# Tool Calls 对翻译场景的适用性分析

## 结论

**对当前翻译场景不适用，Tool Calls 不会节省 cost，反而可能增加开销。**

## 原因分析

### 1. Tool Calls 的本质

Tool Calls 让模型能够调用外部工具，来增强自身能力。其执行流程为：

1. 用户提出问题
2. 模型返回 function_call JSON（如 `{"name": "get_weather", "arguments": {"location": "Hangzhou"}}`）
3. **用户代码执行这个函数**
4. 把函数执行结果塞回对话
5. 模型基于函数结果生成最终自然语言回复

**适用场景**：查天气、查数据库、调用计算器等**需要外部数据/动作**的任务。

### 2. 翻译是"纯文本输入 → 纯文本输出"

当前翻译流程：

```
文本块 → LLM → 翻译后的 JSON
```

不需要调用任何外部工具。如果用 Tool Calls，模型只会输出一个"调用翻译工具"的 JSON，然后用户代码还得自己翻译，完全没意义。

### 3. Cost 角度

- Tool Calls 本身**不减少 token 消耗**
- 反而需要**多一轮对话**：
  - 模型输出 function_call
  - 用户执行函数
  - 再发 tool 结果给模型
  - 模型生成最终回复
- 对翻译来说，这就是**两倍调用**

### 4. 可能混淆的概念：JSON Mode / Structured Output

文档里提到的 `strict` 模式 + JSON Schema 确实能**强制模型按固定格式输出**，但这和 Tool Calls 是**两回事**。

当前代码已经在用 `response_format: { type: 'json_object' }`，已经能约束输出格式。

## 真正可能节省 cost 的方向

| 方向 | 说明 | 可行性 |
|------|------|--------|
| **Prompt 压缩** | 减少 system prompt 长度（当前 6 条规则 + 示例，约 800-1000 tokens） | 中 |
| **缓存命中** | 已有 7 天 TTL 的 translationCache，但首次翻译还是全量 | 已有 |
| **模型降级** | 当前用 `deepseek-v4-flash`，已经是最便宜的；如果质量够，`v3` 更便宜 | 低（质量风险） |
| **Batch API** | DeepSeek 支持批量请求，折扣约 50%，但实时性要求高的话不适用 | 低（实时性要求） |

## 参考文档

- [DeepSeek Tool Calls 文档](https://api-docs.deepseek.com/zh-cn/guides/tool_calls)
- [DeepSeek JSON Mode 文档](https://api-docs.deepseek.com/zh-cn/guides/json_mode)
