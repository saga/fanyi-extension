# 🌐 Fanyi Extension

浏览器翻译插件 - 支持 Chrome, Firefox, Android Firefox

基于 DeepSeek LLM 的文档级翻译，采用完整的上下文理解，提供高质量的翻译体验。

## ✨ 核心功能

- **全文翻译** - 文档级翻译，保持上下文连贯
- **双语对照** - 不破坏原页面布局、链接和格式
- **站点定制规则** - 针对不同网站优化翻译策略
- **流式响应** - 边译边显，无需等待整段完成
- **术语表提取** - 自动识别专有名词，全文统一译法
- **DeepSeek LLM 引擎** - 高质量 AI 翻译
- **本地缓存** - 7 天 TTL，避免重复请求
- **选区翻译** - 选中任意文本即时翻译

## 📦 安装

### Chrome
1. 打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `output/chrome-mv3/` 目录

### Firefox
1. 打开 `about:debugging#/runtime/this-firefox`
2. 点击"临时载入附加组件"
3. 选择 `output/firefox-mv2/manifest.json`

### Android Firefox
1. 安装 Firefox Nightly 或 Firefox Beta
2. 在 `about:config` 中启用 `xpinstall.signatures.required` 为 `false`
3. 通过 `about:debugging` 侧载扩展

## ⚙️ 配置

1. 点击扩展图标打开设置
2. 填入你的 DeepSeek API Key
3. 设置源语言和目标语言
4. 选择翻译模式（双语对照 / 仅译文）

## 🎮 快捷键

| 操作 | 快捷键 |
|------|--------|
| 翻译页面 | `Alt+T` |
| 恢复原文 | `Alt+R` |
| 切换译文显示 | `Alt+V` |

> Firefox 不识别 `commands` —— 快捷键需通过 `about:addons` 页面配置。

## 📐 站点定制规则 (Site Rules)

插件支持针对不同网站定制翻译规则，确保特定术语、UI 标签、品牌名称等不被错误翻译。

### 规则目录结构

```
src/rules/
├── types.ts              # 规则类型定义
├── index.ts              # 规则注册中心
├── github-rules.ts       # GitHub 站点规则
├── reddit-rules.ts       # Reddit 站点规则
├── hackernews-rules.ts   # Hacker News 站点规则
└── fortune-rules.ts      # Fortune 站点规则
```

### 添加自定义规则

创建新的规则文件，例如 `src/rules/stackoverflow-rules.ts`：

```ts
import type { SiteRule } from './types';

export const stackoverflowRule: SiteRule = {
  hostPattern: 'stackoverflow.com',
  skipTerms: [
    'Question',
    'Answers',
    'Tags',
    'Votes',
    'Accepted',
    'Reputation',
    'Badge',
  ],
  skipSelectors: [
    '.vote',
    '.badge',
    'code',
    'pre',
  ],
  promptInstructions:
    'This is Stack Overflow. Keep programming terminology, code snippets, and technical terms untranslated.',
};
```

然后在 `src/rules/index.ts` 中注册：

```ts
import { stackoverflowRule } from './stackoverflow-rules';

const RULES: SiteRule[] = [
  // ...existing rules
  stackoverflowRule,
];
```

### 规则字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `hostPattern` | `string` | 域名匹配，支持 `*.example.com` 通配符 |
| `skipTerms` | `string[]` | 不翻译的词汇列表 |
| `skipSelectors` | `string[]` | 完全跳过的 CSS 选择器 |
| `promptInstructions` | `string` | 额外的 prompt 指令 |

### 最终 Prompt 组成

翻译时发送给 LLM 的 prompt 由以下部分组合而成：

```
┌─────────────────────────────────────────────────────┐
│  System Prompt (基础翻译指令)                         │
├─────────────────────────────────────────────────────┤
│  Professional translator. Translate blocks to       │
│  Simplified Chinese.                                │
│                                                     │
│  Rules:                                             │
│  - Keep IDs unchanged                               │
│  - Consistent terminology                           │
│  - Natural translation                              │
│  - No omissions                                     │
│  - Return JSON only                                 │
├─────────────────────────────────────────────────────┤
│  Site-specific rules (站点定制规则，动态注入)          │
├─────────────────────────────────────────────────────┤
│  Do NOT translate the following terms, keep as-is:  │
│  Releases, Packages, license, MIT, README, ...      │
│                                                     │
│  This is a GitHub page. Keep UI navigation terms,   │
│  file extensions, and code-related vocabulary       │
│  untranslated. Preserve brand names and technical   │
│  terms.                                             │
├─────────────────────────────────────────────────────┤
│  Glossary (术语表，前置抽取的专有名词对照)             │
├─────────────────────────────────────────────────────┤
│  Use these term mappings consistently:              │
│  "API" → "接口"                                     │
│  "Repository" → "仓库"                              │
├─────────────────────────────────────────────────────┤
│  User Message (待翻译内容)                           │
├─────────────────────────────────────────────────────┤
│  Translate and return JSON:                         │
│  [{"id":"b1","text":"Hello World"}]                 │
└─────────────────────────────────────────────────────┘
```

**Prompt 构建流程：**

1. **基础系统提示** - 固定的翻译规则和输出格式要求
2. **站点规则注入** - 根据当前页面 URL 匹配对应规则，将 `skipTerms` 和 `promptInstructions` 追加到 system prompt
3. **术语表注入** - 前置调用 LLM 抽取专有名词及其译法，注入到 prompt 保证全文一致
4. **用户消息** - 待翻译的文本块 JSON

无匹配站点规则时，仅使用基础系统提示和术语表。

## 🏗️ 技术架构

### 流水线

```
网页 DOM
  ↓ (blockExtractor: TreeWalker 提取文本块)
TextBlock[]
  ↓ (chunkBuilder: 块按大小/数量分批)
Chunk[]
  ↓ (background.ts: 全局队列调度，逐 chunk 调用 DeepSeek)
DeepSeekTranslationService
  ├─ 串行流式接口 (translateStream, AsyncGenerator)
  └─ 非流式接口 (translate, 配 cache)
  ↓ (translationDisplay: 包成 <span> 而非清空 DOM)
原文 <span class="fanyi-original"> + 译文 <span class="fanyi-translation">
  ↓ (DOMObserver: 监听新增节点增量翻译)
持续翻译
```

### 目录结构

```
src/
├── __tests__/                  # 全部单元测试 (vitest, jsdom)
│   ├── background.test.ts            # background.ts 处理器
│   ├── background-stream.test.ts     # 流式翻译处理器
│   ├── deepseek.test.ts              # glossary 过滤逻辑
│   ├── deepseek-api.test.ts          # translate / extractGlossary / callApi
│   ├── deepseek-stream.test.ts       # translateStream
│   ├── streamParser.test.ts          # SSE 行解析
│   ├── translationDisplay.test.ts    # DOM 包装/还原 (含链接保留)
│   ├── blockExtractor.test.ts        # DOM 块提取
│   ├── chunkBuilder.test.ts          # 分块策略
│   ├── contentHelper.test.ts
│   ├── domObserver.test.ts
│   ├── glossaryExtractor.test.ts
│   ├── translateApi.test.ts
│   ├── translationQueue.test.ts
│   ├── cacheKey.test.ts
│   ├── cacheManager.test.ts
│   ├── config.test.ts
│   ├── common.test.ts
│   ├── constant.test.ts
│   └── constants.test.ts
│
├── components/                 # Vue 3 组件
│   ├── FloatingBall.vue              # 悬浮操作球
│   ├── SelectionTranslator.vue       # 选区翻译浮窗
│   └── TranslationStatus.vue         # 翻译状态指示
│
├── entrypoints/                # WXT 入口 (打包根目录)
│   ├── background.ts                 # 后台：消息路由、缓存、API 调度
│   ├── content.ts                    # 内容脚本：DOM 提取、应用翻译
│   ├── popup/                        # 配置 UI
│   │   ├── App.vue
│   │   ├── index.html
│   │   └── main.ts
│   ├── service/                      # DeepSeek 客户端
│   │   ├── deepseek.ts                     # DeepSeekTranslationService
│   │   ├── streamParser.ts                 # SSE 解析 (parseSSELine / parseSSEStream)
│   │   └── _service.ts                     # 类型定义
│   └── utils/                        # 工具层
│       ├── blockExtractor.ts               # TreeWalker 提取 TextBlock
│       ├── chunkBuilder.ts                 # 分块策略
│       ├── translationDisplay.ts           # DOM 包装/还原 (保留链接/格式)
│       ├── domObserver.ts                  # 增量 DOM 观察
│       ├── glossaryExtractor.ts            # 术语表抽取 (compromise NLP)
│       ├── translateApi.ts                 # 缓存 + 翻译结果处理
│       ├── translationQueue.ts             # 全局串行队列
│       ├── cacheKey.ts                     # 简单 hash cache key
│       ├── cacheManager.ts                 # @wxt-dev/storage 缓存实例
│       ├── contentHelper.ts                # DOM 准备
│       ├── config.ts                       # @wxt-dev/storage 配置
│       ├── common.ts                       # 通用工具
│       ├── constant.ts
│       └── constants.ts                    # GESTURES 等常量
│
├── rules/                      # 站点定制规则
│   ├── types.ts
│   ├── index.ts
│   ├── github-rules.ts
│   ├── reddit-rules.ts
│   ├── hackernews-rules.ts
│   └── fortune-rules.ts
│
├── public/                     # 静态资源 (图标等)
└── styles/
    └── theme.css
```

### 关键模块说明

| 模块 | 职责 |
|------|------|
| `entrypoints/background.ts` | 后台消息路由、API key 校验、缓存管理、全局翻译队列调度 |
| `entrypoints/content.ts` | 内容脚本：注入页面、提取 DOM 块、应用/还原翻译、监听 DOM 变化 |
| `entrypoints/service/deepseek.ts` | DeepSeek API 客户端（流式 + 非流式 + 术语表抽取） |
| `entrypoints/service/streamParser.ts` | SSE 协议逐行解析，跨 `read()` 分片累积 |
| `entrypoints/utils/translationDisplay.ts` | 把翻译结果以 `<span class="fanyi-original">/fanyi-translation` 包裹原元素，**不修改原 DOM 子节点**，链接、`<strong>`、`<code>` 等内联元素完整保留 |
| `entrypoints/utils/blockExtractor.ts` | `TreeWalker` 遍历 DOM 提取 `TextBlock` |
| `entrypoints/utils/chunkBuilder.ts` | 文本块按字符数上限分批 |
| `entrypoints/utils/domObserver.ts` | `MutationObserver` 增量翻译新出现节点 |
| `entrypoints/utils/glossaryExtractor.ts` | 调用 LLM 抽取专有名词 + 译法 |
| `entrypoints/utils/translationQueue.ts` | 全局串行队列，避免并发请求冲突 |
| `entrypoints/utils/cacheManager.ts` | `@wxt-dev/storage` 缓存（7 天 TTL，简单 hash key） |
| `entrypoints/utils/config.ts` | `@wxt-dev/storage` 持久化配置 |

### 翻译模式

- **bilingual**（双语对照）：在原元素下追加 `.fanyi-translation` span，原文继续可见。
- **target**（仅译文）：原元素下追加 `.fanyi-original` span（`display:none`）+ `.fanyi-translation` span。

两种模式都通过 `translationDisplay.ts` 实现，**不破坏原 DOM 子节点**，原文中的 `<a>`、`<strong>`、`<code>`、`<img>` 等内联元素保持原状和可交互。

### 多浏览器兼容

| 浏览器 | Manifest | 快捷键 | 备注 |
|--------|----------|--------|------|
| Chrome | v3 | 浏览器层 `Alt+T/R/V` | 完整功能 |
| Firefox (桌面) | v2 | 需在 `about:addons` 配置 | 无 `contextMenus` API |
| Firefox (Android) | v2 | 触屏手势 | 触屏优先 |

构建钩子（`wxt.config.ts:63`）会重写 HTML 中的绝对资源路径为相对路径，跨 target 兼容。

## 📝 开发

### 命令

```bash
pnpm install         # 触发 wxt prepare，生成 .wxt/ 类型
pnpm compile         # vue-tsc --noEmit —— 提交前必跑
pnpm test            # vitest run (jsdom)
pnpm test:watch      # 监听模式
pnpm dev             # Chrome 开发模式 (HMR)
pnpm dev:firefox     # Firefox 开发模式
pnpm build           # 构建 Chrome (含 prebuild 类型检查)
pnpm build:firefox   # 构建 Firefox
pnpm zip             # 打包 Chrome 为 .zip
pnpm zip:firefox     # 打包 Firefox 为 .zip
```

`pnpm compile` 必须通过后再 `pnpm build`。

### 测试

- 框架: Vitest + jsdom 环境
- 文件: 20 个测试文件，集中在 [`src/__tests__/`](file:///Users/saga/code-repos/fanyi-extension/src/__tests__/)
- 运行: `pnpm test` (单次) / `pnpm test:watch` (监听)
- 注意: 拉到新代码后若 `.wxt/` 过期，先 `pnpm install` 触发 `wxt prepare` 再测试

### 调试 / Gotchas

- **不要在 `entrypoints/` 下放 `.test.ts`** —— WXT 用 `picomatch` 扫描 entrypoint，basename 冲突会直接 build 失败。所有测试在 `src/__tests__/`。
- **不要手动设置 `TreeWalker.currentNode`** —— 真实 Chrome/Firefox 与 jsdom 行为不同（见 `blockExtractor.ts` 注释）。
- **配置写入**：Vue refs 是 Proxy 代理，写入 `@wxt-dev/storage` 时用 `JSON.parse(JSON.stringify(...))` 剥离 Proxy。
- **Cache key**：非加密 hash，仅用于去重；TTL 7 天。
- **Chunk 调度**：队列串行处理，desktop 间隔 100ms，mobile 间隔 200ms。
- **Popup UI**：`Element Plus` + 自定义 `theme.css`。

### 添加新站点规则

1. 在 [`src/rules/`](file:///Users/saga/code-repos/fanyi-extension/src/rules/) 下新建 `xxx-rules.ts`，导出 `SiteRule`。
2. 在 [`src/rules/index.ts`](file:///Users/saga/code-repos/fanyi-extension/src/rules/index.ts) 的 `RULES` 数组中注册。
3. 运行 `pnpm compile` 验证类型，`pnpm test` 验证现有测试仍通过。

## 📄 License

ISC
