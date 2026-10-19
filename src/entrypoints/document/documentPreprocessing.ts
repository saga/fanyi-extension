export const CONTEXT_GRAPH_ANALYSIS_VERSION = 'context-graph-v5-language-pinned';

export type DocumentTranslationMode = 'literary' | 'technical';

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
      message: '预处理记录属于另一个原文版本。请先更新来源并完成当前原文版本的全书预处理。',
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
  if (progress.analysisVersion !== CONTEXT_GRAPH_ANALYSIS_VERSION) {
    return {
      required: true, ready: false, reason: 'version',
      message: '全书预处理版本过旧或不兼容。服务端会在文学 Run 中重新检查并按需分析；也可以手动重新分析。',
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

export function contextGraphSnapshotFromResponse(
  projectId: string,
  graph: Record<string, any> | null | undefined,
): ContextGraphPreprocessingSnapshot {
  const runs = Array.isArray(graph?.runs) ? graph.runs : [];
  const run = runs[0] || null;
  return {
    projectId,
    sourceRevisionId: typeof graph?.sourceRevisionId === 'string' ? graph.sourceRevisionId : '',
    status: typeof run?.status === 'string' ? run.status : 'not-started',
    phase: typeof run?.phase === 'string' ? run.phase : 'not-started',
    runId: typeof run?.runId === 'string' ? run.runId : '',
    progress: run?.progress && typeof run.progress === 'object' ? run.progress : {},
    error: typeof run?.error === 'string' ? run.error : '',
    loading: false,
  };
}
