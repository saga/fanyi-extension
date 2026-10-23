# fanyi-extension 架构文档

> 简简单单翻译 — 支持 Chrome、Firefox、Android Firefox 的浏览器翻译扩展

## 1. 项目概览

### 1.1 定位

浏览器扩展，将网页正文逐块翻译为中文（或其他目标语言），以双语对照方式显示。当前有三种翻译路由：直连 DeepSeek API、远程 Vocal Saga 服务、以及本机 Workbuddy/OpenCode Agent 服务。启用本机 Provider 后，网页分块、YouTube 字幕、文档翻译及文学分析/审校都严格走本机；本机模型或服务失败时直接报错，不切换到远程 API。

### 1.2 技术栈

| 层面 | 技术 |
|------|------|
| 扩展框架 | WXT (v0.20+) — 基于 Vite 的 WebExtension 开发框架 |
| 前端框架 | Vue 3 (popup 配置 UI) |
| 翻译引擎 | DeepSeek API（直连模式）；本机 Workbuddy/OpenCode Agent；可选 Vocal Saga 远程翻译服务 |
| 正文提取 | 自研 blockExtractor + @mozilla/readability fallback |
| 术语提取 | compromise NLP 库 + 自研规则 |
| 测试 | Vitest + jsdom |
| 类型 | TypeScript (strict mode) |
| 包管理 | pnpm |
| 浏览器 polyfill | webextension-polyfill |
| 本机服务（可选） | 独立仓库 `devweekly/vocal-saga/local-agent-service`，Express + TypeScript + SQLite；默认 `127.0.0.1:8789` |

### 1.3 浏览器兼容

| 浏览器 | Manifest 版本 | 特性差异 |
|--------|---------------|---------|
| Chrome / Chromium | MV3 | 完整支持快捷键 (Alt+T/R/V)、右键菜单、host_permissions |
| Firefox Desktop | MV2 | permissions 合并到单一数组 |
| Android Firefox | MV2 | 静默忽略 contextMenus/commands，通过触屏手势交互 |

## 2. 项目结构

```
fanyi-extension/
├── src/
│   ├── entrypoints/              # WXT 入口点
│   │   ├── background.ts         # Background script (Service Worker)
│   │   ├── content.ts            # Content script 主入口
│   │   ├── content/              # Content script 业务模块
│   │   │   ├── translation.ts        # 翻译控制器 (核心编排)
│   │   │   ├── chunkTranslation.ts   # 分块翻译调度
│   │   │   ├── serverTranslation.ts  # 服务端翻译协议
│   │   │   ├── translationUtils.ts   # 状态管理 + 动态监听
│   │   │   ├── translationTypes.ts   # 翻译状态类型
│   │   │   ├── configPanel.ts        # 页面内配置面板
│   │   │   ├── statusOverlay.ts      # 状态提示条
│   │   │   ├── touchGesture.ts       # 触屏三击翻译手势 (Firefox Android)
│   │   │   ├── styles.ts             # CSS 模板
│   │   │   └── youtube/              # YouTube 字幕翻译
│   │   │       ├── index.ts              # 公共 API
│   │   │       ├── manager.ts            # 生命周期管理器 (单例)
│   │   │       ├── provider.ts            # 字幕抓取 (POT/timedtext)
│   │   │       ├── translator.ts          # 批量翻译 + Ahead Buffer
│   │   │       ├── overlay.ts             # 字幕 UI 渲染
│   │   │       └── types.ts               # 共享类型
│   │   ├── popup/                # Popup Vue 应用
│   │   │   ├── App.vue               # 配置界面
│   │   │   ├── main.ts               # Vue 挂载
│   │   │   └── index.html
│   │   ├── service/              # LLM 翻译服务层
│   │   │   ├── _service.ts           # TranslationService 接口 + Glossary 类型
│   │   │   ├── deepseek.ts           # DeepSeek API 客户端
│   │   │   ├── streamParser.ts       # SSE 流式解析
│   │   │   ├── jinyong-prompt.ts     # 金庸风格 prompt
│   │   │   ├── acheng-prompt.ts      # 阿城风格 prompt
│   │   │   └── wangxiaobo-prompt.ts  # 王小波风格 prompt
│   │   ├── utils/                # 核心工具模块
│   │   │   ├── blockExtractor/       # DOM 块提取器
│   │   │   │   ├── index.ts              # extractBlocks() 公共 API
│   │   │   │   ├── walker.ts             # TreeWalker 遍历 + grabNode
│   │   │   │   ├── rules.ts              # 谓词函数集 (is* / shouldSkip*)
│   │   │   │   ├── constants.ts          # 静态数据 (SKIP_SET, DIRECT_SET, ...)
│   │   │   │   └── types.ts              # TextBlock 类型
│   │   │   ├── contentDetector.ts    # 智能正文根节点检测
│   │   │   ├── contentHelper.ts      # 文章根选择 + prepareDocument
│   │   │   ├── chunkBuilder.ts       # 文本分块
│   │   │   ├── chunkRetry.ts         # 重试策略
│   │   │   ├── translationDisplay.ts # 双语对照 DOM 操作
│   │   │   ├── translationQueue.ts   # 串行/并行任务队列
│   │   │   ├── translateApi.ts       # 翻译结果解析 + 缓存
│   │   │   ├── cacheManager.ts       # analysisCache + translationCache 出口（译文缓存由 ShardedCache 分片持久化）
│   │   │   ├── cacheKey.ts           # 简单哈希缓存键
│   │   │   ├── config.ts             # 配置读写 (@wxt-dev/storage)
│   │   │   ├── glossaryExtractor.ts  # 术语提取 (compromise NLP)
│   │   │   ├── domObserver.ts        # MutationObserver 动态内容监听
│   │   │   └── common.ts             # 通用工具
│   │   └── youtube-injector.content/ # MAIN world 注入脚本
│   ├── rules/                    # 站点特定规则
│   │   ├── index.ts              # 规则匹配器
│   │   ├── types.ts              # SiteRule 接口
│   │   ├── github-rules.ts
│   │   ├── reddit-rules.ts
│   │   ├── hackernews-rules.ts
│   │   ├── youtube-rules.ts
│   │   └── fortune-rules.ts
│   ├── components/               # Vue 组件 (FloatingBall 等)
│   ├── styles/                   # 全局样式
│   └── types/                    # 全局类型声明
├── docs/                         # 设计文档和问题分析
├── scripts/                      # 辅助脚本
├── wxt.config.ts                 # WXT 构建配置
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## 3. 架构总览

```
┌─────────────────────────────────────────────────────┐
│                    Browser Tab                       │
│                                                       │
│  ┌──────────────┐     ┌──────────────────────────┐   │
│  │  Popup (Vue) │     │  Content Script          │   │
│  │              │     │                          │   │
│  │  - API Key   │     │  content.ts (入口)       │   │
│  │  - 语言对    │     │    ├── translation.ts    │   │
│  │  - 翻译模式  │     │    ├── chunkTranslation  │   │
│  │  - 文风      │     │    ├── serverTranslation │   │
│  │  - Provider  │     │    └── youtube/          │   │
│  └──────┬───────┘     └────────┬─────────────────┘   │
│         │                       │                     │
│         │  browser.runtime.     │  browser.runtime.   │
│         │  sendMessage()        │  sendMessage()      │
│         │                       │                     │
│  ┌──────▼───────────────────────▼─────────────────┐   │
│  │           Background Script (Service Worker)    │   │
│  │                                                 │   │
│  │  - 消息路由 (translateChunk / validateApiKey)   │   │
│  │  - 缓存查询/写入                                │   │
│  │  - DeepSeekTranslationService                  │   │
│  │  - 站点规则匹配                                 │   │
│  │  - 远程 globalQueue (concurrency=1)             │   │
│  │  - Local Agent 独立队列 (concurrency=4)          │   │
│  └──────────────────┬──────────────────────────────┘   │
│                     │                                  │
└─────────────────────┼─────────────────────────────────┘
                      │
                      ▼
             ┌────────────────────┐
             │   路由选择规则       │
             │ useLocalAgent 优先  │
             └─────────┬──────────┘
                       │
          ┌────────────┼──────────────────┐
          │            │                  │
          ▼            ▼                  ▼
┌────────────────┐ ┌────────────────┐ ┌──────────────────┐
│ 本机 Agent 服务 │ │ Vocal Saga     │ │ DeepSeek API     │
│ 127.0.0.1:8789 │ │ /fanyi/page    │ │ api.deepseek.com │
│ Express + TS   │ │ 远程服务模式    │ │ 直连模式          │
│ Workbuddy/     │ └────────────────┘ └──────────────────┘
│ OpenCode + SQLite│
└────────────────┘

路由原则：useLocalAgent=true 时强制使用本机；失败即返回错误。
不会因为本机服务不可用、HTTP 502 或 JSON 格式错误而尝试远程 Provider。
仅文档批次边界计算可在本机服务不可用时使用扩展内确定性 CPU 算法；
这不是模型调用，也不发送远程请求。
```

## 4. 核心模块详解

### 4.1 Content Script

#### 4.1.1 入口 (`content.ts`)

**职责**: 注入样式、路由消息、SPA 导航检测、YouTube 集成。

**关键设计**:
- 翻译控制器懒加载：首次收到翻译消息才创建 `TranslationController`
- SPA 导航检测：用 `popstate` + 500ms 轮询 `location.pathname + location.search`（不 monkey patch `history.pushState/replaceState`，避免 Claude.com 风控）
- YouTube SPA 导航：监听 `yt-navigate-finish` 事件，切视频时清理字幕和整页翻译状态
- 共享状态 `TranslationState`: `originalTexts`（恢复原文用）、`translatedBlocks`、`translatedTexts`（React 重渲染后恢复译文用）

**消息路由**:
```
translatePage    → ctrl.start() + YouTube 字幕翻译
restoreOriginal  → ctrl.restore() + 停止 YouTube
toggleTranslation → ctrl.toggle()
```

#### 4.1.2 翻译控制器 (`translation.ts`)

**`createTranslationController()`** 返回 `TranslationController` 接口：

| 方法 | 说明 |
|------|------|
| `start()` | 启动整页翻译（防重入：翻译中再次调用直接返回） |
| `restore(silent?)` | 恢复原文，`silent=true` 时不弹状态条（SPA 导航清理用） |
| `toggle()` | 切换译文显示/隐藏 |
| `isTranslated()` | 当前是否处于已翻译状态 |

**`handleFullTranslation()` 主流程**:

开始提取和调用任何 Provider 前，公共网页翻译入口会检查明显的域名停放页（例如标题为 `<domain> - <keyword> Resources and Information`，或正文明确提示域名停放/出售）。命中时直接向用户显示错误并停止；该检查覆盖服务端翻译和扩展直连 Provider，不适用于独立的 EPUB/PDF 文档翻译流程。Vocal Saga 还会在服务端重复校验并阻止这类页面进入翻译缓存。

```
1. 防御性检查 (isPageTranslated)
2. 站点规则匹配 → forceDirectTranslation?
3. [服务端模式] 检查服务端缓存 (GET /fanyi/page/check)
4. prepareDocument(document)
   ├── findArticleRoot() → 选择器 → 评分 → Readability fallback → body 兜底
   ├── hideBodyOverlays() → 隐藏文章外的 modal/cookie banner
   ├── extractBlocks(effectiveRoot) → TreeWalker 遍历 → TextBlock[]
   ├── [0 块时] fallback 到 body 重试
   ├── [仍 0 块时] 从 SPA 数据岛提取
   └── buildChunks(blocks) → Chunk[]
5. buildNodeMap() → 建立 blockId → DOM Node 映射
6. saveOriginalTexts() → 保存原文用于恢复

7a. [服务端模式]
   ├── 缓存命中: applyServerTranslatedHtml(cachedHtml)
   └── 缓存未命中: translateViaServer() → POST /fanyi/page

7b. [本地模式]
   ├── extractGlossary(fullText) → 术语提取
   ├── translateChunksViaBackground()
   │   ├── warmup-then-parallel (前2个串行, 后续并行 4/2)
   │   ├── 每个 chunk: sendMessage → background → DeepSeek API
   │   ├── per-chunk retry: missing blocks 立即重试
   │   └── applyTranslationsWithRAF() → rAF 批量写回 DOM
   └── retryGlobalMissing() → 全局兜底重试

8. markMissingBlocks() → 标记未翻译块
9. setupDynamicContentObserver() → 监听动态内容
10. cleanupTempAttrs() → 清理 data-fanyi-block-id
11. body.dataset.fanyiTranslated = 'true'
```

#### 4.1.3 分块翻译调度 (`chunkTranslation.ts`)

**warmup-then-parallel 策略**:
- 远程 Provider：前 2 个 chunk 串行执行，尝试预热 DeepSeek Prompt Cache；本机 Agent 通过 `skipWarmup=true` 跳过预热，直接并行（桌面 4 / 移动 2）
- 后续 chunk 并行执行（桌面 4 并发，移动 2 并发）
- `TranslationQueue` 支持动态调整并发度

**per-chunk retry**:
- 每个 chunk 翻译返回后立即检查 missing blocks
- missing > 0 时构建 retry chunk（只含缺失块，jsonContent 重新序列化绕过缓存）
- 递归深度限制为 1（retry 的 retry 不再 retry）

**全局兜底重试**:
- 所有 chunk 跑完后，扫描仍未翻译的 blocks
- 重新 buildChunks 并走一遍 translateChunksViaBackground

**DOM 应用**:
- `applyTranslationsWithRAF()`: 用 `requestAnimationFrame` 等下一帧批量应用
- 5s fallback 防止 hidden tab 时 rAF 不触发

#### 4.1.4 服务端翻译 (`serverTranslation.ts`)

**协议**: 见 `docs/fanyi-extension-blocks-protocol.md`

**流程**:
```
1. prepareHtmlForServer()
   ├── clone document.documentElement
   ├── 清理已有双语标记 (.fanyi-original / .fanyi-translation)
   ├── 移除扩展 UI (.fanyi-status-overlay / .fanyi-floating-btn / ...)
   └── 返回 HTML (full > 900KB 时只发 body)

2. [缓存检查] GET /fanyi/page/check?url=...&source=...&target=...
   ├── 200 → 命中缓存，直接 applyServerTranslatedHtml()
   └── 204 → 未缓存，走 POST

3. [翻译] POST /fanyi/page
   Body: { html, url, source, target, mode: 'bilingual', provider, apiKey?, promptStyle }

4. applyServerTranslatedHtml(translatedHtml)
   ├── 移除 <base> 标签 (避免 CSP base-uri 'none' 违例)
   ├── DOMParser.parseFromString()
   └── 遍历 blocks，提取 .fanyi-translation 文本回填到当前 DOM
```

### 4.2 Background Script

**职责**: 消息路由、API 调用、缓存管理。

**消息处理**:

| Action | 说明 |
|--------|------|
| `translateChunk` | 翻译一个 chunk（缓存查询 → API 调用 → 缓存写入 → 返回结果 + trace） |
| `translateChunkStream` | 流式翻译（预留接口，当前未启用） |
| `validateApiKey` | 验证 API Key 有效性 |
| `clearCache` | 清空翻译缓存 |
| `checkConfig` | 检查配置是否就绪 |

**translateChunk 流程**:
```
1. getConfig() → 读取 API Key
2. matchSiteRule(pageUrl) → 站点特定 prompt
3. generateTranslationCacheKey() → 缓存键
4. getCachedTranslation() → 缓存查询
   └── 命中 → 直接返回
5. 根据 Provider 选择对应队列
   ├── 远程 Provider: `globalQueue` (默认 concurrency=1)
   └── Local Agent: `localAgentQueue` (concurrency=4)，不等待远程队列
6. processTranslationResult() → 解析 JSON，提取 translations
   └── 宽松字段匹配: translated_text / text / translation
7. cacheTranslation() → 缓存写入 (TTL=7天)
8. [ChunkTrace] 诊断包 → inputIds / outputIds / missingInResponse
9. sendResponse({ result, trace })
```

`globalQueue = new TranslationQueue(1, 2, 1000)` 只用于远程/DeepSeek Provider；background.ts 为 Local Agent 建立独立的 `TranslationQueue(4, 0, 0)`，避免本机请求被远程队列串行化。
- 远程 globalQueue：默认并发 1，最多重试 2 次，重试间隔 1 秒；
- Local Agent 网页翻译队列：并发 4，不复用上述重试策略。EPUB/PDF project Agent 则在本机服务端独立调度：四槽位且启用审校时默认 2 个翻译 worker + 2 个审校 worker；关闭审校时翻译最多可用 4 个槽位，所有并发按 Session pool 大小约束。

### 4.3 核心工具模块

#### 4.3.1 正文检测 (`contentDetector.ts`)

**三层架构**:

```
Layer 1: ARTICLE_SELECTORS 选择器快速匹配
  ├── .article-body / .post-content / .entry-content / ...
  ├── refineArticleRoot() → 下钻到更具体的容器
  ├── expandWrappers() → 穿透纯包装层
  └── chooseBestRoot() → candidate/parent/grandParent 三层评分

Layer 2: 智能评分 (detectArticleRoot)
  ├── collectCandidates() → 语义标签 + role + class/id token 匹配
  ├── scoreElement() → 密度分 × 结构 × 类名 × 惩罚 × 归一化
  ├── isFragmentedArticleRoot() → 碎片化文章检测
  └── tryReadabilityRoot() → @mozilla/readability fallback

Layer 3: 兜底 → document.body
```

**评分公式**:
```
score = (bodyTextLength / (linkCount + 1)) * log(textLength + 1)
      × structureBoost      (article=1.3, main=1.2, section=1.1)
      × classMultiplier      (positive=1.2, negative=0.5, meta=0.92)
      × containerPenalty     (子元素多但文本少 → 0.85)
      × siblingBoost        (不够突出 → 0.85)
      × depthBoost           (过浅/过深 → 0.9-0.95)
      × globalRatioBoost     (占 body 比例高 → 1.3)
```

**Readability fallback 触发条件**:
- `bestScore < SCORE_THRESHOLD (300)`
- best 占 body 文本比例 < 15%
- `isFragmentedArticleRoot()`: best 是多个同级 section/div 中的一个小节

**碎片化文章检测**:
- best 的父容器有 ≥3 个同级 section/div 且每个文本 > 100 字符
- best 占兄弟总文本比例 < 30%

#### 4.3.2 块提取器 (`blockExtractor/`)

**架构**: TreeWalker 遍历 + 谓词过滤 + 状态机。

**核心流程**:
```
extractBlocks(rootNode)
  ├── 确定 startNode (Document → body, Element → 自身)
  └── collectBlocks(startNode)
      ├── createTreeWalker(SHOW_ELEMENT | SHOW_TEXT)
      ├── acceptWalkerNode() 状态机:
      │   ├── FILTER_REJECT: 跳过自身 + 整棵子树 (入 rejectedCache)
      │   ├── FILTER_SKIP:   跳过自身, 走子树
      │   └── FILTER_ACCEPT:  自身进 grabNode 评估
      ├── grabNode() 评估:
      │   ├── DIRECT_SET (p/h1-h6/li/blockquote/...): 若无子 DIRECT_SET → 返回
      │   ├── INLINE_SET (a/span/em/...): 在 article 内且无块级父 → 返回
      │   └── 其他容器: 只有内联子节点且有直接文本 → 返回
      ├── 可见重复文本分别分配 block ID（保证每个位置都能回填译文）
      └── collectFromShadowHosts() → 遍历 open shadow roots，仅抑制 light-DOM 镜像文本
```

**谓词函数** (`rules.ts`):

| 函数 | 说明 |
|------|------|
| `isOverlayElement` | 弹窗/overlay/cookie banner → 标记 data-fanyi-remove |
| `isNonHTMLNamespace` | 非 HTML 命名空间 (SVG/MathML) → 拒绝 |
| `isElementHidden` | display:none / visibility:hidden → 拒绝 |
| `shouldSkipByClass` | 匹配 SKIP_CLASS_PATTERNS (广告/nav/cookie/...) → 拒绝 |
| `isCookieBannerByText` | 文本含 "cookie"/"privacy"/"consent" → 拒绝 |
| `isPopupByStyle` | position:fixed + 高 zIndex → 拒绝 |
| `isAdBySize` | 300×250 / 728×90 等广告尺寸 → 拒绝 |
| `isMetadataClass` | class 含 author/date/category/tag → 拒绝 (article/main 豁免) |
| `hasContentTokens` | class 含 post/content/article/story → 豁免 metadata 拒绝 |
| `classifyChildren` | 判断子节点是纯内联还是有块级元素 |

**静态数据** (`constants.ts`):

| 集合 | 说明 |
|------|------|
| `DIRECT_SET` | 块级语义元素: h1-h6, p, li, dd, blockquote, figcaption |
| `SKIP_SET` | 永远不翻译: script, style, table, code, pre, input, video, ... |
| `INLINE_SET` | 内联元素: a, span, em, strong, code, ... |
| `SEMANTIC_SKIP_TAGS` | 语义噪声: footer, aside, nav, search, dialog, address |
| `SKIP_CLASS_PATTERNS` | 跳过类名: sidebar, ad-container, cookie-banner, newsletter, ... |

#### 4.3.3 分块构建 (`chunkBuilder.ts`)

**策略**:
- 目标 token 数: 前 2 个 chunk 400 tokens (warmup)，后续 800 tokens
- 结构边界感知: 遇到 h1-h6 时倾向于在此切分
- 最大 token 上限: 500000 (防止单 chunk 过大)
- `estimateTokens(text) = Math.ceil(text.length / 4)`

#### 4.3.4 术语提取 (`glossaryExtractor.ts`)

**输入**: 文章前 4000 字符 + `<em>/<strong>/<code>` 中的强调文本

**输出**: `Glossary { document_terms: string[] }`

**流程**:
1. compromise NLP 解析 → 提取名词短语
2. 与 `TECH_PRODUCTS` 静态表匹配 → 规范化大小写
3. AI 厂商前缀检测 (Claude/GPT/Gemini/Llama/...) → 提取产品名
4. 过滤停用词、泛化名词、短词
5. 排序后输出 (排序固定 → token 序列稳定 → KV cache 命中)

#### 4.3.5 翻译显示 (`translationDisplay.ts`)

**双语对照模式**:
```
<p data-fanyi-block-id="b1" class="fanyi-translated">
  <span class="fanyi-original">Hello World</span>
  <span class="fanyi-translation">你好世界</span>
</p>
```

- `applyBlockTranslation()`: 将现有子节点移入 `.fanyi-original`，追加 `.fanyi-translation`
- `restoreBlock()`: 将 `.fanyi-original` 子节点移回父元素，移除翻译 span
- `toggleBlockTranslation()`: 切换 `.fanyi-translation` 的 `display`

#### 4.3.6 缓存系统 (`cacheManager.ts` + `cacheKey.ts` + `translateApi.ts`)

- L1: `Map<string, CacheEntry>` (内存缓存，即查即用)
- L1: `Map<string, CacheEntry>` (内存缓存，即查即用)
- L2: `@wxt-dev/storage` (持久化到 `local:translationCache`)
- TTL: 7 天

**缓存键**: `translation_{sourceLang}_{targetLang}_{contentHash}_{prefixHash}`
- `simpleHash()`: 非加密哈希，用于快速去重
- contentHash = 全文哈希, prefixHash = 前 200 字符哈希 (防碰撞)

#### 4.3.7 翻译队列 (`translationQueue.ts`)

**`addAllWithWarmup(tasks, warmupCount, maxConcurrency)`** 只在调用方明确采用预热策略时使用：
1. 前 `warmupCount` 个任务串行执行；
2. 后续任务切换到给定并发度；
3. 队列重试策略由该实例的 `maxRetries` / `retryDelay` 决定。

这不是所有 Provider 的全局策略：远程请求当前通过 `globalQueue`（并发 1）调度，本机网页翻译通过独立 4 并发队列调度；EPUB/PDF project Agent 有自己的批次和审校调度器。

### 4.4 LLM 服务层

#### 4.4.1 DeepSeek 客户端 (`service/deepseek.ts`)

**模型**: `deepseek-v4-flash`  
**API**: `https://api.deepseek.com/v1/chat/completions`  
**温度**: 0.1 (低温度保证一致性)  
**响应格式**: `json_object`  
**thinking**: `disabled` (关闭推理链，降低延迟)

**max_tokens 估算**: `max(1024, ceil(inputLength * 0.5 * 8 * 2))`

**System Prompt 设计**:
- 明确源/目标语言 → 减少隐式语言检测
- JSON 输出格式: `{"translations":[{"id":"x","translated_text":"y"}]}`
- 保留 URL/代码/版本号不变
- 自然中文表达：可重组句子、省略重复主语、自然处理"你"/"我"
- 术语表：排序后列出专有名词，要求保留原文

**文风选项**:

| Style | 说明 |
|-------|------|
| `default` | 通用直译 |
| `jinyong` | 金庸武侠风格 |
| `acheng` | 阿城白描风格 |
| `wangxiaobo` | 王小波大白话风格 |

#### 4.4.2 流式解析 (`streamParser.ts`)

解析 SSE (Server-Sent Events) 格式的流式响应，逐 chunk 拼接完整 JSON。

### 4.5 站点规则系统 (`rules/`)

**`SiteRule` 接口**:

| 字段 | 说明 |
|------|------|
| `hostPattern` | 主机匹配模式 (支持 `*.` 通配) |
| `skipSelectors` | 跳过的 CSS 选择器 |
| `skipTextPatterns` | 跳过的文本正则 |
| `promptInstructions` | 站点特定 prompt 指令 |
| `documentTerms` | 文档级专有名词 |
| `articleRootSelector` | 站点特定文章根选择器 |
| `forceDirectTranslation` | 强制本地 DeepSeek 翻译 (跳过服务端) |
| `skipGlossary` | 跳过术语提取 |

**已注册规则**: GitHub, Reddit, HackerNews, Fortune, YouTube

**YouTube 规则特殊**: `forceDirectTranslation=true`, `skipGlossary=true`，使用简化 prompt。

### 4.6 YouTube 字幕翻译 (`content/youtube/`)

**架构**:

```
用户点击翻译按钮
  ├── content.ts handleAction('translate')
  │   ├── ctrl.start() (整页翻译)
  │   └── startYouTubeCaptionTranslation(apiKey)
  │       └── YouTubeCaptionManager.start()
  │           ├── extractVideoId()
  │           ├── fetchCaptions()
  │           │   ├── youtube-injector.content → MAIN world 脚本
  │           │   │   └── movie_player.getPlayerResponse()
  │           │   ├── 从 captionTracks 获取 timedtext URL
  │           │   └── fetch(timedtextUrl) → 字幕时间轴
  │           ├── disableNativeCaptions() (关闭原生字幕)
  │           ├── CaptionOverlay 创建 (中英双语字幕 UI)
  │           └── video.timeupdate → translateAhead()
  │               └── 翻译当前播放位置后 90 秒的字幕
  │                   └── DeepSeek 直接翻译 (跳过服务端)
  │                       └── BATCH_SIZE=20, max_tokens=max(2048, ceil(chars/4)*2)
  │
  └── SPA 切视频 (yt-navigate-finish)
      ├── stopYouTubeCaptionTranslation()
      └── translation.restore() (清理整页翻译)
```

**关键设计**:
- 单例 `YouTubeCaptionManager`: 同一时间只管理一个视频
- 内存缓存: 按 videoId 缓存已翻译字幕，切回同一视频 0 API 调用
- Ahead Buffer: 跟随 `timeupdate`，只翻译当前播放位置后 90 秒
- AbortController: 切视频时立即停止后台翻译
- 全局索引 ID: 用 `indexOf()` O(1) 查找，不用 `Array.indexOf()`
- `variant=gemini` 字幕轨道不支持 `fmt=json3`，需跳过

### 4.7 SPA 导航处理

**问题**: Substack、YouTube 等 SPA 切换页面时 content script 不会重新注入，翻译状态残留导致新页面被误判为"已翻译"。

**方案**:
```
popstate 事件 ──┐
                ├──→ onSpaNavigation()
500ms 轮询 ─────┘    │
                    ├── 比较 pathname + search (忽略 hash)
                    ├── translation.restore(true) (静默清理)
                    ├── stopYouTubeCaptionTranslation()
                    └── updateButtonState(false)
```

**不使用 `history.pushState/replaceState` monkey patch 的原因**: Claude.com 等站点有反篡改检测，会触发 `Failed to fetch` 错误。

### 4.8 动态内容监听

**MutationObserver** (`domObserver.ts`):
- 监听 `childList` + `subtree` + `characterData`
- 500ms debounce
- 新增节点走 `extractBlocksFromNode()` → 单块翻译

**React/Next.js 重渲染恢复** (`reapplyLostTranslations()`):
- 翻译完成后保存 `originalTexts` + `translatedTexts` 映射
- 滚动时 (500ms throttle) 检查已翻译节点是否被清除
- 匹配原文文本 → 重新应用译文

## 5. 配置系统

### 5.1 Config 接口

```typescript
interface Config {
  sourceLang: string;           // 源语言 ('auto' | 'en' | 'zh' | 'ja' | ...)
  targetLang: string;           // 目标语言 ('zh' | 'en' | 'ja' | ...)
  deepseekApiKey: string;       // DeepSeek API Key
  provider: Provider;            // 服务端翻译 LLM Provider
  promptStyle: PromptStyle;     // 翻译文风
  shortcuts: ShortcutConfig;    // 快捷键
  useServerTranslation: boolean; // 是否使用 Vocal Saga 远程服务
  serverUrl: string;             // 远程服务地址
  useLocalAgent: boolean;         // 是否强制走本机 Workbuddy/OpenCode Provider
  localAgentProvider: 'workbuddy' | 'opencode';
  localAgentUrl: string;          // 默认 http://127.0.0.1:8789
  localAgentModel: string;        // auto 或具体模型覆盖
  localAgentToken: string;        // 可选；与服务端 LOCAL_AGENT_TOKEN 一致
}
```

### 5.2 存储

- 使用 `@wxt-dev/storage`，键为 `local:config`
- `setConfig()` 使用 `JSON.parse(JSON.stringify(...))` 剥离 Vue Proxy 包装

### 5.3 配置入口

- **Popup** (`popup/App.vue`): API Key、语言对、文风、远程服务开关、本机 Provider 开关、运行时、模型、服务地址和可选 Token
- **ConfigPanel** (`content/configPanel.ts`): 页面内旧配置面板；本机模式开启时禁用远程翻译选项，保存逻辑也会阻止它把本机流量切回远程
- **本机服务配置**：见 `devweekly/vocal-saga/local-agent-service/README.md`；本机模式不需要 DeepSeek API Key，但如服务端设置了 Token，扩展必须配置同一 Token

## 6. 构建系统

### 6.1 WXT 配置 (`wxt.config.ts`)

- **模块**: `@wxt-dev/module-vue`, `@wxt-dev/webextension-polyfill`
- **输出目录**: `output/`
- **minify**: 关闭（便于 DevTools 调试）
- **Manifest 差异化**: Firefox 使用 `permissions` 合并数组，Chrome 使用 `host_permissions`
- **Build hook**: `fixHtmlPaths` 将绝对路径改为相对路径

### 6.2 命令

```bash
pnpm dev            # Chrome 开发模式 (HMR)
pnpm dev:firefox    # Firefox 开发模式
pnpm build          # 构建 Chrome
pnpm build:firefox  # 构建 Firefox
pnpm zip            # 打包 Chrome
pnpm compile        # 类型检查 (vue-tsc --noEmit)
pnpm test           # 运行测试 (vitest run)
```

## 7. 测试体系

### 7.1 框架

- **Vitest** + **jsdom** 环境
- `--globals` 启用（`describe`/`it`/`expect` 全局可用）

### 7.2 测试文件

| 文件 | 覆盖范围 |
|------|---------|
| `blockExtractor.test.ts` | DOM 块提取规则、真实 HTML fixtures |
| `serverTranslation.test.ts` | 服务端翻译协议、缓存、CSP 兼容 |
| `translationUtils.test.ts` | 状态管理、恢复、SPA 导航 |
| `youtubeCaptions.test.ts` | YouTube 字幕翻译全流程 |
| `chunkRetry.test.ts` | 重试策略 |
| `cacheKey.test.ts` | 缓存键生成 |

### 7.3 测试约定

- 使用 `document.body.innerHTML = ...` 设置 DOM 环境
- `vi.stubGlobal('fetch', ...)` mock 网络请求
- `vi.mock(...)` mock 模块依赖

## 8. 数据流图

### 8.1 直连 DeepSeek API 模式（非本机 Agent 模式）

```
用户点击翻译
    │
    ▼
content.ts: handleAction('translate')
    │
    ▼
translation.ts: ctrl.start()
    │
    ▼
handleFullTranslation()
    │
    ├── prepareDocument()
    │   ├── contentHelper.findArticleRoot()
    │   │   ├── ARTICLE_SELECTORS 快速匹配
    │   │   ├── contentDetector.detectArticleRoot() (评分)
    │   │   └── Readability fallback
    │   ├── hideBodyOverlays()
    │   ├── blockExtractor.extractBlocks()
    │   └── chunkBuilder.buildChunks()
    │
    ├── glossaryExtractor.extractGlossaryLocal()
    │
    ├── chunkTranslation.translateChunksViaBackground()
    │   ├── TranslationQueue.addAllWithWarmup(2, 4)
    │   │   └── 每个 chunk:
    │   │       ├── browser.runtime.sendMessage('translateChunk')
    │   │       │   └── background.ts → DeepSeek API → 缓存 → 返回
    │   │       ├── processTranslationResult() → Map<id, text>
    │   │       ├── applyTranslationsWithRAF() → 写回 DOM
    │   │       └── per-chunk retry (missing blocks)
    │   └── retryGlobalMissing()
    │
    └── setupDynamicContentObserver()
```

### 8.2 本机 Workbuddy/OpenCode Provider 模式（强制本机）

```
用户启动翻译 / YouTube 字幕 / 文档翻译
    │
    ├── 网页分块 → background.ts → POST 127.0.0.1:8789/v1/chat/completions
    ├── YouTube 字幕 → 本机 /v1/chat/completions
    └── EPUB/PDF 文学分析、审校 → 本机 /api/translate/document/literary/*
              │
              ▼
       local-agent-service（Express + TypeScript）
              ├── Workbuddy SDK 或 OpenCode CLI
              ├── request ID + provider/model + 耗时/输出长度 + 错误堆栈日志
              └── SQLite 请求历史、翻译缓存和文档恢复副本

本机请求失败（服务未启动、鉴权失败、运行时错误、模型输出格式错误）→ 显示错误/保留已有初译。
绝不调用 DeepSeek API 或 Vocal Saga 远程服务作为自动兜底。
只有本机批次规划接口的失败才允许用扩展内确定性 CPU 算法继续切分。
```

### 8.3 Vocal Saga 服务端翻译模式

```
用户点击翻译 (useServerTranslation=true)
    │
    ▼
handleFullTranslation()
    │
    ├── checkServerCache() → GET /fanyi/page/check
    │   ├── 200 (命中) → applyServerTranslatedHtml()
    │   └── 204 (未命中) → 继续
    │
    ├── prepareDocument() (同本地模式)
    │
    ├── translateViaServer()
    │   ├── prepareHtmlForServer()
    │   ├── POST /fanyi/page { html, url, provider, ... }
    │   └── applyServerTranslatedHtml()
    │       ├── 移除 <base> 标签
    │       ├── DOMParser.parseFromString()
    │       └── 遍历 blocks → 提取 .fanyi-translation → applyBlockTranslation()
    │
    └── markMissingBlocks()
```

## 9. 关键设计决策

### 9.1 为什么用 block-walking 而不是 Readability

- Readability 返回单一 article 节点，适合 Reader View
- 我们需要逐块翻译整页所有可读文本（包括 nav/sidebar 之外的正文）
- 模型逐块收到独立 context 才能稳定返回 JSON
- 同类翻译扩展 (XTranslate, Read Frog) 都用 block-walking 方案
- Readability 作为 fallback 使用，处理评分算法选不出可靠根节点的场景

### 9.2 为什么不同 Provider 使用不同的调度策略

- 远程 `globalQueue` 当前默认并发 1，是一项实现策略；是否能减少 Prompt Cache 成本取决于供应商的缓存定义、请求前缀、缓存 TTL 与服务端实现，不应把“并行请求一定 miss、串行一定命中”写成普遍事实。
- 网页翻译主流程的 `warmup-then-parallel` 会先串行发出少量 chunk，再将后续任务以桌面 4 / 移动 2 的并发度执行；这是减少首批冷启动成本与提高吞吐的折衷，不意味着后续所有 chunk 都串行。
- Local Agent 网页翻译不使用远程 `globalQueue`，使用独立并发 4 的队列；本机 EPUB/PDF project Agent 在四槽位且启用审校时以默认 2 个翻译 worker + 2 个 Reviewer worker 调度；关闭审校时翻译最多可用 4 个槽位。
- 调整并发前应在目标模型、真实设备和代表性章节上测量完成时间、请求失败率、成本及译文重跑噪声；不能仅凭缓存假设推导性能结论。

### 9.3 为什么不 monkey patch history

- Claude.com 等站点有反篡改检测
- 修改 `history.pushState/replaceState` 会导致页面 fetch 请求失败
- 改用 `popstate` 事件 + 500ms 轮询 `location.pathname + search`

### 9.4 为什么移除浮动按钮

- 用户反馈底部绿色浮动按钮影响阅读
- 翻译仍可通过 popup、快捷键、右键菜单触发

### 9.5 为什么服务端翻译要先检查缓存

- `prepareHtmlForServer()` 需要 clone 整页 DOM，CPU 密集
- 缓存命中时可跳过所有重计算，直接应用译文

## 10. 性能优化

| 优化 | 说明 |
|------|------|
| DeepSeek KV cache | 远程队列默认串行，尝试保持 prompt 前缀稳定；是否命中取决于供应商缓存策略 |
| 双层缓存 | 内存缓存 L1 即查即用，storage L2 持久化 |
| WeakSet rejectedCache | walker 拒绝的元素 O(1) 查表，不回溯父链 |
| rAF 批量应用 | 译文写回 DOM 用 requestAnimationFrame 避免阻塞 |
| 5s rAF fallback | hidden tab 时 rAF 不触发，用 setTimeout 兜底 |
| scoreCache WeakMap | contentHelper 评分缓存，同一元素不重复计算 |
| collapseSpacedText | 后处理合并 CSS letter-spacing 渲染的分散单词 |
| 重复文本映射 | 可见重复文本各自拥有 block ID；只抑制 Shadow DOM 对 light-DOM 的重复镜像 |

## 11. 诊断体系

### 11.1 ChunkTrace

每个 chunk 翻译的全链路追踪：
- `[Background][ChunkTrace] INPUT`: inputBlocks、inputIds、inputBytes、estInputTokens、reservedMaxTokens
- `[Background][ChunkTrace] OUTPUT`: outputBlocks、outputIds、missingInResponse
- `[ContentScript][ChunkTrace]`: chunk 级别的 input/output/missing 对比

### 11.2 SessionSummary

翻译完成后的会话级统计：
```
total=12 fullyOk=10 neededRetry=1(recovered=2,stillMissing=0) hardFailed=1 429-rate-limit=1
```

### 11.3 StreamTrace

流式翻译的诊断（预留）：
- 采样前 3 条译文
- 统计 no-op（译文=原文）数量

## 12. 跨项目同步

fanyi-extension 与 vocal-saga（服务端项目）共享以下模块，修改时需同步：

| 模块 | 同步方向 |
|------|---------|
| `blockExtractor/` | fanyi-extension → vocal-saga |
| `contentDetector.ts` | fanyi-extension → vocal-saga |
| `chunkBuilder.ts` | fanyi-extension → vocal-saga |
| `glossaryExtractor.ts` | fanyi-extension → vocal-saga |

**同步规则**: 修改"完全一致（必须同步）"类模块时，必须同步到 vocal-saga 的 `lib/translate/` 目录。

## 13. 已知限制

1. **表格不翻译**: `<td>/<th>/<caption>` 在 SKIP_SET 中，避免数据表翻译不一致
2. **代码块不翻译**: `<pre>/<code>` 保留原文
3. **表单部分翻译**: `<input>/<textarea>` 跳过，但 `<label>/<option>` 可翻译
4. **多语言页面**: 含 `data-t` 等隐藏多语言文本的页面，textContent 会混合所有语言版本
5. **SPA 数据岛**: 某些 Next.js 站点首屏未 hydrate 时需要从 `__NEXT_DATA__` 提取
6. **流式翻译**: 当前未启用，接口已预留
