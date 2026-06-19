/**
 * blockExtractor 判定规则
 *
 * 所有 shouldSkip* / is* 谓词集中在这里,逻辑上分两类:
 *   1. 节点级判定: 根据元素自身属性决定 (class, hidden, namespace, ...)
 *   2. 上下文判定: 向上/向下遍历父链或子树 (isInsideArticle, hasBlockLevelParent, ...)
 *
 * 为什么独立: walker.ts 只负责"按这些规则决定 FILTER_*",不混入具体判定逻辑;
 * 每条规则都可独立加测试。
 */

import { matchSiteRule, type SiteRule } from '../../../rules';
import {
  AD_IFRAME_PATTERNS,
  AD_SIZE_PATTERNS,
  ARTICLE_CONTAINER_CLASS_PATTERNS,
  COOKIE_BANNER_TEXT_PATTERNS,
  DIRECT_SET,
  DYNAMIC_NOISE_CONTAINER_TAGS,
  INLINE_SET,
  MAX_TEXT_LENGTH,
  METADATA_TOKENS,
  MIN_TEXT_LENGTH,
  PATTERNS,
  POPUP_STYLE_DETECTION,
  SKIP_CLASS_PATTERNS,
  XHTML_NAMESPACE,
} from './constants';

// =============================================================================
// SiteRule 缓存
// =============================================================================
//
// matchSiteRule() 内部会对 URL 做模式匹配,每个 walker 节点都查会重复工作。
// 缓存到模块级,URL 变化时刷新。SPA 路由切换会触发刷新。

let cachedRule: SiteRule | null = null;
let cachedUrl: string | null = null;

function getSiteRule(): SiteRule | null {
  const currentUrl = window.location.href;
  if (cachedUrl === currentUrl) {
    return cachedRule;
  }
  const matched = matchSiteRule(currentUrl);
  cachedUrl = currentUrl;
  cachedRule = matched?.siteRule || null;
  return cachedRule;
}

// =============================================================================
// Class 匹配工具
// =============================================================================

/**
 * 把 className 按空白切分,小写。
 * 防御: SVG 元素的 className 是 SVGAnimatedString,不是 string,直接当 string 用会报错。
 */
function tokenizeClass(el: Element): string[] {
  if (!el.className || typeof el.className !== 'string') return [];
  return el.className.toLowerCase().split(/\s+/);
}

/**
 * 精确 / 前后缀边界匹配 (与 SKIP_CLASS_PATTERNS 配合使用):
 *   - 精确:    "social-share" === "social-share"
 *   - 前缀:    "social-share-buttons" startsWith "social-share-"
 *   - 后缀:    "post-social-share" endsWith "-social-share"
 *   - 不匹配:  "social-shareholder-list" (前缀 'social-share' 后不是 '-' 或 '_')
 */
function matchesSkipClass(token: string, pattern: string): boolean {
  return (
    token === pattern ||
    token.startsWith(pattern + '-') ||
    token.startsWith(pattern + '_') ||
    token.endsWith('-' + pattern) ||
    token.endsWith('_' + pattern)
  );
}

/**
 * 是否因 class 命中 SKIP_CLASS_PATTERNS 而应跳过 (整棵子树拒绝)。
 * 跨站通用: 广告 / cookie / 推荐 / 弹窗 / 导航 等。
 */
export function shouldSkipByClass(el: Element): boolean {
  const tokens = tokenizeClass(el);
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    for (const pattern of SKIP_CLASS_PATTERNS) {
      if (matchesSkipClass(token, pattern)) return true;
    }
  }
  return false;
}

/**
 * 是否为元数据容器 (作者 / 日期 / 分类 / byline)。
 * 用**整词分割**匹配,不是子串——避免误伤 "metadata-block" / "authorship"。
 * 命中后整棵子树拒绝,避免误翻人名 / 日期格式 / 分类标签。
 */
export function isMetadataClass(el: Element): boolean {
  const tokens = tokenizeClass(el);
  if (tokens.length === 0) return false;
  // 整词分割: "post-meta-info" → ['post', 'meta', 'info']
  // 但我们的 tokens 已经是按空格切的,对 '-' '_' 分隔需要二次拆分
  for (const token of tokens) {
    for (const sub of token.split(/[_\-]+/)) {
      if (METADATA_TOKENS.has(sub)) return true;
    }
  }
  return false;
}

// =============================================================================
// Site-specific 规则
// =============================================================================

/**
 * 站点特殊规则 (src/rules/): 命中后整棵子树拒绝。
 * 通过 CSS selector 匹配,允许站点级更复杂的命中 (e.g. 复合选择器)。
 */
export function shouldSkipBySiteRules(el: Element): boolean {
  const rule = getSiteRule();
  if (!rule?.skipSelectors) return false;

  for (const selector of rule.skipSelectors) {
    if (el.closest(selector)) return true;
  }
  return false;
}

// =============================================================================
// 元素可见性
// =============================================================================

/**
 * 是否隐藏 (display: none / visibility: hidden / hidden 属性 / aria-hidden=true)。
 *
 * ⚠️ 性能: 原实现走父链 + getComputedStyle, 大型页面 (~1000 节点 × 15 深)
 * 触发 ~15000 次 layout。优化后只检查 el 自身 (cheap attributes + inline style
 * + 单次 getComputedStyle)。理由:
 *   1. 父链上 hidden 的元素, 它的子元素会被 rejectedCache 拦截, walker
 *      根本不会访问到——所以"父隐藏子"的情况不会浪费检查。
 *   2. display:none 几乎总在 inline style 或顶层 modal/popover 容器上,
 *      极少需要沿父链回溯。
 *   3. 如果实测有漏网, 可以升级为带 memoization 的实现 (WeakSet 已查过 visible
 *      的元素跳过 computed style 查), 见 _elementVisibilityMemo。
 */
const _elementVisibilityMemo = new WeakSet<Element>();

export function isElementHidden(el: Element): boolean {
  // 已确认可见的, 不再查 (避免在子树中重复 layout)
  if (_elementVisibilityMemo.has(el)) return false;

  // Cheap: 显式属性
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;

  // Cheap: inline style
  if (el instanceof HTMLElement) {
    const s = el.style;
    if (s.display === 'none' || s.visibility === 'hidden') return true;
  }

  // 兜底: getComputedStyle (会触发 layout, 谨慎使用)
  if (el instanceof HTMLElement) {
    try {
      const computed = window.getComputedStyle(el);
      if (computed.display === 'none' || computed.visibility === 'hidden') {
        return true;
      }
    } catch {
      // jsdom 等无 layout 环境, 静默忽略
    }
  }

  // 标记可见, 后续子孙中的同元素 (e.g. 多个 walker visit 同一节点) 跳过
  _elementVisibilityMemo.add(el);
  return false;
}

// =============================================================================
// 命名空间
// =============================================================================

/**
 * 是否在非 HTML 命名空间 (SVG, MathML)。
 * 翻译 SVG <text> 元素很危险 (可能破坏图表); 整棵拒绝。
 */
export function isNonHTMLNamespace(el: Element): boolean {
  return el.namespaceURI !== null && el.namespaceURI !== XHTML_NAMESPACE;
}

// =============================================================================
// 文本有效性
// =============================================================================

/**
 * 文本是否值得翻译:
 *   - 长度在 [MIN, MAX) 区间
 *   - 不是全大写短 UI 文本 ("EMAIL", "SUBSCRIBE")
 *   - 不是 base64 块
 *   - 不是 Sentry / Webpack 元组列表
 *   - 不匹配站点规则的 skipTextPatterns
 */
export function isValidText(text: string | undefined | null): boolean {
  if (!text) return false;

  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH || trimmed.length >= MAX_TEXT_LENGTH) {
    return false;
  }

  // 全大写短 UI 文本: 翻译 "EMAIL" → "电子邮件" 反而破坏表单语义
  if (
    trimmed.length < 25 &&
    PATTERNS.UI_TEXT.test(trimmed) &&
    !PATTERNS.DIGIT_SPACE.test(trimmed)
  ) {
    return false;
  }

  // 误抓的元组列表 / base64 块
  const tupleMatches = trimmed.match(PATTERNS.TUPLE);
  if (tupleMatches && tupleMatches.length >= 8) return false;
  if (PATTERNS.BASE64.test(trimmed)) return false;

  // 站点特殊文本规则 (e.g. Reddit 的 Sentry chunk 列表)
  const rule = getSiteRule();
  if (rule?.skipTextPatterns) {
    for (const pattern of rule.skipTextPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(trimmed)) return false;
      } catch {
        // 无效正则静默忽略,不 crash 整个 extraction
      }
    }
  }

  return true;
}

// =============================================================================
// 上下文判定 (parent chain / child walk)
// =============================================================================

/**
 * 元素是否在文章容器内 (<article> 标签 / role=article / role=main /
 * 常见文章类名)。仅在 INLINE_SET 元素上调用 (判断 span/a/em 是否值得抓)。
 */
export function isInsideArticle(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'article') return true;

    const role = current.getAttribute('role');
    if (role === 'article' || role === 'main') return true;

    // 常见文章容器类名
    const tokens = tokenizeClass(current);
    for (const token of tokens) {
      for (const pattern of ARTICLE_CONTAINER_CLASS_PATTERNS) {
        if (matchesSkipClass(token, pattern)) return true;
      }
    }

    current = current.parentElement;
  }
  return false;
}

/**
 * 元素是否有 DIRECT_SET 块级父 (p/li/dd/blockquote/...)。
 * 用在 INLINE_SET 元素上: 如果外层已是块级,内联不单独抓 (会碎片化句子);
 * 如果只在 inline 容器里 (e.g. <span class="highlight">单独成段</span>),可单独抓。
 */
export function hasBlockLevelParent(el: Element): boolean {
  let current: Element | null = el.parentElement;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (DIRECT_SET.has(tag)) return true;
    if (tag === 'body' || tag === 'html') return false;
    current = current.parentElement;
  }
  return false;
}

// =============================================================================
// 子树结构分析
// =============================================================================

export interface ChildClassification {
  /** 是否有直接文本子节点 (非空)。 */
  hasDirectText: boolean;
  /** 是否有非 INLINE_SET 的子元素。 */
  hasNonInlineChild: boolean;
  /** 是否有非空子元素。 */
  hasNonEmptyElement: boolean;
  /** 是否所有子元素都在 INLINE_SET。 */
  hasOnlyInlineChildren: boolean;
}

/**
 * 把一个非块级元素分类成"容器"或"内联文本":
 *   - hasDirectText=true + hasOnlyInlineChildren=true → 当作翻译块
 *   - hasNonInlineChild=true → 容器,跳过 (子树会被独立处理)
 *   - 都没有 → 空容器,跳过
 */
export function classifyChildren(el: Element): ChildClassification {
  let hasDirectText = false;
  let hasNonEmptyElement = false;
  let hasOnlyInlineChildren = true;

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      hasDirectText = true;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const childEl = child as Element;
    if (childEl.textContent?.trim()) {
      hasNonEmptyElement = true;
    }
    if (!DIRECT_SET.has(childEl.tagName.toLowerCase()) &&
        !INLINE_SET.has(childEl.tagName.toLowerCase())) {
      hasOnlyInlineChildren = false;
    }
  }

  return {
    hasDirectText,
    hasNonInlineChild: !hasOnlyInlineChildren,
    hasNonEmptyElement,
    hasOnlyInlineChildren,
  };
}

// =============================================================================
// 杂项
// =============================================================================

/** 元素是否处于可编辑状态 (contenteditable / isContentEditable)。 */
export function isContentEditable(el: Element): boolean {
  return (
    !!(el as HTMLElement).isContentEditable ||
    el.getAttribute('contenteditable') === 'true'
  );
}

/** 元素是否被自身标记 "不要翻译" (fanyi-bilingual-block) 或 "notranslate"。 */
export function hasTranslateBlockClass(el: Element): boolean {
  return (
    el.classList.contains('fanyi-bilingual-block') ||
    el.classList.contains('notranslate')
  );
}

// =============================================================================
// 动态噪声检测 (DOM / Style 特征)
// =============================================================================
//
// 第三方脚本动态插入的节点往往没有固定 class,这里用 style/文本/尺寸做启发式判断。
// 这些检查相对 expensive,因此:
//   1. 只在大容器标签上调用 (DYNAMIC_NOISE_CONTAINER_TAGS)
//   2. 用 WeakSet 缓存结果,同一元素不会重复计算
//   3. 放在 walker 的 class/站点规则检查之后,优先用廉价规则过滤

const _cookieBannerMemo = new WeakSet<Element>();
const _popupMemo = new WeakSet<Element>();
const _adSizeMemo = new WeakSet<Element>();

/**
 * 是否因文本内容命中 Cookie Banner / Consent 弹窗关键词。
 * 命中后整棵子树拒绝,避免翻译 "Accept All" / "Manage Cookies" 等 UI 文本。
 */
export function isCookieBannerByText(el: Element): boolean {
  if (_cookieBannerMemo.has(el)) return true;

  const tag = el.tagName.toLowerCase();
  if (!DYNAMIC_NOISE_CONTAINER_TAGS.has(tag)) return false;

  // 只检查直接文本子节点,不深入子树——子树会在 walker 中也被逐个访问,
  // 命中后通过 rejectedCache 连坐拒绝,避免 O(n^2) 重复扫描。
  const directText = Array.from(el.childNodes)
    .filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
    .map(n => n.textContent || '')
    .join(' ')
    .toLowerCase();

  const matched = Array.from(COOKIE_BANNER_TEXT_PATTERNS).some(p => directText.includes(p));
  if (matched) {
    _cookieBannerMemo.add(el);
    return true;
  }
  return false;
}

/**
 * 是否因固定 / sticky 定位 + 高 z-index + 大面积覆盖视口而被判定为 Popup / Modal。
 * 命中后整棵子树拒绝,避免翻译 Newsletter 订阅框、登录弹窗、促销浮层等。
 */
export function isPopupByStyle(el: Element): boolean {
  if (_popupMemo.has(el)) return true;
  if (!(el instanceof HTMLElement)) return false;

  const tag = el.tagName.toLowerCase();
  if (!DYNAMIC_NOISE_CONTAINER_TAGS.has(tag)) return false;

  try {
    const style = window.getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'sticky') return false;

    const zIndex = parseInt(style.zIndex || '0', 10);
    if (Number.isNaN(zIndex) || zIndex < POPUP_STYLE_DETECTION.MIN_Z_INDEX) return false;

    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area < POPUP_STYLE_DETECTION.MIN_AREA_PX) return false;

    const viewportArea = window.innerWidth * window.innerHeight;
    if (viewportArea <= 0) return false;

    const coverRatio = area / viewportArea;
    if (coverRatio < POPUP_STYLE_DETECTION.MIN_VIEWPORT_COVER_RATIO) return false;

    _popupMemo.add(el);
    return true;
  } catch {
    // jsdom 等无 layout 环境,静默忽略
    return false;
  }
}

/**
 * 是否因尺寸匹配标准广告位而被判定为广告容器。
 * 命中后整棵子树拒绝。
 */
export function isAdBySize(el: Element): boolean {
  if (_adSizeMemo.has(el)) return true;
  if (!(el instanceof HTMLElement)) return false;

  const tag = el.tagName.toLowerCase();
  if (!DYNAMIC_NOISE_CONTAINER_TAGS.has(tag) && tag !== 'iframe') return false;

  try {
    const rect = el.getBoundingClientRect();
    for (const [w, h] of AD_SIZE_PATTERNS) {
      if (Math.abs(rect.width - w) <= 5 && Math.abs(rect.height - h) <= 5) {
        _adSizeMemo.add(el);
        return true;
      }
    }
  } catch {
    // jsdom 等无 layout 环境,静默忽略
  }
  return false;
}

/**
 * 广告 iframe: 通过 src 匹配常见广告/追踪域名。
 * 命中后整棵子树拒绝。
 */
export function isAdIframe(el: Element): boolean {
  if (el.tagName.toLowerCase() !== 'iframe') return false;
  const src = ((el as HTMLIFrameElement).src || '').toLowerCase();
  return Array.from(AD_IFRAME_PATTERNS).some(p => src.includes(p));
}

// =============================================================================
// 低优先级 / Overlay 元素标记
// =============================================================================
//
// 这些元素 walker 会拒绝翻译，但保留在 DOM 中。通过 data 属性标记后，
// 注入的 CSS 可以对它们进行视觉弱化或完全隐藏，让阅读注意力集中在正文上。

const LOW_PRIORITY_SELECTORS = [
  // 语义标签（含 heading 的 header 除外，由调用方判断）
  { tag: 'nav' },
  { tag: 'footer' },
  { tag: 'aside' },

  // 广告 / 推广
  { classPattern: /\bad\b|banner|sponsor|promo|affiliate|advert/i },
  { idPattern: /\bad\b|banner|sponsor|promo|advert/i },

  // 社交分享 / 评论 / 相关推荐
  { classPattern: /share|social|comment|related|recommend|sidebar/i },
  { idPattern: /share|social|comment|related|recommend|sidebar/i },

  // 站点级 chrome（非文章内容）
  { classPattern: /navbar|site-nav|global-nav|topbar|subscribe|newsletter|cookie|consent/i },
  { idPattern: /navbar|site-nav|global-nav|topbar|subscribe|newsletter|cookie|consent/i },
  { tag: 'form', classPattern: /subscribe|newsletter/i },
];

const OVERLAY_PATTERNS = [
  // Cookie / GDPR / 隐私同意
  { classPattern: /\bcookie\b|consent|gdpr|privacy-banner|cookie-banner/i },
  { idPattern: /\bcookie\b|consent|gdpr|privacy/i },

  // 通用弹窗 / Modal / Overlay
  { classPattern: /\bpopup\b|\bmodal\b|overlay|dialog|backdrop|lightbox/i },
  { idPattern: /\bpopup\b|\bmodal\b|overlay|dialog/i },
  { role: 'dialog' },

  // Substack 系列
  { classPattern: /subscription-popup|paywall|subscribe-popup|newsletter-modal/i },

  // 固定定位的干扰性 banner（顶部/底部 fixed bar）
  {
    tag: 'div',
    styleCheck: (el: Element) => {
      if (!(el instanceof HTMLElement)) return false;
      const pos = el.style?.position;
      return pos === 'fixed' || pos === 'sticky';
    },
  },
];

function matchSelectorRule(
  el: Element,
  rule: {
    tag?: string;
    classPattern?: RegExp;
    idPattern?: RegExp;
    role?: string;
    styleCheck?: (el: Element) => boolean;
  },
): boolean {
  // tag/role 是前置过滤条件
  if (rule.tag && el.tagName.toLowerCase() !== rule.tag) return false;
  if (rule.role && el.getAttribute('role') !== rule.role) return false;

  // 如果规则只有 tag/role，匹配即命中
  const hasHitCondition = rule.classPattern || rule.idPattern || rule.styleCheck;
  if (!hasHitCondition) return true;

  // 有附加命中条件时，任一条件满足即命中
  if (rule.classPattern) {
    // SVG 元素的 className 是 SVGAnimatedString，需要防御
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    if (rule.classPattern.test(cls)) return true;
  }
  if (rule.idPattern) {
    const id = (el.id || '').toLowerCase();
    if (rule.idPattern.test(id)) return true;
  }
  if (rule.styleCheck) {
    // styleCheck 是确定性条件：通过则命中，不通过则此规则不命中
    if (rule.styleCheck(el)) return true;
  }

  return false;
}

/**
 * 是否为低优先级元素（需要视觉弱化但保留 DOM）。
 * 注意：这只是标记建议，最终是否打标记由 walker 在拒绝分支中决定。
 */
export function isLowPriorityElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();

  // header 含 heading 时不视为低优先级（可能是文章标题区）
  if (tag === 'header') {
    const hasHeading = el.querySelector('h1,h2,h3,h4,h5,h6') !== null;
    if (hasHeading) return false;
  }

  for (const rule of LOW_PRIORITY_SELECTORS) {
    if (matchSelectorRule(el, rule)) return true;
  }
  return false;
}

/**
 * 是否为弹窗 / overlay / cookie banner 等遮挡性元素。
 * 这些元素会直接被隐藏（display: none）。
 *
 * 注意：article / main 内部的容器即使 class 含 "overlay" 也很可能是
 * 站点 CMS 包装（如 Substack 的 .overlay-zrMCxn），不在此列。
 */
export function isOverlayElement(el: Element): boolean {
  const inArticle = el.closest('article, main, [role="main"], [role="article"]');
  if (inArticle) return false;

  for (const rule of OVERLAY_PATTERNS) {
    if (matchSelectorRule(el, rule)) return true;
  }
  return false;
}
