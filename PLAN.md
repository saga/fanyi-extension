# 📋 浏览器翻译插件开发计划

## 一、项目概述

基于 FluentRead 的架构，创建一个支持 **Android Firefox / Firefox / Chrome** 的浏览器翻译插件。

**核心理念：Document-level Translation（文档级翻译）**

区别于传统插件的逐段翻译，本插件采用文档级翻译方案：
- 提取网页结构化内容，构建 Block Tree
- 合并请求，一次发送完整上下文给 LLM
- 术语一致性保障（全局术语表 + 滑动上下文）
- 双语对照显示，不破坏原页面布局

**核心功能：**
- 全文翻译（双语对照，文档级翻译）
- 划词翻译
- DeepSeek LLM 翻译引擎
- 悬浮球快捷操作

## 二、技术栈选择

- **框架**: WXT (现代化浏览器扩展开发框架，支持多浏览器)
- **前端**: Vue 3 + TypeScript
- **UI 组件**: Element Plus
- **构建工具**: Vite
- **存储**: @wxt-dev/storage
- **内容提取**: Mozilla Readability
- **HTML 清理**: DOMPurify
- **XML 解析**: fast-xml-parser
- **Token 计算**: tiktoken (或简易估算)

## 三、详细开发计划

### 阶段 1: 项目初始化与基础配置 (约 30 分钟)

1. **初始化 WXT 项目**
   - 安装 WXT CLI
   - 创建项目结构
   - 配置 TypeScript
   - 配置 Vue 3 支持

2. **配置多浏览器支持**
   - Chrome 配置
   - Firefox 配置
   - Android Firefox 特殊配置（manifest v2/v3 兼容）

3. **设置项目结构**
   ```
   fanyi-extension/
   ├── src/
   │   ├── entrypoints/
   │   │   ├── background.ts        # 后台脚本 (chunk orchestration, API queue, cache)
   │   │   ├── content.ts           # 内容脚本 (DOM 抽取, block mapping, UI render)
   │   │   ├── popup/               # 弹出页面
   │   │   │   ├── App.vue
   │   │   │   ├── index.html
   │   │   │   │   └── main.ts
   │   │   ├── service/             # 翻译服务
   │   │   │   ├── deepseek.ts      # DeepSeek LLM API
   │   │   │   └── _service.ts      # 翻译服务接口
   │   │   └── utils/               # 工具函数
   │   │       ├── config.ts        # 配置管理
   │   │       ├── constant.ts      # 常量定义
   │   │       ├── translateApi.ts  # 翻译 API 调用
   │   │       ├── blockExtractor.ts # DOM Block 抽取
   │   │       ├── chunkBuilder.ts  # Chunk 构建器
   │   │       └── xmlParser.ts     # XML 解析
   │   ├── components/              # Vue 组件
   │   │   ├── FloatingBall.vue
   │   │   ├── SelectionTranslator.vue
   │   │   └── TranslationStatus.vue
   │   ├── public/
   │   │   └── icon/               # 插件图标
   │   └── styles/
   │       └── theme.css
   ├── wxt.config.ts
   ├── package.json
   └── tsconfig.json
   ```

### 阶段 2: 核心功能开发 (约 2-3 小时)

4. **配置管理系统**
   - 创建配置模型 (Config)
   - 实现配置存储（使用 @wxt-dev/storage）
   - 配置验证与默认值
   - DeepSeek API Key 配置

5. **内容抽取与 Block 模型**
   - 集成 Mozilla Readability 提取正文
   - 构建 TextBlock 模型：
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
   - DOM 节点映射 (idToDomNode, WeakMap<Node, BlockId>)
   - MutationObserver 监听动态内容变化

6. **Chunk 构建策略**
   - 按 token budget 的语义 chunk（非按段切分）
   - 保留结构边界（不拆 h2 section, table, code block）
   - 目标 token 数: ~10000, 最大: ~12000
   - XML 格式包装：
     ```xml
     <DOC>
       <BLOCK id="b1">标题</BLOCK>
       <BLOCK id="b2">正文内容</BLOCK>
     </DOC>
     ```

7. **翻译服务层 (DeepSeek)**
   - 实现 DeepSeek LLM API 集成
   - 两阶段翻译：
     - Stage 1: 全文分析（术语抽取、风格、主题、领域）
     - Stage 2: 正式翻译（带术语表 + 滑动上下文）
   - Prompt 构建（XML 结构约束 + 术语表 + 文档上下文）
   - 翻译队列管理（并发控制）
   - 缓存机制（sha256(url + normalizedContent) 作为 cache key）

8. **后台脚本 (background.ts)**
   - 处理 DeepSeek API 请求（解决 CORS 问题）
   - Chunk orchestration 与 API queue
   - 右键菜单管理
   - 标签页状态管理
   - 消息通信

9. **内容脚本 (content.ts)**
   - DOM 抽取与 Block 映射
   - 翻译结果 DOM Rehydration
   - 双语对照显示（wrapper 方式，不直接修改原 DOM）
   - 原文恢复功能
   - IntersectionObserver 实现懒加载翻译

### 阶段 3: UI 组件开发 (约 2 小时)

10. **悬浮球组件 (FloatingBall.vue)**
    - 可拖拽定位
    - 点击触发全文翻译
    - 快捷键支持
    - 位置记忆

11. **划词翻译组件 (SelectionTranslator.vue)**
    - 文本选择监听
    - 翻译弹窗显示
    - 一键复制译文
    - 双语/仅译文模式切换

12. **弹出页面 (popup/)**
    - 开关控制
    - DeepSeek API Key 配置
    - 源语言/目标语言设置
    - 翻译模式选择（双语/仅译文）
    - 快捷键设置

13. **翻译状态组件 (TranslationStatus.vue)**
    - 翻译进度显示
    - 错误提示
    - 重试机制

### 阶段 4: 高级功能 (约 1-2 小时)

14. **快捷键系统**
    - 鼠标悬停翻译
    - 双击翻译
    - 长按翻译
    - 自定义快捷键

15. **移动端支持**
    - 触摸事件处理
    - 多指手势翻译
    - Android Firefox 特殊适配

16. **性能优化**
    - 翻译任务队列
    - 并发控制
    - 节流防抖
    - 缓存策略

### 阶段 5: 测试与打包 (约 1 小时)

17. **测试**
    - Chrome 浏览器测试
    - Firefox 浏览器测试
    - Android Firefox 测试
    - 不同网站兼容性测试

18. **打包发布**
    - Chrome 扩展打包
    - Firefox 扩展打包
    - 生成安装包

## 四、核心特性对比

| 特性 | FluentRead | 传统插件 | 我们的插件 |
|------|-----------|---------|-----------|
| 多浏览器支持 | ✅ Chrome, Edge, Firefox | ⚠️ 单一 | ✅ Chrome, Firefox, Android Firefox |
| 翻译引擎 | 20+ 种 | 传统 API | DeepSeek LLM |
| 翻译方式 | 逐段 | 逐段 | **文档级翻译** |
| 术语一致性 | ⚠️ 部分 | ❌ 无 | ✅ 全局术语表 |
| 上下文连贯 | ⚠️ 部分 | ❌ 无 | ✅ 滑动上下文窗口 |
| 全文翻译 | ✅ | ✅ | ✅ |
| 划词翻译 | ✅ | ✅ | ✅ |
| 双语对照 | ✅ | ✅ | ✅ |
| 悬浮球 | ✅ | ⚠️ 部分 | ✅ |
| 右键菜单 | ✅ | ✅ | ✅ |
| 快捷键 | ✅ | ⚠️ 部分 | ✅ |
| 移动端支持 | ⚠️ 部分 | ❌ | ✅ 完整支持 Android Firefox |
| 缓存 | ✅ | ⚠️ 部分 | ✅ sha256 内容哈希 |

## 五、关键技术点

### 1. 文档级翻译架构
```
网页 DOM → Readability → Block Tree → Normalize → Chunk Builder → LLM → XML Result → DOM Rehydration → 双语渲染
```

### 2. XML 结构约束
- 使用 XML-like 格式包装内容，LLM 对这种结构最稳定
- 强约束：保持 BLOCK IDs 不变、不合并块、只返回有效 XML
- 避免纯文本导致的段落合并/拆分/顺序改变问题

### 3. 术语一致性保障
- Stage 1 全文分析抽取术语表
- 所有 chunk 翻译时携带术语表
- 滑动上下文窗口（chunk summary + glossary + heading hierarchy）

### 4. DOM 映射稳定性
- 不直接修改原 DOM，使用 wrapper 方式
- 为每个 block 建立 WeakMap<Node, BlockId>
- MutationObserver 监听动态内容变化
- 只处理 p, li, blockquote, h1-h6, td 等文本节点，忽略 button, nav, code, svg, textarea

### 5. Android Firefox 兼容性
- 使用 Manifest V2（Android Firefox 支持更好）
- 触摸事件优化
- 响应式 UI 设计

### 6. 性能优化
- 使用 IntersectionObserver 实现可视区域翻译
- 翻译任务队列控制并发
- 智能缓存减少重复翻译（sha256(url + normalizedContent)）

## 六、开发优先级

### P0 (核心功能，必须实现)
- [ ] 基础项目结构
- [ ] DeepSeek LLM 集成
- [ ] Block 抽取与 Chunk 构建
- [ ] 文档级全文翻译
- [ ] 双语对照显示
- [ ] 悬浮球

### P1 (重要功能)
- [ ] 术语表与上下文连贯
- [ ] 划词翻译
- [ ] 配置管理
- [ ] 快捷键

### P2 (增强功能)
- [ ] 缓存机制
- [ ] 翻译状态显示
- [ ] 右键菜单
- [ ] 移动端手势

### P3 (可选功能)
- [ ] 自定义主题
- [ ] 翻译历史
- [ ] 高级配置

## 七、参考资源

- FluentRead 源码: `/temp/FluentRead-main/`
- WXT 官方文档: https://wxt.dev/
- Vue 3 文档: https://vuejs.org/
- Element Plus 文档: https://element-plus.org/
- Mozilla Readability: https://github.com/mozilla/readability
- Browser Extension API: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions

## 八、开发时间估算

| 阶段 | 预计时间 | 说明 |
|------|---------|------|
| 阶段 1 | 30 分钟 | 项目初始化 |
| 阶段 2 | 2-3 小时 | 核心功能 |
| 阶段 3 | 2 小时 | UI 组件 |
| 阶段 4 | 1-2 小时 | 高级功能 |
| 阶段 5 | 1 小时 | 测试打包 |
| **总计** | **6-8 小时** | 完整开发周期 |

## 九、下一步行动

1. 初始化 WXT 项目 ✅
2. 安装必要依赖 ✅
3. 创建基础项目结构 ✅
4. 实现 Block 抽取与 Chunk 构建
5. 集成 DeepSeek LLM API
6. 实现文档级翻译流程
