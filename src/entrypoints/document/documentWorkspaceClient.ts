/**
 * 文档 workspace 的唯一客户端契约。
 *
 * 阅读页与“翻译 Agent”都使用这里的文档指纹、项目映射和 API 调用，避免两个 Tab
 * 因为各自生成 session ID 或 Prompt 快照而创建两份数据库、产生两套译文版本。
 */
import { storage } from '@wxt-dev/storage';
import type { ParsedDocument, DocumentSegment } from '@/entrypoints/utils/document/types';

export interface WorkspaceSegment {
  id: string;
  text: string;
  kind?: string;
  contextPath?: string;
  page?: number | null;
  level?: number | null;
  marker?: string | null;
  path?: string;
  start?: string;
  end?: string;
}

export interface WorkspacePrompt {
  name?: string;
  systemPrompt: string;
  userPromptTemplate: string;
  sourceLang: string;
  targetLang: string;
  provider: 'workbuddy' | 'opencode';
  model: string;
  translationMode: 'technical' | 'literary';
  literaryReview: boolean;
  glossary?: unknown;
  literaryMemory?: unknown;
}

export interface WorkspaceProjectMappingInput {
  title: string;
  format: string;
  sourceFileName: string;
  segments: WorkspaceSegment[];
}


export interface LocalAgentFileImportResult {
  project?: {
    projectId: string;
    title: string;
    format: string;
    sourceFileName: string;
    segmentCount: number;
    sourceFingerprint: string;
    sourceFileSaved?: boolean;
  };
  reusedExisting?: boolean;
  sourceChanged?: boolean;
  relatedProject?: { projectId: string; title: string; sourceFileName: string };
  document?: { title: string; format: string; segments: Array<Record<string, unknown>> };
}

function contentTypeForDocumentFile(file: File): string {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'epub') return 'application/epub+zip';
  if (extension === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

/**
 * Import original bytes and parse EPUB/PDF inside local-agent-service.
 * Do not build an all-book JSON body in the extension; the service persists parsed segments
 * directly in the per-project SQLite database.
 */
export async function importDocumentFileViaLocalAgent(
  baseUrl: string,
  token: string,
  file: File,
): Promise<LocalAgentFileImportResult> {
  return workspaceApi<LocalAgentFileImportResult>(
    baseUrl,
    token,
    '/api/documents/projects/import-file',
    {
      method: 'POST',
      headers: {
        'Content-Type': contentTypeForDocumentFile(file),
        'X-Source-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    },
    WORKSPACE_FILE_IMPORT_TIMEOUT_MS,
  );
}

function mapWorkspaceSegment(raw: Record<string, unknown>, fallbackIndex: number): DocumentSegment {
  const index = Number.isInteger(raw.ordinal) ? Number(raw.ordinal) : fallbackIndex;
  const allowedKinds = new Set(['heading', 'paragraph', 'list-item', 'caption', 'code', 'quote', 'other']);
  const kind = typeof raw.kind === 'string' && allowedKinds.has(raw.kind)
    ? raw.kind as DocumentSegment['kind']
    : 'paragraph';
  return {
    id: String(raw.id || ('s' + index)),
    index,
    text: typeof raw.text === 'string' ? raw.text : '',
    kind,
    ...(typeof raw.path === 'string' && raw.path ? { path: raw.path } : {}),
    ...(Number.isInteger(raw.level) ? { level: Number(raw.level) } : {}),
    ...(typeof raw.marker === 'string' && raw.marker ? { marker: raw.marker } : {}),
    ...(Number.isInteger(raw.page) ? { page: Number(raw.page) } : {}),
    ...(typeof raw.contextPath === 'string' && raw.contextPath ? { contextPath: raw.contextPath } : {}),
    ...(typeof raw.start === 'string' && raw.start ? { start: raw.start } : {}),
    ...(typeof raw.end === 'string' && raw.end ? { end: raw.end } : {}),
  };
}

/** Convert the server parser's conflict preview into the reader's display DTO. */
export function parsedDocumentFromLocalAgentPreview(input: {
  title: string;
  format: string;
  segments: Array<Record<string, unknown>>;
}): ParsedDocument {
  const segments = input.segments.map((segment, index) => mapWorkspaceSegment(segment, index));
  return {
    title: input.title,
    format: input.format as ParsedDocument['format'],
    segments,
    meta: {
      charCount: segments.reduce((sum, segment) => sum + segment.text.length, 0),
      segmentCount: segments.length,
      warnings: [],
    },
  };
}

/** Read source segments in bounded pages; no single whole-book JSON response is required. */
export async function loadWorkspaceParsedDocument(
  baseUrl: string,
  token: string,
  project: NonNullable<LocalAgentFileImportResult['project']>,
): Promise<ParsedDocument> {
  const segments: DocumentSegment[] = [];
  const expectedCount = Math.max(0, Number(project.segmentCount) || 0);
  for (let offset = 0; offset < expectedCount; offset += 1000) {
    const page = await workspaceApi<{ segments?: Array<Record<string, unknown>> }>(
      baseUrl,
      token,
      '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/segments?limit=1000&offset=' + offset,
    );
    const rows = Array.isArray(page.segments) ? page.segments : [];
    segments.push(...rows.map((segment, index) => mapWorkspaceSegment(segment, offset + index)));
    if (!rows.length) break;
  }
  if (segments.length !== expectedCount) {
    throw new Error('本机服务解析结果不完整：项目记录 ' + expectedCount + ' 段，实际读取 ' + segments.length + ' 段。请重新导入文件。');
  }
  return {
    title: project.title,
    format: project.format as ParsedDocument['format'],
    segments,
    meta: {
      charCount: segments.reduce((sum, segment) => sum + segment.text.length, 0),
      segmentCount: segments.length,
      warnings: [],
    },
  };
}

type ExactProjectMap = Record<string, string>;
type IdentityProjectMap = Record<string, { projectId: string; documentKey: string }>;

export function workspaceDocumentKey(input: Pick<WorkspaceProjectMappingInput, 'title' | 'format' | 'segments'>): string {
  let hash = 0x811c9dc5;
  const add = (value: string) => {
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  };
  add(input.format.toLowerCase() + '\u0000' + input.title + '\u0000');
  for (const segment of input.segments) {
    add(segment.id); add('\u0000'); add(segment.text); add('\u0000'); add(segment.kind || 'paragraph'); add('\u0000');
    add(segment.contextPath || ''); add('\u0000'); add(String(segment.page ?? '')); add('\u0000');
    add(String(segment.level ?? '')); add('\u0000'); add(segment.marker || ''); add('\u0000');
    add(segment.path || ''); add('\u0000'); add(segment.start || ''); add('\u0000'); add(segment.end || ''); add('\u0001');
  }
  return input.format.toLowerCase() + ':' + input.segments.length + ':' + (hash >>> 0).toString(16);
}

/** 内容指纹会变化；逻辑身份用于提示用户：这是同一个文件名，但内容已更新。 */
export function workspaceSourceIdentityKey(input: Pick<WorkspaceProjectMappingInput, 'title' | 'format' | 'sourceFileName'>): string {
  return [input.format.toLowerCase(), input.sourceFileName.toLocaleLowerCase()].join('::');
}

export async function lookupWorkspaceProject(input: WorkspaceProjectMappingInput): Promise<{
  projectId: string | null;
  sourceChanged: boolean;
  documentKey: string;
}> {
  const documentKey = workspaceDocumentKey(input);
  const exact = (await storage.getItem<ExactProjectMap>('local:documentAgentProjectMap')) || {};
  const identities = (await storage.getItem<IdentityProjectMap>('local:documentAgentProjectIdentityMap')) || {};
  const identity = identities[workspaceSourceIdentityKey(input)];
  const exactProjectId = exact[documentKey];
  return {
    projectId: exactProjectId || identity?.projectId || null,
    sourceChanged: !exactProjectId && !!identity && identity.documentKey !== documentKey,
    documentKey,
  };
}

/**
 * Resolve project identity from Local Agent's durable catalog. Local browser storage is only
 * an index/cache; it must not be required to rediscover a service-backed document.
 */
export async function resolveWorkspaceProject(
  baseUrl: string,
  token: string,
  input: WorkspaceProjectMappingInput,
): Promise<{ exactProject: any | null; relatedProject: any | null }> {
  return workspaceApi(
    baseUrl,
    token,
    '/api/documents/projects/resolve',
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export async function rememberWorkspaceProject(input: WorkspaceProjectMappingInput, projectId: string): Promise<void> {
  const documentKey = workspaceDocumentKey(input);
  const exact = (await storage.getItem<ExactProjectMap>('local:documentAgentProjectMap')) || {};
  exact[documentKey] = projectId;
  await storage.setItem('local:documentAgentProjectMap', exact);
  const identities = (await storage.getItem<IdentityProjectMap>('local:documentAgentProjectIdentityMap')) || {};
  identities[workspaceSourceIdentityKey(input)] = { projectId, documentKey };
  await storage.setItem('local:documentAgentProjectIdentityMap', identities);
}

/**
 * 带 HTTP 状态码的 workspace 调用错误。
 *
 * 调用方必须按 status 分支，不要靠 message 文本匹配：服务端的 404 文案是
 * 「找不到文档项目或项目已归档」这类中文说明，不含任何状态码，用 /HTTP 404/
 * 匹配会永远不命中，导致「项目已不存在」被当成未知故障，该新建的路径报错退出。
 */
export class WorkspaceApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
  }
}

/**
 * 本机服务的错误体有两种形状，必须都解析出可读文案：
 *   - 401 / 404 走 OpenAI 风格嵌套：{ error: { message, type } }
 *   - 其余端点走扁平字符串：{ error: '...' }
 * 直接把 payload.error 传给 Error 构造函数，嵌套对象会被字符串化成
 * "[object Object]"，真实原因（例如 token 不对）就丢了。
 */
function describeWorkspaceFailure(payload: any, status: number): string {
  const error = payload?.error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) return error;
  return '本机服务返回 HTTP ' + status;
}

/**
 * fetch 抛 TypeError 说明请求根本没拿到 HTTP 响应（连接被拒、服务刚被重启、
 * 地址/端口写错、被浏览器拦下）。浏览器只会给一句 "Failed to fetch"，
 * 直接把它当错误文案显示，用户既不知道找谁、也不知道该看哪个地址。
 * 这里补上实际请求的 base 和原始错误，保留可排查性。
 */
function describeNetworkFailure(base: string, error: unknown): string {
  const detail = error instanceof Error && error.message ? '（原始错误：' + error.message + '）' : '';
  return '无法连接本机服务 ' + base + '：服务可能未启动或正在重启，请确认服务运行后重试' + detail;
}

/**
 * 本机服务调用超时。
 *
 * fetch 在连接被黑洞（代理接管、端口假活）时既不成功也不失败，Promise 永远悬着；
 * 没有超时的话点击按钮只会表现为「一点反应都没有」，连错误文案都没有。
 */
const WORKSPACE_REQUEST_TIMEOUT_MS = 20_000;
const WORKSPACE_FILE_IMPORT_TIMEOUT_MS = 10 * 60_000;

function describeTimeoutFailure(base: string, timeoutMs: number): string {
  return '本机服务 ' + base + ' 在 ' + Math.round(timeoutMs / 1000) +
    ' 秒内没有响应：请求可能被浏览器代理拦截，或服务进程卡住。请确认服务运行后重试。';
}

export async function workspaceApi<T = any>(
  baseUrl: string,
  token: string,
  route: string,
  init: RequestInit = {},
  timeoutMs = WORKSPACE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const base = (baseUrl || 'http://127.0.0.1:8789').trim().replace(/\/+$/, '');
  const url = new URL(route, base + '/');
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', 'Bearer ' + token);
  // 调用方自带 signal 时以它为准，但仍叠加本服务的超时，避免任何调用点无限等待。
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  // status 0 表示传输层失败（没有 HTTP 响应），不会和 404/401 这些真实状态码混淆。
  let response: Response;
  try {
    response = await fetch(url.toString(), { ...init, headers, signal: controller.signal })
      .catch((error: unknown) => {
        throw new WorkspaceApiError(timedOut ? describeTimeoutFailure(base, timeoutMs) : describeNetworkFailure(base, error), 0);
      });
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new WorkspaceApiError(describeWorkspaceFailure(payload, response.status), response.status);
  return payload as T;
}

export async function importWorkspaceTranslations(
  baseUrl: string,
  token: string,
  projectId: string,
  translations: Map<string, string> | Array<{ id: string; text: string }>,
): Promise<void> {
  const rows = translations instanceof Map
    ? Array.from(translations, ([id, text]) => ({ id, text }))
    : translations;
  // 分批导入已采纳译文，避免一次请求复制整本书的译文数组；/api/documents/* 的 JSON 上限为 100 MiB。
  for (let offset = 0; offset < rows.length; offset += 200) {
    await workspaceApi(baseUrl, token, '/api/documents/projects/' + encodeURIComponent(projectId) + '/translations/import', {
      method: 'POST',
      body: JSON.stringify({ items: rows.slice(offset, offset + 200) }),
    });
  }
}

export async function loadWorkspaceAcceptedTranslations(
  baseUrl: string,
  token: string,
  projectId: string,
  segmentCount: number,
): Promise<Array<{ id: string; text: string }>> {
  const output: Array<{ id: string; text: string }> = [];
  for (let offset = 0; offset < segmentCount; offset += 1000) {
    const page = await workspaceApi<{ segments: Array<{ id: string; acceptedTranslation: string | null }> }>(
      baseUrl, token,
      '/api/documents/projects/' + encodeURIComponent(projectId) + '/segments?limit=1000&offset=' + offset,
    );
    for (const segment of page.segments || []) {
      if (typeof segment.acceptedTranslation === 'string' && segment.acceptedTranslation.trim()) {
        output.push({ id: segment.id, text: segment.acceptedTranslation });
      }
    }
  }
  return output;
}

/**
 * 将所选文档原件存入 workspace。二进制传输不经过 JSON 编码；文件名只作为元数据。
 */
export async function backupWorkspaceSourceFile(
  baseUrl: string,
  token: string,
  projectId: string,
  file: File | null,
): Promise<void> {
  if (!file) return;
  await workspaceApi(baseUrl, token, '/api/documents/projects/' + encodeURIComponent(projectId) + '/source-file', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Source-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
}
