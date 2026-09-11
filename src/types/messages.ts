/**
 * 消息层类型定义
 *
 * fanyi-extension 在 content script / background / popup 之间通过
 * `browser.runtime.sendMessage` 和 `browser.tabs.sendMessage` 通信。
 * 历史上消息 payload 都是 `any`，导致：
 *   - 改字段时调用方不会报错
 *   - response 字段访问需要 `as any` 后再取
 *   - IDE 无法补全
 *
 * 本文件把所有消息按 `action` 字段做成 discriminated union，
 * 替换 22 处 `any`，让 TypeScript 在编译期就拒绝错误的消息形状。
 *
 * 协议分两类：
 *   1. BackgroundMessage  —— 发给 background（content script / popup 是发送方）
 *   2. ContentMessage     —— 发给 content script（background 是发送方）
 *
 * 每条请求对应一个 *Response 类型，作为 sendMessage 的返回值类型。
 */

import type browser from 'webextension-polyfill';
import type { Config } from '../entrypoints/utils/config';
import type { Glossary } from '../entrypoints/service/_service';
import type { PromptStyle } from '../entrypoints/service/deepseek';

// ============================================================
// 公共子类型
// ============================================================

/**
 * 单 chunk 翻译出参里附带的诊断包。
 * 当模型 missing 时，background 会把这份 trace 塞进响应，
 * 让 content script 不必翻 background console 就能定位根因。
 */
export interface ChunkTrace {
  inputBytes: number;
  estInputTokens: number;
  reservedMaxTokens: number;
  outputBytes: number;
  outputBlocks: number;
  outputIds: string[];
  outputPreview: string;
  missingInResponse: string[];
  jsonParseFailed: boolean;
  outputTail: string;
  parseError: string;
}

/** 错误响应里附带的调试信息，便于 content script 在状态条上展示 stack。 */
export interface DebugInfo {
  name: string;
  message?: string;
  stack?: string | null;
}

/** 翻译结果条目：[blockId, translatedText] */
export type TranslationEntry = [string, string];

// ============================================================
// Background-bound messages (content script → background)
// ============================================================

export interface TranslateChunkMessage {
  action: 'translateChunk';
  jsonContent: string;
  sourceLang: string;
  targetLang: string;
  cacheKey?: string;
  pageUrl?: string;
  glossary?: Glossary;
  /**
   * 已解析的文风（页级语言检测后的结果）。
   * 缺省时 background 回退到 config.promptStyle —— 兼容旧调用方与
   * 无页面上下文的调用点（如按 key 校验）。见 content/translation.ts。
   */
  promptStyle?: PromptStyle;
}

export interface TranslateChunkStreamMessage {
  action: 'translateChunkStream';
  jsonContent: string;
  sourceLang: string;
  targetLang: string;
  pageUrl?: string;
  glossary?: Glossary;
  /** background 把流式 partial 发回哪个 tab；缺省时用 sender.tab.id */
  tabId?: number;
  /** 已解析的文风；缺省时回退 config.promptStyle */
  promptStyle?: PromptStyle;
}

export interface ValidateApiKeyMessage {
  action: 'validateApiKey';
  apiKey: string;
}

export interface ClearCacheMessage {
  action: 'clearCache';
}

export interface CheckConfigMessage {
  action: 'checkConfig';
}

export interface GetPageContextMessage {
  action: 'getPageContext';
  /** 可选：显式指定要读取的标签页（从 popup / 右键菜单跳转到对话 tab 时带上） */
  sourceTabId?: number;
}

/**
 * 消息中枢：popup / side panel 把"要发给 content script 的消息"统一交给
 * background 转发，集中控制失败处理（无 content script 时的友好错误）。
 */
export interface RelayToContentMessage {
  action: 'relayToContent';
  tabId: number;
  message: ContentMessage;
}

/** 发往 background 的所有消息类型。 */
export type BackgroundMessage =
  | TranslateChunkMessage
  | TranslateChunkStreamMessage
  | ValidateApiKeyMessage
  | ClearCacheMessage
  | CheckConfigMessage
  | GetPageContextMessage
  | RelayToContentMessage;

// ============================================================
// Content-script-bound messages (background → content script)
// ============================================================

export interface TranslatePageMessage {
  action: 'translatePage';
}

export interface RestoreOriginalMessage {
  action: 'restoreOriginal';
}

export interface ToggleTranslationMessage {
  action: 'toggleTranslation';
}

export interface TranslationStreamUpdateMessage {
  action: 'translationStreamUpdate';
  partial: string;
}

export interface ExtractChatContextMessage {
  action: 'extractChatContext';
}

/** 发往 content script 的所有消息类型。 */
export type ContentMessage =
  | TranslatePageMessage
  | RestoreOriginalMessage
  | ToggleTranslationMessage
  | TranslationStreamUpdateMessage
  | ExtractChatContextMessage;

// ============================================================
// Responses
// ============================================================

// --- translateChunk ---

export interface TranslateChunkSuccessResponse {
  success: true;
  result: TranslationEntry[];
  trace?: ChunkTrace;
}

export interface TranslateChunkErrorResponse {
  success: false;
  error: string;
  debugInfo?: DebugInfo | null;
}

export type TranslateChunkResponse =
  | TranslateChunkSuccessResponse
  | TranslateChunkErrorResponse;

// --- translateChunkStream ---

export interface TranslateChunkStreamSuccessResponse {
  success: true;
  result: TranslationEntry[];
}

export interface TranslateChunkStreamErrorResponse {
  success: false;
  error: string;
}

export type TranslateChunkStreamResponse =
  | TranslateChunkStreamSuccessResponse
  | TranslateChunkStreamErrorResponse;

// --- validateApiKey ---

export interface ValidateApiKeySuccessResponse {
  success: true;
}

export interface ValidateApiKeyErrorResponse {
  success: false;
  error: string;
  debugInfo?: DebugInfo | null;
}

export type ValidateApiKeyResponse =
  | ValidateApiKeySuccessResponse
  | ValidateApiKeyErrorResponse;

// --- clearCache ---

export interface ClearCacheSuccessResponse {
  success: true;
}

export interface ClearCacheErrorResponse {
  success: false;
  error: string;
}

export type ClearCacheResponse =
  | ClearCacheSuccessResponse
  | ClearCacheErrorResponse;

// --- checkConfig ---

export interface CheckConfigSuccessResponse {
  success: true;
  config: Config;
}

export interface CheckConfigErrorResponse {
  success: false;
  error: string;
}

export type CheckConfigResponse =
  | CheckConfigSuccessResponse
  | CheckConfigErrorResponse;

// --- getPageContext ---

/** 从当前页面提取出的、喂给对话模型的上下文。 */
export interface PageContext {
  title: string;
  url: string;
  text: string;
}

export interface GetPageContextSuccessResponse {
  success: true;
  context: PageContext;
}

export interface GetPageContextErrorResponse {
  success: false;
  error: string;
}

export type GetPageContextResponse =
  | GetPageContextSuccessResponse
  | GetPageContextErrorResponse;

// --- relayToContent ---

export interface RelayToContentSuccessResponse {
  success: true;
  response: unknown;
}

export interface RelayToContentErrorResponse {
  success: false;
  error: string;
}

export type RelayToContentResponse =
  | RelayToContentSuccessResponse
  | RelayToContentErrorResponse;

/**
 * 所有 background 响应的合集，作为运行时收包的兜底类型。
 * 业务代码应当按 action 窄化到具体的 Response 类型。
 */
export type BackgroundResponse =
  | TranslateChunkResponse
  | TranslateChunkStreamResponse
  | ValidateApiKeyResponse
  | ClearCacheResponse
  | CheckConfigResponse
  | GetPageContextResponse
  | RelayToContentResponse;

// ============================================================
// Listener 签名（替换 onMessage.addListener 的 `any` 入参）
// ============================================================

/**
 * background 端 onMessage listener 的入参签名。
 *
 * 注意：`message` 必须是 `BackgroundMessage` 的超集（运行时可能收到未知 action），
 * 所以这里用 `BackgroundMessage | { action: string }` 而不是直接 union，
 * 让 switch case 上的字面量比较仍然能触发 exhaustive check 提示。
 */
export type BackgroundMessageListener = (
  message: BackgroundMessage | { action: string },
  sender: browser.Runtime.MessageSender,
  sendResponse: (response: BackgroundResponse) => void,
) => boolean | void;

/**
 * content script 端 onMessage listener 的入参签名。
 *
 * 同上，`message` 是 `ContentMessage | { action: string }`。
 */
export type ContentMessageListener = (
  message: ContentMessage | { action: string },
) => void | Promise<unknown>;
