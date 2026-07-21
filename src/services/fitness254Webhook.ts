import type { Fitness254WebhookEvent, GymMember } from '../types/index.js';

const MEMBER_EVENT_TYPES = new Set<Fitness254WebhookEvent['type']>([
  'member.created',
  'member.updated',
  'member.activated',
  'member.deactivated',
  'member.frozen',
  'member.unfrozen',
  'member.expired',
  'member.cancelled',
  'member.deleted',
]);

export function isFitness254WebhookEvent(value: unknown): value is Fitness254WebhookEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<Fitness254WebhookEvent>;
  return typeof event.id === 'string' && typeof event.type === 'string' && !!event.data;
}

export function isMemberWebhookEvent(event: Fitness254WebhookEvent): boolean {
  return MEMBER_EVENT_TYPES.has(event.type);
}

export function memberFromFitness254Webhook(event: Fitness254WebhookEvent): GymMember {
  const rawMember = event.data.member;
  const rawTurnstileId = rawMember?.turnstile_id;
  const turnstileId = typeof rawTurnstileId === 'number' ? rawTurnstileId : Number(rawTurnstileId);
  if (!Number.isSafeInteger(turnstileId) || turnstileId < 0) {
    throw new Error(`Webhook ${event.id} has no valid member turnstile_id`);
  }

  const gender = normalizeGender(rawMember?.profile?.gender);
  return {
    turnstileId,
    fullName: rawMember?.profile?.display_name?.trim() || '',
    email: rawMember?.profile?.email || undefined,
    phoneNumber: rawMember?.profile?.phone || undefined,
    profilePictureUrl: rawMember?.profile?.profile_image_url || null,
    gender,
    membershipStatus: rawMember?.membership_status || 'inactive',
    isActive: rawMember?.account_status === 'active' && rawMember?.access_allowed === true,
  };
}

function normalizeGender(value: string | null | undefined): 'M' | 'F' | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'f' || normalized === 'female') return 'F';
  if (normalized === 'm' || normalized === 'male') return 'M';
  return null;
}
