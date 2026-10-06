import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatStream, chat, buildChatSystem } from '../entrypoints/service/chat';
import type { PageContext } from '../types/messages';

const fakeContext: PageContext = {
  title: 'Test Page',
  url: 'https://example.com/article',
  text: 'hello world from the page',
};

function makeSSE(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

describe('chat service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildChatSystem embeds page title / url / text', () => {
    const s = buildChatSystem(fakeContext);
    expect(s).toContain('Test Page');
    expect(s).toContain('https://example.com/article');
    expect(s).toContain('hello world from the page');
  });


  it('chatStream yields incremental full text from SSE', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSSE(sse),
      text: async () => '',
    }) as unknown as typeof fetch;

    const out: string[] = [];
    for await (const partial of chatStream('k', [
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
    ])) {
      out.push(partial);
    }
    expect(out).toEqual(['Hi', 'Hi there']);
  });


});
