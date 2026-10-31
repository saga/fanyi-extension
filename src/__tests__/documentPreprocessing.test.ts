import { describe, expect, it } from 'vitest';
import {
  assessContextGraphReadiness,
  contextGraphSnapshotFromResponse,
  isContextGraphBusy,
  preprocessingGateTitle,
  resolveDocumentTranslationMode,
  shouldAutoStartPreprocessing,
  styleGuideBadge,
} from '../entrypoints/document/documentPreprocessing';

const baseInput = {
  required: true,
  expectedProjectId: 'project-1',
  expectedSourceRevisionId: 'source-2',
  sourceLang: 'en',
  targetLang: 'zh',
};
const completedSnapshot = {
  projectId: 'project-1',
  sourceRevisionId: 'source-2',
  // 服务端当前版本与记录版本一致时才算就绪。
  currentAnalysisVersion: 'context-graph-v9-current',
  status: 'completed',
  phase: 'completed',
  styleGuideReady: true,
  styleMissingFields: [],
  runId: 'preprocess-run',
  progress: {
    analysisVersion: 'context-graph-v9-current',
    sourceLang: 'en',
    targetLang: 'zh',
    strategy: 'B',
    completedStages: ['style', 'characters', 'entities', 'relationships', 'chapters'],
  },
};

describe('literary preprocessing readiness gate', () => {
  it('compares the record version against the version reported by the service', () => {
    // 回归点：扩展曾硬编码 v7，服务端升到 v9 后所有已完成的记录都被误判为「版本过旧」。
    // 版本号只允许来自服务端响应，任何本地常量都会再次漂移。
    const matched = assessContextGraphReadiness({
      ...baseInput,
      snapshot: { ...completedSnapshot, currentAnalysisVersion: 'context-graph-v10-next' },
    });
    expect(matched.reason).toBe('version');
    expect(matched.message).toContain('context-graph-v10-next');

    const aligned = assessContextGraphReadiness({ ...baseInput, snapshot: completedSnapshot });
    expect(aligned.ready).toBe(true);
  });

  it('blocks translation when the service did not report its current analysis version', () => {
    const result = assessContextGraphReadiness({
      ...baseInput,
      snapshot: { ...completedSnapshot, currentAnalysisVersion: undefined },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('checking');
  });

  it('marks non-literary or non-local translation as not requiring this status', () => {
    expect(assessContextGraphReadiness({ ...baseInput, required: false }).ready).toBe(true);
  });

  it('reports a checking status while project/revision state is unknown', () => {
    const result = assessContextGraphReadiness({
      ...baseInput, expectedProjectId: null, snapshot: null,
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('checking');
  });

  it.each(['queued', 'running'] as const)('blocks translation while preprocessing is %s', (status) => {
    const result = assessContextGraphReadiness({
      ...baseInput,
      snapshot: { ...completedSnapshot, status, phase: status },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe(status);
    expect(result.message).toContain('预处理');
  });

  it('reports failed preprocessing and preserves actionable diagnostics', () => {
    const result = assessContextGraphReadiness({
      ...baseInput,
      snapshot: { ...completedSnapshot, status: 'failed', error: 'model quota' },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('failed');
  });

  it('reports an index from another source revision', () => {
    const result = assessContextGraphReadiness({
      ...baseInput,
      snapshot: { ...completedSnapshot, sourceRevisionId: 'source-1' },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('source-revision');
  });

  it('reports an obsolete preprocessing version or a language mismatch', () => {
    const oldVersion = assessContextGraphReadiness({
      ...baseInput,
      snapshot: { ...completedSnapshot, progress: { ...completedSnapshot.progress, analysisVersion: 'old-version' } },
    });
    expect(oldVersion.reason).toBe('version');

    const languageMismatch = assessContextGraphReadiness({
      ...baseInput,
      targetLang: 'ja',
      snapshot: completedSnapshot,
    });
    expect(languageMismatch.reason).toBe('language');
  });

  it('marks the projection ready only when revision, analysis version and languages all match', () => {
    const result = assessContextGraphReadiness({ ...baseInput, snapshot: completedSnapshot });
    expect(result.ready).toBe(true);
  });


  it('blocks a completed run whose style baseline or workflow stages are incomplete', () => {
    const missingStyle = assessContextGraphReadiness({
      ...baseInput,
      snapshot: { ...completedSnapshot, styleGuideReady: false, styleMissingFields: ['styleRhythm'] },
    });
    expect(missingStyle.ready).toBe(false);
    expect(missingStyle.reason).toBe('incomplete');
    expect(missingStyle.message).toContain('styleRhythm');

    const missingStage = assessContextGraphReadiness({
      ...baseInput,
      snapshot: {
        ...completedSnapshot,
        progress: {
          ...completedSnapshot.progress,
          completedStages: ['style', 'characters', 'entities', 'relationships'],
        },
      },
    });
    expect(missingStage.ready).toBe(false);
    expect(missingStage.reason).toBe('incomplete');
    expect(missingStage.message).toContain('chapters');
  });

  it('blocks completed records that do not identify a supported preprocessing workflow', () => {
    const result = assessContextGraphReadiness({
      ...baseInput,
      snapshot: {
        ...completedSnapshot,
        progress: { ...completedSnapshot.progress, strategy: undefined },
      },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('incomplete');
  });

  it('reports a status refresh error even if a previous snapshot looked completed', () => {
    const result = assessContextGraphReadiness({
      ...baseInput,
      snapshot: { ...completedSnapshot, error: '本机服务暂时不可用' },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('checking');
    expect(result.message).toContain('本机服务暂时不可用');
  });

  it('normalizes the API response into the same snapshot shape for both UI entry points', () => {
    const snapshot = contextGraphSnapshotFromResponse('project-1', {
      sourceRevisionId: 'source-2',
      currentAnalysisVersion: 'context-graph-v9-current',
      runs: [{
        runId: 'preprocess-run',
        status: 'running',
        phase: 'model-analysis',
        progress: { sampleCount: 72 },
      }],
    });
    expect(snapshot).toMatchObject({
      projectId: 'project-1',
      sourceRevisionId: 'source-2',
      currentAnalysisVersion: 'context-graph-v9-current',
      runId: 'preprocess-run',
      status: 'running',
      phase: 'model-analysis',
    });
  });

  it('gives every block reason its own banner title', () => {    // 回归点：旧模板只判了 4 个 reason，其余全部落到「尚无可用的全书预处理记录」，
    // 于是「预处理完成」的运行也会显示成「没有记录」。
    const reasons = [
      'queued', 'running', 'failed', 'language', 'version', 'incomplete',
      'missing', 'source-revision', 'project', 'checking',
    ] as const;
    const titles = reasons.map((reason) => preprocessingGateTitle(reason));
    expect(titles.every((title) => title.length > 0)).toBe(true);
    // queued/running 共用一条「正在准备」文案是刻意的；其余每个 reason 必须能区分开。
    const distinctReasons = reasons.filter((reason) => reason !== 'running');
    const distinctTitles = distinctReasons.map((reason) => preprocessingGateTitle(reason));
    expect(new Set(distinctTitles).size).toBe(distinctReasons.length);
    expect(preprocessingGateTitle('version')).not.toContain('没有');
    expect(preprocessingGateTitle('missing')).toContain('没有完成');
  });
});


describe('context graph busy state (button disable guard)', () => {
  it('treats queued and running preprocessing as busy', () => {
    expect(isContextGraphBusy('queued')).toBe(true);
    expect(isContextGraphBusy('running')).toBe(true);
  });

  it('keeps the trigger disabled while the analyze request is in flight', () => {
    expect(isContextGraphBusy('completed', true)).toBe(true);
    expect(isContextGraphBusy('not-started', true)).toBe(true);
  });

  it('allows retry only after preprocessing reached a terminal state', () => {
    expect(isContextGraphBusy('completed')).toBe(false);
    expect(isContextGraphBusy('failed')).toBe(false);
    expect(isContextGraphBusy('not-started')).toBe(false);
    expect(isContextGraphBusy(undefined)).toBe(false);
  });
});

describe('document translation mode resolution', () => {
  it('keeps EPUB/PDF per-document literary mode enabled even when the global default is technical', () => {
    expect(resolveDocumentTranslationMode(true, 'technical')).toBe('literary');
  });

  it('honors the global literary profile when per-document mode is not enabled', () => {
    expect(resolveDocumentTranslationMode(false, 'literary')).toBe('literary');
  });

  it('uses technical mode as the safe default when neither setting enables literary translation', () => {
    expect(resolveDocumentTranslationMode(false, 'technical')).toBe('technical');
    expect(resolveDocumentTranslationMode(false, undefined)).toBe('technical');
    expect(resolveDocumentTranslationMode(false, null)).toBe('technical');
  });
});

describe('style guide badge', () => {
  it('says the machine baseline is already applied, with no confirmation step', () => {
    // 回归点：机器基准一直由 TranslationBrief 自动注入，但徽章与「确认并注入」按钮
    // 让用户以为还要手动确认一次。
    const badge = styleGuideBadge({ autoDisabled: false, origin: 'legacy-unknown', graphReady: true });
    expect(badge).toEqual({ label: '已自动应用', tone: 'active' });
  });

  it('reports user edits and the disabled state truthfully', () => {
    expect(styleGuideBadge({ autoDisabled: false, origin: 'user-edited', graphReady: true }).label)
      .toBe('你的编辑已生效');
    const disabled = styleGuideBadge({ autoDisabled: true, origin: 'user-edited', graphReady: true });
    expect(disabled).toEqual({ label: '机器基准已停用', tone: 'inactive' });
  });

  it('does not claim an active baseline before preprocessing is ready', () => {
    const badge = styleGuideBadge({ autoDisabled: false, origin: 'legacy-unknown', graphReady: false });
    expect(badge).toEqual({ label: '预处理未就绪', tone: 'inactive' });
  });
});

describe('automatic preprocessing on document open', () => {
  const open = {
    required: true,
    status: 'not-started',
    segmentCount: 1200,
    analyzing: false,
    alreadyAttempted: false,
  };

  it('starts preprocessing when the document was never analysed', () => {
    expect(shouldAutoStartPreprocessing(open)).toBe(true);
  });

  it('does not spend a full-book analysis on failed or outdated records', () => {
    // failed 可能是模型/配置问题，版本过旧是成本决策，两者都必须由用户点「重新分析全书」。
    expect(shouldAutoStartPreprocessing({ ...open, status: 'failed' })).toBe(false);
    expect(shouldAutoStartPreprocessing({ ...open, status: 'completed' })).toBe(false);
    expect(shouldAutoStartPreprocessing({ ...open, status: 'queued' })).toBe(false);
    expect(shouldAutoStartPreprocessing({ ...open, status: 'running' })).toBe(false);
  });

  it('stays out of the way for technical mode and empty projects', () => {
    expect(shouldAutoStartPreprocessing({ ...open, required: false })).toBe(false);
    expect(shouldAutoStartPreprocessing({ ...open, segmentCount: 0 })).toBe(false);
  });

  it('fires once per project revision so a rejected start cannot loop', () => {
    expect(shouldAutoStartPreprocessing({ ...open, alreadyAttempted: true })).toBe(false);
    expect(shouldAutoStartPreprocessing({ ...open, analyzing: true })).toBe(false);
  });
});
