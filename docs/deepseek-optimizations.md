# DeepSeek API 专项优化

## 1. `temperature: 0.1`

**问题**：DeepSeek 默认 `temperature = 1.0`，对翻译任务过高，导致输出不稳定，响应长度波动，额外消耗 tokens。

**修改**：翻译和术语提取请求统一设置 `temperature: 0.1`。

**效果**：
- 翻译是确定性任务，低温度确保输出一致、可预测
- 减少 token 浪费（无随机性带来的额外输出）
- 代码位置：[deepseek.ts:12](src/entrypoints/service/deepseek.ts#L12) — `TRANSLATION_TEMPERATURE` 常量

## 2. `max_tokens` — 防跑飞

**问题**：DeepSeek 在 `response_format: { type: 'json_object' }` 模式下，如果 system/user prompt 没有显式要求输出 JSON，模型可能生成无限空白流直到达到 token 上限（[官方文档](https://api-docs.deepseek.com/api/create-chat-completion) 已知问题）。

**修改**：新增 `estimateMaxTokens()` 函数，根据输入长度估算合理上限：

```
max_tokens = input_chars × 0.5 × 2 × 1.2
```

- `× 0.5`：字符转 token 估算（CJK 偏保守）
- `× 2`：翻译输出通常 1-2 倍输入
- `× 1.2`：20% 缓冲防截断
- 下限 256 tokens

**代码位置**：[deepseek.ts:18-21](src/entrypoints/service/deepseek.ts#L18-L21)

## 3. `user_id: 'fanyi-extension'` — KV Cache 隔离

**问题**：DeepSeek 支持基于 `user_id` 的 KV Cache 隔离（[官方文档](https://api-docs.deepseek.com/quick_start/rate_limit)），不设置时无法利用缓存。

**修改**：所有请求统一设置 `user_id: 'fanyi-extension'`。

**效果**：
- 相同来源的翻译请求共享 KV Cache，减少重复计算
- 不同用户/业务隔离，避免缓存污染
- 对翻译场景（相同页面可能多次翻译）有潜在 cost 节省

**代码位置**：[deepseek.ts:11](src/entrypoints/service/deepseek.ts#L11) — `USER_ID` 常量

## 4. Prompt 压缩

### 翻译 prompt

| | 旧 | 新 | 压缩比 |
|---|---|---|---|
| system | ~1150 chars, 6 条规则 | ~320 chars, 3 条规则 | 72% |
| user | ~200 chars | ~80 chars | 60% |

**每次翻译请求节省约 950 tokens。**

### 术语提取 prompt

| | 旧 | 新 | 压缩比 |
|---|---|---|---|
| system | ~220 chars | ~130 chars | 41% |
| user | ~80 chars | ~40 chars | 50% |

## 5. 代码重构 — 消除重复解析

**问题**：`buildTranslationBody` 返回 JSON 字符串，`translateStream` 中需要 `JSON.parse()` 再修改、再 `JSON.stringify()`，浪费 CPU。

**修改**：`buildTranslationBody` 改为返回 `Record<string, unknown>`，`translate` 和 `translateStream` 直接使用对象。

**代码位置**：[deepseek.ts:88](src/entrypoints/service/deepseek.ts#L88)

## 已排除的优化

| 方向 | 原因 |
|------|------|
| `frequency_penalty` | DeepSeek 已废弃，传入不生效 |
| `presence_penalty` | DeepSeek 已废弃，传入不生效 |
| `top_p` | DeepSeek 建议与 `temperature` 二选一，已设 `temperature: 0.1` |
| Tool Calls | 翻译不需要外部工具调用，增加一轮对话反而浪费 cost |
| `thinking` 模式 | 翻译不需要推理，已设 `disabled` |
| Batch API | 实时性要求高，不适合批量 |