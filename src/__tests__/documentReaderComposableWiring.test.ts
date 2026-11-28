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

  it('keeps Local Agent document persistence on the server and never falls back to IndexedDB', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/App.vue'),
      'utf8',
    );
    const persistStart = source.indexOf('async function persistCurrentSession()');
    const persistEnd = source.indexOf('function currentWorkspaceDocumentKey()', persistStart);
    const persistBody = source.slice(persistStart, persistEnd);
    const serverBranch = persistBody.indexOf('if (config.documentUseLocalAgent)');
    const idbWrite = persistBody.indexOf('saveActiveDocumentProgress(input)');
    expect(serverBranch).toBeGreaterThan(-1);
    expect(idbWrite).toBeGreaterThan(serverBranch);
    expect(persistBody.slice(serverBranch, idbWrite)).toContain('return;');

    const restoreStart = source.indexOf('async function restoreLastSession()');
    const restoreEnd = source.indexOf('async function clearSavedSession()', restoreStart);
    const restoreBody = source.slice(restoreStart, restoreEnd);
    const localAgentBranch = restoreBody.indexOf('if (restoreConfig.documentUseLocalAgent)');
    const idbRead = restoreBody.indexOf('loadActiveDocumentSession()');
    expect(localAgentBranch).toBeGreaterThan(-1);
    expect(idbRead).toBeGreaterThan(localAgentBranch);
    expect(restoreBody.slice(localAgentBranch, idbRead)).toContain('restoredFromLocalService = !!saved');

    expect(source).toContain('全书预处理、文学记忆和翻译结果均由本机服务统一保存');

    const checkpointStart = source.indexOf('async function loadDocumentCheckpointFromLocalService()');
    const checkpointEnd = source.indexOf('async function persistCurrentSession()', checkpointStart);
    const checkpointBody = source.slice(checkpointStart, checkpointEnd);
    expect(checkpointStart).toBeGreaterThan(-1);
    expect(checkpointBody).toContain('payload.projectBacked === true');
    expect(checkpointBody).not.toContain('payload.document');
    expect(checkpointBody).not.toContain('snapshot.literaryMemory');

    const workspace = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/DocumentAgentWorkspace.vue'),
      'utf8',
    );
    expect(workspace).not.toContain('importWorkspaceTranslations');
    expect(workspace).not.toContain('legacyMemory');
  });

  it('gates reader-triggered literary Run creation on current preprocessing readiness', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/App.vue'),
      'utf8',
    );
    const runHandler = source.indexOf('async function runWorkspaceTranslation');
    expect(runHandler).toBeGreaterThan(-1);
    const preprocessingImport = source.indexOf("from './documentPreprocessing';");
    expect(preprocessingImport).toBeGreaterThan(-1);
    // 回归：曾漏掉这个导入，点击翻译时抛 ReferenceError，按钮闪一下且没有任何 Run 被创建。
    expect(source.slice(preprocessingImport - 300, preprocessingImport))
      .toContain('shouldUseLightweightLiterarySelection');
    const readinessCheck = source.indexOf('await prepareContextGraphForTranslation(', runHandler);
    const runCreation = source.indexOf("'/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs'", runHandler);
    expect(readinessCheck).toBeGreaterThan(runHandler);
    expect(runCreation).toBeGreaterThan(readinessCheck);
    expect(source.slice(readinessCheck, runCreation)).toContain('if (!readiness.ready)');
    // 页面级动作（翻译当前页/预翻译章节）不替用户启动整本重算：只有从未分析过才顺手起一次，
    // 语言变更、版本过期、上次失败都必须由用户在「人物与预处理」明确点重新分析。
    expect(source.slice(readinessCheck, runCreation))
      .toContain("allowAutoStart: contextGraphState.value.status === 'not-started'");

    const contextGraph = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/useContextGraph.ts'),
      'utf8',
    );
    const orchestration = contextGraph.indexOf('async function prepareContextGraphForTranslation');
    expect(orchestration).toBeGreaterThan(-1);
    expect(contextGraph.slice(orchestration)).toContain('await ensureContextGraphPreprocessing(project, { force: true })');
    expect(contextGraph.slice(orchestration)).toContain('options.allowAutoStart === false');
    expect(contextGraph.slice(orchestration)).toContain('while (!readiness.ready');
    expect(contextGraph.slice(orchestration)).toContain('timeoutMs');
  });

  it('returns before full-book preprocessing when an explicit selection is empty', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/App.vue'),
      'utf8',
    );
    const runHandler = source.indexOf('async function runWorkspaceTranslation');
    expect(runHandler).toBeGreaterThan(-1);
    const emptyScopeGuard = source.indexOf(
      "if (scope.type === 'ids' && (!scope.ids || scope.ids.length === 0)) return;",
      runHandler,
    );
    const memoryWait = source.indexOf('await awaitLiteraryMemoryWrites()', runHandler);
    const fullBookPreprocessing = source.indexOf('await prepareContextGraphForTranslation(', runHandler);
    const runCreation = source.indexOf(
      "'/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs'",
      runHandler,
    );
    expect(emptyScopeGuard).toBeGreaterThan(runHandler);
    expect(memoryWait).toBeGreaterThan(emptyScopeGuard);
    expect(fullBookPreprocessing).toBeGreaterThan(emptyScopeGuard);
    expect(runCreation).toBeGreaterThan(emptyScopeGuard);
    expect(emptyScopeGuard).toBeLessThan(fullBookPreprocessing);
  });

  it('keeps one literary translation action scoped to the current page, not the whole book', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/App.vue'),
      'utf8',
    );
    const start = source.indexOf('async function startTranslate');
    const end = source.indexOf('async function forceTranslateCurrentPage', start);
    const body = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    // 回归：这里曾经对文学模式无条件提交 { type: 'stale' }，一次翻页点击会变成整本 700+ 段的 Run。
    expect(body).not.toContain("scope: { type: 'stale' }");
    // 当前页语义：提交当前页里尚未翻译的片段 id。
    expect(body).toContain('runWorkspaceTranslation({ ids })');
    expect(body).toContain("filter((segment) => !state.value.translations.get(segment.id)?.trim())");
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

describe('document prompt source of truth', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/entrypoints/document/App.vue'),
    'utf8',
  );

  it('内置提示词按当前设置重新生成，不把编辑器里的旧快照当成当前设置', () => {
    const inputStart = source.indexOf('function workspacePromptInput()');
    expect(inputStart).toBeGreaterThan(-1);
    const inputBody = source.slice(inputStart, source.indexOf('async function replaceCurrentTranslations', inputStart));
    // 回归：这里曾经直接取 documentSystemPromptEditor，hydrate 之后编辑器里是
    // 建项目那一刻的 prompt，改源语言/文风再同步就是把这个过期快照写回项目。
    expect(inputBody).toContain('documentSystemPromptOverride.value');
    expect(inputBody).toContain('builtInDocumentSystemPrompt.value');
    expect(inputBody.indexOf('builtInDocumentSystemPrompt.value'))
      .toBeGreaterThan(inputBody.indexOf('documentSystemPromptOverride.value'));
  });

  it('hydrate 只修正过期的语言行，不重建整份提示词', () => {
    const hydrateStart = source.indexOf('async function hydrateWorkspacePrompt(');
    expect(hydrateStart).toBeGreaterThan(-1);
    const hydrateBody = source.slice(hydrateStart, source.indexOf('async function refreshExistingWorkspaceFromService', hydrateStart));
    expect(hydrateBody).not.toContain("documentSystemPromptOverride.value = typeof prompt.systemPrompt");
    // 回归：旧项目存的提示词里写着「输入语言：英语」，但源语言可能已经改成法语。
    expect(hydrateBody).toContain('applyDocumentLanguageLines(storedSystemPrompt)');
    expect(hydrateBody).toContain("'/api/documents/projects/' + encodeURIComponent(projectId) + '/prompts'");

    const helper = source.indexOf('function applyDocumentLanguageLines(');
    expect(helper).toBeGreaterThan(-1);
    const helperBody = source.slice(helper, source.indexOf('const documentStyleVars', helper));
    expect(helperBody).toContain('/^输入语言：/m');
    expect(helperBody).toContain('/^目标语言：/m');
  });

  it('同步 watcher 覆盖文风，切换文风会重写项目 prompt', () => {
    const syncStart = source.indexOf('], async (next, previous) => {');
    expect(syncStart).toBeGreaterThan(-1);
    const watchStart = source.lastIndexOf('watch([', syncStart);
    expect(watchStart).toBeGreaterThan(-1);
    expect(source.slice(watchStart, syncStart)).toContain('() => readerConfig.value?.documentPromptStyle');
  });
});

describe('reader toolbar literary reasoning policy', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/entrypoints/document/App.vue'),
    'utf8',
  );

  it('shows literary translation thinking as always enabled and keeps review concurrency control', () => {
    expect(source).toContain('小说文学初译固定启用思考');
    expect(source).toContain('已启用 · {{ translationEffortLabel }}');
    expect(source).toContain('@change="onReviewConcurrencyChange"');
    expect(source).toContain('v-if="literaryMode && literaryReview"');
    expect(source).not.toContain('@change="onTranslationThinkingChange"');
  });

  it('persists review concurrency and displays the independent translation effort', () => {
    expect(source).toContain('documentReviewConcurrency: value');
    expect(source).toContain('translationEffortLabel');
    expect(source).toContain('await setConfig(patch)');
    expect(source).not.toContain('onTranslationThinkingChange');
  });

  it('locks literary translation thinking on while keeping other task profiles configurable', () => {
    const settings = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/DocumentTranslationSettings.vue'),
      'utf8',
    );
    const config = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/utils/config.ts'),
      'utf8',
    );
    expect(settings).toContain("task.key === 'translation'");
    expect(settings).toContain('<strong>固定启用</strong>');
    expect(settings).toContain('推理强度默认 low');
    expect(settings).toContain('onThinkingModeChange(task.key, $event)');
    expect(config).toContain("const thinkingMode = task === 'translation'");
    expect(config).toContain("? 'enabled'");
    expect(config).not.toContain('thinkingBudgetTokens');
    expect(settings).not.toContain('thinkingBudgetTokens');
  });

  it('预处理状态卡在 checking 时给出可操作提示，不静默吞掉点击', () => {
    const graph = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/useContextGraph.ts'),
      'utf8',
    );
    const prepare = graph.indexOf('async function prepareContextGraphForTranslation');
    expect(prepare).toBeGreaterThan(-1);
    const gate = graph.slice(prepare, graph.indexOf('/** 切换文档时清空预处理状态', prepare));
    expect(gate).toContain('maxCheckingStreak');
    expect(gate).toContain("readiness.reason === 'checking'");
    expect(gate).toContain('请到「人物与预处理」点刷新状态');

    // loading 一旦置起必须在所有路径清掉，否则就绪判断永远停在 checking。
    const refresh = graph.indexOf('async function refreshContextGraphStatus');
    const refreshBody = graph.slice(refresh, graph.indexOf('/**\n   * 启动服务端预处理任务', refresh));
    expect(refreshBody).toContain('loading: true');
    expect(refreshBody).toMatch(/finally\s*\{[\s\S]*loading: false/);

    const start = graph.indexOf('async function ensureContextGraphPreprocessing');
    const startBody = graph.slice(start, graph.indexOf('async function handlePreprocessingStatusRefreshRequested', start));
    expect(startBody).toMatch(/finally\s*\{\s*\/\/[\s\S]*contextGraphAnalyzing\.value = false;/);

    const app = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/App.vue'),
      'utf8',
    );
    expect(app).toContain("state.value.error = '未开始翻译：本机项目中的原文版本与当前文档不同。");
    expect(app).toContain("state.value.error = '未开始翻译：无法确认本机服务项目。");
  });

  it('设置页的备用模型使用下拉，且保留不在模型列表里的已存值', () => {
    const settings = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/document/DocumentTranslationSettings.vue'),
      'utf8',
    );
    const fieldStart = settings.indexOf('<span>备用模型（可选）</span>');
    expect(fieldStart).toBeGreaterThan(-1);
    const field = settings.slice(fieldStart, fieldStart + 700);
    const labelEnd = field.indexOf('</label>');
    const body = labelEnd > -1 ? field.slice(0, labelEnd) : field;
    // 回归：这里曾经是自由文本 input，无法下拉选择模型。
    expect(body).toContain('<select v-model="config.documentCodeBuddyTaskProfiles[task.key].fallbackModel"');
    expect(body).toContain('v-for="model in fallbackModelOptions(task.key)"');
    expect(body).not.toContain('<input');
    expect(body).toContain('<option value="">留空（不启用备用）</option>');
    // 已存的自定义/旧默认值不能因下拉而丢失。
    expect(settings).toContain('function fallbackModelOptions(');
    const helper = settings.indexOf('function fallbackModelOptions(');
    const helperBody = settings.slice(helper, settings.indexOf('async function onTaskModelChange', helper));
    expect(helperBody).toContain('if (current && !options.some(');
    expect(helperBody).toContain('options.unshift({ id: current');
  });
});
