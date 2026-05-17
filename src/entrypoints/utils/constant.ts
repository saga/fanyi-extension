export const TRANSLATION_ENGINE = 'DeepSeek';
export const DEEPSEEK_MODEL = 'deepseek-v4-flash';

export const LANGUAGES = {
  auto: '自动检测',
  zh: '中文',
  en: '英语',
  ja: '日语',
} as const;

export const TRANSLATION_MODES = {
  bilingual: '双语对照',
  target: '仅译文',
} as const;

export const STORAGE_KEYS = {
  CONFIG: 'local:config',
  TRANSLATION_CACHE: 'local:translationCache',
  GLOSSARY_CACHE: 'local:glossaryCache',
} as const;

export const CHUNK_CONFIG = {
  MAX_INPUT_TOKENS: 500000,
  TARGET_TOKENS: 400000,
} as const;
