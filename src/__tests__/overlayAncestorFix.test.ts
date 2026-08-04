import { describe, it, expect, beforeEach } from 'vitest';
import { prepareDocument } from '../entrypoints/utils/contentHelper';
import { createOverlayHider } from '../entrypoints/utils/contentHelper';

/**
 * 回归测试：修复"整页白屏"的根因。
 *
 * 根因：Dialog 类整页容器（如 Drupal 的 .dialog-off-canvas-main-canvas）类名含
 * "dialog"/"overlay"，被 isOverlayElement 判为弹窗。当它是 <main> 的【祖先】时，
 * 旧代码会把它标记 data-fanyi-remove，而扩展注入的 [data-fanyi-remove]{display:none}
 * 会把整个页面容器（连同正文）一起隐藏 → 白屏。
 *
 * 修复：hideBodyOverlays / createOverlayHider 必须跳过"正文根的祖先"。
 * 本测试用 jsdom 构造上述结构，断言：
 *   - 包裹 <main> 的整页容器（祖先）不被标记；
 *   - 正文 <main> 本身不被标记；
 *   - 真正的浮层（poptin / cookie）仍被标记（回归安全）。
 */

function buildDrupalLikeDom() {
  document.body.innerHTML = `
    <div class="dialog-off-canvas-main-canvas" id="wrapper">
      <header>site header</header>
      <main id="article">
        <h1>Article Title</h1>
        <p>Some real article content that should be translated, not hidden.</p>
        <p>Second paragraph with more text to extract as a block.</p>
      </main>
      <footer>site footer</footer>
    </div>
    <div class="poptin-modal" id="poptin">Subscribe now!</div>
    <div class="cookie-banner" id="cookie">Accept cookies</div>
  `;
}

describe('hideBodyOverlays 祖先保护（经 prepareDocument 触发）', () => {
  beforeEach(() => buildDrupalLikeDom());

  it('不隐藏正文根的祖先容器，但仍隐藏真正的浮层', () => {
    const wrapper = document.getElementById('wrapper')!;
    const article = document.getElementById('article')!;
    const poptin = document.getElementById('poptin')!;
    const cookie = document.getElementById('cookie')!;

    // 祖先确实包裹正文
    expect(wrapper.contains(article)).toBe(true);

    const result = prepareDocument(document);

    // 【核心修复断言】整页祖先容器不得被标记
    expect(wrapper.hasAttribute('data-fanyi-remove')).toBe(false);
    // 正文根本身不得被标记
    expect(article.hasAttribute('data-fanyi-remove')).toBe(false);
    // 真正的浮层仍被标记（回归安全：清理逻辑仍生效）
    expect(poptin.hasAttribute('data-fanyi-remove')).toBe(true);
    expect(cookie.hasAttribute('data-fanyi-remove')).toBe(true);

    // 正文未被隐藏，抽取应正常产出块
    expect(result.blocks.length).toBeGreaterThan(0);
  });
});

describe('createOverlayHider 祖先保护（动态浮层猎手）', () => {
  beforeEach(() => buildDrupalLikeDom());

  it('启动时扫描不标记祖先容器，且动态注入的 poptin 会被捕获', () => {
    const wrapper = document.getElementById('wrapper')!;
    const article = document.getElementById('article')!;
    const poptin = document.getElementById('poptin')!;

    const hider = createOverlayHider(article);
    hider.start();

    expect(wrapper.hasAttribute('data-fanyi-remove')).toBe(false);
    expect(article.hasAttribute('data-fanyi-remove')).toBe(false);
    expect(poptin.hasAttribute('data-fanyi-remove')).toBe(true);

    // 动态注入新的 poptin 浮层，MutationObserver 应捕获并标记
    const late = document.createElement('div');
    late.className = 'poptin-late';
    late.id = 'poptin-late';
    document.body.appendChild(late);
    // MutationObserver 回调是微任务，给一点时间
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(document.getElementById('poptin-late')!.hasAttribute('data-fanyi-remove')).toBe(true);
        hider.stop();
        resolve();
      }, 50);
    });
  });
});
