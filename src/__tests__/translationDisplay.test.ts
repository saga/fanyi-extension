import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyBlockTranslation,
  restoreBlock,
  toggleBlockTranslation,
} from '../entrypoints/utils/translationDisplay';
import { logger } from '../utils/logger';

function createP(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

describe('applyBlockTranslation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('wraps original and translation in spans inside the original element', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界');

    expect(p.classList.contains('fanyi-translated')).toBe(true);
    expect(p.dataset.originalText).toBe('Hello world');

    const originalSpan = p.querySelector('.fanyi-original');
    const translationSpan = p.querySelector('.fanyi-translation');

    expect(originalSpan).not.toBeNull();
    expect(translationSpan).not.toBeNull();
    expect(originalSpan?.textContent).toBe('Hello world');
    expect(translationSpan?.textContent).toBe('你好世界');
  });

  it('skips if element is already translated', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界');

    const originalSpanCount = p.querySelectorAll('.fanyi-original').length;
    applyBlockTranslation(p, '第二次翻译');

    expect(p.querySelectorAll('.fanyi-original').length).toBe(originalSpanCount);
    expect(p.querySelector('.fanyi-translation')?.textContent).toBe('你好世界');
  });

  describe('mapping validation (suspect block-id misalignment)', () => {
    it('warns when a short title gets a long paragraph translation', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const p = createP(
        'AI financial advice is surprisingly good especially if you ask the right questions'
      );
      p.dataset.fanyiBlockId = 'b3';
      applyBlockTranslation(
        p,
        '人们越来越多地转向人工智能寻求财务建议。最近的一项研究发现，当被正确引导时，人工智能给出的建议质量出奇地高。研究还表明，提问的方式会显著影响回答的质量。'
      );

      expect(warn).toHaveBeenCalled();
      const allArgs = warn.mock.calls.flat().map(String).join(' | ');
      expect(allArgs).toMatch(/suspect mapping/);
      expect(allArgs).toContain('b3');
      // 校验不应阻断翻译：译文照常注入
      expect(p.querySelector('.fanyi-translation')?.textContent).toContain('人工智能');
      expect(p.dataset.fanyiMappingSuspect).toBeTruthy();
      warn.mockRestore();
    });

    it('does NOT warn on a normal title → short translation', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const p = createP('AI financial advice is surprisingly good');
      applyBlockTranslation(p, '人工智能理财建议出奇地好');

      const allArgs = warn.mock.calls.flat().map(String).join(' | ');
      expect(allArgs).not.toMatch(/suspect mapping/);
      expect(p.dataset.fanyiMappingSuspect).toBeUndefined();
      warn.mockRestore();
    });

    it('does NOT warn on a normal body → body translation', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const p = createP(
        'People are increasingly turning to AI for financial advice. A study found that the way questions are asked significantly affects answer quality.'
      );
      applyBlockTranslation(
        p,
        '人们越来越多地转向人工智能寻求财务建议。研究发现提问方式会显著影响回答质量。'
      );

      const allArgs = warn.mock.calls.flat().map(String).join(' | ');
      expect(allArgs).not.toMatch(/suspect mapping/);
      warn.mockRestore();
    });
  });

  describe('DOM preservation (regression for link/formatting breakage)', () => {
    it('preserves nested <a> links and keeps them clickable', () => {
      const p = document.createElement('p');
      p.innerHTML = 'Read <a href="https://example.com">this guide</a> please';
      const originalLink = p.querySelector('a')!;

      applyBlockTranslation(p, '请阅读本指南');

      // Original link must still exist and be the same element (preserved).
      const linkAfter = p.querySelector('.fanyi-original a');
      expect(linkAfter).not.toBeNull();
      expect(linkAfter).toBe(originalLink);
      expect(linkAfter?.getAttribute('href')).toBe('https://example.com');
      expect(linkAfter?.textContent).toBe('this guide');

      // Translation must live in its own span alongside.
      const translation = p.querySelector('.fanyi-translation');
      expect(translation?.textContent).toBe('请阅读本指南');
    });

  });
});

describe('restoreBlock', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('restores original text and removes spans', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界');
    restoreBlock(p);

    expect(p.textContent).toBe('Hello world');
    expect(p.classList.contains('fanyi-translated')).toBe(false);
    expect(p.querySelector('.fanyi-translation')).toBeNull();
    expect(p.querySelector('.fanyi-original')).toBeNull();
  });


  it('restores nested <a> links so they are clickable again', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Read <a href="https://example.com">this guide</a> please';

    applyBlockTranslation(p, '请阅读本指南');
    restoreBlock(p);

    // After restore, the <a> should be a direct child of <p> again.
    const link = p.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.textContent).toBe('this guide');
    expect(p.querySelector('.fanyi-original')).toBeNull();
    expect(p.querySelector('.fanyi-translation')).toBeNull();
  });

  it('restores nested children after restore', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Hello <strong>world</strong>';

    applyBlockTranslation(p, '你好世界');
    restoreBlock(p);

    expect(p.querySelector('strong')?.textContent).toBe('world');
    expect(p.children.length).toBe(1);
    expect(p.children[0].tagName).toBe('STRONG');
  });
});

describe('toggleBlockTranslation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('hides translation span when visible', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界');

    const translationSpan = p.querySelector('.fanyi-translation') as HTMLElement;
    expect(translationSpan.style.display).toBe('');

    toggleBlockTranslation(p);
    expect(translationSpan.style.display).toBe('none');
  });

});

