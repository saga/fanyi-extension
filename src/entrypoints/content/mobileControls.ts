/**
 * 移动端稳定入口：悬浮按钮。
 *
 * 三击手势只是快捷方式；平板/触控笔/外接鼠标场景下手势可能失效，
 * 因此移动端始终显示一个可点按的悬浮按钮：
 *   - 单击：翻译/恢复当前页面（按是否已翻译切换）
 *   - 长按：打开配置面板（API Key、语言、服务端、翻译/恢复按钮）
 *
 * 按钮自身带 fanyi-floating-btn 类，touchGesture 会跳过它，避免双重触发。
 */
import { showConfigPanel } from './configPanel';

const LONG_PRESS_MS = 550;
const MOVE_TOLERANCE_PX = 12;

export interface MobileControlHandlers {
  onTranslate: () => Promise<void>;
  onRestore: () => void;
  isTranslated: () => boolean;
}

/** 注入悬浮按钮；重复调用不会创建第二个。返回清理函数。 */
export function setupMobileControls(handlers: MobileControlHandlers): () => void {
  const existing = document.querySelector('.fanyi-floating-btn');
  if (existing) existing.remove();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fanyi-floating-btn';
  button.title = '点按翻译 / 恢复，长按打开设置';
  button.setAttribute('aria-label', '翻译控制');
  button.innerHTML = '<span class="fanyi-floating-btn-label">译</span>';
  document.body.appendChild(button);

  let longPressTimer: number | undefined;
  let longPressed = false;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;

  const clearTimer = () => {
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    longPressed = false;
    clearTimer();
    longPressTimer = window.setTimeout(() => {
      longPressed = true;
      showConfigPanel(true, handlers.onTranslate, handlers.onRestore);
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE_PX) {
      clearTimer();
    }
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    clearTimer();
    if (longPressed) return;
    if (handlers.isTranslated()) handlers.onRestore();
    else void handlers.onTranslate();
  };

  const handlePointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    clearTimer();
  };

  // 长按后浏览器仍会派发 click；拦掉避免重复触发翻译/恢复。
  const handleClick = (event: MouseEvent) => {
    if (!longPressed) return;
    event.preventDefault();
    event.stopPropagation();
    longPressed = false;
  };

  button.addEventListener('pointerdown', handlePointerDown);
  button.addEventListener('pointermove', handlePointerMove);
  button.addEventListener('pointerup', handlePointerUp);
  button.addEventListener('pointercancel', handlePointerCancel);
  button.addEventListener('click', handleClick);

  return () => {
    clearTimer();
    button.removeEventListener('pointerdown', handlePointerDown);
    button.removeEventListener('pointermove', handlePointerMove);
    button.removeEventListener('pointerup', handlePointerUp);
    button.removeEventListener('pointercancel', handlePointerCancel);
    button.removeEventListener('click', handleClick);
    button.remove();
  };
}
