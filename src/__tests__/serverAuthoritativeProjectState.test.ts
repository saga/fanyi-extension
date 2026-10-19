import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../entrypoints/document/App.vue', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../entrypoints/document/DocumentAgentWorkspace.vue', import.meta.url), 'utf8');
const contextGraph = readFileSync(new URL('../entrypoints/document/useContextGraph.ts', import.meta.url), 'utf8');

describe('server-authoritative document project state', () => {
  it('does not disable normal translation controls based on client preprocessing readiness', () => {
    expect(workspace).not.toContain('preprocessingBlockedByPreprocessing');
    expect(workspace).not.toContain('preprocessingState.required && preprocessingState.ready === false && !!project');
    expect(app).not.toMatch(/:disabled="[^"]*translationPreprocessingNeedsAttention/);
  });

  it('does not start full-book preprocessing while opening, restoring or synchronizing a project', () => {
    expect(app).not.toMatch(/(?:await|void)\s+ensureContextGraphPreprocessing\s*\(/);
    expect(app).toContain('void refreshContextGraphStatus(refreshed.project, true)');
    expect(app).toContain('await refreshContextGraphStatus(refreshed.project, true)');
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
