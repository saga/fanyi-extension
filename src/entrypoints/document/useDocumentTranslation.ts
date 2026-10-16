import { ref } from 'vue';
import browser from 'webextension-polyfill';
import type { TranslateChunkResponse } from '../../types/messages';
import type { Glossary } from '../service/_service';
import { MODEL_FETCH_TIMEOUT_MS } from '../service/_service';
import type { PromptStyle, TranslationMode } from '../service/deepseek';
import { detectLanguage, shouldUseJapaneseSource } from '../utils/languageDetector';
import { buildSegmentBatches, type BatchBudget } from '../utils/document/batcher';
import type { DocumentSegment } from '../utils/document/types';
import { getMissingDocumentBatchIds, normalizeDocumentBatchResult } from '../utils/document/translationResult';
import { findNoOpBlockIds } from '../utils/translateApi';
import { TRANSLATIONS_OBJECT_SCHEMA } from '../utils/translateApi';
import {
  addLiteraryExamples,
  autoConfirmLiteraryMemory,
  buildLiteraryContextForBatch,
  buildLiteraryTranslationContextPrompt,
  createEmptyLiteraryMemory,
  mergeLiteraryMemory,
  type LiteraryBookMemory,
  refreshLiteraryExampleTargets,
  sanitizeLiteraryMemory,
  type LiteraryReviewFinding,
} from '../utils/document/literary';
import type { DocumentTranslationSnapshot } from '../utils/document/sessionStore';

/**
 * 文档翻译执行器。
 *
 * 三个关键设计（对应长文档翻译最容易翻车的地方）：
 *   1. **逐批提交**：每批成功就把译文写进 map，UI 立刻可见；
 *      不"全部成功后再一次性渲染"，否则中途失败等于白等。
 *   2. **失败隔离 + 重试**：单批失败只重试该批，成功后继续；
 *      最终失败的批单独列出，可一键重跑，不影响已完成部分。
 *   3. **可中断**：stop() 后已在途的请求不再回写，用户不必等长文档跑完才能退出。
 */

export interface TranslateOptions {
  sourceLang: string;
  targetLang: string;
  concurrency?: number;
  budget?: Partial<BatchBudget>;
  /** 单批失败重试次数，默认 1。 */
  retries?: number;
  /** 用户术语表（与网页翻译行为一致，避免文档里同名专有名词被翻错）。 */
  glossary?: Glossary;
  /**
   * 已解析的文风。调用方通常不传 —— 由 `run`/`retryFailed` 基于全部 segment
   * 做一次文档级语言检测后填入（见 resolveDocumentStyle）。
   */
  promptStyle?: PromptStyle;
  /** 全局翻译目标；书籍文学工作流可将当前请求提升为 literary。 */
  translationMode?: TranslationMode;
  /** 跟随扩展全局设置：将已重建的文档片段交给 vocal-saga 服务端翻译。 */
  useServerTranslation?: boolean;
  /** 本机 Workbuddy/OpenCode Provider；启用时不调用远程 document endpoint。 */
  useLocalAgent?: boolean;
  localAgentProvider?: 'workbuddy' | 'opencode';
  localAgentUrl?: string;
  localAgentModel?: string;
  localAgentToken?: string;
  serverUrl?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  documentFileName?: string;
  /** Stable per-document identity passed only to the local Agent for scoped SDK Sessions. */
  documentSessionId?: string;
  /** Force cache bypass for the selected page; successful results replace normal cache entries. */
  forceRefresh?: boolean;
  /** Translate only the currently displayed page instead of the surrounding EPUB chapter. */
  onlyPrioritySegments?: boolean;
  currentPageTitle?: string;
  documentSystemPromptOverride?: string;
  documentUserPromptTemplate?: string;
  documentTitle?: string;
  documentFormat?: string;
  documentWarnings?: string[];
  /** 首批优先翻译当前阅读页；其他片段随后继续翻译。 */
  prioritySegmentIds?: string[];
  /** 仅 EPUB/PDF 可开启：逐章实体分析、书籍记忆、文学译稿审校。 */
  literaryMode?: boolean;
  /** 文学模式下跳过每批的独立审校调用，减少模型请求；译文质量回到初译水平，实际耗时取决于模型与文档。 */
  skipReview?: boolean;
  /** 每批结束、书籍记忆更新或审校结果返回时调用，供阅读器做增量持久化。 */
  onCheckpoint?: () => Promise<void> | void;
}

/**
 * Literary book translation is intentionally one serial lane so each chapter can inherit the
 * previous chapter's voice and wording. Technical documents do not need shared chat history;
 * distribute stable segment IDs across four bounded lanes so chunks can run concurrently
 * without sharing unrelated chunk conversations.
 */
function resolveDocumentSessionLane(
  options: Pick<TranslateOptions, 'literaryMode' | 'translationMode'>,
  segments: DocumentSegment[],
): string {
  if (options.literaryMode || options.translationMode === 'literary') return 'book';
  const id = segments[0]?.id || 'empty-batch';
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = (Math.imul(hash, 31) + id.charCodeAt(index)) | 0;
  }
  return 'lane-' + ((hash >>> 0) % 4);
}

/**
 * 解析本次文档翻译应使用的文风。
 *
 * 与网页翻译、PDF 翻译同一策略：日语原文 → 非日语目标语言时，把 default
 * 自动升级为 ja-source-natural（保留原文的克制、论述顺序与限定语气）。
 * 用户手工选择的文风永远优先 —— 策略集中在 shouldUseJapaneseSource。
 *
 * 检测基于**全部** segment 而不是单批：单批文本可能过短，会触发
 * languageDetector 的短文本保护而判不出语言，导致同一文档内各批文风不一致。
 */
function resolveDocumentStyle(
  segments: DocumentSegment[],
  options: TranslateOptions,
): PromptStyle | undefined {
  // 语言识别只需要有代表性的样本。不要把整本 EPUB 拼成超大字符串，
  // 否则正式发送第一个翻译请求之前，还要额外复制并扫描整本书。
  const SAMPLE_LIMIT = 20_000;
  let sample = '';
  for (const segment of segments) {
    if (sample.length >= SAMPLE_LIMIT) break;
    sample += segment.text.slice(0, SAMPLE_LIMIT - sample.length) + '\n';
  }
  const detected = detectLanguage(sample);
  return shouldUseJapaneseSource(options.promptStyle, detected.language, options.targetLang)
    ? 'ja-source-natural'
    : options.promptStyle;
}

interface ServerDocumentTranslationResponse {
  translations?: Record<string, unknown>;
  failedBatches?: unknown;
  errors?: unknown;
  complete?: unknown;
  missingSegmentIds?: unknown;
}

/**
 * 将各部署模式的现有 serverUrl 规范化为结构化文档端点。
 * 默认设置是 /fanyi/page；文档接口与之同域，但路径独立，服务端不会接收 PDF 二进制。
 */
/**
 * 本机 Provider 是强制路由。即使调用方误把两个开关都设为 true，
 * 也必须优先使用扩展的本机 provider，绝不触发远程文档翻译 API。
 */
export function shouldUseRemoteDocumentTranslation(
  options: Pick<TranslateOptions, 'useLocalAgent' | 'useServerTranslation'>,
): boolean {
  return options.useServerTranslation === true && options.useLocalAgent !== true;
}

function resolveLocalAgentEndpoint(localAgentUrl: string | undefined, endpointPath: string): string {
  const url = new URL(localAgentUrl?.trim() || 'http://127.0.0.1:8789');
  url.pathname = endpointPath;  url.search = '';
  url.hash = '';
  return url.toString();
}

function requestHeaders(options: TranslateOptions): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(options.useLocalAgent && options.localAgentToken
      ? { Authorization: 'Bearer ' + options.localAgentToken }
      : {}),
  };
}

// 直连 fetch 统一超时：无超时会无限"翻译中…"。stall 转中文超时错，
// 调用方现有重试/警告链路不变。
async function fetchJsonWithTimeout(
  endpoint: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetch(endpoint, { ...init, signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(label + '请求超时（180s）：网络或模型服务无响应');
    }
    throw error;
  }
}

function resolveServerDocumentEndpoint(
  serverUrl?: string,
  endpointPath = '/api/translate/document/segments',
): string {
  const base = serverUrl?.trim() || 'https://s.sunxiunan.com/fanyi/page';
  const url = new URL(base);
  if (url.pathname !== endpointPath) {
    url.pathname = endpointPath;
    url.search = '';
    url.hash = '';
  }
  return url.toString();
}

/**
 * 上传已在浏览器端提取好的结构化片段。
 * 响应只接纳当前请求中存在的 ID；服务端返回部分结果时保留有效译文并记录缺失 ID，
 * 用户重试时只提交未完成片段，避免把 HTTP 200 当成完整成功。
 */
async function translateSegmentsViaServer(
  segments: DocumentSegment[],
  options: TranslateOptions,
  runId: number,
  isCurrentRun: (runId: number) => boolean,
): Promise<ServerDocumentTranslationResponse | null> {
  if (options.useLocalAgent) {
    throw new Error('本机 Provider 已启用，拒绝调用远程文档翻译端点');
  }
  if (!segments.length) return { translations: {}, failedBatches: [], errors: [], complete: true };

  const format = options.documentFormat || 'txt';
  const fileName = options.documentFileName ||
    ((options.documentTitle || 'document') + '.' + format);
  const endpoint = resolveServerDocumentEndpoint(options.serverUrl);
  const provider = options.provider || 'deepseek';
  const payload = {
    fileName,
    title: options.documentTitle,
    format,
    warnings: options.documentWarnings ?? [],
    source: options.sourceLang,
    target: options.targetLang,
    glossary: options.translationMode === 'literary' ? undefined : options.glossary,
    promptStyle: options.promptStyle,
    forceRefresh: options.forceRefresh,
    documentSystemPromptOverride: options.documentSystemPromptOverride,
    documentUserPromptTemplate: options.documentUserPromptTemplate,
    translationMode: options.translationMode === 'literary' ? 'literary' : 'technical',
    provider,
    model: options.model,
    ...(provider === 'deepseek' && options.apiKey ? { apiKey: options.apiKey } : {}),
    segments: segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      kind: segment.kind,
      level: segment.level,
      marker: segment.marker,
      page: segment.page,
      contextPath: segment.contextPath,
      path: segment.path,
      start: segment.start,
      end: segment.end,
    })),
  };

  const response = await fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, '服务端文档翻译');
  let data: ServerDocumentTranslationResponse & { error?: string };
  try {
    data = await response.json() as ServerDocumentTranslationResponse & { error?: string };
  } catch {
    throw new Error('服务端文档翻译返回了无法解析的响应');
  }
  if (!isCurrentRun(runId)) return null;
  if (!response.ok) {
    throw new Error(data.error || ('服务端文档翻译失败：HTTP ' + response.status));
  }

  const expectedIds = new Set(segments.map((segment) => segment.id));
  const normalized: Record<string, string> = {};
  if (data.translations && typeof data.translations === 'object') {
    for (const [id, value] of Object.entries(data.translations)) {
      if (expectedIds.has(id) && typeof value === 'string' && value.trim()) {
        normalized[id] = value;
      }
    }
  }
  return { ...data, translations: normalized };
}


type LiteraryDiagnosticStatus = 'started' | 'completed' | 'info' | 'warning' | 'failed';

interface LiteraryDiagnosticEvent {
  id: string;
  at: string;
  stage: string;
  status: LiteraryDiagnosticStatus;
  message: string;
  details: string;
}

interface LiteraryStatus {
  enabled: boolean;
  chapterTitle: string;
  bookProfileReady: boolean;
  analyzedChapters: number;
  reviewedSegments: number;
  warnings: string[];
  reviewFindings: LiteraryReviewFinding[];
  diagnostics: LiteraryDiagnosticEvent[];
}

/** 从长章中均匀抽样；分析请求有界，书籍全文不会送进单个请求。 */
function selectLiteraryChapterSample(segments: DocumentSegment[]): DocumentSegment[] {
  const valid = segments.filter((segment) => segment.text.trim());
  if (valid.length <= 24) return valid.map((segment) => ({ ...segment, text: segment.text.slice(0, 900) }));
  const selected = new Map<number, DocumentSegment>();
  for (let i = 0; i < valid.length; i++) {
    if (valid[i]?.kind === 'heading') selected.set(i, valid[i]!);
  }
  const slots = Math.max(0, 24 - selected.size);
  for (let i = 0; i < slots; i++) {
    const index = Math.round((i + 0.5) * (valid.length - 1) / Math.max(slots, 1));
    selected.set(index, valid[index]!);
  }
  return Array.from(selected.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, 24)
    .map(([, segment]) => ({ ...segment, text: segment.text.slice(0, 900) }));
}

/**
 * 章节/上下文单元的稳定键。EPUB 以章节路径为主，缺少章节标题的 PDF 每 8 页合成一个分析窗口。
 */
function literaryChapterKey(segment: DocumentSegment, enabled: boolean, format?: string): string {
  if (!enabled) return '';
  const context = segment.contextPath?.trim();
  if (context) return context;
  if (format === 'pdf' && segment.page) {
    const firstPage = Math.floor((segment.page - 1) / 8) * 8 + 1;
    return 'PDF 第 ' + firstPage + '-' + (firstPage + 7) + ' 页';
  }
  return segment.page ? 'PDF 第 ' + segment.page + ' 页' : '正文';
}

/**
 * 全书预分析采用跨章节均匀抽样，不把全文送进一个请求。
 * 先保证目录中不同章节都有代表，再填充额外段落；后续每章仍会按需增补新实体。
 */
function selectLiteraryBookSample(segments: DocumentSegment[], format?: string) {
  const valid = segments.filter((segment) => segment.text.trim());
  const groups = new Map<string, Array<{ segment: DocumentSegment; index: number }>>();
  valid.forEach((segment, index) => {
    const key = literaryChapterKey(segment, true, format);
    const group = groups.get(key) ?? [];
    group.push({ segment, index });
    groups.set(key, group);
  });

  const orderedGroups = Array.from(groups.values());
  const selected = new Map<number, DocumentSegment>();
  const addRepresentative = (group: Array<{ segment: DocumentSegment; index: number }>) => {
    const item = group.find((entry) => entry.segment.kind === 'heading') ?? group[0];
    if (item) selected.set(item.index, item.segment);
  };

  // 书里章节多于可用 slot 时，均匀取样而不是只分析开头的章节。
  if (orderedGroups.length >= 24) {
    for (let i = 0; i < 24; i++) {
      const groupIndex = Math.round((i + 0.5) * (orderedGroups.length - 1) / 24);
      const group = orderedGroups[groupIndex];
      if (group) addRepresentative(group);
    }
  } else {
    for (const group of orderedGroups) addRepresentative(group);
    const slots = Math.max(0, 24 - selected.size);
    for (let i = 0; i < slots; i++) {
      const index = Math.round((i + 0.5) * (valid.length - 1) / Math.max(slots, 1));
      if (valid[index]) selected.set(index, valid[index]!);
    }
  }

  return Array.from(selected.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, 24)
    .map(([, segment]) => ({ ...segment, text: segment.text.slice(0, 900) }));
}

async function analyzeLiteraryChapterViaLocalAgent(
  chapterTitle: string,
  segments: DocumentSegment[],
  options: TranslateOptions,
  memory: LiteraryBookMemory | undefined,
  runId: number,
  isCurrentRun: (runId: number) => boolean,
): Promise<{ memory: LiteraryBookMemory; analyzed: boolean; warning?: string } | null> {
  const sampled = selectLiteraryChapterSample(segments);
  if (!sampled.length) return { memory, analyzed: false, warning: '当前内容没有足够的正文片段供实体分析' };
  if (!options.useLocalAgent) {
    throw new Error('文学书籍模式需要启用本机 Local Agent；云端只支持单次片段翻译，不提供全书记忆或独立审校。');
  }
  const endpoint = resolveLocalAgentEndpoint(options.localAgentUrl, '/api/translate/document/literary/analyze');
  const provider = options.localAgentProvider || 'workbuddy';
  const response = await fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: requestHeaders(options),
    body: JSON.stringify({
      chapterTitle,
      segments: sampled.map((segment) => ({
        id: segment.id, text: segment.text, kind: segment.kind, contextPath: segment.contextPath,
      })),
      memory,
      source: options.sourceLang,
      target: options.targetLang,
      glossary: undefined,
      promptStyle: options.promptStyle,
      translationMode: 'literary',
      documentSessionId: options.documentSessionId,
      provider,
      runtime: options.localAgentProvider || 'workbuddy',
      model: options.localAgentModel || 'auto',
      ...(provider === 'deepseek' && options.apiKey ? { apiKey: options.apiKey } : {}),
    }),
  }, '书籍实体分析');
  let data: { memory?: unknown; analyzed?: unknown; warning?: unknown; error?: string; requestId?: string };
  try { data = await response.json() as typeof data; }
  catch { throw new Error('书籍实体分析接口返回了无法解析的响应'); }
  if (!isCurrentRun(runId)) return null;
  if (!response.ok) {
    const message = data.error || ('书籍实体分析失败：HTTP ' + response.status);
    const requestId = data.requestId ? ' (本机 request ID: ' + data.requestId + ')' : '';
    throw new Error(message + requestId);
  }
  return {
    memory: mergeLiteraryMemory(memory, autoConfirmLiteraryMemory(data.memory)),
    analyzed: data.analyzed === true,
    ...(typeof data.warning === 'string' && data.warning ? { warning: data.warning } : {}),
  };
}

async function reviewLiteraryBatchViaLocalAgent(
  segments: DocumentSegment[],
  drafts: Map<string, string>,
  options: TranslateOptions,
  memory: LiteraryBookMemory,
  runId: number,
  isCurrentRun: (runId: number) => boolean,
  precedingSegments: DocumentSegment[] = [],
): Promise<{ translations: Map<string, string>; findings: LiteraryReviewFinding[] } | null> {
  const candidates = segments.flatMap((segment) => {
    const draft = drafts.get(segment.id);
    return draft?.trim() ? [{
      id: segment.id, source: segment.text, draft, kind: segment.kind, contextPath: segment.contextPath,
    }] : [];
  });
  if (!candidates.length) return { translations: new Map(), findings: [] };
  if (!options.useLocalAgent) {
    throw new Error('文学书籍模式需要启用本机 Local Agent；云端只支持单次片段翻译，不提供全书记忆或独立审校。');
  }
  const endpoint = resolveLocalAgentEndpoint(options.localAgentUrl, '/api/translate/document/literary/review');
  const provider = options.localAgentProvider || 'workbuddy';
  const response = await fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: requestHeaders(options),
    body: JSON.stringify({
      chapterTitle: candidates[0]?.contextPath || options.documentTitle,
      segments: candidates,
      memory,
      precedingSegments: precedingSegments.slice(-4).map((segment) => ({
        id: segment.id, text: segment.text.slice(0, 900), contextPath: segment.contextPath,
      })),
      voiceContext: buildLiteraryContextForBatch({
        memory,
        segments: candidates.map((item) => ({ id: item.id, text: item.source, contextPath: item.contextPath })),
        precedingSegments: precedingSegments.map((segment) => ({ id: segment.id, text: segment.text, contextPath: segment.contextPath })),
        chapterTitle: candidates[0]?.contextPath || options.documentTitle,
        tokenBudget: 3000,
      }),
      source: options.sourceLang,
      target: options.targetLang,
      glossary: undefined,
      promptStyle: options.promptStyle,
      translationMode: 'literary',
      documentSessionId: options.documentSessionId,
      provider,
      runtime: options.localAgentProvider || 'workbuddy',
      model: options.localAgentModel || 'auto',
      ...(provider === 'deepseek' && options.apiKey ? { apiKey: options.apiKey } : {}),
    }),
  }, '文学审校');
  let data: { translations?: unknown; reviewedIds?: unknown; missingIds?: unknown; findings?: unknown; reviewFindings?: unknown; error?: string; requestId?: string };
  try { data = await response.json() as typeof data; }
  catch { throw new Error('文学审校接口返回了无法解析的响应'); }
  if (!isCurrentRun(runId)) return null;
  if (!response.ok) {
    const message = data.error || ('文学审校失败：HTTP ' + response.status);
    const requestId = data.requestId ? ' (本机 request ID: ' + data.requestId + ')' : '';
    throw new Error(message + requestId);
  }
  const allowed = new Set(candidates.map((segment) => segment.id));
  const reviewed = new Map<string, string>();
  if (data.translations && typeof data.translations === 'object' && !Array.isArray(data.translations)) {
    for (const [id, value] of Object.entries(data.translations)) {
      if (allowed.has(id) && typeof value === 'string' && value.trim()) reviewed.set(id, value.trim());
    }
  }
  const findings = normalizeLiteraryReviewFindings(data.findings ?? data.reviewFindings);
  const mustFixIds = new Set(findings.filter((finding) => finding.priority === 'must_fix').map((finding) => finding.id));
  // Style findings remain proposals until the user explicitly accepts the full reviewed translation.
  // Accuracy/terminology fixes still auto-apply, because the Reviewer classified those as must-fix.
  const actionableFindings = findings.map((finding) => {
    if (finding.category === 'style' && !mustFixIds.has(finding.id)) {
      // The review endpoint deliberately returns the unchanged draft in translations when
      // a finding is style-only. The complete alternative lives on the finding itself;
      // never infer a proposal from translations[id], or the UI would offer the old draft.
      return finding.proposedTranslation
        ? { ...finding, applicationStatus: finding.applicationStatus || ('pending' as const) }
        : finding;
    }
    return mustFixIds.has(finding.id)
      ? { ...finding, applicationStatus: 'applied' as const }
      : finding;
  });
  return { translations: reviewed, findings: actionableFindings };
}

function normalizeLiteraryReviewFindings(input: unknown): LiteraryReviewFinding[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 240).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id) return [];
    if (item.category !== 'accuracy' && item.category !== 'terminology' && item.category !== 'style') return [];
    const priority = item.category !== 'style' && item.priority === 'must_fix' ? 'must_fix' : 'optional';
    const finding: LiteraryReviewFinding = {
      id: item.id.slice(0, 160), category: item.category, priority,
      sourceExcerpt: typeof item.sourceExcerpt === 'string' ? item.sourceExcerpt.slice(0, 240) : '',
      draftExcerpt: typeof item.draftExcerpt === 'string' ? item.draftExcerpt.slice(0, 240) : '',
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 400) : '',
      suggestion: typeof item.suggestion === 'string' ? item.suggestion.slice(0, 400) : '',
      ...(typeof item.proposedTranslation === 'string' && item.proposedTranslation.trim()
        ? { proposedTranslation: item.proposedTranslation.slice(0, 5000) }
        : {}),
      ...(item.applicationStatus === 'pending' || item.applicationStatus === 'applied' || item.applicationStatus === 'dismissed'
        ? { applicationStatus: item.applicationStatus }
        : {}),
      ...(item.dimension === 'character_voice' || item.dimension === 'register' || item.dimension === 'narrative_style' || item.dimension === 'pacing'
        ? { dimension: item.dimension }
        : {}),
      ...(typeof item.characterId === 'string' ? { characterId: item.characterId.slice(0, 100) } : {}),
      ...(typeof item.relatedCharacterId === 'string' ? { relatedCharacterId: item.relatedCharacterId.slice(0, 100) } : {}),
      ...(Array.isArray(item.evidenceSegmentIds)
        ? { evidenceSegmentIds: item.evidenceSegmentIds.filter((id): id is string => typeof id === 'string').slice(0, 8).map((id) => id.slice(0, 160)) }
        : {}),
    };
    return finding.reason || finding.suggestion ? [finding] : [];
  });
}

function appendLiteraryReviewFindings(input: unknown, existing: LiteraryReviewFinding[]): LiteraryReviewFinding[] {
  const byKey = new Map<string, LiteraryReviewFinding>();
  for (const item of [...existing, ...normalizeLiteraryReviewFindings(input)]) {
    const key = [item.id, item.category, item.priority, item.draftExcerpt, item.reason].join('|');
    byKey.set(key, item);
  }
  return Array.from(byKey.values()).slice(-240);
}

export interface DocumentTranslateState {
  /** segmentId → 译文 */
  translations: Map<string, string>;
  total: number;
  done: number;
  failedBatches: number[];
  running: boolean;
  error: string;
  /** 本次 run 实际推进的章节（文学模式每次只推进一章）；普通模式为空。 */
  workChapter: string;
  /** 本次 run 实际推进的批数（文学模式是单章批数，不是全书 total）。 */
  workTotal: number;
  workDone: number;
  /** 当前阶段（实体分析中/翻译中/审校中），仅 running 时有意义，方便定位慢在哪一步。 */
  workStage: string;
  /**
   * 正在被翻译的 segmentId 集合（并发同时在跑的批）。
   * 阅读页只给这些段显示「翻译中…」，排队的段保持安静——满屏占位会盖过正文。
   */
  activeSegmentIds: Set<string>;
}


/**
 * Prefer local-service batch planning in local mode. The extension fallback is deliberately
 * local CPU-only logic (never a remote request) so a temporary cache/service issue cannot
 * make a document unreadable.
 */
export async function planDocumentBatches(
  segments: DocumentSegment[],
  budget: Partial<BatchBudget>,
  options: TranslateOptions,
): Promise<DocumentSegment[][]> {
  // Batch planning is deterministic CPU work. Sending the entire document to localhost only to
  // receive IDs adds serialization, an HTTP round trip and a second full-array allocation without
  // changing the plan. Keep options in the signature for backwards-compatible callers.
  void options;
  return buildSegmentBatches(segments, budget);
}

export function useDocumentTranslation() {
  const state = ref<DocumentTranslateState>({
    translations: new Map(),
    total: 0,
    done: 0,
    failedBatches: [],
    running: false,
    error: '',
    workChapter: '',
    workTotal: 0,
    workDone: 0,
    workStage: '',
    activeSegmentIds: new Set(),
  });

  // 文学记忆属于当前阅读会话，继续/重试保留；切换文档时重置。
  const literaryMemory = ref<LiteraryBookMemory>(createEmptyLiteraryMemory());
  const literaryStatus = ref<LiteraryStatus>({
    enabled: false, bookProfileReady: false, chapterTitle: '', analyzedChapters: 0, reviewedSegments: 0,
    warnings: [], reviewFindings: [], diagnostics: [],
  });
  let analyzedChapterKeys = new Set<string>();

  // 每次运行有独立 generation；停止或启动新任务时递增，丢弃旧请求的迟到结果。
  let generation = 0;
  // 重试必须沿用上一轮批次顺序（其中可能把当前阅读页提到了最前面）。
  let lastRunSegmentIds: string[] = [];
  let diagnosticSequence = 0;
  const isCurrentRun = (runId: number) => generation === runId;

  /**
   * 在控制台和会话快照中记录轻量诊断事件。details 只允许计数、配置名和片段 ID，
   * 不记录整段原文、完整译文、Prompt、令牌或本机鉴权信息。
   */
  function recordDiagnostic(
    stage: string,
    status: LiteraryDiagnosticStatus,
    message: string,
    details: Record<string, string | number | boolean | null> = {},
  ): void {
    const at = new Date().toISOString();
    const entry: LiteraryDiagnosticEvent = {
      id: at + '-' + (++diagnosticSequence),
      at,
      stage,
      status,
      message,
      details: Object.entries(details)
        .filter(([, value]) => value !== null && value !== '')
        .map(([key, value]) => key + '=' + String(value))
        .join(' · '),
    };
    literaryStatus.value.diagnostics = [...literaryStatus.value.diagnostics, entry].slice(-120);
    const log = status === 'failed' ? console.error : status === 'warning' ? console.warn : console.info;
    log.call(console, '[document-reader][trace]', JSON.stringify({ ...entry, details }));
  }

  async function checkpoint(options: TranslateOptions): Promise<void> {
    try {
      await options.onCheckpoint?.();
    } catch (error) {
      // 存储故障不能把翻译任务标成失败；UI 自己展示持久化警告。
      console.warn('[document-reader] checkpoint failed', error);
    }
  }

  /** 创建不含 Vue Proxy 的纯数据快照，供 IndexedDB structured-clone 使用。 */
  function getSnapshot(): DocumentTranslationSnapshot {
    return {
      translations: Array.from(state.value.translations.entries()),
      total: state.value.total,
      done: state.value.done,
      failedBatches: [...state.value.failedBatches],
      error: state.value.error,
      literaryMemory: JSON.parse(JSON.stringify(literaryMemory.value)) as LiteraryBookMemory,
      literaryStatus: JSON.parse(JSON.stringify(literaryStatus.value)) as LiteraryStatus,
      analyzedChapterKeys: [...analyzedChapterKeys],
      lastRunSegmentIds: [...lastRunSegmentIds],
    };
  }

  /** 刷新后恢复文档状态。running 一律恢复为 false，避免 UI 显示一个实际不存在的请求。 */
  function restoreSnapshot(snapshot: Partial<DocumentTranslationSnapshot>): void {
    generation++;
    analyzedChapterKeys = new Set(
      Array.isArray(snapshot.analyzedChapterKeys)
        ? snapshot.analyzedChapterKeys.filter((key): key is string => typeof key === 'string')
        : [],
    );
    lastRunSegmentIds = Array.isArray(snapshot.lastRunSegmentIds)
      ? snapshot.lastRunSegmentIds.filter((id): id is string => typeof id === 'string')
      : [];
    const restoredTranslations = Array.isArray(snapshot.translations)
      ? snapshot.translations.filter((item): item is [string, string] =>
          Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string')
      : [];
    const status = snapshot.literaryStatus;
    literaryMemory.value = sanitizeLiteraryMemory(snapshot.literaryMemory);
    literaryStatus.value = {
      enabled: status?.enabled === true,
      bookProfileReady: status?.bookProfileReady === true,
      chapterTitle: typeof status?.chapterTitle === 'string' ? status.chapterTitle : '',
      analyzedChapters: typeof status?.analyzedChapters === 'number' && Number.isFinite(status.analyzedChapters)
        ? status.analyzedChapters : 0,
      reviewedSegments: typeof status?.reviewedSegments === 'number' && Number.isFinite(status.reviewedSegments)
        ? status.reviewedSegments : 0,
      warnings: Array.isArray(status?.warnings)
        ? status.warnings.filter((warning): warning is string => typeof warning === 'string').slice(-20)
        : [],
      reviewFindings: normalizeLiteraryReviewFindings(status?.reviewFindings),
      diagnostics: Array.isArray(status?.diagnostics)
        ? status.diagnostics.filter((item): item is LiteraryDiagnosticEvent =>
            !!item && typeof item === 'object' &&
            typeof item.id === 'string' && typeof item.at === 'string' &&
            typeof item.stage === 'string' && typeof item.message === 'string' &&
            typeof item.details === 'string' &&
            ['started', 'completed', 'info', 'warning', 'failed'].includes(item.status))
          .slice(-120)
        : [],
    };
    state.value = {
      translations: new Map(restoredTranslations),
      total: Number.isFinite(snapshot.total) ? Math.max(0, Number(snapshot.total)) : 0,
      done: Number.isFinite(snapshot.done) ? Math.max(0, Number(snapshot.done)) : 0,
      failedBatches: Array.isArray(snapshot.failedBatches)
        ? snapshot.failedBatches.filter((index): index is number => Number.isInteger(index) && index >= 0)
        : [],
      running: false,
      error: typeof snapshot.error === 'string' ? snapshot.error : '',
      // 章节进度是单次 run 的运行时状态，不随快照恢复，避免恢复后显示过期章节。
      workChapter: '',
      workTotal: 0,
      workDone: 0,
      workStage: '',
      activeSegmentIds: new Set(),
    };
  }

  function reset() {
    generation++;
    lastRunSegmentIds = [];
    analyzedChapterKeys = new Set<string>();
    literaryMemory.value = createEmptyLiteraryMemory();
    literaryStatus.value = {
      enabled: false, bookProfileReady: false, chapterTitle: '', analyzedChapters: 0, reviewedSegments: 0,
      warnings: [], reviewFindings: [], diagnostics: [],
    };
    state.value = {
      translations: new Map(),
      total: 0,
      done: 0,
      failedBatches: [],
      running: false,
      error: '',
      workChapter: '',
      workTotal: 0,
      workDone: 0,
      workStage: '',
      activeSegmentIds: new Set(),
    };
  }

  function stop() {
    // runtime.sendMessage 不一定可取消；使当前运行失效，丢弃之后返回的旧结果。
    generation++;
    state.value.running = false;
  }

  async function translateBatch(
    batch: DocumentSegment[],
    options: TranslateOptions,
    runId: number,
    bookMemory?: LiteraryBookMemory,
    precedingSegments: DocumentSegment[] = [],
  ): Promise<boolean> {
    if (shouldUseRemoteDocumentTranslation(options)) {
      // Worker 只做本批片段的一次无状态翻译；文学书籍分析和 Reviewer 仅走本机 Agent。
      const result = await translateSegmentsViaServer(batch, options, runId, isCurrentRun);
      if (!result || !isCurrentRun(runId)) return false;
      const expectedIds = batch.map((segment) => segment.id);
      const batchTextById = new Map(batch.map((segment) => [segment.id, segment.text]));
      for (const [id, value] of Object.entries(result.translations ?? {})) {
        if (expectedIds.includes(id) && typeof value === 'string' && value.trim()) {
          // 服务端空转（长段原文返回）同样不能入库，否则英文冒充译文、
          // 缺失检查也发现不了；跳过后走下面的缺失报错与重试。
          if (options.sourceLang !== options.targetLang &&
            findNoOpBlockIds(new Map([[id, value]]), batchTextById).length > 0) {
            continue;
          }
          state.value.translations.set(id, value);
        }
      }
      const missingIds = getMissingDocumentBatchIds(expectedIds, state.value.translations);
      if (missingIds.length) {
        const serverErrors = Array.isArray(result.errors)
          ? result.errors.filter((error): error is string => typeof error === 'string')
          : [];
        throw new Error(
          serverErrors.join('；') ||
          ('服务端翻译结果不完整，缺少 ' + missingIds.length + '/' + expectedIds.length + ' 个片段'),
        );
      }
      return isCurrentRun(runId);
    }

    const normalized = await translateBatchText(batch, options, runId, bookMemory, precedingSegments);
    await reviewBatchText(batch, normalized, options, bookMemory, runId, precedingSegments);
    await checkpoint(options);
    return isCurrentRun(runId);
  }

  /**
   * 本地初译阶段：只拿译文、提交入库，不等审校。
   * run 的 worker 拿到初译就计进度；审校由 reviewBatchText detached 后台跑。
   * 抛错表示本批失败（调用方走重试/标失败），成功则返回全批译文。
   */
  async function translateBatchText(
    batch: DocumentSegment[],
    options: TranslateOptions,
    runId: number,
    bookMemory?: LiteraryBookMemory,
    precedingSegments: DocumentSegment[] = [],
  ): Promise<Map<string, string>> {
    // 本地初译依旧走扩展现有 provider；仅在书籍模式追加受限的书籍记忆 prompt。
    // 模型偶发只回第一条就停（同样的整批重试经实测复现相同结果，只是白烧时间）：
    // 缺失则对半缩小重发——改变 prompt 本身才可能走出确定性失败，同时指数收敛；
    // 每轮已拿到的逐段提交，不丢。
    const normalized = new Map<string, string>();
    const expectedIds = batch.map((segment) => segment.id);
    const chapterTitle = batch[0]?.contextPath || options.documentTitle || '';
    /** 本批是否出现过模型空转（长段原文返回），用于最终失败时给出对因的报错。 */
    let sawNoOp = false;
    // 发一轮并存好拿到的条目，返回本轮仍缺的 id。
    const sendRound = async (
      segments: DocumentSegment[],
      responseFormat?: { type: 'json_schema'; json_schema: unknown },
    ): Promise<string[]> => {
      const literaryMode = options.literaryMode || options.translationMode === 'literary';
      const voiceContext = literaryMode && bookMemory
        ? buildLiteraryContextForBatch({
            memory: bookMemory,
            segments: segments.map((segment) => ({ id: segment.id, text: segment.text, contextPath: segment.contextPath })),
            precedingSegments: precedingSegments.map((segment) => ({ id: segment.id, text: segment.text, contextPath: segment.contextPath })),
            chapterTitle,
            tokenBudget: 2500,
          })
        : undefined;
      if (literaryMode) {
        const injected = (voiceContext || {}) as Record<string, unknown>;
        const count = (key: string) => Array.isArray(injected[key]) ? (injected[key] as unknown[]).length : 0;
        recordDiagnostic('translation-request', 'started', '准备发送本批初译请求', {
          route: shouldUseRemoteDocumentTranslation(options) ? 'cloud-document-api'
            : options.useLocalAgent ? 'local-agent-via-extension-provider' : 'extension-provider',
          chapter: chapterTitle, segmentCount: segments.length,
          sourceChars: segments.reduce((sum, segment) => sum + segment.text.length, 0),
          firstSegmentId: segments[0]?.id || '', precedingSegments: precedingSegments.length,
          memoryEntities: bookMemory?.entities.length ?? 0, voiceContextIncluded: !!voiceContext,
          injectedEntities: count('entities'), injectedRelationships: count('relationships'),
          injectedCharacterVoices: count('characterVoices'),
          injectedRelationshipVoiceRules: count('relationshipVoiceRules'),
          injectedVoiceAnchors: count('voiceAnchors'), injectedChapterSummaries: count('chapterSummaries'),
          promptOverride: !!options.documentSystemPromptOverride?.trim(),
          userTemplate: !!options.documentUserPromptTemplate?.trim(),
          responseFormat: responseFormat?.type || 'json_object',
        });
      }
      // contextPath 只表示源文档结构；角色声音由独立的只读 voiceContext 传递。
      const jsonContent = JSON.stringify(
        segments.map((segment) => ({
          id: segment.id,
          text: segment.text,
          ...(segment.contextPath ? { contextPath: segment.contextPath } : {}),
          kind: segment.kind,
          ...(segment.level ? { level: segment.level } : {}),
          ...(segment.marker ? { marker: segment.marker } : {}),
        })),
      );
      const response = (await browser.runtime.sendMessage({
        action: 'translateChunk',
        jsonContent,
        ...(voiceContext ? { voiceContext } : {}),
        ...(literaryMode && precedingSegments.length ? {
          precedingSegments: precedingSegments.slice(-4).map((segment) => ({
            id: segment.id, text: segment.text.slice(0, 900), contextPath: segment.contextPath,
          })),
        } : {}),
        sourceLang: options.sourceLang,
        targetLang: options.targetLang,
        pageUrl: 'fanyi://document',
        glossary: options.translationMode === 'literary' || (options.literaryMode && bookMemory) ? undefined : options.glossary,
        promptStyle: options.promptStyle,
        translationMode: options.translationMode === 'literary' || (options.literaryMode && bookMemory) ? 'literary' : 'technical',
        documentSessionId: options.documentSessionId,
        documentSessionLane: resolveDocumentSessionLane(options, segments),
        forceRefresh: options.forceRefresh,
        documentSystemPromptOverride: options.documentSystemPromptOverride,
        documentUserPromptTemplate: options.documentUserPromptTemplate,
        ...((options.literaryMode || options.translationMode === 'literary') && bookMemory ? {
          // Keep the system instruction stable across chapters; chapter identity and book memory
          // are already included as user-payload context for each batch.
          literaryContext: buildLiteraryTranslationContextPrompt(),
        } : {}),
        ...(responseFormat ? { responseFormat } : {}),
      })) as TranslateChunkResponse;

      if (!isCurrentRun(runId)) return [];
      if (!response?.success) {
        if (literaryMode) recordDiagnostic('translation-request', 'failed', '本批初译请求失败', {
          firstSegmentId: segments[0]?.id || '', segmentCount: segments.length,
          error: (response?.error || '翻译失败').slice(0, 240),
        });
        throw new Error(response?.error || '翻译失败');
      }
      if (literaryMode && response.trace) {
        const trace = response.trace;
        recordDiagnostic('provider-trace', trace.cacheSource === 'model' ? 'completed' : 'info',
          trace.cacheSource === 'model' ? '本批由翻译 Provider 新生成结果' :
            trace.cacheSource === 'extension-cache' ? '本批直接命中扩展缓存，未调用模型' :
              trace.cacheSource === 'local-sqlite-cache' ? '本批直接命中本机 SQLite 缓存，未调用模型' :
                '翻译 Provider 返回了诊断信息，但未标明结果来源',
          {
            cacheSource: trace.cacheSource || 'unknown',
            provider: trace.provider || 'unknown',
            translationMode: trace.translationMode || 'unknown',
            inputBytes: trace.inputBytes,
            reservedMaxTokens: trace.reservedMaxTokens,
            outputBytes: trace.outputBytes,
            outputBlocks: trace.outputBlocks,
            missingInResponseCount: trace.missingInResponse?.length ?? 0,
            missingIds: (trace.missingInResponse || []).slice(0, 8).join(','),
            jsonParseFailed: trace.jsonParseFailed,
            parseError: trace.parseError?.slice(0, 160) || '',
          });
      }

      const roundIds = segments.map((segment) => segment.id);
      for (const [id, text] of normalizeDocumentBatchResult(response.result, roundIds)) {
        normalized.set(id, text);
        state.value.translations.set(id, text);
      }
      // 本轮空转条目（长段原文返回）必须剔除、不入库：否则英文冒充译文，
      // 缺失检查发现不了，还会随 checkpoint 存住。剔除后它们回到缺失集合，
      // 走对半缩小重发（短 prompt 弱模型也更容易跟上）。
      let noOpCount = 0;
      if (options.sourceLang !== options.targetLang) {
        const noOpIds = findNoOpBlockIds(normalized, segments);
        noOpCount = noOpIds.length;
        if (noOpIds.length) {
          sawNoOp = true;
          for (const id of noOpIds) {
            normalized.delete(id);
            state.value.translations.delete(id);
          }
          console.warn(
            '[document-reader] 模型本轮 ' + noOpIds.length + ' 段原文返回（未翻译），已剔除并缩小重试：' +
            noOpIds.slice(0, 5).join(', ') + (noOpIds.length > 5 ? '…' : ''),
          );
        }
      }
      const missingIds = getMissingDocumentBatchIds(roundIds, normalized);
      if (literaryMode) recordDiagnostic('translation-response', missingIds.length ? 'warning' : 'completed',
        missingIds.length ? '本轮模型响应缺少部分片段，将进入有界缩小重试' : '本轮初译结果已通过片段 ID 完整性检查',
        {
          requestedSegments: roundIds.length, returnedSegments: roundIds.length - missingIds.length,
          missingCount: missingIds.length, missingIds: missingIds.slice(0, 8).join(','),
          unchangedSourceCount: noOpCount,
        });
      return missingIds;
    };
    let pending = batch;
    const maxRounds = 6;
    for (let round = 0; round < maxRounds && pending.length > 0; round++) {
      const current = round === 0 ? pending : pending.slice(0, Math.max(1, Math.ceil(pending.length / 2)));
      const rest = round === 0 ? [] : pending.slice(current.length);
      const missing = new Set(await sendRound(current));
      if (!isCurrentRun(runId)) return false;
      pending = [...rest, ...current.filter((segment) => missing.has(segment.id))];
    }
    let missingIds = getMissingDocumentBatchIds(expectedIds, state.value.translations);
    // 终极升级（仅本机）：缩小循环后仍有缺失，用 --json-schema 把数组形状写死做约束解码。
    // 普通 json_object 只保证"是 JSON"，确定性失败（如只回第一条）必须升级形状约束才走得出来。
    // 只追加一单；失败即抛，不循环。
    if (missingIds.length > 0 && options.useLocalAgent && isCurrentRun(runId)) {
      const missingSet = new Set(missingIds);
      const missingSegments = batch.filter((segment) => missingSet.has(segment.id));
      const stillMissing = new Set(await sendRound(missingSegments, {
        type: 'json_schema',
        json_schema: TRANSLATIONS_OBJECT_SCHEMA,
      }));
      if (!isCurrentRun(runId)) return false;
      missingIds = getMissingDocumentBatchIds(expectedIds, state.value.translations);
    }
    if (missingIds.length) {
      throw new Error(
        '翻译结果不完整，缺少 ' + missingIds.length + '/' + expectedIds.length +
        ' 个片段（' + missingIds.slice(0, 5).join(', ') + (missingIds.length > 5 ? '…' : '') + '）' +
        (sawNoOp
          ? '；模型多轮原文返回、未实际翻译（本机模型可能太弱或内容被过滤），请更换更大的本机模型后重试该批'
          : ''),
      );
    }

    // 本地初译也走独立 reviewer，但 detached 后台跑（见 reviewBatchText），
    // 这里只保证初译完整入库。skipReview（快速模式）连 detached 都省了。
    await checkpoint(options);
    return normalized;
  }

  /**
   * 审校阶段：可 detached 后台跑，不占主翻译过程。
   * 落定后覆盖初译、刷新记忆例子、增量持久化；自己吞掉失败（保留初译+警告），绝不抛错。
   */
  async function reviewBatchText(
    batch: DocumentSegment[],
    drafts: ReadonlyMap<string, string>,
    options: TranslateOptions,
    bookMemory: LiteraryBookMemory | undefined,
    runId: number,
    precedingSegments: DocumentSegment[] = [],
  ): Promise<void> {
    const expectedIds = batch.map((segment) => segment.id);
    const literaryRequest = options.literaryMode || options.translationMode === 'literary';
    if (!literaryRequest) return;
    if (options.skipReview) {
      recordDiagnostic('review', 'info', '文学审校已配置为关闭；本批只保留初译', {
        segmentCount: expectedIds.length, firstSegmentId: expectedIds[0] || '',
      });
      return;
    }
    state.value.workStage = '审校中';
    recordDiagnostic('review', 'started', '开始独立文学审校', {
      segmentCount: expectedIds.length, precedingSegments: precedingSegments.length,
      memoryEntities: bookMemory?.entities.length ?? 0,
      characterVoices: bookMemory?.characterVoices.length ?? 0,
      relationshipVoiceRules: bookMemory?.relationshipVoiceRules.length ?? 0,
      voiceAnchors: bookMemory?.voiceAnchors.length ?? 0,
      provider: options.localAgentProvider || options.provider || 'default',
      model: options.localAgentModel || options.model || 'auto',
      firstSegmentId: expectedIds[0] || '',
    });
    try {
      const reviewed = await reviewLiteraryBatchViaLocalAgent(
        batch, new Map(drafts), options, bookMemory, runId, isCurrentRun, precedingSegments,
      );
      if (reviewed && isCurrentRun(runId)) {
        recordDiagnostic('review', 'completed', '文学审校已返回结果', {
          requestedSegments: expectedIds.length, reviewedSegments: reviewed.translations.size,
          findings: reviewed.findings.length,
          accuracyFindings: reviewed.findings.filter((item) => item.category === 'accuracy').length,
          terminologyFindings: reviewed.findings.filter((item) => item.category === 'terminology').length,
          styleFindings: reviewed.findings.filter((item) => item.category === 'style').length,
          mustFixFindings: reviewed.findings.filter((item) => item.priority === 'must_fix').length,
          memoryEntities: bookMemory?.entities.length ?? 0,
          characterVoices: bookMemory?.characterVoices.length ?? 0,
        });
        const mustFixIds = new Set(reviewed.findings.filter((finding) => finding.priority === 'must_fix').map((finding) => finding.id));
        const pendingStyleIds = new Set(reviewed.findings
          .filter((finding) => finding.category === 'style' && finding.applicationStatus === 'pending' && !mustFixIds.has(finding.id))
          .map((finding) => finding.id));
        for (const [id, text] of reviewed.translations) {
          // 准确性和实体译名错误自动修正；纯文风建议保留为候选稿，供用户比较后决定。
          if (expectedIds.includes(id) && text.trim() && !pendingStyleIds.has(id)) {
            state.value.translations.set(id, text);
          }
        }
        literaryStatus.value.reviewedSegments += reviewed.translations.size;
        literaryStatus.value.reviewFindings = appendLiteraryReviewFindings(
          reviewed.findings, literaryStatus.value.reviewFindings,
        );
        const missingReview = expectedIds.filter((id) => !reviewed.translations.has(id));
        if (missingReview.length) {
          literaryStatus.value.warnings.push('本批审校未返回 ' + missingReview.length + ' 段，已保留初译');
        }
        literaryMemory.value = refreshLiteraryExampleTargets(
          literaryMemory.value,
          batch.flatMap((segment) => {
            const styleProposalPending = pendingStyleIds.has(segment.id);
            const target = styleProposalPending
              ? drafts.get(segment.id)
              : (reviewed.translations.get(segment.id) ?? drafts.get(segment.id));
            return target ? [{
              source: segment.text, target, chapter: segment.contextPath || '',
            }] : [];
          }),
        );
      } else if (isCurrentRun(runId)) {
        recordDiagnostic('review', 'warning', '审校结果因运行已切换而被丢弃', {
          requestedSegments: expectedIds.length,
        });
      }
    } catch (error) {
      if (isCurrentRun(runId)) {
        const message = error instanceof Error ? error.message : String(error);
        recordDiagnostic('review', 'failed', '文学审校失败，已保留初译', {
          error: message.slice(0, 240), segmentCount: expectedIds.length,
        });
        literaryStatus.value.warnings.push('文学审校不可用，已保留初译：' + message);
      }
    }
    await checkpoint(options);
  }

  /**
   * Re-run only the Reviewer for selected, already translated segments.
   * This repairs legacy "hint only" records without re-translating a whole page or book.
   */
  async function reviewExistingSegments(
    segments: DocumentSegment[],
    options: TranslateOptions,
  ): Promise<void> {
    if (state.value.running) return;
    const candidates = segments.filter((segment) =>
      typeof state.value.translations.get(segment.id) === 'string' &&
      !!state.value.translations.get(segment.id)?.trim(),
    );
    if (!candidates.length) {
      state.value.error = '这些片段还没有译文，请先翻译当前页。';
      return;
    }
    generation++;
    const runId = generation;
    state.value.running = true;
    state.value.error = '';
    state.value.workStage = '重新审校中';
    state.value.activeSegmentIds = new Set(candidates.map((segment) => segment.id));
    try {
      const drafts = new Map(candidates.map((segment) => [
        segment.id,
        state.value.translations.get(segment.id)!,
      ]));
      const reviewed = await reviewLiteraryBatchViaLocalAgent(
        candidates, drafts, options, literaryMemory.value, runId, isCurrentRun,
      );
      if (!reviewed || !isCurrentRun(runId)) return;
      const mustFixIds = new Set(
        reviewed.findings.filter((finding) => finding.priority === 'must_fix').map((finding) => finding.id),
      );
      const pendingStyleIds = new Set(
        reviewed.findings
          .filter((finding) => finding.category === 'style' && finding.applicationStatus === 'pending' && !mustFixIds.has(finding.id))
          .map((finding) => finding.id),
      );
      for (const [id, text] of reviewed.translations) {
        if (text.trim() && !pendingStyleIds.has(id)) state.value.translations.set(id, text);
      }
      literaryStatus.value.reviewedSegments += reviewed.translations.size;
      literaryStatus.value.reviewFindings = appendLiteraryReviewFindings(
        reviewed.findings, literaryStatus.value.reviewFindings,
      );
      literaryMemory.value = refreshLiteraryExampleTargets(
        literaryMemory.value,
        candidates.flatMap((segment) => {
          const draft = drafts.get(segment.id);
          const result = reviewed.translations.get(segment.id);
          const target = pendingStyleIds.has(segment.id) ? draft : (result || draft);
          return target ? [{ source: segment.text, target, chapter: segment.contextPath || '' }] : [];
        }),
      );
      await checkpoint(options);
    } catch (error) {
      if (isCurrentRun(runId)) {
        state.value.error = '重新审校失败：' + (error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (isCurrentRun(runId)) {
        state.value.running = false;
        state.value.workStage = '';
        state.value.activeSegmentIds = new Set();
      }
    }
  }

  async function prepareLiteraryChapter(
    key: string,
    segments: DocumentSegment[],
    options: TranslateOptions,
    runId: number,
  ): Promise<boolean> {
    if (!options.literaryMode) {
      recordDiagnostic('chapter-analysis', 'warning', '未启用书籍级文学模式，跳过实体/人物记忆分析', {
        translationMode: options.translationMode || 'technical', chapter: key,
      });
      return isCurrentRun(runId);
    }
    if (analyzedChapterKeys.has(key)) {
      recordDiagnostic('chapter-analysis', 'info', '本章本次会话已分析过，复用现有记忆', {
        chapter: key, memoryEntities: literaryMemory.value.entities.length,
        characterVoices: literaryMemory.value.characterVoices.length,
      });
      return isCurrentRun(runId);
    }
    literaryStatus.value.chapterTitle = key;
    state.value.workStage = '实体分析中';
    recordDiagnostic('chapter-analysis', 'started', '开始分析当前章节实体与人物声音', {
      chapter: key, sourceSegments: segments.length,
      provider: options.localAgentProvider || options.provider || 'default',
      model: options.localAgentModel || options.model || 'auto',
      priorEntities: literaryMemory.value.entities.length,
      priorCharacterVoices: literaryMemory.value.characterVoices.length,
    });
    try {
      const result = await analyzeLiteraryChapterViaLocalAgent(
        key, segments, options, literaryMemory.value, runId, isCurrentRun,
      );
      if (!result || !isCurrentRun(runId)) return false;
      literaryMemory.value = result.memory;
      recordDiagnostic('chapter-analysis', result.warning ? 'warning' : 'completed',
        result.warning || (result.analyzed ? '章节分析完成' : '分析接口返回，但未标记 analyzed'),
        {
          chapter: key, analyzed: result.analyzed,
          entities: result.memory.entities.length, relationships: result.memory.relationships.length,
          characterVoices: result.memory.characterVoices.length,
          confirmedVoices: result.memory.characterVoices.filter((item) => item.status === 'confirmed').length,
          relationshipVoiceRules: result.memory.relationshipVoiceRules.length,
          voiceAnchors: result.memory.voiceAnchors.length,
        });
      if (result.warning) literaryStatus.value.warnings.push(result.warning);
      if (result.analyzed) literaryStatus.value.analyzedChapters++;
    } catch (error) {
      if (!isCurrentRun(runId)) return false;
      const message = error instanceof Error ? error.message : String(error);
      recordDiagnostic('chapter-analysis', 'failed', '本章记忆分析失败；翻译将继续使用现有上下文', {
        chapter: key, error: message.slice(0, 240),
      });
      literaryStatus.value.warnings.push('本章实体/文风分析失败，继续翻译：' + message);
    }
    // 即使分析服务失败也只尝试一次，避免每批反复支付同一分析的成本。
    analyzedChapterKeys.add(key);
    await checkpoint(options);
    return isCurrentRun(runId);
  }

  async function run(
    segments: DocumentSegment[],
    options: TranslateOptions,
    preserveExisting = false,
  ) {
    // Worker 不承担跨章节记忆与多阶段审校；没有启用本机 Agent 时明确拒绝。
    if (options.literaryMode && !options.useLocalAgent) {
      generation++;
      state.value.running = false;
      state.value.workStage = '';
      state.value.activeSegmentIds = new Set();
      state.value.error = '文学书籍模式需要启用本机 Local Agent；云端只支持单次片段翻译，不提供全书记忆、章节分析或独立审校。';
      return state.value;
    }
    // Literary mode keeps entity/style memory for every structured document, not only EPUB/PDF.
    // The global translation profile enables this automatically; the reader checkbox can opt in
    // to the same workflow for EPUB/PDF while the global profile remains technical.
    const startsLiteraryBook = !!options.literaryMode;
    // reset() normally clears a previous document. Preserve a user-authored glossary entered
    // before the first translation run, then merge the AI book analysis into it below.
    const preseededMemory = startsLiteraryBook ? sanitizeLiteraryMemory(literaryMemory.value) : undefined;
    if (preserveExisting) {
      generation++;
      state.value.failedBatches = [];
      state.value.error = '';
      state.value.running = false;
      state.value.workChapter = '';
      state.value.workTotal = 0;
      state.value.workDone = 0;
    } else {
      reset();
      if (preseededMemory) literaryMemory.value = preseededMemory;
    }
    const runId = generation;
    const literaryEnabled = startsLiteraryBook;
    const literaryProfileEnabled = literaryEnabled || options.translationMode === 'literary';
    literaryStatus.value.enabled = literaryProfileEnabled;
    if (!literaryEnabled) {
      literaryMemory.value = createEmptyLiteraryMemory();
      analyzedChapterKeys = new Set<string>();
    }

    // 文学模式保持原书顺序做分批（记忆按顺序累积），但每次推进的章节优先选
    // 当前阅读页所在章节：用户点"翻译"后当前页立刻有结果，而不是在后台默默
    // 翻译第一章、当前页永远显示"翻译中…"。当前页已翻完时回落到首个待翻章节。
    const priorityIds = new Set(options.prioritySegmentIds ?? []);
    const orderedSegments = priorityIds.size
      ? [
          ...segments.filter((segment) => priorityIds.has(segment.id)),
          ...segments.filter((segment) => !priorityIds.has(segment.id)),
        ]
      : [...segments];
    // The normal action translates only the currently displayed page. Full-document segments
    // still feed language detection and book-level analysis, but unrelated pages stay queued.
    const workInputSegments = options.onlyPrioritySegments && priorityIds.size
      ? orderedSegments.filter((segment) => priorityIds.has(segment.id))
      : orderedSegments;
    lastRunSegmentIds = workInputSegments.map((segment) => segment.id);

    // 文学模式强制在章节/PDF 页边界拆批；普通文档继续使用原分批行为。
    const budget: Partial<BatchBudget> = {
      // Local Agent calls have a higher fixed cost; use fewer, moderately larger batches by default.
      // Caller-supplied budget values remain authoritative.
      ...(options.useLocalAgent ? { maxChars: 5000, maxSegments: 32 } : {}),
      ...options.budget,
      ...(literaryProfileEnabled ? { splitOnContextChange: true } : {}),
    };
    const allBatches = await planDocumentBatches(orderedSegments, budget, options);
    const selectedBatches = workInputSegments === orderedSegments
      ? allBatches
      : await planDocumentBatches(workInputSegments, budget, options);
    state.value.total = allBatches.length;
    state.value.done = allBatches.filter((batch) =>
      batch.every((segment) => !!state.value.translations.get(segment.id)?.trim()),
    ).length;
    const pendingBatches = selectedBatches
      .map((batch, index) => ({
        index,
        batch: batch.filter((segment) => options.forceRefresh || !state.value.translations.get(segment.id)?.trim()),
      }))
      .filter((item) => item.batch.length > 0);
    state.value.running = pendingBatches.length > 0;
    state.value.activeSegmentIds = new Set();
    if (pendingBatches.length === 0) return state.value;

    const effectiveOptions: TranslateOptions = {
      ...options,
      literaryMode: literaryEnabled,
      translationMode: literaryProfileEnabled ? 'literary' : (options.translationMode || 'technical'),
      promptStyle: resolveDocumentStyle(segments, options),
    };
    if (literaryProfileEnabled) {
      recordDiagnostic('run', 'started', '开始文学翻译运行', {
        sourceLang: effectiveOptions.sourceLang, targetLang: effectiveOptions.targetLang,
        literaryBookMode: literaryEnabled, translationMode: effectiveOptions.translationMode || 'technical',
        route: shouldUseRemoteDocumentTranslation(effectiveOptions) ? 'cloud-document-api'
          : effectiveOptions.useLocalAgent ? 'local-agent-via-extension-provider' : 'extension-provider',
        provider: effectiveOptions.localAgentProvider || effectiveOptions.provider || 'default',
        model: effectiveOptions.localAgentModel || effectiveOptions.model || 'auto',
        sourceSegments: segments.length, selectedSegments: workInputSegments.length,
        pendingBatches: pendingBatches.length,
        reviewEnabled: !effectiveOptions.skipReview && !shouldUseRemoteDocumentTranslation(effectiveOptions),
        systemPromptOverride: !!effectiveOptions.documentSystemPromptOverride?.trim(),
        userPromptTemplate: !!effectiveOptions.documentUserPromptTemplate?.trim(),
        memoryEntitiesBeforeAnalysis: literaryMemory.value.entities.length,
        characterVoicesBeforeAnalysis: literaryMemory.value.characterVoices.length,
      });
    }

    // 第一个正式译稿之前，先用覆盖全书的少量代表片段建立实体/关系和声线底稿。
    // 这样早期章节也能认识后续章节反复出现的人物；翻译本身仍然逐批渐次执行。
    if (literaryEnabled && !literaryStatus.value.bookProfileReady && isCurrentRun(runId)) {
      literaryStatus.value.chapterTitle = '全书预分析';
      const bookSample = selectLiteraryBookSample(segments, options.documentFormat);
      recordDiagnostic('book-analysis', 'started', '开始全书实体、人物与关系预分析', {
        sourceSegments: segments.length, sampledSegments: bookSample.length,
        provider: effectiveOptions.localAgentProvider || effectiveOptions.provider || 'default',
        model: effectiveOptions.localAgentModel || effectiveOptions.model || 'auto',
      });
      try {
        const profile = await analyzeLiteraryChapterViaLocalAgent(
          '全书预分析',
          bookSample,
          effectiveOptions,
          literaryMemory.value,
          runId,
          isCurrentRun,
        );
        if (!profile || !isCurrentRun(runId)) return state.value;
        literaryMemory.value = profile.memory;
        literaryStatus.value.bookProfileReady = profile.analyzed;
        recordDiagnostic('book-analysis', profile.warning ? 'warning' : 'completed',
          profile.warning || (profile.analyzed ? '全书预分析完成' : '分析接口返回，但未标记 analyzed'),
          {
            analyzed: profile.analyzed, entities: profile.memory.entities.length,
            relationships: profile.memory.relationships.length,
            characterVoices: profile.memory.characterVoices.length,
            confirmedVoices: profile.memory.characterVoices.filter((item) => item.status === 'confirmed').length,
            relationshipVoiceRules: profile.memory.relationshipVoiceRules.length,
            voiceAnchors: profile.memory.voiceAnchors.length,
          });
        if (profile.analyzed) {
          // 单章文件的全书抽样已经覆盖了本章，无须为同一章再付一次分析请求。
          const chapterKeys = new Set(
            segments.map((segment) => literaryChapterKey(segment, true, options.documentFormat)),
          );
          if (chapterKeys.size === 1) {
            const onlyChapter = chapterKeys.values().next().value as string | undefined;
            if (onlyChapter) analyzedChapterKeys.add(onlyChapter);
            // 单章节书籍的全书抽样已经覆盖该章；避免第二次付费分析，但状态仍反映该章已分析。
            if (literaryStatus.value.analyzedChapters === 0) literaryStatus.value.analyzedChapters = 1;
          }
        }
        if (profile.warning) literaryStatus.value.warnings.push(profile.warning);
        await checkpoint(effectiveOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordDiagnostic('book-analysis', 'failed', '全书预分析失败；后续尝试逐章补充实体记忆', {
          error: message.slice(0, 240),
        });
        literaryStatus.value.warnings.push('全书预分析失败，将逐章补充实体记忆：' + message);
        await checkpoint(effectiveOptions);
      }
    }

    // 文学模式每次只推进一个尚未完成的章节/PDF 上下文单元.
    // 上一单元的初译、reviewer 与译例更新完成后，再由用户继续下一章。
    // 优先推进当前阅读页所在章节（options.prioritySegmentIds 由调用方传入当前页），
    // 这样当前页立刻可见译文；当前页已完成时回落到首个待翻章节。
    let workBatches = pendingBatches;
    let analysisChapterKey = '';
    if (literaryEnabled && pendingBatches.length > 0 && !options.onlyPrioritySegments) {
      const chapterOf = (item: { batch: DocumentSegment[] }) =>
        literaryChapterKey(item.batch[0]!, true, options.documentFormat);
      let chapterKey = chapterOf(pendingBatches[0]!);
      const priorityList = options.prioritySegmentIds ?? [];
      if (priorityList.length) {
        const byId = new Map(segments.map((segment) => [segment.id, segment]));
        for (const id of priorityList) {
          const segment = byId.get(id);
          if (!segment) continue;
          const candidate = literaryChapterKey(segment, true, options.documentFormat);
          if (pendingBatches.some((item) => chapterOf(item) === candidate)) {
            chapterKey = candidate;
            break;
          }
        }
      }
      workBatches = pendingBatches.filter((item) => chapterOf(item) === chapterKey);
      analysisChapterKey = chapterKey;
      state.value.workChapter = chapterKey;
      literaryStatus.value.chapterTitle = chapterKey;
    } else {
      if (literaryEnabled && pendingBatches.length > 0) {
        analysisChapterKey = literaryChapterKey(pendingBatches[0]!.batch[0]!, true, options.documentFormat);
        state.value.workChapter = options.onlyPrioritySegments
          ? (options.currentPageTitle || analysisChapterKey) + '（当前页）'
          : analysisChapterKey;
        literaryStatus.value.chapterTitle = analysisChapterKey;
      } else {
        state.value.workChapter = '';
      }
    }
    state.value.workTotal = workBatches.length;
    state.value.workDone = 0;

    // 同一次 run 只推进一章：章节实体分析提前做一次，worker 里不再逐批重复。
    if (literaryEnabled && workBatches.length > 0 && isCurrentRun(runId)) {
      const chapterSegments = segments.filter((segment) =>
        literaryChapterKey(segment, true, options.documentFormat) === analysisChapterKey);
      state.value.workStage = '实体分析中';
      if (!(await prepareLiteraryChapter(
        analysisChapterKey, chapterSegments, effectiveOptions, runId,
      ))) {
        state.value.workStage = '';
        return state.value;
      }
    }

    // Worker 内部会为 chunk/缺失 ID 执行有界重试；客户端不重复重跑整批，避免重复模型调用。
    const retries = shouldUseRemoteDocumentTranslation(effectiveOptions) ? 0 : (options.retries ?? 1);
    // 章记忆只在章边界累积；同章内的批互相独立（译文按 id 回填），可以并行。
    // 本机服务是每请求独立进程 + SQLite WAL，background 的本机队列并发为 4，
    // 这里取 3：5 批的章节约 3 倍提速，又不会打爆本机服务。
    const concurrency = literaryProfileEnabled
      ? Math.max(1, Math.min(4, options.concurrency ?? 2))
      : Math.max(1, options.concurrency ?? 3);
    let cursor = 0;
    // detached 审校跟踪：初译提交后审校后台跑，不占翻译 worker；
    // run 尾部统一收敛（全部落定才算本次完成）。停止/新 run 会使旧审校失效丢弃。
    const pendingReviews: Array<Promise<void>> = [];
    let pendingReviewCount = 0;
    const updateTailStage = () => {
      if (isCurrentRun(runId)) {
        state.value.workStage = pendingReviewCount > 0
          ? '审校收尾中（剩余 ' + pendingReviewCount + ' 批）'
          : '审校收尾中';
      }
    };
    // Worker 只做单次片段翻译；远程模式不额外启动文学 Reviewer。
    const remoteMode = shouldUseRemoteDocumentTranslation(effectiveOptions);
    const segmentIndexById = new Map(segments.map((segment, index) => [segment.id, index]));
    const precedingForBatch = (batch: DocumentSegment[]): DocumentSegment[] => {
      const first = batch[0];
      const index = first ? segmentIndexById.get(first.id) : undefined;
      if (index === undefined || index <= 0 || !first) return [];
      const previous = segments.slice(Math.max(0, index - 4), index);
      const chapterKey = literaryChapterKey(first, literaryProfileEnabled, options.documentFormat);
      const sameChapter = previous.filter((segment) =>
        literaryChapterKey(segment, literaryProfileEnabled, options.documentFormat) === chapterKey,
      );
      // 同章前文优先；若当前单元刚开始，则仅带最近两段作为过渡线索。
      return (sameChapter.length ? sameChapter : previous.slice(-2)).slice(-4);
    };

    const worker = async () => {
      while (cursor < workBatches.length && isCurrentRun(runId)) {
        const item = workBatches[cursor++];
        if (!item) continue;
        const { index, batch } = item;
        const precedingSegments = literaryProfileEnabled ? precedingForBatch(batch) : [];
        const batchIds = batch.map((segment) => segment.id);
        // 每批进场登记、退场注销：阅读页只给这些段显示「翻译中…」。
        if (isCurrentRun(runId)) {
          state.value.activeSegmentIds = new Set([...state.value.activeSegmentIds, ...batchIds]);
        }
        let ok = false;
        for (let attempt = 0; attempt <= retries && isCurrentRun(runId); attempt++) {
          try {
            state.value.workStage = '翻译中';
            if (remoteMode) {
              ok = await translateBatch(
                batch, effectiveOptions, runId, literaryProfileEnabled ? literaryMemory.value : undefined, precedingSegments,
              );
            } else {
              // 本地：初译一到就提交计进度，审校 detached，不阻塞下一批。
              const normalized = await translateBatchText(
                batch, effectiveOptions, runId, literaryProfileEnabled ? literaryMemory.value : undefined, precedingSegments,
              );
              ok = isCurrentRun(runId);
              if (ok && literaryProfileEnabled && !effectiveOptions.skipReview) {
                const drafts = new Map(normalized);
                pendingReviewCount++;
                pendingReviews.push(
                  reviewBatchText(batch, drafts, effectiveOptions, literaryProfileEnabled ? literaryMemory.value : undefined, runId, precedingSegments)
                    .catch(() => undefined)
                    .finally(() => {
                      pendingReviewCount--;
                      if (isCurrentRun(runId)) updateTailStage();
                    }),
                );
              }
            }
            if (ok) break;
          } catch (err) {
            if (!isCurrentRun(runId)) return;
            if (literaryProfileEnabled) recordDiagnostic('translation-batch', attempt === retries ? 'failed' : 'warning',
              attempt === retries ? '翻译批次最终失败' : '翻译批次失败，准备重试',
              {
                batchIndex: index, attempt: attempt + 1, retriesAllowed: retries,
                segmentCount: batch.length, firstSegmentId: batchIds[0] || '',
                error: (err instanceof Error ? err.message : String(err)).slice(0, 240),
              });
            if (attempt === retries) {
              state.value.failedBatches.push(index);
              state.value.error = (err as Error).message;
            } else {
              await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
            }
          }
        }
        if (!isCurrentRun(runId)) return;
        // 无论成败都摘出活跃集合：失败的段不再显示「翻译中…」，否则会永久挂着。
        state.value.activeSegmentIds = new Set(
          [...state.value.activeSegmentIds].filter((id) => !batchIds.includes(id)),
        );
        if (ok) {
          state.value.done = allBatches.filter((candidateBatch) =>
            candidateBatch.every((segment) => !!state.value.translations.get(segment.id)?.trim()),
          ).length;
          state.value.workDone++;
          if (literaryProfileEnabled) {
            literaryMemory.value = addLiteraryExamples(literaryMemory.value, batch.flatMap((segment) => {
              const translated = state.value.translations.get(segment.id);
              return translated ? [{
                source: segment.text, target: translated, chapter: segment.contextPath || '',
              }] : [];
            }));
          }
        }
        await checkpoint(effectiveOptions);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, workBatches.length) }, () => worker()),
    );

    // 初译全部落定后，统一收敛 detached 审校：译文早已可见，
    // 这里只等审校覆盖+记忆刷新+持久化，尾部最多多等一批审校的时间。
    if (pendingReviews.length > 0 && isCurrentRun(runId)) {
      updateTailStage();
      await Promise.allSettled(pendingReviews);
    }

    if (isCurrentRun(runId)) {
      state.value.failedBatches.sort((a, b) => a - b);
      state.value.running = false;
      state.value.workStage = '';
      state.value.activeSegmentIds = new Set();
      if (literaryProfileEnabled) {
        recordDiagnostic('run', state.value.failedBatches.length ? 'warning' : 'completed',
          state.value.failedBatches.length ? '文学翻译运行结束，但仍有失败批次' : '文学翻译运行完成',
          {
            translatedSegments: state.value.translations.size, totalSegments: segments.length,
            finishedBatches: state.value.workDone, totalWorkBatches: state.value.workTotal,
            failedBatches: state.value.failedBatches.length,
            reviewedSegments: literaryStatus.value.reviewedSegments,
            findings: literaryStatus.value.reviewFindings.length,
            entities: literaryMemory.value.entities.length,
            characterVoices: literaryMemory.value.characterVoices.length,
          });
      }
      await checkpoint(effectiveOptions);
    }
    return state.value;
  }

  /** 只重跑失败的批次。 */
  async function retryFailed(
    segments: DocumentSegment[],
    options: TranslateOptions,
  ) {
    const failed = [...state.value.failedBatches];
    if (!failed.length) return;
    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    const orderedSegments = lastRunSegmentIds.length
      ? lastRunSegmentIds.map((id) => byId.get(id)).filter((segment): segment is DocumentSegment => !!segment)
      : [...segments];
    const batches = buildSegmentBatches(orderedSegments, {
      ...(options.useLocalAgent ? { maxChars: 5000, maxSegments: 32 } : {}),
      ...options.budget,
      ...(options.literaryMode ? { splitOnContextChange: true } : {}),
    });
    const runId = ++generation;
    state.value.failedBatches = [];
    state.value.error = '';
    state.value.running = true;
    // 上一次 run 被打断（停止/新 run）时可能留下活跃 id，这里先清零再由 worker 逐批登记。
    state.value.activeSegmentIds = new Set();

    // 与 run 同一份解析结果：重试批次必须沿用同一文风，否则缓存 key 不同、
    // 且同一文档会出现文风割裂。
    const effectiveOptions: TranslateOptions = {
      ...options,
      promptStyle: resolveDocumentStyle(segments, options),
    };


    for (const index of failed) {
      if (!isCurrentRun(runId)) break;
      const batch = (batches[index] ?? [])
        // 部分成功的批次只提交缺失片段，已成功的译文不重复消耗请求与 token。
        .filter((segment) => !state.value.translations.get(segment.id)?.trim());
      if (!batch.length) continue;
      try {
        if (options.literaryMode) {
          const key = literaryChapterKey(batch[0]!, true, options.documentFormat);
          const chapterSegments = segments.filter((segment) =>
            literaryChapterKey(segment, true, options.documentFormat) === key);
          if (!(await prepareLiteraryChapter(key, chapterSegments, effectiveOptions, runId))) break;
        }
        const ok = await translateBatch(
          batch, effectiveOptions, runId,
          options.literaryMode ? literaryMemory.value : undefined,
        );
        if (!isCurrentRun(runId)) break;
        if (ok) state.value.done++;
        else state.value.failedBatches.push(index);
        await checkpoint(effectiveOptions);
      } catch (err) {
        if (!isCurrentRun(runId)) break;
        state.value.failedBatches.push(index);
        state.value.error = (err as Error).message;
        await checkpoint(effectiveOptions);
      }
    }
    if (isCurrentRun(runId)) {
      state.value.failedBatches.sort((a, b) => a - b);
      state.value.running = false;
      await checkpoint(effectiveOptions);
    }
  }

  return {
    state, run, retryFailed, reviewExistingSegments, stop, reset, literaryMemory, literaryStatus,
    getSnapshot, restoreSnapshot,
  };
}
