export interface SiteRule {
  /**
   * Host pattern to match, e.g. 'github.com', '*.example.com'
   * Supports exact match and wildcard prefix
   */
  hostPattern: string;

  /**
   * Terms that should NOT be translated, kept as-is
   */
  skipTerms?: string[];

  /**
   * CSS selectors whose content should be skipped entirely
   */
  skipSelectors?: string[];

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
