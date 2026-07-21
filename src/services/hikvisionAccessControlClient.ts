import crypto from 'crypto';
import fetch from 'node-fetch';
import { config, httpsAgent } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { photoCache } from '../utils/photoCache.js';
import { parseName } from '../utils/helpers.js';
import { memberIssuesLogger } from '../utils/memberIssuesLogger.js';
import type { GymMember } from '../types/index.js';
import type {
  AccessControlClient,
  AccessControlContext,
  AccessControlPersonSnapshot,
} from './accessControl.js';

const HIK_STRING = (v: unknown): string =>
  v === undefined || v === null ? '' : String(v).trim();

interface HikResponse<T = unknown> {
  code?: number | string;
  msg?: string;
  message?: string;
  data?: T;
}

interface HikPersonInfo {
  personId?: string;
  personCode?: string;
  [key: string]: unknown;
}

interface HikPersonListData {
  list?: HikPersonInfo[];
  total?: number;
  pageNo?: number;
  pageSize?: number;
}

export class HikvisionAccessControlClient implements AccessControlClient {
  readonly vendor = 'hikvision' as const;

  private changedPersonIds = new Set<string>();
  private personIdByCode = new Map<string, string>();
  /** privilegeGroupId → personIds pending addPersons */
  private privilegeAddQueue = new Map<string, Set<string>>();
  /** privilegeGroupId → personIds pending deletePersons */
  private privilegeDeleteQueue = new Map<string, Set<string>>();
  private skippedProfileUpdates = 0;

  async lookupExistingPerson(externalId: string): Promise<AccessControlPersonSnapshot | null> {
    const personId = await this.getPersonIdByPersonCode(externalId);
    if (!personId) return null;
    return {
      externalId,
      personId,
      // The exact person-code endpoint supplies identity, not the full profile.
      // ensureMember will perform one targeted update for the incoming event.
      raw: { personId, personCode: externalId },
    };
  }

  async prefetchExistingPersons(
    _externalIds: string[]
  ): Promise<Record<string, AccessControlPersonSnapshot>> {
    const snapshots: Record<string, AccessControlPersonSnapshot> = {};
    this.privilegeAddQueue.clear();
    this.privilegeDeleteQueue.clear();
    this.skippedProfileUpdates = 0;
    this.personIdByCode.clear();

    // Doc: bulk listing uses person/personList (not advance/personList); pageSize max 500; total drives pagination.
    let pageNo = 1;
    const pageSize = 500;

    while (true) {
      const data = await this.request<HikPersonListData>(
        'POST',
        '/artemis/api/resource/v1/person/personList',
        { pageNo, pageSize }
      );

      const list = Array.isArray(data?.list) ? data.list : [];
      for (const item of list) {
        const personCode = this.coercePersonCode(item.personCode);
        const personId = this.coercePersonId(item.personId);
        if (!personCode || !personId) continue;
        this.personIdByCode.set(personCode, personId);
        snapshots[personCode] = {
          externalId: personCode,
          personId,
          raw: item,
        };
      }

      if (list.length === 0) {
        break;
      }
      if (list.length < pageSize) {
        break;
      }
      const total = data?.total;
      if (typeof total === 'number' && pageNo * pageSize >= total) {
        break;
      }
      pageNo += 1;
      if (pageNo > 5000) {
        logger.warn('Hikvision prefetch stopped after 5000 pages (safety cap)');
        break;
      }
    }

    logger.info(`Hikvision prefetch complete: indexed ${this.personIdByCode.size} existing persons`);
    return snapshots;
  }

  async ensureMember(
    member: GymMember,
    existingSnapshot: AccessControlPersonSnapshot | null,
    context: AccessControlContext
  ): Promise<boolean> {
    const { firstName, lastName } = parseName(member.fullName);
    const externalPersonCode = member.turnstileId.toString();
    const personName = this.normalizeHumanName([firstName, lastName].filter(Boolean).join(' ') || member.fullName);
    const safeGivenName = this.normalizeHumanName(firstName || 'Member');
    const safeFamilyName = this.normalizeHumanName(lastName || 'Member');

    const orgIndexCode =
      context.isFemale && config.hikvision.womenOrgIndexCode
        ? config.hikvision.womenOrgIndexCode
        : config.hikvision.orgIndexCode;

    let faceData: string | undefined;
    if (member.profilePictureUrl && member.profilePictureUrl !== null && member.profilePictureUrl !== '') {
      try {
        faceData = await photoCache.getOrFetchBase64(member.turnstileId, member.profilePictureUrl);
        logger.info(`Converted photo URL to base64 for member ${member.turnstileId} (Hikvision)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Skipping invalid profile photo for member ${member.turnstileId} (Hikvision): ${message}`);
        memberIssuesLogger.logIssue(member.turnstileId, member.fullName, null, 'photo_conversion_error', message);
        context.reportIssue({
          turnstileId: member.turnstileId,
          fullName: member.fullName,
          errorCode: null,
          errorType: 'photo_conversion_error',
          errorMessage: message,
        });
      }
    }

    const payload: Record<string, unknown> = {
      personName,
      personCode: externalPersonCode,
      personGivenName: safeGivenName,
      personFamilyName: safeFamilyName,
      orgIndexCode,
    };

    // Intentionally omit gender for now since enum/format differs by deployment.
    if (member.email) {
      payload['email'] = member.email;
    }
    if (member.phoneNumber) {
      payload['phoneNo'] = member.phoneNumber;
    }
    if (member.gender) {
      payload['gender'] = member.gender === 'F' ? 2 : 1;
    }
    if (faceData) {
      payload['faces'] = [
        {
          faceData,
        },
      ];
    }

    const personId = await this.upsertPerson(payload, externalPersonCode, existingSnapshot);

    if (context.shouldHaveAccess) {
      this.queueGrant(personId, context.isFemale);
    } else {
      this.queueRevoke(personId, context.isFemale);
    }

    this.changedPersonIds.add(personId);
    return true;
  }

  async flushChanges(): Promise<void> {
    await this.flushPrivilegeQueues();

    if (this.skippedProfileUpdates > 0) {
      logger.info(
        `Hikvision skipped ${this.skippedProfileUpdates} redundant profile update(s) (unchanged fields, no new face)`
      );
    }

    if (this.changedPersonIds.size === 0) {
      return;
    }

    if (config.hikvision.skipReapplication) {
      logger.info('Hikvision auth reapplication skipped (HIK_SKIP_REAPPLICATION=true)');
      this.changedPersonIds.clear();
      return;
    }

    const personIds = Array.from(this.changedPersonIds);
    const body = {
      personIds: personIds.join(','),
    };

    logger.info(
      `Triggering Hikvision auth reapplication for ${personIds.length} person(s): ${personIds
        .slice(0, 10)
        .join(', ')}${personIds.length > 10 ? '...' : ''}`
    );

    try {
      await this.request<void>('POST', '/artemis/api/visitor/v1/auth/reapplication', body);
    } catch (error) {
      const err = error as Error;
      logger.warn(
        `Hikvision auth reapplication failed; continuing without failing sync. Error: ${err.message}`
      );
    }

    this.changedPersonIds.clear();
  }

  private async upsertPerson(
    personInfo: Record<string, unknown>,
    personCode: string,
    existingSnapshot: AccessControlPersonSnapshot | null
  ): Promise<string> {
    const existingFromPrefetch = this.personIdByCode.get(personCode);
    const hasFace =
      Array.isArray(personInfo['faces']) && (personInfo['faces'] as unknown[]).length > 0;

    if (existingFromPrefetch) {
      if (!hasFace && this.hikPersonUnchanged(existingSnapshot?.raw, personInfo)) {
        this.skippedProfileUpdates += 1;
        return existingFromPrefetch;
      }
      const updatePayload = { ...personInfo, personId: existingFromPrefetch };
      await this.request('POST', '/artemis/api/resource/v1/person/single/update', updatePayload);
      logger.info(`Hikvision person update (prefetch hit) for personCode=${personCode}, personId=${existingFromPrefetch}`);
      return existingFromPrefetch;
    }

    try {
      const addData = await this.request<HikPersonInfo>(
        'POST',
        '/artemis/api/resource/v1/person/single/add',
        personInfo
      );
      const personId =
        this.coercePersonId(this.extractPersonId(addData)) ||
        (await this.getPersonIdByPersonCode(personCode));
      if (!personId) {
        throw new Error(`Unable to resolve personId after add for personCode=${personCode}`);
      }
      this.personIdByCode.set(personCode, personId);
      logger.info(`Hikvision person add succeeded for personCode=${personCode}, personId=${personId}`);
      return personId;
    } catch (error) {
      const err = error as Error;
      const errorCode = this.extractErrorCode(err.message);
      logger.warn(
        `Hikvision person add failed for personCode=${personCode}, attempting update instead: ${err.message}`
      );

      // If add fails for non-existence reasons (e.g. validation), do not attempt update lookup.
      if (errorCode === '2') {
        throw err;
      }

      const existingPersonId = await this.getPersonIdByPersonCode(personCode);
      if (!existingPersonId) {
        throw new Error(
          `Hikvision person add failed and person lookup by personCode=${personCode} returned no exact personId match`
        );
      }

      const updatePayload = {
        ...personInfo,
        personId: existingPersonId,
      };

      await this.request('POST', '/artemis/api/resource/v1/person/single/update', updatePayload);
      this.personIdByCode.set(personCode, existingPersonId);
      logger.info(`Hikvision person update succeeded for personCode=${personCode}, personId=${existingPersonId}`);
      return existingPersonId;
    }
  }

  /**
   * Doc: POST person/personCode/personInfo returns data.personId + data.personCode (not a personCode filter on advance/personList).
   */
  private async getPersonIdByPersonCode(personCode: string): Promise<string | null> {
    const cached = this.personIdByCode.get(personCode);
    if (cached) {
      return cached;
    }

    try {
      const data = await this.request<HikPersonInfo>(
        'POST',
        '/artemis/api/resource/v1/person/personCode/personInfo',
        { personCode }
      );
      const personId = this.coercePersonId(this.extractPersonId(data));
      if (personId) {
        this.personIdByCode.set(personCode, personId);
      }
      return personId || null;
    } catch {
      return null;
    }
  }

  private coercePersonCode(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  private coercePersonId(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s || null;
  }

  private normalizeHumanName(value: string): string {
    const normalized = value
      .replace(/[^A-Za-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized || 'Member';
  }

  private extractErrorCode(message: string): string | null {
    const match = message.match(/\(code:\s*([^)]+)\)/i);
    return match?.[1]?.trim() ?? null;
  }

  private extractPersonId(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const asInfo = data as HikPersonInfo;
    if (asInfo.personId !== undefined && asInfo.personId !== null && asInfo.personId !== '') {
      return String(asInfo.personId);
    }

    const nested = (data as { personInfo?: HikPersonInfo }).personInfo;
    if (nested?.personId !== undefined && nested?.personId !== null && nested?.personId !== '') {
      return String(nested.personId);
    }

    return undefined;
  }

  private resolvePrivilegeGroupId(isFemale: boolean): string | null {
    const privilegeGroupId =
      isFemale && config.hikvision.womenPrivilegeGroupId
        ? config.hikvision.womenPrivilegeGroupId
        : config.hikvision.privilegeGroupId;
    return privilegeGroupId?.trim() ? privilegeGroupId.trim() : null;
  }

  private queueGrant(personId: string, isFemale: boolean): void {
    const privilegeGroupId = this.resolvePrivilegeGroupId(isFemale);
    if (!privilegeGroupId) {
      logger.warn(`No Hikvision privilege group configured; skipping grant for personId=${personId}`);
      return;
    }
    this.enqueuePrivilege(this.privilegeAddQueue, privilegeGroupId, personId);
    this.dequeuePrivilege(this.privilegeDeleteQueue, privilegeGroupId, personId);
  }

  private queueRevoke(personId: string, isFemale: boolean): void {
    const privilegeGroupId = this.resolvePrivilegeGroupId(isFemale);
    if (!privilegeGroupId) {
      logger.warn(`No Hikvision privilege group configured; skipping revoke for personId=${personId}`);
      return;
    }
    this.enqueuePrivilege(this.privilegeDeleteQueue, privilegeGroupId, personId);
    this.dequeuePrivilege(this.privilegeAddQueue, privilegeGroupId, personId);
  }

  private enqueuePrivilege(map: Map<string, Set<string>>, groupId: string, personId: string): void {
    let set = map.get(groupId);
    if (!set) {
      set = new Set();
      map.set(groupId, set);
    }
    set.add(personId);
  }

  private dequeuePrivilege(map: Map<string, Set<string>>, groupId: string, personId: string): void {
    const set = map.get(groupId);
    if (set) {
      set.delete(personId);
      if (set.size === 0) {
        map.delete(groupId);
      }
    }
  }

  /**
   * Batches addPersons/deletePersons per privilege group (doc: list accepts multiple ids).
   */
  private async flushPrivilegeQueues(): Promise<void> {
    const batchSize = config.hikvision.privilegeBatchSize;
    let addRequests = 0;
    let deleteRequests = 0;
    let addPeople = 0;
    let deletePeople = 0;

    for (const [privilegeGroupId, ids] of this.privilegeAddQueue) {
      const list = Array.from(ids);
      addPeople += list.length;
      for (let i = 0; i < list.length; i += batchSize) {
        const chunk = list.slice(i, i + batchSize);
        await this.request('POST', '/artemis/api/acs/v1/privilege/group/single/addPersons', {
          privilegeGroupId,
          list: chunk.map((id) => ({ id })),
          type: 1,
        });
        addRequests += 1;
      }
    }

    for (const [privilegeGroupId, ids] of this.privilegeDeleteQueue) {
      const list = Array.from(ids);
      deletePeople += list.length;
      for (let i = 0; i < list.length; i += batchSize) {
        const chunk = list.slice(i, i + batchSize);
        await this.request('POST', '/artemis/api/acs/v1/privilege/group/single/deletePersons', {
          privilegeGroupId,
          list: chunk.map((id) => ({ id })),
          type: 1,
        });
        deleteRequests += 1;
      }
    }

    this.privilegeAddQueue.clear();
    this.privilegeDeleteQueue.clear();

    if (addRequests > 0 || deleteRequests > 0) {
      logger.info(
        `Hikvision privilege flush: ${addPeople} grant(s) in ${addRequests} request(s), ${deletePeople} revoke(s) in ${deleteRequests} request(s) (batch size ${batchSize})`
      );
    }
  }

  /** True if Hik list/detail raw matches the payload we would send (no face refresh this run). */
  private hikPersonUnchanged(raw: unknown, payload: Record<string, unknown>): boolean {
    if (!raw || typeof raw !== 'object') {
      return false;
    }
    const r = raw as Record<string, unknown>;
    if (HIK_STRING(r.personName) !== HIK_STRING(payload.personName)) {
      return false;
    }
    if (HIK_STRING(r.personGivenName) !== HIK_STRING(payload.personGivenName)) {
      return false;
    }
    if (HIK_STRING(r.personFamilyName) !== HIK_STRING(payload.personFamilyName)) {
      return false;
    }
    if (HIK_STRING(r.orgIndexCode) !== HIK_STRING(payload.orgIndexCode)) {
      return false;
    }
    if (HIK_STRING(r.email) !== HIK_STRING(payload.email)) {
      return false;
    }
    if (HIK_STRING(r.phoneNo) !== HIK_STRING(payload.phoneNo)) {
      return false;
    }
    if (payload['gender'] !== undefined && Number(r.gender) !== Number(payload['gender'])) {
      return false;
    }
    return true;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<T> {
    const baseUrl = config.hikvision.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}${path}`;
    const parsedUrl = new URL(url);
    const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`;

    const timestamp = Date.now().toString();
    const date = new Date().toUTCString();
    const bodyString = body ? JSON.stringify(body) : '';
    const contentMd5 = bodyString ? crypto.createHash('md5').update(bodyString).digest('base64') : '';
    const appKey = config.hikvision.appKey.trim();
    const appSecret = config.hikvision.appSecret.trim();

    const headers: Record<string, string> = {
      Accept: '*/*',
      'Content-Type': 'application/json',
      Date: date,
      userId: config.hikvision.userId.trim(),
      'X-Ca-Key': appKey,
      'X-Ca-Timestamp': timestamp,
      'X-Ca-Signature-Headers': 'userid,x-ca-key,x-ca-timestamp',
    };
    if (contentMd5) {
      headers['Content-MD5'] = contentMd5;
    }

    const canonicalHeaders = [
      `userid:${headers['userId']}`,
      `x-ca-key:${headers['X-Ca-Key']}`,
      `x-ca-timestamp:${headers['X-Ca-Timestamp']}`,
    ].join('\n');

    const stringToSign = [
      method,
      headers.Accept,
      headers['Content-MD5'] || '',
      headers['Content-Type'],
      headers.Date || '',
      canonicalHeaders,
      pathWithQuery,
    ].join('\n');

    const signature = crypto
      .createHmac('sha256', appSecret)
      .update(stringToSign, 'utf8')
      .digest('base64');

    headers['X-Ca-Signature'] = signature;

    const response = await fetch(url, {
      method,
      headers,
      body: bodyString || undefined,
      agent: url.startsWith('https:') ? httpsAgent : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hikvision HTTP error: ${response.status} ${response.statusText} - ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const json = (await response.json()) as HikResponse<T>;

    if (json.code !== undefined && json.code !== 0 && json.code !== '0') {
      const msg = json.msg || json.message || 'Unknown error';
      if (String(json.code) === '68') {
        logger.error(
          `Hikvision signature diagnostic: path=${pathWithQuery}, ts=${timestamp}, signedHeaders=${headers['X-Ca-Signature-Headers']}, hasMd5=${!!contentMd5}, date=${date}`
        );
      }
      throw new Error(`Hikvision API error: ${msg} (code: ${json.code})`);
    }

    return (json.data as T) ?? (undefined as T);
  }
}

export const hikvisionAccessControlClient = new HikvisionAccessControlClient();
