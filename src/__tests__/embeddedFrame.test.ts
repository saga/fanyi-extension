import { afterEach, describe, expect, it } from 'vitest';
import { hasContentIframe } from '../entrypoints/utils/embeddedFrame';

function setHtml(html: string, size: { width: number; height: number } | null = { width: 1440, height: 900 }): void {
  document.body.innerHTML = html;
  Object.defineProperty(document.documentElement, 'clientWidth', { value: 1440, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: 900, configurable: true });
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    (frame as HTMLElement).getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size?.width ?? 0,
      bottom: size?.height ?? 0,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      toJSON: () => ({}),
    });
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('hasContentIframe', () => {
  it('detects a large remote iframe holding the real article', () => {
    setHtml('<iframe src="https://dlouapre-looped-transformers.hf.space/?__theme=system"></iframe>');
    expect(hasContentIframe(document)).toBe(true);
  });

  it('ignores 1px payment/analytics iframes', () => {
    setHtml('<iframe src="https://js.stripe.com/v3/m-outer.html"></iframe>', { width: 1440, height: 1 });
    expect(hasContentIframe(document)).toBe(false);
  });

  it('ignores hidden iframes', () => {
    setHtml('<iframe style="display:none" src="https://example.org/article"></iframe>');
    expect(hasContentIframe(document)).toBe(false);
  });

  it('ignores tracker hosts even when large', () => {
    setHtml('<iframe src="https://www.googleadservices.com/pagead/aclk"></iframe>');
    expect(hasContentIframe(document)).toBe(false);
  });

  it('resolves relative iframe src against the document base', () => {
    setHtml('<iframe src="/space/app"></iframe>');
    expect(hasContentIframe(document)).toBe(true);
  });
});
