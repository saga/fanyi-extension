<template>
  <section class="panel model-comparison">
    <header class="comparison-heading">
      <div>
        <h3>三模型初译对比</h3>
        <p class="muted small">使用当前阅读页的原文范围和项目预处理上下文。各模型独立初译，完成后即停止，不进入审校、润色或正式译文采纳流程。</p>
      </div>
      <button class="btn" type="button" :disabled="loading" @click="loadHistory">刷新记录</button>
    </header>

    <div v-if="!projectId" class="comparison-empty">文档项目尚未初始化，请先返回阅读页完成本机服务初始化。</div>
    <template v-else>
      <div class="comparison-models">
        <div class="comparison-model">
          <strong>模型 A</strong>
          <label>服务
            <select v-model="modelA.provider">
              <option value="workbuddy">Workbuddy</option>
              <option value="opencode">OpenCode</option>
            </select>
          </label>
          <label>模型标识
            <select v-if="modelA.provider === 'workbuddy'" v-model="modelA.model">
              <option v-for="option in modelOptions" :key="option" :value="option">
                {{ option === 'auto' ? 'auto（默认）' : option }}
              </option>
            </select>
            <input v-else v-model.trim="modelA.model" placeholder="auto 或模型名称" />
          </label>
          <label>思考方式
            <select v-model="modelA.thinkingMode">
              <option value="enabled">启用思考</option>
              <option value="adaptive">自适应</option>
              <option value="disabled">关闭思考</option>
            </select>
          </label>
          <label>推理强度
            <select v-model="modelA.effort">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra High</option>
            </select>
          </label>
        </div>

        <div class="comparison-model">
          <strong>模型 B</strong>
          <label>服务
            <select v-model="modelB.provider">
              <option value="workbuddy">Workbuddy</option>
              <option value="opencode">OpenCode</option>
            </select>
          </label>
          <label>模型标识
            <select v-if="modelB.provider === 'workbuddy'" v-model="modelB.model">
              <option v-for="option in modelOptions" :key="option" :value="option">
                {{ option === 'auto' ? 'auto（默认）' : option }}
              </option>
            </select>
            <input v-else v-model.trim="modelB.model" placeholder="auto 或模型名称" />
          </label>
          <label>思考方式
            <select v-model="modelB.thinkingMode">
              <option value="enabled">启用思考</option>
              <option value="adaptive">自适应</option>
              <option value="disabled">关闭思考</option>
            </select>
          </label>
          <label>推理强度
            <select v-model="modelB.effort">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra High</option>
            </select>
          </label>
        </div>

        <div class="comparison-model comparison-model-c">
          <div class="comparison-model-title">
            <strong>模型 C</strong>
            <label class="comparison-enable">模式
              <select v-model="thirdModelEnabled">
                <option :value="true">启用第三模型</option>
                <option :value="false">Off（退回双模型）</option>
              </select>
            </label>
          </div>
          <template v-if="thirdModelEnabled">
            <label>服务
              <select v-model="modelC.provider">
                <option value="workbuddy">Workbuddy</option>
                <option value="opencode">OpenCode</option>
              </select>
            </label>
            <label>模型标识
              <select v-if="modelC.provider === 'workbuddy'" v-model="modelC.model">
                <option v-for="option in modelOptions" :key="option" :value="option">
                  {{ option === 'auto' ? 'auto（默认）' : option }}
                </option>
              </select>
              <input v-else v-model.trim="modelC.model" placeholder="auto 或模型名称" />
            </label>
            <label>思考方式
              <select v-model="modelC.thinkingMode">
                <option value="enabled">启用思考</option>
                <option value="adaptive">自适应</option>
                <option value="disabled">关闭思考</option>
              </select>
            </label>
            <label>推理强度
              <select v-model="modelC.effort">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra High</option>
              </select>
            </label>
          </template>
          <p v-else class="muted small">模型 C 已关闭，本次使用双模型对比。</p>
        </div>
      </div>

      <div class="comparison-actions">
        <label class="comparison-scope">对比范围
          <select v-model="scopeKey">
            <option v-for="scope in scopeOptions" :key="scope.key" :value="scope.key" :disabled="scope.disabled">
              {{ scope.label }}
            </option>
          </select>
        </label>
        <span class="muted small">本次范围：{{ comparisonSegments.length }} 个原文片段 · {{ activeModelChoices.length }} 个模型</span>
        <button class="btn primary" type="button" :disabled="running || loading || !scopeValid || !modelsValid" @click="startComparison">
          {{ running ? activeModelChoices.length + ' 个模型执行中…' : '翻译所选范围并对比' }}
        </button>
      </div>
      <p v-if="!modelsValid" class="comparison-hint">请为各模型选择有效标识；若模型标识相同，请调整思考方式或推理强度，避免提交完全相同的配置。</p>
      <p v-if="error" class="comparison-error">{{ error }}</p>

      <div class="comparison-history">
        <strong>本项目历史对比</strong>
        <select v-model="selectedId" :disabled="!history.length" @change="selectHistory">
          <option value="">选择一条历史记录</option>
          <option v-for="item in history" :key="item.comparisonId" :value="item.comparisonId">
            {{ formatDate(item.createdAt) }} · {{ item.segmentIds.length }} 段 · {{ modelSummary(item) }}
          </option>
        </select>
      </div>

      <div v-if="activeComparison" class="comparison-results">
        <div class="comparison-result-meta">
          <span>{{ formatDate(activeComparison.createdAt) }}</span>
          <span>原文版本 {{ activeComparison.sourceRevisionId }}</span>
          <span v-if="activeComparison.contextHash">预处理上下文 {{ activeComparison.contextHash.slice(0, 12) }} · {{ activeComparison.contextChars }} 字符</span>
        </div>

        <div class="comparison-model-statuses">
          <div v-for="entry in comparisonModelEntries(activeComparison)" :key="entry.key" class="comparison-model-status">
            <strong>{{ entry.label }}</strong>
            <span>{{ entry.value?.provider }} / {{ entry.value?.requestedModel }}</span>
            <small>思考：{{ thinkingLabel(entry.value?.thinkingMode) }} · 推理：{{ effortLabel(entry.value?.effort) }}</small>
            <em :class="'status-' + entry.value?.status">{{ statusLabel(entry.value?.status) }}</em>
            <p v-if="entry.value?.error" class="comparison-error">{{ entry.value.error }}</p>
          </div>
        </div>

        <div class="comparison-segments">
          <article v-for="(source, index) in activeComparison.source" :key="source.id" class="comparison-segment">
            <div class="comparison-segment-heading">段落 {{ index + 1 }}</div>
            <table class="comparison-table">
              <tbody>
                <tr>
                  <th scope="row">原文</th>
                  <td class="comparison-source-text">{{ source.text }}</td>
                </tr>
                <tr>
                  <th scope="row">模型 A</th>
                  <td>{{ activeComparison.modelA?.translations?.[source.id] || missingLabel(activeComparison.modelA, source.id) }}</td>
                </tr>
                <tr>
                  <th scope="row">模型 B</th>
                  <td>{{ activeComparison.modelB?.translations?.[source.id] || missingLabel(activeComparison.modelB, source.id) }}</td>
                </tr>
                <tr v-if="activeComparison.modelC">
                  <th scope="row">模型 C</th>
                  <td>{{ activeComparison.modelC?.translations?.[source.id] || missingLabel(activeComparison.modelC, source.id) }}</td>
                </tr>
              </tbody>
            </table>
          </article>
        </div>
      </div>
      <div v-else-if="!history.length" class="comparison-empty">当前项目还没有模型对比记录。</div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { workspaceApi } from './documentWorkspaceClient';
import type { DocumentReaderPage } from '@/entrypoints/utils/document/pagination';
import { buildComparisonScopes, buildModelOptions, CURRENT_PAGE_SCOPE_KEY } from './modelComparisonOptions';

type Provider = 'workbuddy' | 'opencode';
type ThinkingMode = 'disabled' | 'adaptive' | 'enabled';
type Effort = 'low' | 'medium' | 'high' | 'xhigh';
type ModelChoice = { provider: Provider; model: string; thinkingMode: ThinkingMode; effort: Effort };
type ModelResult = {
  provider: Provider; requestedModel: string; effectiveModel?: string;
  thinkingMode?: ThinkingMode; effort?: Effort; status: string;
  translations?: Record<string, string>; missingSegmentIds?: string[];
  error?: string | null; usage?: unknown;
};
type ComparisonRecord = {
  comparisonId: string; sourceRevisionId: string; segmentIds: string[];
  source: Array<{ id: string; text: string }>;
  modelA: ModelResult; modelB: ModelResult; modelC?: ModelResult | null;
  createdAt: string; contextHash?: string | null; contextChars?: number;
};
const props = defineProps<{
  projectId?: string;
  serviceUrl: string;
  token: string;
  segments: Array<{ id: string; text: string }>;
  pages: DocumentReaderPage[];
  sourceLang: string;
  targetLang: string;
  translationMode: 'technical' | 'literary';
}>();
const modelA = ref<ModelChoice>({ provider: 'workbuddy', model: 'auto', thinkingMode: 'enabled', effort: 'low' });
const modelB = ref<ModelChoice>({ provider: 'workbuddy', model: 'auto', thinkingMode: 'enabled', effort: 'low' });
const modelC = ref<ModelChoice>({ provider: 'workbuddy', model: 'auto', thinkingMode: 'enabled', effort: 'low' });
const thirdModelEnabled = ref(true);
const modelOptions = ref<string[]>(['auto']);
const scopeKey = ref<string>(CURRENT_PAGE_SCOPE_KEY);
const history = ref<ComparisonRecord[]>([]);
const selectedId = ref('');
const activeComparison = ref<ComparisonRecord | null>(null);
const loading = ref(false);
const error = ref('');
let pollHandle: ReturnType<typeof setInterval> | null = null;
const activeModelChoices = computed(() => [
  modelA.value, modelB.value, ...(thirdModelEnabled.value ? [modelC.value] : []),
]);
const modelsValid = computed(() => {
  const choices = activeModelChoices.value;
  if (choices.some((choice) => !choice.model.trim())) return false;
  const keys = choices.map((choice) => [
    choice.provider, choice.model.trim(), choice.thinkingMode, choice.effort,
  ].join('|'));
  return new Set(keys).size === keys.length;
});
const scopeOptions = computed(() => buildComparisonScopes(props.pages, props.segments));
const selectedScope = computed(() => scopeOptions.value.find((item) => item.key === scopeKey.value) ?? scopeOptions.value[0] ?? null);
const comparisonSegments = computed(() => selectedScope.value?.segmentIds ?? []);
const scopeValid = computed(() => !!selectedScope.value && !selectedScope.value.disabled && comparisonSegments.value.length > 0);
const isInProgress = (status?: string) => status === 'pending' || status === 'running';
const running = computed(() => isInProgress(activeComparison.value?.modelA?.status) ||
  isInProgress(activeComparison.value?.modelB?.status) ||
  isInProgress(activeComparison.value?.modelC?.status));
const endpoint = computed(() => '/api/documents/projects/' + encodeURIComponent(props.projectId || '') + '/model-comparisons');
function formatDate(value: string) { return value ? new Date(value).toLocaleString() : ''; }
function statusLabel(value?: string) {
  return value === 'completed' ? '完成' : value === 'partial' ? '部分完成' : value === 'failed' ? '失败' : value === 'running' ? '执行中' : value === 'off' ? '关闭' : '等待中';
}
function missingLabel(result: ModelResult | null | undefined, id: string) {
  if (result?.status === 'failed') return '模型调用失败';
  if (result?.status === 'partial' && result?.missingSegmentIds?.includes(id)) return '模型未返回此片段';
  return '等待模型返回…';
}
function thinkingLabel(value?: ThinkingMode) {
  return value === 'disabled' ? '关闭' : value === 'adaptive' ? '自适应' : '启用';
}
function effortLabel(value?: Effort) {
  return value === 'medium' ? 'Medium' : value === 'high' ? 'High' : value === 'xhigh' ? 'Extra High' : 'Low';
}
function modelSummary(item: ComparisonRecord) {
  const summarize = (label: string, value?: ModelResult | null) => value
    ? label + ' ' + value.provider + '/' + value.requestedModel + ' (' + thinkingLabel(value.thinkingMode) + ', ' + effortLabel(value.effort) + ')'
    : '';
  return [summarize('A', item.modelA), summarize('B', item.modelB), summarize('C', item.modelC)].filter(Boolean).join(' · ');
}
function comparisonModelEntries(item: ComparisonRecord) {
  return [
    { key: 'a', label: '模型 A', value: item.modelA },
    { key: 'b', label: '模型 B', value: item.modelB },
    ...(item.modelC ? [{ key: 'c', label: '模型 C', value: item.modelC }] : []),
  ];
}
/** Workbuddy 模型下拉直接复用本机服务已有的模型目录，不另造一份静态列表。 */
async function loadModelOptions() {
  try {
    const response = await workspaceApi<{ data?: Array<{ id?: string }> }>(props.serviceUrl, props.token, '/api/codebuddy/models');
    const ids = Array.from(new Set((response.data || []).map((item) => String(item?.id || '').trim()).filter(Boolean)));
    modelOptions.value = buildModelOptions(ids, [modelA.value.model, modelB.value.model, modelC.value.model]);
    // 首次加载且模型目录至少有三个模型时，给 A/B/C 分配三个不同的可用模型；
    // 不把后续用户已调整的选择重置掉。
    if (ids.length >= 3 && [modelA.value, modelB.value, modelC.value].every((choice) => choice.model === 'auto')) {
      modelA.value.model = ids[0]!;
      modelB.value.model = ids[1]!;
      modelC.value.model = ids[2]!;
    }
  } catch {
    // 服务未启动时仍允许手输 auto / 模型标识，不让面板整体不可用。
    modelOptions.value = buildModelOptions([], [modelA.value.model, modelB.value.model, modelC.value.model]);
  }
}
async function loadHistory() {
  if (!props.projectId) return;
  loading.value = true;
  error.value = '';
  try {
    const response = await workspaceApi<{ comparisons: ComparisonRecord[] }>(props.serviceUrl, props.token, endpoint.value);
    history.value = response.comparisons || [];
    if (selectedId.value) {
      const current = history.value.find((item) => item.comparisonId === selectedId.value);
      if (current) activeComparison.value = current;
    } else if (history.value.length) {
      selectedId.value = history.value[0]!.comparisonId;
      activeComparison.value = history.value[0]!;
    }
    syncPolling();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}
async function selectHistory() {
  if (!selectedId.value) { activeComparison.value = null; syncPolling(); return; }
  try {
    const response = await workspaceApi<{ comparison: ComparisonRecord }>(
      props.serviceUrl, props.token, endpoint.value + '/' + encodeURIComponent(selectedId.value),
    );
    activeComparison.value = response.comparison;
    syncPolling();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function refreshActive() {
  if (!selectedId.value) return;
  const response = await workspaceApi<{ comparison: ComparisonRecord }>(
    props.serviceUrl, props.token, endpoint.value + '/' + encodeURIComponent(selectedId.value),
  );
  activeComparison.value = response.comparison;
  const index = history.value.findIndex((item) => item.comparisonId === selectedId.value);
  if (index >= 0) history.value[index] = response.comparison;
  syncPolling();
}
function stopPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}
function syncPolling() {
  if (running.value && !pollHandle) {
    pollHandle = setInterval(() => { void refreshActive().catch((cause) => { error.value = cause instanceof Error ? cause.message : String(cause); }); }, 2200);
  } else if (!running.value) {
    stopPolling();
  }
}
async function startComparison() {
  if (!props.projectId || !scopeValid.value || !modelsValid.value) return;
  loading.value = true; error.value = '';
  try {
    const response = await workspaceApi<{ comparison: ComparisonRecord }>(props.serviceUrl, props.token, endpoint.value, {
      method: 'POST',
      body: JSON.stringify({
        segmentIds: comparisonSegments.value,
        models: activeModelChoices.value,
        sourceLang: props.sourceLang,
        targetLang: props.targetLang,
        translationMode: props.translationMode,
      }),
    });
    activeComparison.value = response.comparison;
    selectedId.value = response.comparison.comparisonId;
    await loadHistory();
    selectedId.value = response.comparison.comparisonId;
    await refreshActive();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}
watch(() => props.projectId, () => {
  stopPolling();
  selectedId.value = '';
  activeComparison.value = null;
  history.value = [];
  void loadHistory();
});
onMounted(() => {
  void loadHistory();
  void loadModelOptions();
});
onBeforeUnmount(stopPolling);
</script>

<style scoped>
.model-comparison { display: grid; gap: 16px; }
.comparison-heading, .comparison-actions, .comparison-result-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.comparison-models { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.comparison-model { min-width: 0; border: 1px solid var(--border-color, #ddd); border-radius: 10px; padding: 16px; display: grid; align-content: start; gap: 10px; }
.comparison-model label, .comparison-history, .comparison-scope { display: grid; gap: 6px; }
.comparison-model input:not([type="checkbox"]), .comparison-model select, .comparison-history select, .comparison-scope select { width: 100%; min-width: 0; }
.comparison-model-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.comparison-enable { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 6px !important; font-size: 12px; }
.comparison-enable select { min-width: 150px; }
.comparison-scope { min-width: 220px; }
.comparison-history { gap: 8px; }
.comparison-model-statuses { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.comparison-model-status { min-width: 0; border: 1px solid var(--border-color, #ddd); border-radius: 8px; padding: 12px; display: grid; gap: 5px; }
.comparison-model-status span, .comparison-model-status small, .comparison-result-meta { color: var(--muted-color, #777); font-size: 13px; overflow-wrap: anywhere; }
.comparison-model-status em { font-size: 13px; font-style: normal; }
.comparison-model-status p { margin: 0; }
.comparison-segments { display: grid; gap: 16px; }
.comparison-segment { border: 1px solid var(--border-color, #ddd); border-radius: 10px; overflow: hidden; }
.comparison-segment-heading { padding: 10px 14px; font-weight: 600; background: var(--panel-secondary, rgba(127,127,127,.08)); }
.comparison-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.comparison-table th, .comparison-table td { border-top: 1px solid var(--border-color, #ddd); padding: 12px 14px; text-align: left; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; }
.comparison-table th { width: 100px; font-size: 13px; font-weight: 600; color: var(--muted-color, #777); }
.comparison-table td { font-size: 1.02rem; }
.comparison-table .comparison-source-text { color: var(--muted-color, #777); font-size: .98rem; }
.comparison-empty { color: var(--muted-color, #777); padding: 18px 0; }
.comparison-error { color: #b42318; white-space: pre-wrap; }
.comparison-hint { color: var(--muted-color, #777); font-size: 13px; margin: -8px 0 0; }
.status-completed { color: #16803c; }
.status-partial { color: #9a6700; }
.status-failed { color: #b42318; }
@media (max-width: 900px) {
  .comparison-models, .comparison-model-statuses { grid-template-columns: 1fr; }
}
</style>
