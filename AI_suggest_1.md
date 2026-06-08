这段新修改的代码在解决特殊 class 模糊匹配（后缀变体等）和防误伤的思路上非常严谨，注释中关于放弃 `el.closest()` 转而手写深度受限遍历（`depth < 12`）的考量也非常清晰。

不过，从**性能（垃圾回收与执行效率）**和**架构逻辑内聚性**来看，这段代码目前潜伏着一个**极大的性能隐患**和一些细节瑕疵。

以下是具体的优化调整建议：

---

## 🚨 核心优化点

### 1. 致命冗余：`TreeWalker` 与 `grabNode` 的双重重叠

这是目前代码最需要调整的地方。

* 在 `collectBlocksFromRoot` 中，你创建了 `TreeWalker` 并通过 `acceptWalkerNode` 对 DOM 树进行了过滤。
* 但在 `while` 循环内部，你又对吐出来的每一个节点调用了一次 `grabNode(currentNode)`。
* **问题在于**：`acceptWalkerNode` 和 `grabNode` 里面包含几乎完全相同的排查过滤集（`isNonHTMLNamespace`、`SKIP_SET`、`isElementHidden`、`shouldSkipByClass`、`classifyChildren` 等）。
* 这意味着**每个节点不仅被重复校验了两次，而且在 `while` 循环里被 `grabNode` 二次判定时，极有可能会因为逻辑微调不一致而被误杀或漏放**。

**💡 调整方案**：
完全删掉整个 `grabNode` 函数。将节点提取的最终判定规则 100% 收拢到 `acceptWalkerNode` 中。让 `TreeWalker` 吐出来的节点就是真正需要翻译的叶子区块，保持逻辑单一可信源（Single Source of Truth）。

### 2. `isInsideSkippedAncestor` 的 $O(N \times D)$ 性能退化与 WeakSet 救场

虽然你限制了 `depth < 12`，但在复杂的现代长网页中，`TreeWalker` 遍历数千个节点时，每个节点都要频繁向上回溯 12 层。更糟糕的是，每回溯一层，都要执行一次包含 `some` 嵌套循环的 `shouldSkipByClass`（涉及字符串分割和多次正则/前缀判定）。
这会导致严重的 CPU 密集型计算和耗电问题。

由于 `TreeWalker` 是深度优先遍历（DFS），如果一个祖先节点被判定为 `FILTER_REJECT`（拒绝），它下面的所有子树在理论上都应该直接被拒绝。

**💡 调整方案**：
声明一个 `WeakSet` 缓存。一旦某个祖先元素触发了 `shouldSkipByClass` 或者是隐藏元素，将其丢入 `rejectedCache`。它的子孙节点在进入检查时，只需 $O(1)$ 复杂度检查父级是否在 `WeakSet` 中即可。

### 3. 高频创建正则表达式引发的 GC（垃圾回收）压力

在 `isValidText` 内部，这一行：

```typescript
const tupleMatches = trimmed.match(/\[\s*['"][^'"]+['"]\s*,\s*-?\d+(?:\.\d+)?\s*\]/g);

```

每次遇到文本都会临时实例化一个带 `/g` 的正则表达式对象。对于上万字或拥有数千节点的页面，这会频繁触发 V8 引擎的垃圾回收，造成滑屏卡顿。

**💡 调整方案**：
将文件内的所有静态正则表达式（包含 `isValidText` 和 `findPreviousHeading` 里的正则）统一抽离到文件顶部作为 `const` 常量。

---

## 🛠️ 重构后的完整代码

以下是优化后的精简、高性能版本。移除了 `grabNode`，将规则内聚到 `acceptWalkerNode` 中，并引入 `WeakSet` 实现了真正的 $O(1)$ 局部祖先过滤：

```typescript
import { matchSiteRule, type SiteRule } from '../../rules';

export interface TextBlock {
  id: string;
  xpath: string;
  tag: string;
  text: string;
  context?: {
    headingPath: string[];
    position: number;
  };
}

const MIN_TEXT_LENGTH = 3;
const MAX_TEXT_LENGTH = 3072;
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// 静态正则抽离，避免高频 GC 压力
const TUPLE_REGEX = /\[\s*['"][^'"]+['"]\s*,\s*-?\d+(?:\.\d+)?\s*\]/g;
const BASE64_REGEX = /^[A-Za-z0-9+/=_-]{200,}$/;
const UI_TEXT_REGEX = /^[A-Z0-9\s]+$/;
const DIGIT_SPACE_REGEX = /^[0-9\s]+$/;
const HEADING_REGEX = /^H[1-6]$/;

const DIRECT_SET = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'li', 'dd', 'blockquote',
  'figcaption'
]);

const SKIP_SET = new Set([
  'html', 'body', 'script', 'style', 'noscript', 'iframe',
  'input', 'textarea', 'select', 'button', 'code', 'pre',
  'dt', 'td', 'th', 'caption'
]);

const SEMANTIC_SKIP_TAGS = new Set(['header', 'footer', 'aside', 'nav']);

const INLINE_SET = new Set([
  'a', 'b', 'strong', 'span', 'em', 'i', 'u', 'small', 'sub', 'sup',
  'font', 'mark', 'cite', 'q', 'abbr', 'time', 'ruby', 'bdi', 'bdo',
  'img', 'br', 'wbr', 'svg'
]);

const SKIP_CLASS_PATTERNS = [
  // ... 保留你原有的完整超大 class 数组
  'sidebar', 'side-bar', 'social-share', 'social-icon-list', 'notranslate'
];

let cachedRule: SiteRule | null = null;
let cachedUrl: string | null = null;

function getSiteRule(): SiteRule | null {
  const currentUrl = window.location.href;
  if (cachedUrl === currentUrl) return cachedRule;
  const matched = matchSiteRule(currentUrl);
  cachedUrl = currentUrl;
  cachedRule = matched?.siteRule || null;
  return cachedRule;
}

function shouldSkipByClass(el: Element): boolean {
  if (!el.className || typeof el.className !== 'string') return false;
  const className = el.className.toLowerCase();
  const classList = className.split(/\s+/);
  return SKIP_CLASS_PATTERNS.some(pattern =>
    classList.some(cls =>
      cls === pattern ||
      cls.startsWith(pattern + '-') ||
      cls.startsWith(pattern + '_') ||
      cls.endsWith('-' + pattern) ||
      cls.endsWith('_' + pattern)
    )
  );
}

function shouldSkipBySiteRules(el: Element): boolean {
  const rule = getSiteRule();
  if (!rule?.skipSelectors) return false;
  for (const selector of rule.skipSelectors) {
    if (el.closest(selector)) return true;
  }
  return false;
}

function isElementHidden(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  if (el instanceof HTMLElement) {
    const s = el.style;
    if (s.display === 'none' || s.visibility === 'hidden') return true;
    try {
      const computed = window.getComputedStyle(el);
      if (computed.display === 'none' || computed.visibility === 'hidden') return true;
    } catch (e) {
      // Ignore
    }
  }
  return false;
}

function isValidText(text: string | undefined | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH || trimmed.length >= MAX_TEXT_LENGTH) return false;

  // 使用文件顶部的常量正则
  if (trimmed.length < 25 && UI_TEXT_REGEX.test(trimmed) && !DIGIT_SPACE_REGEX.test(trimmed)) {
    return false;
  }
  const tupleMatches = trimmed.match(TUPLE_REGEX);
  if (tupleMatches && tupleMatches.length >= 8) return false;
  if (BASE64_REGEX.test(trimmed)) return false;

  const rule = getSiteRule();
  if (rule?.skipTextPatterns) {
    for (const pattern of rule.skipTextPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(trimmed)) return false;
      } catch {
        // Ignore invalid regex
      }
    }
  }
  return true;
}

function isNonHTMLNamespace(el: Element): boolean {
  return el.namespaceURI !== null && el.namespaceURI !== XHTML_NAMESPACE;
}

interface ChildClassification {
  hasDirectText: boolean;
  hasNonEmptyElement: boolean;
  hasOnlyInlineChildren: boolean;
}

function classifyChildren(el: Element): ChildClassification {
  let hasDirectText = false;
  let hasNonEmptyElement = false;
  let hasOnlyInlineChildren = true;

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      hasDirectText = true;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const childTag = (child as Element).tagName.toLowerCase();
      if ((child as Element).textContent?.trim()) {
        hasNonEmptyElement = true;
      }
      if (!INLINE_SET.has(childTag)) {
        hasOnlyInlineChildren = false;
      }
    }
  }
  return { hasDirectText, hasNonEmptyElement, hasOnlyInlineChildren };
}

function getXPath(node: Node): string {
  if (node.nodeType === Node.DOCUMENT_NODE || !(node instanceof Element)) return '';
  const parts: string[] = [];
  let current: Element | null = node;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }
  return '/' + parts.join('/');
}

function getHeadingPath(block: Element): string[] {
  const headings: string[] = [];
  let current: Element | null = block;
  while (current) {
    const prevHeading = findPreviousHeading(current);
    if (prevHeading) {
      headings.unshift(prevHeading.textContent?.trim() || '');
      current = prevHeading;
    } else {
      break;
    }
  }
  return headings;
}

function findPreviousHeading(element: Element): Element | null {
  let current: Node | null = element;
  while (current) {
    while (current.previousSibling) {
      current = current.previousSibling;
      if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as Element;
        if (HEADING_REGEX.test(el.tagName)) return el;
        const found = findLastHeading(el);
        if (found) return found;
      }
    }
    current = current.parentElement;
  }
  return null;
}

function findLastHeading(element: Element): Element | null {
  const children = Array.from(element.children).reverse();
  for (const child of children) {
    if (HEADING_REGEX.test(child.tagName)) return child;
    const found = findLastHeading(child);
    if (found) return found;
  }
  return null;
}

function hasTranslateBlockClass(el: Element): boolean {
  return el.classList.contains('fanyi-bilingual-block') || el.classList.contains('notranslate');
}

function isContentEditable(el: Element): boolean {
  return !!(el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true';
}

// 核心改动：用全局 WeakSet 追踪被 REJECT 掉的污染树祖先，杜绝 O(N*D) 循环回溯
const rejectedElementsCache = new WeakSet<Element>();

function acceptWalkerNode(
  node: Node,
  counters: { rejected: number; skipped: number; accepted: number }
): number {
  if (node instanceof Text) {
    if (node.parentElement && rejectedElementsCache.has(node.parentElement)) {
      return NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_ACCEPT;
  }

  if (!(node instanceof Element)) return NodeFilter.FILTER_SKIP;
  const el = node;

  // 1. 高效降噪拦截：父辈已被拒，子树连坐
  if (el.parentElement && rejectedElementsCache.has(el.parentElement)) {
    rejectedElementsCache.add(el);
    return NodeFilter.FILTER_REJECT;
  }

  const tag = el.tagName.toLowerCase();

  // 2. 基础标签与显式过滤条件
  if (
    isNonHTMLNamespace(el) || 
    SKIP_SET.has(tag) || 
    hasTranslateBlockClass(el) || 
    isContentEditable(el) || 
    isElementHidden(el)
  ) {
    rejectedElementsCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  // 3. 规避回溯：仅在此处做单层 Class 判定，命中则打上标记并 REJECT 整棵树
  if (shouldSkipByClass(el) || shouldSkipBySiteRules(el)) {
    rejectedElementsCache.add(el);
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  if (SEMANTIC_SKIP_TAGS.has(tag)) {
    rejectedElementsCache.add(el); // 语义噪声容器（如 footer/nav）整棵子树全部丢弃
    counters.skipped++;
    return NodeFilter.FILTER_REJECT;
  }

  // 4. 核心容器匹配 (DIRECT_SET)
  if (DIRECT_SET.has(tag)) {
    const hasDirectSetDescendant = el.querySelector(Array.from(DIRECT_SET).join(','));
    if (hasDirectSetDescendant) {
      counters.skipped++;
      return NodeFilter.FILTER_SKIP; // 包含更深层的块级组件，跳过自身，允许深度遍历子孙
    }
    if (isValidText(el.textContent)) {
      counters.accepted++;
      return NodeFilter.FILTER_ACCEPT;
    }
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;
  }

  // 5. 混合文本块/匿名节点块判断
  const { hasDirectText, hasNonEmptyElement, hasOnlyInlineChildren } = classifyChildren(el);

  if (!hasOnlyInlineChildren) {
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;
  }

  if (hasDirectText || hasNonEmptyElement) {
    if (isValidText(el.textContent)) {
      counters.accepted++;
      return NodeFilter.FILTER_ACCEPT;
    }
  }

  counters.skipped++;
  return NodeFilter.FILTER_SKIP;
}

function collectBlocksFromRoot(
  startNode: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number },
  seenTexts: Set<string>
): { rejected: number; skipped: number; accepted: number } {
  const counters = { rejected: 0, skipped: 0, accepted: 0 };
  const walker = document.createTreeWalker(
    startNode,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    { acceptNode: (node) => acceptWalkerNode(node, counters) }
  );

  let currentNode: Node | null;
  while ((currentNode = walker.nextNode()) !== null) {
    // 此时 currentNode 必然是符合翻译准入条件的节点
    const translateNode = currentNode instanceof Element ? currentNode : currentNode.parentElement;
    if (!translateNode) continue;

    const text = translateNode.textContent?.trim();
    if (text) {
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
  }

  collectFromShadowHosts(startNode, blocks, blockIdRef, seenTexts);
  return counters;
}

// ... 其余保留 extractBlocks, findBlockNode, buildNodeMap 等不变

```

---

## 📈 改进后的优势

1. **逻辑内聚，消灭潜伏 Bug**：完全剥离了原先跟 `acceptWalkerNode` 抢夺控制权的 `grabNode`，避免因为两套过滤集不绝对同步造成的不可预测提取表现。
2. **零循环回溯（性能跃升）**：借助 `WeakSet` 在 DFS（深度优先）遍历路径上的状态向下透传特性，使得“子孙节点获知祖先是否由于 class 或是隐藏而被拒”的过程由原本手写的 $O(\text{depth})$ 退化降低为瞬时的 $O(1)$。
3. **彻底根绝内存抖动**：将频繁被触发的元组匹配正则、大写 UI 字样匹配正则全部固定为常驻全局变量，有效规避了在巨量 DOM 结构下引起高频微小 GC（垃圾回收）所造成的滚动掉帧或卡顿。