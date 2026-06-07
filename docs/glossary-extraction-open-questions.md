# Glossary 抽取 — 8 个未决问题

> 日期: 2026-06-07
> 状态: **等用户决策**（每个问题列出 A/B/C 选项，待勾选）
> 文章: `https://thenewstack.io/confluent-intelligence-ai-agents/`
> 长度: 7291 字符 / 1182 词

---

## 1. 背景

`src/entrypoints/utils/glossaryExtractor.ts` 是浏览器翻译扩展的 glossary 抽取模块。
调用方在每次翻译前会跑 `extractGlossaryLocal(text)`，返回 `{ term, definition? }[]`，
这些词会随翻译请求一起发给 DeepSeek API，保证专有名词、acronym、品牌名翻译一致。

整个抽取管线（按调用顺序）：

1. **`extractAcronyms(fullText)`** — 用 regex 找 `API / eBPF / POSTGRESQL` 这类全大写或
   混合大小写标识符，存到 `glossaryMap`。
2. **`extractNamedEntities(doc)`** — 用 `compromise` 的 `nlp(text)` 找：
   - `doc.acronyms()`（替代原先的 `#Acronym+`，更准）
   - `doc.people()`（人物完整名 + 拆分 token）
   - camelCase 标识符 regex（`GitHub / Apache`）
   - 句中单 cap brand regex（`Kafka / Stripe`，前 1 字符必须小写或标点）
3. **`extractFrequentTerms(doc)`** — 用 `#Noun+` / `#Noun #Gerund` 找 ≥ 3 次（单词）或
   ≥ 2 次（多词短语）的常见词组。

每条进入 `glossaryMap` 后再做 `isPhraseSubsuming` 去重：先按长度排，长词吃掉短词。

测试：458 / 458 ✅（最后一次跑）。

---

## 2. 当前抽取结果（Confluent AI 文章）

22 词 / 142 字符。逐个看：

| # | 词 | 类型 | 评价 |
|---|---|---|---|
| 1 | RBAC | acronym | ✅ 保留 |
| 2 | MCP | acronym | ✅ |
| 3 | PII | acronym | ✅ |
| 4 | SQL | acronym | ✅ |
| 5 | ATM | acronym | ✅ |
| 6 | API | acronym | ✅ |
| 7 | Enterprise AI | 短语 | ⚠️ Q5 |
| 8 | Intelligence | 品牌/产品 | ⚠️ Q1 |
| 9 | Confluent | 品牌 | ✅ |
| 10 | Terraform | 产品 | ✅ |
| 11 | McKinsey | 公司 | ✅ |
| 12 | Falconer | 人名 | ✅ |
| 13 | TimesFM | 产品 | ✅ |
| 14 | AI apps | 短语 | ⚠️ Q4 |
| 15 | London | 地名 | ✅ |
| 16 | Google | 品牌 | ✅ |
| 17 | Stack | 媒体名 | ⚠️ Q2 |
| 18 | Cloud | 服务/产品 | ⚠️（"Confluent Cloud"） |
| 19 | Azure | 平台 | ✅ |
| 20 | Flink | 框架 | ✅ |
| 21 | Sean | 人名 | ✅ |
| 22 | data streaming | 短语 | ✅ 保留（Confluent 核心） |

修过的（之前在结果中现已不在）：
- `customer` → 移到 `COMMON_NOUN_FALSE_POSITIVES`
- `I've` / `Ive` → 加到 `STOPWORDS`（`ive, dont, youre, ...` 缩写残片）
- `security controls`, `stakes industries`, `developer tooling` → `isCommonNoun` 改大小写不敏感 + 扩列表

---

## 3. 应入但没入的词

为了在 Q7/Q8 选 A/B，需要列清楚**漏网之鱼**：

| 词 | 漏掉原因 | 出现次数 |
|---|---|---|
| `agentic AI` | 2 词短语阈值 ≥ 2，但 `agentic` 是 `#Adjective` 不在 `#Noun+` 模式 | 2 |
| `Flink SQL` | `Flink` 已入但 `Flink SQL` 没合并 | 1 |
| `dbt adapter` | `dbt` 出现 1 次没过 ≥ 3 阈值；`adapter` 出现多但单独是泛词 | 1 |
| `agent skills` | `agent` 出现多次但 `skills` 单独是泛词 | 1 |
| `real-time data` | `real-time` 被 hyphen 切分；`data` 单独是 stopword | 2 |
| `Confluent Intelligence` | compromise 没把 `Confluent` 和 `Intelligence` 当连续 `Organization+` 实体 | — |
| `New Stack` | `New` 是 stopword | 1 |
| `Microsoft` | compromise 把 `Microsoft` 漏标为 person | — |

---

## 4. 8 个未决问题

每题格式：现象 → 根因 → A/B/C 选项 → 推荐

### Q1 — `Intelligence` 单字 vs `Confluent Intelligence` 全名

**现象**: 结果里有 `Intelligence` 单字，但 `Confluent Intelligence` 是 Confluent 2026 Q2 发布的产品（文章中出现了 2 次）。

**根因**: `extractNamedEntities` 走的是 single-token-only 限制（保护 dedup），但
`Confluent Intelligence` 没有被 `compromise` 当成 `#Organization+` 整体识别。`singleCapRegex` 只匹单个 token，于是 `Intelligence`（独立产品名）被收录，但**前缀 `Confluent` 不带**。

**选项**:
- **A**（当前）接受 `Intelligence` 单字。
- **B** 加 `isPhraseSubsuming` 后处理：把 `Intelligence` 这种"全 cap 紧跟大写 brand 名"的词合并成 `Confluent Intelligence`。实现：扫描 `glossaryMap` 找连续 `[Brand] [Word]` 模式，word 出现在 ≥2 次且与至少一个 brand 名相邻。
- **C** 改用 compromise 的 `doc.organizations().out('array')`（返回 `#Organization+`），不过它在我们的测试中**只匹到 `Netflix's` 等误标**，不能直接用——除非配合 `cleanTerm` 抹 `'s`。

**推荐**: A（保持简单）。**`Confluent` 已入 glossary，翻译模型应能推断 `Intelligence` = 产品名后缀**。

### Q2 — `Stack`（"The New Stack"）单字 vs `New Stack`

**现象**: `Stack` 在结果里。原文是 "tells The New Stack"，媒体名。

**根因**: `New` 是 stopword，`singleCapRegex` 不匹（要求 `[A-Z][a-z]{2,}`，`New` 只 3 字符但实际是 Title-case 没问题）；但**前面是 "The "** —— `singleCapRegex` 的 lookbehind 是 `(?<=[a-z,;:] )`，句中大写后接小写。`The New Stack` 中 `New` 前是 `The `（句首或前句末）—— `The` 末尾是 `e` 小写 → lookbehind 满足。但 `New` 长度只 3，加上 `STOPWORDS.has('new')` → 拒。`Stack` 前是 `New `，但 `New` 末尾是 `w` 仍是字母 → lookbehind 满足。`Stack` 长度 5 + 不在 STOPWORDS → 入。

**选项**:
- **A**（当前）保留 `Stack`。可接受。
- **B** 拒 `Stack` 单独出现（不与 brand 配对就拒）。但**会误伤** "Stack Overflow" 等。
- **C** 加 `The New Stack` 这种**白名单**。

**推荐**: A。`Stack` 单字有歧义但出现频率高（媒体名），翻译模型能处理。

### Q3 — `Microsoft` 偶尔消失 / `Falconer` 偶尔消失

**现象**: 早些版本的实现靠 `#Organization+` 抓 `Microsoft` 等。这次重写为 `doc.people()`，compromise 标 `Microsoft` 为 `Organization`（不是人），于是**漏**。

**根因**: `compromise` 14.x 的 NER 不可靠。同一个词 `Microsoft` 在不同上下文中可能标 `Organization` / `ProperNoun` / `Person`。

**选项**:
- **A**（当前）只用 `doc.people()`。**接受** `Microsoft` 类漏。
- **B** 加 fallback：`doc.match('#ProperNoun+')` 跑一遍，但**这会带出** `The, How, It` 句首词，需要**句子-首词过滤**。可结合 `doc.sentences()` 拿句首 offset 集合排除。
- **C** 用 compromise 的 `doc.organizations().out('array')`，配合 `cleanTerm` 抹 `'s` 后缀——但 dump-stages 显示它**误把 `"Netflix's"` 当 organization**，**风险高**。

**推荐**: A。**Confluent 文章中 `Microsoft` 出现 1 次**（"Microsoft's private backbone"），不是核心词。`Falconer` 出现多次（人物名）已正确入。**当前权衡 OK**。

### Q4 — `AI apps` 应否保留

**现象**: 结果里有 `AI apps`。"apps" 是泛词。

**根因**: 短语 `AI apps` 出现 ≥ 2 次（"AI apps and agents" 重复），触发 frequent term 阈值。

**选项**:
- **A**（当前）保留。在 Confluent 上下文中 "AI apps" 是相对具体的概念（企业 AI 应用），翻译模型需要知道怎么译。
- **B** 拒：当 phrase 包含 `apps/services/tools/users` 这种**纯泛词尾** → reject。改 `extractFrequentTerms` 加 `BLOCKED_TAIL_NOUNS = ['apps', 'services', 'tools', 'users', 'systems']`。
- **C** 保留但加权重：`AI apps` 是 1 阶词但用得泛，翻译时 `apps` → "应用" 即可，无 glossary 必要。

**推荐**: A。**`AI agents` 也类似**（应入但未入，Q8）—— 既然 `AI agents` 要入，`AI apps` 也该入。**保持一致**。

### Q5 — `Enterprise AI` 应否保留

**现象**: 结果里有 `Enterprise AI`（大写首词 + 短语）。

**根因**: compromise 标 `Enterprise` 为 `#ProperNoun` 因为它在句首；但 singleCapRegex 看的是**整段文本** → `enterprise AI` 出现在句中："For enterprise AI, ..."，**`enterprise` 小写**——**不匹** singleCap。但**结果里有 `Enterprise AI`** 因为 `extractFrequentTerms` 的 `#Noun+` 匹到。**且** `Enterprise AI` 出现 ≥ 3 次。

**选项**:
- **A**（当前）保留。专有产品类概念。
- **B** 拒：phrase 首词是 `Enterprise`（"enterprise-grade software" 这种泛词）。但**会误伤** "Enterprise Security" 等。

**推荐**: A。`Enterprise AI` 在 Confluent 文章中是核心概念，**保留**对翻译质量有帮助。

### Q6 — `data streaming` 应否保留

**结论**: ✅ **保留**（当前已实现）。`data streaming` 是 Confluent 核心定位（"the secure foundation for AI apps and agents = real-time data streaming"），是高频短语（≥ 3 次）。`data` 是常见 stopword 不在 `#Noun+` 模式里，**意外地**这个 phrase 没被错误截断。

**无需决策**。

### Q7 — 小写产品名（`dbt`）漏掉

**现象**: 文章中 `dbt adapter` 出现 1 次，`dbt` 没被抽出。`TimesFM` 抽到了（混大小写 `TimesFM` 匹 `[A-Z][a-z]+[A-Z]`）。

**根因**: `dbt` 全小写，无 cap → 匹不到任何 regex。`extractFrequentTerms` 阈值 ≥ 3 也不够。

**选项**:
- **A**（当前）`dbt` 类全小写产品名**不抽**。可接受。
- **B** 维护一个**小写产品名白名单**（`dbt`, `curl`, `ssh`, `grep`, `redis`, `postgres`, `nginx`, `vim`, `git`）—— 这些词出现 ≥ 1 次就入 glossary。
- **C** 用 `compromise` 改进 NER（**不可行**，compromise 14.x 没产品名识别）。

**推荐**: B。**`dbt` 是知名工具**，翻译时不应被翻译。但要警惕**白名单维护成本**和**误伤**（`go` 作为语言名 vs `go` 作为动词）。

### Q8 — 2 词短语阈值 ≥ 2 是否要降到 ≥ 1

**现象**: 漏掉 `agentic AI`, `Flink SQL`, `agent skills`, `real-time data`。这些短语出现 1-2 次但都是核心产品/技术概念。

**选项**:
- **A**（当前）≥ 2 词短语阈值 ≥ 2。
- **B** 把 2 词短语阈值从 ≥ 2 降到 ≥ 1。**风险**：会引入大量噪音（"live context", "real time", "AI tools"）。
- **C** 加**结构化判定**：2 词短语若包含**已知技术词**（`AI, ML, SQL, API, MCP, PII, RAG, LLM, ETL, RBAC, RPC, GPU, CPU, TLS, SSL, SDK, IDE, CDN, DDoS, SaaS, PaaS, IaC, TPU, NPU, FPGA, ASIC, JVM, WASM, gRPC, REST, GraphQL, JSON, YAML, TOML, XML, HTTP, HTTPS, TCP, UDP, DNS, DHCP, ARP, ICMP, SSH, FTP, SFTP, SMTP, IMAP, OAuth, JWT, SSO, SAML, CSRF, XSS, SQLi, OWASP, NIST, GDPR, HIPAA, SOC2, ISO27001, PCI, FedRAMP, SLI, SLO, SLA, K8s, Helm, etc.`）→ 即使只 1 次也入。
- **D** 用 `emphasizedTerms` 参数（已存在的 API）让翻译 UI 用户**主动**标记重点词——纯用户驱动。

**推荐**: C。**最具扩展性**。具体做法：在 `extractFrequentTerms` 加 `TECH_ANCHORS` 集合，phrase 命中其中一个就强制保留（即使 1 次）。`agentic AI` 命中 `AI` 锚点 → 入。

---

## 5. 修复历史

按时间倒序：

| 步 | 改动 | 文件 |
|---|---|---|
| 当前 | Q1-Q8 等决策 | — |
| 9 | `Intelligence` 抽出（compromise `acronyms()` 引入后副作用）| `glossaryExtractor.ts:115-130` |
| 8 | 加 `TimesFM`, `Flink`, `Microsoft` 等用 singleCapRegex | `glossaryExtractor.ts:155-167` |
| 7 | `acronyms()` API 替代 regex 主路径 | `glossaryExtractor.ts:128-138` |
| 6 | 加 `people()` API 抽 `Sean Falconer` | `glossaryExtractor.ts:140-156` |
| 5 | `Possessive` 显式过滤（`Netflix's` → `Netflix`）| `glossaryExtractor.ts:117-126` |
| 4 | `cleanTerm` 处理首尾 `-` 和撇号 | `glossaryExtractor.ts:86-101` |
| 3 | 加 `isCommonNoun` 单字路径过滤 + 缩写残片到 STOPWORDS | `glossaryExtractor.ts:248-263` |
| 2 | 加大小写不敏感的 `isCommonNoun` | `glossaryExtractor.ts:255-262` |
| 1 | 扩 `COMMON_NOUN_FALSE_POSITIVES`（`Stakes, Controls, Tooling, Industries, Security, ...`）| `glossaryExtractor.ts:243-251` |

每个修复都有对应单测（`src/__tests__/glossaryExtractor.test.ts` 49 个测试）保持绿色。

---

## 6. 验证方法

跑这两个命令确认状态：

```sh
# 1. 跑 458 个单元测试
pnpm test

# 2. 跑真实文章抽取
npx tsx scripts/dump-glossary.ts
```

当前两者都通过：
- 19 个 test files, 458 / 458 tests passed。
- dump-glossary 输出 22 词 / 142 字符。

如果要切换到不同文章验证，**编辑 `scripts/article.txt`** 即可——`dump-glossary.ts` 从该文件读取。

---

## 7. 决策表

请对每个问题选 A/B/C/D（可多选 Q7-Q8）。把答案发我即可，我会按选择修改 `glossaryExtractor.ts` 并跑一遍 dump-glossary 验证。

```
Q1: __
Q2: __
Q3: __
Q4: __
Q5: __
Q6: ✅ 已确认
Q7: __
Q8: __
```

| 选项 | 默认 |
|---|---|
| 不回复视为 | 全部按推荐选择 |
