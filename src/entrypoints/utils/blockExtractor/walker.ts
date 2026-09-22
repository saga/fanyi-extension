/**
 * blockExtractor TreeWalker
 *
 * 核心遍历逻辑:
 *   1. createTreeWalker + acceptNode 决定每个节点的 FILTER_* 状态
 *   2. FILTER_ACCEPT 节点进 grabNode() 评估是否可作为翻译块
 *   3. 已拒绝的祖先进 WeakSet 缓存,后代 O(1) 查表拒绝,避免回溯父链
 *
 * 同时处理 Shadow DOM (Reddit <shreddit-post> 等 web component 文本)。
 */

import {
  DIRECT_SET,
  INLINE_SET,
  SEMANTIC_SKIP_TAGS,
  SKIP_SET,
  TABLE_TAGS,
  type WalkerCounters,
} from './constants';
import {
  classifyChildren,
  getSiteWalkOptions,
  hasBlockLevelParent,
  hasContentTokens,
  hasTranslateBlockClass,
  isAdBySize,
  isAdIframe,
  isContentEditable,
  isCookieBannerByText,
  isElementHidden,
  isInsideArticle,
  isLowPriorityElement,
  isMetadataClass,
  isNonHTMLNamespace,
  isOverlayElement,
  isParagraphLikeElement,
  isPopupByStyle,
  isValidText,
  normalizeBlockText,
  classifyNode,
  shouldSkipByClass,
  shouldSkipBySiteRules,
  type SiteWalkOptions,
} from './rules';
import type { TextBlock } from './types';

/** DIRECT_SET 拼接成 CSS 选择器, 用于 querySelector 检查子树是否还有 DIRECT_SET 元素。 */
const DIRECT_SET_CSS_SELECTOR = Array.from(DIRECT_SET).join(',');

// =============================================================================
// Soft score hint (ultra-cheap heuristic)
// =============================================================================
//
// 只用于 sidebar / article 混排、SPA wrapper vs real article body 等场景。
// 给 walker 一个"倾向性"判断，而不是硬过滤，避免过早 reject/skip 正文块。

function computeSoftHint(el: Element): number {
  let score = 0;
  const cls = (el.className || '').toLowerCase();

  if (cls.includes('article') || cls.includes('post')) score += 2;
  if (cls.includes('content') || cls.includes('body')) score += 2;
  if (cls.includes('main')) score += 1;

  if (cls.includes('sidebar') || cls.includes('nav')) score -= 3;
  if (cls.includes('footer') || cls.includes('comment')) score -= 2;

  return score;
}

function getSoftHint(el: Element, scoreHint: WeakMap<Element, number>): number {
  let hint = scoreHint.get(el);
  if (hint === undefined) {
    hint = computeSoftHint(el);
    scoreHint.set(el, hint);
  }
  return hint;
}

/**
 * 对低优先级元素打标记。同一元素只打一次（通过 scoreHint 缓存判断）。
 */
function markLowPriorityIfNeeded(
  el: Element,
  scoreHint: WeakMap<Element, number>
): void {
  if (!scoreHint.has(el) && isLowPriorityElement(el)) {
    el.setAttribute('data-fanyi-low-priority', 'true');
  }
}

// =============================================================================
// grabNode: 把已 ACCEPT 的节点评估为"翻译块"或"非块"
// =============================================================================

/**
 * 是否值得作为翻译块返回。
 * 与 walker 的 acceptNode 不同: 这里做更细的内容检查 (text 有效性、子树结构)。
 * 节点已被 walker 接受,不代表它一定能作为翻译块 (e.g. 空 <p>)。
 *
 * `site` 提供站点级文本剔除选择器：判定用的文本必须与最终抽取的文本一致，
 * 否则「只剩被剔除装饰」的容器会被判为有效块（HN 的 comhead 包裹 div）。
 */
function grabNode(node: Node, site: SiteWalkOptions): Element | false {
  if (!node || node instanceof Text) return false;
  if (!(node instanceof Element)) return false;

  const el = node;
  const tag = el.tagName.toLowerCase();

  // 1) 块级元素 (DIRECT_SET) 或段落类容器 (如 Draft.js 段落): 若子树还有 DIRECT_SET 元素,自身不算
  //    (子块会被独立抓到,避免重复)。段落类 div 自身作为整块返回。
  if (DIRECT_SET.has(tag) || isParagraphLikeElement(el)) {
    if (DIRECT_SET.has(tag)) {
      const hasDirectSetDescendant = el.querySelector(DIRECT_SET_CSS_SELECTOR) !== null;
      if (hasDirectSetDescendant) return false;
    }
    return isValidText(getBlockText(el, site.excludeFromText)) ? el : false;
  }

  // 2) 内联元素: 在 article 内且无块级父 → 单独抓; 否则跳过
  if (INLINE_SET.has(tag)) {
    if (isInsideArticle(el) && !hasBlockLevelParent(el)) {
      return isValidText(getBlockText(el, site.excludeFromText)) ? el : false;
    }
    return false;
  }

  // 3) 其他 (div, section, article...): 看子节点结构
  const { hasDirectText, hasNonInlineChild } = classifyChildren(el);
  if (hasNonInlineChild) return false; // 容器,子树会被独立处理
  if (hasDirectText) {
    return isValidText(getBlockText(el, site.excludeFromText)) ? el : false;
  }
  return false;
}

// =============================================================================
// acceptNode: walker 的过滤回调
// =============================================================================

/**
 * TreeWalker 的 acceptNode: 决定 FILTER_ACCEPT / FILTER_SKIP / FILTER_REJECT。
 *
 * 状态机核心:
 *   - FILTER_REJECT = 跳过自身 + 整棵子树
 *   - FILTER_SKIP   = 跳过自身, 走子树
 *   - FILTER_ACCEPT = 自身进 grabNode, 不走子树
 *
 * 性能优化:
 *   1. rejectedCache (WeakSet) 缓存所有被 REJECT 的元素,后代 O(1) 拒绝
 *   2. 早返回: 便宜的检查放前面 (parent rejected, SKIP_SET)
 *   3. 隐藏/命名空间检查一旦失败立即入 cache
 */
function acceptWalkerNode(
  node: Node,
  counters: WalkerCounters,
  rejectedCache: WeakSet<Element>,
  scoreHint: WeakMap<Element, number>,
  site: SiteWalkOptions
): number {
  // 文本节点: 仅当父被拒时连坐拒绝;否则接受让 grabNode 评估
  if (node instanceof Text) {
    if (node.parentElement && rejectedCache.has(node.parentElement)) {
      return NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_ACCEPT;
  }

  if (!(node instanceof Element)) {
    return NodeFilter.FILTER_SKIP;
  }

  const el = node;
  const tag = el.tagName.toLowerCase();

  // 0) 父已被拒 → 整棵连坐拒绝 (O(1) 查表,避免向上回溯)
  if (el.parentElement && rejectedCache.has(el.parentElement)) {
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  // 0.5) 弹窗 / overlay / cookie banner：直接标记移除并拒绝整棵子树。
  // 这些元素不是页面内容，会遮挡正文，必须在 walker 最前面处理。
  if (isOverlayElement(el)) {
    el.setAttribute('data-fanyi-remove', 'true');
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  // 1) 硬性拒绝条件 (整棵子树拒绝,无例外)
  if (isNonHTMLNamespace(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }
  // 嵌套 <body>（parent 不是 <html>）不拒绝：WordPress CMS 注入的非标准
  // HTML 会在正文中产生 <!DOCTYPE><div><body>…</body></div>，其内容
  // 是正文的一部分，不应因 <body> 在 SKIP_SET 中而被整棵跳过。
  // 文档级 <body>（parent 是 <html>）不会被 walker 访问到（遍历
  // 起始于 <main>/<article> 等下游容器），所以放行嵌套 body 是安全的。
  //
  // 站点规则 translateTables：把 table 系标签从 SKIP_SET 剪枝里放行。
  // HN 等站点用嵌套 table 做整页布局，不放行则整页抽取为 0 块。
  const skipSetMatch =
    SKIP_SET.has(tag) && !(site.translateTables && TABLE_TAGS.has(tag));
  const isNestedBody = tag === 'body' && el.parentElement?.tagName?.toLowerCase() !== 'html';
  if ((skipSetMatch && !isNestedBody) || hasTranslateBlockClass(el) || isContentEditable(el)) {
    markLowPriorityIfNeeded(el, scoreHint);
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }
  if (isElementHidden(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }
  // 噪声类 (广告 / cookie / 侧边栏 / 推荐 等): 整棵子树拒绝。
  // 用 classifyNode() 显式区分「节点自身是噪声」与「节点子树该被剪掉」两个语义
  // （ADR-001 P0）：结构性内容容器 (article / main) 即使自身 class 命中噪声
  // token（如 404media.co 的 <article class="... has-sidebar"> 命中 "sidebar"），
  // 也不应被整棵剪枝，仅跳过自身、继续下钻提取内部正文。
  // （div/section 即使含内容 token 也不豁免，否则 ad-content / sponsored-content
  // 等噪声 div 会被下钻提取。article/main 是语义内容根，可安全豁免。）
  const nodeCls = classifyNode(el);
  if (nodeCls.nodeNoise) {
    if (nodeCls.structuralContainer) {
      counters.skipped++;
      return NodeFilter.FILTER_SKIP;
    }
    markLowPriorityIfNeeded(el, scoreHint);
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  // 动态噪声检测 (第三方脚本插入的 Cookie Banner / Popup / 广告位等)。
  // 这些检查相对 expensive,但只在 DYNAMIC_NOISE_CONTAINER_TAGS 上触发,
  // 并用 WeakSet 在 rules 内部做了缓存。
  if (isCookieBannerByText(el) || isPopupByStyle(el) || isAdBySize(el) || isAdIframe(el)) {
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  // 结构容器标签（article/main）和带内容 token 的容器元素（section/div）：
  // 不因元数据类名而拒绝。
  // 像 WordPress 的 <article class="category-ai"> 或
  // <section class="post__content category-ai-and-ml"> 中 "category"
  // 会命中 METADATA_TOKENS，导致整篇文章子树被拒绝，正文丢失翻译。
  // 对 section/div, 当同时拥有内容 token (post/content/article/story/entry/rich) 时,
  // 它是正文容器, 不应因 metadata class 被拒绝。
  // 注意: 仅限容器标签, <p class="post-meta"> 等叶子节点仍应被拒绝。
  const isContainerWithContent =
    (tag === 'section' || tag === 'div') && hasContentTokens(el);
  if (
    tag !== 'article' && tag !== 'main' &&
    isMetadataClass(el) && !isContainerWithContent
  ) {
    // 文章元数据 (作者 / 日期 / 分类) 整棵子树拒绝
    rejectedCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  // 2) <header> 特殊处理: 文章 header vs 页面 chrome
  //    - 含 h1-h6 → 跳过自身, 走子树 (文章标题要翻)
  //    - 不含     → 整棵拒绝 (navbar / site-header)
  if (tag === 'header') {
    const hasHeading = el.querySelector('h1, h2, h3, h4, h5, h6') !== null;
    if (hasHeading) {
      counters.skipped++;
      return NodeFilter.FILTER_SKIP;
    }
    rejectedCache.add(el);
    counters.skipped++;
    return NodeFilter.FILTER_REJECT;
  }

  // 3) 其他语义噪声 (footer / aside / nav): 整棵拒绝
  if (SEMANTIC_SKIP_TAGS.has(tag)) {
    rejectedCache.add(el);
    counters.skipped++;
    return NodeFilter.FILTER_REJECT;
  }

  // ⭐ soft score hint: 给 walker 一个轻量倾向性判断，避免过早误杀。
  const hint = getSoftHint(el, scoreHint);

  // 4) DIRECT_SET 与段落类容器: 自身评估, 若子树还有 DIRECT_SET 则跳过 (让子块独立抓)
  if (DIRECT_SET.has(tag) || isParagraphLikeElement(el)) {
    if (DIRECT_SET.has(tag)) {
      const hasDirectSetDescendant = el.querySelector(DIRECT_SET_CSS_SELECTOR) !== null;
      if (hasDirectSetDescendant) {
        counters.skipped++;
        return NodeFilter.FILTER_SKIP;
      }
    }
    // hint 为负（sidebar/nav/footer 里的 p/li）降权 skip，不抓成独立块
    if (hint < 0) {
      counters.skipped++;
      return NodeFilter.FILTER_SKIP;
    }
    // 文本有效性用「剔除站点装饰后的文本」判定：否则只剩导航文字的包裹容器
    // （HN 的 comhead 包裹 div / 顶栏 td）会被当成有效块抓出来。
    if (isValidText(getBlockText(el, site.excludeFromText))) {
      counters.accepted++;
      // 段落类容器整体成块 → 子树不再单独抓。
      //
      // ⚠️ TreeWalker 的 FILTER_ACCEPT 只表示「这个节点被接受」，**不会**阻止
      // 继续下钻子节点（本文件顶部"ACCEPT 不走子树"的注释不准确）。所以
      // `div.commtext` 被整体抓取后，内部的 `<p>` 还会被再抓一遍，产生重复译文
      // —— HN 评论正文正是「裸文本 + 多个 `<p>`」混排。
      // 把容器记入 rejectedCache，后代在 step 0 连坐 REJECT。
      //
      // 对纯 DIRECT_SET 元素（如 `<p>`）无副作用：它们的内联/文本后代本来就
      // 抓不成块（grabNode 里 hasBlockLevelParent 遇到 `<p>` 即返回 true）。
      rejectedCache.add(el);
      return NodeFilter.FILTER_ACCEPT;
    }
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;
  }

  // 5) 其他容器: 看子节点结构决定
  const { hasDirectText, hasNonEmptyElement, hasOnlyInlineChildren } =
    classifyChildren(el);

  if (!hasOnlyInlineChildren) {
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;
  }
  if (hasDirectText || hasNonEmptyElement) {
    if (isValidText(getBlockText(el, site.excludeFromText))) {
      counters.accepted++;
      return NodeFilter.FILTER_ACCEPT;
    }
  }
  counters.skipped++;
  return NodeFilter.FILTER_SKIP;
}

// =============================================================================
// 块文本计算（含站点级文本剔除）
// =============================================================================

/** 元素是否命中任一选择器（无效选择器静默忽略，不影响抽取）。 */
function matchesAnySelector(el: Element, selectors: readonly string[]): boolean {
  for (const selector of selectors) {
    try {
      if (el.matches(selector)) return true;
    } catch {
      // 无效选择器：忽略，宁可多翻译也不要让抽取崩掉
    }
  }
  return false;
}

/** 递归收集文本，跳过命中 selectors 的子树。拼接语义与 textContent 一致（不加分隔符）。 */
function collectTextExcluding(
  node: Node,
  selectors: readonly string[],
  out: string[]
): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(child.textContent ?? '');
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const childEl = child as Element;
    if (matchesAnySelector(childEl, selectors)) continue;
    // 块级子元素之间补一个空行。
    // `textContent` 会把 `<p>a</p><p>b</p>` 拼成 "ab"；对「整块抓取的多段容器」
    // （站点 blockSelectors，如 HN 的 div.commtext）必须保留段落边界，
    // 否则译文会糊成一整段。只在剔除路径生效，快路径行为不变。
    const childTag = childEl.tagName.toLowerCase();
    if (out.length > 0 && (DIRECT_SET.has(childTag) || isParagraphLikeElement(childEl))) {
      out.push('\n\n');
    }
    collectTextExcluding(childEl, selectors, out);
  }
}

/**
 * 计算翻译块的文本。
 *
 * `selectors` 为 undefined 时等价于 `el.textContent`（快路径，只多一次规整）。
 * 站点规则声明 `excludeFromTextSelectors` 时走剔除路径 —— 把命中的子树从文本里
 * 去掉，因为 `textContent` 会把它们算进来。该文本同时用于**文本有效性判定**
 * 与最终抽取，保证「判为有效的」= 「真正翻译的」。
 *
 * 两条路径最后都过 `normalizeBlockText`：它替掉裸 `trim()`，把首尾的零宽 /
 * 不可见格式字符（Mintlify 标题锚点的 U+200B 等）一并去掉。
 */
function getBlockText(el: Element, selectors: readonly string[] | undefined): string {
  if (!selectors) return normalizeBlockText(el.textContent ?? '');
  const parts: string[] = [];
  collectTextExcluding(el, selectors, parts);
  return normalizeBlockText(parts.join(''));
}

// =============================================================================
// 主收集函数
// =============================================================================

/**
 * 从 startNode 出发, 收集所有翻译块到 blocks。
 * 同时跨 Shadow DOM 边界 (Reddit <shreddit-post> 等)。
 */
export function collectBlocks(
  startNode: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>
): WalkerCounters {
  const counters = { rejected: 0, skipped: 0, accepted: 0 };
  // Per-walker: 被 REJECT 的元素入表 + soft score hint 缓存。
  // 随 DOM GC, 无内存泄漏。
  const rejectedCache = new WeakSet<Element>();
  const scoreHint = new WeakMap<Element, number>();

  // 站点级 walker 选项：每次遍历取一次（getSiteRule 内部按 URL 缓存）。
  // 无站点规则时两个开关都关闭 → 与历史行为完全一致。
  const site = getSiteWalkOptions();

  const walker = document.createTreeWalker(
    startNode,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        acceptWalkerNode(node, counters, rejectedCache, scoreHint, site),
    }
  );

  let currentNode: Node | null;
  while ((currentNode = walker.nextNode()) !== null) {
    const translateNode = grabNode(currentNode, site);
    if (!translateNode) continue;

    const text = getBlockText(translateNode, site.excludeFromText);
    if (!text) continue;

    // 去重: 同样的段落出现在多个 callout (e.g. HBR summary box + body) 只取一个。
    // 节省 API 调用 + 避免堆叠相同译文。
    if (seenTexts.has(text)) {
      counters.skipped++;
      continue;
    }
    seenTexts.add(text);

    const id = `b${++blockIdRef.value}`;
    if (translateNode instanceof HTMLElement) {
      translateNode.dataset.fanyiBlockId = id;
    }
    blocks.push({
      id,
      xpath: getXPath(translateNode),
      tag: translateNode.tagName.toLowerCase(),
      text,
      context: {
        headingPath: getHeadingPath(translateNode),
        position: blockIdRef.value,
      },
    });
  }

  // TreeWalker 不跨 shadow root 边界, 手动遍历 open shadow roots。
  collectFromShadowHosts(startNode, blocks, blockIdRef, seenTexts);

  return counters;
}

/**
 * 递归遍历 host 元素的 open shadow root。
 * 用宽松的 walker (FILTER_ACCEPT) 拿到 host 自身, 检查 shadowRoot。
 */
function collectFromShadowHosts(
  root: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>
): void {
  const treeWalker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    { acceptNode: () => NodeFilter.FILTER_ACCEPT }
  );

  let currentNode: Node | null;
  while ((currentNode = treeWalker.nextNode()) !== null) {
    if (!(currentNode instanceof Element)) continue;
    const shadow = currentNode.shadowRoot;
    if (shadow && shadow.mode === 'open') {
      collectBlocks(shadow, blocks, blockIdRef, seenTexts);
    }
  }
}

// =============================================================================
// XPath & Heading Path (辅助)
// =============================================================================

/** 生成元素 XPath, 用于回退查找 (data attr 优先)。 */
export function getXPath(node: Node): string {
  if (node.nodeType === Node.DOCUMENT_NODE) return '';
  if (!(node instanceof Element)) return '';

  const parts: string[] = [];
  let current: Element | null = node;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }
  return '/' + parts.join('/');
}

/** 收集元素之前所有 h1-h6 标题, 用于 context.headingPath。 */
function getHeadingPath(block: Element): string[] {
  const headings: string[] = [];
  let current: Element | null = block;
  while (current) {
    const prev = findPreviousHeading(current);
    if (!prev) break;
    // headingPath 也是送给模型的上下文 → 同样要去掉首尾零宽字符
    headings.unshift(normalizeBlockText(prev.textContent ?? ''));
    current = prev;
  }
  return headings;
}

function findPreviousHeading(element: Element): Element | null {
  let current: Node | null = element;
  while (current) {
    // 兄弟节点倒序遍历
    while (current.previousSibling) {
      current = current.previousSibling;
      if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as Element;
        if (isHeading(el)) return el;
        const found = findLastHeadingInSubtree(el);
        if (found) return found;
      }
    }
    current = current.parentElement;
  }
  return null;
}

function findLastHeadingInSubtree(element: Element): Element | null {
  for (const child of Array.from(element.children).reverse()) {
    if (isHeading(child)) return child;
    const found = findLastHeadingInSubtree(child);
    if (found) return found;
  }
  return null;
}

function isHeading(el: Element): boolean {
  return /^H[1-6]$/.test(el.tagName);
}
