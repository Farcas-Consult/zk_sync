import { urlToBase64 } from './imageConverter.js';

/**
 * Fetches and converts a photo URL to base64 on demand.
 * No persistence or in-memory caching to avoid high memory usage.
 * Photos are only fetched when needed (create or when ZK has no photo).
 */
async function getBase64(_turnstileId: number, url: string): Promise<string> {
  return urlToBase64(url);
}

export const photoCache = {
  getOrFetchBase64: getBase64,
};
