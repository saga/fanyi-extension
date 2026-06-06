import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekTranslationService } from '../entrypoints/service/deepseek';

// Mock global fetch
const globalFetch = vi.fn();
Object.defineProperty(globalThis, 'fetch', { value: globalFetch, writable: true });

function createJsonResponse(json: unknown, status = 200) {
  // Wrap the body so it looks like a real DeepSeek chat completions response.
  const contentString = typeof json === 'string' ? json : JSON.stringify(json);
  return {
    ok: status === 200,
    status,
    headers: { entries: () => Object.entries({ 'content-type': 'application/json' })[Symbol.iterator]() },
    body: null,
    text: vi.fn().mockResolvedValue(JSON.stringify({
      choices: [{ message: { content: contentString } }],
    })),
  };
}

describe('DeepSeekTranslationService.translate prompt', () => {
  let service: DeepSeekTranslationService;

  beforeEach(() => {
    service = new DeepSeekTranslationService('test-api-key');
    vi.clearAllMocks();
  });

  async function captureRequestBody() {
    return JSON.parse(globalFetch.mock.calls[0][1].body);
  }

  it('instructs the model to translate every block (no omissions)', async () => {
    globalFetch.mockResolvedValue(
      createJsonResponse({ translations: [{ id: 'b1', translated_text: '你好' }] })
    );
    await service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', []);
    const body = await captureRequestBody();
    const system = body.messages[0].content as string;
    expect(system).toMatch(/Translate.*to/);
    expect(system).toMatch(/One entry per input block/);
    expect(system).toMatch(/translated_text/);
  });

  it('forbids the model from returning the input unchanged', async () => {
    globalFetch.mockResolvedValue(
      createJsonResponse({ translations: [{ id: 'b1', translated_text: '你好' }] })
    );
    await service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', []);
    const body = await captureRequestBody();
    const system = body.messages[0].content as string;
    expect(system).toMatch(/NOT equal input text/i);
  });

  it('tells the user message how many blocks must appear in the output', async () => {
    globalFetch.mockResolvedValue(
      createJsonResponse({
        translations: [
          { id: 'b1', translated_text: '你好' },
          { id: 'b2', translated_text: '世界' },
        ],
      })
    );
    const blocks = [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ];
    await service.translate(JSON.stringify(blocks), 'en', 'zh', []);
    const body = await captureRequestBody();
    const user = body.messages[1].content as string;
    expect(user).toContain('Translate 2 blocks to');
    expect(user).toContain('Simplified Chinese');
  });

  it('still passes when a block is silently returned unchanged (warns)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // LLM "no-op": returns the source text as-is.
    globalFetch.mockResolvedValue(
      createJsonResponse({ translations: [{ id: 'b1', translated_text: 'hello' }] })
    );
    const result = await service.translate(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );
    // The raw string is still returned untouched — caller (background) decides
    // what to do. We just verify the diagnostic fired.
    expect(warn).toHaveBeenCalled();
    expect(result).toContain('hello');
    warn.mockRestore();
  });

  it('translateStream also runs the no-op check on its final content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const encoder = new TextEncoder();
    const payload = JSON.stringify({ translations: [{ id: 'b1', translated_text: 'hello' }] });
    const events = [
      `data: {"choices":[{"delta":{"content":${JSON.stringify(payload)}}}]}\n\n`,
      'data: [DONE]\n\n',
    ];
    const chunk = encoder.encode(events.join(''));
    globalFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: chunk })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: vi.fn(),
        }),
      },
      text: vi.fn().mockResolvedValue(''),
    });

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );
    // Drain the stream completely
    while (true) {
      const r = await stream.next();
      if (r.done) break;
    }
    // After stream exhaustion the diagnostic should have fired
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
