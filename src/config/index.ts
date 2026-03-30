import dotenv from 'dotenv';
import https from 'https';
import type { GymApiSource } from '../types/index.js';

dotenv.config();

export const config = {
  accessControl: {
    vendor: (process.env.ACCESS_CONTROL_VENDOR || 'zkbio') as 'zkbio' | 'hikvision',
  },
  zkbio: {
    baseUrl: process.env.BIOCV_BASE_URL || '',
    accessToken: process.env.BIOCV_ACCESS_TOKEN || '',
    gymAccessLevelId: process.env.ZKBIO_ACCESS_LEVEL_ID || '',
    deptCode: process.env.ZKBIO_DEPT_CODE || '1',
    womenDeptCode: process.env.ZKBIO_WOMEN_DEPT_CODE || '',
    womenAccessLevelId: process.env.ZKBIO_WOMEN_ACCESS_LEVEL_ID || '',
  },
  hikvision: {
    baseUrl: process.env.HIK_BASE_URL || '',
    appKey: process.env.HIK_APP_KEY || '',
    appSecret: process.env.HIK_APP_SECRET || '',
    userId: process.env.HIK_USER_ID || '',
    orgIndexCode: process.env.HIK_ORG_INDEX_CODE || '',
    womenOrgIndexCode: process.env.HIK_WOMEN_ORG_INDEX_CODE || '',
    privilegeGroupId: process.env.HIK_PRIVILEGE_GROUP_ID || '',
    womenPrivilegeGroupId: process.env.HIK_WOMEN_PRIVILEGE_GROUP_ID || '',
    privilegeBatchSize: Math.max(
      1,
      parseInt(process.env.HIK_PRIVILEGE_BATCH_SIZE || '200', 10)
    ),
    skipReapplication: process.env.HIK_SKIP_REAPPLICATION === 'true',
  },
  gym: {
    apiUrl: process.env.GMS_API_URL || '',
    apiKey: process.env.GMS_API_KEY || '',
    apiSource: (process.env.GYM_API_SOURCE || 'fitness254') as GymApiSource,
    name: process.env.GYM_NAME || 'Gym',
    emailDomain: process.env.GYM_EMAIL_DOMAIN || 'gym.local',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  sync: {
    interval: parseInt(process.env.SYNC_INTERVAL_MS || '90000', 10), // Default: 1.5 minutes
    batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '300', 10),
    batchDelay: parseInt(process.env.SYNC_BATCH_DELAY_MS || '100', 10), // ms between batches
    operationDelay: parseInt(process.env.SYNC_OPERATION_DELAY_MS || '100', 10), // ms between operations
  },
  issues: {
    apiUrl: process.env.ISSUE_API_URL || '',
    apiKey: process.env.ISSUE_API_KEY || '',
  },
  notifications: {
    heartbeatInterval: 24 * 60 * 60 * 1000, // 1 day
    errorInterval: 5 * 60 * 1000, // 5 minutes
    heartbeatSchedule: process.env.HEARTBEAT_SCHEDULE || '30 20 * * *', // Default: 20:30 daily
    heartbeatTimezone: process.env.HEARTBEAT_TIMEZONE || 'Africa/Nairobi',
  },
} as const;

export const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export function validateConfig(): void {
  const errors: string[] = [];

  if (config.accessControl.vendor === 'zkbio') {
    if (!config.zkbio.baseUrl) {
      errors.push('BIOCV_BASE_URL is required');
    }
    if (!config.zkbio.accessToken) {
      errors.push('BIOCV_ACCESS_TOKEN is required');
    }
    if (!config.zkbio.gymAccessLevelId) {
      errors.push('ZKBIO_ACCESS_LEVEL_ID is required');
    }
  } else if (config.accessControl.vendor === 'hikvision') {
    if (!config.hikvision.baseUrl) {
      errors.push('HIK_BASE_URL is required when ACCESS_CONTROL_VENDOR=hikvision');
    }
    if (!config.hikvision.appKey) {
      errors.push('HIK_APP_KEY is required when ACCESS_CONTROL_VENDOR=hikvision');
    }
    if (!config.hikvision.appSecret) {
      errors.push('HIK_APP_SECRET is required when ACCESS_CONTROL_VENDOR=hikvision');
    }
    if (!config.hikvision.userId) {
      errors.push('HIK_USER_ID is required when ACCESS_CONTROL_VENDOR=hikvision');
    }
    if (!config.hikvision.orgIndexCode) {
      errors.push('HIK_ORG_INDEX_CODE is required when ACCESS_CONTROL_VENDOR=hikvision');
    }
    if (!config.hikvision.privilegeGroupId) {
      errors.push('HIK_PRIVILEGE_GROUP_ID is required when ACCESS_CONTROL_VENDOR=hikvision');
    }
  }
  if (!config.gym.apiUrl) {
    errors.push('GMS_API_URL is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.join('\n')}`);
  }
}

