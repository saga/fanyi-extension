# 术语表提取优化：从 Background Script 迁移到 Content Script

## 背景

在浏览器扩展的翻译流程中，术语表提取是一个关键的前置步骤。它负责识别文本中的专业术语、缩写词和命名实体，确保翻译结果中这些术语能够被一致地处理。

## 修改概述

将术语表提取逻辑从 **Background Script** 迁移到 **Content Script**，消除了一次跨进程通信（Message Passing）的往返延迟。

## 修改前架构

```
┌─────────────────┐     sendMessage      ┌──────────────────┐
│  Content Script │ ───────────────────> │ Background Script│
│                 │                      │                  │
│  1. 提取文本     │                      │  3. 调用         │
│  2. 收集强调术语  │                      │    extractGlossaryLocal()
│                 │     sendResponse     │  4. 返回术语表    │
│                 │ <─────────────────── │                  │
└─────────────────┘                      └──────────────────┘
```

### 执行流程

1. Content Script 提取页面文本和强调术语（em/strong/code 标签内容）
2. Content Script 通过 `browser.runtime.sendMessage()` 发送请求到 Background Script
3. Background Script 调用 `extractGlossaryLocal()` 进行 NLP 处理
4. Background Script 通过 `sendResponse()` 返回术语表
5. Content Script 收到术语表后，继续执行翻译流程

### 存在的问题

- **延迟开销**：`sendMessage` 是异步跨进程通信，存在往返延迟（通常 5-20ms，在 Android Firefox 上可能更长）
- **不必要的复杂度**：Background Script 仅作为"透传层"，没有实际业务逻辑需要运行在后台
- **资源浪费**：Background Script 需要维护消息处理器和错误处理逻辑

## 修改后架构

```
┌─────────────────────────────────────────────┐
│              Content Script                  │
│                                              │
│  1. 提取文本                                  │
│  2. 收集强调术语                               │
│  3. 直接调用 extractGlossaryLocal()           │
│  4. 继续执行翻译流程                           │
└─────────────────────────────────────────────┘
```

### 执行流程

1. Content Script 提取页面文本和强调术语
2. Content Script **直接**调用 `extractGlossaryLocal()` 进行 NLP 处理
3. 获得术语表后，立即继续执行翻译流程

## 代码变更

### Content Script (`src/entrypoints/content.ts`)

**新增导入：**

```typescript
import { extractGlossaryLocal } from './utils/glossaryExtractor';
```

**修改前（通过 Background Script）：**

```typescript
const glossaryResponse = await browser.runtime.sendMessage({
  action: 'extractGlossary',
  fullText: glossarySample,
  emphasizedTerms,
});
if (glossaryResponse.success && glossaryResponse.glossary?.length > 0) {
  glossary = glossaryResponse.glossary;
}
```

**修改后（直接调用）：**

```typescript
glossary = extractGlossaryLocal(glossarySample, emphasizedTerms);
```

### Background Script (`src/entrypoints/background.ts`)

**移除导入：**

```typescript
// 已移除
// import { extractGlossaryLocal } from './utils/glossaryExtractor';
```

**移除消息处理器：**

```typescript
// 已移除
} else if (message.action === 'extractGlossary') {
  await handleExtractGlossary(message, sendResponse);
```

**移除处理函数：**

```typescript
// 已移除整个 handleExtractGlossary 函数
```

## 性能影响

| 指标 | 修改前 | 修改后 | 提升 |
|------|--------|--------|------|
| 通信延迟 | 5-20ms（sendMessage 往返） | 0ms | 消除 |
| 代码行数 | Background: +32, Content: +18 | Background: -32, Content: -13 | 简化 |
| 执行顺序 | 异步等待 | 同步执行 | 不变 |

## 为什么保持串行执行？

虽然可以进一步将术语表提取与翻译并行化（即不等术语表完成就开始翻译第一个 chunk），但本次修改**有意保持串行**：

1. **简单可靠**：串行逻辑易于理解和维护
2. **术语一致性**：所有 chunk 都使用同一份术语表，避免第一个 chunk 没有术语约束而后续 chunk 有
3. **性能足够**：`extractGlossaryLocal` 处理 4000 字符文本的性能在 200ms 以内（见性能测试），对整体翻译时间影响有限

## 适用场景

此优化适用于以下情况：

- 计算逻辑不依赖后台权限或跨域能力
- 计算量适中（如 NLP 处理 < 500ms）
- 需要减少异步通信带来的延迟
- 希望简化架构，减少不必要的中间层

## 注意事项

1. **Content Script 资源限制**：Content Script 运行在页面上下文中，如果计算量过大可能影响页面响应。术语表提取处理 4000 字符文本在 200ms 以内，属于合理范围。

2. **代码体积**：`compromise` NLP 库现在会被打包到 Content Script 中。但由于本来就是 `compromise/two`（最小版本），体积增加有限。

3. **Background Script 仍然有用**：虽然术语表提取移除了，但 Background Script 仍然负责：
   - API 调用（DeepSeek 翻译服务）
   - 缓存管理
   - 配置验证
   - 上下文菜单和快捷键（桌面端）
