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
  translationOverlay.style.display = 'flex';
}

/** 隐藏状态条（不销毁 DOM，下一次 showStatus 可复用）。 */
export function hideStatus(): void {
  if (translationOverlay) {
    translationOverlay.style.display = 'none';
  }
}

/**
 * HTML 转义工具：把 < > & " ' 转为实体。
 * 主要在 config panel 渲染用户输入时使用，避免 XSS。
 * （虽然当前 panel 用 textContent / 赋值 innerHTML 都有，但保留以备其他场景用）
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
