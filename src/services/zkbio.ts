import fetch, { type RequestInit as NodeFetchRequestInit } from 'node-fetch';
import { config, httpsAgent } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { telegramService } from './telegram.js';
import { delay, chunkArray } from '../utils/helpers.js';
import type {
  ZKBioPerson,
  ZKBioApiResponse,
  ZKBioPersonListResponse,
  PersonListOptions,
  PersonUpdateData,
} from '../types/index.js';

export class ZKBioClient {
  private baseUrl: string;
  private accessToken: string;

  constructor() {
    this.baseUrl = config.zkbio.baseUrl;
    this.accessToken = config.zkbio.accessToken;
  }

  private getUrl(endpoint: string, params?: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    url.searchParams.set('access_token', this.accessToken);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }
    return url.toString();
  }

  private async request<T>(
    url: string,
    options: NodeFetchRequestInit = {}
  ): Promise<ZKBioApiResponse<T>> {
    const isHttps = url.startsWith('https:');
    const fetchOptions: NodeFetchRequestInit = {
      ...options,
      ...(isHttps && { agent: httpsAgent }),
    };
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
    }

    const result = (await response.json()) as ZKBioApiResponse<T>;

    if (result.code < 0) {
      throw new Error(`API Error: ${result.message} [Code: ${result.code}]`);
    }

    return result;
  }

  async createOrEditPerson(personInfo: ZKBioPerson): Promise<ZKBioPerson> {
    if (!personInfo.pin) {
      throw new Error('Personnel ID (pin) is required to create or edit a person.');
    }

    const url = this.getUrl('/api/person/add');
    const result = await this.request<ZKBioPerson>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(personInfo),
    });

    logger.info(`Successfully created/edited person: ${personInfo.pin}`);
    return result.data!;
  }

  async getPerson(pin: string): Promise<ZKBioPerson | null> {
    const url = this.getUrl(`/api/person/get/${pin}`, { _t: Date.now().toString() });

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        },
        agent: url.startsWith('https:') ? httpsAgent : undefined,
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
      }

      const result = (await response.json()) as ZKBioApiResponse<ZKBioPerson>;

      if (result.code < 0) {
        logger.error(`API Error getting person ${pin}: ${result.message} [Code: ${result.code}]`);
        return null;
      }

      return result.data || null;
    } catch (error) {
      logger.error(`Error getting person ${pin}`, error as Error);
      return null;
    }
  }

  async getPersonList(options: PersonListOptions = {}): Promise<ZKBioPersonListResponse> {
    const params: Record<string, string> = {
      pageNo: (options.pageNo || 1).toString(),
      pageSize: (options.pageSize || 100).toString(),
    };

    if (options.deptCodes) {
      params.deptCodes = options.deptCodes;
    }
    if (options.pins) {
      params.pins = options.pins;
    }

    const url = this.getUrl('/api/person/getPersonList', params);
    const result = await this.request<ZKBioPersonListResponse>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    return result.data || {};
  }

  async updatePerson(
    pin: string,
    updateData: PersonUpdateData,
    prefetchedPerson?: ZKBioPerson
  ): Promise<ZKBioPerson> {
    const currentPerson = prefetchedPerson || (await this.getPerson(pin));
    if (!currentPerson) {
      throw new Error(`Person with PIN ${pin} not found`);
    }

    const updatedPersonInfo: ZKBioPerson = {
      ...currentPerson,
      pin,
      name: updateData.name ?? currentPerson.name ?? '',
      lastName: updateData.lastName ?? currentPerson.lastName ?? '',
      email: updateData.email ?? currentPerson.email ?? '',
      mobilePhone: updateData.mobilePhone ?? currentPerson.mobilePhone ?? '',
      deptCode: updateData.deptCode || currentPerson.deptCode || config.zkbio.deptCode,
      isDisabled: false,
      accStartTime: null,
      accEndTime: null,
      ...updateData,
      accLevelIds: updateData.accLevelIds !== undefined 
        ? (updateData.accLevelIds || '') 
        : '',
    };

    return this.createOrEditPerson(updatedPersonInfo);
  }

  async getBatchPersons(pinList: string[], batchSize = config.sync.batchSize): Promise<Record<string, ZKBioPerson>> {
    const allResults: Record<string, ZKBioPerson> = {};
    const pinChunks = chunkArray(pinList, batchSize);

    logger.info(`Fetching ${pinList.length} persons in ${pinChunks.length} batches of ${batchSize}`);

    for (let i = 0; i < pinChunks.length; i++) {
      const chunk = pinChunks[i];
      const pinsParam = chunk.join(',');

      try {
        logger.info(`Fetching batch ${i + 1}/${pinChunks.length} (${chunk.length} PINs)`);

        const data = await this.getPersonList({
          pins: pinsParam,
          pageNo: 1,
          pageSize: chunk.length,
        });

        const personList = this.extractPersonList(data);

        if (personList && personList.length > 0) {
          for (const person of personList) {
            allResults[person.pin] = person;
          }
          logger.info(`Batch ${i + 1}: Found ${personList.length} existing persons`);
        } else {
          logger.warn(`Batch ${i + 1}: No persons found in response`);
        }

        if (i < pinChunks.length - 1) {
          await delay(config.sync.batchDelay);
        }
      } catch (error) {
        const err = error as Error;
        logger.error(`Error fetching batch ${i + 1}`, err);

        if (err.message.includes('401') || err.message.includes('403') || err.message.includes('Unauthorized')) {
          await telegramService.notify(
            'zkbio_batch_auth_error',
            `<b>ZKBio Batch Authentication Error</b>\n\n` +
              `<b>Batch:</b> ${i + 1}/${pinChunks.length}\n` +
              `<b>PINs:</b> ${chunk.length}\n` +
              `<b>Error:</b> ${err.message}\n\n` +
              `Check ZKBio access token and server connectivity.`,
            'zkbio_batch_auth'
          );
        }
      }
    }

    logger.info(`Batch fetch complete: ${Object.keys(allResults).length} persons retrieved from ZKBio`);
    return allResults;
  }

  private extractPersonList(data: ZKBioPersonListResponse): ZKBioPerson[] | null {
    if (Array.isArray(data)) {
      return data;
    }
    if (data?.list && Array.isArray(data.list)) {
      return data.list;
    }
    if (data?.data && Array.isArray(data.data)) {
      return data.data;
    }
    if (data?.persons && Array.isArray(data.persons)) {
      return data.persons;
    }
    if (data?.result && Array.isArray(data.result)) {
      return data.result;
    }
    return null;
  }
}

export const zkbioClient = new ZKBioClient();
