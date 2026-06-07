# 翻译扩展抽取算法（Glossary & Block）改进计划

基于对真实技术文章（Confluent Intelligence 案例：`thenewstack.io/confluent-intelligence-ai-agents`）的抓取测试，现有的 `glossaryExtractor` 和 `blockExtractor` 暴露出了明显的设计缺陷。为了提升提取准确率并防止无用词汇污染大模型的上下文（Token 浪费），特制定以下改进计划。

## 一、 真实场景提取问题复盘

在对实际网页进行提取时，50 个术语槽位中出现了大量“脏数据”：
1. **网页 UI 文本泄漏**：`"EMAIL"`, `"NAME"`, `"REQUIRED"`, `"SUBSCRIBE"`, `"VOXPOP"`。单纯依靠全大写正则将这些表单/按钮文本误认为了技术缩写（Acronym）。
2. **标点清洗（Sanitization）漏洞**：`"Falconer.The"`, `"“Teams"`。未处理粘连的英文句号，未覆盖中文/弯角引号。
3. **品牌/产品名断裂**：核心探讨对象 `"Confluent Intelligence"` 被拆散成了独立的 `"Confluent"` 和 `"Intelligence"`，导致翻译引擎丢失上下文。
4. **所有格碎片残留**：`"Confluents aim"`。短语提取阶段剥离了撇号（`'`），留下了毫无意义的主谓搭配碎片。
5. **大小写导致的重复提取**：同时出现了 `"LINKEDIN"` 和 `"LinkedIn"`，Map 去重逻辑为大小写敏感，导致同一个词汇占据多个坑位。

## 二、 具体改进方案与实施步骤

### 1. 强化 `cleanTerm` 标点与特殊符号清洗
必须在 NLP 分词前后提供更健壮的边界清理，防止标点粘连。
* **动作**：
  * 将 `cleanTerm` 中的替换正则增加对弯角引号（`“”‘’`）的清洗。
  * 增加粘连句号强制截断逻辑（如遇到 `.[A-Z]` 则只保留前半部分）。
* **代码目标**：
  ```typescript
  .replace(/^[,;:.!?'"“”‘’()\[\]{}\-–—#*_/\\|<>~`\s]+/, '')
  .replace(/[,;:.!?'"“”‘’()\[\]{}\-–—#*_/\\|<>~`\s]+$/, '')
  .split(/\.[A-Z]/)[0] // 强制阻断 "Word.Next"
  ```

### 2. 实现全局大小写不敏感去重 (Case-Insensitive Dedup)
当前的 `glossaryMap` 允许大小写不同的同一个词并存。必须在生成最终列表前进行合并。
* **动作**：
  * 在合并最终数组时，使用小写的 `term.toLowerCase()` 作为去重键。
  * **保留策略**：如果发生冲突，优先保留包含小写字母的“驼峰形式/首字母大写形式”（如保留 `LinkedIn` 丢弃 `LINKEDIN`），因为它更符合自然语言中的专有名词。

### 3. 压制全大写 UI 噪音 (Acronym Noise Suppression)
UI 按钮通常是短小的全大写单词。
* **动作**：
  * 在 `extractAcronyms` 中加入频次检验与长度校验：如果一个全大写单词长度 $\ge$ 5 且不包含数字（如 `SUBSCRIBE`, `REQUIRED`），要求它在正文中至少出现 2 次才能作为 Acronym 被提取。
  * 对于真正带有数字的技术组合（如 `GPT4`, `K8S`），直接放行。

### 4. 优化产品组合词 (Brand Merge) 逻辑
解决 `Confluent Intelligence` 被拆散的问题。
* **动作**：
  * 改进正则表达式，允许两个大写单词之间的粘连，或直接依赖 compromise 的 `#ProperNoun+` 输出。
  * 或者在频繁词提取阶段，增加对连续大写单词的组合信任度，不被 `COMMON_NOUN_FALSE_POSITIVES`（如 `Intelligence` 可能被误判）强行打断。

### 5. `blockExtractor` 源头拦截全大写短句
治标先治本，不要让侧边栏的 UI 文本进入 NLP 处理流程。
* **动作**：
  * 在 `src/entrypoints/utils/blockExtractor.ts` 的 `isValidText` 内部，增加检测：如果一个文本块极短（< 20 字符），并且完全由大写字母和空格组成（如 `"EMAIL"`，`"SUBSCRIBE TO NEWSLETTER"`），直接 `return false` 拦截。
  * 增加特定的表单占位符拦截规则（检测 "REQUIRED", "NAME" 等独占一个区块的情况）。

## 三、 总结
当前设计的思路（客户端快速正则+轻量级NLP）是合理的，无需引入庞大的依赖或者请求大模型。目前的缺陷在于**防御性编程不足**，过度信任了网页提取上来的脏文本。执行上述五步改进，即可在保持极高运行速度的同时，大幅度提升术语表的“含金量”。
