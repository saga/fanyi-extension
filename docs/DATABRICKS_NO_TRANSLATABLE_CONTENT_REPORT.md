# Databricks 博客 "No translatable content found" 根因与修复报告

> 触发页面：https://www.databricks.com/blog/introducing-genie-one-genie-ontology-and-genie-agents
> 现象：点击翻译后提示 "No translatable content found"，但页面明显有大量正文可翻译
> 涉及文件：`src/entrypoints/utils/contentDetector.ts`、`src/entrypoints/utils/contentHelper.ts`
> 修复日期：2026-06-21

---

## 0. 三句话结论

1. **是提取端的 bug**，跟 `MISSING_TRANSLATION_ANALYSIS.md` 里那个 LLM 漏翻问题**完全无关**（那个问题提取端正常、问题在 API 响应）。
2. **根因**：评分器 `detectArticleRoot()` 把 OneTrust cookie banner（`#ot-pc-content`，2612 字符高密度 GDPR 法律文本）误判为文章正文，得分 7872 压过真文章的 6544。banner 子树里所有可翻译块都被 overlay/cookie 规则剪枝，`extractBlocks` 返回 **0 块**，`prepareDocument` 抛错。
3. **修复方式**：①给评分器加 consent/cookie/广告 SDK 容器的**绝对排除**黑名单（根因修复）；②`prepareDocument` 在检测出的 root 产生 0 块时**回退到 `<body>` 重试**（防御兜底）。

---

## 1. 完整链路（出问题时的实际数据流）

```
databricks.com 博客页面
  ↓ contentHelper.prepareDocument(document)
  ↓ findArticleRoot()
  │   Layer 1: 16 个 ARTICLE_SELECTORS 全部 miss
  │            （页面用 <div class="article--content rich-text-blog">，
  │             没有 <article>/<main>/.article-body 等语义容器）
  │   Layer 2: detectArticleRoot() 评分
  │            #ot-pc-content (OneTrust banner)  → 7872 分 ★ 冠军
  │            .rich-text-blog (真文章)           → 6544 分
  │            .max-w-4xl (文章包装)              → 6077 分
  ↓ effectiveRoot = #ot-pc-content  ← 误判点
  ↓ extractBlocks(#ot-pc-content)
  │   从 banner 向下走 TreeWalker
  │   banner 子树里 26 个 <p>/<li>/<h3>
  │   每个祖先都带 ot-/onetrust/consent 类 → 全部命中 overlay/cookie 规则
  │   → 返回 0 块
  ↓ blocks.length === 0
  ↓ throw new Error('No translatable content found')
```

---

## 2. 根因详解

### 2.1 为什么所有 ARTICLE_SELECTORS 都 miss

Databricks 博客用非语义化的 `<div>` 构建正文：

```html
<div class="text-blog-body">
  <div class="max-w-4xl ...">
    <div class="article--content rich-text-blog blog-body-serif">
      <h1>...</h1>
      <p>...</p>
    </div>
  </div>
</div>
```

而 `contentHelper.ts` 的 `ARTICLE_SELECTORS` 只认 `.article-body`/`.article-content`/`<article>`/`<main>`/`[role="main"]` 等。**没有任何选择器命中**，Layer 1 快速路径直接 miss。

### 2.2 为什么 cookie banner 评分超过真文章

`contentDetector.ts` 的 `scoreElement()` 公式核心是文本密度：

```
score = (bodyTextLength / (linkCount + 1)) * log(textLength + 1) * (各信号修正)
```

OneTrust banner 的特征对这套公式是"完美攻击样本"：

| 特征 | OneTrust banner | 真文章 |
|---|---|---|
| 文本长度 | 2612 字符 | 8418 字符 |
| 链接数 | 几乎为 0 | 多个（产品链接、文档链接） |
| 文本密度（body/links） | **极高** | 中等 |
| 最终得分 | **7872** | 6544 |

GDPR 法律文本（"We use cookies to personalize content..."）又长又没链接，密度分天然爆表，把真文章挤到第二。

### 2.3 为什么 banner 走 walker 后是 0 块

`extractBlocks(#ot-pc-content)` 从 banner 根向下走 TreeWalker。banner 子树里确实有 26 个 DIRECT_SET 元素（`<p>`/`<li>`/`<h3>`），但它们**全部被剪枝**，因为每个元素的祖先链都携带 OneTrust 的类/id：

```
#ot-pc-content (class: ot-pc-scrollbar ot-sdk-row)
  ↑ #onetrust-pc-sdk (class: otPcTab ot-hide ot-sdk-not-webkit)
    ↑ #onetrust-consent-sdk
```

walker 的 `isOverlayElement()`（id 含 `consent`）、`shouldSkipByClass()`、cookie banner 文本匹配等规则层层拦截，26 个候选块归零。

**核心矛盾**：评分器说 banner 是正文（因为它文本密度高），但 walker 说 banner 是噪声（因为它带 consent 类）。两边标准不一致，导致"选了它 → 又把它全剪掉 → 0 块"。

---

## 3. 修复方案

### 修复 1（主，根因）：`contentDetector.ts` —— consent SDK 绝对排除

**思路**：隐私同意 / Cookie / 广告 SDK 容器（OneTrust、Cookiebot、TrustArc、Quantcast Choice 等）文本密度天然高，但**永远不该被当作 article root**。在评分前就把它们从候选里剔除。

**实现**：

```typescript
// contentDetector.ts

const CONSENT_SDK_ID_RE =
  /(?:onetrust|cookiebot|trustarc|quantcast|consent|gdpr|cookielaw|cookie-law|privacy)/i;
const CONSENT_SDK_CLASS_RE =
  /(?:onetrust|\bot-sdk|ot-pc|ot-cookie|cookiebot|trustarc|quantcast|qc-cmp|cookie-banner|consent-banner|gdpr-banner|privacy-banner)/i;

function isConsentSdkContainer(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') return false;
    const id = current.id || '';
    if (id && CONSENT_SDK_ID_RE.test(id)) return true;
    const cls = typeof current.className === 'string' ? current.className : '';
    if (cls && CONSENT_SDK_CLASS_RE.test(cls)) return true;
    current = current.parentElement;
  }
  return false;
}
```

接入点（两处防御）：

1. `collectCandidates()` 的 `add()` 里：命中 `isConsentSdkContainer` 的元素（含祖先命中）直接不进候选池。
2. `detectArticleRoot()` 选出冠军后：再校验一次冠军不是 consent SDK（防御 collectCandidates 祖先展开引入的外层包装），命中则返回 null 走 body 兜底。

**效果**：OneTrust banner 从候选里消失，真文章 `.rich-text-blog`（6544 分）成为冠军，正常被选中。

### 修复 2（防御，兜底）：`contentHelper.ts` —— 0 块回退 body

**思路**：即便将来又出现新的评分误判（比如某种新的高密度噪声容器没被黑名单覆盖），也不该让用户看到 "No translatable content found"。当检测出的 root 在 `extractBlocks` 后产生 0 块时，从整个 `<body>` 重试——walker 仍会用 overlay/cookie 规则过滤掉同意 SDK，真正的正文会被抓到。

**实现**：

```typescript
// contentHelper.ts prepareDocument()

const effectiveRoot = root instanceof Document ? findArticleRoot(root) : root;
let blocks = extractBlocks(effectiveRoot);

// 防御性回退：detectArticleRoot 误判导致 0 块时，从整个 body 重试。
if (blocks.length === 0 && root instanceof Document && effectiveRoot !== root.body) {
  console.warn(
    `[ContentHelper] Detected root <${effectiveRoot.tagName}> yielded 0 blocks, falling back to <body>`,
  );
  blocks = extractBlocks(root.body || root.documentElement);
}

if (blocks.length === 0) {
  throw new Error('No translatable content found');
}
```

**为什么 body 回退安全**：走 `<body>` 后 walker 仍会逐节点判断，OneTrust banner（带 `onetrust-consent-sdk` id）会被 `isOverlayElement` 整棵拒绝，不会污染翻译结果；真正的文章正文（不带 consent 类）会正常被提取。

---

## 4. 修改的文件清单

| 文件 | 改动 |
|---|---|
| `src/entrypoints/utils/contentDetector.ts` | 新增 `isConsentSdkContainer()` + 两个黑名单正则；`collectCandidates.add()` 加排除；`detectArticleRoot` 冠军加校验 |
| `src/entrypoints/utils/contentHelper.ts` | `prepareDocument` 加 0 块 → body 回退逻辑 |
| `src/__tests__/contentDetector.test.ts` | 加 2 个回归测试（OneTrust id 路径 + Cookiebot class 路径） |
| `src/__tests__/contentHelper.test.ts` | 加 1 个端到端回归测试（0 块回退 body） |

---

## 5. 回归测试

精确复刻了 Databricks 页面的 DOM 结构（OneTrust 三层嵌套 `#onetrust-consent-sdk > #onetrust-pc-sdk > #ot-pc-content`，内含 GDPR 法律文本，外加真文章 `.rich-text-blog`），验证：

| 测试 | 期望 |
|---|---|
| `excludes consent/cookie SDK containers even when they score highest` | `detectArticleRoot` 返回真文章，冠军不是任何 OneTrust 容器 |
| `excludes consent SDK reachable via class match (Cookiebot)` | class 路径（`CybotCookiebotDialog`）也被排除 |
| `falls back to body when the detected root yields 0 translatable blocks` | `prepareDocument` 在 root 产生 0 块时回退 body，真文章被翻译、banner 文本不进结果 |

全套 **656 个测试通过**，3 个新测试全部通过。

---

## 6. 验证步骤

1. `pnpm wxt prepare`（刷新 WXT 自动类型）
2. `pnpm compile`（本次改的两个文件 typecheck 干净；其余报错是仓库既有的、与本次无关的 stale 类型问题）
3. `pnpm test`（656 passed）
4. `pnpm build`（重新构建 Chrome 扩展）
5. 加载 `output/chrome-mv3/`，访问 Databricks 博客 URL，点击翻译 → 正常翻译 ✅

---

## 7. 为什么不直接给 Databricks 加站点选择器

考虑过在 `ARTICLE_SELECTORS` 里加 `.rich-text-blog` 或 `.article--content`，但：

- **脆弱**：Databricks 改一次 class 名就失效，其他站点用不同 class 又得逐个加。
- **没解决根因**：评分器把 consent banner 评得比正文高这个缺陷还在，下一个用 OneTrust + 非 `<article>` 结构的站点照样翻车。

黑名单方案治本——把"隐私同意 SDK 永远不该是正文"这个领域知识固化进评分器，对**所有**用 OneTrust/Cookiebot/TrustArc 的站点（极多）一次性生效。

---

## 8. 后续可考虑的改进（未做）

- `ARTICLE_SELECTORS` 可补 `.rich-text-blog` 等常见 CMS 正文 class，让这类站点走 Layer 1 快速路径（性能更好，不依赖评分）。优先级低，因为修复 2 的 body 回退已保证兜底。
- 评分器可考虑加入"可翻译块数"信号：一个候选走 walker 后能产出多少有效块，比纯文本密度更可靠。但需要在评分阶段跑 walker（较重），暂不引入。
