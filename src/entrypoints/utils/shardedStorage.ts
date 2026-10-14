// 分片式翻译缓存。
//
// 每条缓存独立存储，避免将所有页面译文放进一个超大的 local:translationCache 对象：
// 1. 读写不需要反复序列化全部缓存；
// 2. 并发更新通过写队列串行维护索引，避免互相覆盖；
// 3. Storage 配额/权限等故障只会导致缓存 miss，不会阻断翻译；
// 4. 旧版单对象缓存会在首次使用时尽力迁移。缓存仅是加速层，迁移失败不影响翻译本身。

import { storage } from '@wxt-dev/storage';

const DEFAULT_PREFIX = 'translation';
const DEFAULT_INDEX_KEY = 'local:meta:translationCache:index';
type StorageKey = string;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

function isCacheEntry<T>(value: unknown): value is CacheEntry<T> {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CacheEntry<T>>;
  return typeof entry.timestamp === 'number' &&
    Number.isFinite(entry.timestamp) &&
    typeof entry.ttl === 'number' &&
    Number.isFinite(entry.ttl) &&
    'data' in entry;
}

/**
 * 分片缓存。所有会更改索引的操作都走同一写队列，防止 concurrent get→modify→set 丢更新。
 * @param prefix 当前缓存命名空间；不同用途必须使用不同 prefix/indexKey
 * @param indexKey 索引项的 Storage key
 * @param legacyStorageKey 可选的旧版单对象缓存 key，仅用于迁移现有翻译缓存
 */
export class ShardedCache {
  private prefix: string;
  private indexKey: StorageKey;
  private legacyStorageKey?: string;
  private memoryCache = new Map<string, CacheEntry<unknown>>();
  private writeQueue: Promise<void> = Promise.resolve();
  private migration: Promise<void> | null = null;
  private readonly defaultTTL: number;

  constructor(
    prefix: string = DEFAULT_PREFIX,
    indexKey: StorageKey = DEFAULT_INDEX_KEY,
    legacyStorageKey?: string,
    defaultTTL = 7 * 24 * 60 * 60 * 1000,
  ) {
    this.prefix = prefix;
    this.indexKey = indexKey;
    this.legacyStorageKey = legacyStorageKey;
    this.defaultTTL = defaultTTL;
  }

  private makeKey(cacheKey: string): StorageKey {
    return 'local:' + this.prefix + ':' + cacheKey;
  }

  /** 将写操作排队；即使前一个操作失败，队列也可继续工作。 */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(work, work);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readIndex(): Promise<string[]> {
    const raw = await storage.getItem<unknown>(this.indexKey);
    if (!Array.isArray(raw)) return [];
    return raw.filter((value): value is string => typeof value === 'string');
  }

  /**
   * 一次性迁移旧的 local:translationCache。先读入内存并删除旧大对象，
   * 再逐项写入分片，避免新旧两份数据同时占用 Storage 配额。
   * 中途失败可能丢失部分缓存，但不会丢失原文/译文等业务数据。
   */
  private async ensureMigrated(): Promise<void> {
    if (!this.legacyStorageKey) return;
    if (!this.migration) {
      this.migration = this.serialize(async () => {
        const legacy = await storage.getItem<Record<string, CacheEntry<unknown>>>(this.legacyStorageKey!);
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return;

        // Cache can be recalculated; removing the legacy blob first avoids a double-quota peak.
        await storage.removeItem(this.legacyStorageKey!);
        let index = await this.readIndex();
        const now = Date.now();
        for (const [cacheKey, entry] of Object.entries(legacy)) {
          if (!isCacheEntry(entry) || now - entry.timestamp > entry.ttl) continue;
          const storageKey = this.makeKey(cacheKey);
          if (!index.includes(cacheKey)) {
            index.push(cacheKey);
            await storage.setItem(this.indexKey, index);
          }
          await storage.setItem(storageKey, entry);
          this.memoryCache.set(cacheKey, entry);
        }
      }).catch(() => {
        // Migration is best effort. Allow a later attempt if storage failed before finishing.
        this.migration = null;
      });
    }
    await this.migration;
  }

  /** 读取单条缓存（O(1)）；已过期/存储不可用时按 miss 处理。 */
  async get<T>(cacheKey: string): Promise<T | null> {
    try { await this.ensureMigrated(); } catch { /* cache must not block translation */ }

    const memoryEntry = this.memoryCache.get(cacheKey) as CacheEntry<T> | undefined;
    if (memoryEntry && Date.now() - memoryEntry.timestamp <= memoryEntry.ttl) {
      return memoryEntry.data;
    }
    if (memoryEntry) this.memoryCache.delete(cacheKey);

    try {
      const entry = await storage.getItem<CacheEntry<T>>(this.makeKey(cacheKey));
      if (!entry || !isCacheEntry<T>(entry)) return null;
      if (Date.now() - entry.timestamp > entry.ttl) {
        await this.remove(cacheKey);
        return null;
      }
      this.memoryCache.set(cacheKey, entry);
      return entry.data;
    } catch {
      return null;
    }
  }

  /** 写入单条缓存；Storage 失败时仍保留当前进程的 memory cache。 */
  async set<T>(cacheKey: string, data: T, ttl?: number): Promise<void> {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: Number.isFinite(ttl) && (ttl as number) > 0 ? ttl as number : this.defaultTTL,
    };
    this.memoryCache.set(cacheKey, entry);
    try {
      await this.ensureMigrated();
      await this.serialize(async () => {
        let index = await this.readIndex();
        if (!index.includes(cacheKey)) {
          index = [...index, cacheKey];
          // Index first: if storing the entry fails, clear/prune can still find this orphan.
          await storage.setItem(this.indexKey, index);
        }
        await storage.setItem(this.makeKey(cacheKey), entry);
      });
    } catch {
      // Translation result remains usable even if persistent caching is unavailable.
    }
  }

  /** 删除单条缓存。 */
  async remove(cacheKey: string): Promise<void> {
    this.memoryCache.delete(cacheKey);
    try {
      await this.ensureMigrated();
      await this.serialize(async () => {
        await storage.removeItem(this.makeKey(cacheKey));
        const index = await this.readIndex();
        const next = index.filter((key) => key !== cacheKey);
        if (next.length !== index.length) await storage.setItem(this.indexKey, next);
      });
    } catch {
      // Cache maintenance errors must not interrupt translation.
    }
  }

  /** 清空所有翻译缓存（串行执行，避免与并发 set 竞争索引）。 */
  async clear(): Promise<void> {
    this.memoryCache.clear();
    try {
      await this.ensureMigrated();
      await this.serialize(async () => {
        const index = await this.readIndex();
        for (const cacheKey of index) {
          await storage.removeItem(this.makeKey(cacheKey));
        }
        await storage.setItem(this.indexKey, []);
        if (this.legacyStorageKey) await storage.removeItem(this.legacyStorageKey).catch(() => undefined);
      });
    } catch {
      // Translation continues even if the browser prevents cache cleanup.
    }
  }

  /** 主动清理过期项；同时移除索引中已无数据的孤儿 key。 */
  async pruneExpired(): Promise<number> {
    this.memoryCache.clear();
    try {
      await this.ensureMigrated();
      return await this.serialize(async () => {
        const index = await this.readIndex();
        const keep: string[] = [];
        let removed = 0;
        const now = Date.now();
        for (const cacheKey of index) {
          let entry: CacheEntry<unknown> | null;
          try {
            entry = await storage.getItem<CacheEntry<unknown>>(this.makeKey(cacheKey));
          } catch {
            // If storage is temporarily unreadable, keep the key in the index for a later pass.
            keep.push(cacheKey);
            continue;
          }
          if (!entry) {
            removed++;
          } else if (!isCacheEntry(entry) || now - entry.timestamp > entry.ttl) {
            await storage.removeItem(this.makeKey(cacheKey));
            removed++;
          } else {
            keep.push(cacheKey);
          }
        }
        if (keep.length !== index.length) await storage.setItem(this.indexKey, keep);
        return removed;
      });
    } catch {
      return 0;
    }
  }

  async size(): Promise<number> {
    try {
      await this.ensureMigrated();
      return (await this.readIndex()).length;
    } catch {
      return 0;
    }
  }

  async getStats(): Promise<{ memorySize: number; storageSize: number }> {
    try {
      await this.ensureMigrated();
      return { memorySize: this.memoryCache.size, storageSize: (await this.readIndex()).length };
    } catch {
      return { memorySize: this.memoryCache.size, storageSize: 0 };
    }
  }
}

/**
 * 与旧版 local:translationCache 兼容迁移的全局实例。
 * translationCache.clear()/pruneExpired()/getStats() 均继续可用。
 */
export const shardedCache = new ShardedCache(
  'translation',
  DEFAULT_INDEX_KEY,
  'local:translationCache',
);
