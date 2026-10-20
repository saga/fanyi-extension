/**
 * Agent 轨迹事件的纯展示逻辑。
 *
 * 这里不持有任何 Vue 状态：事件数组、筛选条件和当前 run 都由调用方传入，
 * 便于阅读页与测试复用同一套标题/状态/失败详情规则。
 */

export type AgentTrajectoryFilter = 'all' | 'model' | 'issues';

export interface AgentTrajectoryTask {
  key: string;
  runId: string;
  role: string;
  title: string;
  batchLabel?: string;
}

export function formatAgentDuration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms >= 60000
    ? Math.floor(ms / 60000) + ' 分 ' + Math.round((ms % 60000) / 1000) + ' 秒'
    : (ms / 1000).toFixed(1) + ' 秒';
}

/** token 数展示：万位以上折算成 k，避免长数字挤爆轨迹行。 */
export function formatTokenCount(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : n.toLocaleString();
}

interface UsageSummary {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  totalInputTokens?: unknown;
  totalTokens?: unknown;
  totalCostUsd?: unknown;
  durationMs?: unknown;
  numTurns?: unknown;
}

/** 把服务端 model.usage / run.finished 里的 usage 摘要转成一行可读文本。 */
function usageDetailLine(usage: UsageSummary | null | undefined): string | null {
  if (!usage || typeof usage !== 'object') return null;
  const totalInput = Number(usage.totalInputTokens ??
    (Number(usage.inputTokens || 0) + Number(usage.cacheReadTokens || 0) + Number(usage.cacheCreationTokens || 0)));
  const output = Number(usage.outputTokens || 0);
  const total = Number(usage.totalTokens || (totalInput + output));
  if (!total) return null;
  const cacheRead = Number(usage.cacheReadTokens || 0);
  const cacheWrite = Number(usage.cacheCreationTokens || 0);
  const parts = ['输入 ' + formatTokenCount(totalInput)];
  if (cacheRead || cacheWrite) parts.push('缓存 ' + formatTokenCount(cacheRead + cacheWrite));
  parts.push('输出 ' + formatTokenCount(output));
  parts.push('合计 ' + formatTokenCount(total));
  const cost = Number(usage.totalCostUsd || 0);
  if (cost > 0) parts.push('费用 $' + cost.toFixed(4));
  const durationMs = Number(usage.durationMs || 0);
  if (usage.durationMs != null && durationMs > 0) parts.push('耗时 ' + formatAgentDuration(durationMs));
  return parts.join(' · ');
}

export function agentTrajectoryRole(event: any): string {
  const type = String(event?.type || '');
  const stage = String(event?.payload?.stage || '');
  if (type.startsWith('context-graph.')) return '全书预处理';
  if (stage === 'style-review' || (type === 'stage.started' && /文风|声音/.test(String(event?.payload?.label || '')))) return '人物声音 / 文风 Agent';
  if (stage === 'review' || type === 'review.context.ready') return '准确性 / 术语 Reviewer';
  if (stage === 'translate' || type.startsWith('batch.') || type === 'translation-brief.ready' ||
      type === 'translations.accepted' || type.startsWith('translation.context-')) return '翻译 Agent';
  if (type.startsWith('run.') || type === 'plan.ready') return '任务编排';
  return 'Agent 工作流';
}

export function agentTrajectoryTitle(event: any): string {
  const type = String(event?.type || '');
  const p = event?.payload || {};
  const stage = String(p.stage || '');
  const withSuffix = (label: unknown, suffix: string) => {
    const value = String(label || '');
    return value.endsWith(suffix) ? value : value + suffix;
  };
  const payload = event?.payload || {};
  if (type === 'run.finished' && Number(payload.counts?.failed || 0) > 0) {
    return '运行结束（' + Number(payload.counts.failed) + ' 个片段失败）';
  }
  if (type === 'batch.completed' && Array.isArray(payload.failedIds) && payload.failedIds.length) {
    return '批次流程结束（' + payload.failedIds.length + ' 个片段失败）';
  }
  if (type === 'batch.translation.completed' && Array.isArray(payload.failedIds) && payload.failedIds.length) {
    return '初译完成（' + payload.failedIds.length + ' 个片段失败）';
  }
  const labels: Record<string, string> = {
    'run.planned': '翻译运行已创建',
    'plan.ready': '批次计划已生成',
    'run.context.ready': '运行上下文已固定',
    'batch.started': '开始翻译批次',
    'translation-brief.ready': 'TranslationBrief 已组装',
    'batch.prompt.ready': '向模型提交请求',
    'batch.model.response': '模型已返回结果',
    'model.usage': '本次模型调用 token 消耗',
    'batch.translation.completed': '初译候选已保存',
    'batch.partial': '模型返回不完整，正在重试',
    'batch.output.validation': '模型输出校验告警',
    'batch.completed': '批次与审校流程结束',
    'batch.discarded': '批次结果已丢弃',
    'stage.started': withSuffix(p.label || (stage === 'style-review' ? '人物声音与文风审校' : stage === 'review' ? '准确性与术语审校' : stage === 'translate' ? '初译阶段' : '工作流阶段'), '开始'),
    'stage.completed': withSuffix(p.label || (stage === 'style-review' ? '人物声音与文风审校' : stage === 'review' ? '准确性与术语审校' : stage === 'validate' ? '结果校验' : '工作流阶段'), '完成'),
    'stage.warning': String(stage === 'style-review' ? '人物声音与文风审校' : stage === 'review' ? '准确性与术语审校' : '工作流阶段') + '告警',
    'model.call.failed': '模型调用失败',
    'review.context.ready': 'Reviewer 上下文已准备',
    'review.discarded': '审校结果已丢弃',
    'run.failed': '运行失败',
    'run.completed': '运行完成',
    'run.finished': p.status === 'failed' ? '运行结束但存在失败' : p.status === 'partial' ? '运行部分完成' : '运行结束',
    'translations.accepted': '译文已采纳',
    'translation.context-delta.parsed': '初译上下文证据校验',
    'translation.context-delta.saved': '人物与上下文候选已保存',
    'translation.context-wave.ready': '后续翻译上下文已冻结',
    'translation.context-memory.persisted': '项目人物记忆已更新',
    'translation.context-memory.skipped': '项目记忆更新已跳过',
    'translation.context-memory.unchanged': '没有新的上下文候选',
    'context-graph.phase': p.phase === 'model-analysis' ? '开始分析人物、实体与规范译名' : '开始扫描全书原文',
    'context-graph.scan.completed': '全书扫描与样本规划完成',
    'context-graph.completed': '全书预处理完成',
    'context-graph.failed': '全书预处理失败',
    'context-graph.reviewed': '人工修改图谱状态',
  };
  return labels[type] || type.replace(/[.-]/g, ' ');
}

export interface AgentTrajectoryModelInfo {
  provider?: string;
  model?: string;
  thinkingMode?: string;
  thinkingBudgetTokens?: number;
  effort?: string;
  fallbackModel?: string;
}

/** 从事件 payload / 顶层字段中提取本次调用实际使用的模型与思考配置。 */
export function resolveAgentTrajectoryModelInfo(event: any): AgentTrajectoryModelInfo {
  const p = (event && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload))
    ? event.payload : {};
  const top = event && typeof event === 'object' ? event : {};
  const taskProfile = (p.taskProfile || p.task_profile) && typeof (p.taskProfile || p.task_profile) === 'object'
    ? (p.taskProfile || p.task_profile) : {};
  const thinkingObj = p.thinking && typeof p.thinking === 'object' && !Array.isArray(p.thinking)
    ? p.thinking : {};
  const provider = p.provider ?? top.provider ?? taskProfile.provider;
  const model = p.model ?? top.model ?? taskProfile.model;
  let thinkingMode = p.thinkingMode ?? p.thinking_mode ?? thinkingObj.type ?? thinkingObj.mode ?? taskProfile.thinkingMode;
  let thinkingBudgetTokens = p.thinkingBudgetTokens ?? p.thinking_budget_tokens ?? p.thinkingBudget ??
    thinkingObj.budgetTokens ?? thinkingObj.budget_tokens ?? taskProfile.thinkingBudgetTokens;
  const effort = p.effort ?? taskProfile.effort;
  const fallbackModel = p.fallbackModel ?? p.fallback_model ?? taskProfile.fallbackModel;
  if (thinkingMode != null) thinkingMode = String(thinkingMode);
  if (thinkingBudgetTokens != null) thinkingBudgetTokens = Number(thinkingBudgetTokens);
  if (effort != null) {
    // keep as-is string
  }
  return {
    provider: provider != null ? String(provider) : undefined,
    model: model != null ? String(model) : undefined,
    thinkingMode: thinkingMode != null && thinkingMode !== '' ? String(thinkingMode) : undefined,
    thinkingBudgetTokens: Number.isFinite(thinkingBudgetTokens as number) ? Number(thinkingBudgetTokens) : undefined,
    effort: effort != null && String(effort) !== '' ? String(effort) : undefined,
    fallbackModel: fallbackModel != null && String(fallbackModel) !== '' ? String(fallbackModel) : undefined,
  };
}

export function agentTrajectoryDetail(event: any, projectId?: unknown): string {
  const p = event?.payload || {};
  const type = String(event?.type || '');
  const details: string[] = [];
  const resolvedProjectId = projectId != null && String(projectId).trim() !== ''
    ? String(projectId)
    : (event?.projectId != null ? String(event.projectId)
      : (p.projectId != null ? String(p.projectId) : ''));
  const resolvedRunId = event?.runId != null ? String(event.runId)
    : (p.runId != null ? String(p.runId) : '');
  if (p.chapter) details.push('章节：' + p.chapter);
  if (type === 'plan.ready') {
    details.push('原文片段 ' + (p.segmentCount ?? '?') + ' 段，规划 ' + (p.batchCount ?? '?') + ' 批');
    details.push('初译并发 ' + (p.translationConcurrency ?? '?') + '，审校并发 ' + (p.reviewConcurrency ?? 0));
    if (p.maxBatchSegments != null || p.maxBatchSourceChars != null) {
      details.push('每批上限 ' + (p.maxBatchSegments ?? '?') + ' 段 / ' + (p.maxBatchSourceChars ?? '?') + ' 原文字符');
    }
    if (p.contextBudgetChars != null || p.precedingContextSegments != null || p.maxModelAttempts != null) {
      details.push('前文参考 ' + (p.precedingContextSegments ?? '?') + ' 段 · 上下文预算 ' +
        (p.contextBudgetChars ?? '?') + ' 字符 · 单批最多尝试 ' + (p.maxModelAttempts ?? '?') + ' 次');
    }
  }
  if (type === 'run.context.ready') {
    details.push('模型 ' + (p.provider || '?') + '/' + (p.model || '运行时默认'));
    details.push('语言方向 ' + (p.sourceLang || '?') + ' → ' + (p.targetLang || '?'));
    details.push('实体 ' + (p.memoryEntities ?? 0) + '，人物声音 ' + (p.characterVoices ?? 0) + '，术语 ' + (p.glossaryTerms ?? 0));
  }
  if (type === 'batch.started') {
    details.push('片段 ' + (Array.isArray(p.segmentIds) ? p.segmentIds.length : '?') + ' 段');
    details.push('前文上下文 ' + (p.precedingContextCount ?? 0) + ' 段');
    details.push('会话策略：' + (p.sessionStrategy || '独立批次'));
  }
  if (type === 'translation-brief.ready') {
    details.push('上下文 ' + (p.contextChars ?? 0) + ' 字符');
    // Older persisted events use the detailed summary field names; newer events also carry
    // the UI aliases. Fall back for counts so historical traces don't falsely render zero.
    const entityCount = p.entityCount ??
      (Number(p.graphCharacters || 0) + Number(p.graphEntities || 0));
    const relationshipCount = p.relationshipCount ?? p.graphRelationships ?? 0;
    const characterVoiceCount = p.characterVoiceCount ?? p.characterVoices ?? 0;
    const nameMappingCount = p.nameMappingCount ?? p.graphNameMappingCount;
    details.push('实体 ' + entityCount + '，关系 ' + relationshipCount +
      '，人物声音 ' + characterVoiceCount + '，规范译名 ' +
      (nameMappingCount ?? '见后续模型请求明细'));
    if (p.contextHash) details.push('Context hash ' + String(p.contextHash).slice(0, 12));
  }
  if (type === 'batch.prompt.ready') {
    details.push('模型 ' + (p.provider || '?') + '/' + (p.model || '运行时默认'));
    details.push('原文 ' + (p.sourceChars ?? '?') + ' 字符，系统指令 ' + (p.systemPromptChars ?? '?') + ' 字符，用户提示 ' + (p.userPromptChars ?? '?') + ' 字符');
    details.push('前文 ' + (p.precedingSegmentCount ?? 0) + ' 段，规范译名 ' + (p.contextGraphNameMappingCount ?? 0));
    if (Array.isArray(p.contextGraphNameMappingPreview) && p.contextGraphNameMappingPreview.length) {
      details.push('译名映射：' + p.contextGraphNameMappingPreview.slice(0, 8).map((item: any) => item.source + ' → ' + item.target).join('；'));
    }
  }
  if (type === 'batch.model.response') {
    details.push('返回 ' + (p.returnedSegments ?? 0) + '/' + (p.requestedSegments ?? 0) + ' 段');
    if (p.missingCount) details.push('缺少 ' + p.missingCount + ' 段：' + (p.missingIds || []).slice(0, 8).join(', '));
  }
  if (type === 'model.usage') {
    const line = usageDetailLine(p);
    if (line) details.push(line);
  }
  if (type === 'batch.translation.completed') {
    details.push('候选 ' + (p.candidateCount ?? 0) + ' 段，审校 ' + (p.reviewScheduled ? '已排队' : '关闭'));
  }
  if (type === 'batch.completed' || type === 'batch.translation.completed') {
    if (Array.isArray(p.failedIds) && p.failedIds.length) {
      details.push('失败片段 ' + p.failedIds.length + ' 个：' + p.failedIds.slice(0, 8).join(', ') +
        (p.failedIds.length > 8 ? ' 等' : ''));
    }
  }
  if (type === 'batch.partial') {
    if (Array.isArray(p.missingIds) && p.missingIds.length) {
      details.push('重试后仍缺少或曾缺少 ' + p.missingIds.length + ' 个片段：' + p.missingIds.slice(0, 8).join(', ') +
        (p.missingIds.length > 8 ? ' 等' : ''));
    }
  }
  if (type === 'batch.output.validation') {
    details.push('重复 ID ' + (p.duplicateCount ?? 0) + '，未知 ID ' + (p.unexpectedCount ?? 0) + '，格式异常 ' + (p.malformedRowCount ?? 0));
  }
  if (type === 'review.context.ready') {
    details.push('注入实体 ' + (p.injectedEntities ?? 0) + '，关系 ' + (p.injectedRelationships ?? 0) +
      '，章节摘要 ' + (p.injectedChapterSummaries ?? 0));
    details.push('人物声音 ' + (p.injectedCharacterVoices ?? 0) + '，声音规则 ' + (p.injectedRelationshipVoiceRules ?? 0) +
      '，已批准锚点 ' + (p.injectedVoiceAnchors ?? 0));
  }
  if (type === 'run.finished' || type === 'run.completed') {
    const counts = p.counts || {};
    details.push('候选 ' + (counts.candidate ?? 0) + ' 段，已接受 ' + (counts.accepted ?? 0) + ' 段，失败 ' + (counts.failed ?? 0) + ' 段');
    const usageLine = usageDetailLine(p.usage);
    if (usageLine) details.push('累计 ' + usageLine);
    if (p.error) details.push('状态信息：' + p.error);
  }
  if (type === 'stage.completed') {
    if (p.reviewedIds) details.push('审校片段 ' + p.reviewedIds.length + ' 段');
    if (p.findingCount != null) details.push('发现 ' + p.findingCount + ' 项');
    if (p.accuracyFindingCount != null) details.push('准确性问题 ' + p.accuracyFindingCount + ' 项');
    if (p.terminologyFindingCount != null) details.push('术语问题 ' + p.terminologyFindingCount + ' 项');
    if (p.styleFindingCount != null) details.push('文风问题 ' + p.styleFindingCount + ' 项');
    if (p.revisedCount != null) details.push('新修订候选 ' + p.revisedCount + ' 段');
  }
  if (type === 'context-graph.phase') {
    details.push('来源扫描 ' + (p.segmentCount ?? '?') + ' 段');
    if (p.sampleCount != null) details.push('本轮样本 ' + p.sampleCount + ' 段');
    if (p.sourceLang) details.push('语言方向 ' + p.sourceLang + ' → ' + (p.targetLang || '?'));
    if (p.model) details.push('模型 ' + p.provider + '/' + p.model);
  }
  if (type === 'context-graph.scan.completed') {
    details.push('扫描 ' + (p.segmentCount ?? '?') + ' 段 / ' + (p.chapterCount ?? '?') + ' 章');
    details.push('名称候选 ' + (p.nameCandidateCount ?? 0) + '，重复短语 ' + (p.repeatedPhraseCandidateCount ?? 0));
    details.push('对话片段 ' + (p.dialogueSegmentCount ?? 0) + '，抽样 ' + (p.sampleCount ?? 0) + ' 段');
  }
  if (type === 'context-graph.completed') {
    details.push('人物 ' + (p.characterCount ?? 0) + '，其他实体 ' + (p.entityCount ?? 0) + '，关系 ' + (p.relationshipCount ?? 0));
    details.push('规范译名 ' + (p.canonicalNameMappingCount ?? 0) + ' · 无效证据 ' + (p.invalidEvidenceCount ?? 0));
  }
  const error = p.error || p.warning;
  if (error) details.push('错误：' + String(error));
  if (p.reason) details.push('原因：' + String(p.reason));
  const identityParts: string[] = [];
  if (resolvedProjectId) identityParts.push('project-id ' + resolvedProjectId);
  if (resolvedRunId) identityParts.push('run-id ' + resolvedRunId);
  // 模型与思考配置：与 project-id / run-id 一样作为小字标识，便于排查每次调用实际使用的模型。
  const modelInfo = resolveAgentTrajectoryModelInfo(event);
  if (modelInfo.provider || modelInfo.model) {
    identityParts.push('model ' + (modelInfo.provider || '?') + '/' + (modelInfo.model || '运行时默认'));
  }
  if (modelInfo.thinkingMode) {
    identityParts.push('thinking ' + modelInfo.thinkingMode +
      (modelInfo.thinkingMode === 'enabled' && modelInfo.thinkingBudgetTokens
        ? ' ' + modelInfo.thinkingBudgetTokens : ''));
  }
  if (modelInfo.effort) identityParts.push('effort ' + modelInfo.effort);
  if (modelInfo.fallbackModel) identityParts.push('fallback ' + modelInfo.fallbackModel);
  if (identityParts.length) details.push(identityParts.join('   '));
  return details.join(' · ') || (p.label ? String(p.label) : '已记录持久化事件。');
}

export function agentTrajectoryStatus(event: any): string {
  const type = String(event?.type || '');
  const payload = event?.payload || {};
  const runStatus = String(payload.status || '');
  if (type === 'run.finished' && runStatus === 'failed') return 'failed';
  if (type === 'run.finished' && runStatus === 'partial') return 'warning';
  if (type.endsWith('.failed') || type === 'model.call.failed' || type === 'run.failed') return 'failed';
  if (type === 'run.finished' && Number(payload.counts?.failed || 0) > 0) return 'warning';
  if (['batch.completed', 'batch.translation.completed'].includes(type) &&
      Array.isArray(payload.failedIds) && payload.failedIds.length > 0) return 'warning';
  if (type === 'stage.warning' || type === 'batch.partial' || type === 'batch.output.validation') return 'warning';
  if (type === 'batch.started' || type === 'stage.started' || type === 'context-graph.phase' || type === 'batch.prompt.ready') return 'running';
  return 'completed';
}

export function agentTrajectoryStatusLabel(event: any): string {
  const status = agentTrajectoryStatus(event);
  return status === 'failed' ? '失败' : status === 'warning' ? '告警' : status === 'running' ? '进行中' : '已记录';
}

export function agentTrajectoryHasFailureDetails(event: any): boolean {
  const payload = event?.payload || {};
  return (Array.isArray(payload.failedIds) && payload.failedIds.length > 0) ||
    Number(payload.counts?.failed || 0) > 0;
}

export function agentTrajectoryFailureCount(event: any): number {
  const payload = event?.payload || {};
  return Array.isArray(payload.failedIds) && payload.failedIds.length
    ? payload.failedIds.length
    : Number(payload.counts?.failed || 0);
}

export function agentTrajectoryRelatedFailureEvents(events: any[], event: any): any[] {
  const runId = String(event?.runId || '');
  if (!runId) return [];
  const batchIndex = event?.payload?.batchIndex;
  const relatedTypes = new Set([
    'model.call.failed', 'batch.partial', 'batch.output.validation', 'stage.warning', 'batch.completed',
  ]);
  return events.filter((item) => {
    if (String(item.runId || '') !== runId || !relatedTypes.has(String(item.type || ''))) return false;
    if (batchIndex != null && item.payload?.batchIndex != null && item.payload.batchIndex !== batchIndex) return false;
    return true;
  }).slice(-8).reverse();
}

export function filterAgentTrajectoryEvents(events: any[], filter: AgentTrajectoryFilter): any[] {
  const filtered = filter === 'issues'
    ? events.filter((event) => ['failed', 'warning'].includes(agentTrajectoryStatus(event)))
    : filter === 'model'
      ? events.filter((event) =>
        ['batch.started', 'batch.prompt.ready', 'batch.model.response', 'model.usage', 'batch.translation.completed',
          'stage.started', 'stage.completed', 'stage.warning', 'model.call.failed', 'context-graph.phase',
          'context-graph.scan.completed', 'context-graph.completed', 'context-graph.failed'].includes(event.type))
      : events;
  // 事件按时间顺序存储（旧的在前、新的在后）；展示时最新的在最上面、旧的在最下面。
  return filtered.slice().reverse();
}

export function computeAgentTrajectoryActiveTasks(events: any[], contextGraphRuns?: any[] | null): AgentTrajectoryTask[] {
  const tasks = new Map<string, AgentTrajectoryTask>();
  for (const event of events) {
    const type = String(event.type || '');
    const p = event.payload || {};
    const runId = String(event.runId || '');
    if (type === 'context-graph.phase') {
      const key = runId + ':context-graph';
      tasks.set(key, { key, runId, role: '全书预处理 Agent', title: p.phase === 'model-analysis' ? '正在分析人物、实体与规范译名' : '正在扫描原文并选择样本' });
    } else if (type === 'context-graph.completed' || type === 'context-graph.failed') {
      tasks.delete(runId + ':context-graph');
    } else if (type === 'batch.started') {
      const key = runId + ':translate:' + p.batchIndex;
      tasks.set(key, { key, runId, role: '翻译 Agent', title: '正在翻译本批原文', batchLabel: p.batchIndex ? '批次 ' + p.batchIndex + (p.batchCount ? '/' + p.batchCount : '') : '' });
    } else if (type === 'batch.translation.completed') {
      tasks.delete(runId + ':translate:' + p.batchIndex);
    } else if (type === 'stage.started') {
      const key = runId + ':' + p.stage + ':' + (p.batchIndex ?? 0);
      tasks.set(key, { key, runId, role: agentTrajectoryRole(event), title: String(p.label || agentTrajectoryTitle(event)), batchLabel: p.batchIndex ? '批次 ' + p.batchIndex + (p.batchCount ? '/' + p.batchCount : '') : '' });
    } else if (type === 'stage.completed' || type === 'stage.warning') {
      tasks.delete(runId + ':' + p.stage + ':' + (p.batchIndex ?? 0));
    } else if (type === 'batch.completed') {
      const batchIndex = p.batchIndex ?? 0;
      tasks.delete(runId + ':translate:' + batchIndex);
      tasks.delete(runId + ':review:' + batchIndex);
      tasks.delete(runId + ':style-review:' + batchIndex);
    } else if (type === 'run.failed' || type === 'run.completed' || type === 'run.finished') {
      for (const key of Array.from(tasks.keys())) if (key.startsWith(runId + ':')) tasks.delete(key);
    }
  }

  // When available, the Context Graph status endpoint is authoritative for preprocessing
  // activity. Event history explains what happened; it must not override current run state.
  // This also prunes phase-only events from old source revisions and reconstructs an active
  // task if its phase event fell outside the retained event window.
  if (Array.isArray(contextGraphRuns)) {
    const byRunId = new Map<string, any>(
      contextGraphRuns.filter((run) => run?.runId != null).map((run) => [String(run.runId), run]),
    );
    for (const [key, task] of tasks) {
      if (task.role !== '全书预处理 Agent') continue;
      const run = byRunId.get(task.runId);
      if (!run || run.active !== true || !['queued', 'running'].includes(String(run.status))) tasks.delete(key);
    }
    for (const run of contextGraphRuns) {
      const runId = String(run?.runId || '');
      if (!runId || run.active !== true || !['queued', 'running'].includes(String(run.status))) continue;
      const key = runId + ':context-graph';
      const phase = String(run.phase || '');
      tasks.set(key, {
        key, runId, role: '全书预处理 Agent',
        title: phase === 'model-analysis' ? '正在分析人物、实体与规范译名' : '正在扫描原文并选择样本',
      });
    }
  }
  return Array.from(tasks.values()).slice(-8).reverse();
}

export function agentTrajectoryProjectRunId(projectId: unknown, runId: unknown): string {
  const p = projectId != null ? String(projectId).trim() : '';
  const r = runId != null ? String(runId).trim() : '';
  const parts: string[] = [];
  if (p) parts.push('project-id ' + p);
  if (r) parts.push('run-id ' + r);
  return parts.join('   ');
}

function toDateValue(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 北京时间（Asia/Shanghai）时间展示，避免浏览器本地时区导致 UI 时间不对。 */
export function formatAgentTime(value: unknown): string {
  const date = toDateValue(value);
  if (!date) return '';
  return date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** 北京时间（Asia/Shanghai）日期时间展示。 */
export function formatAgentDateTime(value: unknown): string {
  const date = toDateValue(value);
  if (!date) return '';
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

// 常见命名别名，兼容不同调用方/测试对时间格式化函数的命名。
export const formatTime = formatAgentTime;
export const formatEventTime = formatAgentTime;
export const formatLogTime = formatAgentTime;
export const formatTrajectoryTime = formatAgentTime;
export const formatTimestampTime = formatAgentTime;

export const formatDateTime = formatAgentDateTime;
export const formatTimestamp = formatAgentDateTime;
export const formatBeijingTime = formatAgentDateTime;
export const toBeijingTime = formatAgentDateTime;
export const formatChinaTime = formatAgentDateTime;
export const formatBeijingDateTime = formatAgentDateTime;
export const formatBeijingTimeString = formatAgentTime;

export const agentTrajectoryModelDetails = resolveAgentTrajectoryModelInfo;
export const agentTrajectoryModelInfo = resolveAgentTrajectoryModelInfo;
export const getModelInfo = resolveAgentTrajectoryModelInfo;
export const agentTrajectoryIdentity = agentTrajectoryProjectRunId;
export const agentTrajectoryIdentifiers = agentTrajectoryProjectRunId;
export const agentTrajectoryRunIdentity = agentTrajectoryProjectRunId;
export const agentTrajectoryRunLabel = agentTrajectoryProjectRunId;
export const formatAgentIdentifiers = agentTrajectoryProjectRunId;
