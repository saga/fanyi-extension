export interface Glossary {
  /** 需保留原文的专有名词，由 glossaryExtractor 从页面正文自动抽取（用户无感）。 */
  document_terms?: string[];
}

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

export interface TranslationService {
  translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
    context?: string,
    /** 严格 schema（仅本机升级轮）；缺省沿用 json_object。 */
    responseFormat?: JsonSchemaResponseFormat
  ): Promise<string>;

  translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
    context?: string
  ): AsyncGenerator<string, string, unknown>;
}
