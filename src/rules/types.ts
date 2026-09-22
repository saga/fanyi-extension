export interface SiteRule {
  /**
   * Host pattern to match, e.g. 'github.com', '*.example.com'
   * Supports exact match and wildcard prefix
   */
  hostPattern: string;

  /**
   * CSS selectors whose content should be skipped entirely
   */
  skipSelectors?: string[];

  /**
   * 抽取块文本时，把这些选择器命中的子树从文本里**剔除**（默认不剔除）。
   *
   * 与 `skipSelectors` 的区别（为什么不用同一个列表）：
   * `skipSelectors` 的语义是「这段内容不单独翻译」，**不等于**「这段文字不该
   * 出现在文本里」。两者经常冲突：
   *
   *   典型反例 GitHub：`code` / `pre` 在 skipSelectors 里（代码块不翻译），
   *   但段落中的行内 `<code>` 是正文的一部分；一旦剔除，译文会出现
   *   "Use to install" 这种残缺句子。
   *
   * 所以剔除必须是**独立的、显式的**列表，只列真正该从文本里丢掉的装饰：
   *   - Hacker News：`.comhead`（作者/时间/prev/next 导航）、`.pagetop`（顶栏）、
   *     `.reply`（"reply" 链接）。这些是包裹层里唯一的文本，不剔除的话
   *     `<div style="margin-top:2px">` / `<td>` 这类"只剩导航"的容器会被
   *     当成有效块抓出来翻译（见 walker 的 acceptNode 文本有效性判定）。
   *
   * 开启后 `el.textContent` 会被替换为「排除这些子树后的文本」，抽取块的
   * `text` 与文本有效性判定同时生效，保证「判为有效的文本」=「真正翻译的文本」。
   */
  excludeFromTextSelectors?: string[];

  /**
   * 把 `<table>` 系标签当普通容器处理，不做整棵剪枝（默认 false）。
   *
   * 背景：`table/thead/tbody/tfoot/tr/td/th/caption/col/colgroup` 在
   * blockExtractor 的 SKIP_SET 里（FILTER_REJECT = 剪掉整棵子树），
   * 这是为**数据表**设计的（数字/单位/年份翻译一致性差）。
   *
   * 但有些站点（典型：Hacker News）用嵌套 table 做**整页布局**，
   * 剪枝后整页抽取结果为 0 个块。开启本项后这些标签会走普通容器分支：
   * 有非内联子元素就下钻，只有内联子元素才考虑自成一块。
   *
   * 注意：只放行 table 系标签，`code`/`pre` 等仍在 SKIP_SET 里照常剪枝。
   */
  translateTables?: boolean;

  /**
   * 站点声明「整块翻译」的容器选择器（默认空）。
   *
   * 命中这些选择器的元素会被当作"段落级块"（等价于 `data-as="p"` / 段落类 div）：
   *   1. 整体作为一个翻译块返回，内部 `<p>` / `<a>` / `<code>` 不再被拆成碎片；
   *   2. 同时成为 `hasBlockLevelParent` 的边界。
   *
   * 为什么需要：某些站点的「一段正文」是 `div` 里**裸文本 + 嵌套 `<p>`** 混排
   * （典型：Hacker News 评论 `div.commtext`，首段是裸文本、后续段落是 `<p>`）。
   * 走通用容器分支时，嵌套 `<p>` 会被单独抓出，而**首段裸文本会整个丢失**。
   * 只有把容器整体抓取才能保全文。
   */
  blockSelectors?: string[];

  /**
   * Regex patterns (as strings) whose text content should be skipped entirely.
   * Useful for filtering out site-specific noise like Sentry chunk preload
   * lists injected into the DOM by a particular site.
   */
  skipTextPatterns?: string[];

  /**
   * Additional prompt instructions for this site
   */
  promptInstructions?: string;

  /**
   * 文档级专有名词（公司/产品/服务名），用于 system prompt 中"保留原文"的提示
   */
  documentTerms?: string[];

  /**
   * 站点特定的文章根节点 CSS 选择器。
   *
   * 当通用 ARTICLE_SELECTORS 无法正确定位正文根时使用。典型场景：
   * claude.com 的 hero（h1 + 导语）和正文分属兄弟 section，
   * `.u-rich-text-blog` 只命中正文 section 内的容器，漏掉 hero。
   *
   * 命中后直接作为 article root，跳过 refineArticleRoot /
   * expandIfFragmented（站点选择器是显式的，不需要启发式扩展）。
   */
  articleRootSelector?: string;

  /**
   * 强制使用 direct DeepSeek 翻译（跳过服务端翻译路径）。
   *
   * 适用场景：YouTube 等动态内容多、页面大的站点。服务端翻译需要 clone
   * 整页 HTML（prepareHtmlForServer），对 YouTube 这种 SPA 页面既慢又
   * 容易抓到动态内容。direct deepseek 走分块翻译，更适合。
   *
   * 命中后 handleFullTranslation 跳过 useServerTranslation 分支，即使
   * 用户配置了 useServerTranslation=true 也走 direct deepseek 路径。
   */
  forceDirectTranslation?: boolean;

  /**
   * 跳过术语表（glossary）提取。
   *
   * 适用场景：字幕、评论等简单内容，不需要 extractGlossaryLocal 的开销。
   * YouTube 字幕是短文本口语化内容，术语表价值低，跳过可加速返回。
   */
  skipGlossary?: boolean;
}

export interface MatchedRule {
  siteRule: SiteRule;
  matchedPattern: string;
}
