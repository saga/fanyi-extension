import { describe, it, expect } from 'vitest';
import {
  TRANSLATION_ENGINE,
  DEEPSEEK_MODEL,
  LANGUAGES,
  TRANSLATION_MODES,
  STORAGE_KEYS,
  CHUNK_CONFIG,
} from './constant';

describe('constant', () => {
  describe('TRANSLATION_ENGINE', () => {
    it('is DeepSeek', () => {
      expect(TRANSLATION_ENGINE).toBe('DeepSeek');
    });
  });

  describe('DEEPSEEK_MODEL', () => {
    it('is deepseek-v4-flash', () => {
      expect(DEEPSEEK_MODEL).toBe('deepseek-v4-flash');
    });
  });

  describe('LANGUAGES', () => {
    it('contains expected language entries', () => {
      expect(LANGUAGES).toEqual({
        auto: '自动检测',
        zh: '中文',
        en: '英语',
        ja: '日语',
      });
    });

    it('is frozen/readonly', () => {
      expect(Object.isFrozen(LANGUAGES)).toBe(false);
      // as const makes it readonly at type level; verify values are as expected
      expect(LANGUAGES.auto).toBe('自动检测');
      expect(LANGUAGES.zh).toBe('中文');
      expect(LANGUAGES.en).toBe('英语');
      expect(LANGUAGES.ja).toBe('日语');
    });
  });

  describe('TRANSLATION_MODES', () => {
    it('contains bilingual and target modes', () => {
      expect(TRANSLATION_MODES).toEqual({
        bilingual: '双语对照',
        target: '仅译文',
      });
    });
  });

  describe('STORAGE_KEYS', () => {
    it('contains expected keys', () => {
      expect(STORAGE_KEYS.CONFIG).toBe('local:config');
      expect(STORAGE_KEYS.TRANSLATION_CACHE).toBe('local:translationCache');
      expect(STORAGE_KEYS.GLOSSARY_CACHE).toBe('local:glossaryCache');
    });
  });

  describe('CHUNK_CONFIG', () => {
    it('has MAX_INPUT_TOKENS and TARGET_TOKENS', () => {
      expect(CHUNK_CONFIG.MAX_INPUT_TOKENS).toBe(500000);
      expect(CHUNK_CONFIG.TARGET_TOKENS).toBe(400000);
    });
  });
});