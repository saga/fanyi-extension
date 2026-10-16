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

  it('云端模式拒绝文学书籍工作流，不请求云端文档端点', async () => {
    const { run, state } = useDocumentTranslation();
    await run(sampleSegments, {
      ...options,
      literaryMode: true,
      useLocalAgent: false,
    });
    expect(state.value.running).toBe(false);
    expect(state.value.error).toContain('启用本机 Local Agent');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

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

  it('刷新恢复快照时保留译文、书籍记忆和未完成状态', () => {
    const { restoreSnapshot, getSnapshot, state, literaryMemory, literaryStatus } = useDocumentTranslation();
    restoreSnapshot({
      translations: [['book-s0', '艾丽丝走进房间。']],
      total: 8,
      done: 3,
      failedBatches: [2],
      error: '上次请求被中断',
      literaryMemory: {
        version: 1,
        entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person' }],
        relationships: [{ subject: 'Alice', predicate: 'protects', object: 'Bob' }],
        styleGuide: { narrativeVoice: '克制的第三人称' },
        chapterSummaries: [{ chapter: 'Chapter One', summary: 'Alice enters the room.' }],
        recentExamples: [],
      },
      literaryStatus: {
        enabled: true,
        bookProfileReady: true,
        chapterTitle: 'Chapter Two',
        analyzedChapters: 1,
        reviewedSegments: 7,
        warnings: ['某段 reviewer 未返回，保留初译'],
        reviewFindings: [{ id: 'book-s0', category: 'style', priority: 'optional', sourceExcerpt: 'nothing', draftExcerpt: '无事', reason: '风格建议', suggestion: '可调整' }],
      },
      analyzedChapterKeys: ['Chapter One'],
      lastRunSegmentIds: ['book-s0', 'book-s1'],
    });

    expect(state.value.running).toBe(false);
    expect(state.value.translations.get('book-s0')).toBe('艾丽丝走进房间。');
    expect(state.value.total).toBe(8);
    expect(state.value.failedBatches).toEqual([2]);
    expect(literaryMemory.value.entities[0]?.target).toBe('艾丽丝');
    expect(literaryStatus.value.bookProfileReady).toBe(true);
    expect(literaryStatus.value.reviewedSegments).toBe(7);
    expect(literaryStatus.value.reviewFindings[0]?.priority).toBe('optional');

    const snapshot = getSnapshot();
    expect(snapshot.analyzedChapterKeys).toEqual(['Chapter One']);
    expect(snapshot.lastRunSegmentIds).toEqual(['book-s0', 'book-s1']);
    expect(snapshot.translations).toEqual([['book-s0', '艾丽丝走进房间。']]);
  });

  it('停止或部分失败后继续翻译时保留已完成译文，只发送未翻译片段', async () => {
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

    const { run, state } = useDocumentTranslation();
    await run(sampleSegments, options);
    expect(state.value.translations.get('pdf-s0')).toBe('引言');
    expect(state.value.failedBatches).toEqual([0]);

    await run(sampleSegments, options, true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryPayload = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(retryPayload.segments).toHaveLength(1);
    expect(retryPayload.segments[0].id).toBe('pdf-s1');
    expect(state.value.translations.get('pdf-s0')).toBe('引言');
    expect(state.value.translations.get('pdf-s1')).toBe('该模型提高了翻译质量。');
    expect(state.value.failedBatches).toEqual([]);
    expect(state.value.done).toBe(state.value.total);
  });

  it('文学书籍按原顺序每次只推进一章，第二次继续才翻译下一章', async () => {
    sendMessage.mockImplementation(async (message: { jsonContent: string }) => {
      const blocks = JSON.parse(message.jsonContent) as Array<{ id: string }>;
      return {
        success: true,
        result: blocks.map((block) => [block.id, '初译-' + block.id]),
      };
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith('/api/translate/document/literary/analyze')) {
        const previous = body.memory?.entities ?? [];
        const additions = body.chapterTitle === 'Chapter Two'
          ? [{ source: 'London', target: '伦敦', kind: 'place' }]
          : body.chapterTitle === 'Chapter One'
            ? [{ source: 'Alice', target: '艾丽丝', kind: 'person' }]
            : [
                { source: 'Alice', target: '艾丽丝', kind: 'person' },
                { source: 'London', target: '伦敦', kind: 'place' },
              ];
        return okJson({
          analyzed: true,
          memory: {
            version: 1,
            entities: [...previous, ...additions],
            relationships: body.memory?.relationships ?? [],
            styleGuide: body.memory?.styleGuide?.narrativeVoice
              ? body.memory.styleGuide
              : { narrativeVoice: '克制的第三人称' },
            chapterSummaries: body.memory?.chapterSummaries ?? [],
            recentExamples: body.memory?.recentExamples ?? [],
          },
        });
      }
      if (url.endsWith('/api/translate/document/literary/review')) {
        const translations = Object.fromEntries(
          body.segments.map((segment: { id: string }) => [segment.id, '审校-' + segment.id]),
        );
        return okJson({ translations, reviewedIds: Object.keys(translations), missingIds: [], findings: [
          { id: body.segments[0].id, category: 'style', priority: 'must_fix', reason: '只是风格偏好', suggestion: '可考虑调整措辞' },
        ] });
      }
      throw new Error('unexpected URL: ' + url);
    });

    const { run, state, literaryMemory, literaryStatus } = useDocumentTranslation();
    const segments = [
      {
        id: 'chapter1-s0', index: 0, text: 'Alice enters the room.',
        kind: 'paragraph' as const, contextPath: 'Chapter One', path: 'Text/ch1.xhtml',
      },
      {
        id: 'chapter2-s0', index: 1, text: 'She sees the lights of London.',
        kind: 'paragraph' as const, contextPath: 'Chapter Two', path: 'Text/ch2.xhtml',
      },
    ];
    const options = {
      sourceLang: 'en',
      targetLang: 'zh',
      useServerTranslation: false,
      serverUrl: 'https://s.sunxiunan.com/fanyi/page',
      provider: 'deepseek',
      apiKey: 'test-key',
      documentFileName: 'book.epub',
      documentTitle: 'Book',
      documentFormat: 'epub',
      literaryMode: true,
      useLocalAgent: true,
      localAgentUrl: 'http://127.0.0.1:8789',
      budget: { maxChars: 3000, maxSegments: 24 },
    };

    await run(segments, options);
    expect(state.value.total).toBe(2);
    expect(state.value.done).toBe(1);
    expect(state.value.translations.get('chapter1-s0')).toBe('审校-chapter1-s0');
    expect(state.value.translations.has('chapter2-s0')).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 全书预分析 + 第一章分析 + 第一章审校
    expect(literaryStatus.value.diagnostics.some((event) => event.stage === 'book-analysis' && event.status === 'completed')).toBe(true);
    expect(literaryStatus.value.diagnostics.some((event) => event.stage === 'chapter-analysis' && event.status === 'completed')).toBe(true);
    expect(literaryStatus.value.diagnostics.some((event) => event.stage === 'translation-request' && event.status === 'started')).toBe(true);
    expect(literaryStatus.value.diagnostics.some((event) => event.stage === 'translation-response' && event.status === 'completed')).toBe(true);
    expect(literaryStatus.value.diagnostics.some((event) => event.stage === 'review' && event.status === 'completed')).toBe(true);
    expect(literaryStatus.value.diagnostics.some((event) => event.stage === 'run' && event.status === 'completed')).toBe(true);

    await run(segments, options, true);
    expect(state.value.done).toBe(2);
    expect(state.value.translations.get('chapter2-s0')).toBe('审校-chapter2-s0');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(5); // 第二章分析 + 第二章审校
    expect(literaryMemory.value.entities.map((entity) => entity.source)).toContain('Alice');
    expect(literaryMemory.value.entities.map((entity) => entity.source)).toContain('London');
    expect(literaryStatus.value.bookProfileReady).toBe(true);
    expect(literaryStatus.value.analyzedChapters).toBe(2);
    expect(literaryStatus.value.reviewedSegments).toBe(2);
    expect(literaryStatus.value.reviewFindings[0]?.priority).toBe('optional');
  });

  it('文学模式优先翻译当前页所在章节，而不是从头开始', async () => {
    sendMessage.mockImplementation(async (message: { jsonContent: string }) => {
      const blocks = JSON.parse(message.jsonContent) as Array<{ id: string }>;
      return {
        success: true,
        result: blocks.map((block) => [block.id, '初译-' + block.id]),
      };
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith('/api/translate/document/literary/analyze')) {
        return okJson({
          analyzed: true,
          memory: {
            version: 1,
            entities: body.memory?.entities ?? [],
            relationships: body.memory?.relationships ?? [],
            styleGuide: { narrativeVoice: '克制的第三人称' },
            chapterSummaries: body.memory?.chapterSummaries ?? [],
            recentExamples: body.memory?.recentExamples ?? [],
          },
        });
      }
      if (url.endsWith('/api/translate/document/literary/review')) {
        const translations = Object.fromEntries(
          body.segments.map((segment: { id: string }) => [segment.id, '审校-' + segment.id]),
        );
        return okJson({ translations, reviewedIds: Object.keys(translations), missingIds: [], findings: [] });
      }
      throw new Error('unexpected URL: ' + url);
    });

    const { run, state, literaryStatus, literaryMemory } = useDocumentTranslation();
    const segments = [
      {
        id: 'chapter1-s0', index: 0, text: 'Alice enters the room.',
        kind: 'paragraph' as const, contextPath: 'Chapter One', path: 'Text/ch1.xhtml',
      },
      {
        id: 'chapter2-s0', index: 1, text: 'She sees the lights of London.',
        kind: 'paragraph' as const, contextPath: 'Chapter Two', path: 'Text/ch2.xhtml',
      },
    ];

    // 用户停在第二章点开始：必须先翻 Chapter Two，而不是从 Chapter One 开始。
    await run(segments, {
      sourceLang: 'en',
      targetLang: 'zh',
      useServerTranslation: false,
      serverUrl: 'https://s.sunxiunan.com/fanyi/page',
      provider: 'deepseek',
      apiKey: 'test-key',
      documentFileName: 'book.epub',
      documentTitle: 'Book',
      documentFormat: 'epub',
      literaryMode: true,
      useLocalAgent: true,
      localAgentUrl: 'http://127.0.0.1:8789',
      prioritySegmentIds: ['chapter2-s0'],
      budget: { maxChars: 3000, maxSegments: 24 },
    });

    expect(state.value.total).toBe(2);
    expect(state.value.done).toBe(1);
    expect(state.value.workChapter).toBe('Chapter Two');
    expect(state.value.translations.get('chapter2-s0')).toBe('审校-chapter2-s0');
    expect(state.value.translations.has('chapter1-s0')).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(literaryMemory.value.entities).toHaveLength(0);
    expect(literaryStatus.value.warnings.some((warning) => warning.includes('没有提取到实体/人物记忆'))).toBe(true);
    expect(literaryStatus.value.diagnostics.some((event) =>
      event.stage === 'book-analysis' && event.status === 'warning' && event.message.includes('没有提取到实体/人物记忆'),
    )).toBe(true);
  });

  it('文学模式同章多批并行推进，而不是串行等待', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    sendMessage.mockImplementation(async (message: { jsonContent: string }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight--;
      const blocks = JSON.parse(message.jsonContent) as Array<{ id: string }>;
      return { success: true, result: blocks.map((block) => [block.id, '初译-' + block.id]) };
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith('/api/translate/document/literary/analyze')) {
        return okJson({
          analyzed: true,
          memory: {
            version: 1,
            entities: body.memory?.entities ?? [],
            relationships: body.memory?.relationships ?? [],
            styleGuide: { narrativeVoice: '克制的第三人称' },
            chapterSummaries: body.memory?.chapterSummaries ?? [],
            recentExamples: body.memory?.recentExamples ?? [],
          },
        });
      }
      if (url.endsWith('/api/translate/document/literary/review')) {
        const translations = Object.fromEntries(
          body.segments.map((segment: { id: string }) => [segment.id, '审校-' + segment.id]),
        );
        return okJson({ translations, reviewedIds: Object.keys(translations), missingIds: [], findings: [] });
      }
      throw new Error('unexpected URL: ' + url);
    });

    const { run, state } = useDocumentTranslation();
    // 同一章节两段、每批一段 → 同章 2 批，必须同时在途。
    const segments = [
      {
        id: 'para-s0', index: 0, text: 'Alice enters the room and looks around quietly.',
        kind: 'paragraph' as const, contextPath: 'Chapter One', path: 'Text/ch1.xhtml',
      },
      {
        id: 'para-s1', index: 1, text: 'She sees the lights of London through the small window.',
        kind: 'paragraph' as const, contextPath: 'Chapter One', path: 'Text/ch1.xhtml',
      },
    ];
    const runPromise = run(segments, {
      sourceLang: 'en',
      targetLang: 'zh',
      useServerTranslation: false,
      serverUrl: 'https://s.sunxiunan.com/fanyi/page',
      provider: 'deepseek',
      apiKey: 'test-key',
      documentFileName: 'book.epub',
      documentTitle: 'Book',
      documentFormat: 'epub',
      literaryMode: true,
      useLocalAgent: true,
      localAgentUrl: 'http://127.0.0.1:8789',
      budget: { maxChars: 3000, maxSegments: 1 },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    // 两个 worker 同时卡在翻译调用上：在途数必须达到 2（串行的话恒为 1）。
    expect(maxInFlight).toBe(2);
    release();
    await runPromise;

    expect(state.value.done).toBe(2);
    expect(state.value.translations.get('para-s0')).toBe('审校-para-s0');
    expect(state.value.translations.get('para-s1')).toBe('审校-para-s1');
  });

  it('审校 detached：初译先提交计进度，审校落定后覆盖并刷新记忆例子', async () => {
    sendMessage.mockImplementation(async (message: { jsonContent: string }) => {
      const blocks = JSON.parse(message.jsonContent) as Array<{ id: string }>;
      return { success: true, result: blocks.map((block) => [block.id, '初译-' + block.id]) };
    });
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith('/api/translate/document/literary/analyze')) {
        return okJson({
          analyzed: true,
          memory: {
            version: 1,
            entities: body.memory?.entities ?? [],
            relationships: body.memory?.relationships ?? [],
            styleGuide: { narrativeVoice: '克制的第三人称' },
            chapterSummaries: body.memory?.chapterSummaries ?? [],
            recentExamples: body.memory?.recentExamples ?? [],
          },
        });
      }
      if (url.endsWith('/api/translate/document/literary/review')) {
        await reviewGate;
        const translations = Object.fromEntries(
          body.segments.map((segment: { id: string }) => [segment.id, '审校-' + segment.id]),
        );
        return okJson({ translations, reviewedIds: Object.keys(translations), missingIds: [], findings: [] });
      }
      throw new Error('unexpected URL: ' + url);
    });

    const { run, state, literaryMemory } = useDocumentTranslation();
    const runPromise = run([{
      id: 'book-s0', index: 0,
      text: 'Alice opened the old door and walked into the silent hall.',
      kind: 'paragraph' as const, path: 'Text/chapter1.xhtml', contextPath: 'Chapter One',
    }], {
      sourceLang: 'en',
      targetLang: 'zh',
      useServerTranslation: false,
      serverUrl: 'https://s.sunxiunan.com/fanyi/page',
      provider: 'deepseek',
      apiKey: 'test-key',
      documentFileName: 'book.epub',
      documentTitle: 'Book',
      documentFormat: 'epub',
      literaryMode: true,
      useLocalAgent: true,
      localAgentUrl: 'http://127.0.0.1:8789',
      budget: { maxChars: 3000, maxSegments: 24 },
    });

    // 审校还卡着时，初译已经提交、进度已计，记忆例子记的是初译。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.value.translations.get('book-s0')).toBe('初译-book-s0');
    expect(state.value.done).toBe(1);
    expect(state.value.running).toBe(true);
    expect(literaryMemory.value.recentExamples.some((e) => e.target === '初译-book-s0')).toBe(true);

    // 审校落定：覆盖译文、刷新例子，run 收敛后结束。
    releaseReview();
    await runPromise;
    expect(state.value.translations.get('book-s0')).toBe('审校-book-s0');
    expect(state.value.running).toBe(false);
    expect(literaryMemory.value.recentExamples.some((e) => e.target === '审校-book-s0')).toBe(true);
    expect(literaryMemory.value.recentExamples.some((e) => e.target === '初译-book-s0')).toBe(false);
  });

  it('skipReview 跳过每批审校调用、直接保留初译', async () => {
    sendMessage.mockImplementation(async (message: { jsonContent: string }) => {
      const blocks = JSON.parse(message.jsonContent) as Array<{ id: string }>;
      return { success: true, result: blocks.map((block) => [block.id, '初译-' + block.id]) };
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/translate/document/literary/analyze')) {
        const body = JSON.parse(String(init?.body));
        return okJson({
          analyzed: true,
          memory: {
            version: 1,
            entities: body.memory?.entities ?? [],
            relationships: body.memory?.relationships ?? [],
            styleGuide: { narrativeVoice: '克制的第三人称' },
            chapterSummaries: body.memory?.chapterSummaries ?? [],
            recentExamples: body.memory?.recentExamples ?? [],
          },
        });
      }
      throw new Error('审校应当被跳过，不应请求: ' + url);
    });

    const { run, state, literaryStatus } = useDocumentTranslation();
    await run([{
      id: 'book-s0', index: 0,
      text: 'Alice opened the old door and walked into the silent hall.',
      kind: 'paragraph' as const, path: 'Text/chapter1.xhtml', contextPath: 'Chapter One',
    }], {
      sourceLang: 'en',
      targetLang: 'zh',
      useServerTranslation: false,
      serverUrl: 'https://s.sunxiunan.com/fanyi/page',
      provider: 'deepseek',
      apiKey: 'test-key',
      documentFileName: 'book.epub',
      documentTitle: 'Book',
      documentFormat: 'epub',
      literaryMode: true,
      useLocalAgent: true,
      localAgentUrl: 'http://127.0.0.1:8789',
      skipReview: true,
      budget: { maxChars: 3000, maxSegments: 24 },
    });

    // 只有全书预分析一次 fetch，没有审校请求；译文为初译。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.value.translations.get('book-s0')).toBe('初译-book-s0');
    expect(literaryStatus.value.reviewedSegments).toBe(0);
    expect(state.value.done).toBe(1);
  });

  it('模型整批原文返回时不入库、标失败并提示换模型', async () => {
    // 模型空转：把原文照抄回来。必须当失败（缺失）处理，不能当"译文"存住。
    sendMessage.mockImplementation(async (message: { jsonContent: string }) => {
      const blocks = JSON.parse(message.jsonContent) as Array<{ id: string; text: string }>;
      return { success: true, result: blocks.map((block) => [block.id, block.text]) };
    });

    const { run, state } = useDocumentTranslation();
    const segments = [
      {
        id: 'doc-s0', index: 0,
        text: 'Lieutenant Grey was glad that at last he had spoken aloud what had been twisting his guts.',
        kind: 'paragraph' as const, contextPath: 'Chapter One',
      },
      {
        id: 'doc-s1', index: 1,
        text: 'Sergeant Masters had been thinking about a bottle of ice-cold Australian beer and his home.',
        kind: 'paragraph' as const, contextPath: 'Chapter One',
      },
    ];
    await run(segments, {
      sourceLang: 'en',
      targetLang: 'zh',
      retries: 0,
      useServerTranslation: false,
    });

    // 空转条目全部被剔除：译文 Map 为空，批次标失败，报错说清对因。
    expect(state.value.translations.size).toBe(0);
    expect(state.value.failedBatches).toEqual([0]);
    expect(state.value.error).toMatch(/原文返回/);
  });

  it('本地翻译的 EPUB 也先分析书籍实体，再调用独立 reviewer', async () => {
    sendMessage.mockResolvedValueOnce({
      success: true,
      result: [['book-s0', '她打开了旧门。']],
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/translate/document/literary/analyze')) {
        return okJson({
          analyzed: true,
          memory: {
            version: 1,
            entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person', aliases: ['Miss Alice'] }],
            relationships: [{ subject: 'Alice', predicate: 'protects', object: 'Bob' }],
            styleGuide: { narrativeVoice: '克制的第三人称' },
            chapterSummaries: [{ chapter: 'Chapter One', summary: 'Alice opens an old door.' }],
            recentExamples: [],
          },
        });
      }
      if (url.endsWith('/api/translate/document/literary/review')) {
        return okJson({
          translations: { 'book-s0': '她轻轻推开那扇旧门。' },
          reviewedIds: ['book-s0'],
          missingIds: [],
        });
      }
      throw new Error('unexpected URL: ' + url);
    });

    const { run, state, literaryMemory, literaryStatus } = useDocumentTranslation();
    await run([{
      id: 'book-s0',
      index: 0,
      text: 'Alice opened the old door.',
      kind: 'paragraph',
      path: 'Text/chapter1.xhtml',
      contextPath: 'Chapter One',
    }], {
      sourceLang: 'en',
      targetLang: 'zh',
      useServerTranslation: false,
      serverUrl: 'https://s.sunxiunan.com/fanyi/page',
      provider: 'deepseek',
      apiKey: 'test-key',
      documentFileName: 'book.epub',
      documentTitle: 'Book',
      documentFormat: 'epub',
      literaryMode: true,
      useLocalAgent: true,
      localAgentUrl: 'http://127.0.0.1:8789',
      budget: { maxChars: 3000, maxSegments: 24 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstMessage = sendMessage.mock.calls[0]?.[0] as {
      literaryContext?: string;
      voiceContext?: unknown;
      jsonContent: string;
    };
    expect(firstMessage.literaryContext).toContain('自然的文学表达');
    // 章节路径只能表达原文结构；实体和人物声音必须走独立 voiceContext。
    expect(JSON.parse(firstMessage.jsonContent)[0].contextPath).toBe('Chapter One');
    expect(JSON.parse(firstMessage.jsonContent)[0].contextPath).not.toContain('艾丽丝');
    expect(JSON.stringify(firstMessage.voiceContext)).toContain('艾丽丝');
    expect(state.value.translations.get('book-s0')).toBe('她轻轻推开那扇旧门。');
    expect(literaryMemory.value.entities[0]?.target).toBe('艾丽丝');
    expect(literaryStatus.value.analyzedChapters).toBe(1);
    expect(literaryStatus.value.bookProfileReady).toBe(true);
    expect(literaryStatus.value.reviewedSegments).toBe(1);
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
