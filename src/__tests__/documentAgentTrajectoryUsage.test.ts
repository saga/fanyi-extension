/**
 * Agent 轨迹的 token 消耗展示（model.usage / run.finished）。
 *
 * 回归背景：本机 Agent 服务的每次模型调用现在都会发一条 `model.usage` 事件，
 * run.finished / run.failed 带累计 usage。轨迹里要能一眼看到「每轮花了多少 token、
 * 整个运行一共花了多少」，并且历史事件没有 usage 字段时不能渲染出 0。
 */
import { describe, expect, it } from 'vitest';

import {
  agentTrajectoryDetail,
  agentTrajectoryTitle,
  computeAgentTrajectoryActiveTasks,
  filterAgentTrajectoryEvents,
  formatTokenCount,
} from '../entrypoints/document/documentAgentTrajectory';

describe('formatTokenCount', () => {
  it('万位以上折算为 k，小数字保持千分位', () => {
    expect(formatTokenCount(970)).toBe('970');
    expect(formatTokenCount(3620)).toBe('3,620');
    expect(formatTokenCount(43210)).toBe('43.2k');
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(undefined)).toBe('0');
  });
});

describe('model.usage 事件', () => {
  const event = {
    type: 'model.usage',
    runId: 'run-1',
    payload: {
      stage: 'translate',
      batchIndex: 3,
      inputTokens: 3287,
      outputTokens: 97,
      cacheReadTokens: 512,
      cacheCreationTokens: 2775,
      totalInputTokens: 6574,
      totalTokens: 6671,
      durationMs: 3658,
      numTurns: 1,
    },
  };

  it('标题与角色按翻译 Agent 归类', () => {
    expect(agentTrajectoryTitle(event)).toBe('本次模型调用 token 消耗');
  });

  it('详情包含输入/缓存/输出/合计与耗时', () => {
    const detail = agentTrajectoryDetail(event);
    expect(detail).toContain('输入 6,574');
    expect(detail).toContain('缓存 3,287');
    expect(detail).toContain('输出 97');
    expect(detail).toContain('合计 6,671');
    expect(detail).toContain('耗时 3.7 秒');
  });

  it('totalCostUsd 大于 0 时显示费用，订阅模式（0/缺失）不显示', () => {
    const paid = agentTrajectoryDetail({
      ...event,
      payload: { ...event.payload, totalCostUsd: 0.0123 },
    });
    expect(paid).toContain('费用 $0.0123');
    expect(agentTrajectoryDetail(event)).not.toContain('费用');
  });

  it('模型筛选包含 model.usage 事件', () => {
    const filtered = filterAgentTrajectoryEvents([event], 'model');
    expect(filtered).toContain(event);
  });
});

describe('run.finished 的累计 token', () => {
  it('带 usage 时渲染累计行', () => {
    const detail = agentTrajectoryDetail({
      type: 'run.finished',
      runId: 'run-1',
      payload: {
        status: 'completed',
        counts: { candidate: 10, accepted: 10, failed: 0, total: 10 },
        usage: {
          inputTokens: 12000, outputTokens: 3000,
          cacheReadTokens: 100000, cacheCreationTokens: 0,
          totalInputTokens: 112000, totalTokens: 115000,
        },
      },
    });
    expect(detail).toContain('累计 输入 112.0k');
    expect(detail).toContain('输出 3,000');
    expect(detail).toContain('合计 115.0k');
  });

  it('历史事件没有 usage 时不渲染 0', () => {
    const detail = agentTrajectoryDetail({
      type: 'run.finished',
      runId: 'run-1',
      payload: { status: 'completed', counts: { candidate: 1, accepted: 1, failed: 0, total: 1 } },
    });
    expect(detail).not.toContain('累计');
  });
});

describe('Agent 轨迹活跃任务的终态收敛', () => {
  it('同一个 Context Graph run 收到 failed 终态事件后不再显示为运行中', () => {
    const tasks = computeAgentTrajectoryActiveTasks([
      {
        eventId: 10, runId: 'old-graph-run', type: 'context-graph.phase',
        payload: { phase: 'model-analysis' },
      },
      {
        eventId: 11, runId: 'old-graph-run', type: 'context-graph.failed',
        payload: { error: '服务重启后分析中断' },
      },
    ]);
    expect(tasks).toEqual([]);
  });

  it('旧 run 的终态不能清除另一个 run 的活跃任务', () => {
    const tasks = computeAgentTrajectoryActiveTasks([
      {
        eventId: 10, runId: 'old-graph-run', type: 'context-graph.phase',
        payload: { phase: 'model-analysis' },
      },
      {
        eventId: 11, runId: 'old-graph-run', type: 'context-graph.failed',
        payload: { error: 'timeout' },
      },
      {
        eventId: 12, runId: 'new-graph-run', type: 'context-graph.phase',
        payload: { phase: 'model-analysis' },
      },
    ]);
    expect(tasks.map((task) => task.runId)).toEqual(['new-graph-run']);
  });

  it('服务端已将旧 run 标为 failed 时，即使没有 failed 事件也不显示为活跃', () => {
    const tasks = computeAgentTrajectoryActiveTasks([
      {
        eventId: 10, runId: 'legacy-orphan', type: 'context-graph.phase',
        payload: { phase: 'model-analysis' },
      },
    ], [
      { runId: 'legacy-orphan', status: 'failed', phase: 'failed', active: false },
    ]);
    expect(tasks).toEqual([]);
  });

  it('事件窗口未包含 phase 时，从服务端仍活跃的 run 重建预处理任务', () => {
    const tasks = computeAgentTrajectoryActiveTasks([], [
      { runId: 'live-run', status: 'running', phase: 'model-analysis', active: true },
    ]);
    expect(tasks).toEqual([{
      key: 'live-run:context-graph',
      runId: 'live-run',
      role: '全书预处理 Agent',
      title: '正在分析人物、实体与规范译名',
    }]);
  });

  it('翻译 Run 暂停后清除其仍未完成的阶段任务', () => {
    const tasks = computeAgentTrajectoryActiveTasks([
      {
        eventId: 20, runId: 'paused-translation', type: 'stage.started',
        payload: { stage: 'translate', label: '开始翻译' },
      },
      {
        eventId: 21, runId: 'paused-translation', type: 'run.paused',
        payload: { error: 'user paused' },
      },
    ]);
    expect(tasks).toEqual([]);
  });
});

