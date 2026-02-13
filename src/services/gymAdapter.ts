import type {
  GymMember,
  GymApiResponse,
  GymMasterApiResponse,
  GymMasterMember,
  GymApiSource,
} from '../types/index.js';

export interface GymAdapter {
  transform(rawResponse: unknown): GymMember[];
  validateResponse(rawResponse: unknown): boolean;
}

class Fitness254Adapter implements GymAdapter {
  validateResponse(rawResponse: unknown): boolean {
    const response = rawResponse as GymApiResponse;
    return response?.success === true && Array.isArray(response?.data);
  }

  transform(rawResponse: unknown): GymMember[] {
    const response = rawResponse as GymApiResponse;
    return response.data;
  }
}

class GymMasterAdapter implements GymAdapter {
  validateResponse(rawResponse: unknown): boolean {
    const response = rawResponse as GymMasterApiResponse;
    return Array.isArray(response?.result);
  }

  transform(rawResponse: unknown): GymMember[] {
    const response = rawResponse as GymMasterApiResponse;
    return response.result.map((member) => this.transformMember(member));
  }

  private transformMember(member: GymMasterMember): GymMember {
    const owingAmount = parseFloat(member.owing?.replace(/[^\d.-]/g, '') || '0');
    const isActive = member.status === 'Current' && owingAmount <= 0;

    return {
      turnstileId: member.id,
      fullName: [member.firstname, member.surname].filter(Boolean).join(' '),
      email: member.email || undefined,
      phoneNumber: member.phonecell || undefined,
      profilePictureUrl: member.memberphoto || null,
      gender: member.gender || null,
      membershipStatus: isActive ? 'active' : 'inactive',
      isActive,
    };
  }
}

export function createGymAdapter(source: GymApiSource): GymAdapter {
  switch (source) {
    case 'gymmaster':
      return new GymMasterAdapter();
    case 'fitness254':
    default:
      return new Fitness254Adapter();
  }
}
