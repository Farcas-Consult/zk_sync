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
      // Server expects an array of issues (or an object with issues array). We send an array for compatibility.
      const response = await fetch(config.issues.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.issues.apiKey ? { 'x-api-key': config.issues.apiKey } : {}),
        },
        body: JSON.stringify([issue]),
        agent: isHttps ? httpsAgent : undefined,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(
          `Failed to report issue (turnstileId=${issue.turnstileId}): ${response.status} ${response.statusText} ${body}`
        );
      } else {
        logger.info(
          `Reported issue for turnstile ${issue.turnstileId} (code=${issue.errorCode ?? 'n/a'}, type=${issue.errorType})`
        );
      }
    } catch (error) {
      logger.warn(`Issue reporter error for turnstile ${issue.turnstileId}: ${(error as Error).message}`);
    }
  }

  async reportBatch(issues: MemberIssuePayload[]): Promise<void> {
    if (!config.issues.apiUrl) return;

    const toSend: MemberIssuePayload[] = [];
    for (const issue of issues) {
      const key = this.getKey(issue);
      if (this.sentKeys.has(key)) continue;
      this.sentKeys.add(key);
      toSend.push(issue);
    }

    if (toSend.length === 0) return;

    try {
      const isHttps = config.issues.apiUrl.startsWith('https:');
      const response = await fetch(config.issues.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.issues.apiKey ? { 'x-api-key': config.issues.apiKey } : {}),
        },
        body: JSON.stringify(toSend),
        agent: isHttps ? httpsAgent : undefined,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(`Failed to report issue batch: ${response.status} ${response.statusText} ${body}`);
      } else {
        logger.info(`Reported issue batch (${toSend.length} issues)`);
      }
    } catch (error) {
      logger.warn(`Issue reporter batch error: ${(error as Error).message}`);
    }
  }
}

export const issueReporter = new IssueReporter();


