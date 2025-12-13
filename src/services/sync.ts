import fetch from 'node-fetch';
import { config, httpsAgent } from '../config';
import { logger } from '../utils/logger';
import { telegramService } from './telegram';
import { zkbioClient } from './zkbio';
import { delay, normalizeAccessLevel, parseName } from '../utils/helpers';
import { urlToBase64 } from '../utils/imageConverter';
import type { GymMember, GymApiResponse, ZKBioPerson } from '../types';

export class SyncService {
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

    try {
      const members = await this.fetchGymMembers();
      const allPins = members.map((m) => m.turnstileId.toString());

      logger.info(`Preparing to batch fetch ${allPins.length} persons from ZKBio`);

      let existingPersonsMap: Record<string, ZKBioPerson> = {};

      try {
        existingPersonsMap = await zkbioClient.getBatchPersons(allPins, config.sync.batchSize);
        const batchWorked = Object.keys(existingPersonsMap).length > 0 || allPins.length === 0;

        if (!batchWorked && allPins.length > 0) {
          logger.warn('Batch processing returned no results for existing members');
        }
      } catch (error) {
        const err = error as Error;
        logger.error('Batch fetch failed', err);

        await telegramService.notify(
          'batch_fetch_error',
          `<b>Batch Fetch Error</b>\n\n` +
            `<b>Error:</b> ${err.message}\n` +
            `<b>Action:</b> Stopping sync - batch processing required\n\n` +
            `Please check server status and configuration.`,
          'batch_error'
        );

        throw new Error(`Batch processing failed: ${err.message}`);
      }

      if (Object.keys(existingPersonsMap).length === 0 && allPins.length > 0) {
        const errorMsg = 'Batch processing failed - no individual fallback available';
        logger.error(errorMsg);

        await telegramService.notify(
          'batch_processing_required',
          `<b>Batch Processing Failed</b>\n\n` +
            `<b>Issue:</b> Batch fetch returned no results\n` +
            `<b>Expected:</b> ${allPins.length} members\n` +
            `<b>Action:</b> Sync stopped - requires batch processing\n\n` +
            `Please check ZKBio server status and API configuration.`,
          'batch_required'
        );

        throw new Error(errorMsg);
      }

      logger.info(`Processing ${members.length} members with batch data`);

      for (const member of members) {
        await this.processMember(member, existingPersonsMap);
        await delay(config.sync.operationDelay);
      }

      const endTime = Date.now();
      const totalTime = ((endTime - startTime) / 1000).toFixed(2);
      const processingMode = `batch processing (${Object.keys(existingPersonsMap).length} from batches)`;

      logger.info(`Data sync completed in ${totalTime}s - processed ${members.length} members using ${processingMode}`);
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
    existingPersonsMap: Record<string, ZKBioPerson>
  ): Promise<void> {
    const personPin = member.turnstileId.toString();
    const existingPerson = existingPersonsMap[personPin] || null;

    const shouldHaveAccess = member.membershipStatus === 'active' && member.isActive === true;
    const accessLevelIds = shouldHaveAccess ? config.zkbio.gymAccessLevelId : '';

    const { firstName, lastName } = parseName(member.fullName);

    if (existingPerson) {
      await this.updateMemberIfNeeded(member, existingPerson, firstName, lastName, accessLevelIds);
    } else {
      await this.createMember(member, firstName, lastName, accessLevelIds);
    }
  }

  private async updateMemberIfNeeded(
    member: GymMember,
    existingPerson: ZKBioPerson,
    firstName: string,
    lastName: string,
    accessLevelIds: string
  ): Promise<void> {
    const personPin = member.turnstileId.toString();
    const currentAccessLevel = existingPerson.accLevelIds;
    const accessLevelChanged =
      normalizeAccessLevel(currentAccessLevel) !== normalizeAccessLevel(accessLevelIds);

    const email = member.email || `turnstile${member.turnstileId}@${config.gym.emailDomain}`;
    const phone = member.phoneNumber || '';

    // Check if photo needs updating
    // Only update if a photo URL is provided (not null/undefined/empty)
    // We don't compare with existing photo since we don't store the original URL
    const hasPhotoUrl =
      member.profilePictureUrl !== null &&
      member.profilePictureUrl !== undefined &&
      member.profilePictureUrl !== '';

    const needsUpdate =
      existingPerson.name !== firstName ||
      existingPerson.lastName !== lastName ||
      existingPerson.email !== email ||
      existingPerson.mobilePhone !== phone ||
      accessLevelChanged ||
      hasPhotoUrl; // Update if photo URL is provided

    if (needsUpdate) {
      try {
        let personPhoto: string | undefined;
        if (hasPhotoUrl && member.profilePictureUrl) {
          try {
            personPhoto = await urlToBase64(member.profilePictureUrl);
            logger.info(`Converted photo URL to base64 for member ${member.turnstileId}`);
          } catch (error) {
            const err = error as Error;
            logger.error(`Failed to convert photo URL to base64 for member ${member.turnstileId}`, err);
            throw new Error(`Photo conversion failed: ${err.message}`);
          }
        }

        await zkbioClient.updatePerson(personPin, {
          accLevelIds: accessLevelIds,
          deptCode: config.zkbio.deptCode,
          name: firstName,
          lastName: lastName,
          email: email,
          mobilePhone: phone,
          personPhoto: personPhoto,
        });
      } catch (error) {
        logger.error(`Failed to update ${member.turnstileId}`, error as Error);
        throw error;
      }
    }
  }

  private async createMember(
    member: GymMember,
    firstName: string,
    lastName: string,
    accessLevelIds: string
  ): Promise<void> {
    if (firstName === 'Unknown') {
      logger.warn(`Cannot create ${member.turnstileId} - invalid name`);
      return;
    }

    let personPhoto: string | undefined;
    if (member.profilePictureUrl && member.profilePictureUrl !== null && member.profilePictureUrl !== '') {
      try {
        personPhoto = await urlToBase64(member.profilePictureUrl);
        logger.info(`Converted photo URL to base64 for member ${member.turnstileId}`);
      } catch (error) {
        const err = error as Error;
        logger.error(`Failed to convert photo URL to base64 for member ${member.turnstileId}`, err);
        throw new Error(`Photo conversion failed: ${err.message}`);
      }
    }

    const personData = {
      pin: member.turnstileId.toString(),
      name: firstName,
      lastName: lastName,
      email: member.email || `turnstile${member.turnstileId}@${config.gym.emailDomain}`,
      mobilePhone: member.phoneNumber || '',
      deptCode: config.zkbio.deptCode,
      accLevelIds: accessLevelIds,
      accStartTime: null,
      accEndTime: null,
      isSendMail: false,
      personPhoto: personPhoto,
    };

    try {
      await zkbioClient.createOrEditPerson(personData);
      logger.info(`Created ${member.turnstileId} (${member.fullName}) - access: ${accessLevelIds ? 'granted' : 'revoked'}`);
    } catch (error) {
      logger.error(`Failed to create ${member.turnstileId}`, error as Error);
      throw error;
    }
  }
}

export const syncService = new SyncService();

