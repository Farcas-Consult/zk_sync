export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkArray<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

export function normalizeAccessLevel(level: string | null | undefined): string | null {
  return level === '' || level === null || level === undefined ? null : level;
}

export function parseName(fullName: string | null | undefined): { firstName: string; lastName: string } {
  if (!fullName || typeof fullName !== 'string') {
    return {
      firstName: 'Unknown',
      lastName: 'Member',
    };
  }
  const nameParts = fullName.trim().split(' ');
  return {
    firstName: nameParts[0] || 'Unknown',
    lastName: nameParts.slice(1).join(' ') || 'Member',
  };
}

export function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

