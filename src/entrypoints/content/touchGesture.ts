/**
 * 触屏手势：三击翻译。
 *
 * 桌面端通过 popup / 快捷键 / 右键菜单触发翻译；移动端（Firefox Android）
 * 没有传统桌面 UI，需要手势交互。固定使用 TripleTap 手势：
 *
 *   TripleTap（三击）：500ms 内连续 3 次单击 → 触发翻译
 *
 * 命中扩展自身 UI（配置面板 / 状态条）时不响应手势，避免误触。
 *
 * 注：Firefox / Chrome 触屏都遵循 TouchEvent 接口，无需 UA 区分。
 */

const TRIPLE_TAP_WINDOW_MS = 500;

/**
 * 注册全局 touchstart 监听器，固定使用 TripleTap 手势触发翻译。
 *
 * @param onTranslate 三击命中时调用（执行整页翻译）
 */
export function setupTouchEvents(onTranslate: () => Promise<void>): void {
  let tapCount = 0;
  let tapTimer: number | undefined;

  const handleTouchStart = (event: TouchEvent) => {
    const target = event.target as Element | null;
    // 命中扩展自身的 UI 时不响应手势
    if (
      target?.closest('.fanyi-config-panel') ||
      target?.closest('.fanyi-status-overlay')
    ) {
      return;
    }

    if (event.touches.length !== 1) return;
    tapCount++;
    if (tapCount === 1) {
      tapTimer = window.setTimeout(() => {
        tapCount = 0;
      }, TRIPLE_TAP_WINDOW_MS);
    } else if (tapCount === 3) {
      if (tapTimer) clearTimeout(tapTimer);
      tapCount = 0;
      try {
        event.preventDefault();
      } catch {
        /* passive listener 上 preventDefault 会抛，忽略 */
      }
      void onTranslate();
    }
  };

  // passive: false 是必须的，否则 preventDefault() 在触屏上无效
  document.body.addEventListener('touchstart', handleTouchStart, { passive: false });
}
