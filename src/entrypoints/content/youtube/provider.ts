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
 * 获取当前播放器的 playerResponse。
 *
 * YouTube 是 SPA，切视频时 URL 会立即变化，但 DOM 里的
 * <script>ytInitialPlayerResponse = {...}</script> 标签不会更新
 * （YouTube 用 AJAX 更新内容，不重新加载 <script>）。
 * 所以从 <script> 解析拿到的是页面初始加载时的数据，SPA 导航后是旧视频的。
 *
 * 解决方案：
 *   1. 优先用 movie_player.getPlayerResponse() — YouTube 播放器组件的实时 API，
 *      返回当前正在播放的视频数据（videoDetails.videoId 是实时的）
 *   2. 回退到 DOM <script> 标签解析 — 仅在首次加载或 movie_player 不可用时使用
 *
 * 注意：content script 的 JS 环境与 page 隔离，不能访问 window.ytInitialPlayerResponse，
 * 但可以访问 DOM 元素（movie_player）的方法，因为 DOM 是共享的。
 *
 * ⚠️ 本函数是同步的，SPA 导航后可能返回旧视频数据。
 *    调用方需要 videoId 匹配时，应使用异步的 fetchPlayerResponse()，
 *    它会在 DOM 失败时 fetch 当前页面 HTML 作为 fallback。
 */
export function extractYtInitialPlayerResponse(): any | null {
  // 1. 优先：movie_player.getPlayerResponse()（实时，SPA 友好）
  // 注意：content script 运行在 isolated world，JS 环境与 page 隔离。
  // 但 DOM 元素的方法通过原型链添加时（如 Polymer 组件），content script 可访问。
  // 如果 getPlayerResponse 不可用（undefined 或抛异常），回退到 DOM script 解析。
  try {
    const player = document.getElementById('movie_player') as any;
    if (player) {
      const fnType = typeof player.getPlayerResponse;
      if (fnType === 'function') {
        const resp = player.getPlayerResponse();
        if (resp && resp.videoDetails && resp.videoDetails.videoId) {
          console.log('[YouTubeCaptions] movie_player.getPlayerResponse() OK, videoId=' + resp.videoDetails.videoId);
          return resp;
        }
        console.log('[YouTubeCaptions] movie_player.getPlayerResponse() returned empty, falling back to DOM');
      } else {
        // getPlayerResponse 不是函数 — content script 的 isolated world 限制
        console.log('[YouTubeCaptions] movie_player exists but getPlayerResponse is ' + fnType + ' (isolated world limit), falling back to DOM');
      }
    } else {
      console.log('[YouTubeCaptions] movie_player element not found, falling back to DOM');
    }
  } catch (e) {
    console.log('[YouTubeCaptions] movie_player.getPlayerResponse() threw:', e, 'falling back to DOM');
  }

  // 2. 回退：从 DOM <script> 标签解析
  // ⚠️ SPA 导航后 <script> 里的 ytInitialPlayerResponse 不更新，videoId 可能是旧视频的。
  //    调用方需要 videoId 匹配时，应使用异步的 fetchPlayerResponse()。
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    const resp = extractPlayerResponseFromText(text);
    if (resp) return resp;
  }
  return null;
}

/**
 * 从文本中提取 ytInitialPlayerResponse JSON 对象（括号计数法）。
 *
 * 用于两种场景：
 *   1. DOM <script> 标签的 textContent
 *   2. fetch 当前页面 HTML 后的响应文本（SPA 导航后 DOM script 过期时的 fallback）
 */
function extractPlayerResponseFromText(text: string): any | null {
  const marker = 'ytInitialPlayerResponse';
  const markerIdx = text.indexOf(marker);
  if (markerIdx < 0) return null;

  // 找到 marker 后第一个 '{' 的位置
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
 * 获取当前视频的 playerResponse，确保 videoId 匹配。
 *
 * 三级策略：
 *   1. 轮询等待 movie_player.getPlayerResponse()（首选，实时数据，baseUrl 不过期）
 *      — YouTube SPA 导航后 movie_player 会重新初始化，等它出现后调用 getPlayerResponse()
 *      — 返回的 captionTracks.baseUrl 是实时的，不会因 SPA 导航而过期
 *   2. fetch 当前页面 HTML 作为 fallback（movie_player 一直不可用时）
 *      — 服务器返回的 HTML 基于当前 URL，包含正确的 ytInitialPlayerResponse
 *   3. DOM <script> 解析（最后兜底，SPA 后可能过期）
 *
 * ⚠️ 不再立即使用 DOM <script> 解析作为主路径：
 *    content script 注入时 movie_player 可能还没渲染，但 DOM <script> 里的
 *    ytInitialPlayerResponse 可能是旧视频的（SPA 不更新 <script>），
 *    导致 baseUrl 过期 → timedtext API 返回 200 + 空body。
 */
export async function fetchPlayerResponse(
  expectedVideoId: string,
): Promise<any | null> {
  // 1. 轮询等待 movie_player（最多 5 秒，每 200ms 检查一次）
  //    movie_player 通常在页面加载后几百毫秒内出现
  //    如果立即查找，YouTube 可能还没渲染播放器（content script 注入过早）
  const MAX_WAIT_MS = 5000;
  const POLL_INTERVAL_MS = 200;
  let waited = 0;

  while (waited < MAX_WAIT_MS) {
    try {
      const player = document.getElementById('movie_player') as any;
      if (player && typeof player.getPlayerResponse === 'function') {
        const resp = player.getPlayerResponse();
        const videoId = resp?.videoDetails?.videoId;
        if (videoId === expectedVideoId) {
          console.log('[YouTubeCaptions] playerResponse from movie_player, videoId=' + videoId + ', waited=' + waited + 'ms');
          return resp;
        }
        // videoId 不匹配：movie_player 还在切换，继续等
        if (videoId) {
          console.log('[YouTubeCaptions] movie_player videoId mismatch: expected=' + expectedVideoId + ', got=' + videoId + ', waiting...');
        }
      }
    } catch {
      // movie_player 不可用或 getPlayerResponse 抛异常，继续等
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    waited += POLL_INTERVAL_MS;
  }

  console.log('[YouTubeCaptions] movie_player not ready after ' + MAX_WAIT_MS + 'ms, trying fetch HTML fallback');

  // 2. Fallback: fetch 当前页面 HTML（movie_player 一直不可用时）
  //    服务器返回的 HTML 基于当前 URL，包含正确的 ytInitialPlayerResponse
  try {
    const resp = await fetch(window.location.href);
    const html = await resp.text();
    const fromHtml = extractPlayerResponseFromText(html);
    if (fromHtml) {
      const videoId = fromHtml?.videoDetails?.videoId;
      if (videoId === expectedVideoId) {
        console.log('[YouTubeCaptions] playerResponse from fetched HTML, videoId=' + videoId);
        return fromHtml;
      }
      console.log('[YouTubeCaptions] fetched HTML videoId mismatch: expected=' + expectedVideoId + ', got=' + videoId);
    } else {
      console.log('[YouTubeCaptions] playerResponse not found in fetched HTML');
    }
  } catch (e) {
    console.log('[YouTubeCaptions] fetch page HTML failed:', e);
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
 *
 * 关键：用 URL.searchParams.set 强制 fmt=json3，覆盖 baseUrl 可能已带的 fmt=srv3/vtt。
 * （字符串拼接 includes('fmt=') 检测会漏掉已有的非 json3 fmt，导致返回 XML 报错。）
 */
export async function fetchCaptions(
  trackUrl: string,
): Promise<CaptionEvent[]> {
  // 用 URL API 强制设置 fmt=json3，覆盖任何已有的 fmt 值
  let url: string;
  try {
    const parsed = new URL(trackUrl);
    parsed.searchParams.set('fmt', 'json3');
    url = parsed.toString();
  } catch {
    // URL 解析失败（理论上不会发生，baseUrl 总是合法 URL）
    url = trackUrl + (trackUrl.includes('fmt=') ? '' : '&fmt=json3');
  }

  console.log('[YouTubeCaptions] Fetching captions, URL:', url.substring(0, 200));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`字幕获取失败: HTTP ${response.status}`);
  }

  // 用 text() 而不是 json()，先拿到文本用于诊断
  // （response.json() 在 body 为空或 XML/HTML 时直接抛 "Unexpected end of JSON input"，
  //   看不到实际返回内容，无法定位问题）
  const text = await response.text();
  console.log('[YouTubeCaptions] Response:', {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bodyLength: text.length,
    bodyFirst300: text.substring(0, 300),
  });

  if (text.length === 0) {
    throw new Error('字幕获取失败: 响应为空（可能需要登录或视频无字幕）');
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      '字幕获取失败: JSON 解析失败 (content-type=' +
      response.headers.get('content-type') +
      ', bodyLength=' + text.length +
      ', first200="' + text.substring(0, 200) + '")',
    );
  }

  const events = data?.events;
  if (!Array.isArray(events)) {
    console.log('[YouTubeCaptions] No events array in response, top-level keys:', Object.keys(data || {}));
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
