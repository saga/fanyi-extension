# ADR-001：内容提取架构演进路线图

- **状态**：已对齐（2026-08-12）
- **参与者**：用户（架构主张）、助手（补充与落地）
- **关联文档**：[`TRANSLATION_FLOW_AND_READABILITY.md`](./TRANSLATION_FLOW_AND_READABILITY.md)（当前架构描述）

---

## 1. 背景与动机

翻译内容提取目前是「四层 root 检测 + walker 块提取」架构（详见关联文档）。它能处理绝大多数站点，但维护方式开始偏向 **"遇到新站点 → 加 selector / token / exception"**。这种 heuristic 堆叠模式长期会导致：

- **规则相互打架**：A 站点的 token 误伤 B 站点。
- **regression 驱动维护**：修一个站点炸另一个。
- **调试困难**：一个站点不翻译，无法快速定位是 root 选错、还是 extraction 杀掉、还是翻译/回插问题。

**404media 案例**（`<article class="post ... has-sidebar">` 被 walker 整棵 `FILTER_REJECT`）是最典型的"架构层面"而非"代码写错"的问题：Root Detector 选中了正确的 `<article>`，但 Block Extractor 用一套**独立**的 heuristic（noise class）把它无声推翻了。

---

## 2. 核心论断

> **Root Detection 与 Block Extraction 是两套独立的判定系统。**
> 当前系统实际不是"找到正文 → 提取正文"，而是"找到一个候选区域 → 再由另一套独立 heuristic 决定里面什么能活"。

因此下一步重点是**厘清两者的职责边界**与**引入证据/置信度模型**，而不是继续增加 selector / token / 特例。

---

## 3. 决策原则（硬性约束）

1. **停止 heuristic 堆叠**：不再往 `ARTICLE_SELECTORS` / `POSITIVE_TOKENS` / `NEGATIVE_TOKENS` 堆规则。新站点问题优先用结构性 / 证据性手段解决。
2. **建模而非打补丁**：`shouldSkipByClass` 当前混淆了两个语义——"节点自身是噪声" vs "节点子树该被剪掉"。应显式拆为 `nodeNoise` / `subtreePrune` / `structuralContainer`（article/main 等结构容器不应因 class 命中 noise token 被整棵剪枝）。当前 `article/main → FILTER_SKIP` 只是这个语义的临时补丁。
3. **证据驱动（evidence-driven）**：Root 判定产出 `ContentRoot` 契约，携带 `source` / `confidence` / `evidence`，逐步从"闸门式 if/reject"演进为"评分式证据融合"。
4. **可观测性优先**：先有证据，再谈融合。一个站点不翻译时，应能直接看出 root 问题 / extraction 问题 / 翻译问题 / 回插问题。
5. **消除双 walker 漂移**：fanyi-extension 与 vocal-saga 的 `blockExtractor` 是独立副本，必须共享 fixture 测试，长期抽 shared content-extraction core。

---

## 4. 分阶段路线图

### P0 — `ContentRoot` 契约（零风险，先做）

`findArticleRoot` / `detectArticleRoot` 返回 `ContentRoot` 而非裸 `Element`：

```ts
interface ContentRoot {
  element: Element;
  source: 'site-rule' | 'selector' | 'readability' | 'scoring' | 'body-fallback';
  confidence: number;
  evidence: {
    textLength: number;
    readabilityCoverage?: number;  // Readability 定位时的覆盖率
    semanticScore?: number;        // 评分算法得分
    noiseDensity?: number;         // 子树噪声密度
  };
}
```

- 各 Layer 产出 root 时附带 `source` 与 `evidence`；`confidence` 给合理初值。
- `prepareDocument` 用 `.element` 继续走 `expandRootForHeader` / `extractBlocks`，调用方零破坏性。
- **收益**：立刻获得 debug 能力（`root source=readability confidence=0.91 ...`）；为后续融合提供数据结构。

### P0 — noise / subtree 语义分离

- 将 `shouldSkipByClass` 演进为 `classifyNode()`，区分 `nodeNoise` / `subtreePrune` / `structuralContainer`。
- 不再靠 `if tag===article` 开特例，而是"结构性容器不因子树外的 class 被整棵剪枝"。
- 与 `ContentRoot` 可并行推进。

### P1 — Readability 多锚点定位 ✅（已落地 2026-08-11）

- 将单 signature 首匹配，升级为 **多锚点（首/中/尾 + 均匀采样）+ DOM block 匹配 + LCA**：
  - `extractAnchors`：从 Readability 正文抽 3–5 个锚段落（均匀采样，非只取首段）。
  - `locateAnchor`：在原始 DOM 递归文本遍历（不依赖 TreeWalker），精确 `includes` 优先、token Jaccard ≥ 0.5 兜底。
  - `lowestCommonAncestor`：取所有命中块级元素的 LCA 作为最小稳定正文容器。
  - 覆盖率指标：`anchorCoverage`（锚命中率）、`contentCoverage`（语义内容覆盖，非 raw 文本长度）、`mappingConfidence`（由 anchorCoverage 推导，内容覆盖过低时压低）。
- 缓解 signature collision（首匹配落在 hero / related-articles 区域）：多锚点 + LCA 使单点错配不再致命。
- **关键交付**：抽出**共享映射器** `readabilityRootMapper.ts`（见下），fanyi-extension 与 vocal-saga 两仓**逐字节相同**，同时消灭了第三个分叉副本（旧版 fanyi 用 `includes`、vocal-saga 用 Jaccard，现已统一）。

### P1 — 共享 Readability 映射器（消除第三个副本）✅（已落地 2026-08-11）

- 旧状态：`tryReadabilityRoot` 在两仓各维护一份，且 fanyi 用 `textContent.includes()`、vocal-saga 用 Jaccard ≥ 0.5，**第三个分叉副本**。
- 新状态：抽出环境无关的 `mapReadabilityToRoot(originalDoc, article, options)`，只使用标准 DOM API（递归遍历，不依赖 TreeWalker），两仓各放一份**逐字节相同**：
  - fanyi：`src/entrypoints/utils/readabilityRootMapper.ts`
  - vocal-saga：`lib/translate/readabilityRootMapper.ts`
- 两仓各加 `readabilityRootMapper.test.ts`（断言一致），与 `shared-walker.test.ts` 同一思路捕获漂移。
- `clone + parse`（Readability 会改树）仍由各自 `tryReadabilityRoot` 负责，映射层只吃 `(originalDoc, article)`。

### P1 — vocal-saga：Readability-preferred provider architecture ✅（已落地 2026-08-11）

决策（用户拍板，**不**改成 Readability-primary，也**不**简单把 `+0.05` 改成 `+0.20`）：

> **Readability = high-confidence preferred provider，而非 absolute winner，也非普通候选 + 固定 boost。**

落地点：
- `types.ts`：`ArticleCandidate` 增 `evidence?: ReadabilityEvidence`（含 `anchorCoverage` / `mappingConfidence` / `contentCoverage` / `articleTextLength`）。
- `scoring.ts`：删除固定 `confidence += 0.05`，改为基于 evidence 的**动态加权**：
  - `mappingConfidence ≥ 0.95 && contentCoverage ≥ 0.7` → +0.20
  - `≥ 0.8` → +0.15；`≥ 0.6` → +0.08；否则 +0
- `pipeline.ts` `rankCandidates` 加两条规则：
  - **dominance rule**（安全门 `mappingConfidence ≥ 0.85 && contentCoverage ≥ 0.8 && articleTextLength ≥ 500` 且分差 ≤ 0.15 时优先采用 Readability）。
  - **agreement boost**（Readability root 与 top root 重叠 → top 额外 +0.10，多 provider 指向同一容器是强协同信号）。
- 保留 provider competition 作为 fallback / 边界校验（Readability 定义语义边界，Text Density 校验密度）。

### P1 — 双 walker 共享 fixture

- 在 fanyi-extension 与 vocal-saga 各建同一组真实站点 HTML fixture（404media / mitsloan / OneTrust / 通用博客 / 带 sidebar 新闻站）。
- 各自 walker 跑同一组 fixture 断言关键段落被提取，CI 双跑防漂移。
- 长期目标：抽 `content-extraction-core` shared package，DOM adapter（扩展）/ HTML adapter（服务端）隔离差异。

### P2 — Evidence Fusion（谨慎，远期）

- 各 candidate（selector / readability / scoring）输出 `ContentRoot` 后，统一 `score()` 融合，按 confidence 区间决策：
  - `≥ 0.8` accept
  - `0.55–0.8` uncertain → broaden candidate
  - `< 0.55` reject
- **保留** curated selector 的优先级语义（确定性高于推断），仅加 **selector sanity check**（候选 `<200` 字 / link density 过高 / readability 强烈反对 → 让 readability 进场）。
- **不**把所有 detector 混成一个无差别 ranking。

---

## 5. 已知风险与开放问题

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| Layer 1 显式选择器仍优先于 Readability | 保持（curated 规则确定性更高） | 仅加 sanity check，不降级优先级 |
| 双仓分叉（最大工程风险） | walker、tryReadabilityRoot 两处独立维护，易 semantic drift | 共享 fixture（walker）+ 共享 mapper（已落地）是成本最低的两刀；长期仍要抽 `content-extraction-core` |
| Readability 偶发怪异 parse 接管 | mapping 不可信时仍可能选中错误根 | mapper 已有 `contentCoverage < 0.3 → null` + vocal-saga dominance 安全门三重防护 |
| `root_selected_but_zero_blocks` | root/extractor 契约恶化的信号 | 应作为线上指标监控 |

---

## 6. 参考

- `docs/TRANSLATION_FLOW_AND_READABILITY.md` — 当前架构描述
- `src/entrypoints/utils/contentDetector.ts` — `detectArticleRoot`（Layer 2）
- `src/entrypoints/utils/readabilityRootMapper.ts` — 共享映射器（fanyi 侧）
- `src/entrypoints/utils/blockExtractor/walker.ts` — `shouldSkipByClass` / `FILTER_REJECT`
- `lib/translate/readabilityRootMapper.ts` — 共享映射器（vocal-saga 侧，逐字节相同）
- `lib/translate/contentDetector.ts` — `tryReadabilityRoot`（消费共享 mapper）
- `lib/translate/extraction/scoring.ts` / `pipeline.ts` / `types.ts` / `providers/readability.ts` — Readability-preferred 落地
- `lib/translate/blockExtractor/walker.ts` — vocal-saga walker 副本
