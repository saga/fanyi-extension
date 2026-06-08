import { GESTURES } from '../utils/constants';
import { getCenterPoint } from '../utils/common';
import { getConfig } from '../utils/config';
import { showConfigPanel } from './configPanel';

/**
 * 浮动按钮 + 触屏手势。
 *
 * 浮动按钮交互：
 *   - 短按（< 500/600ms）         → 翻译 / 恢复
 *   - 长按（> 500/600ms 且未拖动）→ 打开配置面板
 *   - 拖动（位移 > 5/10px）        → 移动按钮位置
 *   - 位置保存在 localStorage.fanyi-btn-position，刷新页面后恢复
 *
 * 触屏手势（仅在 enable && 触屏设备上响应）：
 *   - TripleTap（三击）：500ms 内的 3 次单击
 *   - ThreeFinger（三指）：3 指同时触碰
 *   - FourFinger（四指）：4 指同时触碰
 *   手势类型从 config.touchGesture 读取，用户可在配置面板切换。
 */

const BTN_POSITION_KEY = 'fanyi-btn-position';
const LONG_PRESS_MS_DESKTOP = 600;
const LONG_PRESS_MS_MOBILE = 500;
const DRAG_THRESHOLD_DESKTOP = 5;
const DRAG_THRESHOLD_MOBILE = 10;
const TRIPLE_TAP_WINDOW_MS = 500;

interface ButtonPosition {
  right: number;
  bottom: number;
}

/**
 * 读取浮动按钮上次保存的位置；localStorage 没有或解析失败时回退默认值。
 * 单测：src/__tests__/floatingButton.test.ts
 */
export function loadButtonPosition(isMobile: boolean): ButtonPosition {
  const defaults = { right: isMobile ? 12 : 20, bottom: 100 };
  const saved = localStorage.getItem(BTN_POSITION_KEY);
  if (!saved) return defaults;
  try {
    const parsed = JSON.parse(saved);
    return { right: parsed.right ?? defaults.right, bottom: parsed.bottom ?? defaults.bottom };
  } catch {
    return defaults;
  }
}

/** 持久化按钮位置到 localStorage。 */
export function saveButtonPosition(pos: ButtonPosition): void {
  localStorage.setItem(BTN_POSITION_KEY, JSON.stringify(pos));
}

/**
 * 创建浮动按钮并挂到 body。
 *
 * 依赖注入而非闭包共享：
 *   - getIsPageTranslated：避免循环依赖（translation 模块知道"已翻译"状态）
 *   - onTranslate / onRestore：UI 触发业务逻辑
 */
export function setupFloatingButton(
  isMobile: boolean,
  getIsPageTranslated: () => boolean,
  onTranslate: () => Promise<void>,
  onRestore: () => void,
): void {
  const btn = document.createElement('div');
  btn.className = 'fanyi-floating-btn';
  btn.innerHTML = '译';
  btn.title = '点击翻译，长按设置';

  // 恢复上次位置
  const pos = loadButtonPosition(isMobile);
  btn.style.right = pos.right + 'px';
  btn.style.bottom = pos.bottom + 'px';

  // === 拖拽状态 ===
  let isDragging = false;
  let hasMoved = false;
  let startX = 0;
  let startY = 0;
  let longPressTimer: number | null = null;

  const clearLongPress = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  // 取鼠标/触点坐标
  const getClientXY = (e: MouseEvent | TouchEvent): { x: number; y: number } => {
    if (e instanceof MouseEvent) return { x: e.clientX, y: e.clientY };
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const startDrag = (e: MouseEvent | TouchEvent) => {
    try { e.preventDefault(); } catch (err) { /* passive listener 上 preventDefault 会抛 */ }
    hasMoved = false;
    isDragging = false;

    // 长按触发配置面板（仅未拖动）
    longPressTimer = window.setTimeout(() => {
      if (!hasMoved) showConfigPanel(isMobile, onTranslate, onRestore);
    }, isMobile ? LONG_PRESS_MS_MOBILE : LONG_PRESS_MS_DESKTOP);

    const { x, y } = getClientXY(e);
    startX = x;
    startY = y;

    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchmove', onDrag, { passive: false });
    document.addEventListener('touchend', endDrag);
  };

  const onDrag = (e: MouseEvent | TouchEvent) => {
    clearLongPress();
    const { x, y } = getClientXY(e);

    const dx = Math.abs(x - startX);
    const dy = Math.abs(y - startY);
    const threshold = isMobile ? DRAG_THRESHOLD_MOBILE : DRAG_THRESHOLD_DESKTOP;
    if (dx > threshold || dy > threshold) {
      hasMoved = true;
      isDragging = true;
    }

    if (isDragging) {
      const newRight = window.innerWidth - x - btn.offsetWidth / 2;
      const newBottom = window.innerHeight - y - btn.offsetHeight / 2;
      btn.style.right = Math.max(0, Math.min(newRight, window.innerWidth - btn.offsetWidth)) + 'px';
      btn.style.bottom = Math.max(0, Math.min(newBottom, window.innerHeight - btn.offsetHeight)) + 'px';
    }

    if (e instanceof TouchEvent) {
      try { e.preventDefault(); } catch (err) { /* ignore */ }
    }
  };

  const endDrag = () => {
    clearLongPress();
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', endDrag);
    document.removeEventListener('touchmove', onDrag);
    document.removeEventListener('touchend', endDrag);

    if (!hasMoved) {
      // 短按 = 翻译或恢复
      if (getIsPageTranslated()) onRestore();
      else onTranslate();
    } else {
      // 拖动结束 = 保存位置
      const right = parseInt(btn.style.right) || (isMobile ? 12 : 20);
      const bottom = parseInt(btn.style.bottom) || 100;
      saveButtonPosition({ right, bottom });
    }
    isDragging = false;
  };

  btn.addEventListener('mousedown', startDrag);
  btn.addEventListener('touchstart', startDrag, { passive: false });

  document.body.appendChild(btn);
}

/**
 * 切换按钮的"已翻译"状态：
 *   - 译（灰色） ↔ 原（绿色 + fanyi-btn-translated）
 *   - title 文案也对应变化
 */
export function updateButtonState(isTranslated: boolean): void {
  const btn = document.querySelector('.fanyi-floating-btn') as HTMLElement | null;
  if (!btn) return;

  if (isTranslated) {
    btn.innerHTML = '原';
    btn.title = '已翻译，点击恢复原文，长按设置';
    btn.classList.add('fanyi-btn-translated');
  } else {
    btn.innerHTML = '译';
    btn.title = '点击翻译，长按设置';
    btn.classList.remove('fanyi-btn-translated');
  }
}

/**
 * 注册全局 touchstart 监听器，根据 config.touchGesture 触发翻译。
 *
 * 移动端没有"鼠标点击"，需要单独识别手势：
 *   - TripleTap: 500ms 内连续 3 次单击（用 tapCount + tapTimer 实现）
 *   - ThreeFinger / FourFinger: 同时触摸指头数符合才触发
 *
 * 注：Firefox / Chrome 触屏都遵循 TouchEvent 接口，无需 UA 区分。
 */
export function setupTouchEvents(
  onTranslate: () => Promise<void>,
): void {
  let tapCount = 0;
  let tapTimer: number | undefined;

  const handleTouchStart = async (event: TouchEvent) => {
    const target = event.target as Element;
    // 命中扩展自身的 UI 时不响应手势
    if (
      target.closest('.fanyi-config-panel') ||
      target.closest('.fanyi-floating-btn') ||
      target.closest('.fanyi-status-overlay')
    ) {
      return;
    }

    const config = await getConfig();
    if (!config.enabled) return;

    const gesture = config.touchGesture || GESTURES.TripleTap;
    const multiFingerGestures: string[] = [GESTURES.ThreeFinger, GESTURES.FourFinger];

    if (multiFingerGestures.includes(gesture)) {
      const required = gesture === GESTURES.ThreeFinger ? 3 : 4;
      if (event.touches.length === required) {
        const center = getCenterPoint(event.touches, required);
        if (center) {
          try { event.preventDefault(); } catch (e) { /* ignore */ }
          onTranslate();
        }
      }
      return;
    }

    if (gesture === GESTURES.TripleTap) {
      if (event.touches.length !== 1) return;
      tapCount++;
      if (tapCount === 1) {
        tapTimer = window.setTimeout(() => { tapCount = 0; }, TRIPLE_TAP_WINDOW_MS);
      } else if (tapCount === 3) {
        if (tapTimer) clearTimeout(tapTimer);
        tapCount = 0;
        try { event.preventDefault(); } catch (e) { /* ignore */ }
        onTranslate();
      }
    }
  };

  // passive: false 是必须的，否则 preventDefault() 在触屏上无效
  document.body.addEventListener('touchstart', handleTouchStart, { passive: false });
}
