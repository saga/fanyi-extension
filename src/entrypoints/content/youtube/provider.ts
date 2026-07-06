/**
 * 字幕 Provider：从 YouTube 页面获取字幕数据。
 *
 * 职责：
 *   1. 从页面 <script> 标签提取 ytInitialPlayerResponse
 *      （content script 运行在隔离 JS 环境，不能直接访问 window.ytInitialPlayerResponse）
 *   2. 从 captionTracks 选择字幕 track（优先英语）
 *   3. 请求 timedtext API (fmt=json3) 获取完整字幕
 *
 * 不变：保留 DOM 解析方式（用户决策），后续迭代可考虑 yt-navigate-finish 事件 +
 * timedtext 网络请求拦截作为回退（问题 10）。
 */
import type { CaptionEvent } from './types';

// =============================================================================
// 1. 提取 ytInitialPlayerResponse
// =============================================================================

/**
 * 从页面 <script> 标签提取 ytInitialPlayerResponse。
 *
 * content script 运行在隔离的 JS 环境中，不能直接访问
 * window.ytInitialPlayerResponse，需要从 DOM 的 <script> 标签解析。
 *
 * YouTube 页面的 <script> 里有 `ytInitialPlayerResponse = {...};` 赋值。
 * 用括号计数提取完整 JSON 对象（正则无法匹配嵌套大括号）。
 */
export function extractYtInitialPlayerResponse(): any | null {
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    const marker = 'ytInitialPlayerResponse';
    const markerIdx = text.indexOf(marker);
    if (markerIdx < 0) continue;

    // 找到 marker 后第一个 '{' 的位置
    let jsonStart = -1;
    for (let i = markerIdx + marker.length; i < text.length; i++) {
      if (text[i] === '{') {
        jsonStart = i;
        break;
      }
    }
    if (jsonStart < 0) continue;

    const jsonStr = extractJSONObject(text, jsonStart);
    if (jsonStr) {
      try {
        return JSON.parse(jsonStr);
      } catch {
        // JSON 解析失败，继续找下一个 script 标签
      }
    }
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

  const preferred = tracks.find(
    (t: any) => t.languageCode === preferLang,
  );
  const track = preferred || tracks[0];
  return track?.baseUrl || null;
}

// =============================================================================
// 3. 请求字幕（JSON3 格式）
// =============================================================================

/**
 * 请求 timedtext API 获取字幕。
 *
 * YouTube timedtext API (fmt=json3) 返回格式：
 * {
 *   "events": [
 *     { "tStartMs": 1234, "dDurationMs": 2500, "segs": [{ "utf8": "Hello" }] }
 *   ]
 * }
 *
 * 同源请求（youtube.com → youtube.com/api/timedtext），content script 可直接 fetch。
 */
export async function fetchCaptions(
  trackUrl: string,
): Promise<CaptionEvent[]> {
  const url =
    trackUrl + (trackUrl.includes('fmt=') ? '' : '&fmt=json3');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`字幕获取失败: HTTP ${response.status}`);
  }

  const data = await response.json();
  const events = data?.events;
  if (!Array.isArray(events)) return [];

  return events
    .filter((e: any) => e.segs && Array.isArray(e.segs))
    .map((e: any) => ({
      startMs: e.tStartMs || 0,
      durationMs: e.dDurationMs || 0,
      text: e.segs
        .map((s: any) => s.utf8 || '')
        .join('')
        .trim(),
    }))
    .filter((e: CaptionEvent) => e.text.length > 0);
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
