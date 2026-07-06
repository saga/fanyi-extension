import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 导入被测函数（注意：youtubeCaptions.ts 有 DOM 依赖，需要 jsdom 环境）
import {
  extractYtInitialPlayerResponse,
  extractJSONObject,
  getCaptionTrackUrl,
  fetchCaptions,
  translateCaptions,
  isYouTubeWatchPage,
  CaptionOverlay,
  type CaptionEvent,
} from '../entrypoints/content/youtubeCaptions';

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
// extractYtInitialPlayerResponse — 从 DOM 提取
// =============================================================================

describe('extractYtInitialPlayerResponse', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('extracts from inline script tag', () => {
    const mockData = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc', languageCode: 'en' },
          ],
        },
      },
    };
    const script = document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify(mockData)};`;
    document.head.appendChild(script);

    const result = extractYtInitialPlayerResponse();
    expect(result).not.toBeNull();
    expect(result.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl).toContain('timedtext');
  });

  it('returns null when no ytInitialPlayerResponse found', () => {
    const script = document.createElement('script');
    script.textContent = 'var otherVar = 123;';
    document.head.appendChild(script);

    const result = extractYtInitialPlayerResponse();
    expect(result).toBeNull();
  });

  it('handles JSON with nested braces in string values', () => {
    const mockData = { videoDetails: { title: 'Test {video} with braces' } };
    const script = document.createElement('script');
    script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify(mockData)};\nvar other = 1;`;
    document.head.appendChild(script);

    const result = extractYtInitialPlayerResponse();
    expect(result).not.toBeNull();
    expect(result.videoDetails.title).toBe('Test {video} with braces');
  });

  it('skips script tags without marker', () => {
    const script1 = document.createElement('script');
    script1.textContent = 'console.log("hello");';
    document.head.appendChild(script1);
    const script2 = document.createElement('script');
    script2.textContent = `var ytInitialPlayerResponse = {"videoId": "test123"};`;
    document.head.appendChild(script2);

    const result = extractYtInitialPlayerResponse();
    expect(result).not.toBeNull();
    expect(result.videoId).toBe('test123');
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
      json: vi.fn().mockResolvedValue(mockJson3),
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
      json: vi.fn().mockResolvedValue(mockJson3),
    });

    const captions = await fetchCaptions('https://example.com/api/timedtext?v=abc');
    expect(captions).toHaveLength(1);
    expect(captions[0].text).toBe('Real text');
  });

  it('appends fmt=json3 if not present', async () => {
    globalFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ events: [] }),
    });

    await fetchCaptions('https://example.com/api/timedtext?v=abc');
    expect(globalFetch).toHaveBeenCalledWith(
      'https://example.com/api/timedtext?v=abc&fmt=json3',
    );
  });

  it('does not append fmt if already present', async () => {
    globalFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ events: [] }),
    });

    await fetchCaptions('https://example.com/api/timedtext?v=abc&fmt=json3');
    expect(globalFetch).toHaveBeenCalledWith(
      'https://example.com/api/timedtext?v=abc&fmt=json3',
    );
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

  it('handles API error', async () => {
    globalFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });

    const captions: CaptionEvent[] = [
      { startMs: 0, durationMs: 1000, text: 'Hello' },
    ];

    await expect(
      translateCaptions(captions, 'bad-key'),
    ).rejects.toThrow('DeepSeek API error: HTTP 401');
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
});
