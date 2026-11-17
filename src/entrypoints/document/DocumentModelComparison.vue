<template>
  <section class="panel model-comparison">
    <header class="comparison-heading">
      <div>
        <h3>双模型初译对比</h3>
        <p class="muted small">使用当前阅读页的原文范围和项目预处理上下文。两份初译独立执行，完成后即停止，不进入审校、润色或正式译文采纳流程。</p>
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
            <input v-model.trim="modelA.model" placeholder="auto 或模型名称" />
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
            <input v-model.trim="modelB.model" placeholder="auto 或模型名称" />
          </label>
        </div>
      </div>

      <div class="comparison-actions">
        <span class="muted small">本次范围：当前页 {{ segments.length }} 个原文片段</span>
        <button class="btn primary" type="button" :disabled="running || loading || !segments.length || !modelsValid" @click="startComparison">
          {{ running ? '两份初译执行中…' : '翻译当前页并对比' }}
        </button>
      </div>
      <p v-if="error" class="comparison-error">{{ error }}</p>

      <div class="comparison-history">
        <strong>本项目历史对比</strong>
        <select v-model="selectedId" :disabled="!history.length" @change="selectHistory">
          <option value="">选择一条历史记录</option>
          <option v-for="item in history" :key="item.comparisonId" :value="item.comparisonId">
            {{ formatDate(item.createdAt) }} · {{ item.segmentIds.length }} 段 · {{ item.modelA?.requestedModel || '模型 A' }} / {{ item.modelB?.requestedModel || '模型 B' }}
          </option>
        </select>
      </div>

      <div v-if="activeComparison" class="comparison-results">
        <div class="comparison-result-meta">
          <span>{{ formatDate(activeComparison.createdAt) }}</span>
          <span>原文版本 {{ activeComparison.sourceRevisionId }}</span>
          <span v-if="activeComparison.contextHash">预处理上下文 {{ activeComparison.contextHash.slice(0, 12) }} · {{ activeComparison.contextChars }} 字符</span>
        </div>
        <div class="comparison-columns">
          <section class="comparison-column">
            <header><strong>模型 A</strong><span>{{ activeComparison.modelA?.provider }} / {{ activeComparison.modelA?.requestedModel }}</span><em :class="'status-' + activeComparison.modelA?.status">{{ statusLabel(activeComparison.modelA?.status) }}</em></header>
            <p v-if="activeComparison.modelA?.error" class="comparison-error">{{ activeComparison.modelA.error }}</p>
            <article v-for="source in activeComparison.source" :key="'a-' + source.id" class="comparison-segment">
              <small>{{ source.id }}</small>
              <p>{{ activeComparison.modelA?.translations?.[source.id] || missingLabel(activeComparison.modelA, source.id) }}</p>
            </article>
          </section>
          <section class="comparison-column">
            <header><strong>模型 B</strong><span>{{ activeComparison.modelB?.provider }} / {{ activeComparison.modelB?.requestedModel }}</span><em :class="'status-' + activeComparison.modelB?.status">{{ statusLabel(activeComparison.modelB?.status) }}</em></header>
            <p v-if="activeComparison.modelB?.error" class="comparison-error">{{ activeComparison.modelB.error }}</p>
            <article v-for="source in activeComparison.source" :key="'b-' + source.id" class="comparison-segment">
              <small>{{ source.id }}</small>
              <p>{{ activeComparison.modelB?.translations?.[source.id] || missingLabel(activeComparison.modelB, source.id) }}</p>
            </article>
          </section>
        </div>
      </div>
      <div v-else-if="!history.length" class="comparison-empty">当前项目还没有模型对比记录。</div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { workspaceApi } from './documentWorkspaceClient';

type ModelChoice = { provider: 'workbuddy' | 'opencode'; model: string };
type ComparisonRecord = {
  comparisonId: string; sourceRevisionId: string; segmentIds: string[];
  source: Array<{ id: string; text: string }>; modelA: any; modelB: any;
  createdAt: string; contextHash?: string | null; contextChars?: number;
};
const props = defineProps<{
  projectId?: string;
  serviceUrl: string;
  token: string;
  segments: Array<{ id: string; text: string }>;
  sourceLang: string;
  targetLang: string;
  translationMode: 'technical' | 'literary';
}>();
const modelA = ref<ModelChoice>({ provider: 'workbuddy', model: 'auto' });
const modelB = ref<ModelChoice>({ provider: 'opencode', model: 'auto' });
const history = ref<ComparisonRecord[]>([]);
const selectedId = ref('');
const activeComparison = ref<ComparisonRecord | null>(null);
const loading = ref(false);
const error = ref('');
let pollHandle: ReturnType<typeof setInterval> | null = null;
const modelsValid = computed(() => !!modelA.value.model.trim() && !!modelB.value.model.trim() &&
  !(modelA.value.provider === modelB.value.provider && modelA.value.model.trim() === modelB.value.model.trim()));
const running = computed(() => ['pending', 'running'].includes(activeComparison.value?.modelA?.status) ||
  ['pending', 'running'].includes(activeComparison.value?.modelB?.status));
const endpoint = computed(() => '/api/documents/projects/' + encodeURIComponent(props.projectId || '') + '/model-comparisons');
function formatDate(value: string) { return value ? new Date(value).toLocaleString() : ''; }
function statusLabel(value?: string) {
  return value === 'completed' ? '完成' : value === 'partial' ? '部分完成' : value === 'failed' ? '失败' : value === 'running' ? '执行中' : '等待中';
}
function missingLabel(result: any, id: string) {
  if (result?.status === 'failed') return '模型调用失败';
  if (result?.status === 'partial' && result?.missingSegmentIds?.includes(id)) return '模型未返回此片段';
  return '等待模型返回…';
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
  if (!selectedId.value) { activeComparison.value = null; return; }
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
function syncPolling() {
  if (running.value && !pollHandle) {
    pollHandle = setInterval(() => { void refreshActive().catch((cause) => { error.value = cause instanceof Error ? cause.message : String(cause); }); }, 2200);
  } else if (!running.value && pollHandle) {
    clearInterval(pollHandle); pollHandle = null;
  }
}
async function startComparison() {
  if (!props.projectId || !props.segments.length || !modelsValid.value) return;
  loading.value = true; error.value = '';
  try {
    const response = await workspaceApi<{ comparison: ComparisonRecord }>(props.serviceUrl, props.token, endpoint.value, {
      method: 'POST',
      body: JSON.stringify({
        segmentIds: props.segments.map((segment) => segment.id),
        models: [modelA.value, modelB.value],
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
watch(() => props.projectId, () => { selectedId.value = ''; activeComparison.value = null; void loadHistory(); });
onMounted(() => { void loadHistory(); });
onBeforeUnmount(() => { if (pollHandle) clearInterval(pollHandle); });
</script>

<style scoped>
.model-comparison { display: grid; gap: 16px; }
.comparison-heading, .comparison-actions, .comparison-result-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.comparison-models, .comparison-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.comparison-model, .comparison-column { min-width: 0; border: 1px solid var(--border-color, #ddd); border-radius: 10px; padding: 14px; display: grid; gap: 10px; }
.comparison-model label, .comparison-history { display: grid; gap: 6px; }
.comparison-model input, .comparison-model select, .comparison-history select { width: 100%; min-width: 0; }
.comparison-column > header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.comparison-column > header span, .comparison-result-meta, .comparison-segment small { color: var(--muted-color, #777); font-size: 12px; }
.comparison-column > header em { margin-left: auto; font-size: 12px; font-style: normal; }
.comparison-segment { border-top: 1px solid var(--border-color, #ddd); padding-top: 8px; }
.comparison-segment p { white-space: pre-wrap; line-height: 1.65; margin: 6px 0 0; }
.comparison-empty { color: var(--muted-color, #777); padding: 18px 0; }
.comparison-error { color: #b42318; white-space: pre-wrap; }
.status-completed { color: #16803c; }
.status-partial { color: #9a6700; }
.status-failed { color: #b42318; }
@media (max-width: 760px) { .comparison-models, .comparison-columns { grid-template-columns: 1fr; } }
</style>
