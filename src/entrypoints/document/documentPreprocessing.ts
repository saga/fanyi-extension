/**
 * 预处理版本号只有一个来源：local-agent-service 的 `/context-graph/status` 响应
 * （`currentAnalysisVersion` 是服务端当前版本，`run.progress.analysisVersion` 是这条记录的产出
 * 版本）。扩展不保存任何本地副本——硬编码副本在服务端升版后会一直误报「版本过旧」。
 */
export type DocumentTranslationMode = 'literary' | 'technical';

/**
 * 预处理是否处于“进行中”状态：既包括服务端已排队/运行，也包括扩展正在提交启动请求。
 * UI 必须在 busy 时禁用“重新分析全书”，避免重复提交和状态闪烁。
 */
export function isContextGraphBusy(status: unknown, analyzing = false): boolean {
  return analyzing === true || status === 'queued' || status === 'running';
}

/**
 * Resolve the translation mode shared by the reader, Agent workspace and persisted Prompt.
 * Preprocessing status is informational in the extension; the Local Agent Run worker owns the
 * actual source/version/language readiness gate. Per-document literary mode takes precedence.
 */
export function resolveDocumentTranslationMode(
  perDocumentLiteraryMode: boolean,
  configuredMode?: string | null,
): DocumentTranslationMode {
  if (perDocumentLiteraryMode || configuredMode === 'literary') return 'literary';
  return 'technical';
}

export interface ContextGraphPreprocessingSnapshot {
  projectId?: string;
  sourceRevisionId?: string;
  /** 服务端当前的预处理版本（`currentAnalysisVersion`）。 */
  currentAnalysisVersion?: string;
  status?: string;
  phase?: string;
  runId?: string;
  progress?: Record<string, any> | null;
  error?: string;
  loading?: boolean;
}

export type PreprocessingBlockReason =
  | 'not-required'
  | 'checking'
  | 'project'
  | 'source-revision'
  | 'queued'
  | 'running'
  | 'failed'
  | 'missing'
  | 'version'
  | 'language';

export interface PreprocessingReadinessInput {
  required: boolean;
  loading?: boolean;
  snapshot?: ContextGraphPreprocessingSnapshot | null;
  expectedProjectId?: string | null;
  expectedSourceRevisionId?: string | null;
  sourceLang: string;
  targetLang: string;
}

export interface PreprocessingReadiness {
  required: boolean;
  ready: boolean;
  reason: PreprocessingBlockReason;
  message: string;
}

export function assessContextGraphReadiness(input: PreprocessingReadinessInput): PreprocessingReadiness {
  if (!input.required) {
    return { required: false, ready: true, reason: 'not-required', message: '' };
  }

  const snapshot = input.snapshot;
  if (!input.expectedProjectId || !input.expectedSourceRevisionId || !snapshot) {
    return {
      required: true, ready: false, reason: 'checking',
      message: '正在确认当前文档的全书预处理状态。开始文学翻译时，本机服务会核对当前原文版本并按需启动分析。',
    };
  }
  if (snapshot.projectId !== input.expectedProjectId) {
    return {
      required: true, ready: false, reason: 'project',
      message: '正在同步当前文档的本机项目状态。来源版本校验由服务端在翻译 Run 中执行。',
    };
  }
  if (!snapshot.sourceRevisionId) {
    return {
      required: true, ready: false, reason: 'checking',
      message: '尚未读取到当前原文版本的预处理状态；翻译 Run 启动后会由服务端校验并按需准备。',
    };
  }
  if (snapshot.sourceRevisionId !== input.expectedSourceRevisionId) {
    return {
      required: true, ready: false, reason: 'source-revision',
      message: '预处理记录属于另一个原文版本。文学 Run 会由服务端按当前原文版本重新准备；也可以手动刷新或重新分析全书。',
    };
  }

  const status = String(snapshot.status || 'not-started');
  if (status === 'queued' || status === 'running') {
    return {
      required: true, ready: false, reason: status,
      message: status === 'queued'
        ? '全书预处理已排队。可以提交文学翻译 Run，服务端会等待分析完成后再开始翻译。'
        : '全书预处理正在运行。可以提交文学翻译 Run，服务端会等待分析完成后再开始翻译。',
    };
  }
  if (status === 'failed') {
    return {
      required: true, ready: false, reason: 'failed',
      message: snapshot.error
        ? '上次全书预处理失败：' + snapshot.error + '。服务端会在新的文学翻译 Run 中重新检查；也可以手动重新分析。'
        : '上次全书预处理失败。服务端会在新的文学翻译 Run 中重新检查；也可以手动重新分析。',
    };
  }
  if (snapshot.error || input.loading || snapshot.loading) {
    return {
      required: true, ready: false, reason: 'checking',
      message: '无法确认本机服务中的最新预处理状态。该状态仅用于界面提示；Run 创建与上下文就绪校验由服务端处理。' +
        (snapshot.error ? ' 状态读取错误：' + snapshot.error : ''),
    };
  }
  if (status !== 'completed') {
    return {
      required: true, ready: false, reason: 'missing',
      message: '当前原文版本还没有成功完成全书预处理。开始文学翻译时，服务端会自动检查并按需准备；也可以在“人物与预处理”中手动重新分析。',
    };
  }

  const progress = snapshot.progress || {};
  // 版本比较必须用服务端下发的 currentAnalysisVersion，不能和扩展内的常量比。
  // 服务端没下发版本时不做判断：这里只是显示投影，真正的门禁由服务端 Run 负责，
  // 宁可不提示，也不要凭空断言「版本过旧」把用户骗去重跑一次 8 分钟的全书分析。
  const currentAnalysisVersion = String(snapshot.currentAnalysisVersion || '');
  if (currentAnalysisVersion && String(progress.analysisVersion || '') !== currentAnalysisVersion) {
    return {
      required: true, ready: false, reason: 'version',
      message: '这条预处理记录由旧版分析产出（' + (progress.analysisVersion || '未知版本') + '，当前 ' +
        currentAnalysisVersion + '）。服务端会在文学 Run 中自动重新分析；也可以手动重新分析。',
    };
  }
  const sourceLang = input.sourceLang || 'auto';
  const targetLang = input.targetLang || 'zh';
  if ((progress.sourceLang || 'auto') !== sourceLang || (progress.targetLang || 'zh') !== targetLang) {
    return {
      required: true, ready: false, reason: 'language',
      message: '全书预处理语言与当前设置不一致（预处理 ' + (progress.sourceLang || 'auto') + '→' +
        (progress.targetLang || 'zh') + '，当前 ' + sourceLang + '→' + targetLang + '）。服务端会在文学 Run 中按当前语言重新检查；也可以手动重新分析。',
    };
  }

  return { required: true, ready: true, reason: 'not-required', message: '' };
}

/**
 * 阅读页预处理提示卡的标题。
 *
 * 每个 reason 必须有独立文案：`version`（记录由旧版产出）、`missing`（确实没有记录）和
 * `checking`（还没读到状态）是三种完全不同的情况，统一显示成「尚无可用的全书预处理记录」
 * 会和同一张卡片里的「全书预处理完成」自相矛盾。
 */
export function preprocessingGateTitle(reason: PreprocessingBlockReason | string): string {
  switch (reason) {
    case 'queued':
    case 'running':
      return '本机服务正在准备全书上下文';
    case 'failed':
      return '上次全书预处理失败';
    case 'language':
      return '将按当前语言设置准备全书上下文';
    case 'version':
      return '预处理记录版本已更新，翻译时会自动重新分析';
    case 'missing':
      return '当前原文版本还没有完成全书预处理';
    case 'source-revision':
      return '正在同步当前文档的原文版本';
    case 'project':
      return '正在同步当前文档的本机项目状态';
    default:
      return '正在确认全书预处理状态';
  }
}

/**
 * 「全书文风基准」徽章。
 *
 * 机器基准由 TranslationBrief 自动注入（`contextGraph.styleGuide`），用户改动通过
 * `styleGuideOrigin='user-edited'` 同样自动生效，两者都不需要手动确认。
 * 徽章只描述「当前实际在用哪一份」，不再暗示还需要一步操作。
 */
export function styleGuideBadge(input: {
  autoDisabled: boolean;
  origin: string;
  graphReady: boolean;
}): { label: string; tone: 'active' | 'inactive' } {
  if (input.autoDisabled) return { label: '机器基准已停用', tone: 'inactive' };
  if (input.origin === 'user-edited') return { label: '你的编辑已生效', tone: 'active' };
  if (input.graphReady) return { label: '已自动应用', tone: 'active' };
  return { label: '预处理未就绪', tone: 'inactive' };
}

export function contextGraphSnapshotFromResponse(
  projectId: string,
  graph: Record<string, any> | null | undefined,
): ContextGraphPreprocessingSnapshot {
  const runs = Array.isArray(graph?.runs) ? graph.runs : [];
  const run = runs[0] || null;
  return {
    projectId,
    sourceRevisionId: typeof graph?.sourceRevisionId === 'string' ? graph.sourceRevisionId : '',
    currentAnalysisVersion: typeof graph?.currentAnalysisVersion === 'string' ? graph.currentAnalysisVersion : '',
    status: typeof run?.status === 'string' ? run.status : 'not-started',
    phase: typeof run?.phase === 'string' ? run.phase : 'not-started',
    runId: typeof run?.runId === 'string' ? run.runId : '',
    progress: run?.progress && typeof run.progress === 'object' ? run.progress : {},
    error: typeof run?.error === 'string' ? run.error : '',
    loading: false,
  };
}
