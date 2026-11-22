/**
 * 触屏手势：三击翻译。
 *
 * 移动端（Firefox Android / 平板）没有 popup 和右键菜单，三击是快捷入口；
 * 稳定入口由 ./mobileControls 的悬浮按钮提供，手势失败不影响使用。
 *
 * 检测方式：pointerdown / pointermove / pointerup。
 *   - 每次点击的窗口单独计时（从该击开始 600ms），平板手指移动慢也不会中途清零；
 *   - 位移超过 15px 视为滚动，不计为点击；
 *   - 多指同时落下直接放弃本轮，避免手掌误触；
 *   - 第三击命中后阻止随后的 click（链接跳转、双击放大、选词），并清空文本选区。
 *
 * 不监听 touchstart 的原因：触控笔 / 平板外接鼠标不产生 touch 事件，
 * 且 touchstart 无法区分点击与滚动。Pointer Events 统一三种输入。
 */

const TRIPLE_TAP_WINDOW_MS = 600;
const TAP_MOVE_TOLERANCE_PX = 15;
const TAP_MAX_DURATION_MS = 700;
const CLICK_SUPPRESS_MS = 400;

/** 扩展自身 UI 不参与手势，避免点悬浮按钮/面板时误触发。 */
function isExtensionUi(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('.fanyi-config-panel') !== null
    || target.closest('.fanyi-status-overlay') !== null
    || target.closest('.fanyi-floating-btn') !== null;
}

/**
 * 注册全局 Pointer Events 监听器，三击命中时调用 onTranslate。
 * 返回清理函数，便于卸载与测试隔离。
 */
export function setupTouchEvents(onTranslate: () => Promise<void>): () => void {
  let tapCount = 0;
  let tapTimer: number | undefined;
  let activePointerId: number | null = null;
  let start: { x: number; y: number; time: number } | null = null;
  let moved = false;
  let suppressClickUntil = 0;
  let suppressClickTarget: EventTarget | null = null;

  const resetTap = () => {
    tapCount = 0;
    if (tapTimer !== undefined) {
      clearTimeout(tapTimer);
      tapTimer = undefined;
    }
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (isExtensionUi(event.target)) return;
    // 第二根手指落下：整轮作废（平板手掌误触常见）。
    if (activePointerId !== null) {
      activePointerId = null;
      start = null;
      resetTap();
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    activePointerId = event.pointerId;
    start = { x: event.clientX, y: event.clientY, time: Date.now() };
    moved = false;
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId || !start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_MOVE_TOLERANCE_PX) {
      moved = true;
    }
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;
    const pointerStart = start;
    activePointerId = null;
    start = null;
    if (!pointerStart || moved || isExtensionUi(event.target)
      || Date.now() - pointerStart.time > TAP_MAX_DURATION_MS) {
      resetTap();
      return;
    }

    tapCount++;
    // 每次点击重新计时：三击之间各自允许 600ms。
    if (tapTimer !== undefined) clearTimeout(tapTimer);
    tapTimer = window.setTimeout(resetTap, TRIPLE_TAP_WINDOW_MS);

    if (tapCount === 3) {
      resetTap();
      // click 在 pointerup 之后派发；捕获阶段拦一次，阻止链接跳转与双击选词。
      suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
      suppressClickTarget = event.target;
      try {
        event.preventDefault();
      } catch {
        /* 某些环境不允许取消 pointerup，由 click 捕获兜底 */
      }
      const selection = window.getSelection?.();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
      void onTranslate();
    }
  };

  const handlePointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    start = null;
    resetTap();
  };

  const handleClickCapture = (event: MouseEvent) => {
    if (Date.now() >= suppressClickUntil) return;
    const target = suppressClickTarget;
    suppressClickUntil = 0;
    suppressClickTarget = null;
    const sameTarget = target === event.target
      || (target instanceof Element && target.contains(event.target as Node));
    if (!sameTarget) return;
    event.preventDefault();
    event.stopPropagation();
  };

  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('pointerup', handlePointerUp, true);
  document.addEventListener('pointercancel', handlePointerCancel, true);
  document.addEventListener('click', handleClickCapture, true);

  return () => {
    document.removeEventListener('pointerdown', handlePointerDown, true);
    document.removeEventListener('pointermove', handlePointerMove, true);
    document.removeEventListener('pointerup', handlePointerUp, true);
    document.removeEventListener('pointercancel', handlePointerCancel, true);
    document.removeEventListener('click', handleClickCapture, true);
    resetTap();
  };
}
