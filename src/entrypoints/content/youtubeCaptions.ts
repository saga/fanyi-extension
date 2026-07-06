/**
 * YouTube 字幕翻译模块（独立于整页翻译流程）。
 *
 * 架构（参考用户方案）：
 *   YouTube Page → Extract Caption Track → Subtitle Stream
 *   → Translation Pipeline → Translation Cache → Overlay Renderer → Display
 *
 * 1. 从页面 <script> 提取 ytInitialPlayerResponse（content script 无法
 *    直接访问 window.ytInitialPlayerResponse，需从 DOM 解析）
 * 2. 从 captionTracks 获取字幕 track URL
 * 3. 请求 timedtext API (fmt=json3) 获取完整字幕
 * 4. 批量翻译（direct deepseek，简化 prompt，跳过 glossary）
 * 5. CaptionOverlay 监听 video.timeupdate，按时间轴显示译文
 *
 * 为什么独立模块：
 *   - 字幕是动态 DOM（每几秒变化），整页翻译流程不适合
 *   - 字幕有时间轴信息，需要按时间显示
 *   - 字幕是短文本口语化内容，需要专门的简化 prompt
 */

// =============================================================================
// 类型
// =============================================================================

export interface CaptionEvent {
  /** 开始时间（毫秒） */
  startMs: number;
  /** 持续时间（毫秒） */
  durationMs: number;
  /** 原文字幕文本 */
  text: string;
  /** 译文字幕文本（翻译完成后填充） */
  translatedText?: string;
}

// =============================================================================
// JSON 清理工具（内联，避免依赖 vocal-saga 的 shared.ts）
// =============================================================================

function stripThinkingTags(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  result = result.replace(/<think>[\s\S]*$/gi, '');
  return result.trim();
}

function stripMarkdownCodeBlock(text: string): string {
  let result = text.trim();
  result = result.replace(/^```(?:json)?\s*\n?/i, '');
  result = result.replace(/\n?```\s*$/i, '');
  return result.trim();
}

function repairTruncatedJson(text: string): string {
  let result = text.trim();
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    if (ch === '[') bracketDepth++;
    if (ch === ']') bracketDepth--;
  }
  if (inString) result += '"';
  for (let i = 0; i < bracketDepth; i++) result += ']';
  for (let i = 0; i < braceDepth; i++) result += '}';
  return result;
}


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
// 4. 批量翻译字幕
// =============================================================================

const CAPTION_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const CAPTION_MODEL = 'deepseek-v4-flash';

/**
 * 字幕专用简化 system prompt。
 *
 * 比通用 prompt 短 ~80 tokens，针对字幕特点：
 * - 短文本、口语化
 * - 保持时间轴顺序（id 即顺序）
 * - 不需要术语表 / 站点规则
 */
const CAPTION_SYSTEM_PROMPT = `Translate English subtitles to Simplified Chinese.

1. Return {"translations":[{"id":"0","translated_text":"译文"}]}. One entry per subtitle, same ids.
2. Translate naturally and concisely. Subtitles are spoken language — use colloquial Chinese.
3. Keep numbers, URLs, and code unchanged.
4. Keep each subtitle short — match the original's brevity.`;

interface TranslationEntry {
  id: string;
  translated_text: string;
}

/**
 * 调用 DeepSeek API 翻译一批字幕。返回 id → translated_text 的映射。
 */
async function callCaptionApi(
  apiKey: string,
  blocks: Array<{ id: string; text: string }>,
): Promise<Map<string, string>> {
  const blocksJson = JSON.stringify(blocks, null, 2);
  const maxTokens = Math.max(1024, Math.ceil(blocksJson.length * 0.5 * 4));

  const body = {
    model: CAPTION_MODEL,
    messages: [
      { role: 'system' as const, content: CAPTION_SYSTEM_PROMPT },
      { role: 'user' as const, content: `JSON:\n\n${blocksJson}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    stream: false,
  };

  const response = await fetch(CAPTION_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`DeepSeek API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek 返回了无效响应: 缺少 choices[0].message.content');
  }

  let cleaned = stripThinkingTags(content);
  cleaned = stripMarkdownCodeBlock(cleaned);
  try {
    const parsed = JSON.parse(cleaned);
    const translations: TranslationEntry[] = parsed.translations || [];
    const map = new Map<string, string>();
    for (const t of translations) {
      if (t.id != null && t.translated_text != null) {
        map.set(t.id, t.translated_text);
      }
    }
    return map;
  } catch {
    const repaired = repairTruncatedJson(cleaned);
    try {
      const parsed = JSON.parse(repaired);
      const translations: TranslationEntry[] = parsed.translations || [];
      const map = new Map<string, string>();
      for (const t of translations) {
        if (t.id != null && t.translated_text != null) {
          map.set(t.id, t.translated_text);
        }
      }
      return map;
    } catch {
      console.error('[YouTubeCaptions] Failed to parse translation:', cleaned.substring(0, 200));
      return new Map();
    }
  }
}

/**
 * 把字幕分批翻译。
 *
 * 分批策略：每批最多 50 条字幕（约 2000-3000 tokens），避免单次请求过大。
 * 串行发送（不并行），因为字幕翻译是低延迟场景，并行容易触发 rate limit。
 *
 * 翻译结果直接填充到 CaptionEvent.translatedText。
 */
export async function translateCaptions(
  captions: CaptionEvent[],
  apiKey: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (captions.length === 0) return;

  const BATCH_SIZE = 50;
  let done = 0;

  for (let i = 0; i < captions.length; i += BATCH_SIZE) {
    const batch = captions.slice(i, i + BATCH_SIZE);
    const blocks = batch.map((c, idx) => ({
      id: String(i + idx),
      text: c.text,
    }));

    const resultMap = await callCaptionApi(apiKey, blocks);

    // 回填翻译结果
    for (const c of batch) {
      // 找到对应的翻译结果
      const idx = captions.indexOf(c);
      const id = String(idx);
      const translated = resultMap.get(id);
      if (translated) {
        c.translatedText = translated;
      }
    }

    done += batch.length;
    onProgress?.(done, captions.length);
  }
}

// =============================================================================
// 5. CaptionOverlay — 监听视频时间，显示译文
// =============================================================================

const OVERLAY_ID = 'fanyi-caption-overlay';

/**
 * 字幕 Overlay 渲染器。
 *
 * 监听 <video> 的 timeupdate 事件，按当前播放时间找到对应字幕，
 * 在视频底部显示双语字幕（原文 + 译文）。
 *
 * 定位：absolute，挂在视频的父容器上（.html5-video-player）。
 * 样式：半透明黑底白字，居中底部，不遮挡 YouTube 原生字幕。
 */
export class CaptionOverlay {
  private video: HTMLVideoElement | null = null;
  private captions: CaptionEvent[] = [];
  private overlayEl: HTMLElement | null = null;
  private timeUpdateHandler: (() => void) | null = null;
  private lastShownIdx = -1;

  /**
   * 初始化字幕 Overlay。
   *
   * @returns 是否成功找到视频元素并初始化
   */
  start(captions: CaptionEvent[]): boolean {
    this.captions = captions;
    this.video = document.querySelector('video.html5-main-video') ||
                  document.querySelector('video');

    if (!this.video) {
      console.log('[YouTubeCaptions] No <video> element found');
      return false;
    }

    this.createOverlay();

    this.timeUpdateHandler = () => this.update();
    this.video.addEventListener('timeupdate', this.timeUpdateHandler);
    return true;
  }

  /** 停止监听并移除 Overlay。 */
  stop(): void {
    if (this.timeUpdateHandler && this.video) {
      this.video.removeEventListener('timeupdate', this.timeUpdateHandler);
    }
    this.timeUpdateHandler = null;
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.video = null;
    this.captions = [];
    this.lastShownIdx = -1;
  }

  /** 是否已翻译完成。 */
  isReady(): boolean {
    return this.captions.length > 0 && this.captions.some(c => c.translatedText);
  }

  private createOverlay(): void {
    // 移除已有 overlay
    document.getElementById(OVERLAY_ID)?.remove();

    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.style.cssText = [
      'position: absolute',
      'bottom: 60px',
      'left: 50%',
      'transform: translateX(-50%)',
      'max-width: 90%',
      'padding: 6px 12px',
      'background: rgba(0, 0, 0, 0.75)',
      'color: #fff',
      'font-size: 16px',
      'line-height: 1.4',
      'text-align: center',
      'border-radius: 4px',
      'pointer-events: none',
      'z-index: 9999',
      'display: none',
    ].join('; ');

    // 挂到视频播放器容器上
    const player = document.querySelector('.html5-video-player');
    (player || document.body).appendChild(el);
    this.overlayEl = el;
  }

  private update(): void {
    if (!this.video || !this.overlayEl) return;

    const currentMs = this.video.currentTime * 1000;

    // 找当前时间的字幕（用 lastShownIdx 优化：大部分时候是连续的）
    let idx = -1;
    // 先检查上次附近的位置（优化：字幕是按时间排序的）
    if (
      this.lastShownIdx >= 0 &&
      this.lastShownIdx < this.captions.length
    ) {
      const c = this.captions[this.lastShownIdx];
      if (currentMs >= c.startMs && currentMs < c.startMs + c.durationMs) {
        idx = this.lastShownIdx;
      }
    }

    if (idx < 0) {
      // 线性查找（字幕不多，通常 < 1000 条）
      for (let i = 0; i < this.captions.length; i++) {
        const c = this.captions[i];
        if (currentMs >= c.startMs && currentMs < c.startMs + c.durationMs) {
          idx = i;
          break;
        }
      }
    }

    if (idx < 0) {
      this.overlayEl.style.display = 'none';
      this.lastShownIdx = -1;
      return;
    }

    if (idx === this.lastShownIdx) return; // 同一条字幕，不更新 DOM

    this.lastShownIdx = idx;
    const caption = this.captions[idx];

    if (caption.translatedText) {
      // 双语显示：原文 + 译文
      this.overlayEl.innerHTML = '';
      const orig = document.createElement('div');
      orig.textContent = caption.text;
      orig.style.opacity = '0.7';
      orig.style.fontSize = '14px';
      const trans = document.createElement('div');
      trans.textContent = caption.translatedText;
      this.overlayEl.appendChild(orig);
      this.overlayEl.appendChild(trans);
      this.overlayEl.style.display = 'block';
    } else {
      // 译文还没翻好，只显示原文
      this.overlayEl.textContent = caption.text;
      this.overlayEl.style.display = 'block';
    }
  }
}

// =============================================================================
// 顶层编排：startYouTubeCaptionTranslation
// =============================================================================

/**
 * 检测当前页面是否是 YouTube 视频播放页（/watch?v=...）。
 *
 * 用于决定是否启动字幕翻译。YouTube 首页、搜索页、频道页不启动。
 *
 * @param url 可选 URL，默认用 window.location.href（测试时可传入 mock URL）
 */
export function isYouTubeWatchPage(url: string = typeof window !== 'undefined' ? window.location.href : ''): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== 'www.youtube.com') return false;
  return parsed.searchParams.has('v');
}

/**
 * 启动 YouTube 字幕翻译完整流程。
 *
 * 1. 提取 ytInitialPlayerResponse
 * 2. 获取字幕 track URL
 * 3. 请求字幕
 * 4. 批量翻译
 * 5. 启动 CaptionOverlay
 *
 * @param apiKey DeepSeek API Key
 * @param onStatus 状态回调（用于 UI 显示进度）
 * @returns 是否成功启动
 */
export async function startYouTubeCaptionTranslation(
  apiKey: string,
  onStatus?: (msg: string, type: 'loading' | 'success' | 'error') => void,
): Promise<boolean> {
  onStatus?.('正在提取字幕信息...', 'loading');

  // 1. 提取 playerResponse
  const playerResponse = extractYtInitialPlayerResponse();
  if (!playerResponse) {
    onStatus?.('未找到视频字幕数据（可能不是视频页）', 'error');
    return false;
  }

  // 2. 获取字幕 track URL
  const trackUrl = getCaptionTrackUrl(playerResponse);
  if (!trackUrl) {
    onStatus?.('该视频没有字幕', 'error');
    return false;
  }

  // 3. 请求字幕
  onStatus?.('正在获取字幕...', 'loading');
  let captions: CaptionEvent[];
  try {
    captions = await fetchCaptions(trackUrl);
  } catch (e) {
    onStatus?.(`字幕获取失败: ${e instanceof Error ? e.message : e}`, 'error');
    return false;
  }

  if (captions.length === 0) {
    onStatus?.('字幕内容为空', 'error');
    return false;
  }

  // 4. 批量翻译
  onStatus?.(`正在翻译字幕 (0/${captions.length})...`, 'loading');
  try {
    await translateCaptions(captions, apiKey, (done, total) => {
      onStatus?.(`正在翻译字幕 (${done}/${total})...`, 'loading');
    });
  } catch (e) {
    onStatus?.(`字幕翻译失败: ${e instanceof Error ? e.message : e}`, 'error');
    return false;
  }

  // 5. 启动 Overlay
  const overlay = new CaptionOverlay();
  const started = overlay.start(captions);
  if (!started) {
    onStatus?.('未找到视频播放器', 'error');
    return false;
  }

  const translated = captions.filter(c => c.translatedText).length;
  onStatus?.(`字幕翻译完成 (${translated}/${captions.length})`, 'success');
  return true;
}
