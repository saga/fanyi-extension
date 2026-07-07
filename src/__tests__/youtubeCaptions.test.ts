import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 导入被测函数（注意：youtube 模块有 DOM 依赖，需要 jsdom 环境）
import {
  fetchCaptions,
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
// postMessage Mock 工具
// =============================================================================

const PLAYER_DATA_REQUEST_TYPE = 'FANYI_YT_PLAYER_DATA_REQUEST';
const PLAYER_DATA_RESPONSE_TYPE = 'FANYI_YT_PLAYER_DATA_RESPONSE';
const WAIT_TIMEDTEXT_REQUEST_TYPE = 'FANYI_YT_WAIT_TIMEDTEXT_REQUEST';
const WAIT_TIMEDTEXT_RESPONSE_TYPE = 'FANYI_YT_WAIT_TIMEDTEXT_RESPONSE';
const ENSURE_SUBTITLES_REQUEST_TYPE = 'FANYI_YT_ENSURE_SUBTITLES_REQUEST';
const ENSURE_SUBTITLES_RESPONSE_TYPE = 'FANYI_YT_ENSURE_SUBTITLES_RESPONSE';

function setupPostMessageMock(
  responder: (message: any) => { type: string; [key: string]: any } | null,
): () => void {
  const originalPostMessage = window.postMessage;
  window.postMessage = vi.fn((message: any) => {
    const response = responder(message);
    setTimeout(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: response ? { ...response, requestId: message.requestId } : null,
        }),
      );
    }, 0);
  }) as any;
  return () => {
    window.postMessage = originalPostMessage;
  };
}

function buildPlayerDataResponse(data: any) {
  return {
    type: PLAYER_DATA_RESPONSE_TYPE,
    success: true,
    data,
  };
}

function buildTimedtextResponse(url: string | null) {
  return {
    type: WAIT_TIMEDTEXT_RESPONSE_TYPE,
    url,
  };
}

function buildEnsureSubtitlesResponse() {
  return {
    type: ENSURE_SUBTITLES_RESPONSE_TYPE,
  };
}

// =============================================================================
// extractVideoId / fetchCaptions
// =============================================================================

describe('fetchCaptions', () => {
  let restorePostMessage: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    globalFetch.mockReset();
  });

  afterEach(() => {
    restorePostMessage?.();
    restorePostMessage = null;
  });

  it('fetches captions with POT from audioCaptionTracks', async () => {
    restorePostMessage = setupPostMessageMock((message) => {
      if (message.type === PLAYER_DATA_REQUEST_TYPE) {
        return buildPlayerDataResponse({
          videoId: 'abc123',
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=abc123&caps=asr',
              languageCode: 'en',
              kind: 'asr',
              vssId: 'a.en',
            },
          ],
          audioCaptionTracks: [
            {
              url: 'https://www.youtube.com/api/timedtext?v=abc123&lang=en&pot=TOKEN&potc=SIG',
              vssId: 'a.en',
              languageCode: 'en',
              kind: 'asr',
            },
          ],
          device: null,
          cver: null,
          playerState: 1,
          selectedTrackLanguageCode: null,
          selectedTrackVssId: null,
          cachedTimedtextUrl: null,
        });
      }
      return null;
    });

    globalFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        events: [
          {
            tStartMs: 0,
            dDurationMs: 2000,
            segs: [{ utf8: 'Hello world' }],
          },
          {
            tStartMs: 2500,
            dDurationMs: 2000,
            segs: [{ utf8: 'Second line' }],
          },
        ],
      }),
    });

    const captions = await fetchCaptions('abc123');
    expect(captions).toHaveLength(2);
    expect(captions[0].text).toBe('Hello world');
    expect(captions[0].startMs).toBe(0);
    expect(captions[0].durationMs).toBe(2000);
    expect(captions[1].text).toBe('Second line');

    // 验证 URL 构造：包含 pot/potc 和 json3
    const fetchUrl = globalFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('fmt=json3');
    expect(fetchUrl).toContain('pot=TOKEN');
    expect(fetchUrl).toContain('potc=SIG');
  });

  it('falls back to timedtext URL interception when no POT in audio tracks', async () => {
    restorePostMessage = setupPostMessageMock((message) => {
      if (message.type === PLAYER_DATA_REQUEST_TYPE) {
        return buildPlayerDataResponse({
          videoId: 'abc123',
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=abc123&caps=asr',
              languageCode: 'en',
              kind: 'asr',
              vssId: 'a.en',
            },
          ],
          audioCaptionTracks: [],
          device: null,
          cver: null,
          playerState: 1,
          selectedTrackLanguageCode: null,
          selectedTrackVssId: null,
          cachedTimedtextUrl: null,
        });
      }
      if (message.type === ENSURE_SUBTITLES_REQUEST_TYPE) {
        return buildEnsureSubtitlesResponse();
      }
      if (message.type === WAIT_TIMEDTEXT_REQUEST_TYPE) {
        return buildTimedtextResponse(
          'https://www.youtube.com/api/timedtext?v=abc123&pot=TOKEN2&potc=SIG2',
        );
      }
      return null;
    });

    // 第一次 fetch 无 POT，模拟 YouTube 拒绝，触发 fallback 流程
    globalFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: vi.fn().mockResolvedValue('Forbidden'),
    });

    // fallback 后第二次 fetch 成功
    globalFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        events: [
          {
            tStartMs: 0,
            dDurationMs: 1500,
            segs: [{ utf8: 'Fallback line' }],
          },
        ],
      }),
    });

    const captions = await fetchCaptions('abc123');
    expect(captions).toHaveLength(1);
    expect(captions[0].text).toBe('Fallback line');

    // 第二次 fetch 使用拦截到的 timedtext URL（含 POT）
    const fetchUrl = globalFetch.mock.calls[1][0];
    expect(fetchUrl).toContain('pot=TOKEN2');
    expect(fetchUrl).toContain('potc=SIG2');
  }, 10000);

  it('throws when no caption tracks available', async () => {
    restorePostMessage = setupPostMessageMock((message) => {
      if (message.type === PLAYER_DATA_REQUEST_TYPE) {
        return buildPlayerDataResponse({
          videoId: 'abc123',
          captionTracks: [],
          audioCaptionTracks: [],
          device: null,
          cver: null,
          playerState: 1,
          selectedTrackLanguageCode: null,
          selectedTrackVssId: null,
          cachedTimedtextUrl: null,
        });
      }
      return null;
    });

    await expect(fetchCaptions('abc123')).rejects.toThrow('未找到可用字幕');
  });

  it('filters noise annotations from captions', async () => {
    restorePostMessage = setupPostMessageMock((message) => {
      if (message.type === PLAYER_DATA_REQUEST_TYPE) {
        return buildPlayerDataResponse({
          videoId: 'abc123',
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=abc123',
              languageCode: 'en',
              vssId: 'a.en',
            },
          ],
          audioCaptionTracks: [
            {
              url: 'https://www.youtube.com/api/timedtext?v=abc123&pot=POT',
              vssId: 'a.en',
            },
          ],
          device: null,
          cver: null,
          playerState: 1,
          selectedTrackLanguageCode: null,
          selectedTrackVssId: null,
          cachedTimedtextUrl: null,
        });
      }
      return null;
    });

    globalFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        events: [
          {
            tStartMs: 0,
            dDurationMs: 2000,
            segs: [{ utf8: '[Music] Hello' }],
          },
        ],
      }),
    });

    const captions = await fetchCaptions('abc123');
    expect(captions[0].text).toBe('Hello');
  });

  it('parses scrolling ASR subtitles into sentence fragments', async () => {
    restorePostMessage = setupPostMessageMock((message) => {
      if (message.type === PLAYER_DATA_REQUEST_TYPE) {
        return buildPlayerDataResponse({
          videoId: 'asr123',
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=asr123',
              languageCode: 'en',
              kind: 'asr',
              vssId: 'a.en',
            },
          ],
          audioCaptionTracks: [
            {
              url: 'https://www.youtube.com/api/timedtext?v=asr123&pot=POT',
              vssId: 'a.en',
            },
          ],
          device: null,
          cver: null,
          playerState: 1,
          selectedTrackLanguageCode: null,
          selectedTrackVssId: null,
          cachedTimedtextUrl: null,
        });
      }
      return null;
    });

    globalFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        events: [
          { tStartMs: 0, segs: [{ utf8: 'Hello' }], wWinId: 1 },
          { tStartMs: 200, segs: [{ utf8: ' world.' }], wWinId: 1 },
          { tStartMs: 400, aAppend: 1, dDurationMs: 100, wWinId: 1 },
          { tStartMs: 1500, segs: [{ utf8: 'Second' }], wWinId: 1 },
          { tStartMs: 1700, segs: [{ utf8: ' line.' }], wWinId: 1 },
          { tStartMs: 1900, aAppend: 1, dDurationMs: 100, wWinId: 1 },
        ],
      }),
    });

    const captions = await fetchCaptions('asr123');
    expect(captions.length).toBeGreaterThanOrEqual(2);
    expect(captions[0].text).toBe('Hello world.');
    expect(captions[1].text).toBe('Second line.');
  });

  it('parses karaoke subtitles by selecting main kanji track', async () => {
    restorePostMessage = setupPostMessageMock((message) => {
      if (message.type === PLAYER_DATA_REQUEST_TYPE) {
        return buildPlayerDataResponse({
          videoId: 'kara123',
          captionTracks: [
            {
              baseUrl: 'https://www.youtube.com/api/timedtext?v=kara123',
              languageCode: 'ja',
              kind: 'asr',
              vssId: '.ja',
            },
          ],
          audioCaptionTracks: [
            {
              url: 'https://www.youtube.com/api/timedtext?v=kara123&pot=POT',
              vssId: '.ja',
            },
          ],
          device: null,
          cver: null,
          playerState: 1,
          selectedTrackLanguageCode: null,
          selectedTrackVssId: null,
          cachedTimedtextUrl: null,
        });
      }
      return null;
    });

    globalFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        events: [
          { tStartMs: 0, dDurationMs: 1000, wpWinPosId: 3, segs: [{ utf8: 'こんにちは' }] },
          { tStartMs: 0, dDurationMs: 1000, wpWinPosId: 4, segs: [{ utf8: 'konnichiwa' }] },
          { tStartMs: 1200, dDurationMs: 1000, wpWinPosId: 3, segs: [{ utf8: 'こんにちは' }] },
        ],
      }),
    });

    const captions = await fetchCaptions('kara123');
    expect(captions.length).toBe(1);
    expect(captions[0].text).toBe('こんにちは');
  });
});

// =============================================================================
// translateCaptions — 批量翻译字幕
// =============================================================================

describe('translateCaptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalFetch.mockReset();
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
    const el = document.getElementById('fanyi-caption-overlay')!;
    expect(el.textContent).toBe('Hello');

    captions[0].translatedText = '你好';
    overlay.updateCaptions(captions);

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
    globalFetch.mockReset();
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

    await translateAhead(captions, 0, 90_000, 'test-api-key');

    expect(captions[0].translatedText).toBe('你好');
    expect(captions[0].status).toBe('done');
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

    expect(captions[0].translatedText).toBe('已翻译');
    expect(captions[1].status).toBe('failed');
  });

  it('aborts when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Hello', status: 'pending' },
    ];

    await translateAhead(captions, 0, 90_000, 'test-api-key', controller.signal);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(captions[0].status).toBe('pending');
  });

  it('aborts mid-batch when signal fires', async () => {
    const controller = new AbortController();

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
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"translations":[]}' } }] }),
      });
    });

    const captions: CaptionEvent[] = [];
    for (let i = 0; i < 60; i++) {
      captions.push({ startMs: i * 2000, durationMs: 2000, text: 'Line ' + i, status: 'pending' });
    }

    await translateAhead(captions, 0, Number.MAX_SAFE_INTEGER, 'test-api-key', controller.signal);

    expect(captions[0].translatedText).toBe('你好');
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
    globalFetch.mockReset();
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
    const result = await manager.start('test-api-key');
    expect(result).toBe(false);
  });

  it('stop clears running state', () => {
    expect(() => manager.stop()).not.toThrow();
  });

  it('destroy clears cache and removes listeners', () => {
    expect(() => manager.destroy()).not.toThrow();
    const newManager = YouTubeCaptionManager.getInstance();
    expect(newManager).not.toBe(manager);
  });
});
