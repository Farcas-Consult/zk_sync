export interface ZKBioPerson {
  pin: string;
  name?: string;
  lastName?: string;
  email?: string;
  mobilePhone?: string;
  deptCode?: string;
  accLevelIds?: string | null;
  accStartTime?: string | null;
  accEndTime?: string | null;
  isDisabled?: boolean;
  gender?: 'M' | 'F';
  cardNo?: string;
  personPhoto?: string;
  [key: string]: unknown;
}

export interface ZKBioApiResponse<T = unknown> {
  code: number;
  message: string;
  data?: T;
}

export interface ZKBioPersonListResponse {
  list?: ZKBioPerson[];
  data?: ZKBioPerson[];
  persons?: ZKBioPerson[];
  result?: ZKBioPerson[];
}

export interface PersonListOptions {
  deptCodes?: string;
  pins?: string;
  pageNo?: number;
  pageSize?: number;
}

export interface PersonUpdateData {
  name?: string;
  lastName?: string;
  email?: string;
  mobilePhone?: string;
  deptCode?: string;
  accLevelIds?: string | null;
  accStartTime?: string | null;
  accEndTime?: string | null;
  isDisabled?: boolean;
  personPhoto?: string;
}

export interface GymMember {
  turnstileId: number;
  fullName: string;
  email?: string;
  phoneNumber?: string;
  profilePictureUrl?: string | null;
  gender?: 'M' | 'F' | null;
  membershipStatus: string;
  isActive: boolean;
}

export interface GymApiResponse {
  success: boolean;
  data: GymMember[];
}

export interface NotificationState {
  lastMessages: Record<string, number>;
  lastHeartbeat: number;
  authFailures: number;
}

export type NotificationType = 
  | 'heartbeat'
  | 'auth_error'
  | 'api_error'
  | 'batch_fetch_error'
  | 'batch_processing_required'
  | 'critical_error'
  | 'recovery'
  | 'shutdown'
  | 'startup'
  | 'startup_failed'
  | 'fatal_error'
  | 'unhandled_error'
  | 'zkbio_batch_auth_error';

