# ADR-002: Local Agent 文档业务数据由服务端唯一持久化

- 状态：Accepted
- 日期：2026-10-31
- 关联仓库：[saga/vocal-saga](https://github.com/saga/vocal-saga)
- 服务端对应决策：[ADR-0003：Local Agent 项目数据唯一服务端持久化](https://github.com/saga/vocal-saga/blob/main/docs/adr/0003-server-authoritative-project-state.md)

## 背景

历史文档阅读器曾把解析后的文档、原文、译文、阅读状态和 LiteraryMemory 写入扩展 IndexedDB，同时又把项目数据保存到 Local Agent SQLite。后续虽然将 Server 定义为权威来源，但仍保留扩展快照恢复、双写和服务不可用时回退路径，造成两份可恢复的业务状态以及额外的一致性问题。

这不是目标架构。Local Agent 模式下，扩展是 UI 和浏览器适配层；所有文档业务数据必须由 `local-agent-service` 管理和持久化。扩展可以在当前页面内存中持有响应式数据用于渲染和编辑，但不能把它写入 IndexedDB、扩展 storage 或其他浏览器持久化介质作为业务副本。

## 决策

1. **Server 是唯一业务持久化边界。** Local Agent 项目的原始文件、来源版本、解析片段、已采纳译文、人工修订、候选译文、审校结果、Prompt revisions、Context Graph、LiteraryMemory revisions、Runs、事件和质量审计全部由本机服务持久化。
2. **扩展只保留运行时 UI 投影。** LiteraryMemory、Context Graph 状态、译文和文档片段可以在 Vue 响应式状态中短暂存在；用户编辑必须提交 Server API，只有服务端成功提交后才视为保存成功。扩展不得将这些业务对象写入 IndexedDB、`chrome.storage`、localStorage 或其他浏览器持久化存储。
3. **阅读恢复记录也由 Server 保存。** 阅读位置、当前 Tab、视图模式、语言方向等轻量恢复元数据写入本机服务的 reader-session 记录，并关联 `projectId`。reader session 只能保存轻量引用和 UI 元数据，不得复制原文、完整译文、LiteraryMemory 或 Context Graph。
4. **项目内容只能从项目 API 恢复。** 恢复时先读取服务端 reader-session pointer，再通过项目 API 读取来源、分页片段、已采纳译文、文学记忆和 Run 状态。项目数据库是业务事实来源；reader session 不是第二份项目数据。
5. **服务不可用时 fail closed。** 不得回退到扩展 IndexedDB 中的旧 LiteraryMemory、译文或全文快照，不得把未提交的 UI 草稿显示为已保存。应明确提示服务不可用，当前页面内存数据不具备持久化保证；服务恢复后重新从 Server 加载。
6. **旧 IndexedDB 数据只允许清理，不允许作为新权威来源。** 当服务端项目已成功恢复或创建后，可以清理旧版本遗留的扩展文档快照。不得自动把旧快照回灌到已有项目。确需迁移的旧数据必须通过单独、可审计的显式迁移流程，并校验来源指纹及人工修订保护。
7. **项目映射仅是定位缓存。** 扩展可以保存 project ID 与来源身份映射，以便快速定位项目；映射不包含业务数据，不得用于替代 Server 查询。映射缺失或过期时调用 `POST /api/documents/projects/resolve`；服务不可达、鉴权失败或超时不能被解释为项目不存在。
8. **Local Agent 与非 Local Agent 模式必须分开。** 本 ADR 约束启用 Local Agent 的文档项目工作流。非 Local Agent 的轻量兼容路径不得把其浏览器缓存冒充为 Local Agent 项目状态，也不得向 Local Agent 项目回灌旧快照。

## LiteraryMemory 与 Context Graph 的边界

- Context Graph 是服务端全书分析事实，包括节点、边、原文证据、章节摘要、分析版本和运行状态。
- LiteraryMemory 是服务端维护的可编辑翻译投影，包括规范译名、人物声音、关系规则、文风基准、声音锚点及拒绝 tombstone。
- 两者是不同的业务模型，但都只在服务端持久化。扩展可以读取 LiteraryMemory DTO 并在页面内编辑；所有变更通过服务端版本化 API 保存。
- 人物、实体、关系的删除/拒绝必须通过服务端原子操作同时更新 Context Graph review 状态与 LiteraryMemory revision。失败时恢复当前页面的编辑投影，不写入本地副本。
- Run 必须固定引用创建时的 source revision、Prompt revision 和 LiteraryMemory revision；后续编辑不能改变既有 Run 的输入快照。

## EPUB/PDF 原始文件与解析

- Local Agent 模式下，EPUB/PDF 原始文件通过 `POST /api/documents/projects/import-file` 发送给本机服务，由服务端负责解析、分段、来源版本管理和持久化。
- 扩展只读取分页结构化片段用于 UI 展示，不保存全书解析副本。
- 来源更新必须通过原始文件上传和服务端 revision 流程完成；不能仅凭文件名或标题复用旧译文。
- 原始文件大小、展开体积和解析超时由服务端配置控制，不通过在扩展 IndexedDB 中保存整本书来绕过请求限制。

## 实施要求

- Local Agent 模式的文档打开、恢复、进度保存、文学记忆编辑和清除阅读位置均不得调用扩展 IndexedDB 文档会话存储。
- `persistCurrentSession` 只提交 Server reader-session pointer；不得把 `snapshot.literaryMemory`、全文、译文 delta 或 Context Graph 放入 reader-session payload。
- 文学记忆编辑器不得先调用扩展 `persistSession()` 再调用 Server API；Server API 成功响应是唯一保存确认。
- Server API 失败时保留页面内存中的未提交编辑并显示错误；不得把它写入本地持久化层或自动重试到另一事实来源。
- 项目打开/恢复时，Server 不可用必须明确失败，不能使用旧 IndexedDB 快照静默恢复。
- 增加回归测试：Local Agent 模式不读写 IndexedDB；LiteraryMemory 编辑只调用 Server API；服务端失败不会写本地副本；清空浏览器 IndexedDB 后仍能从 Server 恢复完整项目；清理旧快照不会删除 Server 项目数据。
- 修改本 ADR 时同步检查 Vocal Saga ADR-0003、两个仓库的 AGENTS 文档、CROSS_PROJECT_SYNC 和 Local Agent README。
