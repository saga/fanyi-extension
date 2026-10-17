export const CONTEXT_GRAPH_ANALYSIS_VERSION = 'context-graph-v5-language-pinned';

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
      message: '正在确认当前文档与全书预处理状态。文学翻译需要先完成当前原文版本的预处理。',
    };
  }
  if (snapshot.projectId !== input.expectedProjectId) {
    return {
      required: true, ready: false, reason: 'project',
      message: '正在同步当前文档的本机项目状态；同步完成前不会启动文学翻译。',
    };
  }
  if (!snapshot.sourceRevisionId) {
    return {
      required: true, ready: false, reason: 'checking',
      message: '尚未读取到当前原文版本的预处理状态，正在检查本机服务。',
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
        ? '全书预处理已排队，正在准备扫描与分析。预处理完成前，所有文学翻译操作都会暂时禁用。'
        : '全书预处理正在运行，正在扫描原文并分析人物、规范译名、关系与章节上下文。完成后会自动开放翻译。',
    };
  }
  if (input.loading || snapshot.loading) {
    return {
      required: true, ready: false, reason: 'checking',
      message: '正在刷新全书预处理状态；确认前不会启动文学翻译。',
    };
  }
  if (status === 'failed') {
    return {
      required: true, ready: false, reason: 'failed',
      message: '全书预处理失败，文学翻译暂不可用。请查看失败原因并重新分析全书。',
    };
  }
  if (status !== 'completed') {
    return {
      required: true, ready: false, reason: 'missing',
      message: '当前原文版本还没有成功完成全书预处理。请先启动“人物与预处理”，完成后再翻译。',
    };
  }

  const progress = snapshot.progress || {};
  if (progress.analysisVersion !== CONTEXT_GRAPH_ANALYSIS_VERSION) {
    return {
      required: true, ready: false, reason: 'version',
      message: '全书预处理版本过旧或不兼容。请重新分析全书，再启动翻译。',
    };
  }
  const sourceLang = input.sourceLang || 'auto';
  const targetLang = input.targetLang || 'zh';
  if ((progress.sourceLang || 'auto') !== sourceLang || (progress.targetLang || 'zh') !== targetLang) {
    return {
      required: true, ready: false, reason: 'language',
      message: '全书预处理语言与当前设置不一致（预处理 ' + (progress.sourceLang || 'auto') + '→' +
        (progress.targetLang || 'zh') + '，当前 ' + sourceLang + '→' + targetLang + '）。请重新分析全书。',
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
