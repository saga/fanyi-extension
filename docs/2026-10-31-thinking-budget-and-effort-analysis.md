# 思考预算与推理强度的实际效果分析

> **范围**：文档翻译使用的 CodeBuddy 本地 Agent（`vocal-saga/local-agent-service` + `@tencent-ai/agent-sdk@0.3.276`）。
> **方法**：静态阅读 SDK 与 CLI 产物代码，未做线上抓包。
> **结论**：`thinkingBudgetTokens` 的数字对当前默认模型 `deepseek-v4.1-flash` 不产生可观测效果；`effort` 的低/中两档同样被钳制为 high。真正影响耗时与质量的只有「思考开/关」。

## 一、结论摘要

| 旋钮 | 线上实际表现 | 是否影响输出 |
|---|---|---|
| 思考 开 / 关 | `thinking.type` + `alwaysThinkingEnabled` | **是**，唯一有效开关 |
| 思考预算 `thinkingBudgetTokens` | 请求体多一个非标准字段 `max_thinking_tokens`；DeepSeek 分支不读取该数字 | **否**（默认模型） |
| 推理强度 `effort` | `deepseek-v4.1-flash` 只声明了 `high` / `max`，低与中被向上钳制为 `high` | **否**（默认模型） |

由此，文档翻译页把「思考」简化为「不思考 / 思考」两档、并删除「思考量（tokens）」是符合实际行为的；保留预算选择器只会让用户以为自己在调一个有效参数。

## 二、参数链路

```
fanyi-extension 配置（thinkingMode / thinkingBudgetTokens / effort）
  → POST /api/documents/... 
  → local-agent-service/src/agents/taskProfiles.ts:184-190  codeBuddyThinkingOption()
      disabled → { type: 'disabled' }
      enabled  → { type: 'enabled', budgetTokens: N }
      adaptive → { type: 'adaptive' }
  → local-agent-service/src/agents/workbuddy.ts:53  构建 query 参数（thinking / effort）
  → SDK lib/transport/process-transport.js:255-268  applyThinkingEnv()
      enabled + budgetTokens → env MAX_THINKING_TOKENS=N
      adaptive               → 不设该环境变量
  → SDK lib/transport/process-transport.js:396-406  buildArgs()
      enabled / adaptive → --settings alwaysThinkingEnabled=true
      disabled           → --settings alwaysThinkingEnabled=false
  → SDK 进程：cli/dist/codebuddy-headless.js（process-transport.js:492 指向该入口）
      读 MAX_THINKING_TOKENS → modelSettings.providerData.max_thinking_tokens
      budget > 0 本身也被当作「开启思考」的信号（thinkingEnabled || !!budget），除非被显式关闭
```

关键点：**开启思考由 `alwaysThinkingEnabled` 决定，与预算数值无关**。预算只影响是否额外注入 `MAX_THINKING_TOKENS`。

## 三、请求体里到底发生了什么

### 3.1 chat completions 会把 providerData 摊进请求体

CLI 中组装 chat completions 请求体的位置，把 `modelSettings.providerData` 直接展开：

```js
let eh = eA.modelSettings.providerData ?? {};
eA.modelSettings.reasoning?.effort && (eh.reasoning_effort = eA.modelSettings.reasoning.effort);
eA.modelSettings.text?.verbosity && (eh.verbosity = eA.modelSettings.text.verbosity);
let ef = { model, messages, tools, temperature, top_p, ..., ...eh };
```

`SdkFieldCleanupRule` 只删除 `verbosity` 与 `reasoning_summary`，不删 `max_thinking_tokens`。因此 `enabled` 模式下，请求体里确实会出现一个顶层字段（结构示意）：

```json
{
  "model": "deepseek-v4.1-flash",
  "messages": ["..."],
  "thinking": { "type": "enabled" },
  "max_thinking_tokens": 8192
}
```

它不是一个被标准化的 provider 参数，而是原样透传给网关的自定义字段。

### 3.2 DeepSeek 格式只翻译「开/关」

`deepseek-v4.1-flash` 在模型目录中声明 `compat.thinkingFormat: "deepseek"`，对应的翻译规则只有一行有效逻辑：

```js
case "deepseek":
  ep ? (eA.thinking = eA.thinking || {}, void 0 === eA.thinking.type && (eA.thinking.type = "enabled"))
     : (eh && (eA.thinking = { type: "disabled" }), delete eA.reasoning_effort);
```

`ep` 表示思考是否开启。分支里没有任何写入预算数字的代码，数字只能靠 `providerData` 透传。

另外，整个 CLI 产物中 `budget_tokens` 出现 **0 次**：

```bash
cd vocal-saga/local-agent-service/node_modules/@tencent-ai/agent-sdk
grep -o 'budget_tokens'          cli/dist/codebuddy-headless.js | wc -l   # 0
grep -o 'max_thinking_tokens'    cli/dist/codebuddy-headless.js | wc -l   # 2（写入 1 次、Responses 路径剔除 1 次）
grep -o 'MAX_THINKING_TOKENS'    cli/dist/codebuddy-headless.js | wc -l   # 1
```

即：Anthropic 风格的 `thinking: { type: "enabled", budget_tokens: N }` 在本版本 CLI 中根本没有实现，预算不可能以此形式到达模型。

### 3.3 Responses API 路径直接丢弃

走 Responses API 的模型，转换函数显式剔除了该字段：

```js
function toResponsesModelSettings(eA, el) {
  ...
  let eh = eu ? omit(eu, ["max_thinking_tokens", "stop"]) : {};
  ...
}
```

也就是说，即使某个模型经由 Responses API 调用，预算数字也 100% 不会出现在请求里。

## 四、附带发现：effort 的低/中档对默认模型无效

`deepseek-v4.1-flash` 的模型目录声明：

```json
"thinkingLevelMap": { "minimal": null, "low": null, "medium": null, "high": "high", "max": "max" }
```

`getSupportedThinkingLevels()` 把值为 `null` 的档位视为不支持：

```js
function getSupportedThinkingLevels(eA) {
  return eA.reasoning
    ? EXTENDED_THINKING_LEVELS.filter(el => { const ec = eA.thinkingLevelMap?.[el]; return null !== ec && (...); })
    : ["off"];
}
```

随后 `clamp()` 在「low」被判定不支持时，按 `off → minimal → low → medium → high → xhigh → max` 的顺序向后寻找，落到 `high`。因此在默认模型上：

- 选「低」→ 发给网关的是 `high`
- 选「中」→ 发给网关的是 `high`
- 选「高」→ `high`

配置里 `translation` 任务的默认值是 `thinkingMode: 'disabled'` + `effort: 'low'`，实际等价于「完全不思考」，effort 不参与任何计算——这也解释了实测中关闭思考单批耗时从 46s 降到 20s 量级，而调整推理强度几乎没有体感差异。

## 五、预算数值真正有意义的条件

按当前代码，只有同时满足下列条件，`thinkingBudgetTokens` 才可能影响模型输出：

1. 模型经由 **chat completions** 调用（Responses API 会剔除字段）；
2. 模型的 `thinkingFormat` **不是** `deepseek` 这类只写 `type` 的格式；
3. 上游网关 **识别并采纳** `max_thinking_tokens` 这个非标准字段。

第 3 条无法从代码侧证明。默认模型的 baseUrl 是第三方网关 `https://opencode.ai/zen/go/v1`，DeepSeek 官方 API 也没有该参数，因此保守结论是：**数字被发出去，但不保证被使用**。

## 六、对当前实现的约束

- 文档翻译页只暴露「不思考 / 思考」两档，是对实际行为的准确映射，不再给用户「可调预算」的错觉。
- 切换到「思考」时内部补 `8192`（`App.vue:1849-1850`、`DocumentTranslationSettings.vue:519-521`）只用于让 `enabled` 结构完整；由于 `alwaysThinkingEnabled=true` 已足以开启思考，这个兜底可以删除，删除不会改变行为。
- `config.ts` 仍保留 `thinkingBudgetTokens` 字段（默认 8192，规范化时夹在 1024–65536）。它不产生用户可见效果，属于兼容性字段；若后续彻底移除该概念，需同时清理配置默认值与归一化逻辑。
- 更换默认模型或更换网关后，上述结论需要重新验证，不能直接沿用。

## 七、复现方式

```bash
cd /Users/saga/code-repos/vocal-saga/local-agent-service/node_modules/@tencent-ai/agent-sdk

# 1) 预算是否被翻译成标准参数（0 表示没有）
grep -o 'budget_tokens' cli/dist/codebuddy-headless.js | wc -l

# 2) 预算唯一去向
grep -o 'max_thinking_tokens' cli/dist/codebuddy-headless.js | wc -l
grep -o '.\{160\}max_thinking_tokens.\{120\}' cli/dist/codebuddy-headless.js | head

# 3) DeepSeek 分支的翻译规则
grep -o 'case"deepseek":.\{160\}' cli/dist/codebuddy-headless.js

# 4) 请求体摊平 providerData
grep -o 'let eh=eA.modelSettings.providerData??{}.\{600\}' cli/dist/codebuddy-headless.js
```

## 八、未验证事项

- 没有做真实的请求抓包（可用 `OTEL_LOG_RAW_API_BODIES=file:/tmp/raw` 让 CLI 落盘请求体，再跑一次思考翻译复核）。
- 未验证网关对 `max_thinking_tokens` 的处理：忽略、透传，还是换算成上游的 `budget_tokens`。
- 未验证其他可选模型（如 `glm-5.1`、`hy3`）的 `thinkingFormat` 与 `thinkingLevelMap`，结论仅适用于当前默认的 `deepseek-v4.1-flash`。
