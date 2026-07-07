/**
 * 字幕 Provider：从 YouTube 页面获取字幕数据。
 *
 * 架构（按可靠性降级）：
 *   1. Innertube Provider：从 HTML 提取 API key/client，POST youtubei/v1/player
 *      — 不依赖 DOM 播放器，不依赖 movie_player API，SPA 友好
 *   2. DOM ytInitialPlayerResponse：从 <script> 标签解析（快但 SPA 后可能过期）
 *   3. ytcfg / ytplayer.config：从页面配置对象解析
 *   4. HTML fetch：向当前 URL 请求 HTML，解析 ytInitialPlayerResponse（兜底）
 *
 * 获取到 playerResponse 后：
 *   - getCaptionTrackUrl 选择最佳字幕 track（优先非 gemini）
 *   - fetchCaptions 请求 timedtext?fmt=json3 拿到完整字幕
 */
import type { CaptionEvent } from './types';

// =============================================================================
// 1. 提取 Innertube 配置
// =============================================================================

interface InnertubeConfig {
  apiKey: string;
  clientName: string;
  clientVersion: string;
  visitorData?: string;
}

/**
 * 从页面文本提取 Innertube 配置。
 *
 * YouTube 页面 HTML 和 <script> 里通常包含：
 *   "INNERTUBE_API_KEY":"AIza..."
 *   "INNERTUBE_CONTEXT_CLIENT_NAME":1
 *   "INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20250701.01.00"
 *   "VISITOR_DATA":"..."
 */
function extractInnertubeConfigFromText(text: string): InnertubeConfig | null {
  const apiKey = extractQuotedValue(text, 'INNERTUBE_API_KEY');
  const clientName = extractQuotedValue(text, 'INNERTUBE_CONTEXT_CLIENT_NAME') || extractQuotedValue(text, 'clientName');
  const clientVersion = extractQuotedValue(text, 'INNERTUBE_CONTEXT_CLIENT_VERSION') || extractQuotedValue(text, 'clientVersion');
  const visitorData = extractQuotedValue(text, 'VISITOR_DATA');

  if (!apiKey) return null;

  // ⚠️ 参考 youtube-transcript-api，默认使用 ANDROID client。
  // YouTube 的 WEB client 近年来对字幕接口限制很多（variant=gemini、fmt=json3 兼容性差、
  // 需要 PoToken 等），而 ANDROID client 返回的 captionTracks 更稳定。
  const finalClientName = clientName || 'ANDROID';
  const finalClientVersion = clientVersion || (finalClientName === 'ANDROID' ? '20.10.38' : '2.20250701.01.00');

  return {
    apiKey,
    clientName: finalClientName,
    clientVersion: finalClientVersion,
    visitorData: visitorData || undefined,
  };
}

function extractQuotedValue(text: string, key: string): string | null {
  // 支持 "KEY":"VALUE" 和 'KEY':'VALUE' 两种引号
  const patterns = [
    new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"'),
    new RegExp("'" + key + "'\\s*:\\s*'([^']*)'"),
    // 数字值："KEY":1
    new RegExp('"' + key + '"\\s*:\\s*([0-9]+)'),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1] || m[0];
  }
  return null;
}

/**
 * 从当前页面提取 Innertube 配置。
 *
 * 优先从 DOM <script> 标签提取（快），找不到时 fetch 当前页面 HTML 兜底。
 */
async function extractInnertubeConfig(): Promise<InnertubeConfig | null> {
  // 1. 从 DOM script 标签提取
  for (const script of document.querySelectorAll('script')) {
    const cfg = extractInnertubeConfigFromText(script.textContent || '');
    if (cfg) return cfg;
  }

  // 2. fallback：fetch 当前页面 HTML
  try {
    const resp = await fetch(window.location.href);
    const html = await resp.text();
    return extractInnertubeConfigFromText(html);
  } catch {
    return null;
  }
}

// =============================================================================
// 2. Innertube Provider：请求 youtubei/v1/player
// =============================================================================

/**
 * 方案1：通过 Innertube Player API（带 API key）获取 playerResponse。
 *
 * 参考 youtube-transcript-api：
 *   - URL: https://www.youtube.com/youtubei/v1/player?key=API_KEY
 *   - client: ANDROID（强制，不跟随页面 WEB client）
 *   - credentials: include
 */
export async function fetchInnertubePlayer(videoId: string): Promise<any | null> {
  const cfg = await extractInnertubeConfig();
  if (!cfg || !cfg.apiKey) return null;

  const clientName = 'ANDROID';
  const clientVersion = '20.10.38';
  const url = `https://www.youtube.com/youtubei/v1/player?key=${cfg.apiKey}`;
  const body = {
    context: {
      client: {
        clientName,
        clientVersion,
        ...(cfg.visitorData ? { visitorData: cfg.visitorData } : {}),
      },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': clientName,
        'X-YouTube-Client-Version': clientVersion,
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      console.warn('[YouTubeCaptions] Innertube v1 HTTP', response.status, text.substring(0, 120));
      return null;
    }

    const data = JSON.parse(text);
    const respVideoId = data?.videoDetails?.videoId;
    if (respVideoId === videoId) {
      console.log('[YouTubeCaptions] playerResponse from Innertube v1');
      return data;
    }
    console.warn('[YouTubeCaptions] Innertube v1 no videoId, got:', Object.keys(data).slice(0, 8).join(','));
    return null;
  } catch (e) {
    console.warn('[YouTubeCaptions] Innertube v1 failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 方案2：通过 Innertube Player API（不带 API key，带 Android User-Agent）获取 playerResponse。
 *
 * 参考 Kakulukian/youtube-transcript：
 *   - URL: https://www.youtube.com/youtubei/v1/player?prettyPrint=false
 *   - client: ANDROID 20.10.38
 *   - User-Agent: com.google.android.youtube/20.10.38 (Linux; U; Android 14)
 *   - 不需要从 HTML 提取 API key
 */
export async function fetchInnertubePlayerV2(videoId: string): Promise<any | null> {
  const clientName = 'ANDROID';
  const clientVersion = '20.10.38';
  const url = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const body = {
    context: {
      client: { clientName, clientVersion },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `com.google.android.youtube/${clientVersion} (Linux; U; Android 14)`,
        'X-YouTube-Client-Name': clientName,
        'X-YouTube-Client-Version': clientVersion,
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      console.warn('[YouTubeCaptions] Innertube v2 HTTP', response.status, text.substring(0, 120));
      return null;
    }

    const data = JSON.parse(text);
    const respVideoId = data?.videoDetails?.videoId;
    if (respVideoId === videoId) {
      console.log('[YouTubeCaptions] playerResponse from Innertube v2');
      return data;
    }
    console.warn('[YouTubeCaptions] Innertube v2 no videoId, got:', Object.keys(data).slice(0, 8).join(','));
    return null;
  } catch (e) {
    console.warn('[YouTubeCaptions] Innertube v2 failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

// =============================================================================
// 3. DOM / HTML playerResponse 提取（降级方案）
// =============================================================================

/**
 * 从文本中提取 ytInitialPlayerResponse JSON 对象（括号计数法）。
 */
function extractPlayerResponseFromText(text: string): any | null {
  const marker = 'ytInitialPlayerResponse';
  const markerIdx = text.indexOf(marker);
  if (markerIdx < 0) return null;

  let jsonStart = -1;
  for (let i = markerIdx + marker.length; i < text.length; i++) {
    if (text[i] === '{') {
      jsonStart = i;
      break;
    }
  }
  if (jsonStart < 0) return null;

  const jsonStr = extractJSONObject(text, jsonStart);
  if (!jsonStr) return null;

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * 从 DOM <script> 标签提取 ytInitialPlayerResponse。
 *
 * ⚠️ SPA 导航后 <script> 里的 ytInitialPlayerResponse 不会更新，可能是旧视频数据。
 */
function extractYtInitialPlayerResponseFromDom(): any | null {
  for (const script of document.querySelectorAll('script')) {
    const resp = extractPlayerResponseFromText(script.textContent || '');
    if (resp) return resp;
  }
  return null;
}

/**
 * 从页面配置对象提取 playerResponse（ytcfg / ytplayer.config）。
 */
function extractPlayerResponseFromPageConfig(): any | null {
  // 从页面脚本里找 ytcfg.set('PLAYER_CONFIG', ...) 或 ytcfg.d()
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';

    // ytplayer.config.args.player_response
    const marker = 'ytplayer.config';
    const idx = text.indexOf(marker);
    if (idx >= 0) {
      const prIdx = text.indexOf('player_response', idx);
      if (prIdx >= 0) {
        const json = extractJSONObject(text, text.indexOf('{', prIdx));
        if (json) {
          try {
            return JSON.parse(json);
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return null;
}

/**
 * 获取当前视频的 playerResponse，确保 videoId 匹配。
 *
 * 降级链：
 *   1. Innertube API v1（带 API key，参考 youtube-transcript-api）
 *   2. Innertube API v2（不带 API key + Android UA，参考 Kakulukian/youtube-transcript）
 *   3. DOM ytInitialPlayerResponse（同步，快但可能过期）
 *   4. 页面配置 ytcfg / ytplayer.config
 *   5. fetch 当前页面 HTML 并解析
 */
export async function fetchPlayerResponse(
  expectedVideoId: string,
): Promise<any | null> {
  // 1. Innertube API v1
  const fromInnertube = await fetchInnertubePlayer(expectedVideoId);
  if (fromInnertube) return fromInnertube;

  // 2. Innertube API v2
  const fromInnertubeV2 = await fetchInnertubePlayerV2(expectedVideoId);
  if (fromInnertubeV2) return fromInnertubeV2;

  // 3. DOM ytInitialPlayerResponse（同步，快）
  const fromDom = extractYtInitialPlayerResponseFromDom();
  if (fromDom?.videoDetails?.videoId === expectedVideoId) {
    console.log('[YouTubeCaptions] playerResponse from DOM');
    return fromDom;
  }

  // 4. 页面配置对象
  const fromConfig = extractPlayerResponseFromPageConfig();
  if (fromConfig?.videoDetails?.videoId === expectedVideoId) {
    console.log('[YouTubeCaptions] playerResponse from page config');
    return fromConfig;
  }

  // 5. fetch 当前页面 HTML（兜底）
  try {
    const resp = await fetch(window.location.href);
    const html = await resp.text();
    const fromHtml = extractPlayerResponseFromText(html);
    if (fromHtml?.videoDetails?.videoId === expectedVideoId) {
      console.log('[YouTubeCaptions] playerResponse from fetched HTML');
      return fromHtml;
    }
  } catch (e) {
    console.warn('[YouTubeCaptions] fetch HTML failed:', e instanceof Error ? e.message : e);
  }

  return null;
}

/**
 * 从 text 的 start 位置提取完整的 JSON 对象（括号计数法）。
 * 处理字符串内的 `{` `}` 和转义字符。
 */
export function extractJSONObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// =============================================================================
// 2. 获取字幕 track URL
// =============================================================================

/**
 * 从 playerResponse 获取字幕 track URL。
 *
 * 优先选择英语字幕（languageCode === 'en'），否则取第一个。
 * 返回 baseUrl（已含基础参数，追加 &fmt=json3 即可请求 JSON3 格式）。
 */
export function getCaptionTrackUrl(
  playerResponse: any,
  preferLang = 'en',
): string | null {
  const tracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !Array.isArray(tracks) || tracks.length === 0) return null;

  // ⚠️ 优先选择非 variant=gemini 的 track
  // YouTube 的 Gemini 自动字幕（variant=gemini）不支持 fmt=json3，
  // 强制请求会返回 200 + text/html + 空body。
  // 优先选择顺序：
  //   1. 指定语言 + 非 gemini
  //   2. 任意非 gemini
  //   3. 指定语言（即使是 gemini）
  //   4. 第一条 track
  const isGemini = (t: any) => {
    const url = t.baseUrl || '';
    return url.includes('variant=gemini');
  };

  let track =
    tracks.find((t: any) => t.languageCode === preferLang && !isGemini(t)) ||
    tracks.find((t: any) => !isGemini(t)) ||
    tracks.find((t: any) => t.languageCode === preferLang) ||
    tracks[0];

  return track?.baseUrl || null;
}

// =============================================================================
// 3. 请求字幕（JSON3 格式）
// =============================================================================

/**
 * 请求 timedtext API 获取字幕。
 *
 * 参考 youtube-transcript-api + Kakulukian/youtube-transcript：
 *   1. 不强制设置 fmt=json3，而是移除 baseUrl 中已有的 fmt 参数。
 *      YouTube 默认返回的格式通常是可用的 JSON3 或 XML3。
 *   2. credentials: 'include' 带上页面的 Cookie。
 *   3. 根据响应 content-type 自动解析 JSON 或 XML。
 *   4. 如果默认请求拿不到字幕，用桌面 User-Agent 重试一次（Kakulukian 的做法）。
 *
 * JSON3 格式：
 *   { "events": [{ "tStartMs": 1234, "dDurationMs": 2500, "segs": [{ "utf8": "Hello" }] }] }
 *
 * XML 格式（srv3）：
 *   <transcript><text start="1.234" dur="2.5">Hello</text>...</transcript>
 */
export async function fetchCaptions(
  trackUrl: string,
): Promise<CaptionEvent[]> {
  // 参考 youtube-transcript-api：移除 baseUrl 中的 fmt 参数，不强制指定格式
  let url: string;
  try {
    const parsed = new URL(trackUrl);
    parsed.searchParams.delete('fmt');
    url = parsed.toString();
  } catch {
    // URL 解析失败（理论上不会发生，baseUrl 总是合法 URL）
    url = trackUrl.replace(/[?&]fmt=[^&]*/g, '');
  }

  // 方案 A：默认请求（带 Cookie，无特殊 User-Agent）
  const eventsA = await fetchCaptionsOnce(url, {});
  if (eventsA.length > 0) {
    console.log('[YouTubeCaptions] Captions loaded:', eventsA.length);
    return eventsA;
  }

  // 方案 B：带桌面 User-Agent 重试（参考 Kakulukian/youtube-transcript）
  console.warn('[YouTubeCaptions] Default fetch no captions, retrying with desktop UA');
  const eventsB = await fetchCaptionsOnce(url, {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)',
  });
  if (eventsB.length > 0) {
    console.log('[YouTubeCaptions] Captions loaded (desktop UA):', eventsB.length);
    return eventsB;
  }

  throw new Error('字幕获取失败: 默认请求和带 User-Agent 重试均未返回有效字幕');
}

/**
 * 单次 timedtext 请求。
 */
async function fetchCaptionsOnce(
  url: string,
  extraHeaders: Record<string, string>,
): Promise<CaptionEvent[]> {
  const response = await fetch(url, {
    credentials: 'include',
    ...(Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {}),
  });
  if (!response.ok) {
    throw new Error(`字幕获取失败: HTTP ${response.status}`);
  }

  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  if (text.length === 0) {
    return [];
  }

  // 自动检测格式：JSON 或 XML
  const isJson = contentType.includes('json') || text.trimStart().startsWith('{');
  const events = isJson ? parseJson3Captions(text) : parseXmlCaptions(text);
  return events.filter((e: CaptionEvent) => e.text.length > 0);
}

/** 解析 JSON3 格式字幕。 */
function parseJson3Captions(text: string): CaptionEvent[] {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('字幕获取失败: JSON 解析失败');
  }

  const events = data?.events;
  if (!Array.isArray(events)) {
    console.log('[YouTubeCaptions] No events array in JSON3 response, top-level keys:', Object.keys(data || {}));
    return [];
  }

  return events
    .filter((e: any) => e.segs && Array.isArray(e.segs))
    .map((e: any) => ({
      startMs: e.tStartMs || 0,
      durationMs: e.dDurationMs || 0,
      text: e.segs
        .map((s: any) => s.utf8 || '')
        .join('')
        .trim(),
    }));
}

/** 解析 XML 格式字幕（支持 srv3 和 classic 两种格式，并解码 HTML entities）。
 *
 * srv3 格式：
 *   <p t="1234" d="2500"><s>Hello</s> <s>world</s></p>
 *
 * classic 格式：
 *   <text start="1.234" dur="2.5">Hello world</text>
 */
function parseXmlCaptions(text: string): CaptionEvent[] {
  const decoded = decodeHtmlEntities(text);

  // 1. 先尝试 srv3 格式 <p t="ms" d="ms">...</p>
  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  const events: CaptionEvent[] = [];
  let match: RegExpExecArray | null;

  while ((match = pRegex.exec(decoded)) !== null) {
    const startMs = parseInt(match[1], 10);
    const durationMs = parseInt(match[2], 10);
    const inner = match[3];

    // 提取 <s> 标签内文本
    let content = '';
    const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sRegex.exec(inner)) !== null) {
      content += sMatch[1];
    }
    // 如果没有 <s> 标签，直接去掉所有标签
    if (!content) {
      content = inner.replace(/<[^>]+>/g, '');
    }

    content = content.trim();
    if (content) {
      events.push({ startMs, durationMs, text: content });
    }
  }

  if (events.length > 0) return events;

  // 2. 回退到 classic 格式 <text start="s" dur="s">content</text>
  const parser = new DOMParser();
  const doc = parser.parseFromString(decoded, 'text/xml');
  const textNodes = doc.querySelectorAll('text');

  textNodes.forEach((node) => {
    const startSec = parseFloat(node.getAttribute('start') || '0');
    const durSec = parseFloat(node.getAttribute('dur') || '0');
    const content = node.textContent || '';
    if (content.trim()) {
      events.push({
        startMs: Math.round(startSec * 1000),
        durationMs: Math.round(durSec * 1000),
        text: content.trim(),
      });
    }
  });

  return events;
}

/** 解码常见 HTML entities。 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// =============================================================================
// 4. videoId 提取
// =============================================================================

/**
 * 从 URL 提取 YouTube videoId。
 *
 * YouTube watch URL 格式：`https://www.youtube.com/watch?v=VIDEO_ID`
 * 用于内存缓存的 key 和 SPA 导航检测。
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
