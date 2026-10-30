import { describe, expect, it } from 'vitest';
import {
  agentProgressCopy,
  canAutoAcceptRun,
  humanizeAgentError,
  pickInitialRun,
} from '../entrypoints/document/documentAgentPresentation';

const base = { isRunning: false, acceptedSegments: 0, totalSegments: 7366, pendingSegments: 7366 };

describe('agent progress copy', () => {
  it('treats an untouched document as not started, never as "continue"', () => {
    // 回归点：accepted===0 曾被写成「等待继续 / 继续完成这份文档」，
    // 用户第一次打开面板就被告知在续做一件没做过的事。
    const copy = agentProgressCopy(base);
    expect(copy.phase).toBe('idle');
    expect(copy.kicker).toBe('尚未开始');
    expect(copy.title).not.toContain('继续');
    expect(copy.actionLabel).toBe('开始翻译');
    // 没有进度时不要画 0% 和空进度条。
    expect(copy.showProgress).toBe(false);
  });

  it('states the real remaining count once some segments are translated', () => {
    const copy = agentProgressCopy({ ...base, acceptedSegments: 1200, pendingSegments: 6166 });
    expect(copy.phase).toBe('resuming');
    expect(copy.title).toContain('6,166');
    expect(copy.actionLabel).toBe('继续翻译');
    expect(copy.showProgress).toBe(true);
  });

  it('reports running and complete states without progress ambiguity', () => {
    expect(agentProgressCopy({ ...base, isRunning: true }).phase).toBe('running');
    expect(agentProgressCopy({ ...base, isRunning: true }).percentLabel).toBe('本次任务');

    const done = agentProgressCopy({ ...base, acceptedSegments: 7366, pendingSegments: 0 });
    expect(done.phase).toBe('complete');
    expect(done.actionLabel).toBe('');
    expect(done.showProgress).toBe(true);
  });
});

describe('auto accept eligibility', () => {
  it('refuses to settle a run that still has unfinished segments', () => {
    // failed/paused 的 Run 常留着 pending 片段，服务端会以 409 拒绝结算；
    // 这种状态正确动作是恢复运行，不是「重试保存」。
    expect(canAutoAcceptRun({ status: 'failed', counts: { candidate: 78 } })).toBe(false);
    expect(canAutoAcceptRun({ status: 'paused', counts: { candidate: 78 } })).toBe(false);
    expect(canAutoAcceptRun({ status: 'running', counts: { candidate: 78 } })).toBe(false);
  });

  it('allows settlement for terminal runs that actually hold candidates', () => {
    expect(canAutoAcceptRun({ status: 'awaiting_acceptance', counts: { candidate: 5 } })).toBe(true);
    expect(canAutoAcceptRun({ status: 'partial', counts: { candidate: 5 } })).toBe(true);
    expect(canAutoAcceptRun({ status: 'completed', counts: { candidate: 5 } })).toBe(true);
    expect(canAutoAcceptRun({ status: 'completed', counts: { candidate: 0 } })).toBe(false);
    expect(canAutoAcceptRun(null)).toBe(false);
  });
});

describe('initial run selection', () => {
  const automation = (runId: string, status: string) => ({
    runId, status, scope: { automation: { kind: 'quality-audit-repair' } },
  });
  const manual = (runId: string, status: string) => ({ runId, status });

  it('does not surface an interrupted auto-repair child as the main run', () => {
    // 服务重启会打断自动修复子 Run，它排在 runs[0]；直接取第一条会让用户
    // 一打开面板就看到「失败」和一条看不懂的采纳错误。
    const runs = [automation('child-failed', 'failed'), manual('parent-done', 'completed')];
    expect(pickInitialRun(runs)?.runId).toBe('parent-done');
  });

  it('still follows a live run, including an automatic one', () => {
    expect(pickInitialRun([manual('old', 'completed'), automation('live', 'running')])?.runId).toBe('live');
  });

  it('falls back to the newest run when every run is automatic', () => {
    expect(pickInitialRun([automation('a', 'failed')])?.runId).toBe('a');
    expect(pickInitialRun([])).toBeNull();
    expect(pickInitialRun(null)).toBeNull();
  });
});

describe('error copy', () => {
  it('rewrites internal acceptance wording into an actionable sentence', () => {
    const copy = humanizeAgentError('运行仍包含待处理或执行中的片段，拒绝结束采纳事务。');
    expect(copy).not.toContain('事务');
    expect(copy).toContain('恢复运行');
  });

  it('keeps unknown errors verbatim so real causes are not hidden', () => {
    expect(humanizeAgentError('数据库被锁定')).toBe('数据库被锁定');
    expect(humanizeAgentError('')).toBe('');
    expect(humanizeAgentError(null)).toBe('');
  });
});
