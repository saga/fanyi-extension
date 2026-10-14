import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: { runtime: { sendMessage: vi.fn() } },
}));

import browser from 'webextension-polyfill';
import { useDocumentTranslation } from '../entrypoints/document/useDocumentTranslation';

const sendMessage = browser.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;

/** 每段自成一批 + 串行，用来观察「正在翻」与「排队中」的区别。 */
const serialSegments = [
  { id: 's0', index: 0, text: 'First line.', kind: 'paragraph' as const, page: 1, contextPath: '' },
  { id: 's1', index: 1, text: 'Second line.', kind: 'paragraph' as const, page: 1, contextPath: '' },
  { id: 's2', index: 2, text: 'Third line.', kind: 'paragraph' as const, page: 1, contextPath: '' },
];
const [firstSegment] = serialSegments;

const options = {
  sourceLang: 'en',
  targetLang: 'zh',
  useServerTranslation: true,
  serverUrl: 'https://s.sunxiunan.com',
  concurrency: 1,
  budget: { maxSegments: 1 },
};

/** 可手动放行的 fetch 响应。 */
function deferredJson() {
  let release!: (value: unknown) => void;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function okJson(value: unknown) {
  return { ok: true, status: 200, json: async () => value };
}

function batchOk(ids: Record<string, string>) {
  return okJson({ translations: ids, failedBatches: [], errors: [], complete: true, missingSegmentIds: [] });
}

describe('阅读页「翻译中」占位只覆盖正在翻译的段', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    sendMessage.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('排队中的段不进活跃集合——否则整页都是占位', async () => {
    const first = deferredJson();
    const second = deferredJson();
    const third = deferredJson();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);

    const { run, state } = useDocumentTranslation();
    const running = run(serialSegments, options);

    // 第一批在飞：只有 s0 是活跃的，后面两段排队，不该显示「翻译中…」。
    await vi.waitFor(() => expect(state.value.activeSegmentIds.has('s0')).toBe(true));
    expect(state.value.activeSegmentIds.has('s1')).toBe(false);
    expect(state.value.activeSegmentIds.has('s2')).toBe(false);

    first.release(batchOk({ s0: '第一行。' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.value.activeSegmentIds.has('s1')).toBe(true));
    expect(state.value.activeSegmentIds.has('s0')).toBe(false);

    second.release(batchOk({ s1: '第二行。' }));
    third.release(batchOk({ s2: '第三行。' }));
    await running;

    expect([...state.value.translations.values()]).toEqual(['第一行。', '第二行。', '第三行。']);
    expect(state.value.activeSegmentIds.size).toBe(0);
  });

  it('失败批次也会被摘出活跃集合，不会永久挂着「翻译中…」', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(batchOk({ s0: '第一行。' }));

    const { run, state } = useDocumentTranslation();
    await run(firstSegment ? [firstSegment] : [], { ...options, retries: 0 });

    expect(state.value.failedBatches).toEqual([0]);
    expect(state.value.activeSegmentIds.size).toBe(0);
  });

  it('run 启动时清掉上一次被打断残留的活跃 id', async () => {
    fetchMock.mockResolvedValue(batchOk({ s0: '第一行。' }));
    const { run, state } = useDocumentTranslation();
    state.value.activeSegmentIds = new Set(['stale-1', 'stale-2']);

    await run(firstSegment ? [firstSegment] : [], options);

    expect([...state.value.activeSegmentIds]).toEqual([]);
  });
});