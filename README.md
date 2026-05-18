# 🌐 Fanyi Extension

浏览器翻译插件 - 支持 Chrome, Firefox, Android Firefox

基于 DeepSeek LLM 的文档级翻译，采用完整的上下文理解，提供高质量的翻译体验。

## ✨ 核心功能

- **全文翻译** - 文档级翻译，保持上下文连贯
- **双语对照** - 不破坏原页面布局
- **站点定制规则** - 针对不同网站优化翻译策略
- **DeepSeek LLM 引擎** - 高质量 AI 翻译

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

## 📐 站点定制规则 (Site Rules)

插件支持针对不同网站定制翻译规则，确保特定术语、UI 标签、品牌名称等不被错误翻译。

### 规则目录结构

```
src/rules/
├── types.ts              # 规则类型定义
├── index.ts              # 规则注册中心
├── github-rules.ts       # GitHub 站点规则
├── reddit-rules.ts       # Reddit 站点规则
└── hackernews-rules.ts   # Hacker News 站点规则
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
│  User Message (待翻译内容)                           │
├─────────────────────────────────────────────────────┤
│  Translate and return JSON:                         │
│  [{"id":"b1","text":"Hello World"}]                 │
└─────────────────────────────────────────────────────┘
```

**Prompt 构建流程：**

1. **基础系统提示** - 固定的翻译规则和输出格式要求
2. **站点规则注入** - 根据当前页面 URL 匹配对应规则，将 `skipTerms` 和 `promptInstructions` 追加到 system prompt
3. **用户消息** - 待翻译的文本块 JSON

无匹配站点规则时，仅使用基础系统提示。

## 🏗️ 技术架构

```
网页 DOM → Block 抽取 → Chunk 构建 → Background 翻译 → DOM 渲染 → 双语显示
```

- **框架**: WXT + Vue 3 + TypeScript
- **翻译引擎**: DeepSeek LLM
- **存储**: @wxt-dev/storage
- **多浏览器**: Chrome / Firefox / Android Firefox

## 📝 开发

```bash
pnpm install
pnpm dev          # Chrome 开发模式
pnpm dev:firefox  # Firefox 开发模式
pnpm build        # 构建
pnpm test         # 运行测试
```

## 📄 License

ISC
