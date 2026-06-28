# BankingDive 前半部分未翻译 — Root Cause 分析

## 现象

访问 `https://www.bankingdive.com/news/wells-fargo-ceo-scharf-ai-employment-banking-jobs/821368/`，
点击翻译后：

- 页面顶部 **标题** (h1) "Wells Fargo CEO: AI's effect on employment is..." 仍是英文
- **副标题** "The bank's biggest AI-related challenge is..." 仍是英文
- 从正文段 "As the company considers..." 开始才有翻译
- 后续所有正文段落均能正常翻译

## 根因（不止一个，三个叠加）

### 1. 翻译范围错误：`<article>` 实际是整页 wrapper

BankingDive 的 DOM 结构：

```
<article>                                     ← 整页包装（包含页眉/分享菜单/署名/正文）
  <div class="first-page-pdf">                 ← 文章头：h1、副标题、署名、分享菜单
    <h1>Wells Fargo CEO: ...</h1>
    <ul class="social-icon-list--inner">      ← 8 个分享按钮 li
      <li>Copy link</li><li>Email</li>...
    </ul>
  </div>
  <div class="row">
    <div class="article-body">                 ← 真正正文
      <p>Wells Fargo CEO Charlie Scharf said Wednesday...</p>
      ...
    </div>
  </div>
</article>
```

旧 `findArticleRoot` 用 `ARTICLE_SELECTORS` 第一个匹配 —— `<article>`。
它把页眉 h1、副标题、8 个分享菜单 li、署名、首页说明都当成"可翻译块"
一起塞进首 chunk。

实际验证：把 `<article>` 作为 root，提取出 42 个块，
前 16 个块都是页眉/分享菜单噪声（h1、副标题、8 个 li、figcap、署名）。

### 2. 首 chunk 过大 → 模型截断/拒答

chunkBuilder 按 token 数（~800）切块。首 chunk 包含 16 个噪声块
+ 8 个首段正文 = 约 24 个块，已经接近上限。模型在这种"头重脚轻"的
输入下：

- 要么直接截断（只翻译前 5-6 个块，后面完全丢）
- 要么把噪声（"Copy link"、"Email"）当成主语，给出无意义译文
- 标题往往排在前几个噪声块里一起被吃

结果：首 chunk 的 h1、副标题、figcap 全部不返回译文 → 用户看到
"标题没翻译"。

### 3. 分享菜单 class 漏过滤

`<ul class="social-icon-list--inner">` 是分享菜单的容器，但：
- 旧 `SKIP_CLASS_PATTERNS` 只有 `social-share`、`share-buttons`
- `social-icon-list` 没在列表里
- `shouldSkipByClass` 只检查**元素自身**的 class，`<li>` 本身没
  class（class 在父 `<ul>` 上），所以遍历到 li 时不会被拒绝

8 个 li 全部进入提取（Copy link / Email / LinkedIn / X/Twitter /
Facebook / Print / License / Add us on Google），进一步撑大首 chunk。

## 验证数据

| 方案 | 提取块数 | 首 chunk 大小 | 标题/副标题/正文表现 |
|------|---------|--------------|---------------------|
| 旧：`<article>` 为 root | 42 | 16+8 | 全部挤首 chunk，模型截断 |
| 中间：`<article>` + skip share menu | 33 | 22 | 标题 + 正文同 chunk，更可靠但仍偏大 |
| 激进：下钻到 `.article-body` | 27 | 23 | 标题/副标题丢失，正文稳定翻译 |
| **最终：三者并用** | **33** | **11** | **h1 + 副标题 + 8 段正文，稳定出译文** |

## 修复策略（三路并进）

1. **`refineArticleRoot` 智能判断**：当选中的是 `.article-body` 且其
   祖先 `<article>` 内有不在 `.article-body` 内的 h1/h2 时，向上扩展到
   `<article>`（TreeWalker 会一并遍历到 `.first-page-pdf` 里的 h1）。
   同时校验标题有非空文本（≥4 字符），装饰性空标题不触发扩展。
2. **`SKIP_CLASS_PATTERNS` 扩展 + `isInsideSkippedAncestor`**：
   - 加上 `share-menu`、`share-list`、`share-icons`、`social-icons`、
     `social-icon-list`、`social-share-list`、`share-toolbar`
   - 祖先 class 检查：`<li>` 自身没 class 但父 `<ul>` 有时，整个
     子树都要拒掉（不能用 `closest()`，因为 CSS 类选择器是精确匹配，
     漏掉 `ot-cookie-policy-content` 这类带后缀的 class）
3. **`chunkBuilder` 首 chunk 块数硬上限（FIRST_CHUNK_MAX_BLOCKS=12）**：
   即使 token 没爆，第 13 个块也强制切到 chunk 2，确保 h1 + 副标题
   + 引言段落稳定在首 chunk 输出。

## 验证数据（最终）

| 方案 | 总块数 | Chunk 数 | 首 chunk 大小 | 标题/副标题是否在首 chunk |
|------|--------|---------|--------------|--------------------------|
| 旧：`<article>` 为 root | 42 | 4 | 16+ | 否（被噪声挤出） |
| 新：`<article>` + skip share menu + 首 chunk 上限 | 33 | 4 | **11** | **是** |

实际首 chunk 内容：h1（标题）+ 副标题 + figcaption + 8 段首段正文。

## 受影响文件

- `src/entrypoints/utils/contentHelper.ts` — `refineArticleRoot` + `hasValidHeadingOutside`
- `src/entrypoints/utils/blockExtractor.ts` — `SKIP_CLASS_PATTERNS` 扩展
  + 新增 `isInsideSkippedAncestor()`（保留手写遍历，不用 `closest()`）
- `src/entrypoints/utils/chunkBuilder.ts` — 新增 `FIRST_CHUNK_MAX_BLOCKS=12`
- `src/__tests__/contentHelper.test.ts` — 改 bankingdive 测试用例 +
  新增"标题在 .article-body 内"的下钻场景
