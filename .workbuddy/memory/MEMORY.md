# 项目长期记忆 (fanyi-extension)

## 内容提取架构的设计哲学（用户明确声明，2026-08-12）
翻译内容的"Root Detection"与"Block Extraction"是两套**独立判定系统**，后者可在前者选定 root 后无声推翻（404media 即 `has-sidebar` 被 walker `FILTER_REJECT` 整棵杀掉）。用户对架构演化的硬性约束：

- **不要再往 `ARTICLE_SELECTORS` / `POSITIVE_TOKENS` / `NEGATIVE_TOKENS` 堆规则**。遇到新站点加 selector/token/exception 是短期变准、长期变难维护的 heuristic stack 陷阱。
- 下一步重心是 **Root/Extraction 职责边界** 与 **证据/置信度模型（evidence-driven）**，而非增加特例。
- 应建模的概念：`shouldSkipByClass` 需拆成 `nodeNoise`（节点自身是噪声）vs `subtreePrune`（子树该剪）vs `structuralContainer`（结构容器不应因 class 命中 noise 而被整棵剪）。`article`/`main` 的 FILTER_SKIP 只是这个语义的临时补丁。
- Root 判定应产出 `ContentRoot { root, source, confidence, evidence }` 契约，提升可观测性（debug 一个站点翻译失败能直接看出是 root 问题 / extraction 问题 / 翻译问题）。
- **双 walker 漂移是 #1 工程风险**：fanyi-extension 与 vocal-saga 的 blockExtractor 是独立副本，需共享 fixture 测试防语义漂移，长期目标是抽 shared content-extraction core。
- Readability 在 fanyi-extension 是 Layer2 主候选（非全局 primary detector，但 `detectArticleRoot` 先跑 `tryReadabilityRoot` 直接采用）。vocal-saga 仍保持 **provider competition**，但已升级为 **Readability-preferred**：不再固定 `+0.05`，改为基于 evidence 动态加权（mappingConfidence×contentCoverage 决定 +0.08~+0.20）+ dominance rule（高置信且分差≤0.15 优先）+ agreement boost（与 top root 重叠 +0.10）。**不**改 primary、也**不**简单调大常量。
- signature 单锚点定位的 collision 风险已解决（2026-08-11）：抽出共享 `readabilityRootMapper.ts`（多锚点 + DOM block + LCA + 内容覆盖率），fanyi 与 vocal-saga 逐字节相同，同时消灭了第三个分叉副本（旧 fanyi=includes / 旧 vocal-saga=Jaccard）。
- 两仓新增 `readabilityRootMapper.test.ts`（断言一致）与共享 `shared-walker.test.ts` 同一思路防漂移。

## 长文失效缺陷（2026-09-01 实测 → 2026-09-01 已修复 ✅）
`readabilityRootMapper.ts` 的 **`contentCoverage` 指标定义错误**：分子 = 命中的 5 个锚段落
textContent 之和，分母 = Readability 全文。覆盖率 ≈ 5×段长/全文，**与文章长度成反比**。
→ **正文超过约 5,000 字符时 Readability 主条件 100% 返回 null，静默退回手写评分。**
实测 info.deeplearning.ai（27,499 字符 / 85 段）：锚点合计 1,144 → coverage 0.042 < 0.3 → null。
兜底 `scoreElement` 又结构性偏好「零链接纯文本片段」（old3_ 0 链接 = 16989 分 vs
完整容器 main 40 链接 = 6343 分），最终只提取 9/116 blocks（3,793 / 32,331 字符）。

**修复（2026-09-01，双仓同步，逐字节相同）**：`contentCoverage` 重定义为「映射根是否装下整篇
正文」= `coverage`（rootTextLen / articleTextLength），删除旧的错误 `matchedTextLen` 字符和算法。
阈值常量 `minContentCoverage=0.3` 不变（用户明确"不要只调阈值"，修正指标定义才是病根）。
vocal-saga 的 Readability-preferred 规则（`scoring>=0.7` 加 0.2 分、`pipeline>=0.8` 触发
dominance）此前因长文 contentCoverage≈0.04 从不触发，修复后长文终于走 Readability-preferred。
回归测试：两仓 `readabilityRootMapper.test.ts` 各加一条 60 段长文用例（原文会返回 null，修复后
命中且 contentCoverage>=0.9）。端到端验证：deeplearning.ai 的 detectArticleRoot 从
`source:'scoring'`（old3_，14%）变为 `source:'readability'`（根文本 1.21×全文）。
**下钻 walker 仍把整段正文 0 块的问题属 table 布局坑（见下方"已知坑"），本次未动。**

## 已知坑（架构约束）
- **`table/tbody/tr/td/th` 在 `SKIP_SET`（整棵 `FILTER_REJECT`）**：对 table-layout 站点
  （HubSpot / Mailchimp / Substack 邮件归档页）致命。实测 `div.hse-body-background → table →
  tbody → tr` 全 0 块，只有 root 落到 `td` 或更深的 div 才恢复。→ 这类站点的 body-fallback
  路径彻底失效。修复方向：区分「数据表」（行列规整、单元格短文本，拒绝）与「布局表」
  （单列、td 内含 p/div 块级内容，降级 FILTER_SKIP 下钻）。
- **服务端翻译在 Firefox 失败，根因要分清两种模式（2026-08-15 生产日志实测更正）：**
  - *模式 A（已确认，来自生产报错日志）*：请求**确实到达**服务端（`POST /fanyi/page` → `translateChunks`），但 LLM 返回了坏 JSON。报错栈 `cleanResponse→repairJson→jsonrepair` 抛 `Colon expected at position ~6333`，是 **gemini provider 未强制 JSON 输出**导致某个 `translated_text` 结构损坏；当时 `cleanResponse` 无兜底 catch、下游也无故障隔离，单个坏 chunk 直接把整页翻译成 500。默认 provider 是 `deepseek`（`response_format: json_object` 强约束，极少坏 JSON）；用户把扩展 `config.provider` 设成 `gemini` 才触发。日志里 `client=Firefox/153.0 (Android...)` 只是 `clientInfo` 元数据，**不是根因**。修复（vocal-saga，2026-08-15）：gemini 加 `responseMimeType:'application/json'` 从源头杜绝；新增 `extractJsonContainer` 提升 jsonrepair 成功率；`processTranslationWithCheck`/`translateChunk` 改为容错降级（解析失败返回空 Map → 缺失重试/原样渲染，而非整请求 500）；空结果不写缓存。
  - *模式 B（仅假设，未在生产日志证实）*：Firefox content script 的 `fetch` 可能受页面 CSP `connect-src` 约束（Chrome 不受），表现为客户端 "网络请求失败 statusCode=0"、从未到达服务端。本地翻译已正确走 background（`runtime.sendMessage({action:'translateChunk'})`）；服务端翻译路径 `translateViaServer` 仍是 content script 直接 fetch。这条**尚未在真实 Firefox 上验证**，且用户贴的日志证明本次失败是模式 A（请求到了服务端），所以模式 B 是否为真需另行实测，**不要据此盲目改成 background 架构**。

## 约定
- 浏览器扩展改动需**重新加载扩展**生效（本地改动，非线上部署）。
- vocal-saga 改动需 `build:lib` + `deploy:cf` 才上线（wrangler OAuth 曾过期，需 `CLOUDFLARE_API_TOKEN` 或 `wrangler login`）。
- 截至 2026-08-15：两仓累积**未提交 git 改动**较多——vocal-saga 有 Readability-preferred（mapper/contentDetector/scoring/pipeline/types/readability provider + 新测试）**外加本轮翻译 JSON 容错改造**（shared.ts 的 extractJsonContainer、translateApi.ts 容错降级、pipeline.ts 故障隔离、gemini.ts 强制 JSON + deepseek.ts 不抛错）；fanyi-extension 有共享 mapper + ContentRoot + classifyNode + ADR 等。均尚未 commit/push，部署前需先提交并在 vocal-saga 跑 `build:lib` + `deploy:cf`。
