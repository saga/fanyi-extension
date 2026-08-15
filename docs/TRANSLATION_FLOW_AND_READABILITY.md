# fanyi-extension 翻译判断流程与 Readability 使用分析

> 适用代码（截至 2026-08-12）：
> - 流程编排：`src/entrypoints/content/translation.ts`、`src/entrypoints/content/serverTranslation.ts`
> - 根判定：`src/entrypoints/utils/contentHelper.ts`（`findArticleRoot`）、`src/entrypoints/utils/contentDetector.ts`（`detectArticleRoot` / `tryReadabilityRoot`）
> - 块提取：`src/entrypoints/utils/blockExtractor/walker.ts`
>
> 本文档描述**当前**实现，不追溯历史版本。

---

## 1. 总览：两条翻译路径，一个提取内核

扩展的翻译入口是 `translation.ts` 的 `start()`。它先 `getConfig()` 决定走哪条路径，但**两条路径都共用同一个提取内核** `prepareDocument()`：

```
                         start()  (translation.ts)
                                │
                                ▼
                          getConfig()
                                │
            ┌───────────────────┴───────────────────┐
            │ useServerTranslation === true ?        │
            └───────────────────┬───────────────────┘
              YES               │               NO
               ▼                │                ▼
    checkServerCache()     ┌────┴────┐   translateChunksViaBackground()
    translateViaServer()   │ 都用    │   （本地 DeepSeek / 其他 provider）
    applyServerTranslatedHtml()  │  prepareDocument() 提取内核
               │          └────┬────┘          │
               │                │               │
               └───────►  blocks / nodeMap ◄────┘
                          （统一产出，按 data-fanyi-block-id 关联 DOM）
```

**关键事实（容易混淆）**：「服务端翻译」≠「服务端决定翻译哪些块」。

- **正常翻译路径**（用户点扩展翻译，默认 `useServerTranslation`）：扩展**本地**调用 `prepareDocument()`，用**扩展自己的 walker** 给每个块打 `data-fanyi-block-id`、产出 `blocks`/`nodeMap`，再把整页 HTML 发给 `s.sunxiunan.com/fanyi/page`。服务端**只按这些 id 翻译**，不再重新判断正文范围。
- **`/force/` 与浏览器直译路径**：服务端 `vocal-saga` 的 `prepareDocument` **自己 walk、自己打 id**，不经过扩展 walker。

所以「服务端翻译没翻出某段正文」，在正常路径下真正的根因往往在前端的 `findArticleRoot` + walker；只有 `/force/` 直译才是 `vocal-saga` 的 walker。两仓的 walker 是**独立分叉副本**，修复需各自落地（见第 6 节）。

---

## 2. 正文根判定（`findArticleRoot`）的四层架构

`contentHelper.ts:314` 的 `findArticleRoot(doc)` 按优先级从四个层级选根，**命中即返回**：

| 层级 | 机制 | 适用场景 | 失败则 |
|------|------|----------|--------|
| **Layer 0** | 站点规则 `articleRootSelector`（`rules.ts`） | 通用选择器搞不定的特定站点（如 hero 与正文分属兄弟 section） | 落到 Layer 1 |
| **Layer 1** | `ARTICLE_SELECTORS` 显式清单逐条匹配（取文本最长者），再 `refineArticleRoot` → `expandWrappers` → `chooseBestRoot` 评分 | 已知高价值站点（WordPress / Ghost / Hugo / 404media 的 `.post__content` 等） | 落到 Layer 2 |
| **Layer 2** | `detectArticleRoot`：**Readability 主条件 + 手写评分兜底**（本文重点） | 未知站点、碎片正文、缺语义标签 | 落到 Layer 3 |
| **Layer 3** | `doc.body`（整页兜底） | 前述全部失败 | —（仍可能被 walker 噪声规则过滤） |

### Layer 1 的细节
`ARTICLE_SELECTORS`（`contentHelper.ts:11`）是一个**手工 curated 清单**，按「具体容器在前、语义标签兜底」排序：

```
.article-body / .article-content / .article-text / .story-body / .story-content
.u-rich-text-blog / .rich-text / .blog-content / .post-content / .post__content
.entry-content / .page-content / article / [role="article"] / [role="main"]
main / .main-content / .content-body
```

命中后还要经过三步加工：
1. `refineArticleRoot`（`:60`）：若候选是具体正文容器、而其 `<article>` 祖先里有不在容器内的 h1/h2，则**上扩到 `<article>`**（避免标题漏翻，参见 mitsloan 修复）。
2. `expandWrappers`（`:125`）：穿透纯包装层（父文本与子相同），但遇到 `nav/menu/sidebar/footer/header/comment/widget` 立即停止。
3. `chooseBestRoot`（`:276`）：对 candidate 到含 h1 祖先逐层评分（`scoreArticleContainer`），选最高分——解决「hero 与正文是兄弟 section，应一起选」的问题。

---

## 3. Readability 的角色：主条件，而非兜底

`contentDetector.ts` 的 `detectArticleRoot`（Layer 2）是本次分析的核心。它的逻辑**与旧版相反**：

```
detectArticleRoot(doc):
  ① tryReadabilityRoot(doc)        ← 先跑，成功即采用
  ② if 失败/返回 body|consent:
       手写评分算法 (collectCandidates + scoreElement)  ← 兜底
  ③ if 评分 < SCORE_THRESHOLD(300): 返回 null → 上层落到 Layer 3(body)
```

### 3.1 为什么把它当主条件

`@mozilla/readability` 是成熟的阅读模式提取器，在「聚合正文」上比手写评分更鲁棒：
- 多 section 碎片站点（如 `developers.googleblog.com` 的 `.inner-block-content.rich-content`），评分算法容易只选其中一个小节；
- 缺语义标签（`article`/`main`）的站点；
- 被噪声容器干扰的站点——典型如 **404media.co**：`<article class="... has-sidebar">` 含正文，但 h1 在兄弟 `.post-hero`，手写评分把 root 上提到含 h1 的 `<main>`，再被 walker 的 `sidebar` 噪声类整棵拒掉（详见第 4 节）。Readability 能稳定把正文聚合出来。

> 设计边界（与用户确认过）：Layer 1 的**显式选择器仍优先于 Readability**。理由——curated 清单对已知站点更精确（能排除特定 boilerplate），去掉会在已知站点上回归。若未来想让 Readability 也先于 Layer 1，需另行评估。

### 3.2 `tryReadabilityRoot` 工作机制（`contentDetector.ts:447`）

Readability 不能直接在原始 DOM 上跑（它会改写树，破坏后续提取），所以流程是：

1. **克隆文档**：`doc.documentElement.cloneNode(true)` → 新建 `cloneDoc`，只在克隆上 `new Readability(cloneDoc).parse()`。
2. **最小长度闸门**：`article.textContent.trim().length >= 200` 才算成功，否则返回 `null`。
3. **取定位签名**：把正文按行拆分，取第一个 `length >= 40` 的段落作为 `signature`（找不到则取首段）。
4. **回原始 DOM 定位**：用 `TreeWalker` 在 `doc.body` 的文本节点里找包含 `signature` 的节点。为应对「清理后文本被 `<span>` 拆碎」（如 `LiteRT.js` 被单独包裹），签名会逐步缩短到词前缀（`>= 12` 字符）重试。找不到命中 → 返回 `null`。
5. **向上走到稳定容器**：从命中的文本节点向上，遇到 `article/main/section/div/body` 就记为候选 `root`，直到该容器的文本覆盖 Readability 正文的 **80%**（`coverageThreshold`）即停止——这样在 `sunxiunan` 这类多 section、没有统一 wrapper 的站点上，能走到 `body` 聚合全文。

### 3.3 三个防御闸门

Readability 返回的结果不会无条件采用，有三道闸：

| 闸门 | 条件 | 处理 |
|------|------|------|
| 长度 | 正文 `< 200` 字符 | `tryReadabilityRoot` 直接返回 `null` → 转评分 |
| 签名命中 | 签名在原始 DOM 找不到 | 返回 `null` → 转评分 |
| consent 容器 | `isConsentSdkContainer(root)` | 拒绝（cookie/GDPR 弹窗文本密度天然高，会抢 root） |
| **body/html 守卫** | `root === body \|\| root === html` | **不采用**，转评分算法取更精确容器 |

最后一道闸很重要：Readability 在有些页面（如 OneTrust cookie 弹窗页，真实文章是 `body` 直接子节点）**只能定位到 `body`**。若直接采用 `body`，walker 会遍历整页、可能误翻 GDPR 文本，且回归测试会失败。此时转交手写评分，往往能精确选到 `.rich-text-blog` 之类的真实正文容器。

### 3.4 为什么 Readability 不是「主提取器」

Readability 产出的是**合成后的干净阅读视图**——它会改写/剥离原 DOM，返回一个新的 `article` 对象，里面**没有「原元素」可配对**。而本扩展要在**原始页面上做双语对照**：保留原 DOM、给每个块打 `data-fanyi-block-id`、把译文回注到原元素**旁边**（原文 + 译文并排）。

Readability 的结果没有「原元素」，没法做这个 overlay。因此它的角色被严格限定为 **root 定位器**：只在克隆文档上跑、拿到正文、用签名回原始 DOM 定位容器，然后把 root 交还给同一个 `blockExtractor` walker 做块提取。它和手写评分互为补充，而非替代 `extractBlocks`。

---

## 4. 块提取 walker：为什么 Readability 不解决一切

即便 `findArticleRoot` 选对了 root，`blockExtractor/walker.ts` 仍可能把正文**整棵丢弃**。这正是 404media 的 bug 根源，也是「Readability 当主条件」修不掉的地方。

walker 用 `NodeFilter` 遍历 root 子树，对噪声类（广告 / cookie / 侧边栏 / 推荐）执行 `FILTER_REJECT`（整棵子树拒绝）。问题出在 `shouldSkipByClass` 用**后缀规则**匹配：

```js
// walker.ts:213 附近
if (shouldSkipByClass(el) || shouldSkipBySiteRules(el)) {
  if (tag === 'article' || tag === 'main') {
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;   // 跳过自身、下钻子树
  }
  // 其他标签（div/section）：整棵拒绝
  rejectedCache.add(el);
  return NodeFilter.FILTER_REJECT;
}
```

404media 的 `<article class="post tag-ai ... post-access-paid has-sidebar">` 命中 `sidebar` 模式。修复前，**无论标签**都 `FILTER_REJECT` → 整棵 `<article>`（含正文 `<p>`）被丢弃。

**修复**：当元素是 `article` 或 `main` 且命中噪声类时，改为 `FILTER_SKIP`（跳过自身、继续下钻子树），与文件里已有的 metadata 类守卫对 `article`/`main` 的特例保持一致。

**为什么只豁免 `article`/`main`，不扩展到 `div`/`section`**：`ad-content`、`sponsored-content`、`post-content-wrapper`（在 `POSITIVE_TOKENS` 里）等噪声 div 也含 `content`/`post`，若一并豁免，walker 会下钻提取广告/赞助内容——这正是 `blockExtractor.test.ts` 里 10 个噪声屏蔽回归测试守护的契约。

---

## 5. 防御性兜底链（`prepareDocument`，`contentHelper.ts:672`）

提取内核 `prepareDocument(root)` 在根判定之后还有一条兜底链，确保「尽量翻到内容」：

```
extractBlocks(effectiveRoot)
   └─ 若 0 块 且 root 是 Document:
        ① 退到 <body> 重试 extractBlocks   （防 detectArticleRoot 误判整棵剪枝）
        ② 仍 0 块: extractFromDataIsland() （SPA 站点：__NEXT_DATA__ / __NUXT_DATA__ / application/json）
   └─ 仍 0 块:
        isPdfJsViewerHtml() ? 抛 PDF.js 专用错误 : 抛 "No translatable content found"
```

`createOverlayHider()` 还会在翻译期间持续监听 DOM，隐藏运行时动态注入的营销弹窗 / cookie 层（避免盖住译文或造成白屏）。

---

## 6. 双仓一致性：vocal-saga 也要同步修复

扩展与 `vocal-saga`（服务端 Cloudflare Worker）各自维护一份 `blockExtractor` 副本，已分叉：

| 修复项 | fanyi-extension | vocal-saga | 说明 |
|--------|----------------|------------|------|
| 404media walker `has-sidebar` 修复 | ✅ 已修 | ✅ 已修（实证：修复前服务端翻不出 404media 正文） | 两个 walker 都需 `article`/`main` 的 `FILTER_SKIP` 例外 |
| 选择器 `.post__content` | ✅ 已加 | ✅ 已有 | vocal-saga `selector.ts` 第 32 行本就含此选择器 |
| Readability 主条件化 | ✅ 已改 | 无需改 | vocal-saga 本就是多 provider 管线，Readability 是平等候选（含 +0.05 boost），不存在「仅兜底」问题 |

**结论**：
- 「Readability 主条件化」这次改动**不移植**到 vocal-saga（架构本就如此）。
- 「404media walker 修复」**必须移植**，且已实证修复——用户「服务端一开始翻不出 404media 正文」的体验，正是服务端侧（无论前端 walker 还是 vocal-saga walker）存在 bug 的证据。
- vocal-saga 改在 `lib/` 源码，需 `build:lib` + `deploy:cf` 才上线。

---

## 7. 已知边界与演进方向

1. **Layer 1 显式选择器仍优先于 Readability**。对已知站点这是特性（更精确），但也意味着 Readability 的鲁棒性在那些站点上没被利用。若要让 Readability 彻底主导，需重新评估已知站点回归风险。
2. **Readability 偶发定位到 `body`** 时会转交评分算法——这是有意的精度权衡（避免整页误翻），但代价是评分算法的盲区在此时会暴露。
3. **`ARTICLE_SELECTORS` 与 `POSITIVE_TOKENS` 是手工清单**，靠站点踩坑逐步补充（如 `.post__content` 因 404media 加入）。无法覆盖长尾站点，最终依赖 Layer 2 的 Readability + 评分兜底。
4. **两个副本（扩展 / vocal-saga）的分叉风险**：两边 walker 逻辑应保持一致，但当前靠人工同步。建议长期考虑抽成共享包，或在 CI 中跑同一组 404media / 噪声回归用例。

---

### 附：关键函数索引

| 函数 | 文件:行 | 职责 |
|------|---------|------|
| `findArticleRoot` | `contentHelper.ts:314` | 四层根判定入口 |
| `refineArticleRoot` / `expandWrappers` / `chooseBestRoot` | `contentHelper.ts:60/125/276` | Layer 1 加工 |
| `detectArticleRoot` | `contentDetector.ts:537` | Layer 2：Readability 主 + 评分兜底 |
| `tryReadabilityRoot` | `contentDetector.ts:447` | Readability 定位器 |
| `scoreElement` / `collectCandidates` | `contentDetector.ts:248/376` | 手写评分算法 |
| walker 噪声类分支 | `blockExtractor/walker.ts:213` | `article`/`main` 的 `FILTER_SKIP` 例外 |
| `prepareDocument` | `contentHelper.ts:672` | 提取内核 + 兜底链 |
| `translateViaServer` / `prepareHtmlForServer` | `serverTranslation.ts:193/42` | 服务端路径（按 id 翻译） |
