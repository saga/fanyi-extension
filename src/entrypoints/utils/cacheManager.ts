import { storage } from '@wxt-dev/storage';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class CacheManager {
  private memoryCache = new Map<string, CacheEntry<any>>();
  private storageKey: string;
  private defaultTTL: number;

  constructor(storageKey: string, defaultTTL = 24 * 60 * 60 * 1000) {
    this.storageKey = storageKey;
    this.defaultTTL = defaultTTL;
  }

  async get<T>(key: string): Promise<T | null> {
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry && !this.isExpired(memoryEntry)) {
      return memoryEntry.data;
    }

    if (memoryEntry) {
      this.memoryCache.delete(key);
    }

    try {
      const entries = await storage.getItem<Record<string, CacheEntry<T>>>(this.storageKey);
      if (entries && entries[key]) {
        const entry = entries[key];
        if (!this.isExpired(entry)) {
          this.memoryCache.set(key, entry);
          return entry.data;
        }
        delete entries[key];
        await storage.setItem(this.storageKey, entries);
      }
    } catch {
      // Storage error, return null
    }

    return null;
  }

  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
    };

    this.memoryCache.set(key, entry);

    try {
      const entries = (await storage.getItem<Record<string, CacheEntry<T>>>(this.storageKey)) || {};
      entries[key] = entry;
      await storage.setItem(this.storageKey, entries);
    } catch {
      // Storage error, memory cache still works
    }
  }

  async remove(key: string): Promise<void> {
    this.memoryCache.delete(key);

    try {
      const entries = await storage.getItem<Record<string, CacheEntry<any>>>(this.storageKey);
      if (entries) {
        delete entries[key];
        await storage.setItem(this.storageKey, entries);
      }
    } catch {
      // Storage error, ignore
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    await storage.setItem(this.storageKey, {});
  }

  async getStats(): Promise<{ memorySize: number; storageSize: number }> {
    let storageSize = 0;
    try {
      const entries = await storage.getItem<Record<string, CacheEntry<any>>>(this.storageKey);
      storageSize = entries ? Object.keys(entries).length : 0;
    } catch {
      // ignore
    }

    return {
      memorySize: this.memoryCache.size,
      storageSize,
    };
  }

  private isExpired(entry: CacheEntry<any>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }
}

export const analysisCache = new CacheManager('local:analysisCache');
export const translationCache = new CacheManager('local:translationCache');
export const glossaryCache = new CacheManager('local:glossaryCache');
