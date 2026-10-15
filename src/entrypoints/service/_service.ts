export interface Glossary {
  /** 需保留原文的专有名词，由 glossaryExtractor 从页面正文自动抽取（用户无感）。 */
  document_terms?: string[];
}

/**
 * 模型/API 请求超时（毫秒）：fetch 无超时会无限"翻译中…"——网络层 stall 时
 * 转大声失败，走现有重试/警告链路。对齐本机服务 REQUEST_TIMEOUT。
 */
export const MODEL_FETCH_TIMEOUT_MS = 180_000;

/**
 * 严格 JSON Schema 响应格式（OpenAI json_schema 形状）。
 * 只用于本机 Agent 重试升级轮：--json-schema 约束解码，逼模型吐完整结构。
 * 远端 DeepSeek 不保证支持该形状，调用方只在本机路径传入。
 */
export interface JsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: unknown;
}

export interface GlossaryEntry {
  term: string;
  translation: string;
}

/** Optional metadata used only by the local-agent adapter to isolate a document's SDK Session. */
export interface TranslationSessionContext {
  documentSessionId?: string;
  /** Optional scope lane for the legacy /v1/chat/completions adapter; project-based document runs use their own run/role/batch scopes in translationAgent.ts. */
  sessionLane?: string;
  role: 'translation';
  sourceLang: string;
  targetLang: string;
  promptStyle?: string;
  translationMode?: string;
  contextVersion?: string;
  /** Optional full system prompt override, used only by document-reader requests. */
  systemPromptOverride?: string;
  /** Optional user-message template; {{CONTENT}} is replaced with the current batch JSON. */
  userPromptTemplate?: string;
  /** 独立只读的角色声音上下文，放入 user message 而非 system prompt。 */
  voiceContext?: unknown;
  /** 前文文本单独传递，避免把结构化的 contextPath/voiceContext 混成原文。 */
  precedingSegments?: Array<{ id: string; text: string; contextPath?: string }>;
}

export interface TranslationService {
  translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
    context?: string,
    /** 严格 schema（仅本机升级轮）；缺省沿用 json_object。 */
    responseFormat?: JsonSchemaResponseFormat,
    sessionContext?: TranslationSessionContext
  ): Promise<string>;

  translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
    context?: string
  ): AsyncGenerator<string, string, unknown>;
}
