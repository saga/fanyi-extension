export const TRANSLATION_ENGINES = {
  microsoft: '微软翻译',
  google: 'Google 翻译',
  deepl: 'DeepL',
} as const;

export const LANGUAGES = {
  auto: '自动检测',
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
} as const;

export const TRANSLATION_MODES = {
  bilingual: '双语对照',
  target: '仅译文',
} as const;

export const STORAGE_KEYS = {
  CONFIG: 'local:config',
  TRANSLATION_CACHE: 'local:translationCache',
} as const;
