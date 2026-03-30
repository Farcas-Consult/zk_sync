import crypto from 'crypto';
import fetch from 'node-fetch';
import { config, httpsAgent } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { photoCache } from '../utils/photoCache.js';
import { parseName } from '../utils/helpers.js';
import type { GymMember } from '../types/index.js';
import type {
  AccessControlClient,
  AccessControlContext,
  AccessControlPersonSnapshot,
} from './accessControl.js';

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
}

export class HikvisionAccessControlClient implements AccessControlClient {
  readonly vendor = 'hikvision' as const;

  private changedPersonIds = new Set<string>();

  async prefetchExistingPersons(
    _externalIds: string[]
  ): Promise<Record<string, AccessControlPersonSnapshot>> {
    // For now, we rely on upsert semantics per member and do not prefetch in bulk.
    return {};
  }

  async ensureMember(
    member: GymMember,
    _existingSnapshot: AccessControlPersonSnapshot | null,
    context: AccessControlContext
  ): Promise<void> {
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
        const err = error as Error;
        logger.error(`Failed to convert photo URL to base64 for member ${member.turnstileId} (Hikvision)`, err);
        throw new Error(`Photo conversion failed: ${err.message}`);
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

    const personId = await this.upsertPerson(payload, externalPersonCode);

    if (context.shouldHaveAccess) {
      await this.grantAccess(personId, context.isFemale);
    } else {
      await this.revokeAccess(personId, context.isFemale);
    }

    this.changedPersonIds.add(personId);
  }

  async flushChanges(): Promise<void> {
    if (this.changedPersonIds.size === 0) {
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

    await this.request<void>('POST', '/artemis/api/visitor/v1/auth/reapplication', body);

    this.changedPersonIds.clear();
  }

  private async upsertPerson(personInfo: Record<string, unknown>, personCode: string): Promise<string> {
    try {
      const addData = await this.request<HikPersonInfo>(
        'POST',
        '/artemis/api/resource/v1/person/single/add',
        personInfo
      );
      const personId = this.extractPersonId(addData) || (await this.getPersonIdByPersonCode(personCode));
      if (!personId) {
        throw new Error(`Unable to resolve personId after add for personCode=${personCode}`);
      }
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
          `Hikvision person add failed and person lookup by personCode=${personCode} returned no personId`
        );
      }

      const updatePayload = {
        ...personInfo,
        personId: existingPersonId,
      };

      await this.request('POST', '/artemis/api/resource/v1/person/single/update', updatePayload);
      logger.info(`Hikvision person update succeeded for personCode=${personCode}, personId=${existingPersonId}`);
      return existingPersonId;
    }
  }

  private async getPersonIdByPersonCode(personCode: string): Promise<string | null> {
    const data = await this.request<HikPersonListData>(
      'POST',
      '/artemis/api/resource/v1/person/advance/personList',
      {
        pageNo: 1,
        pageSize: 1,
        personCode,
      }
    );

    if (!data) return null;
    const personId = this.extractPersonId(data.list?.[0]);
    return personId || null;
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
    if (typeof asInfo.personId === 'string' && asInfo.personId) {
      return asInfo.personId;
    }

    const nested = (data as { personInfo?: HikPersonInfo }).personInfo;
    if (nested && typeof nested.personId === 'string' && nested.personId) {
      return nested.personId;
    }

    return undefined;
  }

  private async grantAccess(personId: string, isFemale: boolean): Promise<void> {
    const privilegeGroupId =
      isFemale && config.hikvision.womenPrivilegeGroupId
        ? config.hikvision.womenPrivilegeGroupId
        : config.hikvision.privilegeGroupId;

    if (!privilegeGroupId) {
      logger.warn(`No Hikvision privilege group configured; skipping grant for personId=${personId}`);
      return;
    }

    const body = {
      privilegeGroupId,
      list: [{ id: personId }],
      type: 1,
    };

    await this.request('POST', '/artemis/api/acs/v1/privilege/group/single/addPersons', body);
  }

  private async revokeAccess(personId: string, isFemale: boolean): Promise<void> {
    const privilegeGroupId =
      isFemale && config.hikvision.womenPrivilegeGroupId
        ? config.hikvision.womenPrivilegeGroupId
        : config.hikvision.privilegeGroupId;

    if (!privilegeGroupId) {
      logger.warn(`No Hikvision privilege group configured; skipping revoke for personId=${personId}`);
      return;
    }

    const body = {
      privilegeGroupId,
      list: [{ id: personId }],
      type: 1,
    };

    await this.request('POST', '/artemis/api/acs/v1/privilege/group/single/deletePersons', body);
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

