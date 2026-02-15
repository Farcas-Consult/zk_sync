import fetch from 'node-fetch';
import { httpsAgent } from '../config/index.js';

const IMAGE_FETCH_TIMEOUT = 10000; // 10 seconds
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Converts an image URL to base64-encoded string
 * @param url The URL of the image to convert
 * @returns Promise resolving to base64-encoded image string
 * @throws Error if the image cannot be fetched or converted
 */
export async function urlToBase64(url: string): Promise<string> {
  if (!url || url.trim() === '') {
    throw new Error('Image URL is required');
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT);

    const isHttps = url.startsWith('https:');
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      agent: isHttps ? httpsAgent : undefined,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
      throw new Error(`Invalid content type: ${contentType}. Expected an image.`);
    }

    const buffer = await response.buffer();

    if (buffer.length === 0) {
      throw new Error('Image file is empty');
    }

    if (buffer.length > MAX_IMAGE_SIZE) {
      throw new Error(`Image file too large: ${buffer.length} bytes (max: ${MAX_IMAGE_SIZE} bytes)`);
    }

    return buffer.toString('base64');
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error(`Image fetch timeout after ${IMAGE_FETCH_TIMEOUT}ms`);
      }
      throw new Error(`Failed to convert image URL to base64: ${error.message}`);
    }
    throw new Error(`Failed to convert image URL to base64: ${String(error)}`);
  }
}

