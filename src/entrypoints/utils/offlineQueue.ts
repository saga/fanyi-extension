// 离线翻译队列 — 网络中断时存储失败的翻译请求,网络恢复后自动重试
//
// 使用 IndexedDB 持久化(通过 idb-keyval 或原生 IndexedDB API)
// 流程:
//   1. 翻译失败(网络错误)→ 加入队列
//   2. 监听 online 事件 → 触发重试
//   3. 重试成功 → 从队列移除;重试失败 → 保留,下次再试

const DB_NAME = 'fanyi-offline-queue';
const STORE_NAME = 'pending-translations';
const DB_VERSION = 1;

export interface PendingTranslation {
  id: string;  // UUID
  url: string;
  html: string;
  sourceLang: string;
  targetLang: string;
  provider?: string;
  promptStyle?: string;
  timestamp: number;
  retryCount: number;
  maxRetries: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** 打开 IndexedDB */
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });

  return dbPromise;
}

/** 生成 UUID */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** 添加失败的翻译到队列 */
export async function enqueuePendingTranslation(
  data: Omit<PendingTranslation, 'id' | 'timestamp' | 'retryCount' | 'maxRetries'>,
): Promise<string> {
  const entry: PendingTranslation = {
    ...data,
    id: generateId(),
    timestamp: Date.now(),
    retryCount: 0,
    maxRetries: 3,
  };

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.add(entry);
    request.onsuccess = () => resolve(entry.id);
    request.onerror = () => reject(request.error);
  });
}

/** 获取所有待重试的翻译(按时间排序) */
export async function getPendingTranslations(): Promise<PendingTranslation[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const request = index.getAll();
    request.onsuccess = () => resolve(request.result as PendingTranslation[]);
    request.onerror = () => reject(request.error);
  });
}

/** 从队列移除(重试成功后调用) */
export async function removePendingTranslation(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** 增加重试计数 */
export async function incrementRetryCount(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getRequest = store.get(id);
    getRequest.onsuccess = () => {
      const entry = getRequest.result as PendingTranslation;
      if (entry) {
        entry.retryCount++;
        store.put(entry);
      }
      resolve();
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

/** 清空队列(全部成功后或手动清除) */
export async function clearPendingTranslations(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** 获取队列长度 */
export async function getPendingCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 初始化离线队列监听器 — 监听 online 事件,自动重试。
 * 在 background.ts 中调用一次。
 *
 * @param retryFn 重试函数,接收 PendingTranslation,返回 true 表示成功
 */
export function initOfflineQueueListener(retryFn: (entry: PendingTranslation) => Promise<boolean>): void {
  // 监听 online 事件
  window.addEventListener('online', async () => {
    console.log('[offline-queue] 网络恢复,开始重试待处理翻译');
    await processQueue(retryFn);
  });

  // 启动时如果已在线,也尝试处理一次(可能有上次未处理完的)
  if (navigator.onLine) {
    setTimeout(() => processQueue(retryFn), 5000);  // 延迟 5 秒,避免启动时压力
  }
}

/** 处理队列中的待重试翻译 */
async function processQueue(retryFn: (entry: PendingTranslation) => Promise<boolean>): Promise<void> {
  const pending = await getPendingTranslations();
  if (pending.length === 0) return;

  console.log(`[offline-queue] 处理 ${pending.length} 个待重试翻译`);

  for (const entry of pending) {
    if (entry.retryCount >= entry.maxRetries) {
      console.warn(`[offline-queue] 翻译 ${entry.id} 已达最大重试次数,移除`);
      await removePendingTranslation(entry.id);
      continue;
    }

    try {
      const success = await retryFn(entry);
      if (success) {
        await removePendingTranslation(entry.id);
        console.log(`[offline-queue] 翻译 ${entry.id} 重试成功`);
      } else {
        await incrementRetryCount(entry.id);
      }
    } catch (err) {
      console.error(`[offline-queue] 翻译 ${entry.id} 重试失败:`, err);
      await incrementRetryCount(entry.id);
    }
  }
}
