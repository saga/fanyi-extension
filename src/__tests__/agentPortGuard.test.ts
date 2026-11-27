import { describe, expect, it } from 'vitest';
import { isSidepanelPortUrl } from '../entrypoints/utils/agentPortGuard';

describe('privileged runtime port guard', () => {
  const sidepanel = 'moz-extension://example-id/sidepanel.html';

  it('allows only the extension sidepanel document, independent of query parameters', () => {
    expect(isSidepanelPortUrl('moz-extension://example-id/sidepanel.html?sourceTabId=12', sidepanel)).toBe(true);
    expect(isSidepanelPortUrl('moz-extension://example-id/sidepanel.html', sidepanel)).toBe(true);
  });

  it('rejects website content scripts and other extension pages', () => {
    expect(isSidepanelPortUrl('https://example.com/article', sidepanel)).toBe(false);
    expect(isSidepanelPortUrl('moz-extension://example-id/popup.html', sidepanel)).toBe(false);
    expect(isSidepanelPortUrl('moz-extension://other-id/sidepanel.html', sidepanel)).toBe(false);
    expect(isSidepanelPortUrl(undefined, sidepanel)).toBe(false);
  });
});
