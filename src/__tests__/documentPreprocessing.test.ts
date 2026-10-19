import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GRAPH_ANALYSIS_VERSION,
  assessContextGraphReadiness,
  contextGraphSnapshotFromResponse,
  resolveDocumentTranslationMode,
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
  status: 'completed',
  phase: 'completed',
  runId: 'preprocess-run',
  progress: {
    analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
    sourceLang: 'en',
    targetLang: 'zh',
  },
};

describe('literary preprocessing status projection (informational only)', () => {
  it('does not block non-literary or non-local translation', () => {
    expect(assessContextGraphReadiness({ ...baseInput, required: false }).ready).toBe(true);
  });

  it('reports a checking status while project/revision state is unknown', () => {
    const result = assessContextGraphReadiness({
      ...baseInput, expectedProjectId: null, snapshot: null,
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('checking');
  });

  it.each(['queued', 'running'] as const)('reports status while preprocessing is %s without deciding whether a Run may be submitted', (status) => {
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
      runId: 'preprocess-run',
      status: 'running',
      phase: 'model-analysis',
    });
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
