# 📋 浏览器翻译插件开发计划

## 一、项目概述

基于 FluentRead 的架构，创建一个支持 **Android Firefox / Firefox / Chrome** 的浏览器翻译插件，核心功能包括：
- 全文翻译（双语对照）
- 划词翻译
- 多翻译引擎支持
- 悬浮球快捷操作

## 二、技术栈选择

参考 FluentRead 的技术方案：
- **框架**: WXT (现代化浏览器扩展开发框架，支持多浏览器)
- **前端**: Vue 3 + TypeScript
- **UI 组件**: Element Plus
- **构建工具**: Vite
- **存储**: @wxt-dev/storage

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
   ├── entrypoints/
   │   ├── background.ts        # 后台脚本
   │   ├── content.ts           # 内容脚本
   │   ├── popup/               # 弹出页面
   │   │   ├── App.vue
   │   │   ├── index.html
   │   │   └── main.ts
   │   ├── service/             # 翻译服务
   │   │   ├── microsoft.ts
   │   │   ├── google.ts
   │   │   ├── deepl.ts
   │   │   └── _service.ts
   │   └── utils/               # 工具函数
   │       ├── config.ts
   │       ├── constant.ts
   │       └── translateApi.ts
   ├── components/              # Vue 组件
   │   ├── FloatingBall.vue
   │   ├── SelectionTranslator.vue
   │   └── TranslationStatus.vue
   ├── public/
   │   └── icon/               # 插件图标
   ├── styles/
   │   └── theme.css
   ├── wxt.config.ts           # WXT 配置
   ├── package.json
   └── tsconfig.json
   ```

### 阶段 2: 核心功能开发 (约 2-3 小时)

4. **配置管理系统**
   - 创建配置模型 (Config)
   - 实现配置存储（使用 @wxt-dev/storage）
   - 配置验证与默认值

5. **翻译服务层**
   - 实现翻译服务接口
   - 只需要集成deepseek翻译api
   - 翻译队列管理（并发控制）
   - 缓存机制

6. **后台脚本 (background.ts)**
   - 处理翻译 API 请求（解决 CORS 问题）
   - 右键菜单管理
   - 标签页状态管理
   - 消息通信

7. **内容脚本 (content.ts)**
   - DOM 节点识别与提取
   - 翻译结果注入
   - 双语对照显示
   - 原文恢复功能
   - IntersectionObserver 实现懒加载翻译

### 阶段 3: UI 组件开发 (约 2 小时)

8. **悬浮球组件 (FloatingBall.vue)**
   - 可拖拽定位
   - 点击触发全文翻译
   - 快捷键支持
   - 位置记忆

9. **划词翻译组件 (SelectionTranslator.vue)**
   - 文本选择监听
   - 翻译弹窗显示
   - 一键复制译文
   - 双语/仅译文模式切换

10. **弹出页面 (popup/)**
    - 开关控制
    - 翻译引擎选择
    - 源语言/目标语言设置
    - 翻译模式选择（双语/仅译文）
    - API Key 配置
    - 快捷键设置

11. **翻译状态组件 (TranslationStatus.vue)**
    - 翻译进度显示
    - 错误提示
    - 重试机制

### 阶段 4: 高级功能 (约 1-2 小时)

12. **快捷键系统**
    - 鼠标悬停翻译
    - 双击翻译
    - 长按翻译
    - 自定义快捷键

13. **移动端支持**
    - 触摸事件处理
    - 多指手势翻译
    - Android Firefox 特殊适配

14. **性能优化**
    - 翻译任务队列
    - 并发控制
    - 节流防抖
    - 缓存策略

### 阶段 5: 测试与打包 (约 1 小时)

15. **测试**
    - Chrome 浏览器测试
    - Firefox 浏览器测试
    - Android Firefox 测试
    - 不同网站兼容性测试

16. **打包发布**
    - Chrome 扩展打包
    - Firefox 扩展打包
    - 生成安装包

## 四、核心特性对比

| 特性 | FluentRead | 我们的插件 |
|------|-----------|-----------|
| 多浏览器支持 | ✅ Chrome, Edge, Firefox | ✅ Chrome, Firefox, Android Firefox |
| 翻译引擎 | 20+ 种 | 初期支持 3-5 种主流引擎 |
| 全文翻译 | ✅ | ✅ |
| 划词翻译 | ✅ | ✅ |
| 双语对照 | ✅ | ✅ |
| 悬浮球 | ✅ | ✅ |
| 右键菜单 | ✅ | ✅ |
| 快捷键 | ✅ | ✅ |
| 移动端支持 | ⚠️ 部分 | ✅ 完整支持 Android Firefox |
| 缓存 | ✅ | ✅ |

## 五、关键技术点

### 1. Android Firefox 兼容性
- 使用 Manifest V2（Android Firefox 支持更好）
- 触摸事件优化
- 响应式 UI 设计

### 2. 翻译引擎选择
- 优先使用微软翻译（免费，无需 API Key）
- 支持用户自定义 API Key
- 支持本地部署翻译服务

### 3. 性能优化
- 使用 IntersectionObserver 实现可视区域翻译
- 翻译任务队列控制并发
- 智能缓存减少重复翻译

## 六、开发优先级

### P0 (核心功能，必须实现)
- [ ] 基础项目结构
- [ ] 微软翻译集成
- [ ] 全文翻译
- [ ] 划词翻译
- [ ] 悬浮球

### P1 (重要功能)
- [ ] 多翻译引擎支持
- [ ] 双语对照显示
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

1. 初始化 WXT 项目
2. 安装必要依赖
3. 创建基础项目结构
4. 实现微软翻译服务
5. 开发核心翻译功能
