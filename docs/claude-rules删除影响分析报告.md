# claude-rules.ts 删除后已知影响分析报告

## 背景

按 `修改.md` 的 Scoring Pipeline 架构重构后，已删除 `claude-rules.ts`（fanyi-extension + vocal-saga）。claude.com 现在完全靠 `chooseBestRoot` 评分自动选 `main.page_main` 作根节点。

删除前 `claudeRule` 提供三个能力：
1. `articleRootSelector: 'main.page_main'` → 根节点选择（**已由 scoring pipeline 替代，无影响**）
2. `skipSelectors: ['.blog_related_section_wrap']` → 过滤相关文章
3. `documentTerms`/`promptInstructions` → 术语保留（Claude/Opus/Sonnet/Haiku/Anthropic/API/LLM）

## 影响 1：相关文章会被翻译？

### 结论：**不存在该问题**（误报）

### 证据

TreeWalker 的通用过滤规则已覆盖。`blockExtractor/rules.ts:497`：

```typescript
{ classPattern: /share|social|comment|related|recommend|sidebar/i },
{ idPattern: /share|social|comment|related|recommend|sidebar/i },
```

claude.com 相关文章 section 的 class 是 `blog_related_section_wrap`，包含 `related` token，会被该正则匹配，**整棵子树被 TreeWalker 拒绝**，不会进入翻译 chunk。

`claudeRule.skipSelectors` 之前是冗余的——通用规则已经能过滤。

### 验证方式

在 claude.com 翻译后，检查 chunk 列表是否包含 "Related posts" / 相关文章标题。预期：不包含。

---

## 影响 2：术语 Claude/Opus/Sonnet/Haiku 不再强制保留

### 结论：**部分存在**

### 术语处理当前流程

1. `background.ts:152/305` 调用 `buildSitePrompt(matchedRule.siteRule)` 生成站点 prompt
2. 无 site rule 时，`sitePrompt = ''`（不注入 `document_terms`）
3. 但 `glossaryExtractor.ts:extractGlossaryLocal()` 会**自动从全文提取**术语注入 glossary
4. `deepseek.ts:71/205` 把 `glossary.document_terms` 注入翻译 prompt

### 自动提取能力分析

| 术语 | 能否自动提取 | 来源 |
|------|------------|------|
| API | ✅ 是 | `extractAcronyms`（全大写缩写，`ACRONYM_PATTERN`） |
| LLM | ✅ 是 | `extractAcronyms` |
| Anthropic | ⚠️ 部分 | `KNOWN_BRANDS_AT_SENTENCE_START`（glossaryExtractor.ts:705）仅用于句首大写检测，**不注入 document_terms** |
| Claude | ⚠️ 部分 | 同上（glossaryExtractor.ts:709） |
| Opus | ❌ 否 | 不在任何列表 |
| Sonnet | ❌ 否 | 不在任何列表 |
| Haiku | ❌ 否 | 不在任何列表 |

`tech-products.json`（TECH_PRODUCTS 数据集）**不包含** Opus/Sonnet/Haiku/Anthropic/Claude（已 grep 确认）。

### 实际风险

- **API/LLM**：自动提取，无风险
- **Claude/Anthropic**：DeepSeek 默认通常保留知名品牌名，但不保证（尤其句中位置）
- **Opus/Sonnet/Haiku**：作为普通词可能被翻译（Opus→作品/巨著，Sonnet→十四行诗，Haiku→俳句）。这是真实风险——在 Claude 博客里这些是模型代号，不是原义

### 解决方向（供接手 AI 参考）

**方向 A：扩展 `tech-products.json`**
- 文件：`src/entrypoints/utils/tech-products.json`
- 在 `products` 数组加入 `"Opus"`, `"Sonnet"`, `"Haiku"`, `"Anthropic"`, `"Claude"`
- `extractGlossaryLocal` 的 TECH_PRODUCTS 匹配逻辑（glossaryExtractor.ts:531-548）会自动注入
- **优点**：通用方案，所有站点受益
- **缺点**：可能误伤（如诗歌网站讨论 sonnet/haiku 原义）——但这些是常见英文词，需评估

**方向 B：在 KNOWN_BRANDS_AT_SENTENCE_START 之外新增"强制保留词表"**
- 文件：`src/entrypoints/utils/glossaryExtractor.ts`
- 新增一个 `ALWAYS_KEEP_TERMS` 集合，在 `extractGlossaryLocal` 末尾强制加入 `termSet`
- **优点**：精准控制
- **缺点**：硬编码词表维护成本

**方向 C：恢复一个最小 claudeRule（仅术语，无 articleRootSelector/skipSelectors）**
- 文件：`src/rules/claude-rules.ts`（重新创建）
- 只保留 `documentTerms` 和 `promptInstructions`
- **优点**：精准、与修改.md 不冲突（修改.md 只要求根节点选择不用 rule）
- **缺点**：用户明确要求删除 claude-rules，需确认是否接受

---

## 接手约束

1. **不要发散**：仅解决影响 2（术语保留），不要重构其他部分
2. **跨项目同步**：fanyi-extension (`src/`) 和 vocal-saga (`lib/translate/`) 的 `glossaryExtractor.ts` / `tech-products.json` / `rules/` 必须保持逻辑一致（见 `CROSS_PROJECT_SYNC.md`）
3. **验证**：`pnpm test`（fanyi-extension 657 tests + vocal-saga 813 tests）必须全过；`pnpm build` 必须成功
4. **不要重新引入 `articleRootSelector`**：根节点选择已由 scoring pipeline 接管，这是修改.md 的核心要求

## 关键文件清单

| 文件 | 作用 |
|------|------|
| `src/entrypoints/utils/glossaryExtractor.ts` | 术语自动提取，`extractGlossaryLocal` 入口在 L514 |
| `src/entrypoints/utils/tech-products.json` | TECH_PRODUCTS 数据集（缺 Opus/Sonnet/Haiku） |
| `src/entrypoints/utils/blockExtractor/rules.ts` | TreeWalker 过滤规则，L497 含 `related` 正则 |
| `src/entrypoints/utils/contentHelper.ts` | scoring pipeline（`chooseBestRoot` L273，已含 h1 守卫） |
| `src/rules/index.ts` | `buildSitePrompt`（L40），无 rule 时返回空串 |
| `src/entrypoints/background.ts` | L152/L305 调用 `buildSitePrompt` |
| `src/entrypoints/service/deepseek.ts` | L71/L205 注入 `glossary.document_terms` |
| vocal-saga 对应文件 | `lib/translate/glossaryExtractor.ts` / `lib/translate/rules/` 等 |

## 当前状态

- fanyi-extension: 657 tests passed, build 成功
- vocal-saga: 813 tests passed
- `claude-rules.ts` 已从两个项目删除
- `output/chrome-mv3/` 已构建就绪
- scoring pipeline（expandWrappers + scoreArticleContainer + chooseBestRoot）已在两个项目同步
