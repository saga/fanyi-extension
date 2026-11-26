import { describe, expect, it } from 'vitest';
import { createChatHistoryKey } from '../entrypoints/sidepanel/chatHistory';

describe('webpage chat history key', () => {
  it('isolates different pages in the same tab', () => {
    expect(createChatHistoryKey(7, 'https://example.com/a'))
      .not.toBe(createChatHistoryKey(7, 'https://example.com/b'));
  });

  it('isolates tabs even when they show the same page', () => {
    expect(createChatHistoryKey(7, 'https://example.com/a'))
      .not.toBe(createChatHistoryKey(8, 'https://example.com/a'));
  });

  it('ignores fragments but retains query parameters', () => {
    expect(createChatHistoryKey(7, 'https://example.com/a#section'))
      .toBe(createChatHistoryKey(7, 'https://example.com/a'));
    expect(createChatHistoryKey(7, 'https://example.com/a?mode=1'))
      .not.toBe(createChatHistoryKey(7, 'https://example.com/a?mode=2'));
  });

  it('does not expose the source URL in the storage key', () => {
    expect(createChatHistoryKey(7, 'https://example.com/private?token=secret'))
      .not.toContain('secret');
  });
});
