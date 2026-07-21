import fetch from 'node-fetch';
import { config, httpsAgent } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { telegramService } from './telegram.js';
import { delay, isWoman } from '../utils/helpers.js';
import { memberIssuesLogger } from '../utils/memberIssuesLogger.js';
import { issueReporter, type MemberIssuePayload } from '../utils/issueReporter.js';
import type { GymApiResponse, GymMember } from '../types/index.js';
import type { AccessControlClient, AccessControlPersonSnapshot } from './accessControl.js';
import { accessControlClient } from './accessControlFactory.js';
import { createGymAdapter } from './gymAdapter.js';

const FITNESS254_MAX_PAGES = 5000;

export class SyncService {
  private operationChain: Promise<void> = Promise.resolve();
  private memberSnapshots = new Map<string, AccessControlPersonSnapshot>();

  constructor(private readonly accessClient: AccessControlClient) {}

  private runExclusively<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async fetchGymMembers(): Promise<GymMember[]> {
    logger.info('Fetching gym members data...');

    const headers: Record<string, string> = {};
    if (config.gym.apiKey) {
      headers['x-api-key'] = config.gym.apiKey;
    }

    if (config.gym.apiSource === 'fitness254') {
      const members = await this.fetchGymMembersFitness254Paginated(headers);
      await this.notifyGymRecoveryIfNeeded(members.length);
      return members;
    }

    const apiResponse = await this.gymGetJson(config.gym.apiUrl, headers);
    const members = await this.validateAndTransformGymResponse(apiResponse, config.gym.apiUrl);
    logger.info(`Found ${members.length} members in gym system (source: ${config.gym.apiSource})`);

    await this.notifyGymRecoveryIfNeeded(members.length);
    return members;
  }

  private async fetchGymMembersFitness254Paginated(headers: Record<string, string>): Promise<GymMember[]> {
    let pageUrl: URL;
    try {
      pageUrl = new URL(config.gym.apiUrl);
    } catch {
      throw new Error(`GMS_API_URL is not a valid URL: ${config.gym.apiUrl}`);
    }

    const pageSize = config.gym.pageSize;
    let offset = Math.max(0, parseInt(pageUrl.searchParams.get('offset') || '0', 10) || 0);
    const allMembers: GymMember[] = [];
    let pageIndex = 0;

    while (pageIndex < FITNESS254_MAX_PAGES) {
      pageUrl.searchParams.set('offset', String(offset));
      pageUrl.searchParams.set('limit', String(pageSize));

      const urlString = pageUrl.toString();
      const apiResponse = (await this.gymGetJson(urlString, headers)) as GymApiResponse;
      const pageMembers = await this.validateAndTransformGymResponse(apiResponse, urlString);

      allMembers.push(...pageMembers);
      pageIndex += 1;
      logger.info(
        `Fitness254 page ${pageIndex}: +${pageMembers.length} members (total so far: ${allMembers.length})`
      );

      if (pageMembers.length === 0) {
        break;
      }
      if (pageMembers.length < pageSize) {
        break;
      }
      if (apiResponse.hasMore === false) {
        break;
      }

      offset += pageMembers.length;

      if (pageIndex < FITNESS254_MAX_PAGES && config.gym.pageDelayMs > 0) {
        await delay(config.gym.pageDelayMs);
      }
    }

    if (pageIndex >= FITNESS254_MAX_PAGES) {
      logger.warn(`Fitness254 member fetch stopped after ${FITNESS254_MAX_PAGES} pages (safety cap)`);
    }

    logger.info(`Found ${allMembers.length} members in gym system (source: fitness254)`);
    return allMembers;
  }

  private async gymGetJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      agent: url.startsWith('https:') ? httpsAgent : undefined,
    });

    if (!response.ok) {
      const errorMsg = `Gym API failed: ${response.status} ${response.statusText}`;

      if (response.status === 401 || response.status === 403) {
        telegramService.incrementAuthFailures();
        await telegramService.notify(
          'auth_error',
          `<b>Authentication Error</b>\n\n` +
            `<b>Status:</b> ${response.status} ${response.statusText}\n` +
            `<b>URL:</b> ${url}\n` +
            `<b>Failures:</b> ${telegramService.getAuthFailures()}\n\n` +
            `Please check API credentials and server status.`,
          'auth_failure'
        );
      }

      throw new Error(errorMsg);
    }

    return response.json();
  }

  private async validateAndTransformGymResponse(
    apiResponse: unknown,
    requestUrl: string
  ): Promise<GymMember[]> {
    const adapter = createGymAdapter(config.gym.apiSource);

    if (!adapter.validateResponse(apiResponse)) {
      const msg = `Gym API response invalid format for source: ${config.gym.apiSource}`;
      logger.error(msg);
      console.error('Gym API response:', JSON.stringify(apiResponse, null, 2));

      await telegramService.notify(
        'api_error',
        `<b>API Response Error</b>\n\n` +
          `<b>Issue:</b> Invalid response format\n` +
          `<b>Source:</b> ${config.gym.apiSource}\n` +
          `<b>URL:</b> ${requestUrl}\n\n` +
          `API returned unexpected data structure.`,
        'invalid_response'
      );

      throw new Error(msg);
    }

    return adapter.transform(apiResponse);
  }

  private async notifyGymRecoveryIfNeeded(memberCount: number): Promise<void> {
    if (telegramService.getAuthFailures() > 0) {
      telegramService.resetAuthFailures();
      await telegramService.notify(
        'recovery',
        `<b>Connection Restored</b>\n\n` +
          `<b>Service:</b> Gym API\n` +
          `<b>Members Found:</b> ${memberCount}\n\n` +
          `System is back online and functioning normally.`
      );
    }
  }

  async sync(): Promise<void> {
    return this.runExclusively(() => this.syncAll());
  }

  /** Process one member supplied by Fitness254 without fetching either full member list. */
  async syncMember(member: GymMember): Promise<void> {
    return this.runExclusively(() => this.syncOneMember(member));
  }

  private async syncAll(): Promise<void> {
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
        this.memberSnapshots = new Map(Object.entries(existingSnapshots));
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
        const changed = await this.processMember(member, existingSnapshots, addRunIssue);
        // Do not make an unchanged in-memory comparison wait. The configured delay protects
        // ZKBio/Hikvision only when an actual provider mutation was made.
        if (changed && config.sync.operationDelay > 0) {
          await delay(config.sync.operationDelay);
        }
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

  private async syncOneMember(member: GymMember): Promise<void> {
    const startTime = Date.now();
    const issues = new Map<string, MemberIssuePayload>();
    const addRunIssue = (issue: MemberIssuePayload) => {
      const key = `${issue.turnstileId}:${issue.errorCode ?? 'null'}:${issue.errorType}`;
      const existing = issues.get(key);
      const now = new Date().toISOString();
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
        existing.lastSeen = now;
        existing.errorMessage = issue.errorMessage;
      } else {
        issues.set(key, { ...issue, firstSeen: issue.firstSeen ?? now, lastSeen: issue.lastSeen ?? now, count: 1 });
      }
    };

    const externalId = member.turnstileId.toString();
    try {
      // Let the normal validation/reporting path reject malformed events without an avoidable provider lookup.
      if (!member.fullName.trim()) {
        await this.processMember(member, {}, addRunIssue);
        const issuesToSend = Array.from(issues.values());
        if (issuesToSend.length > 0) await issueReporter.reportBatch(issuesToSend);
        return;
      }

      let snapshot = this.memberSnapshots.get(externalId);
      if (!snapshot) {
        // A one-person lookup is the only access-control read required for a cold webhook event.
        if (this.accessClient.lookupExistingPerson) {
          snapshot = (await this.accessClient.lookupExistingPerson(externalId)) || undefined;
        } else {
          const fetched = await this.accessClient.prefetchExistingPersons([externalId]);
          snapshot = fetched[externalId];
        }
        if (snapshot) this.memberSnapshots.set(externalId, snapshot);
      }

      await this.processMember(member, snapshot ? { [externalId]: snapshot } : {}, addRunIssue);
      await this.accessClient.flushChanges();
      this.memberSnapshots.delete(externalId); // event may have changed the remote record; avoid stale comparisons

      const issuesToSend = Array.from(issues.values());
      if (issuesToSend.length > 0) await issueReporter.reportBatch(issuesToSend);
      logger.info(`Webhook member sync completed for ${externalId} in ${Date.now() - startTime}ms`);
    } catch (error) {
      this.memberSnapshots.delete(externalId);
      throw error;
    }
  }

  private async processMember(
    member: GymMember,
    existingSnapshots: Record<string, AccessControlPersonSnapshot>,
    addRunIssue: (issue: MemberIssuePayload) => void
  ): Promise<boolean> {
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
      return false;
    }

    const externalId = member.turnstileId.toString();
    const existingSnapshot = existingSnapshots[externalId] || null;

    const shouldHaveAccess = member.membershipStatus === 'active' && member.isActive === true;
    const isFemale = isWoman(member.gender);

    const context = {
      shouldHaveAccess,
      isFemale,
      reportIssue: addRunIssue,
    };

    try {
      return await this.accessClient.ensureMember(member, existingSnapshot, context);
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
      return false;
    }
  }
}

export const syncService = new SyncService(accessControlClient);
