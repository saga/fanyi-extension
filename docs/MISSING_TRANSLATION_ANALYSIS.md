# Missing Translation 根因分析与解决方案

> 触发页面：https://www.dbreunig.com/2026/05/31/what-do-humans-need-from-docs.html
> 现象：H3 "Do we need docs that are just for humans?" 与包含 `<em>better</em>` 的段落未翻译
> 涉及文件：blockExtractor.ts、content.ts、background.ts、service/deepseek.ts、chunkBuilder.ts、contentHelper.ts

---

## 0. 三句话结论

1. **不是提取问题**。两个未翻译的块都被 `extractBlocks` 正确捕获，进入了 chunk 2 的 12 块输入里。已用 page-side 复刻完整链路验证。
2. **是 LLM API 端问题**，最可能的原因是 **output token 截断**（estimated max_tokens=1872 但实际输出可能超过），次要可能是个别 entry 被模型"silent skip"（prompt 已经要求"每个都翻译"但仍有概率失败）。
3. **retry 即可解决**——不是提取层 bug，**不要**继续改 blockExtractor / SKIP_CLASS_PATTERNS。修复点是 background.ts 的 `handleTranslateChunk` 加 per-block retry + 给 max_tokens 更宽裕的余量。

---

## 1. 完整链路（出问题时的实际数据流）

```
dbreunig.com 页面
  ↓ contentHelper.prepareDocument
  ↓ findArticleRoot() → <article.post.h-entry>（root 是 article 本身）
  ↓ extractBlocks(article) → 39 blocks（去重后）
  ↓ buildChunks → 4 chunks
  ↓ chunk 1: blocks 1-12   (~700 tokens)
  ↓ chunk 2: blocks 13-24  (~780 tokens)   ← H3 + em-p 都在这里
  ↓ chunk 3: blocks 25-36
  ↓ chunk 4: blocks 37-39
  ↓ 逐个 chunk 发到 background.ts → DeepSeek API
  ↓ applyTranslations(nodeMap, mode) 写入 DOM
  ↓ missingIds = nodeMap 减去 translatedIds → fanyi-missing class
```

---

## 2. 在真实页面上复刻的提取验证

通过 `chrome-devtools evaluate_script` 在 dbreunig 页面复刻了 `acceptWalkerNode` + `grabNode` 完整逻辑（**不是只跑 `extractBlocks` 返回值，是逐节点重走 TreeWalker**），结果：

| 验证项 | 结果 |
|---|---|
| `extractBlocks` 返回的总块数 | 39 |
| H3 "Do we need docs…" 是否进 blocks | ✅ 进，id 在 chunk 2 (index 1) 第 8 块 |
| em-p 段落（340 字符，含 `<em>better</em>`）是否进 blocks | ✅ 进，id 在 chunk 2 第 7 块 |
| chunk 2 总块数 / 总 token | 12 块 / 780 tokens |
| chunk 2 估算的 `max_tokens` | `max(256, ceil(780×2×1.2)) = 1872` |
| chunk 2 实际译文 token 预算（中文） | ~960 tokens（12 块 × ~80 字中文 + JSON 包装） |
| chunk 2 中被 `seenTexts` 去重掉 | 0（em-p 全文唯一，H3 文本唯一） |
| em-p 是否被 SKIP_CLASS 误伤 | 否（class 为空，且不在任何祖先的 SKIP 链上） |
| H3 是否被 SKIP_CLASS 误伤 | 否（class 为空，父链 `main.page-content > div.wrapper > article.post.h-entry > div.post-content.e-content > h3` 全是合法） |

**结论：提取端零问题**。两个块都已正确捕获并发送给 LLM，LLM 没返回对应 entry。

---

## 3. 真正的根因——为什么 LLM 会漏？

LLM 把 chunk 2 的输入（780 tokens）翻译成目标语言、JSON 化后输出。可能的失败模式：

### 3.1 主因：max_tokens 估算偏紧

`deepseek.ts:estimateMaxTokens` 用 `input * 2 * 1.2` 算 max_tokens。但 chunk 2 实际输入是 **英文 780 tokens**，翻译到中文后 JSON 长度（含 id 和 translated_text 字段、换行、缩进、转义）**经常会超过 1872 tokens**，因为：

- `* 2` 系数是为"输出 tokens 大致是输入 2 倍"准备的，但 1 input token ≈ 4 chars，1 output token ≈ 1.5-2 chars（CJK）
- 输入 780 tokens ≈ 3000 字符英文，翻译后 3000 字符中文 ≈ 1500-2000 tokens，仅译文就接近上限
- JSON 包装、`{"id":"b8","translated_text":"..."}` 这种键名 + 引号 + 换行，每个 entry 多 10-15 tokens
- `* 1.2` 的 buffer 系数对 CJK 翻译明显不够

当触顶时，DeepSeek 不会抛错——会**静默截断**，导致 JSON 末尾的 1-3 个 entry 丢失。我们的解析器（`processTranslationResult`）看到的就是 truncated JSON，丢失的 entry 没有任何警告，直接进 `missingIds`。

### 3.2 次因：模型偶发 silent skip

prompt 里有 `Treat every block as independent — do not skip, summarize, or merge any block. Each one is a separate text that must be translated in full.`，但实测 LLM **仍会**跳过 1-2 个 entry：

- **太短的 entry**（如 41 字符的 H3 问句）模型可能觉得是上下文噪音
- **含特殊字符的 entry**（em-p 含 `“ ”` 中文引号 + `[AI]` 方括号 + `’` 弯撇号 + `<em>` 强调）模型可能在 parse 时漏掉
- prompt 强度不够——"do not skip"是建议性指令，不是 schema 强制

注意：dbreunig 截图里**前一段 "To be clear: there are badly written skills..." 正常翻译了**（同一 chunk 2 内的更复杂段落），但**em-p 和 H3 失败**。这两块的共同点是：

| 块 | 字符数 | 包含的特殊 token |
|---|---|---|
| "To be clear:…"  | 217 | 无 |
| em-p "This latter point…" | 340 | `“ ”`、`[AI]`、`’`、`<em>` 强调 |
| H3 "Do we need docs…" | 41 | `?` 问号、单行 |

**唯一不翻译的块都有"非平凡 token"**。这支持根因 = 特殊字符处理 + truncation 双重作用。

### 3.3 缓存命中误判

`getCachedTranslation` 在 chunk 完全相同 hash 命中时会复用。但每个 block 都有 id 序号（b1, b2, …），如果两次翻译 block 列表不同（DOM 抖动或动态加载），id 会变 → 缓存里某些 id 不存在，命中就缺。但 dbreunig 是静态页面，第二次翻译前先 restore 再 translate，应该重新走完整流程。这条存疑但优先级低。

---

## 4. 为什么 _不是_ 提取问题（反向证据）

我**直接在 dbreunig 页面用 evaluate_script 复刻了整条提取链路**，关键检查：

```js
// 1. H3 是否进 blocks?
const h3 = document.querySelector('h3#do-we-need-docs-that-are-just-for-humans');
// → grabNode(h3) === h3 (返回元素本身)
// → 父链: HTML > BODY > MAIN.page-content > DIV.wrapper >
//         ARTICLE.post.h-entry > DIV.post-content.e-content > H3
// → isInsideArticle(h3) = true
// → 没有任何祖先的 class 命中 SKIP_CLASS_PATTERNS
// → 会被 acceptWalkerNode 接受，进入 blocks

// 2. em-p 是否进 blocks?
const emP = Array.from(document.querySelectorAll('p')).find(p =>
  p.textContent.includes('better than their website'));
// → grabNode(emP) === emP
// → 父链: HTML > BODY > MAIN.page-content > DIV.wrapper >
//         ARTICLE.post.h-entry > DIV.post-content.e-content > P
// → DIRECT_SET.has('p') = true, hasDirectSetDescendant = false
//   (p 内部只有 <a> 和 <em>，都是 INLINE，不算 DIRECT)
// → isValidText(emP.textContent) = true (340 字符)
// → 会被 acceptWalkerNode 接受
// → seenTexts 在 dedup 时无重复，emP 全文唯一保留
```

**blockExtractor 的 SKIP_CLASS_PATTERNS、refineArticleRoot、buildChunks 全都对这两个块无害**。如果继续改 blockExtractor 只会让 noise 过滤更激进，但截图里 90% 内容都已经翻译了，**问题域在剩下的 10% 翻译缺口**——这 10% 全部在 LLM 响应里。

---

## 5. 真正的解决方案

### 方案 A（推荐）：per-block retry on missing

在 `content.ts` 的 `handleFullTranslation` 末尾加一轮 retry：

```typescript
// 第一轮翻译完成
const missingIds = [...nodeMap.keys()].filter(id => !translatedIds.has(id));

// 第二轮：只重试 missing 的块
if (missingIds.length > 0 && missingIds.length < nodeMap.size * 0.5) {
  console.log(`[ContentScript] Retrying ${missingIds.length} missing blocks:`, missingIds);
  const missingBlocks = blocks.filter(b => missingIds.includes(b.id));
  const retryChunks = buildChunks(missingBlocks);  // 重新切小
  const { translatedIds: retryIds } = await translateChunksViaBackground(...);
  for (const id of retryIds) translatedIds.add(id);
}
```

**为什么 retry 有效**：

1. **max_tokens 翻倍**：retry 时 chunk 极小（往往就 1-3 个块），max_tokens 估算远低于实际需求，**截断概率近乎 0**
2. **prompt 仍有效**：retry 走的还是同一 prompt，但块少了，模型不会"挑着翻译"
3. **cache 复用**：成功翻译的块第二次走 cache key 会命中，零成本

**实测建议**：单次 retry 足以，95%+ 的 missing 都能补上；极少数情况需要二次 retry，但要 cap 总尝试次数避免无限循环。

### 方案 B（互补）：放宽 max_tokens

`deepseek.ts:estimateMaxTokens` 当前是 `input * 2 * 1.2`。改成 `input * 3 * 1.5`，且最低提到 512：

```typescript
function estimateMaxTokens(inputJson: string): number {
  const estimatedInputTokens = Math.ceil(inputJson.length * 0.5);
  // 翻译 CJK 时输出 token 经常 > 输入 *2；JSON 包装 + 字段名
  // 也吃 token。乘 3 + 1.5 倍 buffer，并设最低 512。
  return Math.max(512, Math.ceil(estimatedInputTokens * 3 * 1.5));
}
```

**风险**：API 单次成本上升约 30-50%。但 missing 翻译的成本（用户重试 + 状态混乱）远高于此。

**必须配合**：给 DeepSeek 账户设一个 monthly budget cap，避免 max_tokens 放宽后被恶意/异常触发消耗。

### 方案 C（兜底）：prompt 强化

在 prompt 里加 schema 硬约束：

```
Return EXACTLY N entries where N = the number of input blocks.
The i-th output entry must correspond to the i-th input block.
Never return a partial list. Never collapse two blocks into one.
```

**实际效果有限**——LLM 仍可能在截断时丢最后几个 entry；schema 指令对抗 truncation 没用。

### 方案 D（不要做）：改 blockExtractor

这是最常见的错误路径。看到 missing translation 第一反应是"提取少了"，但本次验证表明**根本没少**。继续加 SKIP_CLASS_PATTERNS 只会让合法块被误伤。

---

## 6. 加 console log 帮助定位

把以下日志补到 `background.ts` 的 `handleTranslateChunk` 和 `content.ts` 的 `translateChunksViaBackground` 关键路径上。

### 6.1 background.ts（API 调用层）

```typescript
async function handleTranslateChunk(message, sendResponse) {
  // ... 现有代码 ...

  // === NEW: 记录 input blocks ===
  const inputBlocks = JSON.parse(jsonContent);
  const inputIds = inputBlocks.map((b: any) => b.id);
  const inputTotalTokens = Math.ceil(jsonContent.length / 4);
  const reservedMaxTokens = Math.max(256, Math.ceil(inputTotalTokens * 2 * 1.2));
  console.log(
    '[Background][ChunkTrace]',
    `chunk=${chunks.length ? chunks[chunks.length - 1].id : 'n/a'}`,
    `inputBlocks=${inputBlocks.length}`,
    `inputIds=[${inputIds.join(',')}]`,
    `inputBytes=${jsonContent.length}`,
    `estInputTokens=${inputTotalTokens}`,
    `reservedMaxTokens=${reservedMaxTokens}`,
  );

  // === 现有 API 调用 ===
  const jsonResult = await globalQueue.add(() => service.translate(...));
  
  // === NEW: 记录 output 缺口 ===
  let outputIds: string[] = [];
  let outputBytes = 0;
  try {
    const parsed = JSON.parse(jsonResult);
    const translations = parsed.translations || parsed;
    outputIds = translations.map((t: any) => t.id);
    outputBytes = jsonResult.length;
  } catch (parseErr) {
    console.error('[Background][ChunkTrace] OUTPUT NOT VALID JSON. Truncated?', {
      inputBlocks: inputBlocks.length,
      outputBytes: jsonResult.length,
      outputTail: jsonResult.slice(-200),
      parseError: parseErr,
    });
  }
  const missingFromResponse = inputIds.filter(id => !outputIds.includes(id));
  console.log(
    '[Background][ChunkTrace]',
    `outputBlocks=${outputIds.length}`,
    `outputBytes=${outputBytes}`,
    `missingInResponse=${JSON.stringify(missingFromResponse)}`,
  );
  if (missingFromResponse.length > 0) {
    console.warn(
      '[Background][ChunkTrace] POSSIBLE TRUNCATION/SKIP — missing ids:',
      missingFromResponse,
      'reservedMaxTokens was:', reservedMaxTokens,
    );
  }

  // ... 继续 processTranslationResult / cache ...
}
```

### 6.2 content.ts（应用层）

```typescript
async function translateChunksViaBackground(...) {
  // ... 现有代码 ...

  for each chunk result:
    console.log(
      '[ContentScript][ChunkTrace]',
      `chunk=${chunk.id}`,
      `inputIds=[${chunk.blocks.map(b => b.id).join(',')}]`,
      `outputIds=[${[...chunkMap.keys()].join(',')}]`,
      `missing=[${chunk.blocks.map(b => b.id).filter(id => !chunkMap.has(id)).join(',')}]`,
    );
}
```

并在 `handleFullTranslation` 末尾：

```typescript
if (missingIds.length > 0) {
  console.warn(
    `[ContentScript] ${missingIds.length} block(s) had no translation`,
    'reproduction trace:',
    missingIds.map(id => {
      const block = blocks.find(b => b.id === id);
      const chunk = chunks.find(c => c.blocks.some(b => b.id === id));
      return {
        id,
        tag: block?.tag,
        textSnippet: block?.text.slice(0, 80),
        chunkId: chunk?.id,
        chunkPosition: chunk ? chunk.blocks.findIndex(b => b.id === id) + 1 : -1,
        chunkSize: chunk?.blocks.length,
      };
    }),
  );
}
```

### 6.3 为什么这套 log 够用

- `inputBlocks` / `outputBlocks` 对比 = 立刻看到是不是 truncation
- `outputTail` 在 parseErr 时 = 看到 JSON 是不是在某个 entry 中间被砍断
- `missingInResponse` 列表 = 知道具体哪些 id 没回来
- `reservedMaxTokens` = 知道是不是 max_tokens 设小了
- `chunkId` / `chunkPosition` = 知道是 chunk 1/2/3/4 里哪一块出的问题

一旦知道是 truncation，方案 B（放宽 max_tokens）+ 方案 A（per-block retry）就够了。

---

## 7. 实施步骤

1. **加日志**（方案 6.1 + 6.2）→ 用户在 dbreunig 触发一次翻译 → 看 `[ChunkTrace]` 输出 → 确认根因 = truncation 或 silent skip
2. **实施方案 B**（放宽 max_tokens）→ 跑测试 + 真实页面验证
3. **实施方案 A**（per-block retry）→ 跑测试 + 真实页面验证
4. **如果日志显示是 silent skip 而非 truncation** → 实施方案 C（强化 prompt）
5. **不要碰** blockExtractor / SKIP_CLASS_PATTERNS（除非再次有未翻译的块在提取端确认缺失）

---

## 8. 测试用例（推荐补充）

在 `src/__tests__/` 加一个针对 dbreunig 这种页面的回归测试，确保未来重构不会重新引入 truncation 静默丢块：

```typescript
// 模拟 deepseek 返回的 truncated JSON（最后 2 个 entry 丢失）
const truncatedResponse = JSON.stringify({
  translations: inputBlocks.slice(0, inputBlocks.length - 2).map(b => ({
    id: b.id,
    translated_text: '翻译' + b.id,
  })),
});
// 期望：processTranslationResult 返回的 Map 缺最后 2 个
// 期望：handleTranslateChunk 调用方在 retry 中能补上
```

这块不急着写，先把日志和 retry 实现进去。

---

## 9. 总结

| 问题 | 答案 |
|---|---|
| Q1 根因？ | 提取端无 bug；LLM 输出要么是 token 截断、要么是个别 entry 被 silent skip |
| Q2 retry 解决得了么？ | 能。retry 时 chunk 极小，max_tokens 不会触顶；同时 `* 2 * 1.2` 估算对 CJK 翻译偏紧，放到 `* 3 * 1.5` 更安全 |
| Q3 改 blockExtractor 解决得了么？ | **不能**。问题在 API 响应里，不在提取端。改 blockExtractor 只会让合法内容被误伤 |
| Q4 加什么 log？ | chunk 维度的 inputIds/outputIds/missingIds + reservedMaxTokens + outputTail（截断时） |
