import { describe, it, expect, beforeEach } from 'vitest';
import { createOverlayHider } from '../entrypoints/utils/contentHelper';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createOverlayHider (Poptins 等动态弹层隐藏)', () => {
  let hider: ReturnType<typeof createOverlayHider> | undefined;

  beforeEach(() => {
    document.body.innerHTML = '<main id="main-content" role="main"><p>正文</p></main>';
    if (hider) hider.stop();
    hider = undefined;
  });

  it('动态注入的 poptin 弹层被标记 data-fanyi-remove', async () => {
    hider = createOverlayHider();
    hider.start();
    const popup = document.createElement('div');
    popup.className = 'poptin-modal';
    document.body.appendChild(popup);
    await tick();
    expect(popup.getAttribute('data-fanyi-remove')).toBe('true');
  });

  it('扩展自身 UI（class 以 fanyi- 开头）不被隐藏', async () => {
    hider = createOverlayHider();
    hider.start();
    const ui = document.createElement('div');
    ui.className = 'fanyi-status-overlay';
    document.body.appendChild(ui);
    await tick();
    expect(ui.hasAttribute('data-fanyi-remove')).toBe(false);
  });

  it('正文（main 内）内的 poptin 节点不被误隐藏', async () => {
    hider = createOverlayHider();
    hider.start();
    const inside = document.createElement('div');
    inside.className = 'poptin-notification';
    document.querySelector('main')!.appendChild(inside);
    await tick();
    expect(inside.hasAttribute('data-fanyi-remove')).toBe(false);
  });


  it('stop() 后不再隐藏新注入的弹层', async () => {
    hider = createOverlayHider();
    hider.start();
    hider.stop();
    const popup = document.createElement('div');
    popup.className = 'poptin-modal';
    document.body.appendChild(popup);
    await tick();
    expect(popup.hasAttribute('data-fanyi-remove')).toBe(false);
  });
});
