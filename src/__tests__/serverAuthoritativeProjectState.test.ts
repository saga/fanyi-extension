import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest can expose a transformed URL rather than a file: URL in CI; resolve source paths
// from the repository root instead of relying on new URL(..., import.meta.url).
const app = readFileSync(resolve(process.cwd(), 'src/entrypoints/document/App.vue'), 'utf8');
const workspace = readFileSync(resolve(process.cwd(), 'src/entrypoints/document/DocumentAgentWorkspace.vue'), 'utf8');
const contextGraph = readFileSync(resolve(process.cwd(), 'src/entrypoints/document/useContextGraph.ts'), 'utf8');

describe('server-authoritative document project state', () => {
  it('does not disable normal translation controls based on client preprocessing readiness', () => {
    expect(workspace).not.toContain('preprocessingBlockedByPreprocessing');
    expect(workspace).not.toContain('preprocessingState.required && preprocessingState.ready === false && !!project');
    expect(app).not.toMatch(/:disabled="[^"]*translationPreprocessingNeedsAttention/);
  });

  it('starts preprocessing on open only through the composable, and only for a never-analysed revision', () => {
    // App.vue 的打开/恢复/同步路径只读状态，不直接发起分析。
    expect(app).not.toMatch(/(?:await|void)\s+ensureContextGraphPreprocessing\s*\(/);
    expect(app).toContain('void refreshContextGraphStatus(refreshed.project, true)');
    expect(app).toContain('await refreshContextGraphStatus(refreshed.project, true)');
    // 自动启动的判定集中在 composable + 纯函数里，由状态刷新统一触发。
    expect(contextGraph).toContain('shouldAutoStartPreprocessing({');
    expect(contextGraph).toContain('await ensureContextGraphPreprocessing(project, { auto: true })');
  });

  it('keeps manual re-analysis as an explicit user command', () => {
    expect(app).toContain('@click="reanalyzeContextGraph"');
    expect(contextGraph).toContain('async function reanalyzeContextGraph()');
    expect(contextGraph).toContain('await ensureContextGraphPreprocessing(project, { force: true })');
  });

  it('shows preprocessing diagnostics without replacing the first-run or restore controls', () => {
    expect(workspace).toContain('v-if="preprocessingState.required && !preprocessingState.ready"');
    expect(workspace).toContain('v-if="restoringProject && !project"');
    expect(workspace).toContain('v-if="restorationError && !project"');
    expect(workspace).toContain('v-if="!project && !restoringProject && !restorationError"');
  });
});


describe('Local Agent document ingestion boundary', () => {
  it('routes selected EPUB/PDF originals to Local Agent for parsing', () => {
    expect(app).toContain('importDocumentFileViaLocalAgent(base, token, file)');
    expect(app).toContain('loadWorkspaceParsedDocument(base, token, imported.project)');
    expect(app).toContain('本机服务模式下 EPUB/PDF 必须通过原始文件导入');
  });

  it('stores reader-resume metadata as a project pointer instead of copying document, translations or LiteraryMemory', () => {
    const start = app.indexOf('async function persistDocumentCheckpointToLocalService');
    const end = app.indexOf('async function loadDocumentCheckpointFromLocalService', start);
    const checkpointWriter = app.slice(start, end);
    expect(checkpointWriter).toContain('projectBacked: true');
    expect(checkpointWriter).toContain('projectId,');
    expect(checkpointWriter).toContain('mergeExisting: false');
    expect(checkpointWriter).not.toContain('document: doc.value');
    expect(checkpointWriter).not.toContain('rawText,');
    expect(checkpointWriter).not.toContain('snapshot: input.snapshot');
    expect(checkpointWriter).not.toContain('literaryMemory:');
  });

  it('rehydrates a project-backed reader checkpoint from Local Agent project APIs', () => {
    const start = app.indexOf('async function loadDocumentCheckpointFromLocalService');
    const end = app.indexOf('async function persistCurrentSession', start);
    const checkpointReader = app.slice(start, end);
    expect(checkpointReader).toContain('payload.projectBacked === true');
    expect(checkpointReader).toContain('loadWorkspaceParsedDocument');
    expect(checkpointReader).toContain('loadWorkspaceAcceptedTranslations');
    expect(checkpointReader).toContain('/literary-memory');
  });

  it('does not send EPUB/PDF segment arrays to project resolution from Agent Workspace', () => {
    expect(workspace).toContain('const isLocalAgentBook = /^(epub|pdf)$/i.test(props.format)');
    expect(workspace).toContain('importDocumentFileViaLocalAgent');
    expect(workspace).toContain('Never send the parsed');
  });
});
