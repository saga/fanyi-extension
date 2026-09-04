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

  it('buildChatSystem handles null context', () => {
    const s = buildChatSystem(null);
    expect(s).toContain('没有可用的网页内容');
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

  it('chatStream throws on HTTP error with status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"invalid key"}}',
    }) as unknown as typeof fetch;

    await expect(
      (async () => {
        for await (const _ of chatStream('k', [{ role: 'user', content: 'q' }])) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/401/);
  });

  it('chat returns full content (non-stream)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSSE(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']),
      // chat() 解析的是整段响应文本（JSON），不是 SSE 流
      text: async () => '{"choices":[{"message":{"content":"final answer"}}]}',
    }) as unknown as typeof fetch;

    const result = await chat('k', [{ role: 'user', content: 'q' }]);
    expect(result).toBe('final answer');
  });
});
