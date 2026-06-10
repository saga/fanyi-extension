# 翻译异常根因分析报告

日期：2026-06-10
触发页面：英文长文（51 个 block，5 个 chunk）

## 现象

英文页面部分段落翻译成功、部分段落翻译失败，但**失败的段落还是英文**（不是缺翻译、是"翻译回原文"）。

`[ContentScript][SessionSummary] total=5 fullyOk=5 neededRetry=0 stillMissing=0` —— 所有 51 个 block 都被报告"成功翻译"，但 DOM 上看上去没翻译。

## 根因（按决定性排序）

### 1. Glossary 格式导致 no-op 翻译（主因）

之前的 system prompt 长这样：

```text
Required translations:
AI = AI
AI Agents = AI Agents
cash flow = cash flow
...
```

模型把 `X = Y` 解读成"翻译映射表"。当 `X === Y`（self-mapping）时，模型**学到了"包含这些词的句子应该原样保留"**。

证据（背景 console）：
```text
[TranslateApi] Block b51 came back unchanged (LLM refused / no-op). Original: 正在提取文本...
```

虽然这条是 b51（中文），但同样的 no-op 机制作用在英文上：`The shift will also boost cash flow` 因为 glossary 里有 `cash flow = cash flow`，模型把整段当成"已保护内容"原样回传。

**Fix**：把 glossary 格式从 `X = X` 改为 `Protected terms (do not translate, keep as-is): X\nY\nZ`。明确语义是"这些词不要翻译"，不是"翻译映射"。

### 2. Glossary 噪声污染

`document_terms` 由 `glossaryExtractor.ts` 提取，包含 27 个词组，其中：

- **普通词被当术语**：`Boost / Forecast / Soars / Cash / Tech / IT / US / Jim / Sachs` —— 这些是普通单词
- **正常英语短语**：`cash flow / consumption / enterprises / AI applications` —— 这些应该被翻译成中文

`[Background][StreamTrace]` 显示部分段落 noOpCount 接近 N/M。

**Fix（已部分）**：
- ✅ 改了 prompt 格式
- ⏳ 应该在 `glossaryExtractor.ts` 加更严格的过滤：长度 < 4 的普通词、常见英语短语应该被排除

### 3. max_tokens 触顶风险

`estInputTokens=881 reservedMaxTokens=2115` —— 对 chunk4 而言预算充足，但**输出端**没有按输入长度补偿。模型如果把英文逐字回传（不去构造中文），输出 token 数会变少 → 节省；但中文输出 token 数比英文多 30-50%。

不过 missing=0 说明 JSON 都成功解析，这条不是当前问题。

## 已实施的修复

| 文件 | 变更 |
|------|------|
| `src/entrypoints/service/deepseek.ts` | `X = X` → `Protected terms (do not translate):\nX\nY\nZ` |
| `src/entrypoints/background.ts` | 新增 `[StreamTrace]` 诊断 log（sample + noOpCount） |
| `src/entrypoints/service/deepseek.ts` | 新增 `[DeepSeek] System prompt built:` 诊断 log |
| `src/__tests__/deepseek-api.test.ts` | 改测试期望 |
| `src/__tests__/deepseek-stream.test.ts` | 改测试期望 |

## 建议的后续优化

1. **glossaryExtractor 加严过滤**：
   - 长度 < 4 字符的词不收（`AI / IT / US / Jim` 等），除非在 `TECH_ANCHORS` 白名单
   - 常见英语词组不收（`cash flow / consumption` 等），需要新加 `COMMON_PHRASES` 停用词
   - 已知产品/品牌名优先用白名单 casing 修正

2. **超时监控**：`[DeepSeek] Response status: 200` 跟 `[ChunkTrace] OUTPUT` 时间差是 ~5-7 秒/chunk（10:58:41 → 10:58:48）。如果未来 glossary 涨到 100+ 词，时间会从 7s 飙到 15s+。

3. **prompt cache 验证**：在 background log 加 `prompt_cache_hit_tokens` 字段，确认排序后的 glossary 确实命中了 KV cache。

## 验证步骤

1. 重新 build：`pnpm build`
2. 加载 dist 到 Chrome
3. 打开原文页面 → 触发翻译
4. 切到 background service worker console，看：
   - `[DeepSeek] System prompt built:` —— 确认 `Protected terms` 格式
   - `[Background][StreamTrace] noOpCount=0/M` —— 确认不再是 no-op
5. 看 DOM 上英文段落是否变中文

预期：`noOpCount` 应下降到 0-2/M（个别的无操作合理，例如纯 URL block），英文段落全部翻译。
