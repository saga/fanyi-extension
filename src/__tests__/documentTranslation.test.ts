import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: { runtime: { sendMessage: vi.fn() } },
}));

import browser from 'webextension-polyfill';
import { useDocumentTranslation } from '../entrypoints/document/useDocumentTranslation';

const sendMessage = browser.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;

const sampleSegments = [
  {
    id: 'pdf-s0',
    index: 0,
    text: 'Introduction',
    kind: 'heading' as const,
    level: 1,
    page: 1,
    contextPath: 'Introduction',
  },
  {
    id: 'pdf-s1',
    index: 1,
    text: 'The model improves translation quality.',
    kind: 'paragraph' as const,
    page: 2,
    contextPath: '2 Method > 2.1 Model',
  },
];

function okJson(value: unknown) {
  return { ok: true, status: 200, json: async () => value };
}

describe('文档翻译服务端模式', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    sendMessage.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const options = {
    sourceLang: 'en',
    targetLang: 'zh',
    useServerTranslation: true,
    serverUrl: 'https://s.sunxiunan.com/fanyi/page',
    provider: 'deepseek',
    apiKey: 'test-key',
    documentFileName: 'research.pdf',
    documentTitle: 'Research',
    documentFormat: 'pdf',
    documentWarnings: ['第 3 页文字较少'],
  };

  it('发送结构化 PDF 片段和章节上下文，而不是上传 PDF 二进制', async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      translations: { 'pdf-s0': '引言', 'pdf-s1': '该模型提高了翻译质量。' },
      failedBatches: [],
      errors: [],
      complete: true,
      missingSegmentIds: [],
    }));
    const { run, state } = useDocumentTranslation();

    await run(sampleSegments, options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://s.sunxiunan.com/api/translate/document/segments');
    expect(request.method).toBe('POST');
    const payload = JSON.parse(String(request.body));
    expect(payload.fileName).toBe('research.pdf');
    expect(payload.format).toBe('pdf');
    expect(payload.segments[1].contextPath).toBe('2 Method > 2.1 Model');
    expect(payload.segments[0].kind).toBe('heading');
    expect(payload.apiKey).toBe('test-key');
    expect(payload.content).toBeUndefined();
    expect(state.value.translations.get('pdf-s0')).toBe('引言');
    expect(state.value.translations.get('pdf-s1')).toBe('该模型提高了翻译质量。');
    expect(state.value.failedBatches).toEqual([]);
    expect(state.value.done).toBe(state.value.total);
  });

  it('本地 provider 的批次部分响应在重试后可以补齐，而不是永久判失败', async () => {
    sendMessage
      .mockResolvedValueOnce({ success: true, result: [['pdf-s0', '引言']] })
      .mockResolvedValueOnce({ success: true, result: [['pdf-s1', '该模型提高了翻译质量。']] });

    const { run, state } = useDocumentTranslation();
    await run(sampleSegments, {
      sourceLang: 'en',
      targetLang: 'zh',
      retries: 1,
      useServerTranslation: false,
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const firstMessage = sendMessage.mock.calls[0]?.[0] as { jsonContent: string };
    const localPayload = JSON.parse(firstMessage.jsonContent);
    expect(localPayload[0].contextPath).toBe('Introduction');
    expect(localPayload[1].contextPath).toBe('2 Method > 2.1 Model');
    expect(localPayload[0].marker).toBeUndefined();
    expect(state.value.translations.get('pdf-s0')).toBe('引言');
    expect(state.value.translations.get('pdf-s1')).toBe('该模型提高了翻译质量。');
    expect(state.value.failedBatches).toEqual([]);
    expect(state.value.done).toBe(state.value.total);
  });

  it('部分成功时保留已有译文，重试请求只包含缺失片段', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({
        translations: { 'pdf-s0': '引言' },
        failedBatches: [0],
        errors: ['batch 0: pdf-s1 missing'],
        complete: false,
        missingSegmentIds: ['pdf-s1'],
      }))
      .mockResolvedValueOnce(okJson({
        translations: { 'pdf-s1': '该模型提高了翻译质量。' },
        failedBatches: [],
        errors: [],
        complete: true,
        missingSegmentIds: [],
      }));

    const { run, retryFailed, state } = useDocumentTranslation();
    await run(sampleSegments, options);

    expect(state.value.translations.get('pdf-s0')).toBe('引言');
    expect(state.value.translations.has('pdf-s1')).toBe(false);
    expect(state.value.failedBatches).toEqual([0]);

    await retryFailed(sampleSegments, options);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryPayload = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(retryPayload.segments).toHaveLength(1);
    expect(retryPayload.segments[0].id).toBe('pdf-s1');
    expect(retryPayload.segments[0].contextPath).toBe('2 Method > 2.1 Model');
    expect(state.value.translations.get('pdf-s1')).toBe('该模型提高了翻译质量。');
    expect(state.value.failedBatches).toEqual([]);
    expect(state.value.error).toBe('');
  });
});
