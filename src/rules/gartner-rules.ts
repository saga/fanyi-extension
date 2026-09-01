import type { SiteRule } from './types';

/**
 * Gartner 新闻稿页（Adobe Experience Manager 生成）正文结构特征：
 * - 正文被切成 9 个 <article class="article-text ..."> **兄弟碎片**，各自含一段，
 *   共同祖先是 div.aem-Grid（该 div 同时包含 h1 标题与全部 9 个碎片）。
 * - 通用选择器 .article-text 命中 9 个碎片中最长者，chooseBestRoot 已能向上
 *   爬到含 h1 的 div.aem-Grid 并正确提取全部正文（已验证 103 blocks）。
 * - 但为消除 AEM 不同渲染时机 / 不同构建下 chooseBestRoot 漏爬导致
 *   "No translatable content found" 的风险，这里用站点规则**确定性锁定**正文根。
 *
 * 选择器用 [class*="aem-Grid"] 而非 div.aem-Grid：aem-Grid 是 AEM 页面布局网格，
 * 文档顺序中第一个匹配项即包裹整篇（h1 + 9 碎片）的顶层网格，直接作为 article
 * root 跳过启发式扩展。该属性选择器在标准浏览器与 jsdom 下均可稳定解析。
 */
export const gartnerRule: SiteRule = {
  hostPattern: '*.gartner.com',
  articleRootSelector: '[class*="aem-Grid"]',
};
