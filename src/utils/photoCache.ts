import fs from 'fs';
import { logger } from './logger.js';
import { urlToBase64 } from './imageConverter.js';

interface PhotoCacheEntry {
  turnstileId: number;
  url: string;
  base64: string;
  lastUpdated: string;
}

class PhotoCache {
  private cacheFile: string;
  private entries: Map<string, PhotoCacheEntry> = new Map();

  constructor(cacheFile = 'photo_cache.json') {
    this.cacheFile = cacheFile;
    this.load();
  }

  private getKey(turnstileId: number, url: string): string {
    return `${turnstileId}:${url}`;
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.cacheFile)) return;
      const data = fs.readFileSync(this.cacheFile, 'utf-8');
      if (!data.trim()) return;

      const arr = JSON.parse(data) as PhotoCacheEntry[];
      for (const entry of arr) {
        const key = this.getKey(entry.turnstileId, entry.url);
        this.entries.set(key, entry);
      }
      logger.info(`Loaded ${this.entries.size} cached photos from ${this.cacheFile}`);
    } catch (error) {
      logger.warn(`Failed to load photo cache: ${(error as Error).message}`);
    }
  }

  private save(): void {
    try {
      const arr = Array.from(this.entries.values());
      const json = JSON.stringify(arr, null, 2);
      fs.writeFileSync(this.cacheFile, json, 'utf-8');
    } catch (error) {
      logger.error(`Failed to save photo cache: ${(error as Error).message}`);
    }
  }

  async getOrFetchBase64(turnstileId: number, url: string): Promise<string> {
    const key = this.getKey(turnstileId, url);
    const existing = this.entries.get(key);

    if (existing) {
      return existing.base64;
    }

    const base64 = await urlToBase64(url);

    const entry: PhotoCacheEntry = {
      turnstileId,
      url,
      base64,
      lastUpdated: new Date().toISOString(),
    };

    this.entries.set(key, entry);
    this.save();

    return base64;
  }
}

export const photoCache = new PhotoCache();


