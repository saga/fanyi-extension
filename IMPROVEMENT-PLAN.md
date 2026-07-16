# fanyi-extension 架构改进计划

> 基于当前 v0.70.13 的架构审查，列出值得改进的方向和具体方案。

## 1. 问题总览

| # | 问题 | 严重度 | 影响范围 |
|---|------|--------|---------|
| P1 | 消息层无类型安全，22 处 `any` | 高 | content ↔ background 全链路 |
| P2 | 死代码：floatingButton.ts 已停用但未删除 | 中 | 代码可维护性 |
| P3 | 94 处 console.log/warn/error 散布全项目 | 中 | 线上性能、用户调试体验 |
| P4 | domObserver.extractBlocksFromNode 重复定义过滤规则 | 中 | 规则一致性 |
| P5 | contentDetector.ts 单文件 640+ 行，职责过多 | 中 | 可维护性 |
| P6 | 翻译状态管理为可变对象，无统一入口 | 中 | 状态追溯困难 |
| P7 | error handling 不统一（throw / return null / 静默吞） | 中 | 故障排查困难 |
| P8 | 缺少 abort 机制：翻译中 SPA 跳转后旧请求继续跑 | 低 | 浪费 API 调用 |
| P9 | 缓存键 simpleHash 碰撞风险无检测 | 低 | 翻译正确性 |
| P10 | 测试覆盖不均：核心路径覆盖好，边界场景少 | 中 | 回归风险 |

---

## 2. 改进项详解

### P1. 消息层类型安全

**现状**: content ↔ background 之间的消息用 `any` 传递，编译器无法检查。

**方案**: 定义统一的 `Message` 联合类型和 `MessageHandler` 映射。

```typescript
// src/types/messages.ts
interface TranslateChunkRequest {
  action: 'translateChunk';
  payload: { chunk: Chunk; pageUrl: string; glossary?: Glossary };
}
interface TranslateChunkResponse {
  result?: Map<string, string>;
  trace?: ChunkTrace;
  error?: string;
}
// ... 其他消息

type Request = TranslateChunkRequest | ValidateApiKeyRequest | ...;
type Response = TranslateChunkResponse | ValidateApiKeyResponse | ...;
```

**改动范围**:
- 新建 `src/types/messages.ts`
- `background.ts` 的 `onMessage` 回调签名改用 `Request` / `Response`
- `chunkTranslation.ts` 的 `sendMessage` 调用改用具体类型
- `translationUtils.ts` 的 `sendMessage` 同上

**风险**: 低。纯类型变更，不改变运行时行为。

---

### P2. 删除死代码 floatingButton.ts

**现状**: `setupFloatingButton()` 调用已从 `content.ts` 移除，但 `floatingButton.ts` 仍然被 import，且 `updateButtonState()` 仍被 3 个文件调用。

**方案**:
1. 将 `updateButtonState()` 的 5 行实现内联到调用方（或改为空函数），消除 `floatingButton.ts` 依赖
2. 删除 `floatingButton.ts` 和对应测试 `floatingButton.test.ts`
3. 清理 `content.ts` 顶部注释中对 floatingButton 的描述

**改动范围**:
- 删除 `src/entrypoints/content/floatingButton.ts`
- 删除 `src/__tests__/floatingButton.test.ts`
- 修改 `content.ts`、`translation.ts`、`translationUtils.ts` 移除 import

**风险**: 低。`setupFloatingButton` 已不被调用，`updateButtonState` 只做按钮状态更新，内联后零风险。

---

### P3. 日志系统治理

**现状**: 94 处 `console.log/warn/error` 散布 18 个文件。生产环境也会输出，影响性能且暴露内部逻辑。

**方案**: 引入 `debug` 模式控制。

```typescript
// src/utils/logger.ts
const DEBUG = localStorage.getItem('fanyi-debug') === '1' || import.meta.env.DEV;

export const logger = {
  debug: (...args: any[]) => DEBUG && console.log('[fanyi]', ...args),
  info: (...args: any[]) => console.log('[fanyi]', ...args),
  warn: (...args: any[]) => console.warn('[fanyi]', ...args),
  error: (...args: any[]) => console.error('[fanyi]', ...args),
};
```

**分阶段实施**:
1. 先创建 `logger.ts`，全量替换 `console.*` 调用
2. `debug` 级别日志在生产环境完全静默
3. `warn/error` 保留，但统一加 `[fanyi]` 前缀
4. 后续可扩展为发送到 background script 做远程日志收集

**改动范围**: 18 个文件，纯机械替换。

**风险**: 低。不改变业务逻辑。

---

### P4. domObserver 规则与 blockExtractor 规则统一

**现状**: `domObserver.ts` 的 `extractBlocksFromNode()` 自己维护了一份 `PROCESSABLE_TAGS` 和 `IGNORE_TAGS`，与 `blockExtractor/constants.ts` 的 `DIRECT_SET` / `SKIP_SET` 不一致：

| 元素 | blockExtractor | domObserver | 问题 |
|------|---------------|-------------|------|
| `<td>` `<th>` `<caption>` | SKIP_SET | PROCESSABLE_TAGS | 动态内容会翻译表格，主流程不会 |
| `<label>` `<legend>` | (不 skip) | PROCESSABLE_TAGS | 可接受，但应统一 |
| `<button>` | (不 skip) | IGNORE_TAGS | 不一致 |
| `<dt>` | SKIP_SET | (未列出) | 动态内容会漏 |

**方案**: `domObserver.extractBlocksFromNode()` 直接复用 `blockExtractor` 的 `collectBlocks()` 函数，传入新增的 DOM 节点作为 root。

```typescript
// 修改前
private extractBlocksFromNode(element: Element): TextBlock[] {
  // 自己的 traverse 逻辑 + PROCESSABLE_TAGS + IGNORE_TAGS
}

// 修改后
private extractBlocksFromNode(element: Element): TextBlock[] {
  return collectBlocks(element, [], { value: 0 }, new Set());
}
```

**改动范围**: `domObserver.ts` 删除 ~40 行自定义遍历逻辑，改为调用 `collectBlocks`。

**风险**: 中。需验证动态内容提取结果与主流程一致，可能需要调整 `collectBlocks` 的参数。需补充测试。

---

### P5. contentDetector.ts 拆分

**现状**: 单文件 640+ 行，包含：常量、token 定义、评分函数、候选收集、Readability fallback、碎片化检测、调试输出。

**方案**: 按职责拆分为 4 个文件：

```
src/entrypoints/utils/contentDetector/
├── index.ts          # detectArticleRoot() 主入口 + 导出
├── scoring.ts        # scoreElement() + 相关常量
├── candidates.ts     # collectCandidates() + refine/expand
└── readability.ts    # tryReadabilityRoot() + isFragmentedArticleRoot()
```

**改动范围**: 纯文件拆分 + import 路径更新，不改业务逻辑。

**风险**: 低。需同步更新 vocal-saga 的 `lib/translate/contentDetector.ts`。

---

### P6. 翻译状态管理改进

**现状**: `TranslationState` 是一个可变对象，在 `content.ts` 闭包中被多个函数直接修改，无统一变更入口。

```typescript
// 当前
state.originalTexts.set(node, text);  // 任意位置直接修改
state.translatedBlocks = blocks;       // 任意位置直接赋值
```

**方案**: 封装为类，所有状态变更通过方法调用。

```typescript
class TranslationStateManager {
  private originalTexts = new Map<Node, string>();
  private translatedBlocks: TextBlock[] = [];
  private translatedTexts = new Map<string, string>();
  private _isTranslated = false;

  get isTranslated() { return this._isTranslated; }

  saveOriginal(node: Node, text: string) { ... }
  setTranslated(id: string, text: string) { ... }
  restoreAll(): void { ... }
  clear(): void { ... }
}
```

**改动范围**:
- 新建 `TranslationStateManager` 类
- `translation.ts`、`translationUtils.ts`、`chunkTranslation.ts` 中的 `state.xxx` 调用改为 `stateManager.xxx()`
- `content.ts` 中的 `state` 变量改为 `stateManager` 实例

**风险**: 中。涉及核心翻译流程，需充分测试。建议分阶段实施：先封装不改逻辑，再逐步收紧访问权限。

---

### P7. Error Handling 统一

**现状**:
- `translateApi.ts`: 失败时 `throw new Error()`
- `chunkTranslation.ts`: 失败时 `return { error: ... }`
- `background.ts`: 失败时 `sendResponse({ error: ... })` 但部分分支静默吞
- `cacheManager.ts`: 失败时 `try/catch` 静默返回 `null`

**方案**: 定义错误类型层级 + 统一处理策略。

```typescript
// src/utils/errors.ts
class TranslationError extends Error {
  constructor(
    message: string,
    public readonly code: 'API_ERROR' | 'PARSE_ERROR' | 'RATE_LIMIT' | 'NETWORK' | 'UNKNOWN',
    public readonly retryable: boolean = false,
  ) { super(message); }
}
```

**策略**:
- Background 层: catch 所有错误，转换为 `TranslationError`，通过 `sendResponse` 返回
- Content 层: 根据 `retryable` 决定是否重试
- 不可恢复错误: 直接向用户展示 `statusOverlay.show('error', message)`

**改动范围**: 渐进式。先在 `background.ts` 和 `translateApi.ts` 引入，再扩展到其他模块。

**风险**: 低。不改变用户可见行为，只改善错误信息质量。

---

### P8. 翻译中 AbortController

**现状**: 翻译进行中如果用户触发 SPA 跳转，`restore()` 会清理 DOM 标记，但后台正在跑的 chunk 翻译请求不会被 abort，API 调用和 token 消耗浪费。

**方案**:
```typescript
// translation.ts
private abortController: AbortController | null = null;

async start() {
  this.abortController = new AbortController();
  // 传递 signal 到 chunkTranslation
  await translateChunksViaBackground(chunks, ..., this.abortController.signal);
}

restore(silent?: boolean) {
  this.abortController?.abort();
  this.abortController = null;
  // ... 清理逻辑
}
```

`chunkTranslation.ts` 中每个 chunk 发送前检查 `signal.aborted`，已 abort 则不再发送。

**改动范围**: `translation.ts`、`chunkTranslation.ts`，约 20 行新增。

**风险**: 低。AbortController 是标准 API，行为可预期。

---

### P9. 缓存键碰撞检测

**现状**: `cacheKey.ts` 的 `simpleHash()` 是非加密哈希，理论上存在碰撞风险。当前无检测机制。

**方案**: 在缓存命中时做一次轻量校验。

```typescript
// cacheKey.ts
export interface CacheKey {
  key: string;
  checksum: string;  // 全文的前 50 + 后 50 字符
}

// 查询时
const cached = await getCachedTranslation(cacheKey.key);
if (cached && cached.checksum !== cacheKey.checksum) {
  // 碰撞！跳过缓存
  return null;
}
```

**改动范围**: `cacheKey.ts`、`cacheManager.ts`、`translateApi.ts`。

**风险**: 低。只影响缓存命中路径，碰撞时 fallback 到重新翻译。

**优先级**: 低。实际碰撞概率极低（64 位哈希 + prefixHash 双重保护），当前可不做。

---

### P10. 测试覆盖提升

**现状**: 核心模块（blockExtractor、serverTranslation）覆盖好，但以下场景缺测试：

| 缺失场景 | 风险 |
|---------|------|
| SPA 导航后的状态清理 | 已有 bug 反复出现 |
| 动态内容 observer 的 reapply | React 站点翻译丢失 |
| Readability fallback 触发条件 | 多 section 文章漏翻 |
| YouTube SPA 切视频清理 | 字幕残留 |
| 缓存 TTL 过期后重翻 | 旧译文被使用 |
| API 限流 (429) 重试逻辑 | 用户卡住 |

**方案**: 针对每个场景编写集成测试，使用真实 HTML fixture。

**改动范围**: 新增测试文件，不改动源码。

**风险**: 无。

---

## 3. 实施优先级

### Phase 1: 低风险、高收益（建议立即执行）

| 项 | 工作量 | 收益 |
|----|--------|------|
| P2. 删除死代码 floatingButton.ts | 小 | 消除混乱，减少打包体积 |
| P1. 消息层类型安全 | 中 | 编译期发现类型错误 |
| P3. 日志系统治理 | 中 | 生产环境性能 + 调试体验 |

### Phase 2: 中风险、中收益（建议下个迭代）

| 项 | 工作量 | 收益 |
|----|--------|------|
| P4. domObserver 规则统一 | 小 | 规则一致性，减少重复代码 |
| P7. Error Handling 统一 | 中 | 故障排查效率 |
| P8. 翻译中 AbortController | 小 | 减少 API 调用浪费 |
| P10. 测试覆盖提升 | 中 | 回归风险降低 |

### Phase 3: 高投入、长期收益（建议规划后执行）

| 项 | 工作量 | 收益 |
|----|--------|------|
| P5. contentDetector.ts 拆分 | 中 | 可维护性，需同步 vocal-saga |
| P6. 翻译状态管理改进 | 大 | 状态可追溯，但风险较高 |

### 暂不实施

| 项 | 原因 |
|----|------|
| P9. 缓存键碰撞检测 | 碰撞概率极低，当前 64 位哈希 + prefixHash 已足够 |

---

## 4. 架构演进方向（长期）

### 4.1 翻译 Provider 插件化

**现状**: 硬编码 DeepSeek + 服务端两种模式，provider 枚举写在 config 中。

**目标**: 支持多 LLM provider（OpenAI、Anthropic、Gemini），通过插件接口扩展。

```typescript
interface TranslationProvider {
  name: string;
  translate(request: TranslateRequest): AsyncGenerator<TranslateChunk>;
  validateApiKey(key: string): Promise<boolean>;
}
```

**收益**: 用户可选择不同 LLM，社区可贡献 provider 适配。

### 4.2 翻译质量反馈闭环

**现状**: 无翻译质量评估，不知道翻译好不好。

**目标**: 利用背景数据收集（无感），记录：
- chunk 重试次数（质量差 → 模型不确定）
- missing blocks 比例
- 译文 = 原文的 no-op 比例
- 用户手动恢复原文的频率

用轻量模型（如 Haiku）离线评估译文质量，生成训练标签。

### 4.3 Service Worker 持久化

**现状**: MV3 Service Worker 30 秒不活动会被终止，导致缓存丢失、翻译中断。

**目标**: 使用 `chrome.alarms` API 保持活跃，或将关键状态迁移到 `chrome.storage.session`。

### 4.4 流式翻译启用

**现状**: `translateChunkStream` 接口已预留但未启用。

**目标**: 启用流式翻译，让用户看到译文逐字出现，改善感知速度。需要在 `streamParser.ts` 和 `chunkTranslation.ts` 中接入 SSE 流式解析。
