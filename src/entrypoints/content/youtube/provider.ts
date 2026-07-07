/**
 * YouTube 字幕 Provider（参考 read-frog 实现）。
 *
 * 核心流程：
 *   1. 通过 MAIN world 注入脚本读取 movie_player.getPlayerResponse()，
 *      拿到 captionTracks、audioCaptionTracks、device、cver 等。
 *   2. 优先用已有 POT token（audioCaptionTracks 或拦截到的 timedtext URL）。
 *   3. 若无 POT，自动开启 CC 并等待 XHR/fetch 拦截到 timedtext URL。
 *   4. 用 buildSubtitleUrl 构造请求 URL（json3），fetch 字幕事件。
 *   5. parseStandardSubtitles + filterNoiseFromEvents 解析为 CaptionEvent[]。
 *
 * 相比 DOM observer 方案：
 *   - 能拿到完整时间轴，支持 Ahead Buffer 增量翻译
 *   - 不受原生字幕渲染时机影响
 *   - 与 read-frog 的 YouTube 抓取策略一致
 */
import type { CaptionEvent } from './types';

// =============================================================================
// 消息类型常量（与 youtube-injector.content/index.ts 保持一致）
// =============================================================================

const PLAYER_DATA_REQUEST_TYPE = 'FANYI_YT_PLAYER_DATA_REQUEST';
const PLAYER_DATA_RESPONSE_TYPE = 'FANYI_YT_PLAYER_DATA_RESPONSE';
const WAIT_TIMEDTEXT_REQUEST_TYPE = 'FANYI_YT_WAIT_TIMEDTEXT_REQUEST';
const WAIT_TIMEDTEXT_RESPONSE_TYPE = 'FANYI_YT_WAIT_TIMEDTEXT_RESPONSE';
const ENSURE_SUBTITLES_REQUEST_TYPE = 'FANYI_YT_ENSURE_SUBTITLES_REQUEST';
const ENSURE_SUBTITLES_RESPONSE_TYPE = 'FANYI_YT_ENSURE_SUBTITLES_RESPONSE';

const POST_MESSAGE_TIMEOUT_MS = 5000;
const TIMEDTEXT_WAIT_TIMEOUT_MS = 8000;

const MAX_FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 500;
const MAX_POT_WAIT_ATTEMPTS = 10;
const POT_WAIT_INTERVAL_MS = 500;
const MAX_STATE_WAIT_ATTEMPTS = 20;
const STATE_WAIT_INTERVAL_MS = 250;

// =============================================================================
// 类型
// =============================================================================

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string; // 'asr' = auto-generated
  vssId: string;
  name?: { simpleText: string };
  trackName?: string;
}

export interface AudioCaptionTrack {
  url: string;
  vssId: string;
  kind?: string;
  languageCode?: string;
}

export interface PlayerData {
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

export interface YoutubeTimedTextSeg {
  utf8: string;
  tOffsetMs?: number;
}

export interface YoutubeTimedText {
  tStartMs: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: YoutubeTimedTextSeg[];
  wpWinPosId?: number;
  wWinId?: number;
}

export interface YoutubeSubtitlesResponse {
  events: YoutubeTimedText[];
}

export interface PotToken {
  pot: string | null;
  potc: string | null;
}

interface PlayerDataResponse {
  type: typeof PLAYER_DATA_RESPONSE_TYPE;
  requestId: string;
  success: boolean;
  error?: string;
  data?: PlayerData;
}

// =============================================================================
// videoId 提取
// =============================================================================

/**
 * 从 URL 提取 YouTube videoId。
 *
 * YouTube watch URL 格式：`https://www.youtube.com/watch?v=VIDEO_ID`
 * 用于 SPA 导航检测。
 *
 * @param url 可选 URL，默认用 window.location.href
 * @returns videoId 或 null（非 watch 页或无 v 参数）
 */
export function extractVideoId(
  url: string = typeof window !== 'undefined' ? window.location.href : '',
): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'www.youtube.com') return null;
    return parsed.searchParams.get('v');
  } catch {
    return null;
  }
}

// =============================================================================
// 对外 API：抓取整段字幕
// =============================================================================

/**
 * 抓取当前 YouTube 视频的字幕事件列表。
 *
 * 流程：
 *   1. 向 MAIN world 请求 player data
 *   2. 选择最佳字幕轨道
 *   3. 尝试快速抓取（已有 POT）
 *   4. 必要时开启 CC 并等待 timedtext URL
 *   5. 解析为 CaptionEvent[]
 *
 * @param videoId YouTube videoId
 * @returns 按时间排序的字幕事件数组
 */
export async function fetchCaptions(videoId: string): Promise<CaptionEvent[]> {
  const fastPath = await tryFastFetch(videoId);
  let resolvedTrack = fastPath.track;
  let events = fastPath.events;

  if (!events) {
    const fallback = await fetchWithFallback(videoId, fastPath.track);
    resolvedTrack = fallback.track;
    events = fallback.events;
  }

  if (!resolvedTrack || !events) {
    throw new Error('未找到可用字幕');
  }

  const fragments = processRawEvents(events, resolvedTrack.languageCode);

  // 转换为 CaptionEvent（使用数组下标作为 id，便于 Manager 用 globalIdx 匹配）
  return fragments.map((f, idx) => ({
    id: String(idx),
    startMs: f.start,
    durationMs: f.end - f.start,
    text: f.text,
    status: 'pending',
  }));
}

// =============================================================================
// 内部：PlayerData 请求
// =============================================================================

function postMessageRequest(
  responseType: string,
  message: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve) => {
    const requestId = cryptoRandomUUID();

    const handler = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.data?.type !== responseType ||
        event.data?.requestId !== requestId
      ) {
        return;
      }
      window.removeEventListener('message', handler);
      resolve(event.data);
    };

    window.addEventListener('message', handler);
    window.postMessage({ ...message, requestId }, window.location.origin);

    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, POST_MESSAGE_TIMEOUT_MS);
  });
}

function cryptoRandomUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return String(Date.now()) + '-' + Math.random().toString(36).slice(2);
}

async function requestPlayerData(videoId: string): Promise<PlayerDataResponse> {
  const resp = await postMessageRequest(PLAYER_DATA_RESPONSE_TYPE, {
    type: PLAYER_DATA_REQUEST_TYPE,
    expectedVideoId: videoId,
  });
  if (!resp) {
    return { type: PLAYER_DATA_RESPONSE_TYPE, requestId: '', success: false, error: 'TIMEOUT' };
  }
  return {
    type: PLAYER_DATA_RESPONSE_TYPE,
    requestId: resp.requestId,
    success: resp.success,
    error: resp.error,
    data: resp.data,
  };
}

async function waitForTimedtextUrl(videoId: string): Promise<string | null> {
  const resp = await postMessageRequest(WAIT_TIMEDTEXT_RESPONSE_TYPE, {
    type: WAIT_TIMEDTEXT_REQUEST_TYPE,
    videoId,
  });
  return resp?.url ?? null;
}

async function ensureSubtitlesEnabled(): Promise<void> {
  await postMessageRequest(ENSURE_SUBTITLES_RESPONSE_TYPE, {
    type: ENSURE_SUBTITLES_REQUEST_TYPE,
  });
}

// =============================================================================
// 内部：抓取策略
// =============================================================================

async function tryFastFetch(videoId: string): Promise<{
  track: CaptionTrack | null;
  events: YoutubeTimedText[] | null;
}> {
  const response = await requestPlayerData(videoId);
  if (!response.success || !response.data) {
    return { track: null, events: null };
  }

  const playerData = response.data;
  const track = selectTrack(playerData);
  if (!track) {
    return { track: null, events: null };
  }

  try {
    const events = await fetchTrackEvents(track, playerData);
    return { track, events };
  } catch {
    return { track, events: null };
  }
}

async function fetchWithFallback(
  videoId: string,
  preferredTrack: CaptionTrack | null,
): Promise<{ track: CaptionTrack; events: YoutubeTimedText[] }> {
  // 等待播放器状态 >= 1（已初始化）
  await waitForPlayerState(videoId);

  const playerData = await getPlayerDataWithPot(videoId);
  const track = selectTrack(playerData) ?? preferredTrack;

  if (!track) {
    throw new Error('未找到可用字幕轨道');
  }

  const events = await fetchTrackEvents(track, playerData);
  return { track, events };
}

async function waitForPlayerState(videoId: string): Promise<void> {
  for (let i = 0; i < MAX_STATE_WAIT_ATTEMPTS; i++) {
    const response = await requestPlayerData(videoId);
    if (response.success && response.data && response.data.playerState >= 1) {
      return;
    }
    await sleep(STATE_WAIT_INTERVAL_MS);
  }
}

async function getPlayerDataWithPot(videoId: string): Promise<PlayerData> {
  const response = await requestPlayerData(videoId);
  if (!response.success || !response.data) {
    throw new Error('获取播放器数据超时');
  }

  let playerData = response.data;

  if (hasPotInAudioTracks(playerData) || playerData.cachedTimedtextUrl) {
    return playerData;
  }

  if (playerData.captionTracks.length === 0) {
    return playerData;
  }

  await ensureSubtitlesEnabled();

  for (let i = 0; i < MAX_POT_WAIT_ATTEMPTS; i++) {
    await sleep(POT_WAIT_INTERVAL_MS);
    const pollResponse = await requestPlayerData(videoId);
    if (pollResponse.success && pollResponse.data) {
      playerData = pollResponse.data;
      if (hasPotInAudioTracks(playerData) || playerData.cachedTimedtextUrl) {
        return playerData;
      }
    }
  }

  // 最后再等一次 XHR/fetch 拦截
  const timedtextUrl = await waitForTimedtextUrl(videoId);
  if (timedtextUrl) {
    playerData.cachedTimedtextUrl = timedtextUrl;
  }

  return playerData;
}

function hasPotInAudioTracks(playerData: PlayerData): boolean {
  return playerData.audioCaptionTracks.some((t) => {
    try {
      return new URL(t.url).searchParams.has('pot');
    } catch {
      return false;
    }
  });
}

async function fetchTrackEvents(track: CaptionTrack, playerData: PlayerData): Promise<YoutubeTimedText[]> {
  const potToken = extractPotToken(track, playerData);
  const url = buildSubtitleUrl(track, playerData, potToken);
  return fetchWithRetry(url);
}

async function fetchWithRetry(url: string): Promise<YoutubeTimedText[]> {
  let lastError: Error | null = null;

  for (let i = 0; i < MAX_FETCH_RETRIES; i++) {
    try {
      const response = await fetch(url);

      if (!response.ok) {
        const status = response.status;
        if (status === 403) throw new Error('HTTP 403: 字幕请求被拒绝');
        if (status === 404) throw new Error('HTTP 404: 字幕不存在');
        if (status === 429) throw new Error('HTTP 429: 请求过于频繁');
        throw new Error(`HTTP ${status}`);
      }

      const data = await response.json();
      const events = (data?.events ?? []) as YoutubeTimedText[];
      return events;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.message.startsWith('HTTP 403') || err.message.startsWith('HTTP 404') || err.message.startsWith('HTTP 429')) {
        throw err;
      }
      lastError = err;
      if (i < MAX_FETCH_RETRIES - 1) {
        await sleep(FETCH_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError ?? new Error('获取字幕失败');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// 内部：轨道选择
// =============================================================================

/**
 * 选择最佳字幕轨道。
 *
 * 优先级：
 *   1. 用户当前在 YouTube 播放器中选中的轨道
 *   2. 人工字幕（非 ASR），无 name 的原始语言字幕
 *   3. 人工字幕（非 ASR）
 *   4. 自动生成的 ASR 字幕
 *   5. 第一条可用轨道
 */
function selectTrack(playerData: PlayerData): CaptionTrack | null {
  const { captionTracks: tracks, selectedTrackLanguageCode, selectedTrackVssId } = playerData;
  if (tracks.length === 0) return null;

  if (selectedTrackVssId) {
    const selected = tracks.find((t) => t.vssId === selectedTrackVssId);
    if (selected) return selected;
  }

  if (selectedTrackLanguageCode) {
    const selected = tracks.find((t) => t.languageCode === selectedTrackLanguageCode);
    if (selected) return selected;
  }

  const humanExact = tracks.find((t) => t.kind !== 'asr' && !t.name);
  if (humanExact) return humanExact;

  const humanWithName = tracks.find((t) => t.kind !== 'asr');
  if (humanWithName) return humanWithName;

  const asr = tracks.find((t) => t.kind === 'asr');
  if (asr) return asr;

  return tracks[0];
}

// =============================================================================
// 内部：POT token 提取
// =============================================================================

function extractPotToken(selectedTrack: CaptionTrack, playerData: PlayerData): PotToken {
  const { audioCaptionTracks, cachedTimedtextUrl } = playerData;

  if (audioCaptionTracks.length > 0) {
    let matchedTrack: AudioCaptionTrack | undefined = audioCaptionTracks.find(
      (t) => t.vssId === selectedTrack.vssId,
    );

    if (!matchedTrack) {
      matchedTrack = audioCaptionTracks.find(
        (t) => t.languageCode === selectedTrack.languageCode && t.kind === selectedTrack.kind,
      );
    }

    if (!matchedTrack) {
      matchedTrack = audioCaptionTracks.find(
        (t) => t.languageCode === selectedTrack.languageCode,
      );
    }

    if (!matchedTrack) {
      matchedTrack = audioCaptionTracks[0];
    }

    if (matchedTrack?.url) {
      try {
        const url = new URL(matchedTrack.url);
        const pot = url.searchParams.get('pot');
        const potc = url.searchParams.get('potc');
        if (pot) return { pot, potc };
      } catch {
        // ignore
      }
    }
  }

  if (cachedTimedtextUrl) {
    try {
      const url = new URL(cachedTimedtextUrl);
      const pot = url.searchParams.get('pot');
      const potc = url.searchParams.get('potc');
      if (pot) return { pot, potc };
    } catch {
      // ignore
    }
  }

  return { pot: null, potc: null };
}

// =============================================================================
// 内部：URL 构造
// =============================================================================

const DEVICE_PARAM_KEYS = ['cbrand', 'cbr', 'cbrver', 'cos', 'cosver', 'cplatform'] as const;

const FIXED_PARAMS = {
  fmt: 'json3',
  xorb: '2',
  xobt: '3',
  xovt: '3',
  c: 'WEB',
  cplayer: 'UNIPLAYER',
} as const;

function buildSubtitleUrl(track: CaptionTrack, playerData: PlayerData, potToken: PotToken): string {
  const url = new URL(track.baseUrl);

  Object.entries(FIXED_PARAMS).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  if (playerData.device) {
    const deviceParams = new URLSearchParams(playerData.device);
    DEVICE_PARAM_KEYS.forEach((key) => {
      const value = deviceParams.get(key);
      if (value) url.searchParams.set(key, value);
    });
  }

  if (playerData.cver) {
    url.searchParams.set('cver', playerData.cver);
  }

  if (potToken.pot) {
    url.searchParams.set('pot', potToken.pot);
  }

  if (potToken.potc) {
    url.searchParams.set('potc', potToken.potc);
  }

  return url.toString();
}

// =============================================================================
// 内部：字幕格式解析
// =============================================================================

type SubtitleFormat = 'animated' | 'karaoke' | 'karaoke-stylized' | 'scrolling-asr' | 'standard';

const ZERO_WIDTH_SPACE_PATTERN = /\u200B/g;
const SLASH_PATTERN = /\//g;
const KANJI_TRACK_ID = 3;
const WHITESPACE_PATTERN = /\s+/g;

const SENTENCE_END_PATTERN = /[,.。?？！!；;…؟۔\n]$/;
const ESTIMATED_WORD_DURATION_MS = 200;
const MAX_CHARS_CJK = 30;
const MAX_WORDS = 15;

function isCJKLanguage(lang?: string): boolean {
  if (!lang) return false;
  return ['zh', 'ja', 'ko', 'th', 'lo', 'km', 'my'].some((l) => lang.startsWith(l));
}

function getTextLength(text: string, isCJK: boolean): number {
  if (isCJK) return text.length;
  return text.split(WHITESPACE_PATTERN).filter(Boolean).length;
}

function getMaxLength(isCJK: boolean): number {
  return isCJK ? MAX_CHARS_CJK : MAX_WORDS;
}

function getEventText(event: YoutubeTimedText): string {
  return (event.segs ?? [])
    .map((seg) => seg.utf8 || '')
    .join('');
}

function cleanEventText(text: string): string {
  return text
    .replace(ZERO_WIDTH_SPACE_PATTERN, '')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
}

function detectFormat(events: YoutubeTimedText[]): SubtitleFormat {
  if (!events || events.length === 0) return 'standard';
  if (isAnimatedFormat(events)) return 'animated';
  if (isStylizedKaraokeFormat(events)) return 'karaoke-stylized';
  if (isKaraokeFormat(events)) return 'karaoke';
  if (isScrollingAsrFormat(events)) return 'scrolling-asr';
  return 'standard';
}

function isAnimatedFormat(events: YoutubeTimedText[]): boolean {
  const ANIMATED_DURATION_THRESHOLD_MS = 100;
  const ANIMATED_MIN_EVENTS = 50;
  const ANIMATED_SHORT_DURATION_RATIO = 0.5;

  if (events.length < ANIMATED_MIN_EVENTS) return false;
  let shortWithPos = 0;
  for (const event of events) {
    if (
      event.wpWinPosId !== undefined
      && (event.dDurationMs ?? 0) <= ANIMATED_DURATION_THRESHOLD_MS
    ) {
      shortWithPos += 1;
    }
  }
  return shortWithPos / events.length >= ANIMATED_SHORT_DURATION_RATIO;
}

function isKaraokeFormat(events: YoutubeTimedText[]): boolean {
  if (events.length < 2) return false;

  const groupsByTime = new Map<number, Set<number>>();
  for (const event of events) {
    if (event.wpWinPosId === undefined) continue;

    const group = groupsByTime.get(event.tStartMs) ?? new Set<number>();
    group.add(event.wpWinPosId);
    if (group.size > 1) return true;
    groupsByTime.set(event.tStartMs, group);
  }

  return false;
}

function isStylizedKaraokeFormat(events: YoutubeTimedText[]): boolean {
  if (events.length < 4) return false;

  const STYLIZED_GAP_MS = 400;
  const MIN_STYLIZED_MATCHES = 3;

  function normalizeStylizedText(text: string): string {
    return cleanEventText(text)
      .replace(SLASH_PATTERN, '')
      .replace(WHITESPACE_PATTERN, ' ')
      .trim()
      .toLowerCase();
  }

  const tracks = new Map<number, YoutubeTimedText[]>();
  for (const event of events) {
    if (event.wpWinPosId === undefined) continue;

    const arr = tracks.get(event.wpWinPosId);
    if (arr) {
      arr.push(event);
    } else {
      tracks.set(event.wpWinPosId, [event]);
    }
  }

  for (const trackEvents of tracks.values()) {
    if (trackEvents.length < 4) continue;

    let stylizedMatches = 0;
    let previousNormalized = '';
    let previousTime = 0;

    for (const event of trackEvents) {
      const rawText = getEventText(event);
      const cleanedText = cleanEventText(rawText);
      const normalizedText = normalizeStylizedText(rawText);

      if (!cleanedText || !normalizedText) continue;

      const hasStylizedMarkers = rawText.includes('/') || rawText.includes('\u200B');
      const isCloseInTime = previousNormalized.length > 0
        && event.tStartMs - previousTime <= STYLIZED_GAP_MS;
      const isDuplicateOrExpansion = isCloseInTime && (
        normalizedText === previousNormalized
        || normalizedText.startsWith(previousNormalized)
        || previousNormalized.startsWith(normalizedText)
      );

      if (hasStylizedMarkers && isDuplicateOrExpansion) {
        stylizedMatches += 1;
        if (stylizedMatches >= MIN_STYLIZED_MATCHES) return true;
      }

      previousNormalized = normalizedText;
      previousTime = event.tStartMs;
    }
  }

  return false;
}

function isScrollingAsrFormat(events: YoutubeTimedText[]): boolean {
  return events.some((event) => event.wWinId !== undefined && event.aAppend === 1);
}

// =============================================================================
// 内部：噪声过滤
// =============================================================================

const NOISE_PATTERNS = [
  /\[.*?\]/g, // [Music], [Applause], [Speaker 1]
  /\(.*?\)/g, // (Music), (Applause)
  /♪.*?♪/g, // ♪ Music ♪
  /🎵.*?🎵/g, // 🎵 Music 🎵
  /🎶.*?🎶/g, // 🎶 Music 🎶
];

function filterNoiseText(text: string): string {
  let result = text;
  for (const pattern of NOISE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

function filterNoiseFromEvents(events: YoutubeTimedText[]): YoutubeTimedText[] {
  return events.map((event) => {
    if (!event.segs) return event;

    const filteredSegs = event.segs
      .map((seg) => ({ ...seg, utf8: filterNoiseText(seg.utf8) }))
      .filter((seg) => seg.utf8.trim().length > 0);

    return { ...event, segs: filteredSegs };
  });
}

// =============================================================================
// 内部：格式分发处理
// =============================================================================

function processRawEvents(events: YoutubeTimedText[], languageCode: string): SubtitleFragment[] {
  const filteredEvents = filterNoiseFromEvents(events);
  const format = detectFormat(filteredEvents);

  switch (format) {
    case 'karaoke':
      return parseKaraokeSubtitles(filteredEvents);
    case 'karaoke-stylized':
      return parseStylizedKaraokeSubtitles(filteredEvents);
    case 'animated':
      return parseAnimatedSubtitles(filteredEvents);
    case 'scrolling-asr':
      return parseScrollingAsrSubtitles(filteredEvents, languageCode);
    default:
      return parseStandardSubtitles(filteredEvents);
  }
}

// =============================================================================
// 内部：标准字幕解析
// =============================================================================

interface SubtitleFragment {
  text: string;
  start: number;
  end: number;
}

function parseStandardSubtitles(events: YoutubeTimedText[] = []): SubtitleFragment[] {
  const segments: SubtitleFragment[] = [];
  let buffer: SubtitleFragment | null = null;

  events.forEach(({ segs = [], tStartMs = 0, dDurationMs = 0 }) => {
    segs.forEach(({ utf8 = '', tOffsetMs = 0 }, segIndex) => {
      const text = utf8.trim().replace(WHITESPACE_PATTERN, ' ');
      const start = tStartMs + tOffsetMs;

      if (buffer) {
        if (!buffer.end || buffer.end > start) {
          buffer.end = start;
        }
        segments.push(buffer);
        buffer = null;
      }

      buffer = {
        text,
        start,
        end: 0,
      };

      if (segIndex === segs.length - 1) {
        buffer.end = tStartMs + dDurationMs;
      }
    });
  });

  if (buffer) {
    segments.push(buffer);
  }

  return segments;
}

// =============================================================================
// 内部：滚动 ASR 字幕解析
// =============================================================================

function parseScrollingAsrSubtitles(
  events: YoutubeTimedText[],
  lang?: string,
): SubtitleFragment[] {
  const result: SubtitleFragment[] = [];
  const isSpaceSeparated = lang?.startsWith('en') || false;
  const isCJK = isCJKLanguage(lang);
  const maxLength = getMaxLength(isCJK);

  let currentText = '';
  let currentStart = 0;
  let lastSegEnd = 0;
  let isFirstSeg = true;
  let pendingSplit = false;

  function isSpecialTag(text: string): boolean {
    return text.startsWith('[') && text.endsWith(']');
  }

  function pushFragment(fragment: SubtitleFragment) {
    const last = result.at(-1);
    if (last && last.end > fragment.start) {
      last.end = fragment.start;
    }
    result.push(fragment);
  }

  function flushPendingFragment(): boolean {
    const trimmed = currentText.trim();
    if (trimmed && !isSpecialTag(trimmed)) {
      pushFragment({ text: trimmed, start: currentStart, end: lastSegEnd });
      return true;
    }
    return false;
  }

  for (const event of events) {
    if (event.aAppend === 1) {
      if (currentText) {
        lastSegEnd = event.tStartMs + (event.dDurationMs || 0);
        if (pendingSplit) {
          flushPendingFragment();
          currentText = '';
          isFirstSeg = true;
          pendingSplit = false;
        }
      }
      continue;
    }

    if (!event.segs || event.segs.length === 0) continue;

    if (pendingSplit && currentText) {
      flushPendingFragment();
      currentText = '';
      isFirstSeg = true;
      pendingSplit = false;
    }

    const segs = event.segs;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const text = seg.utf8 || '';
      const offsetMs = seg.tOffsetMs || 0;
      const segStart = event.tStartMs + offsetMs;

      if (pendingSplit && currentText) {
        flushPendingFragment();
        currentText = '';
        isFirstSeg = true;
        pendingSplit = false;
      }

      if (isFirstSeg && text.trim()) {
        currentStart = segStart;
        isFirstSeg = false;
      }

      if (isSpaceSeparated && currentText && text && i === 0) {
        const needsSpace = !currentText.endsWith(' ') && !text.startsWith(' ');
        if (needsSpace) {
          currentText += ' ';
        }
      }

      currentText += text;
      lastSegEnd = segStart + ESTIMATED_WORD_DURATION_MS;

      const isSentenceEnd = SENTENCE_END_PATTERN.test(text.trim());
      const textLength = getTextLength(currentText, isCJK);

      if (isSentenceEnd || textLength >= maxLength) {
        pendingSplit = true;
      }
    }
  }

  flushPendingFragment();
  return result;
}

// =============================================================================
// 内部：卡拉 OK 字幕解析
// =============================================================================

function cleanKaraokeText(text: string): string {
  return text
    .replace(ZERO_WIDTH_SPACE_PATTERN, '')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
}

function parseKaraokeSubtitles(events: YoutubeTimedText[]): SubtitleFragment[] {
  const posIds = new Set<number>();
  for (const event of events) {
    if (event.wpWinPosId !== undefined) {
      posIds.add(event.wpWinPosId);
    }
  }

  const mainTrackId = posIds.has(KANJI_TRACK_ID) ? KANJI_TRACK_ID : Math.max(...posIds);

  const merged: SubtitleFragment[] = [];
  for (const event of events) {
    if (event.wpWinPosId !== mainTrackId) continue;
    if (!event.segs || event.segs.length === 0) continue;

    const text = cleanKaraokeText(event.segs.map((seg) => seg.utf8 || '').join(''));
    if (!text) continue;

    const last = merged.at(-1);
    if (last && last.end > event.tStartMs) {
      last.end = event.tStartMs;
    }

    merged.push({
      text,
      start: event.tStartMs,
      end: event.tStartMs + (event.dDurationMs ?? 0),
    });
  }

  const result: SubtitleFragment[] = [];
  for (const fragment of merged) {
    const last = result.at(-1);
    if (last && last.text === fragment.text) {
      last.end = fragment.end;
    } else {
      result.push({ ...fragment });
    }
  }

  return result;
}

// =============================================================================
// 内部：样式化卡拉 OK 字幕解析
// =============================================================================

function parseStylizedKaraokeSubtitles(events: YoutubeTimedText[]): SubtitleFragment[] {
  interface TrackStats {
    trackId: number;
    eventCount: number;
    markerCount: number;
    textLength: number;
  }

  interface SentenceFamily {
    text: string;
    normalized: string;
    start: number;
    end: number;
    lastStart: number;
  }

  const FAMILY_GAP_MS = 1200;
  const MIN_PREFIX_LENGTH = 10;

  function selectMainTrack(): number | null {
    const statsByTrack = new Map<number, TrackStats>();

    for (const event of events) {
      if (event.wpWinPosId === undefined) continue;

      const rawText = getEventText(event);
      const cleanedText = cleanEventText(rawText);
      if (!cleanedText) continue;

      const current = statsByTrack.get(event.wpWinPosId) ?? {
        trackId: event.wpWinPosId,
        eventCount: 0,
        markerCount: 0,
        textLength: 0,
      };

      current.eventCount += 1;
      current.textLength += cleanedText.length;
      if (rawText.includes('/') || rawText.includes('\u200B')) {
        current.markerCount += 1;
      }

      statsByTrack.set(event.wpWinPosId, current);
    }

    const tracks = [...statsByTrack.values()];
    if (tracks.length === 0) return null;

    tracks.sort((left, right) => {
      if (right.eventCount !== left.eventCount) return right.eventCount - left.eventCount;
      if (right.markerCount !== left.markerCount) return right.markerCount - left.markerCount;
      if (right.textLength !== left.textLength) return right.textLength - left.textLength;
      return right.trackId - left.trackId;
    });

    return tracks[0].trackId;
  }

  function pushStylizedFragment(result: SubtitleFragment[], fragment: SubtitleFragment) {
    const last = result.at(-1);
    if (last && last.end > fragment.start) {
      last.end = fragment.start;
    }
    result.push(fragment);
  }

  function isSameSentenceFamily(current: SentenceFamily, text: string, start: number): boolean {
    if (start - current.lastStart > FAMILY_GAP_MS) return false;

    const nextNormalized = text.toLowerCase();
    if (nextNormalized === current.normalized) return true;

    const shorter = current.normalized.length <= nextNormalized.length ? current.normalized : nextNormalized;
    const longer = current.normalized.length <= nextNormalized.length ? nextNormalized : current.normalized;

    return shorter.length >= MIN_PREFIX_LENGTH && longer.startsWith(shorter);
  }

  function mergeFamilies(inputEvents: YoutubeTimedText[]): SubtitleFragment[] {
    const result: SubtitleFragment[] = [];
    let currentFamily: SentenceFamily | null = null;

    for (const event of inputEvents) {
      const text = cleanEventText(getEventText(event));
      if (!text) continue;

      const fragmentEnd = event.tStartMs + (event.dDurationMs ?? 0);

      if (!currentFamily) {
        currentFamily = {
          text,
          normalized: text.toLowerCase(),
          start: event.tStartMs,
          end: fragmentEnd,
          lastStart: event.tStartMs,
        };
        continue;
      }

      if (isSameSentenceFamily(currentFamily, text, event.tStartMs)) {
        currentFamily.end = fragmentEnd;
        currentFamily.lastStart = event.tStartMs;
        if (text.length > currentFamily.text.length) {
          currentFamily.text = text;
          currentFamily.normalized = text.toLowerCase();
        }
        continue;
      }

      pushStylizedFragment(result, {
        text: currentFamily.text,
        start: currentFamily.start,
        end: currentFamily.end,
      });

      currentFamily = {
        text,
        normalized: text.toLowerCase(),
        start: event.tStartMs,
        end: fragmentEnd,
        lastStart: event.tStartMs,
      };
    }

    if (currentFamily) {
      pushStylizedFragment(result, {
        text: currentFamily.text,
        start: currentFamily.start,
        end: currentFamily.end,
      });
    }

    return result;
  }

  function overlapsAny(start: number, end: number, intervals: SubtitleFragment[]): boolean {
    return intervals.some((interval) => start < interval.end && end > interval.start);
  }

  const mainTrackId = selectMainTrack();
  if (mainTrackId === null) return [];

  const mainFragments = mergeFamilies(
    events.filter((event) => event.wpWinPosId === mainTrackId),
  );

  const offTrackEvents = events.filter((event) => {
    if (event.wpWinPosId === mainTrackId) return false;
    if (!cleanEventText(getEventText(event))) return false;

    const start = event.tStartMs;
    const end = start + (event.dDurationMs ?? 0);
    return !overlapsAny(start, end, mainFragments);
  });

  const offFragments = mergeFamilies(offTrackEvents);

  const merged = [...mainFragments, ...offFragments].sort(
    (left, right) => left.start - right.start,
  );

  const result: SubtitleFragment[] = [];
  for (const fragment of merged) {
    pushStylizedFragment(result, { ...fragment });
  }

  return result;
}

// =============================================================================
// 内部：动画字幕解析
// =============================================================================

function parseAnimatedSubtitles(events: YoutubeTimedText[]): SubtitleFragment[] {
  const fragments: SubtitleFragment[] = [];

  for (const event of events) {
    const text = cleanEventText(getEventText(event));
    if (!text) continue;

    const start = event.tStartMs;
    const end = start + (event.dDurationMs ?? 0);
    const last = fragments.at(-1);

    if (last && last.text === text) {
      last.end = end;
    } else {
      if (last && last.end > start) {
        last.end = start;
      }
      fragments.push({ text, start, end });
    }
  }

  return fragments;
}
