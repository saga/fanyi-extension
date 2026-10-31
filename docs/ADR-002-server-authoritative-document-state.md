# ADR-002: Local Agent 项目状态以服务端为权威

- 状态：Accepted
- 日期：2026-10-18
- 关联仓库：[devweekly/vocal-saga](https://github.com/devweekly/vocal-saga)
- 服务端对应决策：[ADR-0003：服务端项目权威与扩展离线副本](https://github.com/devweekly/vocal-saga/blob/main/docs/adr/0003-server-authoritative-project-state.md)

## 背景

文档阅读器会把当前阅读位置、译文和文学记忆保存到扩展 IndexedDB，并可能另存一份 Local Agent SQLite 会话检查点。这些记录用于快速恢复和离线连续性，但它们不是 Local Agent 文档项目的第二个事实来源。浏览器记录可能缺失、落后或来自旧版本；如果打开文档时用它覆盖服务端 Prompt、译文或记忆，就会抹掉更新过的人工修订与运行结果。若扩展映射清失或过期后直接新建项目，也会形成重复项目。

## 决策

1. **服务端优先，扩展副本从属。** Local Agent 可用并找到匹配项目时，扩展必须从服务端刷新项目、来源版本、已采纳译文、文学记忆、运行状态和轨迹。刷新页面、重新打开文档以及进入 Agent Workspace 都不得仅凭扩展缓存认定服务端状态。
2. **映射是缓存，不是目录。** 扩展的 project ID 映射只能用作快速查找。映射缺失或指向已删除项目时，扩展调用 `POST /api/documents/projects/resolve`，先按标准化原文指纹寻找精确项目；不能把文件名/标题相似误当作原文相同。
3. **来源不同不自动合并。** 精确指纹匹配才允许同步译文；文件身份/标题相近但来源指纹不同，只显示来源变化并要求用户显式更新来源版本或另建项目。不得将旧译文映射到新原文。
4. **读取现有项目时不回灌扩展快照。** 普通打开、恢复、项目发现和 Run 创建，不得把本地缓存译文、Prompt 或文学记忆再提交至已存在的服务端项目。只有明确的新建项目迁移或显式用户更改才能执行对应写操作。Run 创建只提交范围等执行参数，使用项目在服务端保存的当前 Prompt；用户点击“保存 Prompt”或显式调整项目语言/模式时，才同步相应 Prompt 修订。
5. **离线副本只用于服务不可用时恢复。** 服务不可达、鉴权失败或超时不能被解释为“项目不存在”，也不能触发重复新建。扩展可以继续显示最后一次同步的本地副本，并提示其可能过期；服务恢复后必须重新解析并以服务端状态刷新本地副本。

6. **本机 EPUB/PDF 原始文件由 Local Agent 解析。** 当 Local Agent 开启时，扩展上传原始二进制到 `POST /api/documents/projects/import-file`，不把浏览器解析后的全书片段通过 JSON 发送到项目创建/resolve 接口。扩展仅将分页读回的片段用于 UI 展示。更新来源版本也上传原始文件，由服务端解析并建立新 revision。
7. **SQLite 阅读器检查点只存轻量引用。** 服务端项目已是原文、译文、文学记忆及 Run 状态的权威存储；通用 reader session 只保存 `projectId`、阅读位置和轻量设置。不得再向通用会话表复制全书正文、全量译文和 LiteraryMemory。旧版全量快照只为恢复兼容。
8. **文件大小和 JSON 大小分开治理。** 原始文件使用二进制请求和 `LOCAL_AGENT_MAX_DOCUMENT_SOURCE_MB` 配置（默认 512 MiB）；展开体积与 PDF 提取时间另有服务端上限。不得因为普通 JSON API 的请求体限制，改为在扩展端解析整本 EPUB/PDF。

## 文学翻译的预处理状态协作

文学翻译采用“扩展前置检查 + 服务端最终执行门禁”，但 Context Graph 事实始终只有服务端一份：

- 扩展通过服务端轻量 status DTO 核对当前 source revision、服务端 analysis version、source/target language、有效样本、style completeness 和 B 工作流阶段。只有通过才开放创建文学 Run。
- 从未分析的当前来源版本可由扩展自动触发一次预处理；失败、过期或语言设置变化后由用户显式重新分析。未知状态和状态读取错误一律不视为 ready。
- Local Agent 的 executeRun 在进入 running 前再次校验。旧客户端或直接 API 可能先产生 queued Run，但服务端在 readiness 通过前不得开始翻译模型调用。
- 技术文档模式不要求文学 Context Graph。扩展只保留状态投影，不复制节点、边、原文证据和章节摘要。

服务端的完整决策见 [ADR-0005](https://github.com/saga/vocal-saga/blob/main/docs/adr/0005-literary-preprocessing-before-translation.md)。

## 实施要求

- 项目发现、打开文档、IndexedDB 恢复和 Local Agent 服务检查都需复用同一个服务端解析与同步契约。
- 新增或修改同步逻辑时，为精确指纹匹配、缺失映射、过期映射、来源变化、服务离线、鉴权失败和服务端译文优先级增加回归测试。
- 扩展端不得复制服务端的项目指纹或维护一套独立的合并决策。源版本、译文优先级和运行生命周期仍由 Local Agent 管理。
