/**
 * 文档阅读器的 IndexedDB 会话存储。
 *
 * 只保存文档翻译页：解析后的结构化文档、逐段译文、当前阅读位置与文学书籍记忆。
 * 不存储原始 PDF/EPUB 二进制，也不接入网页翻译的缓存或存储路径。
 *
 * 文档正文在导入时写入一次；翻译过程中只增量写入新增/修订的译文和小型状态记录，
 * 避免每翻译一批就把整本书再次 structured-clone 到 IndexedDB。
 */

import type { Glossary } from '../../service/_service';
import type { LiteraryBookMemory, LiteraryReviewFinding } from './literary';
import type { ParsedDocument } from './types';

const DATABASE_NAME = 'fanyi-document-reader';
const DATABASE_VERSION = 1;
const ACTIVE_ID = 'active';
const DOCUMENTS_STORE = 'documents';
const SESSIONS_STORE = 'sessions';
const TRANSLATIONS_STORE = 'translations';

export type SavedViewMode = 'bilingual' | 'translation' | 'original';
export type SavedDocumentTab = 'reading' | 'settings' | 'characters' | 'agent' | 'trajectory';

export interface DocumentTranslationSnapshot {
  translations: Array<[string, string]>;
  total: number;
  done: number;
  failedBatches: number[];
  error: string;
  literaryMemory: LiteraryBookMemory;
  literaryStatus: {
    enabled: boolean;
    bookProfileReady: boolean;
    chapterTitle: string;
    analyzedChapters: number;
    reviewedSegments: number;
    warnings: string[];
    reviewFindings: LiteraryReviewFinding[];
    /** Backward-compatible lightweight diagnostic trail; absent in older saved sessions. */
    diagnostics?: Array<{
      id: string;
      at: string;
      stage: string;
      status: string;
      message: string;
      details: string;
    }>;
  };
  analyzedChapterKeys: string[];
  lastRunSegmentIds: string[];
}

export interface CreateActiveDocumentSessionInput {
  fileName: string;
  document: ParsedDocument;
  rawText: string;
  glossary?: Glossary;
  sourceLang: string;
  targetLang: string;
  viewMode: SavedViewMode;
  literaryMode: boolean;
  currentPageIndex: number;
  activeTab: SavedDocumentTab;
}

export interface SaveActiveDocumentProgressInput {
  sourceLang: string;
  targetLang: string;
  viewMode: SavedViewMode;
  literaryMode: boolean;
  currentPageIndex: number;
  activeTab: SavedDocumentTab;
  snapshot: DocumentTranslationSnapshot;
  /** 只写入本次新增或变更的译文；不会重复写入整本书的译文。 */
  translationDelta: Array<[string, string]>;
  translatedSegmentCount: number;
}

interface StoredDocument {
  id: string;
  fileName: string;
  document: ParsedDocument;
  rawText: string;
  glossary?: Glossary;
  createdAt: number;
}

interface StoredSession {
  id: string;
  fileName: string;
  title: string;
  format: string;
  segmentCount: number;
  charCount: number;
  createdAt: number;
  updatedAt: number;
  sourceLang: string;
  targetLang: string;
  viewMode: SavedViewMode;
  literaryMode: boolean;
  currentPageIndex: number;
  activeTab?: SavedDocumentTab;
  translatedSegmentCount: number;
  total: number;
  done: number;
  failedBatches: number[];
  error: string;
  literaryMemory: LiteraryBookMemory;
  literaryStatus: DocumentTranslationSnapshot['literaryStatus'];
  analyzedChapterKeys: string[];
  lastRunSegmentIds: string[];
}

interface StoredTranslation {
  sessionId: string;
  segmentId: string;
  text: string;
}

export interface ActiveDocumentSessionSummary {
  fileName: string;
  title: string;
  format: string;
  segmentCount: number;
  charCount: number;
  updatedAt: number;
  translatedSegmentCount: number;
  total: number;
  done: number;
  currentPageIndex: number;
  activeTab: SavedDocumentTab;
  literaryMode: boolean;
}

export interface LoadedActiveDocumentSession extends ActiveDocumentSessionSummary {
  document: ParsedDocument;
  rawText: string;
  glossary?: Glossary;
  sourceLang: string;
  targetLang: string;
  viewMode: SavedViewMode;
  failedBatches: number[];
  error: string;
  literaryMemory: LiteraryBookMemory;
  literaryStatus: DocumentTranslationSnapshot['literaryStatus'];
  analyzedChapterKeys: string[];
  lastRunSegmentIds: string[];
  translations: Array<[string, string]>;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已中止'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器环境不支持 IndexedDB，无法启用文档自动恢复'));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) {
        db.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(TRANSLATIONS_STORE)) {
        const translations = db.createObjectStore(TRANSLATIONS_STORE, {
          keyPath: ['sessionId', 'segmentId'],
        });
        translations.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('无法打开文档会话数据库'));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('文档会话数据库升级被另一个阅读器页面阻塞，请关闭重复打开的文档页后重试'));
    };
  });
  return databasePromise;
}

/** IndexedDB 不能 structured-clone Vue Proxy；文档对象都是纯 JSON 数据，显式去代理。 */
function toPlainData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sessionFromCreate(input: CreateActiveDocumentSessionInput, now: number): StoredSession {
  return {
    id: ACTIVE_ID,
    fileName: input.fileName,
    title: input.document.title,
    format: input.document.format,
    segmentCount: input.document.meta.segmentCount,
    charCount: input.document.meta.charCount,
    createdAt: now,
    updatedAt: now,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    viewMode: input.viewMode,
    literaryMode: input.literaryMode,
    currentPageIndex: Math.max(0, Math.floor(input.currentPageIndex)),
    activeTab: input.activeTab,
    translatedSegmentCount: 0,
    total: 0,
    done: 0,
    failedBatches: [],
    error: '',
    literaryMemory: {
      version: 1, entities: [], relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    },
    literaryStatus: {
      enabled: input.literaryMode,
      bookProfileReady: false,
      chapterTitle: '',
      analyzedChapters: 0,
      reviewedSegments: 0,
      warnings: [],
      reviewFindings: [],
      diagnostics: [],
    },
    analyzedChapterKeys: [],
    lastRunSegmentIds: [],
  };
}

/** 刚解析成功时创建新的活动会话；本次交易原子地替换旧书及其译文。 */
export async function createActiveDocumentSession(
  input: CreateActiveDocumentSessionInput,
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [DOCUMENTS_STORE, SESSIONS_STORE, TRANSLATIONS_STORE],
    'readwrite',
  );
  const documents = transaction.objectStore(DOCUMENTS_STORE);
  const sessions = transaction.objectStore(SESSIONS_STORE);
  const translations = transaction.objectStore(TRANSLATIONS_STORE);

  // 本产品保留一个“最近阅读”快照，防止多本几十 MB 的电子书把扩展存储持续堆满。
  translations.clear();
  const now = Date.now();
  const documentRecord: StoredDocument = {
    id: ACTIVE_ID,
    fileName: input.fileName,
    document: toPlainData(input.document),
    rawText: input.rawText,
    ...(input.glossary ? { glossary: toPlainData(input.glossary) } : {}),
    createdAt: now,
  };
  documents.put(documentRecord);
  sessions.put(sessionFromCreate(input, now));
  await transactionDone(transaction);
}

/** 每批结束时保存小型状态并只增量写入新译文。 */
export async function saveActiveDocumentProgress(
  input: SaveActiveDocumentProgressInput,
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([SESSIONS_STORE, TRANSLATIONS_STORE], 'readwrite');
  const sessions = transaction.objectStore(SESSIONS_STORE);
  const translations = transaction.objectStore(TRANSLATIONS_STORE);
  const now = Date.now();

  const session: StoredSession = {
    id: ACTIVE_ID,
    fileName: '',
    title: '',
    format: 'txt',
    segmentCount: 0,
    charCount: 0,
    createdAt: now,
    updatedAt: now,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    viewMode: input.viewMode,
    literaryMode: input.literaryMode,
    currentPageIndex: Math.max(0, Math.floor(input.currentPageIndex)),
    activeTab: input.activeTab,
    translatedSegmentCount: input.translatedSegmentCount,
    total: input.snapshot.total,
    done: input.snapshot.done,
    failedBatches: input.snapshot.failedBatches,
    error: input.snapshot.error,
    literaryMemory: toPlainData(input.snapshot.literaryMemory),
    literaryStatus: toPlainData(input.snapshot.literaryStatus),
    analyzedChapterKeys: [...input.snapshot.analyzedChapterKeys],
    lastRunSegmentIds: [...input.snapshot.lastRunSegmentIds],
  };

  // 在同一个事务中读出原始文档记录，只拷贝轻量元信息；正文只在首次创建时写一次。
  const existingRequest = sessions.get(ACTIVE_ID);
  existingRequest.onsuccess = () => {
    const previous = existingRequest.result as StoredSession | undefined;
    if (previous) {
      session.fileName = previous.fileName;
      session.title = previous.title;
      session.format = previous.format;
      session.segmentCount = previous.segmentCount;
      session.charCount = previous.charCount;
      session.createdAt = previous.createdAt;
    }
    sessions.put(session);
  };

  for (const [segmentId, text] of input.translationDelta) {
    if (typeof segmentId === 'string' && typeof text === 'string' && text.trim()) {
      const row: StoredTranslation = { sessionId: ACTIVE_ID, segmentId, text };
      translations.put(row);
    }
  }
  await transactionDone(transaction);
}

/** 轻量地读取最近会话摘要，避免为了显示恢复卡片而载入整本书。 */
export async function getActiveDocumentSessionSummary(): Promise<ActiveDocumentSessionSummary | null> {
  const db = await openDatabase();
  const transaction = db.transaction(SESSIONS_STORE, 'readonly');
  const done = transactionDone(transaction);
  const rowRequest = transaction.objectStore(SESSIONS_STORE).get(ACTIVE_ID);
  const row = await requestResult(rowRequest) as StoredSession | undefined;
  await done;
  if (!row) return null;
  return {
    fileName: row.fileName,
    title: row.title,
    format: row.format,
    segmentCount: row.segmentCount,
    charCount: row.charCount,
    updatedAt: row.updatedAt,
    translatedSegmentCount: row.translatedSegmentCount,
    total: row.total,
    done: row.done,
    currentPageIndex: row.currentPageIndex,
    activeTab: row.activeTab || 'reading',
    literaryMode: row.literaryMode,
  };
}

/** 恢复最近一次阅读：正文、译文、位置、语言设置和文学记忆一起恢复。 */
export async function loadActiveDocumentSession(): Promise<LoadedActiveDocumentSession | null> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [DOCUMENTS_STORE, SESSIONS_STORE, TRANSLATIONS_STORE],
    'readonly',
  );
  const documents = transaction.objectStore(DOCUMENTS_STORE);
  const sessions = transaction.objectStore(SESSIONS_STORE);
  const translationStore = transaction.objectStore(TRANSLATIONS_STORE);

  const done = transactionDone(transaction);
  const documentRequest = documents.get(ACTIVE_ID);
  const sessionRequest = sessions.get(ACTIVE_ID);
  const translationRequest = translationStore.index('sessionId').getAll(IDBKeyRange.only(ACTIVE_ID));
  const [documentRecord, sessionRecord, translationRecords] = await Promise.all([
    requestResult(documentRequest) as Promise<StoredDocument | undefined>,
    requestResult(sessionRequest) as Promise<StoredSession | undefined>,
    requestResult(translationRequest) as Promise<StoredTranslation[]>,
  ]);
  await done;

  if (!documentRecord || !sessionRecord) return null;
  const row = sessionRecord;
  return {
    fileName: row.fileName,
    title: row.title,
    format: row.format,
    segmentCount: row.segmentCount,
    charCount: row.charCount,
    updatedAt: row.updatedAt,
    translatedSegmentCount: row.translatedSegmentCount,
    total: row.total,
    done: row.done,
    currentPageIndex: row.currentPageIndex,
    activeTab: row.activeTab || 'reading',
    literaryMode: row.literaryMode,
    document: documentRecord.document,
    rawText: documentRecord.rawText,
    ...(documentRecord.glossary ? { glossary: documentRecord.glossary } : {}),
    sourceLang: row.sourceLang,
    targetLang: row.targetLang,
    viewMode: row.viewMode,
    failedBatches: row.failedBatches,
    error: row.error,
    literaryMemory: row.literaryMemory,
    literaryStatus: row.literaryStatus,
    analyzedChapterKeys: row.analyzedChapterKeys,
    lastRunSegmentIds: row.lastRunSegmentIds,
    translations: translationRecords.map((entry) => [entry.segmentId, entry.text]),
  };
}

export async function clearActiveDocumentSession(): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(
    [DOCUMENTS_STORE, SESSIONS_STORE, TRANSLATIONS_STORE],
    'readwrite',
  );
  transaction.objectStore(DOCUMENTS_STORE).delete(ACTIVE_ID);
  transaction.objectStore(SESSIONS_STORE).delete(ACTIVE_ID);
  transaction.objectStore(TRANSLATIONS_STORE).clear();
  await transactionDone(transaction);
}
