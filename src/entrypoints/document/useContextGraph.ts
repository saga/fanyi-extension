import { computed, ref, type Ref } from 'vue';
import { getConfig, type Config } from '@/entrypoints/utils/config';
import type { ParsedDocument } from '@/entrypoints/utils/document/types';
import { sanitizeLiteraryMemory, type LiteraryBookMemory } from '@/entrypoints/utils/document/literary';
import {
  assessContextGraphReadiness,
  CONTEXT_GRAPH_ANALYSIS_VERSION,
} from './documentPreprocessing';
import { workspaceApi } from './documentWorkspaceClient';
import { mergeContextGraphEntitySuggestions } from './documentLiteraryBridge';

export interface ContextGraphDeps {
  readerConfig: Ref<Config | null>;
  workspaceProject: Ref<any>;
  workspaceActiveRun: Ref<any>;
  doc: Ref<ParsedDocument | null>;
  sourceLang: Ref<string>;
  targetLang: Ref<string>;
  effectiveDocumentTranslationMode: Ref<'technical' | 'literary'>;
  literaryMemory: Ref<LiteraryBookMemory>;
  persistenceMessage: Ref<string>;
  activeTab: Ref<string>;
  ensureWorkspace: () => Promise<any | null>;
  persistSession: () => Promise<void>;
  persistLiteraryMemoryToWorkspace: () => Promise<void>;
}

/**
 * 全书预处理（Context Graph）状态机。
 *
 * 负责读取/轮询分析进度、维护翻译前的就绪门禁，以及把分析结果合并进书籍记忆；
 * 具体的分析任务由本机服务执行。
 */
export function useContextGraph(deps: ContextGraphDeps) {
    const {
      readerConfig,
      workspaceProject,
      workspaceActiveRun,
      doc,
      sourceLang,
      targetLang,
      effectiveDocumentTranslationMode,
      literaryMemory,
      persistenceMessage,
      activeTab,
    } = deps;

  const contextGraphState = ref<any>({
    projectId: '', sourceRevisionId: '', segmentCount: 0,
    counts: { characters: 0, entities: 0, relationships: 0, chapters: 0, evidencedNodes: 0 },
    status: 'not-started', phase: 'not-started', progress: {}, runId: '',
    startedAt: null, finishedAt: null, error: '', loading: false, checkedAt: '',
  });
  const contextGraphAnalyzing = ref(false);
  const contextGraphOverview = ref<{ narrativeStyle: string; styleRules: string[] }>({ narrativeStyle: '', styleRules: [] });
  let contextGraphPollTimer: number | null = null;
  const contextGraphStatusLabel = computed(() => ({
    'not-started': '尚未运行', queued: '等待执行', running: '运行中',
    completed: '已完成', failed: '失败',
  }[contextGraphState.value.status] || contextGraphState.value.status || '未知'));
  const contextGraphPhaseLabel = computed(() => {
    const run = contextGraphState.value;
    const phase = run.phase;
    const labels: Record<string, string> = {
      'not-started': '尚未预处理当前原文版本。',
      queued: '预处理已排队，等待开始。',
      sample: '阶段 1/2：扫描全书结构、对话密度和名称线索，规划代表性样本。',
      'model-analysis': '阶段 2/2：模型正在分析人物、规范译名、实体、关系、文风与章节摘要。',
      completed: '全书预处理完成。翻译批次会注入与当前原文匹配的规范专名和有时间边界的上下文。',
      failed: '预处理失败。错误详情已记录；修复配置后可以重新分析。',
    };
    return labels[phase] || labels[run.status] || '读取预处理状态中。';
  });
  const contextGraphProgressPercent = computed(() => {
    const { status, phase, progress } = contextGraphState.value;
    if (status === 'completed' || status === 'failed') return 100;
    if (status === 'queued') return 4;
    if (phase === 'sample') return 32;
    if (phase === 'model-analysis') {
      const sampleCount = Number(progress?.sampleCount || progress?.scan?.samplePlan?.length || 0);
      return sampleCount > 0 ? 68 : 55;
    }
    if (status === 'running') return 12;
    return 0;
  });

  const translationPreprocessingRequired = computed(() =>
    readerConfig.value?.documentUseLocalAgent === true && effectiveDocumentTranslationMode.value === 'literary',
  );
  const translationPreprocessingReadiness = computed(() => assessContextGraphReadiness({
    required: translationPreprocessingRequired.value,
    loading: contextGraphState.value.loading || contextGraphAnalyzing.value,
    snapshot: contextGraphState.value,
    expectedProjectId: workspaceProject.value?.projectId || null,
    expectedSourceRevisionId: workspaceProject.value?.currentSourceRevisionId || null,
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
  }));
  const translationBlockedByPreprocessing = computed(() =>
    translationPreprocessingRequired.value && !translationPreprocessingReadiness.value.ready,
  );
  const translationPreprocessingUiState = computed(() => ({
    ...contextGraphState.value,
    required: translationPreprocessingRequired.value,
    ready: translationPreprocessingReadiness.value.ready,
    reason: translationPreprocessingReadiness.value.reason,
    message: translationPreprocessingReadiness.value.message,
    progressPercent: contextGraphProgressPercent.value,
    expectedProjectId: workspaceProject.value?.projectId || '',
    expectedSourceRevisionId: workspaceProject.value?.currentSourceRevisionId || '',
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
  }));

  function clearContextGraphPoll() {
    if (contextGraphPollTimer !== null) window.clearTimeout(contextGraphPollTimer);
    contextGraphPollTimer = null;
  }

  function scheduleContextGraphPoll(projectId: string) {
    clearContextGraphPoll();
    contextGraphPollTimer = window.setTimeout(() => {
      contextGraphPollTimer = null;
      if (workspaceProject.value?.projectId !== projectId) return;
      void refreshContextGraphStatus(workspaceProject.value, true);
    }, 1200);
  }

  async function loadContextGraph(project: any, schedulePoll = true): Promise<any> {
    const config = readerConfig.value || await getConfig();
    const base = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
    const token = config.documentLocalAgentToken || '';
    const projectId = String(project?.projectId || '');
    if (!projectId) throw new Error('无法查询预处理状态：缺少文档 projectId。');
    const result = await workspaceApi<{ contextGraph: any }>(
      base, token, '/api/documents/projects/' + encodeURIComponent(projectId) + '/context-graph',
    );
    const graph = result.contextGraph || {};
    contextGraphOverview.value = {
      narrativeStyle: typeof graph.overview?.narrativeStyle === 'string' ? graph.overview.narrativeStyle : '',
      styleRules: Array.isArray(graph.overview?.styleRules) ? graph.overview.styleRules.filter((item: unknown): item is string => typeof item === 'string') : [],
    };
    const run = Array.isArray(graph.runs) ? graph.runs[0] : null;
    const status = run?.status || 'not-started';
    contextGraphState.value = {
      projectId,
      sourceRevisionId: graph.sourceRevisionId || '',
      segmentCount: Number(graph.segmentCount || 0),
      counts: {
        characters: Number(graph.counts?.characters || 0),
        entities: Number(graph.counts?.entities || 0),
        relationships: Number(graph.counts?.relationships || 0),
        chapters: Number(graph.counts?.chapters || 0),
        evidencedNodes: Number(graph.counts?.evidencedNodes || 0),
      },
      status,
      phase: run?.phase || 'not-started',
      progress: run?.progress || {},
      runId: run?.runId || '',
      startedAt: run?.startedAt || null,
      finishedAt: run?.finishedAt || null,
      error: run?.error || '',
      loading: false,
      checkedAt: new Date().toISOString(),
    };
    if (schedulePoll && ['queued', 'running'].includes(status)) scheduleContextGraphPoll(projectId);
    else if (!['queued', 'running'].includes(status)) clearContextGraphPoll();
    return graph;
  }

  async function refreshContextGraphStatus(projectOverride?: any, schedulePoll = true) {
    const config = readerConfig.value || await getConfig();
    readerConfig.value = config;
    if (!config.documentUseLocalAgent) return;
    let project = projectOverride || workspaceProject.value;
    if (!project?.projectId && doc.value) project = await deps.ensureWorkspace();
    if (!project?.projectId) return;
    contextGraphState.value = { ...contextGraphState.value, loading: true, error: '' };
    try {
      const graph = await loadContextGraph(project, schedulePoll);
      const latestRun = Array.isArray(graph?.runs) ? graph.runs[0] : null;
      if (effectiveDocumentTranslationMode.value === 'literary' && latestRun?.status === 'completed' &&
          latestRun?.progress?.analysisVersion === CONTEXT_GRAPH_ANALYSIS_VERSION &&
          graph?.sourceRevisionId === contextGraphState.value.sourceRevisionId) {
        // Also bridge completed analyses created by CLI or another UI session into the editable
        // character-memory workflow. The merge preserves human-confirmed names and voice profiles.
        await syncContextGraphEntitiesToMemory(project, graph);
      }
    } catch (error) {
      contextGraphState.value = {
        ...contextGraphState.value,
        projectId: project.projectId,
        loading: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function syncContextGraphEntitiesToMemory(project: any, graph: any) {
    // Context Graph analysis may finish after several translation waves. Always merge against the
    // newest SQLite memory revision, not the reader's possibly stale IndexedDB snapshot.
    const config = readerConfig.value || await getConfig();
    const serverMemory = await workspaceApi<{ current?: { memory?: unknown } }>(
      config.documentLocalAgentUrl || 'http://127.0.0.1:8789',
      config.documentLocalAgentToken || '',
      '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/literary-memory',
    );
    literaryMemory.value = sanitizeLiteraryMemory(serverMemory.current?.memory);
    const next = mergeContextGraphEntitySuggestions(graph, literaryMemory.value);
    if (JSON.stringify(next.entities) === JSON.stringify(literaryMemory.value.entities) &&
        JSON.stringify(next.relationships) === JSON.stringify(literaryMemory.value.relationships) &&
        JSON.stringify(next.characterVoices) === JSON.stringify(literaryMemory.value.characterVoices) &&
        JSON.stringify(next.styleGuide) === JSON.stringify(literaryMemory.value.styleGuide) &&
        next.styleGuideStatus === literaryMemory.value.styleGuideStatus) {
      await deps.persistSession();
      return;
    }
    literaryMemory.value = next;
    await deps.persistLiteraryMemoryToWorkspace();
  }

  async function ensureContextGraphPreprocessing(project: any, options: { force?: boolean } = {}) {
    if (!project?.projectId || effectiveDocumentTranslationMode.value !== 'literary' || readerConfig.value?.documentUseLocalAgent !== true) return;
    const base = readerConfig.value.documentLocalAgentUrl || 'http://127.0.0.1:8789';
    const token = readerConfig.value.documentLocalAgentToken || '';
    const latestTranslationStatus = workspaceActiveRun.value?.status;
    const translationAlreadyActive = ['queued', 'running', 'paused', 'awaiting_acceptance', 'partial'].includes(latestTranslationStatus);
    contextGraphAnalyzing.value = true;
    try {
      let graph = await loadContextGraph(project, false);
      let status = contextGraphState.value.status;
      let run = Array.isArray(graph.runs) ? graph.runs[0] : null;
      const needsVersionUpgrade = status === 'completed' &&
        run?.progress?.analysisVersion !== CONTEXT_GRAPH_ANALYSIS_VERSION;
      const needsLanguageRefresh = status === 'completed' &&
        (run?.progress?.sourceLang !== sourceLang.value || run?.progress?.targetLang !== targetLang.value);
      const shouldStart = options.force === true || status === 'not-started' || status === 'failed' ||
        needsVersionUpgrade || needsLanguageRefresh;
      if (translationAlreadyActive && shouldStart) {
        contextGraphState.value = {
          ...contextGraphState.value,
          error: '当前项目已有翻译任务运行，服务会保护本轮上下文不被修改。翻译结束后再启动预处理。',
        };
        return;
      }
      if (shouldStart) {
        await workspaceApi(
          base, token,
          '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/context-graph/analyze',
          { method: 'POST', body: JSON.stringify({}) },
        );
        graph = await loadContextGraph(project, false);
        const deadline = Date.now() + 45 * 60 * 1000;
        while (['queued', 'running'].includes(contextGraphState.value.status) && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 1200));
          graph = await loadContextGraph(project, false);
        }
        status = contextGraphState.value.status;
        run = Array.isArray(graph.runs) ? graph.runs[0] : null;
        if (['queued', 'running'].includes(status)) {
          contextGraphState.value = {
            ...contextGraphState.value,
            error: '预处理仍在运行；页面会继续显示当前状态。稍后刷新即可查看结果。',
          };
          scheduleContextGraphPoll(project.projectId);
          return;
        }
      } else if (['queued', 'running'].includes(status)) {
        const deadline = Date.now() + 45 * 60 * 1000;
        while (['queued', 'running'].includes(contextGraphState.value.status) && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 1200));
          graph = await loadContextGraph(project, false);
        }
        status = contextGraphState.value.status;
        run = Array.isArray(graph.runs) ? graph.runs[0] : null;
      }
      if (status === 'completed' && run?.progress?.analysisVersion === CONTEXT_GRAPH_ANALYSIS_VERSION) {
        await syncContextGraphEntitiesToMemory(project, graph);
      }
    } catch (error) {
      contextGraphState.value = {
        ...contextGraphState.value,
        status: 'failed',
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
    } finally {
      contextGraphAnalyzing.value = false;
    }
  }

  async function handlePreprocessingStatusRefreshRequested(project?: any) {
    if (project?.projectId) workspaceProject.value = project;
    await refreshContextGraphStatus(project || workspaceProject.value || undefined, true);
  }

  async function openPreprocessingAndEnsure() {
    activeTab.value = 'characters';
    if (!translationPreprocessingRequired.value) {
      await refreshContextGraphStatus(workspaceProject.value || undefined, true);
      return;
    }
    try {
      const project = workspaceProject.value || await deps.ensureWorkspace();
      if (!project?.projectId) return;
      await refreshContextGraphStatus(project, true);
      const readiness = translationPreprocessingReadiness.value;
      if (readiness.ready) return;
      if (!['queued', 'running'].includes(String(contextGraphState.value.status || ''))) {
        await ensureContextGraphPreprocessing(project, { force: false });
      }
    } catch (error) {
      persistenceMessage.value = '无法准备全书预处理：' + (error instanceof Error ? error.message : String(error));
    }
  }

  async function reanalyzeContextGraph() {
    const project = workspaceProject.value || await deps.ensureWorkspace();
    if (!project?.projectId) return;
    await ensureContextGraphPreprocessing(project, { force: true });
  }

    /** 切换文档时清空预处理状态与轮询；服务端项目不会被删除。 */
    function resetContextGraph(): void {
      contextGraphAnalyzing.value = false;
      if (contextGraphPollTimer !== null) window.clearTimeout(contextGraphPollTimer);
      contextGraphPollTimer = null;
      contextGraphState.value = {
        projectId: '', sourceRevisionId: '', segmentCount: 0,
        counts: { characters: 0, entities: 0, relationships: 0, chapters: 0, evidencedNodes: 0 },
        status: 'not-started', phase: 'not-started', progress: {}, runId: '',
        startedAt: null, finishedAt: null, error: '', loading: false, checkedAt: '',
      };
      contextGraphOverview.value = { narrativeStyle: '', styleRules: [] };
    }

  return {
    contextGraphState,
    contextGraphAnalyzing,
    contextGraphOverview,
    contextGraphStatusLabel,
    contextGraphPhaseLabel,
    contextGraphProgressPercent,
    translationPreprocessingRequired,
    translationPreprocessingReadiness,
    translationBlockedByPreprocessing,
    translationPreprocessingUiState,
    clearContextGraphPoll,
    loadContextGraph,
    refreshContextGraphStatus,
    syncContextGraphEntitiesToMemory,
    ensureContextGraphPreprocessing,
    handlePreprocessingStatusRefreshRequested,
    openPreprocessingAndEnsure,
    reanalyzeContextGraph,
    resetContextGraph,
  };
}
