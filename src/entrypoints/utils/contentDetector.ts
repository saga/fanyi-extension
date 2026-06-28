/**
 * 智能正文识别：基于评分的容器选择算法（增强版）。
 *
 * 当 ARTICLE_SELECTORS 选择器快速路径全部 miss 时，
 * 对所有候选容器评分，选最高分的作为文章根节点。
 *
 * 相比 v1 的归一化加权平均，v2 使用绝对分数排名：
 *   - 以 bodyTextLength / (linkCount + 1) * log(textLength) 作为基础密度分
 *   - 用 token / compound / id 信号替代模糊的 regex
 *   - 引入 structure boost、container penalty、sibling normalization、
 *     depth normalization 压制 wrapper dominance 和 sidebar/article 混排误判
 *
 * 特点：
 *   - no layout dependency
 *   - deterministic scoring
 *   - SPA / CMS / blog 全覆盖
 */

// =============================================================================
// 常量
// =============================================================================

/** 评分阈值：低于此分数回退 body */
export const SCORE_THRESHOLD = 300;

/** 最小参与评分的文本长度 */
const MIN_TEXT_LENGTH = 50;

// =============================================================================
// Token 系统
// =============================================================================

const POSITIVE_TOKENS: ReadonlySet<string> = new Set([
  'article',
  'post',
  'entry',
  'rich',
  'story',
  'main',
  'post-content-block',
  'post-content-wrapper',
  'article-container',
  'article-wrapper',
]);

const POSITIVE_COMPOUND_RE =
  /(?:^|[\s\_-])(article|post|entry|blog|page|story|rich)[\_-](content|body|text|inner|main)(?:[\s\_-]|$)/i;

const NEGATIVE_CONTAINER_TOKENS: ReadonlySet<string> = new Set([
  'nav',
  'navigation',
  'navbar',
  'menu',
  'sidebar',
  'side-bar',
  'aside',
  'footer',
  'header',
  'comment',
  'comments',
  'disqus',
  'discourse',
  'widget',
  'ad',
  'ads',
  'advert',
  'banner',
  'social',
  'share',
  'sharing',
  'related',
  'recommended',
  'cookie',
  'popup',
  'modal',
  'newsletter',
  'subscribe',
  'cta',
  'promo',
  'breadcrumb',
  'pagination',
  'toolbar',
  'mbox',
  'callout',
  'pullquote',
]);

const META_TOKENS: ReadonlySet<string> = new Set([
  'metadata',
  'meta',
  'author',
  'byline',
  'timestamp',
  'tag',
  'tags',
  'category',
  'categories',
  'topics',
  'topic',
  'date',
  'time',
  'reading-time',
  'post-meta',
  'entry-meta',
  'article-meta',
]);

const POSITIVE_ID_RE = /(?:article|content|post|entry|rich|blog|story|main|body)/i;
const NEGATIVE_CONTAINER_ID_RE =
  /(?:nav|menu|sidebar|footer|header|comment|widget|ad|banner|social|share|related|cookie|popup|modal|disqus|discourse)/i;
const META_ID_RE = /(?:author|byline|timestamp|tag|category|topic|date|meta)/i;

// =============================================================================
// 绝对排除：隐私同意 / Cookie / 广告 SDK 容器
// =============================================================================
//
// 这些容器 (OneTrust, Cookiebot, TrustArc, Quantcast Choice, GDPR banner...)
// 文本密度天然很高 (几千字符的法律条文、几乎没链接)，会让 scoreElement() 得到
// 超高分，从而在 detectArticleRoot() 里压过真正的文章正文。
// 但它们绝不该被当作 article root —— 走 extractBlocks 后整棵子树会被 overlay /
// cookie 规则剪枝, 返回 0 块, 最终用户看到 "No translatable content found"。
// (回归 case: databricks.com 博客, OneTrust #ot-pc-content 抢走了 root。)
//
// 命中任一 token 的元素 (含其祖先) 直接从候选里剔除, 不参与评分。

const CONSENT_SDK_ID_RE =
  /(?:onetrust|cookiebot|trustarc|quantcast|consent|gdpr|cookielaw|cookie-law|cookie|privacy)/i;
const CONSENT_SDK_CLASS_RE =
  /(?:onetrust|\bot-sdk|ot-pc|ot-cookie|cookiebot|trustarc|quantcast|qc-cmp|cookie-banner|consent-banner|gdpr-banner|privacy-banner|\bcookie[s]?\b)/i;

/**
 * 噪声类元素文本长度安全阀：超过此长度的元素不视为 consent SDK 容器。
 *
 * webclaw 借鉴：cookie/consent/gdpr 类容器若 textContent > 5000 字符，
 * 很可能是长 FAQ / 长隐私政策正文，不应被绝对排除。
 *
 * 回归 case: #cookiesModal (Bootstrap modal 含 cookie policy tabs) 有 ~50k
 * 字符文本，因 id 含 "cookie" 被排除为 consent SDK，但它实际是页面正文，
 * 排除后 detectArticleRoot 选不到 root，用户看到 "No translatable content"。
 */
const CONSENT_SAFE_VALVE = 5000;

const _consentSafeValveMemo = new WeakSet<Element>();

/**
 * 检查元素是否因文本过长而豁免 consent SDK 判定。
 * 用 WeakSet 缓存，同一元素不会重复计算 textContent。
 */
function isConsentSafeValve(el: Element): boolean {
  if (_consentSafeValveMemo.has(el)) return true;
  const text = el.textContent || '';
  if (text.length > CONSENT_SAFE_VALVE) {
    _consentSafeValveMemo.add(el);
    return true;
  }
  return false;
}

/**
 * 元素 (或其任意祖先) 是否是隐私同意 / Cookie / 广告 SDK 容器。
 * 用于在 detectArticleRoot 里绝对排除这类高密度但非正文的容器。
 *
 * 安全阀：若元素 textContent > 5000 字符，即使命中 consent SDK 模式也不排除，
 * 防止误杀长隐私政策 / 长 FAQ 等正文内容。
 */
function isConsentSdkContainer(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') return false;

    const id = current.id || '';
    if (id && CONSENT_SDK_ID_RE.test(id)) {
      // 安全阀：文本过长的元素不视为 consent SDK 容器
      if (isConsentSafeValve(el)) return false;
      return true;
    }

    const cls = typeof current.className === 'string' ? current.className : '';
    if (cls && CONSENT_SDK_CLASS_RE.test(cls)) {
      // 安全阀：文本过长的元素不视为 consent SDK 容器
      if (isConsentSafeValve(el)) return false;
      return true;
    }

    current = current.parentElement;
  }
  return false;
}

// =============================================================================
// 结构 boost
// =============================================================================

const STRUCTURE_BOOST: Record<string, number> = {
  article: 1.3,
  main: 1.2,
  section: 1.02,
};

// =============================================================================
// utils
// =============================================================================

function tokenizeClass(el: Element): string[] {
  if (!el.className || typeof el.className !== 'string') return [];
  return el.className.toLowerCase().split(/[\s-_]+/).filter(Boolean);
}

function collectSignals(el: Element): {
  positive: boolean;
  negative: boolean;
  meta: boolean;
} {
  let positive = false;
  let negative = false;
  let meta = false;

  for (const token of tokenizeClass(el)) {
    if (POSITIVE_TOKENS.has(token)) positive = true;
    if (NEGATIVE_CONTAINER_TOKENS.has(token)) negative = true;
    if (META_TOKENS.has(token)) meta = true;
  }

  if (typeof el.className === 'string' && POSITIVE_COMPOUND_RE.test(el.className)) {
    positive = true;
  }

  if (el.id) {
    if (POSITIVE_ID_RE.test(el.id)) positive = true;
    if (NEGATIVE_CONTAINER_ID_RE.test(el.id)) negative = true;
    if (META_ID_RE.test(el.id)) meta = true;
  }

  return { positive, negative, meta };
}

// =============================================================================
// core scoring
// =============================================================================

export function scoreElement(el: Element): number {
  const text = (el.textContent || '').trim();
  if (text.length < MIN_TEXT_LENGTH) return 0;

  // link analysis: 只统计 <a> 内的直接文本节点，避免把 a 的子元素（如 h2）全算成链接文本
  const aEls = el.querySelectorAll('a');
  const linkCount = aEls.length;

  let linkTextLength = 0;
  for (let i = 0; i < aEls.length; i++) {
    const a = aEls[i];
    const children = a.childNodes;
    for (let j = 0; j < children.length; j++) {
      if (children[j].nodeType === Node.TEXT_NODE) {
        linkTextLength += (children[j].textContent || '').length;
      }
    }
  }

  const bodyTextLength = Math.max(0, text.length - linkTextLength);

  // base density
  let score = (bodyTextLength / (linkCount + 1)) * Math.log(text.length + 1);

  // smooth link penalty
  const linkRatio = linkTextLength / Math.max(text.length, 1);
  score *= 1 / (1 + linkRatio * 2);

  // signals
  const { positive, negative, meta } = collectSignals(el);

  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');

  let structureBoost = 1;
  if (tag === 'article' || role === 'article') structureBoost *= STRUCTURE_BOOST.article;
  else if (tag === 'main') structureBoost *= STRUCTURE_BOOST.main;
  else if (tag === 'section') structureBoost *= STRUCTURE_BOOST.section;

  let classMultiplier = 1;
  if (positive) classMultiplier *= 1.2;
  if (negative) classMultiplier *= 0.5;
  if (meta) classMultiplier *= 0.92;

  // container penalty: 子元素很多但每个子元素文本很少 → 列表/导航
  const childCount = el.children?.length || 0;
  const densityPerChild = text.length / Math.max(childCount, 1);

  let containerPenalty = 1;
  if (childCount > 20 && densityPerChild < 25) {
    containerPenalty *= 0.85;
  }

  // sibling normalization: 压制同层级里不够突出的容器
  let siblingBoost = 1;
  const parent = el.parentElement;
  if (parent) {
    const siblings = parent.children;

    let maxSiblingText = 0;
    let total = 0;

    for (let i = 0; i < siblings.length; i++) {
      const len = (siblings[i].textContent || '').length;
      total += len;
      if (len > maxSiblingText) maxSiblingText = len;
    }

    const myLen = text.length;

    if (maxSiblingText > 0 && myLen < maxSiblingText * 0.7) {
      siblingBoost *= 0.85;
    }

    if (siblings.length > 3) {
      const avg = total / siblings.length;
      if (avg > 0 && Math.abs(myLen - avg) / avg < 0.25) {
        siblingBoost *= 0.9;
      }
    }
  }

  // depth normalization: 过浅可能是 wrapper，过深可能是细粒度容器
  let depthBoost = 1;
  let depth = 0;
  let p: Element | null = el.parentElement;
  while (p) {
    depth++;
    p = p.parentElement;
  }

  if (depth < 3) depthBoost = 0.95;
  if (depth > 7) depthBoost *= 0.9;

  return (
    score *
    structureBoost *
    classMultiplier *
    containerPenalty *
    siblingBoost *
    depthBoost
  );
}

// =============================================================================
// candidate collection
// =============================================================================

export function collectCandidates(doc: Document): Element[] {
  const seen = new Set<Element>();
  const candidates: Element[] = [];

  function add(el: Element | null) {
    if (!el || seen.has(el) || el === doc.body || el === doc.documentElement) return;
    // 绝对排除: 隐私同意 / Cookie / 广告 SDK 容器 (含祖先命中)。
    // 它们文本密度高、会拿到超高评分, 但 extractBlocks 后必然 0 块。
    if (isConsentSdkContainer(el)) return;
    seen.add(el);
    candidates.push(el);
  }

  const semantic = doc.querySelectorAll('article, main');
  for (let i = 0; i < semantic.length; i++) add(semantic[i]);

  const roles = doc.querySelectorAll('[role="main"], [role="article"], [role="region"]');
  for (let i = 0; i < roles.length; i++) add(roles[i]);

  const nodes = doc.querySelectorAll('div, section, article, main');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const tokens = tokenizeClass(el);

    const hasToken = tokens.some((t) => POSITIVE_TOKENS.has(t));
    const hasCompound =
      typeof el.className === 'string' && POSITIVE_COMPOUND_RE.test(el.className);
    const idHit = el.id && POSITIVE_ID_RE.test(el.id);

    if (hasToken || hasCompound || idHit) add(el);
  }

  const td = doc.querySelectorAll('td');
  for (let i = 0; i < td.length; i++) {
    const t = td[i];
    if ((t.textContent || '').trim().length > 1000) add(t);
  }

  const original = candidates.slice();
  for (let i = 0; i < original.length; i++) {
    let p = original[i].parentElement;
    for (let j = 0; j < 2 && p && p !== doc.body; j++) {
      add(p);
      p = p.parentElement;
    }
  }

  if (candidates.length < 3) {
    const children = doc.body.children;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.tagName === 'DIV' || c.tagName === 'SECTION') add(c);
    }
  }

  return candidates;
}

// =============================================================================
// entry
// =============================================================================

export function detectArticleRoot(doc: Document): Element | null {
  const candidates = collectCandidates(doc);
  if (!candidates.length) return null;

  let best: Element | null = null;
  let bestScore = -1;

  for (const el of candidates) {
    const s = scoreElement(el);
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  }

  if (bestScore < SCORE_THRESHOLD) {
    console.log(
      `[ContentDetector] Best score ${bestScore.toFixed(1)} < threshold ${SCORE_THRESHOLD}, fallback to body`,
    );
    return null;
  }

  // 防御: 即便通过了 collectCandidates 过滤, 也再校验一次冠军不是 consent SDK
  // (理论上不会命中, 但 collectCandidates 的祖先展开可能引入外层包装)。
  if (best && isConsentSdkContainer(best)) {
    console.log(
      `[ContentDetector] Best candidate is a consent/cookie SDK container, ignoring (score: ${bestScore.toFixed(1)})`,
    );
    return null;
  }

  console.log(
    `[ContentDetector] Best: <${best!.tagName}> .${(best!.className || '').split(/\s+/)[0]} (score: ${bestScore.toFixed(1)})`,
  );
  return best;
}
