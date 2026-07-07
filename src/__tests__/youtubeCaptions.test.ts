import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 导入被测函数（注意：youtube 模块有 DOM 依赖，需要 jsdom 环境）
import {
  extractJSONObject,
  getCaptionTrackUrl,
  fetchCaptions,
  fetchPlayerResponse,
  fetchInnertubePlayer,
  fetchInnertubePlayerV2,
  translateCaptions,
  translateAhead,
  translateBatch,
  isYouTubeWatchPage,
  CaptionOverlay,
  YouTubeCaptionManager,
  type CaptionEvent,
} from '../entrypoints/content/youtube';

// Mock global fetch
const globalFetch = vi.fn();
Object.defineProperty(globalThis, 'fetch', { value: globalFetch, writable: true });

// =============================================================================
// extractJSONObject — 括号计数法提取 JSON
// =============================================================================

describe('extractJSONObject', () => {
  it('extracts simple JSON object', () => {
    const text = 'var x = {"key": "value"};';
    const result = extractJSONObject(text, text.indexOf('{'));
    expect(result).toBe('{"key": "value"}');
  });

  it('extracts nested JSON object', () => {
    const text = 'var x = {"a": {"b": [1, 2, {"c": "}"}]}};';
    const result = extractJSONObject(text, text.indexOf('{'));
    expect(result).toBe('{"a": {"b": [1, 2, {"c": "}"}]}}');
    expect(() => JSON.parse(result!)).not.toThrow();
  });

  it('handles braces inside strings', () => {
    const text = '{"str": "has { and } inside"}';
    const result = extractJSONObject(text, 0);
    expect(result).toBe('{"str": "has { and } inside"}');
  });

  it('handles escaped quotes in strings', () => {
    const text = '{"str": "has \\"quoted\\" {braces}"}';
    const result = extractJSONObject(text, 0);
    expect(result).toBe('{"str": "has \\"quoted\\" {braces}"}');
  });

  it('returns null for unbalanced braces', () => {
    const text = '{"key": "value"';
    const result = extractJSONObject(text, 0);
    expect(result).toBeNull();
  });
});

// =============================================================================
// fetchPlayerResponse — 降级链：Innertube → DOM → HTML fetch
// =============================================================================

describe('fetchPlayerResponse', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('returns Innertube playerResponse when API succeeds', async () => {
    const videoId = 'test123';
    const innertubeResponse = {
      videoDetails: { videoId },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=' + videoId, languageCode: 'en' }],
        },
      },
    };

    // Mock: 第一次 fetch 是 Innertube config 请求（HTML），第二次是 Innertube API
    globalFetch
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue('"INNERTUBE_API_KEY":"AIzaTest"'),
        headers: new Map(),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(innertubeResponse)),
        headers: new Map([['content-type', 'application/json']]),
      });

    const result = await fetchPlayerResponse(videoId);
    expect(result).not.toBeNull();
    expect(result.videoDetails.videoId).toBe(videoId);
  });

  it('falls back to Innertube v2 when v1 fails', async () => {
    const videoId = 'v2fallback';
    const v2Response = { videoDetails: { videoId }, videoId };

    // v1 第一次 fetch（提取 config）失败，v2 成功
    globalFetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(v2Response)),
        headers: new Map([['content-type', 'application/json']]),
      });

    const result = await fetchPlayerResponse(videoId);
    expect(result).not.toBeNull();
    expect(result.videoDetails.videoId).toBe(videoId);
  });

  it('falls back to DOM ytInitialPlayerResponse when both Innertube fail', async () => {
    const videoId = 'dom123';
    const mockData = { videoDetails: { videoId }, videoId };
    const script = document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify(mockData)};`;
    document.head.appendChild(script);

    // Innertube v1/v2 都失败
    globalFetch.mockRejectedValue(new Error('network error'));

    const result = await fetchPlayerResponse(videoId);
    expect(result).not.toBeNull();
    expect(result.videoDetails.videoId).toBe(videoId);
  });

  it('falls back to fetched HTML when DOM data is stale', async () => {
    const videoId = 'html123';
    const staleData = { videoDetails: { videoId: 'old123' }, videoId: 'old123' };
    const freshData = { videoDetails: { videoId }, videoId };

    const script = document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify(staleData)};`;
    document.head.appendChild(script);

    globalFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(`var ytInitialPlayerResponse = ${JSON.stringify(freshData)};`),
      headers: new Map(),
    });

    const result = await fetchPlayerResponse(videoId);
    expect(result).not.toBeNull();
    expect(result.videoDetails.videoId).toBe(videoId);
  });

  it('returns null when all sources fail', async () => {
    globalFetch.mockRejectedValue(new Error('network error'));
    const result = await fetchPlayerResponse('none123');
    expect(result).toBeNull();
  });
});

// =============================================================================
// getCaptionTrackUrl — 字幕 track URL 选择
// =============================================================================

describe('getCaptionTrackUrl', () => {
  it('returns English track URL when available', () => {
    const playerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://example.com/api/timedtext?lang=es', languageCode: 'es' },
            { baseUrl: 'https://example.com/api/timedtext?lang=en', languageCode: 'en' },
          ],
        },
      },
    };
    const url = getCaptionTrackUrl(playerResponse);
    expect(url).toContain('lang=en');
  });

  it('returns first track when English not available', () => {
    const playerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://example.com/api/timedtext?lang=fr', languageCode: 'fr' },
            { baseUrl: 'https://example.com/api/timedtext?lang=de', languageCode: 'de' },
          ],
        },
      },
    };
    const url = getCaptionTrackUrl(playerResponse);
    expect(url).toContain('lang=fr');
  });

  it('returns null when no caption tracks', () => {
    expect(getCaptionTrackUrl({})).toBeNull();
    expect(getCaptionTrackUrl({ captions: {} })).toBeNull();
    expect(getCaptionTrackUrl({
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
    })).toBeNull();
  });

  it('prefers non-gemini track over gemini track', () => {
    // YouTube 真实场景：有两条 track
    // 1. kind=asr, lang=en, variant=gemini（不支持 fmt=json3）
    // 2. lang=en-US（普通 track，支持 fmt=json3）
    // 应该选择第二条（非 gemini），即使 languageCode 不是 'en'
    const playerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: 'https://example.com/api/timedtext?lang=en&kind=asr&variant=gemini',
              languageCode: 'en',
              kind: 'asr',
            },
            {
              baseUrl: 'https://example.com/api/timedtext?lang=en-US',
              languageCode: 'en-US',
            },
          ],
        },
      },
    };
    const url = getCaptionTrackUrl(playerResponse);
    expect(url).toContain('lang=en-US');
    expect(url).not.toContain('variant=gemini');
  });

  it('falls back to gemini track if only option', () => {
    // 如果只有 gemini track，还是要用
    const playerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: 'https://example.com/api/timedtext?lang=en&variant=gemini',
              languageCode: 'en',
              kind: 'asr',
            },
          ],
        },
      },
    };
    const url = getCaptionTrackUrl(playerResponse);
    expect(url).toContain('variant=gemini');
  });
});

// =============================================================================
// fetchCaptions — 请求 timedtext API
// =============================================================================

describe('fetchCaptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses JSON3 format correctly', async () => {
    const mockJson3 = {
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 2000,
          segs: [{ utf8: 'Hello ' }, { utf8: 'world' }],
        },
        {
          tStartMs: 3000,
          dDurationMs: 1500,
          segs: [{ utf8: 'Second subtitle' }],
        },
      ],
    };
    globalFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(mockJson3)),
      headers: new Map([['content-type', 'application/json']]),
    });

    const captions = await fetchCaptions('https://example.com/api/timedtext?v=abc');
    expect(captions).toHaveLength(2);
    expect(captions[0]).toEqual({
      startMs: 1000,
      durationMs: 2000,
      text: 'Hello world',
    });
    expect(captions[1].text).toBe('Second subtitle');
  });

  it('filters out empty text segments', async () => {
    const mockJson3 = {
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '   ' }] },
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Real text' }] },
      ],
    };
    globalFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(mockJson3)),
      headers: new Map([['content-type', 'application/json']]),
    });

    const captions = await fetchCaptions('https://example.com/api/timedtext?v=abc');
    expect(captions).toHaveLength(1);
    expect(captions[0].text).toBe('Real text');
  });

  it('removes fmt parameter from URL', async () => {
    // 参考 youtube-transcript-api：不强制 fmt=json3，而是删除 fmt 参数
    globalFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hello' }] }],
      })),
      headers: new Map([['content-type', 'application/json']]),
      url: 'https://example.com/api/timedtext?v=abc',
    });

    await fetchCaptions('https://example.com/api/timedtext?v=abc&fmt=srv3');
    expect(globalFetch).toHaveBeenCalledWith(
      'https://example.com/api/timedtext?v=abc',
      { credentials: 'include' },
    );
  });

  it('parses XML srv3 format correctly', async () => {
    const mockXml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="1.000" dur="2.000">Hello world</text>
  <text start="3.500" dur="1.500">Second subtitle</text>
</transcript>`;
    globalFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(mockXml),
      headers: new Map([['content-type', 'text/xml']]),
    });

    const captions = await fetchCaptions('https://example.com/api/timedtext?v=abc');
    expect(captions).toHaveLength(2);
    expect(captions[0]).toEqual({
      startMs: 1000,
      durationMs: 2000,
      text: 'Hello world',
    });
    expect(captions[1]).toEqual({
      startMs: 3500,
      durationMs: 1500,
      text: 'Second subtitle',
    });
  });

  it('parses XML srv3 <p t="ms" d="ms"> format', async () => {
    const mockXml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <p t="1234" d="2500"><s>Hello </s><s>world</s></p>
  <p t="5000" d="1500">Second &amp; subtitle</p>
</transcript>`;
    globalFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(mockXml),
      headers: new Map([['content-type', 'text/xml']]),
    });

    const captions = await fetchCaptions('https://example.com/api/timedtext?v=abc');
    expect(captions).toHaveLength(2);
    expect(captions[0]).toEqual({
      startMs: 1234,
      durationMs: 2500,
      text: 'Hello world',
    });
    expect(captions[1]).toEqual({
      startMs: 5000,
      durationMs: 1500,
      text: 'Second & subtitle',
    });
  });

  it('throws on HTTP error', async () => {
    globalFetch.mockResolvedValue({ ok: false, status: 403 });

    await expect(
      fetchCaptions('https://example.com/api/timedtext?v=abc'),
    ).rejects.toThrow('字幕获取失败: HTTP 403');
  });
});

// =============================================================================
// translateCaptions — 批量翻译字幕
// =============================================================================

describe('translateCaptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('translates captions and fills translatedText', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: '{"translations":[{"id":"0","translated_text":"你好"},{"id":"1","translated_text":"世界"}]}',
          },
        }],
      }),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Hello' },
      { startMs: 1000, durationMs: 1000, text: 'World' },
    ];

    await translateCaptions(captions, 'test-api-key');

    expect(captions[0].translatedText).toBe('你好');
    expect(captions[1].translatedText).toBe('世界');
  });

  it('handles empty captions array', async () => {
    await translateCaptions([], 'test-api-key');
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('handles markdown code block in response', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: '```json\n{"translations":[{"id":"0","translated_text":"测试"}]}\n```',
          },
        }],
      }),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Test' },
    ];

    await translateCaptions(captions, 'test-api-key');
    expect(captions[0].translatedText).toBe('测试');
  });

  it('handles thinking tags in response (defense in depth)', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: '<think>Reasoning about translation</think>\n{"translations":[{"id":"0","translated_text":"你好"}]}',
          },
        }],
      }),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Hello' },
    ];

    await translateCaptions(captions, 'test-api-key');
    expect(captions[0].translatedText).toBe('你好');
  });

  it('calls progress callback', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: '{"translations":[{"id":"0","translated_text":"你好"}]}',
          },
        }],
      }),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Hello' },
    ];
    const onProgress = vi.fn();

    await translateCaptions(captions, 'test-api-key', onProgress);
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it('handles API error by marking batch as failed', async () => {
    // 重构后 translateCaptions 内部走 translateAhead，错误被 catch 后标记为 failed，
    // 不再抛出（resilient design：单批失败不影响其他批次）
    globalFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Hello', status: 'pending' },
    ];

    await translateCaptions(captions, 'bad-key');
    expect(captions[0].status).toBe('failed');
  });
});

// =============================================================================
// isYouTubeWatchPage — 页面检测
// =============================================================================

describe('isYouTubeWatchPage', () => {
  it('returns true for YouTube watch page', () => {
    expect(isYouTubeWatchPage('https://www.youtube.com/watch?v=abc123')).toBe(true);
  });

  it('returns false for YouTube homepage', () => {
    expect(isYouTubeWatchPage('https://www.youtube.com/')).toBe(false);
  });

  it('returns false for YouTube search page', () => {
    expect(isYouTubeWatchPage('https://www.youtube.com/results?search_query=test')).toBe(false);
  });

  it('returns false for non-YouTube site', () => {
    expect(isYouTubeWatchPage('https://example.com/watch?v=abc')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isYouTubeWatchPage('not-a-url')).toBe(false);
  });
});

// =============================================================================
// CaptionOverlay — Overlay 渲染器
// =============================================================================

describe('CaptionOverlay', () => {
  let overlay: CaptionOverlay;

  beforeEach(() => {
    document.body.innerHTML = '';
    overlay = new CaptionOverlay();
  });

  afterEach(() => {
    overlay.stop();
  });

  it('start returns false when no video element', () => {
    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Hello' },
    ];
    expect(overlay.start(captions)).toBe(false);
  });

  it('start returns true and creates overlay when video exists', () => {
    const video = document.createElement('video');
    video.className = 'html5-main-video';
    const player = document.createElement('div');
    player.className = 'html5-video-player';
    player.appendChild(video);
    document.body.appendChild(player);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 5000, text: 'Hello', translatedText: '你好' },
    ];

    expect(overlay.start(captions)).toBe(true);
    expect(document.getElementById('fanyi-caption-overlay')).not.toBeNull();
  });

  it('stop removes overlay element', () => {
    const video = document.createElement('video');
    document.body.appendChild(video);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Test' },
    ];

    overlay.start(captions);
    expect(document.getElementById('fanyi-caption-overlay')).not.toBeNull();

    overlay.stop();
    expect(document.getElementById('fanyi-caption-overlay')).toBeNull();
  });

  it('updateCaptions refreshes display when translation arrives', () => {
    const video = document.createElement('video');
    video.className = 'html5-main-video';
    Object.defineProperty(video, 'currentTime', { value: 0, writable: true });
    const player = document.createElement('div');
    player.className = 'html5-video-player';
    player.appendChild(video);
    document.body.appendChild(player);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 5000, text: 'Hello' },
    ];

    overlay.start(captions);
    // 初始状态：只显示原文（无 translatedText）
    const el = document.getElementById('fanyi-caption-overlay')!;
    expect(el.textContent).toBe('Hello');

    // 模拟 Ahead Buffer 翻译完成后调用 updateCaptions
    captions[0].translatedText = '你好';
    overlay.updateCaptions(captions);

    // 更新后应显示双语（原文 + 译文）
    expect(el.children.length).toBe(2);
    expect(el.children[0].textContent).toBe('Hello');
    expect(el.children[1].textContent).toBe('你好');
  });
});

// =============================================================================
// translateAhead — Ahead Buffer 增量翻译
// =============================================================================

describe('translateAhead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only translates captions within the ahead window', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: '{"translations":[{"id":"0","translated_text":"你好"}]}',
          },
        }],
      }),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 2000, text: 'Hello', status: 'pending' },
      { startMs: 100_000, durationMs: 2000, text: 'Far away', status: 'pending' },
    ];

    // ahead 窗口：0 ~ 90 秒，只翻译第一条
    await translateAhead(captions, 0, 90_000, 'test-api-key');

    expect(captions[0].translatedText).toBe('你好');
    expect(captions[0].status).toBe('done');
    // 第二条在 100 秒，超出 90 秒窗口，不应翻译
    expect(captions[1].translatedText).toBeUndefined();
    expect(captions[1].status).toBe('pending');
  });

  it('skips already translated captions', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":[]}' } }],
      }),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 2000, text: 'Hello', translatedText: '已翻译', status: 'done' },
      { startMs: 2000, durationMs: 2000, text: 'World', status: 'pending' },
    ];

    await translateAhead(captions, 0, 90_000, 'test-api-key');

    // 第一条已翻译，不应再调用 API（mockResponse 返回空 translations）
    expect(captions[0].translatedText).toBe('已翻译');
    // 第二条未翻译，会调用 API 但 mockResponse 返回空，所以标记为 failed
    expect(captions[1].status).toBe('failed');
  });

  it('aborts when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Hello', status: 'pending' },
    ];

    await translateAhead(captions, 0, 90_000, 'test-api-key', controller.signal);

    // abort 后不应调用 fetch
    expect(globalFetch).not.toHaveBeenCalled();
    // 字幕状态保持 pending
    expect(captions[0].status).toBe('pending');
  });

  it('aborts mid-batch when signal fires', async () => {
    const controller = new AbortController();

    // 第一批通过 setTimeout（macrotask）resolve，让 abort 在两批之间触发：
    // microtask（Promise 继续）先于 macrotask（setTimeout）执行，
    // 所以必须让 fetch 本身也走 macrotask 才能让 abort 插入
    let callCount = 0;
    globalFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => {
          setTimeout(() => {
            controller.abort();
            resolve({
              ok: true,
              json: () => Promise.resolve({
                choices: [{ message: { content: '{"translations":[{"id":"0","translated_text":"你好"}]}' } }],
              }),
            });
          }, 0);
        });
      }
      // 第二批应该不会被调用（因为 abort 了）
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"translations":[]}' } }] }),
      });
    });

    const captions: CaptionEvent[] = [];
    // 构造超过 BATCH_SIZE (50) 的字幕，确保需要两批
    for (let i = 0; i < 60; i++) {
      captions.push({ startMs: i * 2000, durationMs: 2000, text: 'Line ' + i, status: 'pending' });
    }

    await translateAhead(captions, 0, Number.MAX_SAFE_INTEGER, 'test-api-key', controller.signal);

    // 第一批 50 条应该被翻译（第一条验证）
    expect(captions[0].translatedText).toBe('你好');
    // fetch 只应被调用一次（第一批），第二批因 abort 不调用
    expect(callCount).toBe(1);
  });

  it('calls progress callback', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: '{"translations":[{"id":"0","translated_text":"你好"}]}',
          },
        }],
      }),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Hello', status: 'pending' },
    ];
    const onProgress = vi.fn();

    await translateAhead(captions, 0, 90_000, 'test-api-key', undefined, onProgress);
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });
});

// =============================================================================
// translateBatch — 单批翻译（带 AbortSignal）
// =============================================================================

describe('translateBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty map when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await translateBatch(
      'test-api-key',
      [{ id: '0', text: 'Hello' }],
      controller.signal,
    );

    expect(result.size).toBe(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('passes signal to fetch', async () => {
    const controller = new AbortController();
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":[{"id":"0","translated_text":"你好"}]}' } }],
      }),
    };
    globalFetch.mockResolvedValue(mockResponse);

    await translateBatch('test-api-key', [{ id: '0', text: 'Hello' }], controller.signal);

    const fetchCall = globalFetch.mock.calls[0];
    expect(fetchCall[1].signal).toBe(controller.signal);
  });

  it('handles empty blocks array', async () => {
    const result = await translateBatch('test-api-key', []);
    expect(result.size).toBe(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// YouTubeCaptionManager — 生命周期 / 缓存 / 取消
// =============================================================================

describe('YouTubeCaptionManager', () => {
  let manager: YouTubeCaptionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    // 重置单例（通过 destroy + 重新 getInstance）
    (YouTubeCaptionManager as any)._instance = null;
    manager = YouTubeCaptionManager.getInstance();
  });

  afterEach(() => {
    manager.destroy();
  });

  it('is a singleton', () => {
    const a = YouTubeCaptionManager.getInstance();
    const b = YouTubeCaptionManager.getInstance();
    expect(a).toBe(b);
  });

  it('start returns false when not on YouTube watch page', async () => {
    // jsdom 默认 location 是 about:blank，extractVideoId 返回 null
    const result = await manager.start('test-api-key');
    expect(result).toBe(false);
  });

  it('stop clears running state', () => {
    // stop 应该不抛错，即使没启动过
    expect(() => manager.stop()).not.toThrow();
  });

  it('destroy clears cache and removes listeners', () => {
    expect(() => manager.destroy()).not.toThrow();
    // destroy 后 getInstance 应该返回新实例
    const newManager = YouTubeCaptionManager.getInstance();
    expect(newManager).not.toBe(manager);
  });
});
