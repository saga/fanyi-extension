import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheManager } from '../entrypoints/utils/cacheManager';

// Mock @wxt-dev/storage
const store: Record<string, any> = {};
vi.mock('@wxt-dev/storage', () => {
  return {
    storage: {
      getItem: vi.fn(async (key: string) => store[key] ?? null),
      setItem: vi.fn(async (key: string, value: any) => {
        store[key] = value;
      }),
    },
  };
});

describe('CacheManager', () => {
  let cache: CacheManager;

  beforeEach(() => {
    // Clear the shared mock storage between tests
    Object.keys(store).forEach(k => delete store[k]);
    cache = new CacheManager('test:cache', 1000);
  });

  // --- set and get ---

  it('stores and retrieves a value', async () => {
    await cache.set('key1', 'value1');
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');
  });

  it('returns null for missing key', async () => {
    const result = await cache.get<string>('nonexistent');
    expect(result).toBeNull();
  });

  it('stores and retrieves objects', async () => {
    const obj = { name: 'test', count: 42, nested: { deep: true } };
    await cache.set('obj', obj);
    const result = await cache.get<typeof obj>('obj');
    expect(result).toEqual(obj);
  });

  it('uses custom TTL', async () => {
    // Set with very short TTL
    await cache.set('key1', 'value1', 100);
    await new Promise(r => setTimeout(r, 150));
    const result = await cache.get<string>('key1');
    expect(result).toBeNull();
  });

  it('uses default TTL when not specified', async () => {
    const cache1 = new CacheManager('test:cache2', 100);
    await cache1.set('key1', 'value1');
    await new Promise(r => setTimeout(r, 150));
    const result = await cache1.get<string>('key1');
    expect(result).toBeNull();
  });

  // --- remove ---

  it('removes a key', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');
    await cache.remove('key1');

    expect(await cache.get<string>('key1')).toBeNull();
    expect(await cache.get<string>('key2')).toBe('value2');
  });

  // --- clear ---

  it('clears all entries', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');
    await cache.clear();

    expect(await cache.get<string>('key1')).toBeNull();
    expect(await cache.get<string>('key2')).toBeNull();
  });

  // --- getStats ---

  it('reports memory and storage stats', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');

    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(2);
    expect(stats.storageSize).toBe(2);
  });

  it('reports zero stats for empty cache', async () => {
    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(0);
    expect(stats.storageSize).toBe(0);
  });

  // --- expiry ---

  it('removes expired entries from memory', async () => {
    await cache.set('key1', 'value1', 50);
    await new Promise(r => setTimeout(r, 100));

    const result = await cache.get<string>('key1');
    expect(result).toBeNull();

    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(0);
  });

  // --- memory cache (in-session speed) ---

  it('serves from memory cache on subsequent access', async () => {
    await cache.set('key1', 'value1');
    // First get should populate memory cache
    await cache.get<string>('key1');
    // Second get should hit memory cache
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');
  });

  // --- multiple instances ---

  it('isolates data between different cache instances', async () => {
    const cache1 = new CacheManager('test:cache:a');
    const cache2 = new CacheManager('test:cache:b');

    await cache1.set('key', 'valueA');
    await cache2.set('key', 'valueB');

    expect(await cache1.get<string>('key')).toBe('valueA');
    expect(await cache2.get<string>('key')).toBe('valueB');
  });

  // --- storage error recovery ---

  it('falls back to memory cache when storage get fails', async () => {
    // First set normally (populates both memory and storage)
    await cache.set('key1', 'value1');

    // Now make storage.get throw
    const mockStore = await import('@wxt-dev/storage');
    const originalGet = mockStore.storage.getItem;
    mockStore.storage.getItem = vi.fn(async () => {
      throw new Error('Storage unavailable');
    });

    // Memory cache should still serve the value
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');

    mockStore.storage.getItem = originalGet;
  });

  it('returns null when storage get fails and memory cache is empty', async () => {
    const mockStore = await import('@wxt-dev/storage');
    const originalGet = mockStore.storage.getItem;
    mockStore.storage.getItem = vi.fn(async () => {
      throw new Error('Storage unavailable');
    });

    const result = await cache.get<string>('nonexistent');
    expect(result).toBeNull();

    mockStore.storage.getItem = originalGet;
  });

  it('still writes to memory cache when storage set fails', async () => {
    const mockStore = await import('@wxt-dev/storage');
    const originalSet = mockStore.storage.setItem;
    mockStore.storage.setItem = vi.fn(async () => {
      throw new Error('Storage write failed');
    });

    await cache.set('key1', 'value1');
    // Memory cache should still work
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');

    mockStore.storage.setItem = originalSet;
  });

  it('handles remove when storage is unavailable', async () => {
    await cache.set('key1', 'value1');

    const mockStore = await import('@wxt-dev/storage');
    const originalGet = mockStore.storage.getItem;
    mockStore.storage.getItem = vi.fn(async () => {
      throw new Error('Storage unavailable');
    });

    // Should not throw — memory cache is cleared
    await cache.remove('key1');
    expect(await cache.get<string>('key1')).toBeNull();

    mockStore.storage.getItem = originalGet;
  });

  it('reports memory stats correctly even when storage is unavailable', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');

    const mockStore = await import('@wxt-dev/storage');
    const originalGet = mockStore.storage.getItem;
    mockStore.storage.getItem = vi.fn(async () => {
      throw new Error('Storage unavailable');
    });

    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(2);
    expect(stats.storageSize).toBe(0); // storage read failed

    mockStore.storage.getItem = originalGet;
  });

  // --- parallel operations ---

  it('handles concurrent set operations', async () => {
    await Promise.all([
      cache.set('key1', 'value1'),
      cache.set('key2', 'value2'),
      cache.set('key3', 'value3'),
      cache.set('key4', 'value4'),
      cache.set('key5', 'value5'),
    ]);

    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(5);

    expect(await cache.get<string>('key1')).toBe('value1');
    expect(await cache.get<string>('key5')).toBe('value5');
  });

  it('handles concurrent get and set operations', async () => {
    await cache.set('key1', 'value1');

    const [result1, result2] = await Promise.all([
      cache.get<string>('key1'),
      (async () => {
        await cache.set('key2', 'value2');
        return await cache.get<string>('key1');
      })(),
    ]);

    expect(result1).toBe('value1');
    expect(result2).toBe('value1');
  });

  // --- overwrite ---

  it('overwrites existing value with same key', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key1', 'updated');
    expect(await cache.get<string>('key1')).toBe('updated');
  });

  it('overwrites object value', async () => {
    await cache.set('obj', { a: 1 });
    await cache.set('obj', { a: 2, b: 3 });
    const result = await cache.get<Record<string, number>>('obj');
    expect(result).toEqual({ a: 2, b: 3 });
  });

  // --- TTL boundary ---

  it('returns value exactly at TTL boundary (not expired)', async () => {
    const ttl = 200;
    await cache.set('key1', 'value1', ttl);

    // Wait just under TTL
    await new Promise(r => setTimeout(r, ttl - 50));
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');
  });

  it('expires value just after TTL boundary', async () => {
    await cache.set('key1', 'value1', 100);
    await new Promise(r => setTimeout(r, 150));
    const result = await cache.get<string>('key1');
    expect(result).toBeNull();
  });
});