import fetch from 'node-fetch';
import { config, httpsAgent } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { telegramService } from './telegram.js';
import { delay, isWoman } from '../utils/helpers.js';
import { memberIssuesLogger } from '../utils/memberIssuesLogger.js';
import { issueReporter, type MemberIssuePayload } from '../utils/issueReporter.js';
import type { GymMember, GymApiResponse } from '../types/index.js';
import type { AccessControlClient, AccessControlPersonSnapshot } from './accessControl.js';
import { accessControlClient } from './accessControlFactory.js';

export class SyncService {
  constructor(private readonly accessClient: AccessControlClient) {}

  async fetchGymMembers(): Promise<GymMember[]> {
    logger.info('Fetching gym members data...');

    const headers: Record<string, string> = {};
    if (config.gym.apiKey) {
      headers['x-api-key'] = config.gym.apiKey;
    }

    const response = await fetch(config.gym.apiUrl, {
      method: 'GET',
      headers,
      agent: config.gym.apiUrl.startsWith('https:') ? httpsAgent : undefined,
    });

    if (!response.ok) {
      const errorMsg = `Gym API failed: ${response.status} ${response.statusText}`;

      if (response.status === 401 || response.status === 403) {
        telegramService.incrementAuthFailures();
        await telegramService.notify(
          'auth_error',
          `<b>Authentication Error</b>\n\n` +
            `<b>Status:</b> ${response.status} ${response.statusText}\n` +
            `<b>URL:</b> ${config.gym.apiUrl}\n` +
            `<b>Failures:</b> ${telegramService.getAuthFailures()}\n\n` +
            `Please check API credentials and server status.`,
          'auth_failure'
        );
      }

      throw new Error(errorMsg);
    }

    const apiResponse = (await response.json()) as GymApiResponse;

    if (!apiResponse.success || !Array.isArray(apiResponse.data)) {
      const msg = `Gym API response invalid format: ${JSON.stringify(apiResponse)}`;
      logger.error(msg);
      console.error('Gym API response:', JSON.stringify(apiResponse, null, 2));

      await telegramService.notify(
        'api_error',
        `<b>API Response Error</b>\n\n` +
          `<b>Issue:</b> Invalid response format\n` +
          `<b>URL:</b> ${config.gym.apiUrl}\n\n` +
          `API returned unexpected data structure.`,
        'invalid_response'
      );

      throw new Error(msg);
    }

    logger.info(`Found ${apiResponse.data.length} members in gym system`);

    if (telegramService.getAuthFailures() > 0) {
      telegramService.resetAuthFailures();
      await telegramService.notify(
        'recovery',
        `<b>Connection Restored</b>\n\n` +
          `<b>Service:</b> Gym API\n` +
          `<b>Members Found:</b> ${apiResponse.data.length}\n\n` +
          `System is back online and functioning normally.`
      );
    }

    return apiResponse.data;
  }

  async sync(): Promise<void> {
    const startTime = Date.now();

    const runIssues = new Map<string, MemberIssuePayload>();
    const addRunIssue = (issue: MemberIssuePayload) => {
      const key = `${issue.turnstileId}:${issue.errorCode ?? 'null'}:${issue.errorType}`;
      const existing = runIssues.get(key);
      const now = new Date().toISOString();
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
        existing.lastSeen = now;
        existing.errorMessage = issue.errorMessage;
        if (issue.fullName && !existing.fullName) existing.fullName = issue.fullName;
      } else {
        runIssues.set(key, {
          ...issue,
          firstSeen: issue.firstSeen ?? now,
          lastSeen: issue.lastSeen ?? now,
          count: issue.count ?? 1,
        });
      }
    };

    try {
      const members = await this.fetchGymMembers();
      const allExternalIds = members.map((m) => m.turnstileId.toString());

      logger.info(
        `Preparing to batch fetch ${allExternalIds.length} persons from access provider: ${this.accessClient.vendor}`
      );

      let existingSnapshots: Record<string, AccessControlPersonSnapshot> = {};

      try {
        existingSnapshots = await this.accessClient.prefetchExistingPersons(allExternalIds);
        const batchWorked = Object.keys(existingSnapshots).length > 0 || allExternalIds.length === 0;

        if (!batchWorked && allExternalIds.length > 0) {
          logger.warn('Batch processing returned no results for existing members');
        }
      } catch (error) {
        const err = error as Error;
        logger.error('Batch fetch failed', err);

        await telegramService.notify(
          'batch_fetch_error',
          `<b>Batch Fetch Error</b>\n\n` +
            `<b>Provider:</b> ${this.accessClient.vendor}\n` +
            `<b>Error:</b> ${err.message}\n` +
            `<b>Action:</b> Stopping sync - batch processing required\n\n` +
            `Please check server status and configuration.`,
          'batch_error'
        );

        throw new Error(`Batch processing failed: ${err.message}`);
      }

      logger.info(`Processing ${members.length} members with batch data for provider ${this.accessClient.vendor}`);

      for (const member of members) {
        await this.processMember(member, existingSnapshots, addRunIssue);
        await delay(config.sync.operationDelay);
      }

      const endTime = Date.now();
      const totalTime = ((endTime - startTime) / 1000).toFixed(2);
      const processingMode = `batch processing with provider ${this.accessClient.vendor} (${Object.keys(
        existingSnapshots
      ).length} from batches)`;

      logger.info(
        `Data sync completed in ${totalTime}s - processed ${members.length} members using ${processingMode}`
      );
      
      const issueCount = memberIssuesLogger.getIssueCount();
      if (issueCount > 0) {
        logger.info(`Member issues tracked: ${issueCount} unique issues (see member_issues.json)`);
      }

      // Flush provider-specific changes (e.g. Hikvision auth reapplication)
      await this.accessClient.flushChanges();

      // Send aggregated issues for this run
      const issuesToSend = Array.from(runIssues.values());
      if (issuesToSend.length > 0) {
        await issueReporter.reportBatch(issuesToSend);
      }
    } catch (error) {
      const err = error as Error;
      logger.error('Error occurred during sync', err);

      await telegramService.notify(
        'critical_error',
        `<b>Critical System Error</b>\n\n` +
          `<b>Error:</b> ${err.message}\n` +
          `<b>Time:</b> ${new Date().toLocaleString()}\n` +
          `<b>Operation:</b> Data sync failed\n\n` +
          `Manual intervention may be required.`,
        'data_operation_error'
      );

      await delay(5000);
      throw err;
    }
  }

  private async processMember(
    member: GymMember,
    existingSnapshots: Record<string, AccessControlPersonSnapshot>,
    addRunIssue: (issue: MemberIssuePayload) => void
  ): Promise<void> {
    // Skip members with invalid/null names
    if (!member.fullName || typeof member.fullName !== 'string' || member.fullName.trim() === '') {
      logger.warn(`Skipping member ${member.turnstileId} - invalid or missing fullName`);
      memberIssuesLogger.logIssue(
        member.turnstileId,
        member.fullName,
        null,
        'invalid_name',
        'Invalid or missing fullName'
      );
      addRunIssue({
        turnstileId: member.turnstileId,
        fullName: member.fullName ?? null,
        errorCode: null,
        errorType: 'invalid_name',
        errorMessage: 'Invalid or missing fullName',
      });
      return;
    }

    const externalId = member.turnstileId.toString();
    const existingSnapshot = existingSnapshots[externalId] || null;

    const shouldHaveAccess = member.membershipStatus === 'active' && member.isActive === true;
    const isFemale = isWoman(member.gender);

    const context = {
      shouldHaveAccess,
      isFemale,
    };

    try {
      await this.accessClient.ensureMember(member, existingSnapshot, context);
    } catch (error) {
      const clientWithHandler = this.accessClient as AccessControlClient & {
        handleMemberError?: (
          member: GymMember,
          error: unknown,
          addRunIssue: (issue: MemberIssuePayload) => void
        ) => Promise<void>;
      };

      if (clientWithHandler.handleMemberError) {
        await clientWithHandler.handleMemberError(member, error, addRunIssue);
      } else {
        const err = error as Error;
        logger.error(`Failed processing member ${member.turnstileId} (${member.fullName})`, err);
        memberIssuesLogger.logIssue(member.turnstileId, member.fullName, null, 'unknown_error', err.message);
        addRunIssue({
          turnstileId: member.turnstileId,
          fullName: member.fullName,
          errorCode: null,
          errorType: 'unknown_error',
          errorMessage: err.message,
        });
      }
    }
  }
}

export const syncService = new SyncService(accessControlClient);

