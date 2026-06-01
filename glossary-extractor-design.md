# 翻译一致性词典：从「术语识别」到「频率筛选」的重构

## 一、问题起源

fanyi-extension 是一个浏览器翻译插件，在将英文网页翻译为中文时，需要从页面文本中提取一个「术语表」（glossary），随翻译请求一起发送给 LLM，以确保关键术语在全文中被统一翻译。

旧方案的术语提取逻辑基于一个直觉：**大写词 = 专有名词 = 术语**。具体做法是用正则匹配首字母大写或全大写的词，再通过一个黑名单（`COMMON_CAPITALIZED_WORDS`）排除已知的非术语大写词。

这个方案在实践中暴露了三个核心问题：

### 1.1 高频常用词误提取

"Code"、"Prompt"、"Work"、"Time"、"Year" 这些词在技术文章中经常大写出现在句首，被正则捕获后进入术语表。黑名单虽然能堵一部分，但英语常用词太多，堵不胜堵。每发现一个误提取的词就往黑名单加一条，本质上是打地鼠。

### 1.2 多词术语漏提取

"PII scrubbing"、"coordination layer"、"context window" 这类多词短语是技术文章中最需要统一翻译的词汇，但旧方案只能识别单个大写词，无法捕获短语级别的术语。

### 1.3 缩写误判

"DOER"、"VS"、"GET" 等全大写词被正则 `\b[A-Z]{2,6}\b` 捕获，但它们并非技术缩写。黑名单同样需要逐个添加，维护成本高。

## 二、思路转变：从「术语识别」到「翻译一致性词典」

这是本次重构最核心的设计决策。

传统术语提取（terminology extraction）的目标是：**识别文本中的专有名词、技术术语**。这是一个 NLP 难题，需要词性标注、领域知识、甚至外部语料库支持。

但翻译插件的真正需求不是「术语识别」，而是：**哪些词值得在全文中保持统一翻译？**

这个区别至关重要：

| 维度 | 术语识别 | 翻译一致性词典 |
|------|---------|---------------|
| 目标 | 这个词是不是术语？ | 这个词需不需要统一翻译？ |
| "agent" | 是术语 ✓ | 出现 17 次，需要统一 ✓ |
| "code" | 是术语（模糊） | 出现 5 次但太泛，不需要 ✗ |
| "Squad Places" | 是专有名词 ✓ | 出现 6 次，必须统一 ✓ |
| "time" | 不是术语 ✗ | 太泛，不需要统一 ✗ |

CAT 工具（Trados、MemoQ）实际上也是这个思路——它们不关心一个词是不是严格意义上的术语，而关心它是否值得保持统一翻译。

## 三、技术方案：频率统计 + Stopword 过滤

### 3.1 整体流程

```
原始文本
  │
  ├─→ 缩写提取（正则 + 排除表）
  │
  ├─→ 命名实体提取（Compromise #Person/#Organization/#Place）
  │
  └─→ 频繁短语提取（Compromise 名词模式 + 频率统计 + Stopword 过滤）
        │
        ├─ 单词名词：频率 ≥ 3
        └─ 多词短语：频率 ≥ 2
  │
  ├─→ 单复数合并
  │
  ├─→ 子串去重（"agent" 被 "disposable agents" 包含则移除）
  │
  └─→ 按长度降序排列（长术语优先匹配）
```

### 3.2 缩写提取

缩写是最明确的术语信号——全大写、2-6 个字母、几乎总是需要统一翻译。

```typescript
const ACRONYM_PATTERN = /\b[A-Z]{2,6}\b/g;
```

但需要排除非缩写的全大写词。旧方案的黑名单只覆盖了常见大写词，新方案将其精简为仅服务于缩写排除的 `ACRONYM_EXCLUSIONS`，不再承担术语过滤职责。

### 3.3 命名实体提取

Compromise 的命名实体识别（`#Person`、`#Organization`、`#Place`）直接可用，无需频率阈值——人名、组织名、地名几乎总是需要统一翻译。

### 3.4 频繁短语提取（核心）

这是本次重构最关键的部分，替代了旧的 `extractRecurringProperNouns`。

#### 3.4.1 名词短语提取

使用 Compromise 的模式匹配，而非纯正则：

```typescript
const patterns = ['#Noun+', '#Noun #Gerund', '#Noun #Noun #Gerund'];
```

- `#Noun+`：匹配一个或多个连续名词（如 "context window"、"rate limiter"）
- `#Noun #Gerund`：匹配名词+动名词组合（如 "token billing"）
- `#Noun #Noun #Gerund`：匹配双名词+动名词组合（如 "PII data scrubbing"）

为什么需要 `#Noun #Gerund`？因为 Compromise 对 "billing" 这类词的词性标注不稳定——有时标为 Noun，有时标为 Gerund/Verb。如果只用 `#Noun+`，"token billing" 只在 Compromise 恰好将 "billing" 标为 Noun 时才能被匹配到，导致频率统计不准确。补充 `#Noun #Gerund` 模式后，无论 Compromise 怎么标注 "billing"，都能被捕获。

#### 3.4.2 Stopword 过滤

Stopword 列表包含约 200 个词，分为三类：

1. **功能词**（the, a, an, is, are, of, in...）：语法功能词，无实质语义
2. **高频动词**（get, make, go, come, take...）：动作词，不构成术语核心
3. **高频普通名词**（time, year, people, code, work...）：太泛，不值得统一翻译

过滤规则：

```typescript
// 规则 1：短语必须包含至少一个非 stopword
if (!hasSubstantiveWord(words)) continue;

// 规则 2：短语不能以 stopword 开头
if (isStopword(words[0])) continue;
```

规则 1 过滤 "The way"（全由 stopword 组成），规则 2 过滤 "The interesting"（以 stopword 开头的噪声短语）。

为什么要把高频普通名词（如 time, year, people, code）放入 stopword？因为这些词虽然被 Compromise 标为名词，但它们太泛了——"time" 在不同上下文中可能翻译为"时间"、"时期"、"次数"，强行统一反而降低翻译质量。

#### 3.4.3 频率阈值

```typescript
const isSingleWord = !key.includes(' ');
if (isSingleWord && count < 3) continue;  // 单词名词需要出现 ≥3 次
if (!isSingleWord && count < 2) continue;  // 多词短语只需出现 ≥2 次
```

为什么单词和多词的阈值不同？

- **单词名词**（如 "governance"、"memory"）太泛，单独出现一两次不足以证明它需要统一翻译。出现 3 次以上说明作者在反复讨论这个概念。
- **多词短语**（如 "context window"、"PII scrubbing"）本身就是更精确的语义单元，出现 2 次就值得统一。

#### 3.4.4 单复数合并

```typescript
const singular = key.replace(/s$/, '');
if (singular !== key && phraseCounts.has(singular)) {
  totalCount += phraseCounts.get(singular)!;
  processed.add(singular);
}
```

"agent" 出现 6 次，"agents" 出现 11 次，合并为 17 次。不引入词形还原（lemmatization）库，只用最简单的 `-s` 规则处理最常见的英语复数形式。这在实践中覆盖了绝大多数情况，同时保持了零依赖。

### 3.5 子串去重

```typescript
function isSubsumedByLonger(term: string, allTerms: string[]): boolean {
  for (const other of allTerms) {
    if (other !== term && other.includes(term) && other.length > term.length) {
      return true;
    }
  }
  return false;
}
```

如果术语表中同时有 "agent" 和 "disposable agents"，移除 "agent"——因为 "disposable agents" 已经包含了 "agent" 的语义，且更精确。这避免了术语表中出现大量冗余的短术语。

### 3.6 长度降序排列

```typescript
result.sort((a, b) => b.term.length - a.term.length);
```

长术语排在前面，确保 LLM 优先匹配更精确的短语。例如 "Squad Places" 排在 "Squad" 前面，避免 "Squad Places" 中的 "Squad" 被单独替换。

## 四、效果对比

以一篇关于 "Squad Places" 的技术文章为测试用例：

### 旧方案输出（18 个术语）

```
API, CI, Code, DOER, Git, PII, Prompt, SDK, Squad, TUI, UX, Work, YAML
+ 命名实体: Brady, Dina Berry, TUI squad, third agent, Squad
```

问题：Code、Prompt、Work、DOER 是误提取；PII scrubbing、coordination layer 等多词术语完全遗漏。

### 新方案输出（26 个术语）

```
缩写: API, CI, PII, SDK, TUI, UX, YAML
命名实体: Brady, Dina Berry, TUI squad, third agent, Squad
频繁短语: Squad Places, PII scrubbing, coordination layer, coordination mechanism,
          UX suggestions, Git, agents, governance, memory, prompt, squads
```

改进：
- ✅ 消除了 Code、Work、DOER 等误提取
- ✅ 捕获了 PII scrubbing、coordination layer 等多词术语
- ✅ agent/agents 合并计数，频率更准确
- ✅ things 等泛词被 stopword 过滤

## 五、设计权衡

### 5.1 为什么不用 TF-IDF？

TF-IDF 需要一个「文档集合」作为背景语料来计算 IDF（逆文档频率）。浏览器插件只能拿到当前页面的文本，没有外部语料库。纯 TF（词频）在单文档场景下退化为频率统计，而我们的 stopword 列表本质上就是一个人工编码的「高 IDF 词表」——它标记了那些在所有文档中都高频出现的词，相当于 IDF 的简化替代。

### 5.2 为什么不用 N-gram 正则？

早期版本用 bigram/trigram 正则提取 2-3 词短语，但产生了大量噪声："memory is"、"Agents are"、"Git is" 这类包含动词/系动词的短语不是名词短语，不应进入术语表。

最终选择完全依赖 Compromise 的词性标注，用 `#Noun+`、`#Noun #Gerund` 等模式匹配，确保提取的短语至少在语法结构上是名词短语。

### 5.3 为什么不引入词形还原库？

英语的词形还原（lemmatization）需要词典支持，典型库如 `natural`、`lemmatizer` 体积较大。浏览器插件对包体积敏感。简单的 `-s` 去复数规则覆盖了最常见的情况（agent/agents, squad/squads），对于不规则复数（mouse/mice）和不变化复数（sheep/sheep），接受它们作为独立条目——频率阈值会自然过滤掉低频的不规则形式。

### 5.4 为什么 Stopword 包含普通名词？

传统 stopword 列表只包含功能词（the, is, of...）。但我们的目标不是「去除无意义词」，而是「过滤不值得统一翻译的词」。"time"、"code"、"work" 这些词虽然有意义，但在翻译场景中太泛——它们的翻译取决于上下文，强行统一反而有害。将它们加入 stopword 是一种领域特定的设计决策。

## 六、性能特征

- **零 API 调用**：全部在浏览器本地计算，不消耗 LLM token
- **耗时 <100ms**：Compromise 的 NLP 处理在典型网页文本（数千词）上耗时约 50-80ms
- **零额外依赖**：Compromise 已是项目依赖，stopword 列表为硬编码常量
- **包体积影响**：stopword 列表约 2KB，相比删除的旧黑名单代码，净增约 1KB

## 七、局限与未来方向

1. **跨语言支持**：当前 stopword 和名词模式仅适用于英语
2. **领域自适应**：stopword 列表是静态的，无法根据文章领域动态调整（如医学文章中 "patient" 应该是术语）
3. **短语边界**：Compromise 的 `#Noun+` 可能过度匹配（如 "memory governance coordination" 被视为一个短语），频率阈值部分缓解了这个问题
4. **词性标注准确性**：依赖 Compromise 的词性标注，对边缘用例（如 "billing" 的 Noun/Gerund 歧义）需要补充模式

---

*本文档记录了 fanyi-extension v0.62.1 中 `glossaryExtractor.ts` 的重构设计。核心代码位于 `src/entrypoints/utils/glossaryExtractor.ts`。*
