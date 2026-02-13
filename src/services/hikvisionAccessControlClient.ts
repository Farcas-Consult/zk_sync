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
    const personId = member.turnstileId.toString();
    const personName = [firstName, lastName].filter(Boolean).join(' ') || member.fullName;

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
      personId,
      orgIndexCode,
    };

    if (member.gender) {
      // Map 'M' | 'F' to Hikvision gender representation if needed; here we pass through as-is.
      payload['gender'] = member.gender;
    }
    if (member.email) {
      payload['email'] = member.email;
    }
    if (member.phoneNumber) {
      payload['phoneNo'] = member.phoneNumber;
    }
    if (faceData) {
      payload['faces'] = [
        {
          faceData,
        },
      ];
    }

    await this.upsertPerson(payload);

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

  private async upsertPerson(personInfo: Record<string, unknown>): Promise<void> {
    try {
      await this.request('POST', '/artemis/api/resource/v1/person/single/add', { personInfo });
      logger.info(`Hikvision person add succeeded for ${personInfo.personId as string}`);
    } catch (error) {
      const err = error as Error;
      logger.warn(
        `Hikvision person add failed for ${personInfo.personId as string}, attempting update instead: ${err.message}`
      );
      await this.request('POST', '/artemis/api/resource/v1/person/single/update', { personInfo });
      logger.info(`Hikvision person update succeeded for ${personInfo.personId as string}`);
    }
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

    const timestamp = Date.now().toString();
    const bodyString = body ? JSON.stringify(body) : '';
    const contentMd5 = bodyString ? crypto.createHash('md5').update(bodyString).digest('base64') : '';

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Ca-Key': config.hikvision.appKey,
      'X-Ca-Timestamp': timestamp,
      'X-Ca-Signature-Headers': 'x-ca-key,x-ca-timestamp',
    };

    const stringToSign = [
      method,
      headers.Accept,
      contentMd5,
      headers['Content-Type'],
      '',
      `x-ca-key:${headers['X-Ca-Key']}`,
      `x-ca-timestamp:${headers['X-Ca-Timestamp']}`,
      path,
    ].join('\n');

    const signature = crypto
      .createHmac('sha256', config.hikvision.appSecret)
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
      throw new Error(`Hikvision API error: ${msg} (code: ${json.code})`);
    }

    return (json.data as T) ?? (undefined as T);
  }
}

export const hikvisionAccessControlClient = new HikvisionAccessControlClient();

