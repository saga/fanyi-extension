/**
 * 文档 workspace 的唯一客户端契约。
 *
 * 阅读页与“翻译 Agent”都使用这里的文档指纹、项目映射和 API 调用，避免两个 Tab
 * 因为各自生成 session ID 或 Prompt 快照而创建两份数据库、产生两套译文版本。
 */
import { storage } from '@wxt-dev/storage';

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

export async function rememberWorkspaceProject(input: WorkspaceProjectMappingInput, projectId: string): Promise<void> {
  const documentKey = workspaceDocumentKey(input);
  const exact = (await storage.getItem<ExactProjectMap>('local:documentAgentProjectMap')) || {};
  exact[documentKey] = projectId;
  await storage.setItem('local:documentAgentProjectMap', exact);
  const identities = (await storage.getItem<IdentityProjectMap>('local:documentAgentProjectIdentityMap')) || {};
  identities[workspaceSourceIdentityKey(input)] = { projectId, documentKey };
  await storage.setItem('local:documentAgentProjectIdentityMap', identities);
}

export async function workspaceApi<T = any>(
  baseUrl: string,
  token: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const base = (baseUrl || 'http://127.0.0.1:8789').trim().replace(/\/+$/, '');
  const url = new URL(route, base + '/');
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', 'Bearer ' + token);
  const response = await fetch(url.toString(), { ...init, headers });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(payload.error || ('本机服务返回 HTTP ' + response.status));
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
 * 将所选 EPUB/PDF 原件存入 workspace。二进制传输不经过 JSON 编码；文件名只作为元数据。
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
