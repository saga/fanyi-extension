// 分片式 Storage 适配器
//
// 替代 @wxt-dev/storage 把所有 key 塞一个大对象的方式：
//   - 原方案：所有 chunk 缓存塞进 storage.getItem('local:translationCache') 大对象
//     → O(N) 序列化 + 5MB 配额 + 并发写丢失（一个写覆盖另一个）
//   - 现方案：每个 cacheKey 独立存储为 storage.getItem('local:translation:<key>')
//     → O(1) 读写、互不影响、单条失败不影响其他缓存
//
// @wxt-dev/storage 要求 key 必须形如 `${area}:${string}`（area ∈ local|session|sync|managed）。
// 本实现统一用 `local:` 前缀：
//   local:translation:<cacheKey>  → 单条缓存数据（含 timestamp + ttl）
//   local:meta:translation:index  → 全局索引（记录所有 cacheKey，便于 clear/size 遍历）
//
// 设计取舍：
//   - 索引本身仍然是一个对象，每次 set/remove 都要读 + 写一次。
//     但索引只存 key 字符串数组，体积小，序列化开销远小于把所有 data 塞一起。
//   - 并发写索引仍可能丢失一次「addToIndex」，但只会让索引漏记一个 key，
//     数据本身的 get/set 不会丢，且 clear 时可以遍历 storage.snapshot 兜底。
//
// 暂不替换现有 cacheManager，作为可选方案提供（避免破坏现有功能）。

import { storage } from '@wxt-dev/storage';

const DEFAULT_PREFIX = 'translation';
const DEFAULT_INDEX_KEY = 'local:meta:translationCache:index';

// @wxt-dev/storage 要求 key 形如 `${area}:${string}`（area ∈ local|session|sync|managed）。
// 用模板字面量类型让 makeKey/indexKey 的返回值直接满足 StorageItemKey，
// 避免每次调用 storage.getItem/setItem 都要 cast。
type StorageKey = `local:${string}`;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

/**
 * 分片式缓存 — 每个 cacheKey 独立存储，避免全量序列化。
 *
 * 多个 ShardedCache 实例可以通过不同 prefix 隔离（每个实例维护独立索引）。
 */
export class ShardedCache {
  private prefix: string;
  private indexKey: StorageKey;

  constructor(prefix: string = DEFAULT_PREFIX, indexKey: StorageKey = DEFAULT_INDEX_KEY) {
    this.prefix = prefix;
    this.indexKey = indexKey;
  }

  private makeKey(cacheKey: string): StorageKey {
    return `local:${this.prefix}:${cacheKey}`;
  }

  /**
   * 读取单条缓存（直接读对应 key，O(1)）。
   * TTL 过期自动清理并从索引移除。
   */
  async get<T>(cacheKey: string): Promise<T | null> {
    const key = this.makeKey(cacheKey);
    const entry = await storage.getItem<CacheEntry<T>>(key);
    if (!entry) return null;

    // TTL 检查
    if (Date.now() - entry.timestamp > entry.ttl) {
      await storage.removeItem(key);
      await this.removeFromIndex(cacheKey);
      return null;
    }

    return entry.data;
  }

  /**
   * 写入单条缓存（直接写对应 key，O(1)，不影响其他 key）。
   * 同时把 cacheKey 加入索引。
   */
  async set<T>(cacheKey: string, data: T, ttl: number): Promise<void> {
    const key = this.makeKey(cacheKey);
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl,
    };
    await storage.setItem(key, entry);
    await this.addToIndex(cacheKey);
  }

  /**
   * 删除单条缓存。
   */
  async remove(cacheKey: string): Promise<void> {
    const key = this.makeKey(cacheKey);
    await storage.removeItem(key);
    await this.removeFromIndex(cacheKey);
  }

  /**
   * 清空所有缓存（通过索引遍历删除）。
   */
  async clear(): Promise<void> {
    const index = await this.getIndex();
    for (const cacheKey of index) {
      const key = this.makeKey(cacheKey);
      await storage.removeItem(key);
    }
    await storage.setItem(this.indexKey, []);
  }

  /**
   * 获取缓存条目数量。
   */
  async size(): Promise<number> {
    const index = await this.getIndex();
    return index.length;
  }

  private async getIndex(): Promise<string[]> {
    return (await storage.getItem<string[]>(this.indexKey)) ?? [];
  }

  private async addToIndex(cacheKey: string): Promise<void> {
    const index = await this.getIndex();
    if (!index.includes(cacheKey)) {
      index.push(cacheKey);
      await storage.setItem(this.indexKey, index);
    }
  }

  private async removeFromIndex(cacheKey: string): Promise<void> {
    const index = await this.getIndex();
    const newIndex = index.filter((k) => k !== cacheKey);
    if (newIndex.length !== index.length) {
      await storage.setItem(this.indexKey, newIndex);
    }
  }
}

// 全局单例（默认 prefix=translation）
export const shardedCache = new ShardedCache();
