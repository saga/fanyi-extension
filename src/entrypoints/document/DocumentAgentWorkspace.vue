<template>
  <section class="panel document-agent-workspace">
    <div class="workspace-heading">
      <div>
        <h3>文档翻译 Agent</h3>
        <p class="muted small">把这份 EPUB/PDF 作为长期项目管理。每次运行生成候选版本；接受前不会覆盖当前采用译文，人工修订会单独留档。</p>
      </div>
      <span v-if="project" class="status-chip">{{ project.format.toUpperCase() }} · {{ project.segmentCount.toLocaleString() }} 段</span>
    </div>

    <div v-if="!useLocalAgent" class="notice">
      请先在“设置与记忆”中启用本机 Workbuddy / OpenCode，文档 Agent 才能通过本机服务保存项目并执行任务。
    </div>
    <div v-else-if="!project" class="project-create">
      <div class="project-description">
        <strong>{{ title }}</strong>
        <span class="muted small">{{ format.toUpperCase() }} · {{ segments.length.toLocaleString() }} 个结构化片段</span>
        <span class="muted small">项目数据库独立存放于本机 documents 目录；切换 Prompt、纠正译文和重复运行都会保留运行记录。</span>
      </div>
      <button class="btn primary" :disabled="busy || segments.length === 0" @click="createProject">
        {{ busy ? '正在创建…' : '创建 / 关联本机文档项目' }}
      </button>
    </div>

    <template v-if="project">
      <div v-if="sourceChanged" class="source-change-notice">
        <strong>检测到同名文档的来源内容已经变化</strong>
        <p>系统不会自动覆盖旧来源。确认后可以在同一项目中登记新的来源版本；旧运行和人工修订仍会保留。未确认前禁止启动翻译，避免把旧译文映射到新原文。</p>
        <div class="agent-actions">
          <button class="btn primary" :disabled="busy || isRunning || !segments.length" @click="updateSourceRevision">导入为新来源版本</button>
          <button class="btn" :disabled="busy || isRunning" @click="createSeparateProject">另建独立项目</button>
        </div>
      </div>
      <div v-else-if="!project.sourceFileSaved && sourceFile" class="source-change-notice">
        <strong>尚未备份原始文件</strong>
        <p>当前项目已保存解析后的源文本与片段。上传原始文件到本机项目目录，便于后续恢复、核对和导出。</p>
        <button class="btn" :disabled="busy" @click="uploadCurrentSourceFile">备份原始文件</button>
      </div>
      <div class="project-overview">
        <div class="overview-item">
          <span class="muted small">来源版本</span>
          <strong>{{ project.currentSourceRevisionId?.slice(0, 8) || '—' }}</strong>
        </div>
        <div class="overview-item">
          <span class="muted small">当前已采用</span>
          <strong>{{ verification?.acceptedSegments ?? '—' }}/{{ verification?.totalSegments ?? project.segmentCount }}</strong>
        </div>
        <div class="overview-item">
          <span class="muted small">待翻译 / 过期</span>
          <strong>{{ verification ? verification.missingSegmentIds.length + verification.staleSourceIds.length : '—' }}</strong>
        </div>
        <div class="overview-item">
          <span class="muted small">最近运行</span>
          <strong>{{ activeRun?.status || '尚未运行' }}</strong>
        </div>
      </div>

      <div class="agent-actions">
        <button class="btn primary" :disabled="busy || isRunning || sourceChanged" @click="startRun('stale')">翻译过期 / 未完成内容</button>
        <button class="btn" :disabled="busy || isRunning || sourceChanged" @click="startRun('failed')">重试失败片段</button>
        <button class="btn" :disabled="busy || isRunning || sourceChanged || !visibleSegments.length" @click="startRun('visible')">重译当前阅读页</button>
        <button class="btn" :disabled="busy || isRunning || sourceChanged" @click="startRun('all')">生成全书新候选</button>
        <button v-if="isRunning" class="btn warn" :disabled="busy" @click="cancelRun">停止运行</button>
        <button v-else-if="activeRun?.status === 'paused' || activeRun?.status === 'failed' || activeRun?.status === 'partial'" class="btn" :disabled="busy" @click="resumeRun">恢复 / 继续失败项</button>
        <button class="btn ghost" :disabled="busy" @click="refreshProject">刷新状态</button>
      </div>

      <div class="prompt-summary">
        <div>
          <strong>本次运行参数</strong>
          <p class="muted small">{{ sourceLang }} → {{ targetLang }} · {{ translationMode }} · {{ localAgentProvider }} / {{ localAgentModel || 'auto' }}</p>
          <p class="muted small">运行使用下方所示的当前 Prompt；若 Prompt 指纹、源片段或模型配置变化，系统会把对应结果视为过期候选，而不是覆盖已有译文。</p>
        </div>
        <button class="btn" :disabled="busy" @click="savePromptRevision">保存 Prompt 版本</button>
      </div>

      <div v-if="activeRun" class="run-card">
        <div class="run-heading">
          <div>
            <strong>运行 {{ activeRun.runId.slice(0, 8) }}</strong>
            <span class="muted small">{{ activeRun.scope?.type || 'stale' }} · {{ new Date(activeRun.createdAt).toLocaleString() }}</span>
          </div>
          <span class="run-status" :class="'status-' + activeRun.status">{{ runStatusLabel(activeRun.status) }}</span>
        </div>
        <div class="run-progress">
          <span v-for="status in progressItems" :key="status.key" class="progress-item">
            <strong>{{ activeRun.counts?.[status.key] || 0 }}</strong><small>{{ status.label }}</small>
          </span>
        </div>
        <p v-if="activeRun.error" class="err-text small">{{ activeRun.error }}</p>
        <div v-if="activeRun.status === 'awaiting_acceptance' || (activeRun.counts?.candidate || 0) > 0" class="candidate-gate">
          <div>
            <strong>候选译文已保存</strong>
            <p class="muted small">先检查候选结果。点击采纳后才会更新项目的当前采用版本；原来的人工修订和历史运行仍然保留。</p>
          </div>
          <button class="btn primary" :disabled="busy || !(activeRun.counts?.candidate || 0)" @click="acceptCandidates()">
            采纳本次全部候选（{{ activeRun.counts?.candidate || 0 }}）
          </button>
        </div>
        <div v-if="candidatePreview.length" class="candidate-preview">
          <strong>候选译文预览（{{ candidatePreview.length }} 条）</strong>
          <article v-for="item in candidatePreview" :key="item.id" class="candidate-preview-item">
            <div class="candidate-preview-title">
              <strong>{{ item.id }}</strong>
              <span class="muted small">{{ item.contextPath || '' }}</span>
            </div>
            <p><span class="preview-label">原文</span>{{ item.source }}</p>
            <p><span class="preview-label">当前采用</span>{{ item.accepted || '（暂无已采用译文）' }}</p>
            <p class="new-candidate"><span class="preview-label">新候选</span>{{ item.candidate }}</p>
            <button class="btn" :disabled="busy" @click="acceptCandidates([item.id])">只采纳此条</button>
          </article>
          <p class="muted small">只预览前 8 条；其余候选可通过运行详情 API 分页查看。采纳会应用本次所有候选。</p>
        </div>
        <div v-if="activeRun.findings?.length" class="finding-list">
          <strong>审校发现 {{ activeRun.findings.length }} 条</strong>
          <div v-for="finding in activeRun.findings.slice(0, 12)" :key="finding.findingId" class="finding-row">
            <span class="finding-category">{{ finding.category === 'accuracy' ? '准确性' : finding.category === 'terminology' ? '术语' : '文风' }}</span>
            <span class="muted small">{{ finding.segmentId }}</span>
            <span>{{ finding.finding?.reason || finding.finding?.suggestion || '审校建议' }}</span>
          </div>
        </div>
      </div>

      <section class="manual-edit-panel">
        <div>
          <strong>人工修订当前阅读页</strong>
          <p class="muted small">先在“阅读”页定位片段，再回到这里编辑。保存会写入项目数据库，并同步更新阅读器当前译文。</p>
        </div>
        <label class="manual-field">
          <span>片段</span>
          <select v-model="selectedSegmentId" @change="loadSelectedTranslation">
            <option v-for="segment in visibleSegments" :key="segment.id" :value="segment.id">
              {{ segment.id }} · {{ segment.text.slice(0, 70) }}
            </option>
          </select>
        </label>
        <label v-if="selectedSegment" class="manual-field">
          <span>原文</span>
          <div class="source-preview">{{ selectedSegment.text }}</div>
        </label>
        <label class="manual-field">
          <span>修订后的译文</span>
          <textarea v-model="manualText" rows="4" placeholder="输入你确认的完整译文"></textarea>
        </label>
        <div class="manual-actions">
          <button class="btn" :disabled="busy || !selectedSegmentId || !manualText.trim()" @click="saveManualEdit">保存人工修订</button>
          <span class="muted small">人工修订优先保留，不会被后台模型结果静默覆盖。</span>
        </div>
      </section>

      <details class="run-history">
        <summary>运行历史（{{ runs.length }}）</summary>
        <div v-for="run in runs" :key="run.runId" class="history-row">
          <div>
            <strong>{{ run.runId.slice(0, 8) }}</strong>
            <span class="muted small">{{ new Date(run.createdAt).toLocaleString() }} · {{ run.scope?.type }}</span>
          </div>
          <span class="run-status" :class="'status-' + run.status">{{ runStatusLabel(run.status) }}</span>
          <button class="btn ghost" :disabled="busy" @click="selectRun(run.runId)">查看</button>
        </div>
      </details>
    </template>

    <p v-if="message" class="muted small workspace-message">{{ message }}</p>
    <p v-if="error" class="err-text small workspace-error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storage } from '@wxt-dev/storage';

interface Segment {
  id: string;
  text: string;
  kind?: string;
  contextPath?: string;
  page?: number | null;
  level?: number;
  marker?: string;
}
interface PromptInput {
  systemPrompt: string;
  userPromptTemplate: string;
  sourceLang: string;
  targetLang: string;
  provider: string;
  model: string;
  translationMode: 'technical' | 'literary';
  literaryReview: boolean;
  literaryMemory: unknown;
}
const props = defineProps<{
  title: string;
  format: string;
  sourceFileName: string;
  sourceFile: File | null;
  segments: Segment[];
  visibleSegments: Segment[];
  translations: Map<string, string>;
  sourceLang: string;
  targetLang: string;
  translationMode: 'technical' | 'literary';
  literaryReview: boolean;
  useLocalAgent: boolean;
  localAgentProvider: 'workbuddy' | 'opencode';
  localAgentUrl: string;
  localAgentModel: string;
  localAgentToken: string;
  systemPrompt: string;
  userPromptTemplate: string;
}>();
const emit = defineEmits<{
  acceptedTranslations: [items: Array<{ id: string; text: string }>];
}>();

const project = ref<any>(null);
const verification = ref<any>(null);
const activeRun = ref<any>(null);
const runs = ref<any[]>([]);
const events = ref<any[]>([]);
const busy = ref(false);
const error = ref('');
const message = ref('');
const selectedSegmentId = ref('');
const manualText = ref('');
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const isRunning = computed(() => !!activeRun.value && ['queued', 'running'].includes(activeRun.value.status));
const selectedSegment = computed(() => props.visibleSegments.find((segment) => segment.id === selectedSegmentId.value));
const candidatePreview = computed(() => {
  const rows = Array.isArray(activeRun.value?.segments) ? activeRun.value.segments : [];
  const sourceById = new Map(props.segments.map((segment) => [segment.id, segment]));
  return rows
    .filter((row: any) => typeof row.candidateTranslation === 'string' && row.candidateTranslation.trim())
    .slice(0, 8)
    .map((row: any) => {
      const source = sourceById.get(row.id);
      return {
        id: row.id,
        source: source?.text || '',
        contextPath: source?.contextPath || '',
        accepted: props.translations.get(row.id) || '',
        candidate: row.candidateTranslation as string,
      };
    });
});
const progressItems = [
  { key: 'total', label: '计划' },
  { key: 'pending', label: '等待' },
  { key: 'running', label: '执行中' },
  { key: 'candidate', label: '候选' },
  { key: 'accepted', label: '已采纳' },
  { key: 'failed', label: '失败' },
];
const runLabels: Record<string, string> = {
  queued: '排队中', running: '运行中', paused: '已暂停', awaiting_acceptance: '待采纳',
  partial: '部分完成', completed: '已完成', failed: '失败', cancelled: '已停止',
};
function runStatusLabel(status: string): string { return runLabels[status] || status; }

function documentKey(): string {
  let hash = 0x811c9dc5;
  const add = (value: string) => {
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  };
  add(props.format.toLowerCase() + '\u0000' + props.title + '\u0000');
  for (const segment of props.segments) {
    add(segment.id); add('\u0000'); add(segment.text); add('\u0000'); add(segment.kind || 'paragraph'); add('\u0000');
    add(segment.contextPath || ''); add('\u0000'); add(String(segment.page ?? '')); add('\u0000');
    add(String(segment.level ?? '')); add('\u0000'); add(segment.marker || ''); add('\u0000');
    add(segment.path || ''); add('\u0000'); add(segment.start || ''); add('\u0000'); add(segment.end || ''); add('\u0001');
  }
  return props.format.toLowerCase() + ':' + props.segments.length + ':' + (hash >>> 0).toString(16);
}

// Stable logical identity is separate from the full content fingerprint. Re-importing a changed
// file with the same name offers an explicit new source revision rather than silently replacing it.
function sourceIdentityKey(): string {
  return [props.format.toLowerCase(), props.sourceFileName.toLocaleLowerCase(), props.title.toLocaleLowerCase()].join('::');
}
type ProjectIdentityMap = Record<string, { projectId: string; documentKey: string }>;

async function saveProjectMapping() {
  if (!project.value) return;
  const exact = (await storage.getItem<Record<string, string>>('local:documentAgentProjectMap')) || {};
  exact[documentKey()] = project.value.projectId;
  await storage.setItem('local:documentAgentProjectMap', exact);
  const identities = (await storage.getItem<ProjectIdentityMap>('local:documentAgentProjectIdentityMap')) || {};
  identities[sourceIdentityKey()] = { projectId: project.value.projectId, documentKey: documentKey() };
  await storage.setItem('local:documentAgentProjectIdentityMap', identities);
  sourceChanged.value = false;
}

function promptInput(): PromptInput {
  return {
    systemPrompt: props.systemPrompt,
    userPromptTemplate: props.userPromptTemplate,
    sourceLang: props.sourceLang,
    targetLang: props.targetLang,
    provider: props.localAgentProvider,
    model: props.localAgentModel || 'auto',
    translationMode: props.translationMode,
    literaryReview: props.translationMode === 'literary' && props.literaryReview,
    literaryMemory: props.literaryMemory,
  };
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const base = (props.localAgentUrl || 'http://127.0.0.1:8789').trim().replace(/\/+$/, '');
  const url = new URL(path, base + '/');
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (props.localAgentToken) headers.set('Authorization', 'Bearer ' + props.localAgentToken);
  const response = await fetch(url.toString(), { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || ('本机服务返回 HTTP ' + response.status));
  return payload;
}

async function createProject() {
  if (!props.useLocalAgent) { error.value = '请先启用本机 Agent。'; return; }
  if (!props.segments.length) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const response = await api('/api/documents/projects', {
      method: 'POST',
      body: JSON.stringify({
        title: props.title, sourceFileName: props.sourceFileName, format: props.format,
        segments: props.segments,
        prompt: promptInput(),
      }),
    });
    project.value = response.project;
    await saveProjectMapping();
    message.value = '文档项目已创建，来源片段和翻译运行会独立保存。';
    if (props.sourceFile) {
      try {
        await uploadCurrentSourceFile();
      } catch (uploadError) {
        message.value = '项目已创建，但原始文件备份失败：' + (uploadError instanceof Error ? uploadError.message : String(uploadError)) + '。可点击“备份原始文件”重试。';
      }
    } else {
      message.value += ' 当前没有原始文件对象，项目暂时只保存解析后的片段。';
    }
    await refreshProject();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally { busy.value = false; }
}

async function loadExistingProject() {
  if (!props.useLocalAgent || !props.segments.length) return;
  try {
    const mapping = (await storage.getItem<Record<string, string>>('local:documentAgentProjectMap')) || {};
    const identities = (await storage.getItem<ProjectIdentityMap>('local:documentAgentProjectIdentityMap')) || {};
    const identity = identities[sourceIdentityKey()];
    const exactProjectId = mapping[documentKey()];
    const projectId = exactProjectId || identity?.projectId;
    if (!projectId) return;
    const result = await api('/api/documents/projects/' + encodeURIComponent(projectId));
    project.value = result.project;
    sourceChanged.value = !exactProjectId && !!identity && identity.documentKey !== documentKey();
    verification.value = result.verification;
    runs.value = result.runs || [];
    const active = runs.value.find((run) => ['queued', 'running', 'paused', 'awaiting_acceptance', 'partial'].includes(run.status));
    if (active) await selectRun(active.runId);
    loadSelectedTranslation();
  } catch {
    // An old mapping may point to an archived project; the user can create a new project explicitly.
    project.value = null;
  }
}

async function refreshProject() {
  if (!project.value) return;
  const result = await api('/api/documents/projects/' + encodeURIComponent(project.value.projectId));
  project.value = result.project;
  verification.value = result.verification;
  runs.value = result.runs || [];
  if (activeRun.value) await refreshRun(activeRun.value.runId);
}

async function uploadCurrentSourceFile() {
  if (!project.value || !props.sourceFile) throw new Error('当前没有可上传的原始文件');
  const result = await api('/api/documents/projects/' + encodeURIComponent(project.value.projectId) + '/source-file', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Source-File-Name': encodeURIComponent(props.sourceFile.name),
    },
    body: props.sourceFile,
  });
  project.value = { ...project.value, sourceFileSaved: true, sourceFileSize: result.size };
  message.value = '原始文件已备份到本机文档项目目录（' + (result.size / 1024 / 1024).toFixed(2) + ' MiB）。';
  await refreshProject();
}

async function updateSourceRevision() {
  if (!project.value || !sourceChanged.value) return;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const result = await api('/api/documents/projects/' + encodeURIComponent(project.value.projectId) + '/source', {
      method: 'POST',
      body: JSON.stringify({
        title: props.title,
        sourceFileName: props.sourceFileName,
        format: props.format,
        segments: props.segments,
      }),
    });
    project.value = result.project;
    if (props.sourceFile) {
      try {
        await uploadCurrentSourceFile();
      } catch (uploadError) {
        message.value = '新来源片段已保存，但原始文件备份失败：' + (uploadError instanceof Error ? uploadError.message : String(uploadError));
      }
    }
    await saveProjectMapping();
    await refreshProject();
    message.value = (message.value ? message.value + ' ' : '') + '新来源版本已保存；原有运行与人工修订保留，变更片段会在下次运行中重新翻译。';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function createSeparateProject() {
  if (busy.value || isRunning.value) return;
  project.value = null;
  activeRun.value = null;
  verification.value = null;
  runs.value = [];
  sourceChanged.value = false;
  await createProject();
}

async function startRun(scope: 'stale' | 'all' | 'failed' | 'visible') {
  if (sourceChanged.value) { error.value = '请先确认是否导入新的来源版本。'; return; }
  busy.value = true; error.value = ''; message.value = '';
  try {
    if (!project.value) await createProject();
    if (!project.value) return;
    const runScope = scope === 'visible'
      ? { type: 'ids', ids: props.visibleSegments.map((segment) => segment.id) }
      : { type: scope };
    const response = await api('/api/documents/projects/' + project.value.projectId + '/runs', {
      method: 'POST',
      body: JSON.stringify({ scope: runScope, prompt: promptInput() }),
    });
    activeRun.value = response.run;
    message.value = response.started ? '翻译 Agent 已启动；进度和模型调用结果会持久化到项目数据库。' : '当前范围没有需要处理的片段。';
    await refreshProject();
    if (isRunning.value) schedulePoll(activeRun.value.runId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally { busy.value = false; }
}

async function selectRun(runId: string) {
  try {
    await refreshRun(runId);
    const result = await api('/api/documents/projects/' + project.value.projectId + '/events?runId=' + encodeURIComponent(runId) + '&limit=100');
    events.value = result.events || [];
    if (isRunning.value) schedulePoll(runId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function refreshRun(runId: string) {
  if (!project.value) return;
  const result = await api('/api/documents/projects/' + project.value.projectId + '/runs/' + encodeURIComponent(runId));
  activeRun.value = result.run;
}

function schedulePoll(runId: string) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (disposed) return;
    try {
      await refreshRun(runId);
      if (isRunning.value) schedulePoll(runId);
      else await refreshProjectWithoutRun();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }, 1200);
}

async function refreshProjectWithoutRun() {
  if (!project.value) return;
  const result = await api('/api/documents/projects/' + encodeURIComponent(project.value.projectId));
  project.value = result.project;
  verification.value = result.verification;
  runs.value = result.runs || [];
  if (activeRun.value) {
    const eventResult = await api('/api/documents/projects/' + project.value.projectId + '/events?runId=' + encodeURIComponent(activeRun.value.runId) + '&limit=100');
    events.value = eventResult.events || [];
  }
}

async function savePromptRevision() {
  busy.value = true; error.value = '';
  try {
    const response = await api('/api/documents/projects/' + project.value.projectId + '/prompts', {
      method: 'POST', body: JSON.stringify(promptInput()),
    });
    message.value = 'Prompt 版本已保存：' + response.prompt.promptRevisionId.slice(0, 8);
    await refreshProject();
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}

async function resumeRun() {
  if (!activeRun.value || !project.value) return;
  busy.value = true; error.value = '';
  try {
    const response = await api('/api/documents/projects/' + project.value.projectId + '/runs/' + activeRun.value.runId + '/resume', {
      method: 'POST', body: '{}',
    });
    activeRun.value = response.run;
    if (['queued', 'running'].includes(activeRun.value.status)) schedulePoll(activeRun.value.runId);
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}

async function cancelRun() {
  if (!activeRun.value || !project.value) return;
  busy.value = true; error.value = '';
  try {
    const response = await api('/api/documents/projects/' + project.value.projectId + '/runs/' + activeRun.value.runId + '/cancel', {
      method: 'POST', body: '{}',
    });
    activeRun.value = response.run;
    message.value = '已请求停止；已持久化的候选不会删除。';
    if (pollTimer) clearTimeout(pollTimer);
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}

async function acceptCandidates(segmentIds?: string[]) {
  if (!activeRun.value || !project.value) return;
  const runId = activeRun.value.runId as string;
  // Snapshot candidates before the response changes their run-segment status.
  const candidates = (activeRun.value.segments || [])
    .filter((segment: any) => segment.status === 'candidate' && typeof segment.candidateTranslation === 'string')
    .map((segment: any) => ({ id: segment.id as string, text: segment.candidateTranslation as string }));
  const requested = segmentIds?.length ? new Set(segmentIds) : new Set(candidates.map((item) => item.id));
  if (!requested.size) return;
  busy.value = true; error.value = '';
  try {
    const response = await api('/api/documents/projects/' + project.value.projectId + '/runs/' + runId + '/accept', {
      method: 'POST', body: JSON.stringify({ segmentIds: Array.from(requested) }),
    });
    activeRun.value = response.run;
    const items = candidates.filter((item) => requested.has(item.id));
    emit('acceptedTranslations', items);
    message.value = segmentIds?.length
      ? '已采纳所选片段并同步到阅读器；其他候选仍可单独选择。'
      : '已采纳本次候选并同步到阅读器；历史运行仍可查看。';
    await refreshProjectWithoutRun();
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}

function loadSelectedTranslation() {
  const segment = selectedSegment.value;
  if (segment) manualText.value = props.translations.get(segment.id) || '';
}
async function saveManualEdit() {
  if (!project.value || !selectedSegmentId.value || !manualText.value.trim()) return;
  busy.value = true; error.value = '';
  try {
    await api('/api/documents/projects/' + project.value.projectId + '/segments/' + encodeURIComponent(selectedSegmentId.value) + '/translation', {
      method: 'PUT', body: JSON.stringify({ text: manualText.value }),
    });
    emit('acceptedTranslations', [{ id: selectedSegmentId.value, text: manualText.value }]);
    message.value = '人工修订已单独存档，并已更新阅读器当前译文。';
    await refreshProject();
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}

watch(() => props.visibleSegments.map((segment) => segment.id).join('|'), () => {
  if (!props.visibleSegments.some((segment) => segment.id === selectedSegmentId.value)) {
    selectedSegmentId.value = props.visibleSegments[0]?.id || '';
  }
  loadSelectedTranslation();
});
watch(() => [props.systemPrompt, props.userPromptTemplate, props.sourceLang, props.targetLang, props.translationMode],
  () => { /* Prompt is snapshotted only when the user starts/saves a run. */ });

onMounted(async () => {
  await loadExistingProject();
  if (!selectedSegmentId.value) selectedSegmentId.value = props.visibleSegments[0]?.id || '';
  loadSelectedTranslation();
});
onUnmounted(() => {
  disposed = true;
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<style scoped>
.document-agent-workspace { display: flex; flex-direction: column; gap: 1rem; }
.workspace-heading, .run-heading, .prompt-summary, .candidate-gate, .manual-actions, .history-row {
  display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem;
}
.workspace-heading h3 { margin: 0 0 .3rem; }
.workspace-heading p, .prompt-summary p, .candidate-gate p, .manual-edit-panel p { margin: .25rem 0 0; line-height: 1.5; }
.status-chip, .run-status { border-radius: 999px; padding: .2rem .6rem; background: #f0f2f5; font-size: .78rem; white-space: nowrap; }
.run-status.status-running { background: #e6f4ff; color: #0958d9; }
.run-status.status-failed, .run-status.status-partial { background: #fff1f0; color: #a8071a; }
.run-status.status-awaiting_acceptance { background: #fff7e6; color: #ad6800; }
.run-status.status-completed { background: #f6ffed; color: #389e0d; }
.notice { padding: .8rem; border-radius: 6px; background: #fafafa; }
.project-create { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.project-description { display: flex; flex-direction: column; gap: .25rem; min-width: 0; }
.project-overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .6rem; }
.overview-item { display: flex; flex-direction: column; gap: .25rem; padding: .7rem; border: 1px solid #e8e8e8; border-radius: 7px; min-width: 0; }
.overview-item strong { overflow-wrap: anywhere; }
.agent-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.prompt-summary, .run-card, .manual-edit-panel, .run-history { padding: .9rem; border: 1px solid #e8e8e8; border-radius: 8px; }
.prompt-summary { align-items: center; }
.run-card { display: flex; flex-direction: column; gap: .8rem; }
.run-heading > div { display: flex; flex-direction: column; gap: .2rem; }
.run-progress { display: flex; flex-wrap: wrap; gap: .65rem; }
.progress-item { display: flex; flex-direction: column; min-width: 3.5rem; gap: .1rem; }
.progress-item strong { font-size: 1.1rem; }
.progress-item small { color: #666; }
.candidate-gate { align-items: center; padding: .75rem; border: 1px solid #ffe7ba; background: #fffbe6; border-radius: 6px; }
.finding-list { display: flex; flex-direction: column; gap: .4rem; }
.finding-row { display: grid; grid-template-columns: 4.5rem 7rem 1fr; gap: .5rem; align-items: start; padding: .45rem 0; border-top: 1px solid #f0f0f0; }
.finding-category { font-size: .78rem; color: #595959; }
.manual-edit-panel { display: flex; flex-direction: column; gap: .7rem; }
.manual-field { display: flex; flex-direction: column; gap: .3rem; }
.manual-field select, .manual-field textarea { width: 100%; border: 1px solid #d9d9d9; border-radius: 5px; padding: .5rem; background: white; color: inherit; }
.source-preview { white-space: pre-wrap; max-height: 8rem; overflow: auto; padding: .55rem; border-radius: 5px; background: #fafafa; }
.manual-actions { align-items: center; justify-content: flex-start; flex-wrap: wrap; }
.run-history summary { cursor: pointer; font-weight: 600; }
.history-row { align-items: center; padding: .55rem 0; border-top: 1px solid #f0f0f0; }
.history-row > div { display: flex; flex-direction: column; gap: .2rem; }
.workspace-message { margin: 0; }
.workspace-error { margin: 0; }
@media (max-width: 700px) {
  .project-create, .prompt-summary, .candidate-gate { align-items: stretch; flex-direction: column; }
  .project-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .finding-row { grid-template-columns: 1fr; gap: .2rem; }
}
</style>
