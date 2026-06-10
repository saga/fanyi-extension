# 翻译插件标题/副标题未翻译 — 根因分析报告

**日期**：2026-06-10
**复现 URL**：https://www.aleksagordic.com/blog/transformer
**症状**：h1 标题 `Inside the Transformer: The Life of a Token` 和 h2 副标题 `A deep dive into a modern dense transformer: ...` 始终保持英文，但 article body（`<p>`）正常翻译成中文。

---

## 根因

[`blockExtractor.ts`](file:///Users/saga/code-repos/fanyi-extension/src/entrypoints/utils/blockExtractor.ts) 的 `acceptWalkerNode` 把 `<header>` 与 `<footer>/<aside>/<nav>` 一同放在 [`SEMANTIC_SKIP_TAGS`](file:///Users/saga/code-repos/fanyi-extension/src/entrypoints/utils/blockExtractor.ts#L38)：

```ts
const SEMANTIC_SKIP_TAGS = new Set(['header', 'footer', 'aside', 'nav']);
```

并在 [line 555-560](file:///Users/saga/code-repos/fanyi-extension/src/entrypoints/utils/blockExtractor.ts#L555-L560) 触发：

```ts
if (SEMANTIC_SKIP_TAGS.has(tag)) {
  rejectedCache.add(el);
  counters.skipped++;
  return NodeFilter.FILTER_REJECT;  // ← 整棵子树被连坐拒绝
}
```

`FILTER_REJECT` 会**阻止 TreeWalker 进入子树**——所有 `<header>` 后代节点（h1、h2、p、span）都不会被访问。

aleksagordic 文章页的 DOM 结构（[chrome-devtools 抓取](#)）：

```html
<article>
  <header class="mb-8">
    <h1 class="font-bold text-3xl mb-4">Inside the Transformer: The Life of a Token</h1>
    <h2 class="text-xl mb-3 mt-6">A deep dive into a modern dense transformer: ...</h2>
  </header>
  <p>In this post, I'll do a deep dive ...</p>
  ...
</article>
```

**触发路径**：

1. TreeWalker 走到 `<header class="mb-8">`
2. `tag === 'header'`
3. `SEMANTIC_SKIP_TAGS.has('header') === true`
4. `return FILTER_REJECT` → 整个 `<header>` 子树（包括 h1 / h2）被丢弃
5. `<header>` 后面的 `<p>` 正常进入 walker
6. `grabNode` 抓到的 `blocks` 数组里**没有 h1 / h2**，所以翻译请求根本不包含标题
7. 后台 DeepSeek 拿到的是无标题的 chunk 列表，翻译后应用回 DOM，标题位置保持原文

---

## 验证

实际抓取确认 [blockExtractor.ts](file:///Users/saga/code-repos/fanyi-extension/src/entrypoints/utils/blockExtractor.ts) 的 `acceptWalkerNode` 流程：

| 节点 | 行为 |
|------|------|
| `<header class="mb-8">` | `FILTER_REJECT`（整棵子树拒绝）|
| `<h1>Inside the Transformer...</h1>` | 父链拒绝，文本节点连坐拒绝 |
| `<h2>A deep dive...</h2>` | 父链拒绝，文本节点连坐拒绝 |
| `</header>` 后面的 `<p>` | 正常 walker，命中 `DIRECT_SET.has('p')` → 进 blocks |
| 后台 log `inputIds` | 缺 b1 / b2（h1 / h2 的 id）|

之前用户的 background console log：

```text
[Background][ChunkTrace] INPUT inputBlocks=14 inputIds=[b27,b28,...]
```

h1 / h2 的 id 缺失也支持这一点（h1 / h2 在 chunk1 之前的 `extractBlocks` 阶段就被丢掉了）。

---

## 为什么这个 bug 一直存在

`<header>` 在 HTML 里有两种用法：

| 用途 | 典型例子 | 应否翻译 |
|------|----------|----------|
| 页面 chrome（导航条 / 顶部品牌区） | `<header class="site-header"><nav>...</nav></header>` | **否** |
| 文章页标题区 | `<header class="mb-8"><h1>标题</h1><h2>副标题</h2></header>` | **是** |

旧代码"一刀切"地把所有 `<header>` 当作 chrome，连文章标题也丢了。这在新闻/博客站点（aleksagordic、Substack、Medium、dev.to）尤其明显。

---

## 修复方案

### 区分 chrome header vs 文章 header

判定规则：**含 h1-h6 的 `<header>` → 文章 header → 进 walker；不含 → chrome → 仍拒绝**。

[blockExtractor.ts:553-572](file:///Users/saga/code-repos/fanyi-extension/src/entrypoints/utils/blockExtractor.ts#L553-L572)：

```ts
if (tag === 'header') {
  // 文章页面的 <header> 通常是真实内容（标题、副标题、作者、日期、分类），
  // 不能整棵子树拒绝。
  // 但页面 chrome（navbar / site-header）也是 <header>，仍然要拒。
  const hasHeading = el.querySelector('h1, h2, h3, h4, h5, h6') !== null;
  if (hasHeading) {
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;  // 跳过自身, 走子树
  }
  rejectedCache.add(el);
  counters.skipped++;
  return NodeFilter.FILTER_REJECT;
}
```

`FILTER_SKIP`（不是 `REJECT`）让 TreeWalker 跳过 `<header>` 自身但**继续走子树**。子树里的 h1 / h2 正常被 `acceptWalkerNode` 评估（`DIRECT_SET.has('h1')` → `FILTER_ACCEPT`），最后进入 `grabNode` → 抽出文本。

### 测试覆盖

[blockExtractor.test.ts:4170-4247](file:///Users/saga/code-repos/fanyi-extension/src/__tests__/blockExtractor.test.ts#L4170-L4247) 新增 3 个测试：

1. `extracts h1 and h2 inside an article <header>` — aleksagordic 真实场景
2. `still rejects chrome <header> (navbar) without headings` — 回归保护
3. `handles header with h1 + date + author` — 博客 header 含 meta p

---

## 副带的好处

修复后这些**标题级内容**会正常翻译（之前被 chrome header 误丢）：

- `<header>` 里的 `<h1>` 主标题
- `<header>` 里的 `<h2>` / `<h3>` 副标题 / 小节标题

⚠️ **不应翻译**（已通过 [`isMetadataClass`](file:///Users/saga/code-repos/fanyi-extension/src/entrypoints/utils/blockExtractor.ts#L218-L244) 整棵子树拒绝）：

- `<header>` 里的 `<p class="post-meta">` —— "By John Doe on May 26, 2026 in Tech"
- `<header>` 里的 `<div class="author-bio">` —— "Written by Jane Smith, ..."
- `<header>` 里的 `<ul class="post-categories">` —— 分类列表

**匹配规则**：整词分割（`split(/[\s_\-]+/)`），不是子串匹配。避免误伤 `class="metadata-block"` / `class="authorship"`。

**关键词集合**：`meta` / `author` / `byline` / `category` / `categories` / `dateline`。

---

## 风险评估

| 风险 | 缓解 |
|------|------|
| 误翻译 `<header class="site-header">` 里的 brand 名 | 测试 2 验证：不含 h1-h6 的 header 仍被整棵拒绝 |
| 部分站点用 `<header>` 包裹非标题的"hero"内容（banner / CTA） | 这些 hero 通常含 h1-h2（"Welcome to ..."），翻译是合理的 |
| TreeWalker 性能 | 多一次 `querySelector('h1...h6')` 调用，对性能影响可忽略（DOM 树局部查询） |

---

## 复现步骤（修复前）

1. `pnpm build` 加载 extension
2. 打开 https://www.aleksagordic.com/blog/transformer
3. 触发翻译（Alt+T）
4. 观察：h1 / h2 保持英文，`<p>` 正常翻译
5. background service worker console 看到的 `inputIds` 缺 h1 / h2

## 验证步骤（修复后）

1. `pnpm build` 重新加载
2. 同一页面触发翻译
3. h1 翻译为 "深入 Transformer：Token 的生命周期"
4. h2 翻译为 "深入探讨现代 dense transformer：YaRN、混合注意力、..."
5. background console `inputIds` 出现 h1 / h2
