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
    await service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined);
    const body = await captureRequestBody();
    const system = body.messages[0].content as string;
    expect(system).toContain('目标语言：简体中文');
    expect(system).toMatch(/每个输入块对应一个输出/);
    expect(system).toMatch(/translated_text/);
  });

  it('forbids the model from returning the input unchanged', async () => {
    globalFetch.mockResolvedValue(
      createJsonResponse({ translations: [{ id: 'b1', translated_text: '你好' }] })
    );
    await service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined);
    const body = await captureRequestBody();
    const system = body.messages[0].content as string;
    // 不再写 "NOT equal input" — 品牌名/代号就是要保留原文，写了反而
    // 跟 "Keep URLs, code, version numbers, and protected terms unchanged" 冲突，让模型困惑。
    // 取而代之用「不返回空字符串」+「不得添加、删除、总结」暗示不要 no-op。
    expect(system).toContain('不返回空字符串');
    expect(system).toContain('不得添加、删除、总结、臆测、解释或重新编造原文没有的信息');
  });

  it('user message prefix is stable (no variable N) but mentions "json" for json_object', async () => {
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
    await service.translate(JSON.stringify(blocks), 'en', 'zh', undefined);
    const body = await captureRequestBody();
    const user = body.messages[1].content as string;
    // 关键：user message 头部不能含变量（"Translate N blocks to LANG"），
    // 否则 N 在变 → prefix token 失配 → DeepSeek KV cache 公共前缀被缩
    // 短。固定头部只放 "JSON:"。
    expect(user).not.toMatch(/Translate \d+ blocks to/);
    expect(user.startsWith('JSON:\n\n')).toBe(true);
    // 硬约束：response_format: json_object 要求 user message 出现 "json"
    // 这个字，否则 HTTP 400 invalid_request_error。
    expect(user.toLowerCase()).toContain('json');
    // system message 里仍然有语言对说明（prompt 已全量中文化）
    const system = body.messages[0].content as string;
    expect(system).toContain('输入语言：英语');
    expect(system).toContain('目标语言：简体中文');
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
      undefined
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
