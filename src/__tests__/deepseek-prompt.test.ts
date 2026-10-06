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



});
