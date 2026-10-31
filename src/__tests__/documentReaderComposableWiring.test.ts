import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ref } from 'vue';
import { useLiteraryMemoryEditor } from '../entrypoints/document/useLiteraryMemoryEditor';
import {
  createEmptyContextGraphOverview,
  useContextGraph,
} from '../entrypoints/document/useContextGraph';
import { createEmptyLiteraryMemory } from '../entrypoints/utils/document/literary';

/**
 * 回归：`Cannot access 'contextGraphOverview' before initialization`。
 *
 * `useLiteraryMemoryEditor` 内部的 watcher 会在 setup 阶段立即读取一次文风基准。
 * 只要 App.vue 按「编辑器 → ContextGraph」的顺序调用（这是既有的调用顺序，
 * 由 persistLiteraryMemoryToWorkspace 的依赖方向决定），文风基准就必须在
 * **两个 composable 之前**创建并作为 ref 传入；否则读的是尚未初始化的 `const`，
 * 触发 TDZ，整个阅读页白屏。
 */
describe('document reader composable wiring', () => {
  it('shares one overview ref created before both composables', () => {
    const readerConfig = ref<any>({});
    const workspaceProject = ref<any>(null);
    const doc = ref<any>(null);
    const literaryMemory = ref(createEmptyLiteraryMemory());
    const persistenceMessage = ref('');
    const activeTab = ref('reading');

    // App.vue 的顺序：先建 ref，再编辑器，最后 ContextGraph
    const contextGraphOverview = ref(createEmptyContextGraphOverview());

    expect(() => {
      useLiteraryMemoryEditor({
        literaryMemory,
        doc,
        state: ref<any>({ translations: new Map(), activeSegmentIds: new Set() }),
        readerConfig,
        workspaceProject,
        ensureWorkspace: async () => null,
        persistenceMessage,
        persistSession: async () => {},
        contextGraphOverview,
      });
    }).not.toThrow();

    const graph = useContextGraph({
      readerConfig,
      workspaceProject,
      doc,
      sourceLang: ref('en'),
      targetLang: ref('zh'),
      effectiveDocumentTranslationMode: ref<'technical' | 'literary'>('literary'),
      persistenceMessage,
      activeTab,
      ensureWorkspace: async () => null,
      contextGraphOverview,
    });

    // 两个 composable 必须操作同一个 ref 实例，否则文风基准不会同步到编辑器
    expect(graph.contextGraphOverview).toBe(contextGraphOverview);
  });

  it('gates reader-triggered literary Run creation on current preprocessing readiness', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/App.vue'),
      'utf8',
    );
    const runHandler = source.indexOf('async function runWorkspaceTranslation');
    expect(runHandler).toBeGreaterThan(-1);
    const readinessCheck = source.indexOf('await refreshContextGraphStatus(project, true)', runHandler);
    const runCreation = source.indexOf("'/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs'", runHandler);
    expect(readinessCheck).toBeGreaterThan(runHandler);
    expect(runCreation).toBeGreaterThan(readinessCheck);
    expect(source.slice(readinessCheck, runCreation)).toContain('if (readiness.required && !readiness.ready)');
  });

  it('declares the shared ref in App.vue before both composables', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/App.vue'),
      'utf8',
    );
    const decl = source.indexOf('const contextGraphOverview = ref(');
    const editor = source.indexOf('} = useLiteraryMemoryEditor({');
    const graph = source.indexOf('} = useContextGraph({');

    expect(decl).toBeGreaterThan(-1);
    expect(editor).toBeGreaterThan(-1);
    expect(graph).toBeGreaterThan(-1);
    // 顺序错了就会在 setup 阶段命中 TDZ，整个阅读页白屏
    expect(decl).toBeLessThan(editor);
    expect(decl).toBeLessThan(graph);
    // 禁止回退成惰性 getter：watcher 会在 setup 阶段立即读取它
    expect(source).not.toContain('getContextGraphOverview');
  });
});
