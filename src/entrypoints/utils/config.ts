import { storage } from '@wxt-dev/storage';
import type { PromptStyle, TranslationMode } from '../service/deepseek';

export interface ShortcutConfig {
  translatePage: string;
  translateSelection: string;
  restoreOriginal: string;
  toggleTranslation: string;
}

export type Provider = 'deepseek' | 'cloudflare' | 'openrouter' | 'nvidia' | 'gemini' | 'opencode';
export type LocalAgentProvider = 'workbuddy' | 'opencode';
export type DocumentCodeBuddyTaskKey = 'translation' | 'accuracyReview' | 'styleReview' | 'literaryAnalysis' | 'contextGraph';
export type DocumentCodeBuddyThinkingMode = 'disabled' | 'adaptive' | 'enabled';
export type DocumentCodeBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface DocumentCodeBuddyTaskProfile {
  /** Empty means inherit the local Agent's project/provider model. */
  model: string;
  fallbackModel: string;
  thinkingMode: DocumentCodeBuddyThinkingMode;
  thinkingBudgetTokens: number;
  effort: DocumentCodeBuddyEffort;
  /** Supplemental instructions; built-in task contracts are retained. */
  systemPromptAppendix: string;
  /** Optional task-specific wrapper. {{CONTENT}} receives the built-in task input. */
  userPromptTemplate: string;
}
export type DocumentCodeBuddyTaskProfiles = Record<DocumentCodeBuddyTaskKey, DocumentCodeBuddyTaskProfile>;

export interface Config {
  sourceLang: string;
  targetLang: string;
  deepseekApiKey: string;
  /** 远程服务翻译使用的 LLM Provider；本机 Agent 模式改用 localAgentProvider。 */
  provider: Provider;
  /**
   * 翻译文风：default=通用直译, jinyong=金庸武侠, acheng=阿城白描,
   * wangxiaobo=王小波大白话, ja-source-natural=日语原文汉译（源语言感知，仅日译中）。
   * 选 default 时，若页级检测判定源语言为日语且目标语言非日语，
   * 会自动升级为 ja-source-natural（见 utils/languageDetector）。
   */
  promptStyle: PromptStyle;
  /** 独立翻译目标：technical 精确技术翻译；literary 文学表达与实体一致性。 */
  translationMode: TranslationMode;
  floatingBallPosition?: { x: number; y: number };
  shortcuts: ShortcutConfig;
  /** 是否使用服务端翻译（发送到 /fanyi/page） */
  useServerTranslation: boolean;
  /** 服务端翻译地址，留空时使用默认地址 */
  serverUrl: string;
  /** 直接把翻译请求交给本机的 Workbuddy/OpenCode Provider。启用后优先于远程服务设置。 */
  useLocalAgent: boolean;
  localAgentProvider: LocalAgentProvider;
  /** 本机服务根地址，不包含 /v1/chat/completions。 */
  localAgentUrl: string;
  /** 可选模型覆盖；auto 表示使用本机服务的环境配置。 */
  localAgentModel: string;
  /** 可选共享令牌；本机服务未配置 LOCAL_AGENT_TOKEN 时留空即可。 */
  localAgentToken: string;

  /**
   * 文档翻译专用配置，与网页页面/选区翻译隔离。
   * 未显式设置过的字段会临时继承旧的全局值；首次修改文档设置时会保存独立配置。
   */
  documentSourceLang: string;
  documentTargetLang: string;
  documentDeepseekApiKey: string;
  documentProvider: Provider;
  documentPromptStyle: PromptStyle;
  documentTranslationMode: TranslationMode;
  documentUseServerTranslation: boolean;
  documentServerUrl: string;
  documentUseLocalAgent: boolean;
  /** Automatically select the document-local Agent when health checks succeed; a manual opt-out disables this. */
  documentAutoSelectLocalAgent: boolean;
  documentLocalAgentProvider: LocalAgentProvider;
  documentLocalAgentUrl: string;
  documentLocalAgentModel: string;
  documentLocalAgentToken: string;
  /** Separate CodeBuddy reasoning/prompt profile for each local document task. */
  documentCodeBuddyTaskProfiles: DocumentCodeBuddyTaskProfiles;

  /** Local Agent document translation strategy; all limits are validated again by the service. */
  documentBatchMaxSegments: number;
  documentBatchMaxSourceChars: number;
  documentTranslationConcurrency: number;
  documentReviewConcurrency: number;
  documentPrecedingContextSegments: number;
  documentContextBudgetChars: number;
  documentMaxModelAttempts: number;
  documentLiteraryReviewEnabled: boolean;

  /** Document reader typography; English and Chinese can be adjusted independently. */
  documentEnglishFontFamily: string;
  documentChineseFontFamily: string;
  documentEnglishFontSize: number;
  documentChineseFontSize: number;
  /** Empty means use the generated built-in prompt; non-empty replaces it for document translation. */
  documentSystemPromptOverride: string;
  /** Empty means use the built-in user-message wrapper; {{CONTENT}} receives this batch's JSON. */
  documentUserPromptTemplate: string;
}

export const DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES: DocumentCodeBuddyTaskProfiles = {
  translation: {
    model: '', fallbackModel: '', thinkingMode: 'disabled', thinkingBudgetTokens: 8192, effort: 'low',
    systemPromptAppendix: '', userPromptTemplate: '',
  },
  accuracyReview: {
    model: '', fallbackModel: '', thinkingMode: 'adaptive', thinkingBudgetTokens: 8192, effort: 'medium',
    systemPromptAppendix: '', userPromptTemplate: '',
  },
  styleReview: {
    model: '', fallbackModel: '', thinkingMode: 'adaptive', thinkingBudgetTokens: 8192, effort: 'high',
    systemPromptAppendix: '', userPromptTemplate: '',
  },
  literaryAnalysis: {
    model: '', fallbackModel: '', thinkingMode: 'adaptive', thinkingBudgetTokens: 8192, effort: 'high',
    systemPromptAppendix: '', userPromptTemplate: '',
  },
  contextGraph: {
    model: '', fallbackModel: '', thinkingMode: 'adaptive', thinkingBudgetTokens: 8192, effort: 'high',
    systemPromptAppendix: '', userPromptTemplate: '',
  },
};

function normalizeDocumentCodeBuddyTaskProfiles(input: unknown): DocumentCodeBuddyTaskProfiles {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, any> : {};
  const result = {} as DocumentCodeBuddyTaskProfiles;
  for (const task of Object.keys(DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES) as DocumentCodeBuddyTaskKey[]) {
    const value = raw[task] && typeof raw[task] === 'object' && !Array.isArray(raw[task]) ? raw[task] : {};
    const defaults = DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES[task];
    const thinkingMode = ['disabled', 'adaptive', 'enabled'].includes(value.thinkingMode)
      ? value.thinkingMode as DocumentCodeBuddyThinkingMode : defaults.thinkingMode;
    const effort = ['low', 'medium', 'high', 'xhigh'].includes(value.effort)
      ? value.effort as DocumentCodeBuddyEffort : defaults.effort;
    const rawBudget = Number(value.thinkingBudgetTokens ?? defaults.thinkingBudgetTokens);
    const model = typeof value.model === 'string' ? value.model.trim().slice(0, 200) : defaults.model;
    const fallbackModel = typeof value.fallbackModel === 'string' ? value.fallbackModel.trim().slice(0, 200) : defaults.fallbackModel;
    result[task] = {
      model: model.toLowerCase() === 'auto' ? '' : model,
      fallbackModel: fallbackModel.toLowerCase() === 'auto' ? '' : fallbackModel,
      thinkingMode,
      thinkingBudgetTokens: Number.isFinite(rawBudget) ? Math.max(1024, Math.min(65536, Math.round(rawBudget))) : defaults.thinkingBudgetTokens,
      effort,
      systemPromptAppendix: typeof value.systemPromptAppendix === 'string' ? value.systemPromptAppendix.slice(0, 12000) : defaults.systemPromptAppendix,
      userPromptTemplate: typeof value.userPromptTemplate === 'string' ? value.userPromptTemplate.slice(0, 30000) : defaults.userPromptTemplate,
    };
  }
  return result;
}

const defaultConfig: Config = {
  sourceLang: 'auto',
  targetLang: 'zh',
  deepseekApiKey: '',
  provider: 'deepseek',
  promptStyle: 'default',
  translationMode: 'technical',
  shortcuts: {
    translatePage: 'Alt+T',
    translateSelection: 'Alt+S',
    restoreOriginal: 'Alt+R',
    toggleTranslation: 'Alt+V',
  },
  useServerTranslation: false,
  serverUrl: 'https://s.sunxiunan.com/fanyi/page',
  useLocalAgent: false,
  localAgentProvider: 'workbuddy',
  localAgentUrl: 'http://127.0.0.1:8789',
  localAgentModel: 'auto',
  localAgentToken: '',

  // getConfig() inherits legacy values until these document-specific fields are persisted.
  documentSourceLang: 'auto',
  documentTargetLang: 'zh',
  documentDeepseekApiKey: '',
  documentProvider: 'deepseek',
  documentPromptStyle: 'default',
  documentTranslationMode: 'technical',
  documentUseServerTranslation: false,
  documentServerUrl: 'https://s.sunxiunan.com/fanyi/page',
  documentUseLocalAgent: false,
  documentAutoSelectLocalAgent: true,
  documentLocalAgentProvider: 'workbuddy',
  documentLocalAgentUrl: 'http://127.0.0.1:8789',
  documentLocalAgentModel: 'auto',
  documentLocalAgentToken: '',
  documentCodeBuddyTaskProfiles: DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES,

  documentBatchMaxSegments: 16,
  documentBatchMaxSourceChars: 8000,
  documentTranslationConcurrency: 4,
  documentReviewConcurrency: 2,
  documentPrecedingContextSegments: 4,
  documentContextBudgetChars: 18000,
  documentMaxModelAttempts: 2,
  documentLiteraryReviewEnabled: true,

  documentEnglishFontFamily: 'Georgia',
  documentChineseFontFamily: 'Noto Serif CJK SC',
  documentEnglishFontSize: 17,
  documentChineseFontSize: 18,
  documentSystemPromptOverride: '',
  documentUserPromptTemplate: '',
};

const documentConfigFallbacks = {
  documentSourceLang: 'sourceLang',
  documentTargetLang: 'targetLang',
  documentDeepseekApiKey: 'deepseekApiKey',
  documentProvider: 'provider',
  documentPromptStyle: 'promptStyle',
  documentTranslationMode: 'translationMode',
  documentUseServerTranslation: 'useServerTranslation',
  documentServerUrl: 'serverUrl',
  documentUseLocalAgent: 'useLocalAgent',
  documentLocalAgentProvider: 'localAgentProvider',
  documentLocalAgentUrl: 'localAgentUrl',
  documentLocalAgentModel: 'localAgentModel',
  documentLocalAgentToken: 'localAgentToken',
} as const;

/**
 * Migrate legacy installs exactly once: copy the current global translation profile into
 * document-specific keys before either profile can be edited independently.
 */
export async function getConfig(): Promise<Config> {
  const stored = (await storage.getItem<Partial<Config>>('local:config')) || {};
  const merged: Config = { ...defaultConfig, ...stored };
  const migrated: Partial<Config> = {};
  for (const [documentKey, globalKey] of Object.entries(documentConfigFallbacks) as Array<[keyof typeof documentConfigFallbacks, (typeof documentConfigFallbacks)[keyof typeof documentConfigFallbacks]]>) {
    if (!Object.prototype.hasOwnProperty.call(stored, documentKey)) {
      const value = (stored as any)[globalKey] ?? (defaultConfig as any)[globalKey];
      (merged as any)[documentKey] = value;
      (migrated as any)[documentKey] = value;
    }
  }
  if (Object.keys(migrated).length) {
    // Write directly to storage; do not call setConfig() here and recurse back into getConfig().
    await storage.setItem('local:config', JSON.parse(JSON.stringify({ ...stored, ...migrated })));
  }
  merged.translationMode = merged.translationMode === 'literary' ? 'literary' : 'technical';
  merged.documentTranslationMode = merged.documentTranslationMode === 'literary' ? 'literary' : 'technical';
  merged.documentCodeBuddyTaskProfiles = normalizeDocumentCodeBuddyTaskProfiles(merged.documentCodeBuddyTaskProfiles);
  return merged;
}

/** Save a patch on top of the current profile after the one-time document-profile migration. */
export async function setConfig(config: Partial<Config>): Promise<void> {
  const currentConfig = await getConfig();
  // Preserve unspecified subfields when a caller patches one task profile only.
  const incomingProfiles = config.documentCodeBuddyTaskProfiles;
  const mergedProfiles = incomingProfiles
    ? normalizeDocumentCodeBuddyTaskProfiles(Object.fromEntries(
        (Object.keys(DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES) as DocumentCodeBuddyTaskKey[]).map((task) => [
          task,
          { ...currentConfig.documentCodeBuddyTaskProfiles[task], ...(incomingProfiles as any)[task] },
        ]),
      ))
    : currentConfig.documentCodeBuddyTaskProfiles;
  // Use JSON serialization to strip Proxy/reactive wrappers from Vue refs.
  const cleanConfig = JSON.parse(JSON.stringify({
    ...currentConfig, ...config, documentCodeBuddyTaskProfiles: mergedProfiles,
  }));
  await storage.setItem('local:config', cleanConfig);
}

export async function resetConfig(): Promise<void> {
  await storage.setItem('local:config', defaultConfig);
}

export async function hasApiKey(): Promise<boolean> {
  const config = await getConfig();
  return !!config.deepseekApiKey;
}
