你这个方向其实是对的。
“逐段翻译”是很多浏览器翻译插件质量差的核心原因：

* 没有全局上下文
* 术语不统一
* 指代关系丢失
* 标题/正文风格不一致
* AI 无法理解文章整体结构

你真正想做的，其实是：

> document-level translation（文档级翻译）

而不是 sentence-level / paragraph-level translation。

下面我给你一个适合 Chrome Extension + LLM 的完整架构方案，重点放在：

1. 如何抽取网页内容
2. 如何合并请求
3. 如何切 chunk
4. 如何映射翻译结果回 DOM
5. 如何实现中英文对照显示
6. 如何保证稳定性与一致性

---

# 一、整体架构（推荐）

```text
网页 DOM
   ↓
Readable/DOM Parser
   ↓
结构化 Block Tree
   ↓
Normalize + Clean
   ↓
Global Chunk Builder
   ↓
LLM Translation
   ↓
Structured Translation Result
   ↓
DOM Rehydration
   ↓
双语渲染
```

---

# 二、不要“按段落直接翻译”

你真正应该做的是：

# 先建立“文档块模型”

而不是直接操作 DOM。

例如：

```ts
type TextBlock = {
  id: string
  xpath: string
  tag: string

  text: string

  context?: {
    headingPath: string[]
    position: number
  }
}
```

抽取后：

```json
[
  {
    "id": "b1",
    "tag": "h1",
    "text": "How AI Is Changing Finance"
  },
  {
    "id": "b2",
    "tag": "p",
    "text": "Large language models are transforming..."
  }
]
```

---

# 三、核心关键：合并请求（重点）

这是整个系统最重要的部分。

不要：

```text
p1 -> API
p2 -> API
p3 -> API
```

而是：

# 先构建“大文档”

例如：

```xml
<DOC>
  <BLOCK id="b1">
    How AI Is Changing Finance
  </BLOCK>

  <BLOCK id="b2">
    Large language models are transforming...
  </BLOCK>

  <BLOCK id="b3">
    Investment banks are experimenting...
  </BLOCK>
</DOC>
```

然后：

一次发送。

---

# 四、为什么 XML/JSON 包装非常重要

因为你后面还要：

# “重新映射回原文”

如果你只发纯文本：

```text
paragraph1

paragraph2

paragraph3
```

LLM 很可能：

* 合并段落
* 拆分段落
* 改变顺序
* 丢失结构

结果无法映射回 DOM。

---

# 正确方式

## 强约束结构

推荐：

# XML-like

因为 GPT/Claude 对这种结构最稳定。

例如：

```xml
<DOC>
  <BLOCK id="b1">
    Hello world
  </BLOCK>

  <BLOCK id="b2">
    Apple released a new model.
  </BLOCK>
</DOC>
```

Prompt：

```text
Translate the content to Simplified Chinese.

Rules:
1. Keep all BLOCK ids unchanged
2. Preserve structure
3. Do not merge blocks
4. Return valid XML only
5. Keep technical terms consistent
```

---

# 五、Chunk 策略（真正关键）

因为网页可能非常长。

例如：

* arxiv
* 长博客
* 法律文档
* 财报

不可能一次发。

所以：

# 不是“按段切”

而是：

# “按 token budget 的语义 chunk”

---

# 推荐算法

## Step 1

先抽 block：

```text
h1
p
p
h2
p
li
li
```

---

## Step 2

保留结构边界

例如：

* 不拆 h2 section
* 不拆 table
* 不拆 code block

---

## Step 3

构建 chunk

例如：

```ts
MAX_INPUT_TOKENS = 12000
TARGET = 10000
```

不断 append：

```text
BLOCK
BLOCK
BLOCK
```

直到接近 limit。

---

# 六、最关键：全局术语一致性

你真正想解决的是：

```text
LLM
Large Language Model
Foundation Model
```

不能一会翻：

* 大语言模型
* 大型语言模型
* 基础模型

---

# 推荐方案（非常重要）

在正式翻译前：

# 先做一次术语抽取

例如：

```text
Extract key technical terms and preferred Chinese translations.
```

返回：

```json
{
  "LLM": "大语言模型",
  "agent": "智能体",
  "token": "token",
  "fine-tuning": "微调"
}
```

---

# 然后后续所有 chunk 都带：

```text
Terminology Glossary:

LLM => 大语言模型
agent => 智能体
```

这会极大提升一致性。

---

# 七、Chunk 之间上下文连续性（高级）

很多系统忽略这一点。

你需要：

# Sliding Context Window

例如：

chunk2 翻译时：

带上：

* chunk1 summary
* glossary
* previous heading hierarchy

例如：

```text
Document Summary:
This article discusses AI in finance...

Previous Section:
Risk management systems...
```

这样：

AI 不会“失忆”。

---

# 八、重新映射回 DOM（重点）

因为你有：

```xml
<BLOCK id="b123">
```

所以：

可以：

```ts
translationMap[id] = translatedText
```

然后：

```ts
const node = idToDomNode[id]
```

重新插入。

---

# 九、不要直接修改原 DOM

推荐：

# Shadow DOM

或者：

# 双层 wrapper

例如：

```html
<div class="ai-translated">
  <div class="original">
    original text
  </div>

  <div class="translated">
    翻译
  </div>
</div>
```

---

# 十、中英文对照显示（推荐）

不要覆盖原文。

最佳 UX：

```text
English
中文翻译
```

例如：

```html
<div class="bilingual-block">
  <div class="source">
    Large language models are changing finance.
  </div>

  <div class="target">
    大语言模型正在改变金融行业。
  </div>
</div>
```

---

# 十一、如何避免网页布局崩掉

不要：

```js
innerHTML = ...
```

会炸。

---

# 推荐：

只处理：

```text
p
li
blockquote
h1-h6
td
span(large)
```

忽略：

* button
* nav
* code
* svg
* textarea

---

# 十二、非常关键：内容抽取

不要直接遍历 DOM。

推荐：

# Mozilla Readability

类似 Firefox Reader Mode。

实体：

Mozilla

官方：

[Mozilla Readability GitHub](https://github.com/mozilla/readability?utm_source=chatgpt.com)

它会：

* 去广告
* 去导航
* 去 footer
* 提取正文

质量会高很多。

---

# 十三、推荐的 Prompt 结构

建议：

```text
You are a professional translator.

Requirements:
- Preserve XML structure
- Preserve BLOCK ids
- Keep terminology consistent
- Use natural Simplified Chinese
- Do not omit content
- Do not summarize
- Return XML only

Terminology:
LLM => 大语言模型
agent => 智能体

Document Context:
This article discusses AI applications in finance.

XML:
...
```

---

# 十四、建议使用的模型

如果追求质量：

## 第一梯队

* [Claude](https://claude.ai?utm_source=chatgpt.com)
* [OpenAI GPT Models](https://openai.com/api/?utm_source=chatgpt.com)
* [Gemini](https://gemini.google.com?utm_source=chatgpt.com)

---

# 十五、一个真正专业的增强方案（很值）

你甚至可以：

# 两阶段翻译

---

## Stage 1

全文分析：

* 术语
* 风格
* 主题
* 人称
* 专业领域

输出：

```json
{
  "domain": "finance",
  "tone": "professional",
  "glossary": {}
}
```

---

## Stage 2

正式翻译。

质量会比普通插件高很多。

这其实已经接近：

DeepL 文档翻译级别。

实体：

DeepL

---

# 十六、真正难点（提前提醒）

真正难的不是翻译。

而是：

# DOM 映射稳定性

尤其：

* React 页面
* 虚拟 DOM
* 无限滚动
* 动态 rerender

所以：

不要依赖：

```js
querySelectorAll("p")
```

---

# 推荐：

为每个 block 建立：

```ts
WeakMap<Node, BlockId>
```

并监听：

```js
MutationObserver
```

---

# 十七、最终推荐架构（最优）

## content script

负责：

* DOM 抽取
* block mapping
* UI render

---

## background worker

负责：

* chunk orchestration
* API queue
* cache
* retry

---

## translator engine

负责：

* prompt build
* glossary
* chunk memory
* merge

---

# 十八、缓存（非常重要）

用户会重复打开页面。

建议：

```text
sha256(url + normalizedContent)
```

作为 cache key。

---

# 十九、推荐技术栈

## DOM

* Readability
* Turndown
* DOMPurify

---

## token 计算

* tiktoken

实体：

tiktoken

---

## XML parser

不要 regex。

用：

* fast-xml-parser

---

# 二十、一个很重要的额外建议

不要把：

```html
<p>
```

直接发给 AI。

因为：

HTML token 浪费巨大。

应该：

# 内部结构化

# 外部纯文本 XML

例如：

```xml
<BLOCK id="b1">
Text only
</BLOCK>
```

token 成本会下降很多。
