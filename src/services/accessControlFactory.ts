import { config } from '../config/index.js';
import type { AccessControlClient } from './accessControl.js';
import { zkbioAccessControlClient } from './zkbioAccessControlClient.js';
import { hikvisionAccessControlClient } from './hikvisionAccessControlClient.js';

export function createAccessControlClient(): AccessControlClient {
  if (config.accessControl.vendor === 'hikvision') {
    return hikvisionAccessControlClient;
  }
  return zkbioAccessControlClient;
}

export const accessControlClient: AccessControlClient = createAccessControlClient();

