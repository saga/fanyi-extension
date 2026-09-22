// @ts-nocheck
// 该测试需要 node:fs 与 jsdom 读取真实 Hacker News 页面快照；项目未安装 @types/node，
// 故对该测试文件关闭 tsc 检查（运行时由 vitest 的 node + jsdom 环境正常提供）。
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { extractBlocks } from '../entrypoints/utils/blockExtractor';
import { matchSiteRule } from '../rules';
import { hackernewsRule } from '../rules/hackernews-rules';

const FIXTURE = 'src/__tests__/fixtures/hackernews-item.html';
const HN_URL = 'https://news.ycombinator.com/item?id=49808023';

/**
 * 在「假装当前页是 HN」的 location 下执行 fn，结束后还原。
 * blockExtractor 的站点规则按 window.location.href 匹配并缓存。
 */
function withHnLocation<T>(fn: () => T): T {
  const loc = (window as unknown as { location: { href: string } }).location;
  const originalHref = loc?.href ?? 'http://localhost/';
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: HN_URL },
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: originalHref },
    });
  }
}

/**
 * 这个 fixture 的回归背景（改坏了会怎样）：
 *
 *   HN 用嵌套 <table> 搭整页布局，而 table/tr/td 在 SKIP_SET 里（剪整棵子树）
 *   → 没有 `translateTables: true` 时整页抽出 0 块。
 *
 *   评论正文是 div.commtext 里「裸文本 + 多个 <p>」混排
 *   → 不整体抓取（blockSelectors）会丢掉首段裸文本；
 *   → 不抑制子树（ACCEPT 不阻止下钻）会让内部 <p> 变成重复块；
 *   → 不剔除装饰（excludeFromTextSelectors）会把 "reply" / 作者时间 / 顶栏
 *     当作独立块抓出来翻译。
 */
describe('Hacker News item page (comments)', () => {
  beforeAll(() => {
    const html = readFileSync(FIXTURE, 'utf-8');
    const dom = new JSDOM(html);
    document.documentElement.innerHTML =
      dom.window.document.documentElement.innerHTML;
  });

  afterAll(() => {
    try {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: new URL('http://localhost/'),
      });
    } catch {
      /* jsdom 下 location 可能不可重定义，忽略 */
    }
  });

  it('registers a hackernews site rule opting into table layout and block selectors', () => {
    const matched = matchSiteRule(HN_URL);
    expect(matched).not.toBeNull();
    expect(matched?.siteRule.hostPattern).toBe('news.ycombinator.com');
    expect(matched?.siteRule).toBe(hackernewsRule);

    // HN 整页 table 布局 → 必须放行 table 系标签，否则抽取 0 块
    expect(hackernewsRule.translateTables).toBe(true);
    expect(hackernewsRule.blockSelectors).toContain('.commtext');
    // 评论头部 / 顶栏 / reply 链接必须从文本里剔除
    expect(hackernewsRule.excludeFromTextSelectors).toEqual(
      expect.arrayContaining(['.comhead', '.pagetop', '.reply'])
    );
    // code / pre 只"不单独翻译"，**不能**剔除文本（评论里的行内 <code> 是正文）
    expect(hackernewsRule.skipSelectors).toEqual(
      expect.arrayContaining(['code', 'pre'])
    );
    expect(hackernewsRule.excludeFromTextSelectors).not.toContain('code');
    expect(hackernewsRule.excludeFromTextSelectors).not.toContain('pre');
  });

  it('extracts the story title and every comment body as one block each', () => {
    const blocks = withHnLocation(() => extractBlocks(document));

    expect(blocks.map((b) => b.text)).toEqual([
      "Microsoft killed FoxPro in 2007. Anyway, here's FoxPro revived",
      'Flashback.  When I was an adolescent, the dBase and Fox products were my first paid software development, and they were surprisingly accessible to even kids.\n\nI was only supposed to help assemble computer furniture, and maybe install networked Unix and PC software, but the retired Marine my mom worked for thought I had potential.\n\n(Then I kept working, and there was a period when all employers either wanted me to figure out something, or were favorably surprised when I soon did.)',
      'Maybe someone can put the core FoxPro ideas on top of SQLite',
      'Here’s my problem with reviving FoxPro in any form: there’s a huge security hole in the Database Container (DBC) design. For DBCs to be useful, they must be read/write to all users (there is no permissions scheme).\n\nMy recommendation is to get rid of the DBF/DBC files and move to a SQL DB of some flavor ASAP. If you have the source code, use ODBC or OLE DB to point to a server.\n\nSource: filed that bug over 20 years ago when I worked on the Fox team. No, it wasn’t going to get fixed without rewriting large parts of how the DB engine worked.',
      'Sqlite?',
      'Original - FoxPro: https://en.wikipedia.org/wiki/FoxPro\n\nSuccessor - Visual FoxPro: https://en.wikipedia.org/wiki/Visual_FoxPro',
    ]);
  });

  it('grabs each comment whole (regression: first bare-text paragraph must survive)', () => {
    const blocks = withHnLocation(() => extractBlocks(document));
    const texts = blocks.map((b) => b.text);

    // 首段是裸文本、后续段落才是 <p>：整体抓取才不会丢首段
    const multiParagraph = texts.find((t) => t.includes('Flashback.'));
    expect(multiParagraph).toBeDefined();
    expect(multiParagraph).toContain('When I was an adolescent');
    expect(multiParagraph).toContain('I was only supposed to help assemble');
    expect(multiParagraph).toContain('(Then I kept working');
    // 段落边界必须保留，否则译文会糊成一整段
    expect(multiParagraph).toContain('\n\n');

    // 只有 6 个块：1 个标题 + 5 个评论。内部 <p> 不得变成重复块。
    expect(texts).toHaveLength(6);
    // 每个评论正文恰好出现一次
    for (const needle of [
      'Flashback.',
      'Maybe someone can put the core FoxPro ideas',
      'Here’s my problem with reviving FoxPro',
      'Sqlite?',
      'Original - FoxPro:',
    ]) {
      expect(texts.filter((t) => t.includes(needle))).toHaveLength(1);
    }
  });

  it('never translates HN chrome: reply link, comment header, story subtext, top nav', () => {
    const blocks = withHnLocation(() => extractBlocks(document));
    const joined = blocks.map((b) => b.text).join('\n');

    // reply 链接（div.reply 是 div.commtext 的**兄弟**，必须单独剪掉）
    expect(joined).not.toMatch(/(^|\s)reply(\s|$)/);
    // 评论头部：作者 / 相对时间 / prev-next 导航
    expect(joined).not.toContain('minutes ago');
    expect(joined).not.toContain('hours ago');
    expect(joined).not.toContain('[–]');
    expect(joined).not.toContain('neilv');
    expect(joined).not.toContain('mikestew');
    // 故事元信息（.subtext）：分数 / 点数 / hide / favorite
    expect(joined).not.toContain('points by');
    expect(joined).not.toContain('119 points');
    expect(joined).not.toContain('favorite');
    // 顶栏（.pagetop）
    expect(joined).not.toContain('Hacker News');
    expect(joined).not.toContain('jobs');
  });
});

/**
 * 反例守卫：`code` / `pre` 只属于 skipSelectors（不单独成块），
 * **绝不能**进 excludeFromTextSelectors —— 否则评论里的行内 `<code>`
 * 会被从文本里剔除，译文变成 "Use to do that." 这种残缺句子。
 * 这正是"剔除必须用独立字段、不能复用 skipSelectors"的原因。
 */
describe('Hacker News comment text: inline <code> must survive extraction', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <table class="comment-tree"><tbody><tr class="athing comtr" id="1"><td><table><tbody><tr>
        <td class="default">
          <div class="comment">
            <div class="commtext c00">Use <code>std::map</code> to do that, not a raw array.</div>
            <div class="reply"><p><font size="1"><u><a href="reply?id=1" rel="nofollow">reply</a></u></font></p></div>
          </div>
        </td>
      </tr></tbody></table></td></tr></tbody></table>
    `;
  });

  it('keeps inline code text and drops the reply link', () => {
    const blocks = withHnLocation(() => extractBlocks(document));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(
      'Use std::map to do that, not a raw array.'
    );
  });
});
