import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ShardedCache } from '../entrypoints/utils/shardedStorage';

// Mock @wxt-dev/storage
// 把 store 声明在 mock 工厂外面，方便 beforeEach 清空（参考 cacheManager.test.ts 的写法）
const store: Record<string, any> = {};
vi.mock('@wxt-dev/storage', () => {
  return {
    storage: {
      getItem: vi.fn(async (key: string) => store[key] ?? null),
      setItem: vi.fn(async (key: string, value: any) => {
        store[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete store[key];
      }),
    },
  };
});

describe('ShardedCache', () => {
  let cache: ShardedCache;

  beforeEach(() => {
    // 清空 mock storage + 重置 mock 调用记录
    Object.keys(store).forEach((k) => delete store[k]);
    vi.clearAllMocks();
    // 用独立 prefix + 独立 indexKey，避免污染其他测试
    cache = new ShardedCache('test', 'local:meta:test:index');
  });

  // --- get / set 基础 ---

  it('returns null for missing key', async () => {
    const result = await cache.get('missing');
    expect(result).toBeNull();
  });

  it('stores and retrieves data', async () => {
    await cache.set('key1', 'value1', 60000);
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');
  });

  it('stores and retrieves objects', async () => {
    const obj = { name: 'test', count: 42, nested: { deep: true } };
    await cache.set('obj', obj, 60000);
    const result = await cache.get<typeof obj>('obj');
    expect(result).toEqual(obj);
  });

  // --- remove ---

  it('removes data', async () => {
    await cache.set('key1', 'value1', 60000);
    await cache.remove('key1');
    const result = await cache.get('key1');
    expect(result).toBeNull();
  });

  it('remove on missing key is a no-op', async () => {
    await expect(cache.remove('never-set')).resolves.toBeUndefined();
  });

  // --- TTL 过期 ---

  it('expires after TTL', async () => {
    // TTL = 1ms，等一下再读
    await cache.set('key1', 'value1', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await cache.get('key1');
    expect(result).toBeNull();
  });


  // --- clear ---

  it('clears all entries', async () => {
    await cache.set('key1', 'value1', 60000);
    await cache.set('key2', 'value2', 60000);
    await cache.clear();
    expect(await cache.get('key1')).toBeNull();
    expect(await cache.get('key2')).toBeNull();
  });

  it('clear on empty cache is a no-op', async () => {
    await expect(cache.clear()).resolves.toBeUndefined();
    expect(await cache.size()).toBe(0);
  });

  // --- size / index ---

  it('tracks size correctly', async () => {
    expect(await cache.size()).toBe(0);
    await cache.set('key1', 'value1', 60000);
    expect(await cache.size()).toBe(1);
    await cache.set('key2', 'value2', 60000);
    expect(await cache.size()).toBe(2);
  });

  it('size decreases after remove', async () => {
    await cache.set('key1', 'value1', 60000);
    await cache.set('key2', 'value2', 60000);
    expect(await cache.size()).toBe(2);
    await cache.remove('key1');
    expect(await cache.size()).toBe(1);
  });


  it('set same key twice does not duplicate index entry', async () => {
    await cache.set('key1', 'value1', 60000);
    await cache.set('key1', 'value2', 60000);
    expect(await cache.size()).toBe(1);
    const result = await cache.get<string>('key1');
    expect(result).toBe('value2');
  });

  it('serializes concurrent writes without dropping index entries', async () => {
    const keys = Array.from({ length: 30 }, (_, index) => 'page-' + index);
    await Promise.all(keys.map((key) => cache.set(key, 'translation:' + key, 60000)));
    expect(await cache.size()).toBe(keys.length);
    for (const key of keys) {
      expect(await cache.get<string>(key)).toBe('translation:' + key);
    }
  });

  it('migrates a legacy cache object to individual storage keys', async () => {
    store['local:legacy-cache'] = {
      oldPage: { data: 'old translation', timestamp: Date.now(), ttl: 60000 },
      expiredPage: { data: 'expired translation', timestamp: Date.now() - 120000, ttl: 1000 },
    };
    cache = new ShardedCache('test', 'local:meta:test:index', 'local:legacy-cache');

    expect(await cache.get<string>('oldPage')).toBe('old translation');
    expect(store).not.toHaveProperty('local:legacy-cache');
    expect(store).toHaveProperty('local:test:oldPage');
    expect(await cache.get('expiredPage')).toBeNull();
    expect(await cache.size()).toBe(1);
  });

  it('clear after migration also clears migrated in-memory entries', async () => {
    store['local:legacy-cache'] = {
      oldPage: { data: 'old translation', timestamp: Date.now(), ttl: 60000 },
    };
    cache = new ShardedCache('test', 'local:meta:test:index', 'local:legacy-cache');

    expect(await cache.get<string>('oldPage')).toBe('old translation');
    await cache.clear();
    expect(await cache.get('oldPage')).toBeNull();
    expect(await cache.size()).toBe(0);
  });

  it('expired items are removed by pruneExpired', async () => {
    await cache.set('expired', 'value', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await cache.pruneExpired()).toBe(1);
    expect(await cache.size()).toBe(0);
  });

  // --- 隔离性 ---


});
