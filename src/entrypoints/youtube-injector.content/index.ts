/**
 * YouTube 页面内注入脚本（MAIN world）。
 *
 * 参考 read-frog 的 interceptor.content 实现：
 *   - 通过 postMessage 与 content script（ISOLATED world）通信
 *   - 直接读取 YouTube 播放器内部 API（movie_player.getPlayerResponse）
 *   - 监听 XMLHttpRequest 抓取 timedtext URL（含 POT token）
 *   - 自动开启字幕（CC）
 *
 * 该脚本在 WXT manifest 中注册为 world: 'MAIN'、runAt: 'document_start'，
 * 因此可以在 YouTube 自己的脚本运行前注入并劫持 XHR。
 */

// =============================================================================
// 消息类型常量（与 provider.ts 保持一致）
// =============================================================================

const PLAYER_DATA_REQUEST_TYPE = 'FANYI_YT_PLAYER_DATA_REQUEST';
const PLAYER_DATA_RESPONSE_TYPE = 'FANYI_YT_PLAYER_DATA_RESPONSE';
const WAIT_TIMEDTEXT_REQUEST_TYPE = 'FANYI_YT_WAIT_TIMEDTEXT_REQUEST';
const WAIT_TIMEDTEXT_RESPONSE_TYPE = 'FANYI_YT_WAIT_TIMEDTEXT_RESPONSE';
const ENSURE_SUBTITLES_REQUEST_TYPE = 'FANYI_YT_ENSURE_SUBTITLES_REQUEST';
const ENSURE_SUBTITLES_RESPONSE_TYPE = 'FANYI_YT_ENSURE_SUBTITLES_RESPONSE';

const POST_MESSAGE_TIMEOUT_MS = 5000;
const TIMEDTEXT_WAIT_TIMEOUT_MS = 8000;
const TIMEDTEXT_API_RE = /api\/timedtext/;

// =============================================================================
// 类型（内联，避免跨 world 共享类型文件）
// =============================================================================

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  vssId: string;
  name?: { simpleText: string };
  trackName?: string;
}

interface AudioCaptionTrack {
  url: string;
  vssId: string;
  kind?: string;
  languageCode?: string;
}

interface PlayerData {
  videoId: string;
  captionTracks: CaptionTrack[];
  audioCaptionTracks: AudioCaptionTrack[];
  device: string | null;
  cver: string | null;
  playerState: number;
  selectedTrackLanguageCode: string | null;
  selectedTrackVssId: string | null;
  cachedTimedtextUrl: string | null;
}

interface YouTubePlayer extends HTMLElement {
  getPlayerResponse?: () => any;
  getAudioTrack?: () => any;
  getPlayerState?: () => number;
  getWebPlayerContextConfig?: () => any;
  getOption?: (module: string, option: string) => any;
  toggleSubtitles?: () => void;
}

interface PlayerDataRequest {
  type: typeof PLAYER_DATA_REQUEST_TYPE;
  requestId: string;
  expectedVideoId: string;
}

interface PlayerDataResponse {
  type: typeof PLAYER_DATA_RESPONSE_TYPE;
  requestId: string;
  success: boolean;
  error?: string;
  data?: PlayerData;
}

interface SelectedTrackSnapshot {
  languageCode: string | null;
  vssId: string | null;
}

declare global {
  interface Window {
    ytcfg?: {
      get?: (key: string) => string | undefined;
    };
    __FANYI_YT_INJECTOR_INJECTED__?: boolean;
  }
}

// =============================================================================
// Entry
// =============================================================================

export default defineContentScript({
  matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
  allFrames: true,
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    injectPlayerApi();
  },
});

function injectPlayerApi(): void {
  if (window.__FANYI_YT_INJECTOR_INJECTED__) {
    return;
  }
  window.__FANYI_YT_INJECTOR_INJECTED__ = true;

  setupTimedtextObserver();
  window.addEventListener('message', handleMessage);
}

// =============================================================================
// Timedtext URL 拦截（XHR + fetch）
// =============================================================================

const timedtextUrlCache: Map<string, string> = new Map();
const timedtextUrlWaiters: Map<string, Array<(url: string) => void>> = new Map();

function cacheTimedtextUrl(url: string): void {
  if (!TIMEDTEXT_API_RE.test(url)) return;

  try {
    const parsedUrl = new URL(url);
    const videoId = parsedUrl.searchParams.get('v');
    const pot = parsedUrl.searchParams.get('pot');
    if (!videoId || !pot) return;

    timedtextUrlCache.set(videoId, url);

    const waiters = timedtextUrlWaiters.get(videoId);
    if (waiters) {
      waiters.forEach((resolve) => resolve(url));
      timedtextUrlWaiters.delete(videoId);
    }
  } catch {
    // ignore malformed URL
  }
}

function waitForTimedtextUrl(videoId: string, timeoutMs: number): Promise<string | null> {
  const cached = timedtextUrlCache.get(videoId);
  if (cached) {
    return Promise.resolve(cached);
  }

  return new Promise((resolve) => {
    const waiters = timedtextUrlWaiters.get(videoId) || [];
    waiters.push(resolve);
    timedtextUrlWaiters.set(videoId, waiters);

    setTimeout(() => {
      const currentWaiters = timedtextUrlWaiters.get(videoId);
      if (!currentWaiters) return;
      const index = currentWaiters.indexOf(resolve);
      if (index !== -1) {
        currentWaiters.splice(index, 1);
        resolve(timedtextUrlCache.get(videoId) ?? null);
      }
    }, timeoutMs);
  });
}

function getCachedTimedtextUrl(videoId: string): string | null {
  return timedtextUrlCache.get(videoId) ?? null;
}

function setupTimedtextObserver(): void {
  // 拦截 XMLHttpRequest
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...args: any[]
  ) {
    (this as any)._url = url.toString();
    return originalXhrOpen.apply(this, [method, url, ...args] as any);
  };

  XMLHttpRequest.prototype.send = function (...args: any[]) {
    this.addEventListener('load', function () {
      cacheTimedtextUrl(this.responseURL || (this as any)._url);
    });
    return originalXhrSend.apply(this, args as any);
  };

  // 拦截 fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args: any[]) {
    const request = args[0];
    const url = typeof request === 'string' ? request : request?.url;
    if (typeof url === 'string') {
      try {
        const response = await originalFetch.apply(this, args as any);
        cacheTimedtextUrl(response.url || url);
        return response;
      } catch (e) {
        throw e;
      }
    }
    return originalFetch.apply(this, args as any);
  };
}

// =============================================================================
// Message 处理
// =============================================================================

function handleMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return;
  if (!event.data?.type) return;

  if (event.data.type === PLAYER_DATA_REQUEST_TYPE) {
    const request = event.data as PlayerDataRequest;
    const response = getPlayerData(request);
    window.postMessage(response, window.location.origin);
  }

  if (event.data.type === WAIT_TIMEDTEXT_REQUEST_TYPE) {
    const { requestId, videoId } = event.data;
    void waitForTimedtextUrl(videoId, TIMEDTEXT_WAIT_TIMEOUT_MS).then((url) => {
      window.postMessage(
        {
          type: WAIT_TIMEDTEXT_RESPONSE_TYPE,
          requestId,
          url,
        },
        window.location.origin,
      );
    });
  }

  if (event.data.type === ENSURE_SUBTITLES_REQUEST_TYPE) {
    const { requestId } = event.data;
    ensureSubtitlesEnabled();
    window.postMessage(
      {
        type: ENSURE_SUBTITLES_RESPONSE_TYPE,
        requestId,
      },
      window.location.origin,
    );
  }
}

// =============================================================================
// Player 数据读取
// =============================================================================

function findYoutubePlayer(): YouTubePlayer | null {
  const shortsActive = document.querySelector<YouTubePlayer>(
    '#reel-overlay-container .html5-video-player',
  );
  if (shortsActive) return shortsActive;

  return (
    document.querySelector('.html5-video-player.playing-mode, .html5-video-player.paused-mode') ??
    document.querySelector('.html5-video-player')
  );
}

function getPlayerData(request: PlayerDataRequest): PlayerDataResponse {
  const { requestId, expectedVideoId } = request;

  try {
    const player = findYoutubePlayer();
    if (!player) {
      return errorResponse(requestId, 'PLAYER_NOT_FOUND');
    }

    const playerResponse = player.getPlayerResponse?.();
    const videoId = playerResponse?.videoDetails?.videoId;
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const captionTracks = normalizeTracks(tracks);
    const selectedTrack = getSelectedTrackSnapshot(player, captionTracks);

    if (!videoId || videoId !== expectedVideoId) {
      return errorResponse(requestId, 'VIDEO_ID_MISMATCH');
    }

    return {
      type: PLAYER_DATA_RESPONSE_TYPE,
      requestId,
      success: true,
      data: {
        videoId,
        captionTracks,
        audioCaptionTracks: parseAudioTracks(player.getAudioTrack?.()?.captionTracks),
        device: window.ytcfg?.get?.('DEVICE') ?? null,
        cver: player.getWebPlayerContextConfig?.()?.innertubeContextClientVersion ?? null,
        playerState: player.getPlayerState?.() ?? -1,
        selectedTrackLanguageCode: selectedTrack.languageCode,
        selectedTrackVssId: selectedTrack.vssId,
        cachedTimedtextUrl: getCachedTimedtextUrl(videoId),
      },
    };
  } catch (e) {
    return errorResponse(requestId, String(e));
  }
}

function errorResponse(requestId: string, error: string): PlayerDataResponse {
  return {
    type: PLAYER_DATA_RESPONSE_TYPE,
    requestId,
    success: false,
    error,
  };
}

function normalizeTracks(tracks: CaptionTrack[]): CaptionTrack[] {
  return tracks.map((t) => ({
    ...t,
    baseUrl: t.baseUrl?.includes('://') ? t.baseUrl : `${location.origin}${t.baseUrl}`,
  }));
}

function parseAudioTracks(tracks?: any[]): AudioCaptionTrack[] {
  return (tracks ?? []).flatMap((t) => {
    try {
      return [
        {
          url: t.url,
          vssId: t.vssId,
          kind: t.kind,
          languageCode: new URL(t.url).searchParams.get('lang') ?? undefined,
        },
      ];
    } catch {
      return [];
    }
  });
}

function ensureSubtitlesEnabled(): void {
  const button = document.querySelector('.ytp-subtitles-button') as HTMLElement | null;
  if (!button) return;
  if (button.getAttribute('aria-pressed') === 'true') return;

  const player = findYoutubePlayer();
  if (player?.toggleSubtitles) {
    player.toggleSubtitles();
  } else {
    button.click();
  }
}

function getSelectedTrackSnapshot(
  player: YouTubePlayer,
  captionTracks: Array<{ languageCode: string; kind?: string; vssId: string }>,
): SelectedTrackSnapshot {
  const selectedTrack = player.getOption?.('captions', 'track');
  const languageCode = selectedTrack?.languageCode ?? null;
  const matchedTrack = matchSelectedTrack(captionTracks, selectedTrack);
  const vssId = getSelectedTrackVssId(selectedTrack) ?? matchedTrack?.vssId ?? null;

  return { languageCode, vssId };
}

function getSelectedTrackVssId(selectedTrack: any): string | null {
  const directVssId = selectedTrack?.vssId ?? selectedTrack?.vss_id;
  if (typeof directVssId === 'string' && directVssId.length > 0) return directVssId;

  const baseUrl = selectedTrack?.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return null;

  try {
    const url = new URL(baseUrl, window.location.origin);
    return url.searchParams.get('vssId') ?? url.searchParams.get('vss_id');
  } catch {
    return null;
  }
}

function matchSelectedTrack(
  captionTracks: Array<{ languageCode: string; kind?: string; vssId: string }>,
  selectedTrack: any,
) {
  const selectedVssId = getSelectedTrackVssId(selectedTrack);
  if (selectedVssId) {
    return captionTracks.find((track) => track.vssId === selectedVssId);
  }

  const selectedLanguageCode = selectedTrack?.languageCode;
  const selectedKind = selectedTrack?.kind ?? selectedTrack?.trackKind ?? null;

  if (typeof selectedLanguageCode !== 'string' || selectedLanguageCode.length === 0) {
    return undefined;
  }

  if (typeof selectedKind === 'string' && selectedKind.length > 0) {
    const exactKindMatch = captionTracks.find(
      (track) =>
        track.languageCode === selectedLanguageCode && (track.kind ?? null) === selectedKind,
    );
    if (exactKindMatch) return exactKindMatch;
  }

  const sameLanguageTracks = captionTracks.filter(
    (track) => track.languageCode === selectedLanguageCode,
  );
  if (sameLanguageTracks.length === 1) return sameLanguageTracks[0];

  return undefined;
}
