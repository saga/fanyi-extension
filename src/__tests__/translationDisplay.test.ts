import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyBlockTranslation,
  restoreBlock,
  toggleBlockTranslation,
} from '../entrypoints/utils/translationDisplay';

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

    it('preserves <strong>, <em>, <code> children', () => {
      const p = document.createElement('p');
      p.innerHTML = 'Click <strong>here</strong> or <em>there</em> for <code>code</code>';

      applyBlockTranslation(p, '点此或那里看代码');

      const original = p.querySelector('.fanyi-original')!;
      expect(original.querySelector('strong')?.textContent).toBe('here');
      expect(original.querySelector('em')?.textContent).toBe('there');
      expect(original.querySelector('code')?.textContent).toBe('code');
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

  it('handles element without originalText gracefully', () => {
    const p = createP('Hello world');
    p.classList.add('fanyi-translated');
    restoreBlock(p);

    expect(p.textContent).toBe('Hello world');
    expect(p.classList.contains('fanyi-translated')).toBe(false);
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

  it('shows translation span when hidden', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界');

    const translationSpan = p.querySelector('.fanyi-translation') as HTMLElement;
    translationSpan.style.display = 'none';

    toggleBlockTranslation(p);
    expect(translationSpan.style.display).toBe('');
  });
});

describe('full workflow', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('apply → toggle → toggle → restore', () => {
    const p = createP('Hello world');
    document.body.appendChild(p);

    applyBlockTranslation(p, '你好世界');
    expect(p.querySelector('.fanyi-translation')?.textContent).toBe('你好世界');

    toggleBlockTranslation(p);
    expect((p.querySelector('.fanyi-translation') as HTMLElement).style.display).toBe('none');

    toggleBlockTranslation(p);
    expect((p.querySelector('.fanyi-translation') as HTMLElement).style.display).toBe('');

    restoreBlock(p);
    expect(p.textContent).toBe('Hello world');
    expect(p.querySelector('.fanyi-translation')).toBeNull();
  });

  it('preserves element tag and inherits original styling', () => {
    const h2 = document.createElement('h2');
    h2.textContent = 'Section Title';
    document.body.appendChild(h2);

    applyBlockTranslation(h2, '章节标题');
    expect(h2.tagName).toBe('H2');

    const originalSpan = h2.querySelector('.fanyi-original');
    const translationSpan = h2.querySelector('.fanyi-translation');
    expect(originalSpan?.textContent).toBe('Section Title');
    expect(translationSpan?.textContent).toBe('章节标题');

    restoreBlock(h2);
    expect(h2.textContent).toBe('Section Title');
  });
});
