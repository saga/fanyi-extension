import { computed, ref, type Ref } from 'vue';
import { getConfig, type Config } from '@/entrypoints/utils/config';
import type { ParsedDocument } from '@/entrypoints/utils/document/types';
import { workspaceApi } from './documentWorkspaceClient';
import {
  agentTrajectoryRelatedFailureEvents as agentTrajectoryRelatedFailureEventsOf,
  computeAgentTrajectoryActiveTasks,
  filterAgentTrajectoryEvents,
  type AgentTrajectoryFilter,
} from './documentAgentTrajectory';

export interface AgentTrajectoryDeps {
  activeTab: Ref<string>;
  readerConfig: Ref<Config | null>;
  workspaceProject: Ref<any>;
  doc: Ref<ParsedDocument | null>;
  ensureWorkspace: () => Promise<any | null>;
}

/**
 * Agent 轨迹的轮询与失败详情状态。
 *
 * 只负责读取/筛选服务端已持久化的事件；不启动、不取消任何翻译运行。
 */
export function useAgentTrajectory(deps: AgentTrajectoryDeps) {
  const agentTrajectoryEvents = ref<any[]>([]);
  const agentTrajectoryCursor = ref(0);
  const agentTrajectoryLoading = ref(false);
  const agentTrajectoryError = ref('');
  const agentTrajectoryFilter = ref<AgentTrajectoryFilter>('all');
  const expandedAgentFailureEventId = ref<number | string | null>(null);
  const agentTrajectoryFailureDetails = ref<Record<string, any[]>>({});
  const agentTrajectoryFailureLoading = ref<Record<string, boolean>>({});
  const agentTrajectoryFailureErrors = ref<Record<string, string>>({});
  let agentTrajectoryPollTimer: number | null = null;
  let agentTrajectoryRequestGeneration = 0;
  /** 模板只传事件本身；轨迹列表由阅读页统一持有。 */
  function agentTrajectoryRelatedFailureEvents(event: any): any[] {
    return agentTrajectoryRelatedFailureEventsOf(agentTrajectoryEvents.value, event);
  }

  function stopAgentTrajectoryPolling() {
    if (agentTrajectoryPollTimer !== null) window.clearTimeout(agentTrajectoryPollTimer);
    agentTrajectoryPollTimer = null;
    agentTrajectoryRequestGeneration++;
  }

  async function refreshAgentTrajectory(reset = false): Promise<void> {
    if (reset) agentTrajectoryRequestGeneration++;
    const config = deps.readerConfig.value || await getConfig();
    deps.readerConfig.value = config;
    if (!config.documentUseLocalAgent) {
      agentTrajectoryError.value = '请先启用本机 Local Agent，才能读取持久化 Agent 轨迹。';
      return;
    }
    let project = deps.workspaceProject.value;
    if (!project?.projectId) project = await deps.ensureWorkspace();
    if (!project?.projectId) {
      agentTrajectoryError.value = '尚未建立当前文档的本机项目，暂时无法读取事件。';
      return;
    }
    const generation = agentTrajectoryRequestGeneration;
    if (reset) {
      agentTrajectoryCursor.value = 0;
      agentTrajectoryEvents.value = [];
    }
    agentTrajectoryLoading.value = true;
    try {
      const base = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
      const token = config.documentLocalAgentToken || '';
      const query = reset || agentTrajectoryCursor.value <= 0
        ? '?latest=true&limit=500'
        : '?after=' + agentTrajectoryCursor.value + '&limit=500';
      const response = await workspaceApi<{ events: any[] }>(
        base, token,
        '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/events' + query,
      );
      if (generation !== agentTrajectoryRequestGeneration || deps.activeTab.value !== 'trajectory') return;
      const incoming = Array.isArray(response.events) ? response.events : [];
      if (reset || agentTrajectoryCursor.value <= 0) {
        agentTrajectoryEvents.value = incoming.slice(-600);
      } else if (incoming.length) {
        const seen = new Set(agentTrajectoryEvents.value.map((item) => item.eventId));
        agentTrajectoryEvents.value = [...agentTrajectoryEvents.value, ...incoming.filter((item) => !seen.has(item.eventId))].slice(-600);
      }
      agentTrajectoryCursor.value = agentTrajectoryEvents.value.reduce(
        (max, item) => Math.max(max, Number(item.eventId) || 0), agentTrajectoryCursor.value,
      );
      agentTrajectoryError.value = '';
    } catch (error) {
      if (generation === agentTrajectoryRequestGeneration) {
        agentTrajectoryError.value = '读取 Agent 轨迹失败：' + (error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === agentTrajectoryRequestGeneration) agentTrajectoryLoading.value = false;
    }
  }

  function scheduleAgentTrajectoryPoll(): void {
    if (deps.activeTab.value !== 'trajectory') return;
    if (agentTrajectoryPollTimer !== null) window.clearTimeout(agentTrajectoryPollTimer);
    agentTrajectoryPollTimer = window.setTimeout(async () => {
      agentTrajectoryPollTimer = null;
      await refreshAgentTrajectory(false);
      scheduleAgentTrajectoryPoll();
    }, 1200);
  }

  async function startAgentTrajectoryPolling(): Promise<void> {
    stopAgentTrajectoryPolling();
    if (deps.activeTab.value !== 'trajectory') return;
    await refreshAgentTrajectory(true);
    scheduleAgentTrajectoryPoll();
  }

  async function toggleAgentTrajectoryFailureDetails(event: any): Promise<void> {
    if (expandedAgentFailureEventId.value === event?.eventId) {
      expandedAgentFailureEventId.value = null;
      return;
    }
    const runId = String(event?.runId || '');
    if (!runId) return;
    expandedAgentFailureEventId.value = event.eventId;
    if (Object.prototype.hasOwnProperty.call(agentTrajectoryFailureDetails.value, runId)) return;

    agentTrajectoryFailureLoading.value = { ...agentTrajectoryFailureLoading.value, [runId]: true };
    agentTrajectoryFailureErrors.value = { ...agentTrajectoryFailureErrors.value, [runId]: '' };
    try {
      const config = deps.readerConfig.value || await getConfig();
      deps.readerConfig.value = config;
      if (!config.documentUseLocalAgent) throw new Error('请先启用本机 Local Agent，才能读取失败片段详情。');
      const project = deps.workspaceProject.value || await deps.ensureWorkspace();
      if (!project?.projectId) throw new Error('尚未建立当前文档的本机项目。');
      const base = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
      const token = config.documentLocalAgentToken || '';
      const response = await workspaceApi<{ run: any }>(
        base, token,
        '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs/' + encodeURIComponent(runId),
      );
      const run = response.run || {};
      const runSegments = Array.isArray(run.segments) ? run.segments : [];
      const failedRows = runSegments.filter((item: any) => item.status === 'failed');
      const reportedIds = agentTrajectoryEvents.value
        .filter((item) => String(item.runId || '') === runId)
        .flatMap((item) => Array.isArray(item.payload?.failedIds) ? item.payload.failedIds.map(String) : []);
      const ids = Array.from(new Set([
        ...failedRows.map((item: any) => String(item.id)),
        ...reportedIds,
      ]));
      const sourceById = new Map<string, any>(
        (deps.doc.value?.segments || []).map((item: any): [string, any] => [String(item.id), item]),
      );
      const details = ids.map((id) => {
        const row = runSegments.find((item: any) => String(item.id) === id);
        const source = sourceById.get(id);
        return {
          id,
          status: String(row?.status || 'failed'),
          attempts: Number(row?.attempts || 0),
          error: typeof row?.error === 'string' ? row.error : '',
          contextPath: String(source?.contextPath || source?.chapter || ''),
          sourceExcerpt: String(source?.text || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        };
      });
      agentTrajectoryFailureDetails.value = { ...agentTrajectoryFailureDetails.value, [runId]: details };
    } catch (error) {
      agentTrajectoryFailureErrors.value = {
        ...agentTrajectoryFailureErrors.value,
        [runId]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      agentTrajectoryFailureLoading.value = { ...agentTrajectoryFailureLoading.value, [runId]: false };
    }
  }

  const agentTrajectoryVisibleEvents = computed(() =>
    filterAgentTrajectoryEvents(agentTrajectoryEvents.value, agentTrajectoryFilter.value),
  );

  const agentTrajectoryActiveTasks = computed(() => computeAgentTrajectoryActiveTasks(agentTrajectoryEvents.value));


  return {
    agentTrajectoryEvents,
    agentTrajectoryCursor,
    agentTrajectoryLoading,
    agentTrajectoryError,
    agentTrajectoryFilter,
    expandedAgentFailureEventId,
    agentTrajectoryFailureDetails,
    agentTrajectoryFailureLoading,
    agentTrajectoryFailureErrors,
    agentTrajectoryVisibleEvents,
    agentTrajectoryActiveTasks,
    stopAgentTrajectoryPolling,
    refreshAgentTrajectory,
    startAgentTrajectoryPolling,
    toggleAgentTrajectoryFailureDetails,
    agentTrajectoryRelatedFailureEvents,
  };
}
