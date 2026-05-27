import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyBlockTranslation,
  restoreBlock,
  toggleBlockTranslation,
} from './translationDisplay';

function createP(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

describe('applyBlockTranslation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('bilingual mode', () => {
    it('wraps original and translation in spans inside the original element', () => {
      const p = createP('Hello world');
      applyBlockTranslation(p, '你好世界', 'bilingual');

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
      applyBlockTranslation(p, '你好世界', 'bilingual');

      const originalSpanCount = p.querySelectorAll('.fanyi-original').length;
      applyBlockTranslation(p, '第二次翻译', 'bilingual');

      expect(p.querySelectorAll('.fanyi-original').length).toBe(originalSpanCount);
      expect(p.querySelector('.fanyi-translation')?.textContent).toBe('你好世界');
    });
  });

  describe('target mode', () => {
    it('replaces text content with translation', () => {
      const p = createP('Hello world');
      applyBlockTranslation(p, '你好世界', 'target');

      expect(p.textContent).toBe('你好世界');
      expect(p.classList.contains('fanyi-translated')).toBe(true);
      expect(p.dataset.originalText).toBe('Hello world');
    });

    it('does not create spans in target mode', () => {
      const p = createP('Hello world');
      applyBlockTranslation(p, '你好世界', 'target');

      expect(p.querySelector('.fanyi-original')).toBeNull();
      expect(p.querySelector('.fanyi-translation')).toBeNull();
    });
  });
});

describe('restoreBlock', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('restores original text from dataset in bilingual mode', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界', 'bilingual');
    restoreBlock(p);

    expect(p.textContent).toBe('Hello world');
    expect(p.classList.contains('fanyi-translated')).toBe(false);
    expect(p.dataset.originalText).toBeUndefined();
  });

  it('restores original text from dataset in target mode', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界', 'target');
    restoreBlock(p);

    expect(p.textContent).toBe('Hello world');
    expect(p.classList.contains('fanyi-translated')).toBe(false);
  });

  it('handles element without originalText gracefully', () => {
    const p = createP('Hello world');
    p.classList.add('fanyi-translated');
    restoreBlock(p);

    expect(p.textContent).toBe('Hello world');
    expect(p.classList.contains('fanyi-translated')).toBe(false);
  });
});

describe('toggleBlockTranslation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('hides translation span when visible', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界', 'bilingual');

    const translationSpan = p.querySelector('.fanyi-translation') as HTMLElement;
    expect(translationSpan.style.display).toBe('');

    toggleBlockTranslation(p);
    expect(translationSpan.style.display).toBe('none');
  });

  it('shows translation span when hidden', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界', 'bilingual');

    const translationSpan = p.querySelector('.fanyi-translation') as HTMLElement;
    translationSpan.style.display = 'none';

    toggleBlockTranslation(p);
    expect(translationSpan.style.display).toBe('');
  });

  it('does nothing in target mode (no translation span)', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界', 'target');

    expect(() => toggleBlockTranslation(p)).not.toThrow();
  });
});

describe('full workflow', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('bilingual: apply → toggle → toggle → restore', () => {
    const p = createP('Hello world');
    document.body.appendChild(p);

    applyBlockTranslation(p, '你好世界', 'bilingual');
    expect(p.querySelector('.fanyi-translation')?.textContent).toBe('你好世界');

    toggleBlockTranslation(p);
    expect((p.querySelector('.fanyi-translation') as HTMLElement).style.display).toBe('none');

    toggleBlockTranslation(p);
    expect((p.querySelector('.fanyi-translation') as HTMLElement).style.display).toBe('');

    restoreBlock(p);
    expect(p.textContent).toBe('Hello world');
    expect(p.querySelector('.fanyi-translation')).toBeNull();
  });

  it('target: apply → restore', () => {
    const p = createP('Hello world');
    document.body.appendChild(p);

    applyBlockTranslation(p, '你好世界', 'target');
    expect(p.textContent).toBe('你好世界');

    restoreBlock(p);
    expect(p.textContent).toBe('Hello world');
  });

  it('preserves element tag and inherits original styling', () => {
    const h2 = document.createElement('h2');
    h2.textContent = 'Section Title';
    document.body.appendChild(h2);

    applyBlockTranslation(h2, '章节标题', 'bilingual');
    expect(h2.tagName).toBe('H2');

    const originalSpan = h2.querySelector('.fanyi-original');
    const translationSpan = h2.querySelector('.fanyi-translation');
    expect(originalSpan?.textContent).toBe('Section Title');
    expect(translationSpan?.textContent).toBe('章节标题');

    restoreBlock(h2);
    expect(h2.textContent).toBe('Section Title');
  });
});
