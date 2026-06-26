/**
 * 屏幕底部居中显示的状态提示条（小气泡）。
 *
 * 用于在翻译流程中提示用户：
 *   - "正在提取文本..."
 *   - "翻译进度: 3/5"
 *   - "翻译完成"
 *   - "API Key 无效"
 *
 * 使用场景：
 *   - 任何需要"轻提示用户但不阻塞操作"的反馈
 *   - 默认 2-3 秒后自动隐藏（调用方控制 setTimeout）
 *
 * 注意：translationOverlay 缓存在模块级单例，因为页面同时只会显示一个气泡。
 */

let translationOverlay: HTMLElement | null = null;

export type StatusType = 'loading' | 'success' | 'error';

/**
 * 显示一条状态提示。如已存在则替换文案 + 颜色类。
 * 不会自动隐藏，需调用方在合适的时机调用 hideStatus()。
 */
export function showStatus(message: string, type: StatusType): void {
  if (!translationOverlay) {
    // 第一次调用：创建并挂到 body 末尾，避免被页面 transform/overflow 裁剪
    translationOverlay = document.createElement('div');
    translationOverlay.className = 'fanyi-status-overlay';
    document.body.appendChild(translationOverlay);
  }

  // 切换颜色类（loading=蓝边 / success=绿边 / error=红边，CSS 见 styles.ts）
  translationOverlay.className = `fanyi-status-overlay fanyi-${type}`;
  translationOverlay.textContent = message;
  // 防御：如果 overlay 被误标记为 data-fanyi-remove（hideBodyOverlays 的
  // [class*="overlay"] 选择器会匹配 .fanyi-status-overlay），移除该标记，
  // 否则 CSS 的 display:none !important 会覆盖下面的 flex。
  translationOverlay.removeAttribute('data-fanyi-remove');
  translationOverlay.style.setProperty('display', 'flex', 'important');
}

/** 隐藏状态条（不销毁 DOM，下一次 showStatus 可复用）。 */
export function hideStatus(): void {
  if (translationOverlay) {
    translationOverlay.style.display = 'none';
  }
}

/**
 * HTML 转义工具：把 < > & 转成实体。
 * 主要在 config panel 渲染用户输入时使用，避免 XSS。
 * 注：浏览器/JSdom 的 textContent→innerHTML 不会转义 " 和 '（它们在
 * 文本节点里不需要转义），所以本工具也只覆盖 < > & 三字符。
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 仅供单测使用：清空模块级单例缓存并移除已挂载的 overlay。
 * 模块在多次 showStatus 之间复用同一个 DOM 节点，单测需要隔离场景时
 * 调用此函数重置。生产代码不应调用。
 */
export function __resetStatusOverlayForTesting(): void {
  if (translationOverlay?.parentNode) {
    translationOverlay.parentNode.removeChild(translationOverlay);
  }
  translationOverlay = null;
}
