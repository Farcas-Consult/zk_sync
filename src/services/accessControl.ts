import type { GymMember } from '../types/index.js';
import type { MemberIssuePayload } from '../utils/issueReporter.js';

export interface AccessControlPersonSnapshot {
  externalId: string;
  personId?: string;
  fullName?: string | null;
  gender?: 'M' | 'F' | null;
  orgCode?: string | null;
  hasAccess?: boolean;
  raw?: unknown;
}

export interface AccessControlContext {
  shouldHaveAccess: boolean;
  isFemale: boolean;
  reportIssue: (issue: MemberIssuePayload) => void;
}

export interface AccessControlClient {
  readonly vendor: 'zkbio' | 'hikvision';

  /**
   * Optionally prefetch existing persons for a list of external IDs (turnstileIds).
   * Implementations that do not support batch lookup can return an empty map.
   */
  prefetchExistingPersons(
    externalIds: string[]
  ): Promise<Record<string, AccessControlPersonSnapshot>>;

  /**
   * Look up exactly one person for an incremental webhook update. Implementations
   * should use this instead of an all-person prefetch when available.
   */
  lookupExistingPerson?(externalId: string): Promise<AccessControlPersonSnapshot | null>;

  /**
   * Ensure a member exists with up-to-date profile and access attributes.
   * Implementations should be idempotent.
   */
  ensureMember(
    member: GymMember,
    existingSnapshot: AccessControlPersonSnapshot | null,
    context: AccessControlContext
  ): Promise<boolean>;

  /**
   * Record a per-member issue for this client, if needed.
   * Implementations may be a no-op and let the caller handle logging.
   */
  handleMemberError?(
    member: GymMember,
    error: unknown,
    addRunIssue: (issue: MemberIssuePayload) => void
  ): Promise<void>;

  /**
   * Flush any queued changes (e.g. trigger Hikvision reapplication).
   * For ZKBio this is a no-op.
   */
  flushChanges(): Promise<void>;
}
