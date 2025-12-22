import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

export const config = {
  zkbio: {
    baseUrl: process.env.BIOCV_BASE_URL || '',
    accessToken: process.env.BIOCV_ACCESS_TOKEN || '',
    gymAccessLevelId: process.env.ZKBIO_ACCESS_LEVEL_ID || '',
    deptCode: process.env.ZKBIO_DEPT_CODE || '1',
  },
  gym: {
    apiUrl: process.env.GMS_API_URL || '',
    apiKey: process.env.GMS_API_KEY || '',
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

  if (!config.zkbio.baseUrl) {
    errors.push('BIOCV_BASE_URL is required');
  }
  if (!config.zkbio.accessToken) {
    errors.push('BIOCV_ACCESS_TOKEN is required');
  }
  if (!config.zkbio.gymAccessLevelId) {
    errors.push('ZKBIO_ACCESS_LEVEL_ID is required');
  }
  if (!config.gym.apiUrl) {
    errors.push('GMS_API_URL is required');
  }
  if (!config.gym.apiKey) {
    errors.push('GMS_API_KEY is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.join('\n')}`);
  }
}

