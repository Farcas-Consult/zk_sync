import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { photoCache } from '../utils/photoCache.js';
import { accessLevelsEqual, normalizeAccessLevel, normalizeString, parseName } from '../utils/helpers.js';
import { memberIssuesLogger } from '../utils/memberIssuesLogger.js';
import type { GymMember, ZKBioPerson } from '../types/index.js';
import { zkbioClient } from './zkbio.js';
import type {
  AccessControlClient,
  AccessControlContext,
  AccessControlPersonSnapshot,
  EnsureMemberResult,
} from './accessControl.js';
import type { MemberIssuePayload } from '../utils/issueReporter.js';

export class ZKBioAccessControlClient implements AccessControlClient {
  readonly vendor = 'zkbio' as const;

  async prefetchExistingPersons(externalIds: string[]): Promise<Record<string, AccessControlPersonSnapshot>> {
    if (externalIds.length === 0) return {};

    const existingPersonsMap = await zkbioClient.getBatchPersons(externalIds, config.sync.batchSize);
    const snapshots: Record<string, AccessControlPersonSnapshot> = {};

    for (const [pin, person] of Object.entries(existingPersonsMap)) {
      snapshots[pin] = {
        externalId: pin,
        fullName: [person.name, person.lastName].filter(Boolean).join(' ') || null,
        gender: person.gender ?? null,
        orgCode: person.deptCode ?? null,
        hasAccess: !!normalizeAccessLevel(person.accLevelIds || ''),
        raw: person,
      };
    }

    return snapshots;
  }

  async ensureMember(
    member: GymMember,
    existingSnapshot: AccessControlPersonSnapshot | null,
    context: AccessControlContext
  ): Promise<EnsureMemberResult> {
    const { firstName, lastName } = parseName(member.fullName);

    const isFemale = context.isFemale;
    const deptCode =
      isFemale && config.zkbio.womenDeptCode ? config.zkbio.womenDeptCode : config.zkbio.deptCode;
    const accessLevelIds = context.shouldHaveAccess
      ? isFemale && config.zkbio.womenAccessLevelId
        ? config.zkbio.womenAccessLevelId
        : config.zkbio.gymAccessLevelId
      : '';

    if (existingSnapshot && existingSnapshot.raw) {
      return this.updateMemberIfNeeded(
        member,
        existingSnapshot.raw as ZKBioPerson,
        firstName,
        lastName,
        accessLevelIds,
        deptCode
      );
    }
    return this.createMember(member, firstName, lastName, accessLevelIds, deptCode);
  }

  async handleMemberError(
    member: GymMember,
    error: unknown,
    addRunIssue: (issue: MemberIssuePayload) => void
  ): Promise<void> {
    const err = error as Error;
    const message = err instanceof Error ? err.message : String(err);
    const codeMatch = message.match(/\[Code:\s*(-?\d+)\]/);
    const code = codeMatch ? Number(codeMatch[1]) : null;

    const errorType = this.getErrorType(error);

    // Known per-member validation issues: log and continue
    if (this.shouldSkipMemberOnZkBioError(error)) {
      logger.warn(
        `Skipping member ${member.turnstileId} (${member.fullName}) due to ZKBio validation error` +
          (code !== null ? ` [Code: ${code}]` : '') +
          `: ${err.message}`
      );
      memberIssuesLogger.logIssue(member.turnstileId, member.fullName, code, errorType, err.message);
      addRunIssue({
        turnstileId: member.turnstileId,
        fullName: member.fullName,
        errorCode: code,
        errorType,
        errorMessage: err.message,
      });
      return;
    }

    if (this.isFatalZkBioError(error)) {
      throw error;
    }

    // Default: log and continue for non-fatal member-level errors.
    logger.error(`Failed processing member ${member.turnstileId} (${member.fullName})`, err);
    memberIssuesLogger.logIssue(member.turnstileId, member.fullName, code, errorType, err.message);
    addRunIssue({
      turnstileId: member.turnstileId,
      fullName: member.fullName,
      errorCode: code,
      errorType,
      errorMessage: err.message,
    });
  }

  async flushChanges(): Promise<void> {
    // ZKBio does not require an explicit flush/apply step.
  }

  private getErrorType(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const codeMatch = message.match(/\[Code:\s*(-?\d+)\]/);
    const code = codeMatch ? Number(codeMatch[1]) : null;
    if (code === -62) return 'name_validation_error';
    if (code === -63) return 'face_detection_error';
    if (message.includes('Photo conversion failed')) return 'photo_conversion_error';
    return 'unknown_error';
  }

  private shouldSkipMemberOnZkBioError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('[Code: -62]')) return true; // Name cannot enter special characters
    if (message.includes('[Code: -63]')) return true; // Face detection failed
    return false;
  }

  private isFatalZkBioError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('ZKBio HTTP error: 401') ||
      message.includes('ZKBio HTTP error: 403') ||
      message.includes('Unauthorized') ||
      message.includes('Forbidden') ||
      message.includes('UNKNOWN DEVICE')
    );
  }

  private async updateMemberIfNeeded(
    member: GymMember,
    existingPerson: ZKBioPerson,
    firstName: string,
    lastName: string,
    accessLevelIds: string,
    deptCode: string
  ): Promise<EnsureMemberResult> {
    const personPin = member.turnstileId.toString();
    const currentAccessLevel = existingPerson.accLevelIds;
    const accessLevelChanged = !accessLevelsEqual(currentAccessLevel, accessLevelIds);

    const email = member.email || `turnstile${member.turnstileId}@${config.gym.emailDomain}`;
    const phone = member.phoneNumber || '';

    // Normalize for comparison to handle null/undefined/empty equivalently
    const emailChanged = normalizeString(existingPerson.email) !== normalizeString(email);
    const phoneChanged = normalizeString(existingPerson.mobilePhone) !== normalizeString(phone);
    const nameChanged = normalizeString(existingPerson.name) !== normalizeString(firstName);
    const lastNameChanged = normalizeString(existingPerson.lastName) !== normalizeString(lastName);

    const hasPhotoUrl =
      member.profilePictureUrl !== null &&
      member.profilePictureUrl !== undefined &&
      member.profilePictureUrl !== '';
    const needsPhotoUpdate = hasPhotoUrl && !existingPerson.personPhoto;

    const deptCodeChanged = existingPerson.deptCode !== deptCode;
    const genderChanged = member.gender !== null && existingPerson.gender !== member.gender;

    const needsUpdate =
      nameChanged ||
      lastNameChanged ||
      emailChanged ||
      phoneChanged ||
      accessLevelChanged ||
      deptCodeChanged ||
      genderChanged ||
      needsPhotoUpdate;

    if (!needsUpdate) {
      return 'skipped';
    }

    let personPhoto: string | undefined;
    if (needsPhotoUpdate && member.profilePictureUrl) {
      try {
        personPhoto = await photoCache.getOrFetchBase64(member.turnstileId, member.profilePictureUrl);
      } catch (error) {
        const err = error as Error;
        logger.error(`Failed to convert photo URL to base64 for member ${member.turnstileId}`, err);
        throw new Error(`Photo conversion failed: ${err.message}`);
      }
    }

    await zkbioClient.updatePerson(personPin, {
      accLevelIds: accessLevelIds,
      deptCode: deptCode,
      name: firstName,
      lastName: lastName,
      email: email,
      mobilePhone: phone,
      personPhoto: personPhoto,
      gender: member.gender || undefined,
    });
    logger.info(`Updated ${personPin} (${member.fullName}) - access: ${accessLevelIds ? 'granted' : 'revoked'}`);
    return 'updated';
  }

  private async createMember(
    member: GymMember,
    firstName: string,
    lastName: string,
    accessLevelIds: string,
    deptCode: string
  ): Promise<EnsureMemberResult> {
    if (firstName === 'Unknown') {
      logger.warn(`Cannot create ${member.turnstileId} - invalid name`);
      return 'skipped';
    }

    let personPhoto: string | undefined;
    if (member.profilePictureUrl && member.profilePictureUrl !== null && member.profilePictureUrl !== '') {
      try {
        personPhoto = await photoCache.getOrFetchBase64(member.turnstileId, member.profilePictureUrl);
      } catch (error) {
        const err = error as Error;
        logger.error(`Failed to convert photo URL to base64 for member ${member.turnstileId}`, err);
        throw new Error(`Photo conversion failed: ${err.message}`);
      }
    }

    const personPin = member.turnstileId.toString();
    const personData = {
      pin: personPin,
      name: firstName,
      lastName: lastName,
      email: member.email || `turnstile${member.turnstileId}@${config.gym.emailDomain}`,
      mobilePhone: member.phoneNumber || '',
      deptCode: deptCode,
      accLevelIds: accessLevelIds,
      accStartTime: null,
      accEndTime: null,
      isSendMail: false,
      personPhoto: personPhoto,
      gender: member.gender || undefined,
    };

    await zkbioClient.createOrEditPerson(personData);
    logger.info(`Created ${personPin} (${member.fullName}) - access: ${accessLevelIds ? 'granted' : 'revoked'}`);
    return 'created';
  }
}

export const zkbioAccessControlClient = new ZKBioAccessControlClient();

