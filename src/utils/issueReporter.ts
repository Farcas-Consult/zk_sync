import fetch from 'node-fetch';
import { config, httpsAgent } from '../config/index.js';
import { logger } from './logger.js';

export interface MemberIssuePayload {
  turnstileId: number;
  fullName: string | null;
  errorCode: number | null;
  errorType: string;
  errorMessage: string;
  firstSeen?: string;
  lastSeen?: string;
  count?: number;
}

class IssueReporter {
  private sentKeys: Set<string> = new Set();

  private getKey(issue: MemberIssuePayload): string {
    return `${issue.turnstileId}:${issue.errorCode ?? 'null'}:${issue.errorType}`;
  }

  async report(issue: MemberIssuePayload): Promise<void> {
    if (!config.issues.apiUrl) {
      return; // Not configured; skip
    }

    const key = this.getKey(issue);
    if (this.sentKeys.has(key)) {
      return; // avoid spamming the same issue in the same run
    }

    this.sentKeys.add(key);

    try {
      const isHttps = config.issues.apiUrl.startsWith('https:');
      const response = await fetch(config.issues.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.issues.apiKey ? { 'x-api-key': config.issues.apiKey } : {}),
        },
        body: JSON.stringify(issue),
        agent: isHttps ? httpsAgent : undefined,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(
          `Failed to report issue (turnstileId=${issue.turnstileId}): ${response.status} ${response.statusText} ${body}`
        );
      }
    } catch (error) {
      logger.warn(`Issue reporter error for turnstile ${issue.turnstileId}: ${(error as Error).message}`);
    }
  }
}

export const issueReporter = new IssueReporter();


