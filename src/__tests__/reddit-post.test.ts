// @ts-nocheck
// 回归测试：Reddit post 页主帖正文（shreddit-post）必须与评论区一起被抽取。
//
// 回归背景（2026-09-28，线上 /article/739 实测）：
//   Reddit 把每条评论渲染成 <details role="article">，contentHelper Layer 1 的
//   '[role="article"]' 选择器优先级高于 'main'，命中「textContent 最长的评论
//   子树」；chooseBestRoot 的评分又偏爱文本密集、按钮少的评论容器（main 因
//   "按钮过多"被扣 15 分）→ 文章根被选进评论区 → 主帖 shreddit-post 整体在
//   根外，正文一段都不翻译（评论区双语正常，极具迷惑性）。
//
//   修复：reddit 规则声明 articleRootSelector: 'main#main-content'（Layer 0
//   最高优先级，直接钉住同时包含主帖与评论区的唯一稳定锚点）。
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { prepareDocument } from '../entrypoints/utils/contentHelper';

const FIXTURE = 'src/__tests__/fixtures/reddit-post-real.html';
const REDDIT_URL =
  'https://www.reddit.com/r/ExperiencedDevs/comments/1wql3g2/interviewed_candidates_for_ai_engineer_roles_this/';

function withRedditLocation<T>(fn: () => T): T {
  const original = window.location?.href ?? 'http://localhost/';
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: REDDIT_URL },
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: original },
    });
  }
}

describe('Reddit post page: 主帖正文必须与评论区一起被抽取', () => {
  beforeAll(() => {
    const html = readFileSync(FIXTURE, 'utf-8');
    const dom = new JSDOM(html);
    document.documentElement.innerHTML =
      dom.window.document.documentElement.innerHTML;
  });

  it('主帖正文段落进入抽取块（不会被 [role="article"] 评论区根排除）', () => {
    const { blocks } = withRedditLocation(() => prepareDocument(document));
    const texts = blocks.map((b) => b.text);

    // 主帖正文段落（fixture 来自真实缓存的 shreddit-post 切片）
    expect(
      texts.some((t) => t.includes('left wondering this weekend')),
    ).toBe(true);

    // 评论区段落（details role="article" 内）仍正常抽取
    expect(
      texts.some((t) => t.includes('Think about the whole thing')),
    ).toBe(true);
  });

  it('抽取根包含 shreddit-post 与评论区（articleRootSelector 生效）', () => {
    withRedditLocation(() => {
      const { blocks } = prepareDocument(document);
      // 主帖 <p> 若在根外，主帖段落一个都不会出现；这里用
      // 「主帖段落 + 评论段落同时存在」作为根覆盖两个区域的证据。
      const texts = blocks.map((b) => b.text);
      const hasPostBody = texts.some((t) =>
        t.includes('order of magnitude'),
      );
      const hasComment = texts.some((t) =>
        t.includes('Think about the whole thing'),
      );
      expect(hasPostBody).toBe(true);
      expect(hasComment).toBe(true);
    });
  });

  it('articleRootSelector 必须压过 [role="article"] + 评分选择（Layer 0 语义）', () => {
    // 合成 DOM 复刻真实页面的评分格局：
    //   - 评论（details role="article"）文本极长 → Layer 1 命中它；
    //   - main 里按钮 / li / related 密布 → scoreArticleContainer 对 main
    //     重罚（-15 按钮 / -10 li / -8 related）；
    //   - 若无 articleRootSelector，chooseBestRoot 会把根选进评论容器，
    //     主帖 shreddit-post 落在根外 → 正文丢失（线上 /article/739 症状）。
    // 20 段 ≈ 2700 字符：远超主帖以拉开评分差距，但保持在
    // MAX_TEXT_LENGTH(3072) 之下 —— 超长文本会被 isValidText 直接跳过。
    // main 内的按钮/列表/related 复刻真实 Reddit 页面的扣分格局
    // （-15 按钮 / -10 li / -8 related），让无 Layer 0 时评分倒向评论区。
    const longComment = Array(20)
      .fill(
        'This comment discusses hiring practices and AI engineers at length ' +
          'with plenty of paragraphs to make the comment subtree very heavy. ',
      )
      .join('');
    const fillerButtons = Array(14).fill('<button type="button">vote</button>').join('');
    const fillerList = '<ul class="listing">' + Array(85).fill('<li><a href="#">tag</a></li>').join('') + '</ul>';
    const html = `<!doctype html><html><body>
      <main id="main-content">
        <shreddit-post>
          <h1>Interviewed candidates for AI engineer roles</h1>
          <div slot="text-body" class="md">
            <p>The main post body paragraph that must be translated.</p>
          </div>
          ${fillerButtons}${fillerList}
          <div class="related-posts"><span>related</span></div>
        </shreddit-post>
        <shreddit-comment-tree>
          <div class="comment-tree-wrapper">
            <shreddit-comment>
              <details role="article" open>
                <p>${longComment}</p>
              </details>
            </shreddit-comment>
          </div>
        </shreddit-comment-tree>
      </main>
      <nav><a>nav1</a><a>nav2</a></nav>
      </body></html>`;

    withRedditLocation(() => {
      const dom = new JSDOM(html);
      document.documentElement.innerHTML =
        dom.window.document.documentElement.innerHTML;

      const { blocks } = prepareDocument(document);
      const texts = blocks.map((b) => b.text);
      expect(
        texts.some((t) =>
          t.includes('The main post body paragraph that must be translated.'),
        ),
      ).toBe(true);
      expect(texts.some((t) => t.includes('hiring practices'))).toBe(true);
    });
  });
});
