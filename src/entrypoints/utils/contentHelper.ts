import { extractBlocks, isOverlayElement, type TextBlock } from './blockExtractor';
import { buildChunks, type Chunk } from './chunkBuilder';
import { detectArticleRoot } from './contentDetector';
import { matchSiteRule } from '../../rules';

import { logger } from '../../utils/logger';
// 优先级：先 class 后标签，先更具体的子容器再更通用的包裹元素。
// 像 bankingdive.com 把 <article> 用作整页 wrapper、正文放在
// .article-body 的站点，会直接定位到 .article-body。HBR 这种把整篇
// 装在 <article> 内的站点仍然走 <article>。
const ARTICLE_SELECTORS = [
  '.article-body',
  '.article-content',
  '.article-text',
  '.story-body',
  '.story-content',
  '.u-rich-text-blog',        // Webflow blog rich text (claude.com)
  '.rich-text',               // Generic rich text wrapper
  '.blog-content',            // Ghost CMS
  '.post-content',            // Common blog CMS (Jane Street, Hugo, Jekyll)
  '.entry-content',           // WordPress
  '.page-content',
  'article',
  '[role="article"]',
  '[role="main"]',
  'main',
  '.main-content',
  '.content-body',
];

/**
 * 对于 bankingdive.com 这类把 <article> 当作整页 wrapper 的站点，
 * 直接用 <article> 会把页眉（h1、导语、分享菜单、署名、图片说明）
 * 和正文混在一起进同一个 chunk：模型拿到一份头重脚轻的输入，往
 * 往往正文翻译甚至直接截断。
 *
 * 策略：优先 .article-body 等具体容器，但当具体容器**外层是
 * <article> 且 <article> 里有不在该容器内的 h1/h2 标题**时，向上
 * 扩展到 <article>（TreeWalker 会一并遍历到 .first-page-pdf 里的 h1）。
 *
 * 校验：仅当 <article> 内**不在**该容器内、且有非空文本的 h1/h2
 * 才扩展。空标题（<h1></h1> 或全空格/装饰性 svg）不触发扩展，
 * 避免无谓把整页包装带回来。
 */
function hasValidHeadingOutside(
  container: Element,
  ancestor: Element
): Element | null {
  const headings = ancestor.querySelectorAll('h1, h2');
  for (const h of Array.from(headings)) {
    if (container.contains(h)) continue;
    const text = (h.textContent || '').trim();
    if (text.length < 4) continue;
    return h;
  }
  return null;
}

function refineArticleRoot(candidate: Element): Element {
  const SPECIFIC_SELECTORS = [
    '.article-body',
    '.article-content',
    '.article-text',
    '.story-body',
    '.story-content',
    '.post-content',            // Jane Street, Hugo, Jekyll
  ];

  if (SPECIFIC_SELECTORS.some((sel) => candidate.matches?.(sel))) {
    // candidate 已经是具体内容容器。如果它的祖先是 <article> 且
    // article 里有 h1/h2 标题不在 candidate 内，向上扩展到 <article>。
    const articleAncestor = candidate.closest('article');
    if (articleAncestor && articleAncestor !== candidate) {
      const heading = hasValidHeadingOutside(candidate, articleAncestor);
      if (heading) {
        logger.debug(
          '[ContentHelper] Bumping root up to <article> to capture heading:',
          heading.textContent?.slice(0, 40)
        );
        return articleAncestor;
      }
    }
    return candidate;
  }

  for (const sel of SPECIFIC_SELECTORS) {
    const inner = candidate.querySelector(sel);
    if (inner && candidate.contains(inner)) {
      // candidate 是 <article> 时：如果它本身含有效 h1/h2 标题而
      // inner 不含（典型：标题在 .first-page-pdf，正文在 .article-body），
      // 保留 candidate（<article>）并依赖 SKIP_CLASS_PATTERNS 过滤
      // 噪声；否则下钻到 inner。
      if (candidate.tagName.toLowerCase() === 'article') {
        const heading = hasValidHeadingOutside(inner, candidate);
        if (heading) {
          logger.debug(
            '[ContentHelper] Keeping outer <article> to preserve heading outside inner body:',
            heading.textContent?.slice(0, 40)
          );
          return candidate;
        }
      }
      logger.debug('[ContentHelper] Refining article root to inner:', sel);
      return inner;
    }
  }
  return candidate;
}

function hasMeaningfulContent(el: Element): boolean {
  // 过滤掉空的占位容器（如 Microsoft TechCommunity 里第一个 <article>
  // 是 CustomComponent_lia-article__sQ7z4 这类无正文的包装）。
  const text = (el.textContent || '').trim();
  return text.length > 0;
}

/**
 * 穿透纯包装层：当 parent 的文本和 child 相同（parent 只是 wrapper）时向上穿。
 * 不负责"hero/content 是否同一篇文章"等业务判断 —— 那是 chooseBestRoot 的事。
 *
 * 保留 nav/footer/header 等 class 的守卫：这些不是 wrapper，遇到就停。
 */
function expandWrappers(el: Element): Element {
  let current: Element = el;
  const MAX_UP = 6;
  for (let i = 0; i < MAX_UP; i++) {
    const parent = current.parentElement;
    if (!parent) break;

    const tag = parent.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;

    const classes = `${parent.className || ''} ${parent.id || ''}`;
    if (/nav|menu|sidebar|footer|header|comment|widget/i.test(classes)) break;

    const parentLen = (parent.textContent || '').trim().length;
    const currentLen = (current.textContent || '').trim().length;

    // 纯包装层（文本相同），穿过它继续向上
    if (parentLen <= currentLen) {
      current = parent;
      continue;
    }
    break;
  }
  return current;
}

// =============================================================================
// ArticleRootScorer —— 基于启发式评分的根节点选择
// =============================================================================
//
// 把"hero 和正文是否同一篇文章""parent 是否比 candidate 更适合做根"等判断
// 从 ad-hoc 规则（expandIfFragmented 的兄弟文本检测）改为统一的评分函数。
// chooseBestRoot 对 candidate / parent / grandParent 三层评分，选最高分。
// 随着评分因子积累，绝大多数博客（Webflow / WordPress / Ghost / Medium /
// Hugo / Substack / OpenAI / Anthropic / Cloudflare）都能通过统一逻辑识别，
// 无需为每个站点写 site rule。

interface RootScore {
  score: number;
  reasons: string[];
}

const scoreCache = new WeakMap<Element, RootScore>();

/**
 * 对一个候选容器评分。评分不是黑盒：reasons 记录每个因子的贡献，
 * 日志一眼看出为什么选了/没选这个节点。
 */
function scoreArticleContainer(container: Element): RootScore {
  const cached = scoreCache.get(container);
  if (cached) return cached;

  let score = 0;
  const reasons: string[] = [];

  // 1) h1：单 h1 是文章标志，多 h1 可能是列表页
  const h1Count = container.querySelectorAll('h1').length;
  if (h1Count === 1) {
    score += 20;
    reasons.push('+20 single h1');
  } else if (h1Count > 1) {
    score -= 10;
    reasons.push(`-10 multiple h1 (${h1Count})`);
  }

  // 2) h2 >= 2：说明有多个小节，像正文
  const h2Count = container.querySelectorAll('h2').length;
  if (h2Count >= 2) {
    score += 10;
    reasons.push(`+10 sections (h2=${h2Count})`);
  }

  // 3) 正文长度：800 字 +1，8000 字 +10，24000 字 +30（封顶）
  const textLength = (container.textContent ?? '').trim().length;
  const textScore = Math.min(30, textLength / 800);
  score += textScore;
  reasons.push(`+${textScore.toFixed(1)} text length (${textLength})`);

  // 4) 段落数：越多越像正文（封顶 20）
  const pCount = container.querySelectorAll('p').length;
  const pScore = Math.min(20, pCount);
  score += pScore;
  reasons.push(`+${pScore} paragraphs (${pCount})`);

  // 5) 图片：博客一般都有图（封顶 5）
  const figures = container.querySelectorAll('img, figure').length;
  const figScore = Math.min(5, figures);
  score += figScore;
  reasons.push(`+${figScore} images (${figures})`);

  // 6) 作者署名
  const author = container.querySelector(
    '[rel=author], .author, .byline, [class*=author]',
  );
  if (author) {
    score += 8;
    reasons.push('+8 author');
  }

  // 7) 发布时间
  const time = container.querySelector('time, [class*=date], [class*=publish]');
  if (time) {
    score += 6;
    reasons.push('+6 time');
  }

  // 8) 导航类元素扣分（nav/menu/sidebar/footer/header）
  const navCount = container.querySelectorAll(
    'nav, .menu, .sidebar, footer, header',
  ).length;
  if (navCount > 0) {
    const penalty = navCount * 8;
    score -= penalty;
    reasons.push(`-${penalty} nav elements (${navCount})`);
  }

  // 9) 按钮过多：CTA 页面特征
  const buttons = container.querySelectorAll('button, a.btn').length;
  if (buttons > 10) {
    score -= 15;
    reasons.push(`-15 too many buttons (${buttons})`);
  }

  // 10) 相关推荐区域扣分
  const related = container.querySelector('[class*=related], [class*=recommend]');
  if (related) {
    score -= 8;
    reasons.push('-8 related/recommend section');
  }

  // 11) 列表项过多：可能是导航/目录页
  const liCount = container.querySelectorAll('li').length;
  if (liCount > 80) {
    score -= 10;
    reasons.push(`-10 too many li (${liCount})`);
  }

  const result: RootScore = { score, reasons };
  scoreCache.set(container, result);
  return result;
}

/**
 * 对 candidate / parent / grandParent 三层评分，选最高分。
 * 把"hero 和正文分属兄弟 section"这类判断从规则改为评分：
 * 如果 parent（包含 hero + 正文）的分数比 candidate（只含正文）高，就选 parent。
 *
 * 守卫：candidate 已有 h1 时直接返回。h1 是文章主标题，candidate 有 h1
 * 说明它就是文章根（如 .post-content 自己带 h1），不需要向上找。
 * 只有 candidate 缺 h1（如 claude.com 的 h1 在 hero section）时才向上评分。
 */
function chooseBestRoot(candidate: Element): Element {
  // h1 守卫：candidate 已有 h1（文章主标题），直接返回。
  // 如 Jane Street 的 .post-content 自带 h1，说明它就是文章根。
  if (candidate.querySelector('h1')) {
    return candidate;
  }

  // candidate 缺 h1 时（如 claude.com 的 h1 在 hero section，正文 section 缺 h1），
  // 向上扫描直到遇到含 h1 的祖先或 body/html，收集所有候选后评分选最高分。
  // 固定 3 层不够：claude.com 的 .u-rich-text-blog 到 main.page_main 有 7 层嵌套。
  const list: Element[] = [];
  let p: Element | null = candidate;
  while (p) {
    const tag = p.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    list.push(p);
    // 遇到含 h1 的祖先就停止向上 —— h1 是文章主标题的标志，
    // 更上层的容器（如 page_wrap 含整个页面）只会引入噪声。
    if (p.querySelector('h1')) break;
    p = p.parentElement;
  }

  let best = list[0];
  let bestScore = -Infinity;
  for (const node of list) {
    const result = scoreArticleContainer(node);
    logger.debug(
      `[ContentHelper] Candidate <${node.tagName}> .${(node.className || '').slice(0, 40)} score=${result.score.toFixed(1)}`,
      result.reasons,
    );
    if (result.score > bestScore) {
      best = node;
      bestScore = result.score;
    }
  }
  return best;
}

function findArticleRoot(doc: Document): Element {
  // Layer 0: 站点特定 articleRootSelector（最高优先级）
  // 当通用选择器无法正确定位正文根时（如 claude.com 的 hero 和正文
  // 分属兄弟 section），用站点规则的 articleRootSelector 直接指定。
  const siteRule = matchSiteRule(window.location.href)?.siteRule;
  if (siteRule?.articleRootSelector) {
    const el = doc.querySelector(siteRule.articleRootSelector);
    if (el && hasMeaningfulContent(el)) {
      logger.debug(
        `[ContentHelper] Site rule articleRootSelector: ${siteRule.articleRootSelector} → <${el.tagName}> .${(el.className || '').slice(0, 40)}`,
      );
      return el;
    }
    logger.warn(
      `[ContentHelper] Site rule articleRootSelector "${siteRule.articleRootSelector}" matched no meaningful element, falling back to Layer 1`,
    );
  }

  // Layer 1: 选择器快速匹配（处理已知站点）
  // 对每个选择器：先取内容最多的匹配项（避免空占位符/短摘要），
  // 再 refine，再 expandWrappers（穿透纯包装层），最后 chooseBestRoot
  //（对 candidate/parent/grandParent 评分，选最高分）。
  for (const selector of ARTICLE_SELECTORS) {
    const els = Array.from(doc.querySelectorAll(selector));
    let bestInSelector: Element | null = null;
    let bestLen = 0;
    for (const el of els) {
      const len = (el.textContent || '').trim().length;
      if (len > 0 && len > bestLen) {
        bestLen = len;
        bestInSelector = el;
      }
    }
    if (bestInSelector) {
      const refined = refineArticleRoot(bestInSelector);
      const expanded = expandWrappers(refined);
      const best = chooseBestRoot(expanded);
      if (best !== expanded) {
        logger.debug(
          `[ContentHelper] Chose <${best.tagName}> .${(best.className || '').slice(0, 40)} over <${expanded.tagName}> .${(expanded.className || '').slice(0, 40)} by scoring`,
        );
      }
      return best;
    }
  }

  // Layer 2: 智能评分（处理未知站点）
  const detected = detectArticleRoot(doc);
  if (detected && hasMeaningfulContent(detected)) return detected;

  // Layer 3: 兜底
  return doc.body || doc.documentElement;
}

/**
 * 隐藏文章根节点之外的弹窗 / overlay / cookie banner。
 *
 * walker 只遍历 effectiveRoot 子树, body 层级的 modal (登录弹窗、
 * cookie 同意浮层、newsletter 订阅弹窗等) 不会被遇到。这些元素
 * 会遮挡译文, 需要在翻译前单独标记为 data-fanyi-remove 隐藏掉。
 *
 * 用宽泛的 CSS 选择器先圈定候选, 再用 isOverlayElement 精确判定,
 * 避免对全文档做 getComputedStyle 扫描。
 */
function hideBodyOverlays(doc: Document, articleRoot: Element): void {
  const candidates = doc.querySelectorAll(
    '[class*="modal"], [class*="popup"], [class*="overlay"], ' +
      '[class*="dialog"], [class*="backdrop"], [class*="lightbox"], ' +
      '[class*="cookie"], [id*="modal"], [id*="popup"], [id*="overlay"], ' +
      '[id*="dialog"], [id*="cookie"], [role="dialog"], ' +
      // form action 指向 http:// 的订阅/搜索表单（Mixed Content 来源，
      // 通常在侧边栏，不属于正文）。isOverlayElement 中的 form+http 规则
      // 会精确判定，这里只做候选圈定。
      'form[action^="http://"]',
  );
  for (const el of candidates) {
    const tag = el.tagName.toLowerCase();
    // 绝不隐藏 body / html / article 根节点本身
    if (tag === 'body' || tag === 'html') continue;
    if (articleRoot.contains(el)) continue;
    if (el === articleRoot) continue;
    if (el.hasAttribute('data-fanyi-remove')) continue;
    // 跳过扩展端自身注入的 UI 元素（class 以 fanyi- 开头或为 selection-translator），
    // 否则 hideBodyOverlays 的 [class*="overlay"] 会匹配到 .fanyi-status-overlay
    // 并把它标记为 data-fanyi-remove，导致翻译过程中状态提示条被隐藏。
    {
      const cls = el.classList;
      let isExtensionUi = cls.contains('selection-translator');
      if (!isExtensionUi) {
        for (let i = 0; i < cls.length; i++) {
          if (cls[i].startsWith('fanyi-')) {
            isExtensionUi = true;
            break;
          }
        }
      }
      if (isExtensionUi) continue;
    }
    if (isOverlayElement(el)) {
      el.setAttribute('data-fanyi-remove', 'true');
    }
  }
}

// =============================================================================
// Data Island fallback —— 从 SPA 数据岛提取正文
// =============================================================================
//
// 许多 SPA 站点（Next.js / Nuxt / SvelteKit）首屏 DOM 是骨架，真正的内容塞在
// <script type="application/json"> / #__NEXT_DATA__ / #__NUXT_DATA__ 里。
// 当 DOM 上 extractBlocks 抓到 0 块时，尝试从数据岛解析结构化数据，递归提取
// 字符串字段，包装成 TextBlock。
//
// 不修改 DOM：返回的 TextBlock 用占位 xpath `/data-island/[i]`，调用方据此
// 知道这些块没有真实 DOM 节点，apply 阶段会跳过 DOM 修改。

/** 优先字段名：这些字段通常是正文（不分大小写）。 */
const DATA_ISLAND_PRIORITY_FIELDS =
  /^(articleBody|text|content|description|body|html|markdown|summary|excerpt|plaintext)$/i;

/** 跳过字段名：导航/元数据/技术字段（不分大小写）。 */
const DATA_ISLAND_SKIP_FIELDS =
  /^(url|href|src|image|icon|logo|type|@type|@context|id|key|name|slug|tag|category|author|date|published|modified|created|updated|locale|lang|language|version|site|domain|host|path|query|method|status|code|token|csrf|nonce)$/i;

/** 短于此长度的字符串不算正文（过滤标题、面包屑、按钮文案）。 */
const DATA_ISLAND_MIN_TEXT_LEN = 50;

/**
 * 递归遍历 JSON 数据，提取正文字符串。
 * - 命中 PRIORITY_FIELDS 的字段：长度 ≥ 1 即采集（标题、description 可能短）
 * - 其他字段：长度 ≥ DATA_ISLAND_MIN_TEXT_LEN 才采集（避免短字段污染）
 * - SKIP_FIELDS 字段：跳过
 */
function walkDataIsland(
  obj: unknown,
  fieldName: string | undefined,
  texts: string[],
  seen: Set<string>,
): void {
  if (obj == null || typeof obj === 'number' || typeof obj === 'boolean') return;

  if (typeof obj === 'string') {
    const trimmed = obj.trim();
    if (trimmed.length === 0) return;
    if (seen.has(trimmed)) return;

    if (fieldName && DATA_ISLAND_SKIP_FIELDS.test(fieldName)) return;

    // 优先字段：短文本也采集（如 description、summary）
    // 其他字段：长度阈值过滤
    const isPriority = fieldName && DATA_ISLAND_PRIORITY_FIELDS.test(fieldName);
    if (!isPriority && trimmed.length < DATA_ISLAND_MIN_TEXT_LEN) return;

    seen.add(trimmed);
    texts.push(trimmed);
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) walkDataIsland(item, fieldName, texts, seen);
    return;
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      walkDataIsland(record[key], key, texts, seen);
    }
  }
}

/**
 * 从 SPA 数据岛提取正文 TextBlock。
 *
 * 候选 script（按优先级）：
 * 1. #__NEXT_DATA__（Next.js SSR 数据）
 * 2. #__NUXT_DATA__（Nuxt SSR 数据）
 * 3. <script type="application/json">（通用，排除前两者）
 *
 * 解析失败的 script 静默跳过；提取到的字符串去重后包装成 TextBlock。
 * 不修改 DOM，返回的 xpath 是占位符 `/data-island/[i]`。
 */
export function extractFromDataIsland(doc: Document): TextBlock[] {
  const candidates: string[] = [];

  // 优先级 1：Next.js
  const nextData = doc.getElementById('__NEXT_DATA__');
  if (nextData?.textContent) candidates.push(nextData.textContent);

  // 优先级 2：Nuxt
  const nuxtData = doc.getElementById('__NUXT_DATA__');
  if (nuxtData?.textContent) candidates.push(nuxtData.textContent);

  // 优先级 3：通用 application/json（排除已收集的）
  const scripts = doc.querySelectorAll('script[type="application/json"]');
  for (const s of Array.from(scripts)) {
    if (s.id === '__NEXT_DATA__' || s.id === '__NUXT_DATA__') continue;
    if (s.textContent) candidates.push(s.textContent);
  }

  if (candidates.length === 0) return [];

  const texts: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      walkDataIsland(data, undefined, texts, seen);
    } catch {
      // JSON 解析失败，跳过这个 script
    }
  }

  if (texts.length === 0) return [];

  logger.debug(
    `[ContentHelper] Extracted ${texts.length} blocks from data island (${candidates.length} script(s) scanned)`,
  );

  return texts.map((text, i) => ({
    id: `data-island-${i}`,
    xpath: `/data-island/${i}`,
    tag: 'p',
    text,
  }));
}

/**
 * 检测文档是否是 PDF.js viewer 页面。
 *
 * PDF.js viewer 把 PDF 内容渲染为 <canvas> 位图，.textLayer span 是透明的
 * 文字选择层。服务端（vocal-saga）不执行 JavaScript，抓取到的 HTML 只有
 * 空壳（#viewer.pdfViewer + <canvas>），没有可翻译的文本。
 *
 * 检测信号（按可靠性排序）：
 *   1. #viewer.pdfViewer — PDF.js viewer 初始化时加的 class，在初始 HTML 中就存在
 *   2. #viewerContainer — PDF.js viewer 的页面容器，ID 足够独特
 *
 * 注：.textLayer 在服务端抓取的 HTML 中不存在（由 JavaScript 在客户端创建），
 * 所以不作为服务端检测信号。
 */
function isPdfJsViewerHtml(root: Document | Element): boolean {
  const doc = root instanceof Document ? root : root.ownerDocument;
  if (!doc) return false;
  const viewer = doc.getElementById('viewer');
  if (viewer && viewer.classList.contains('pdfViewer')) return true;
  return doc.getElementById('viewerContainer') !== null;
}

export function prepareDocument(root: Document | Element): {
  blocks: TextBlock[];
  chunks: Chunk[];
  fullText: string;
} {
  // 优先使用文章容器，减少 TreeWalker 遍历范围
  const effectiveRoot = root instanceof Document ? findArticleRoot(root) : root;

  // 隐藏文章根节点之外的弹窗 / overlay / cookie banner。
  // walker 只遍历 effectiveRoot 子树, body 层级的 modal (如登录弹窗、
  // cookie 同意浮层) 不会被遇到, 需要在这里单独清理, 否则会遮挡译文。
  if (root instanceof Document) {
    hideBodyOverlays(root, effectiveRoot);
  }

  let blocks = extractBlocks(effectiveRoot);

  // 防御性回退: 当 detectArticleRoot 误判 (e.g. 选了一个高密度但被 walker 整棵
  // 剪枝的容器, 如 cookie banner) 导致 0 块时, 从整个 body 重试。
  // 走到 body 后, walker 仍会用 overlay/cookie 规则过滤掉同意 SDK, 真正的正文
  // 会被抓到。回归 case: databricks.com 博客。
  if (blocks.length === 0 && root instanceof Document && effectiveRoot !== root.body) {
    logger.warn(
      `[ContentHelper] Detected root <${effectiveRoot.tagName}> yielded 0 blocks, falling back to <body>`,
    );
    blocks = extractBlocks(root.body || root.documentElement);
  }

  // Data Island fallback: SPA 站点（Next.js / Nuxt / SvelteKit）首屏 DOM
  // 是骨架，内容塞在 __NEXT_DATA__ / __NUXT_DATA__ / application/json
  // script 里。body fallback 仍 0 块时，从结构化数据提取正文。
  // 回归 case: vercel.com 文档站、部分 Next.js SSR 站点首屏未 hydrate。
  if (blocks.length === 0 && root instanceof Document) {
    blocks = extractFromDataIsland(root);
  }

  if (blocks.length === 0) {
    if (isPdfJsViewerHtml(root)) {
      throw new Error(
        'PDF.js viewer pages render content client-side as canvas bitmap. ' +
        'Server-side translation cannot extract text. ' +
        'Please use the browser extension directly on this URL for client-side PDF translation.',
      );
    }
    throw new Error('No translatable content found');
  }

  const fullText = blocks.map((b) => b.text).join('\n\n');
  const chunks = buildChunks(blocks);

  return { blocks, chunks, fullText };
}

export type { TextBlock, Chunk };
