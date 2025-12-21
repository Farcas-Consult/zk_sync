import fs from 'fs';
import { logger } from './logger.js';

interface MemberIssue {
  turnstileId: number;
  fullName: string | null;
  errorCode: number | null;
  errorType: string;
  errorMessage: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

class MemberIssuesLogger {
  private issuesFile: string;
  private issues: Map<string, MemberIssue> = new Map();

  constructor(issuesFile = 'member_issues.json') {
    this.issuesFile = issuesFile;
    this.loadIssues();
  }

  private getIssueKey(turnstileId: number, errorCode: number | null, errorType: string): string {
    return `${turnstileId}:${errorCode ?? 'null'}:${errorType}`;
  }

  private loadIssues(): void {
    try {
      if (fs.existsSync(this.issuesFile)) {
        const data = fs.readFileSync(this.issuesFile, 'utf-8');
        const issuesArray = JSON.parse(data) as MemberIssue[];
        for (const issue of issuesArray) {
          const key = this.getIssueKey(issue.turnstileId, issue.errorCode, issue.errorType);
          this.issues.set(key, issue);
        }
        logger.info(`Loaded ${this.issues.size} existing member issues from ${this.issuesFile}`);
      }
    } catch (error) {
      logger.warn(`Failed to load member issues file: ${(error as Error).message}`);
    }
  }

  logIssue(
    turnstileId: number,
    fullName: string | null,
    errorCode: number | null,
    errorType: string,
    errorMessage: string
  ): void {
    const key = this.getIssueKey(turnstileId, errorCode, errorType);
    const now = new Date().toISOString();

    const existing = this.issues.get(key);
    if (existing) {
      existing.lastSeen = now;
      existing.count += 1;
      existing.errorMessage = errorMessage;
      if (fullName && !existing.fullName) {
        existing.fullName = fullName;
      }
    } else {
      this.issues.set(key, {
        turnstileId,
        fullName,
        errorCode,
        errorType,
        errorMessage,
        firstSeen: now,
        lastSeen: now,
        count: 1,
      });
    }

    this.saveIssues();
  }

  private saveIssues(): void {
    try {
      const issuesArray = Array.from(this.issues.values()).sort((a, b) => {
        if (a.turnstileId !== b.turnstileId) {
          return a.turnstileId - b.turnstileId;
        }
        return (a.errorCode ?? 0) - (b.errorCode ?? 0);
      });

      const data = JSON.stringify(issuesArray, null, 2);
      fs.writeFileSync(this.issuesFile, data, 'utf-8');
    } catch (error) {
      logger.error(`Failed to save member issues: ${(error as Error).message}`);
    }
  }

  getIssues(): MemberIssue[] {
    return Array.from(this.issues.values());
  }

  getIssueCount(): number {
    return this.issues.size;
  }

  clearIssues(): void {
    this.issues.clear();
    if (fs.existsSync(this.issuesFile)) {
      fs.unlinkSync(this.issuesFile);
    }
    logger.info('Cleared all member issues');
  }
}

export const memberIssuesLogger = new MemberIssuesLogger();

