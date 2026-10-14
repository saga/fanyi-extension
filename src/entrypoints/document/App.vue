<template>
  <div class="doc-page" :class="{ 'is-empty': !doc }">
    <header class="doc-header">
      <h1>文档翻译</h1>
      <div class="header-actions">
        <button v-if="doc" class="btn ghost" @click="resetAll">换一个文件</button>
      </div>
    </header>

    <!-- 上次阅读快照仅包含最近一本书；正文与译文保存在扩展本地 IndexedDB。 -->
    <section v-if="!doc && !parsing && (savedSessionSummary || localSessionSummary)" class="panel saved-session">
      <div class="saved-session-copy">
        <strong>继续上次阅读</strong>
        <span>{{ savedSessionSummary?.title || savedSessionSummary?.fileName || localSessionSummary?.title || '本机阅读记录' }}</span>
        <span v-if="savedSessionSummary" class="muted small">
          {{ FORMAT_LABEL[savedSessionSummary.format] || savedSessionSummary.format }}
          · {{ savedSessionSummary.segmentCount.toLocaleString() }} 段
          · 已保存 {{ savedSessionSummary.translatedSegmentCount.toLocaleString() }} 段译文
        </span>
        <span v-else-if="localSessionSummary" class="muted small">
          {{ FORMAT_LABEL[localSessionSummary.format] || localSessionSummary.format }} · 本机 SQLite 恢复副本
        </span>
        <span class="muted small">上次保存：{{ new Date(savedSessionSummary?.updatedAt ?? localSessionSummary?.updatedAt ?? Date.now()).toLocaleString() }}</span>
      </div>
      <div class="saved-session-actions">
        <button class="btn primary" @click="restoreLastSession">恢复阅读</button>
        <button class="btn ghost" @click="clearSavedSession">清除记录</button>
      </div>
    </section>

    <section v-if="persistenceMessage && !doc" class="panel persistence-notice">
      <span>{{ persistenceMessage }}</span>
    </section>

    <!-- 1. 未选择文件：选择 / 拖拽 -->
    <section v-if="!doc && !parsing" class="dropzone" :class="{ dragover }"
      @dragover.prevent="dragover = true" @dragleave.prevent="dragover = false"
      @drop.prevent="onDrop">
      <p class="dz-title">把文件拖到这里，或</p>
      <button class="btn primary" @click="pickFile">选择文件</button>
      <p class="dz-hint">
        支持 TXT / Markdown / HTML / SRT / VTT / JSON / PDF / DOCX / EPUB，单个文件 ≤ 20MB
      </p>
      <input ref="fileInput" type="file" class="hidden-input" :accept="DOCUMENT_ACCEPT_ATTR"
        @change="onFilePicked" />
    </section>

    <!-- 2. 解析中 -->
    <section v-if="parsing" class="panel">
      <p class="muted">正在解析{{ progress.total > 1 ? `（${progress.done}/${progress.total} 个处理单元）` : '…' }}</p>
      <div v-if="progress.total > 1" class="progress"><div class="bar"
        :style="{ width: (progress.done / progress.total) * 100 + '%' }"></div></div>
    </section>

    <!-- 3. 解析错误 -->
    <section v-if="parseError" class="panel error-box">
      <p>{{ parseError }}</p>
      <button class="btn" @click="resetAll">重新选择</button>
    </section>

    <!-- 4. 已解析：Tab 导航 + 控制条 + 正文 -->
    <template v-if="doc">
      <nav class="tabs" aria-label="文档功能分区">
        <button class="tab" :class="{ active: activeTab === 'reading' }" @click="activeTab = 'reading'">阅读</button>
        <button class="tab" :class="{ active: activeTab === 'memory' }" @click="activeTab = 'memory'">
          设置与记忆
          <span v-if="literaryMode" class="tab-badge">{{ literaryMemory.entities.length }}实体·{{ literaryStatus.reviewFindings.length }}审校</span>
        </button>
      </nav>

      <!-- Tab 1 阅读：只留操作条 + 章节导航 + 正文。设置、记忆、词典都在第二个 Tab。 -->
      <template v-if="activeTab === 'reading'">
      <section class="panel action-bar">
        <div class="action-title">
          <strong>{{ doc.title }}</strong>
          <span class="muted small">
            本页 {{ currentPageTranslatedCount }}/{{ visibleSegments.length }} 段
            · 全书 {{ translatedSegmentCount }}/{{ doc.meta.segmentCount }} 段
            <template v-if="state.running && state.workChapter"> · 正在翻译「{{ state.workChapter }}」{{ state.workTotal > 0 ? `${state.workDone}/${state.workTotal} 批` : '' }}{{ state.workStage ? ` · ${state.workStage}` : '' }}</template>
          </span>
        </div>
        <div class="action-controls">
          <label class="field inline">
            <span>显示</span>
            <select v-model="viewMode">
              <option value="bilingual">双语对照</option>
              <option value="translation">仅译文</option>
              <option value="original">仅原文</option>
            </select>
          </label>
          <label v-if="literaryMode" class="field inline" title="关闭后每批省一次审校调用，速度翻倍；译文为初译水平">
            <span>审校</span>
            <input v-model="literaryReview" type="checkbox" />
          </label>
          <button
            v-if="!state.running && (state.total === 0 || state.done < state.total)"
            class="btn primary"
            @click="startTranslate">
            {{ startLabel }}
          </button>
          <button v-if="state.running" class="btn" @click="stopTranslation">停止</button>
          <button v-if="state.failedBatches.length" class="btn warn" @click="retry">
            重试失败批次（{{ state.failedBatches.length }}）
          </button>
        </div>
        <p v-if="state.error" class="err-text small">{{ state.error }}</p>
      </section>

      <!-- 阅读导航：只渲染当前页片段，避免整本 EPUB 一次变成超长页面。 -->
      <section class="panel reader-navigation" aria-label="阅读位置">
        <div class="reader-navigation-main">
          <div class="reader-location">
            <strong>{{ currentPage?.title || doc.title }}</strong>
            <span class="muted small">
              第 {{ currentPageIndex + 1 }} / {{ pages.length }} 页
              · {{ (currentPage?.charCount ?? 0).toLocaleString() }} 字
            </span>
            <span class="muted small">
              本页已译 {{ currentPageTranslatedCount }}/{{ visibleSegments.length }} 段
              · 全文已译 {{ translatedSegmentCount }}/{{ doc.meta.segmentCount }} 段
            </span>
            <span v-if="state.running && state.workChapter && !isTranslatingCurrentChapter" class="muted small translating-hint">
              正在翻译「{{ state.workChapter }}」，当前页不在该章节。
              <button class="link-btn" @click="jumpToWorkChapter">跳到正在翻译的章节</button>
            </span>
          </div>
          <div class="reader-navigation-controls">
            <button class="btn" :disabled="currentPageIndex <= 0" @click="currentPageIndex--">上一页</button>
            <select v-model.number="currentPageIndex" aria-label="跳转阅读页" class="page-select">
              <option v-for="(page, index) in pages" :key="page.id" :value="index">
                {{ index + 1 }}. {{ page.title }}
              </option>
            </select>
            <button class="btn" :disabled="currentPageIndex >= pages.length - 1" @click="currentPageIndex++">下一页</button>
          </div>
        </div>
        <div class="reader-progress" role="progressbar"
          :aria-valuenow="currentPageIndex + 1" :aria-valuemin="1" :aria-valuemax="Math.max(pages.length, 1)">
          <div class="reader-progress-bar" :style="{ width: (pages.length ? ((currentPageIndex + 1) / pages.length) * 100 : 0) + '%' }"></div>
        </div>
      </section>

      <!-- 当前阅读页：译文逐批到达后即时显示，不必等待整本书结束。 -->
      <article ref="readerRef" class="reader" :key="currentPage?.id || 'empty-reader'">
        <div v-for="seg in visibleSegments" :key="seg.id" class="seg"
          :class="['kind-' + seg.kind, 'level-' + (seg.level ?? 0), { 'is-active': state.activeSegmentIds?.has(seg.id) }]">
          <div v-if="viewMode !== 'translation'" class="or">{{ seg.text }}</div>
          <div v-if="viewMode !== 'original'" class="tr">
            <template v-if="state.translations.get(seg.id)">{{ state.translations.get(seg.id) }}</template>
            <span v-else-if="state.running && state.activeSegmentIds?.has(seg.id)" class="tr-pending">翻译中…</span>
            <span v-else-if="!state.running && state.total > 0" class="tr-idle">待翻译 — 点击上方「{{ startLabel }}」</span>
          </div>
          <div v-if="seg.kind === 'caption' && (seg.start || seg.end)" class="timecode">
            {{ seg.start }} → {{ seg.end }}
          </div>
        </div>
      </article>

      <!-- 导出 -->
      <section class="panel export">
        <span class="muted small">导出：</span>
        <button class="btn ghost" @click="doExport('html')">HTML</button>
        <button class="btn ghost" @click="doExport('md')">Markdown</button>
        <button class="btn ghost" @click="doExport('txt')">TXT</button>
        <button v-if="doc.format === 'srt'" class="btn ghost" @click="doExport('srt')">双语 SRT</button>
        <button v-if="doc.format === 'vtt'" class="btn ghost" @click="doExport('vtt')">双语 VTT</button>
        <button v-if="doc.format === 'json'" class="btn ghost" @click="doExport('json')">JSON</button>
      </section>
      </template>

      <template v-else>
      <section v-if="persistenceMessage" class="panel persistence-notice">
        <span>{{ persistenceMessage }}</span>
      </section>

      <section class="panel meta">
        <div class="meta-row">
          <strong class="doc-title">{{ doc.title }}</strong>
          <span class="chip">{{ FORMAT_LABEL[doc.format] || doc.format }}</span>
          <span class="chip">{{ doc.meta.segmentCount }} 段</span>
          <span class="chip">{{ doc.meta.charCount.toLocaleString() }} 字</span>
        </div>
        <p v-for="(w, i) in doc.meta.warnings" :key="i" class="warn">⚠️ {{ w }}</p>
      </section>

      <section class="panel controls">
        <label class="field">
          <span>源语言</span>
          <select v-model="sourceLang">
            <option value="auto">自动检测</option>
            <option value="en">英语</option>
            <option value="zh">中文</option>
            <option value="ja">日语</option>
            <option value="ko">韩语</option>
            <option value="fr">法语</option>
            <option value="de">德语</option>
          </select>
        </label>
        <label class="field">
          <span>目标语言</span>
          <select v-model="targetLang">
            <option value="zh">中文</option>
            <option value="en">英语</option>
            <option value="ja">日语</option>
            <option value="ko">韩语</option>
            <option value="fr">法语</option>
            <option value="de">德语</option>
          </select>
        </label>
        <label class="field">
          <span>显示</span>
          <select v-model="viewMode">
            <option value="bilingual">双语对照</option>
            <option value="translation">仅译文</option>
            <option value="original">仅原文</option>
          </select>
        </label>
        <label v-if="doc.format === 'epub' || doc.format === 'pdf'" class="field literary-toggle">
          <span>书籍翻译</span>
          <span class="literary-toggle-control">
            <input v-model="literaryMode" type="checkbox" :disabled="state.total > 0" />
            实体一致性与文风审校
          </span>
        </label>
      </section>

      <section v-if="state.total > 0" class="panel progress-panel">
        <div class="progress"><div class="bar"
          :style="{ width: (state.done / state.total) * 100 + '%' }"></div></div>
        <span class="muted small">
          <template v-if="literaryMode && state.workTotal > 0">本章 {{ state.workDone }}/{{ state.workTotal }} 批 · 全书 {{ state.done }}/{{ state.total }} 批</template>
          <template v-else>{{ state.done }}/{{ state.total }} 批</template>
          <template v-if="state.running && state.workChapter"> · 正在翻译：{{ state.workChapter }}</template>
          <template v-if="state.error"> · <span class="err-text">{{ state.error }}</span></template>
        </span>
      </section>

      <section v-if="literaryStatus.enabled" class="panel literary-status">
        <div class="literary-status-title">
          <strong>书籍一致性与文风审校</strong>
          <span class="chip">{{ literaryStatus.bookProfileReady ? '已建立全书记忆' : '全书预分析中/待重试' }}</span>
          <span class="chip">已补充分析 {{ literaryStatus.analyzedChapters }} 章</span>
          <span class="chip">已审校 {{ literaryStatus.reviewedSegments }} 段</span>
          <span class="chip">记忆实体 {{ literaryMemory.entities.length }} 个</span>
          <span class="chip">审校记录 {{ literaryStatus.reviewFindings.length }} 条</span>
        </div>
        <p class="muted small" v-if="literaryStatus.chapterTitle">
          当前分析章节：{{ literaryStatus.chapterTitle }}
        </p>
        <p v-for="(warning, index) in literaryStatus.warnings.slice(-3)" :key="index" class="warn">
          {{ warning }}
        </p>
      </section>


      <!-- 词典/关系表可人工修订；确认状态会随本地会话保存，并影响后续章节。 -->
      <section v-if="literaryMode" class="panel literary-dictionary">
        <details open>
          <summary><strong>实体词典</strong>（{{ literaryMemory.entities.length }} 项；有原文依据的入库自动确认，无依据的待人工过目）</summary>
          <div class="literary-editor-list">
            <div v-for="(entity, index) in literaryMemory.entities" :key="'entity-' + index" class="literary-editor-row">
              <label>原文名称<input v-model="entity.source" @change="markEntitySuggested(entity)" /></label>
              <label>规范译名<input v-model="entity.target" @change="markEntitySuggested(entity)" /></label>
              <label>别名（逗号分隔）<input :value="(entity.aliases || []).join(', ')" @change="setEntityAliases(entity, $event)" /></label>
              <span class="chip">{{ entity.reviewStatus === 'confirmed' ? '已确认' : '待确认' }}</span>
              <button class="btn ghost" :disabled="!entity.source.trim() || !entity.target.trim()" @click="confirmEntity(entity)">确认</button>
              <button class="btn ghost" @click="removeEntity(index)">删除</button>
            </div>
            <button class="btn" @click="addEntity">新增实体</button>
            <button class="btn" @click="confirmAllEntities">一键确认剩余</button>
          </div>
        </details>
        <details>
          <summary><strong>人物/事物关系表</strong>（{{ literaryMemory.relationships.length }} 项）</summary>
          <div class="literary-editor-list">
            <div v-for="(relation, index) in literaryMemory.relationships" :key="'relation-' + index" class="literary-editor-row">
              <label>主体<input v-model="relation.subject" @change="markRelationshipSuggested(relation)" /></label>
              <label>关系<input v-model="relation.predicate" @change="markRelationshipSuggested(relation)" /></label>
              <label>对象<input v-model="relation.object" @change="markRelationshipSuggested(relation)" /></label>
              <span class="chip">{{ relation.reviewStatus === 'confirmed' ? '已确认' : '待确认' }}</span>
              <button class="btn ghost" :disabled="!relation.subject.trim() || !relation.predicate.trim() || !relation.object.trim()" @click="confirmRelationship(relation)">确认</button>
              <button class="btn ghost" @click="removeRelationship(index)">删除</button>
            </div>
            <button class="btn" @click="addRelationship">新增关系</button>
            <button class="btn" @click="confirmAllRelationships">一键确认剩余</button>
          </div>
        </details>
        <p class="muted small">有原文依据的入库自动确认；编辑后会重新标记为“待确认”，剩余项可一键确认。修改会保存在本机阅读会话中。</p>
      </section>

      <section v-if="literaryStatus.reviewFindings.length" class="panel literary-review-findings">
        <strong>Reviewer 审校记录</strong>
        <p class="muted small">审校只报明确的事实/术语错误，命中即自动修正译文；文风偏好不在审校范围内。</p>
        <div v-for="(finding, index) in literaryStatus.reviewFindings" :key="'finding-' + index" class="literary-review-finding">
          <div>
            <span class="chip">{{ finding.priority === 'optional' ? '仅提示（未覆盖译文）' : '必须修正（已应用）' }}</span>
            <span class="muted small">{{ finding.id }} · {{ finding.category }}</span>
          </div>
          <p v-if="finding.sourceExcerpt"><strong>原文：</strong>{{ finding.sourceExcerpt }}</p>
          <p v-if="finding.draftExcerpt"><strong>初译：</strong>{{ finding.draftExcerpt }}</p>
          <p v-if="finding.reason"><strong>原因：</strong>{{ finding.reason }}</p>
          <p v-if="finding.suggestion"><strong>建议：</strong>{{ finding.suggestion }}</p>
        </div>
      </section>
      <section v-if="!literaryMode && !literaryStatus.enabled" class="panel">
        <p class="muted small">当前文档未启用书籍翻译模式。EPUB / PDF 打开时默认启用；也可在本页上方勾选「实体一致性与文风审校」。</p>
      </section>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { getConfig } from '@/entrypoints/utils/config';
import { extractGlossaryLocal } from '@/entrypoints/utils/glossaryExtractor';
import type { Glossary } from '@/entrypoints/service/_service';
import {
  DOCUMENT_ACCEPT_ATTR,
  exportDocument,
  buildExportFileName,
  parseDocument,
  type ExportFormat,
} from '@/entrypoints/utils/document';
import type { ParsedDocument } from '@/entrypoints/utils/document/types';
import { buildDocumentPages } from '@/entrypoints/utils/document/pagination';
import {
  clearActiveDocumentSession,
  createActiveDocumentSession,
  getActiveDocumentSessionSummary,
  loadActiveDocumentSession,
  saveActiveDocumentProgress,
  type ActiveDocumentSessionSummary,
  type LoadedActiveDocumentSession,
  type SavedViewMode,
} from '@/entrypoints/utils/document/sessionStore';
import { useDocumentTranslation } from './useDocumentTranslation';
import { createEmptyLiteraryMemory, type LiteraryEntity, type LiteraryRelationship } from '@/entrypoints/utils/document/literary';

const FORMAT_LABEL: Record<string, string> = {
  txt: '纯文本',
  md: 'Markdown',
  html: 'HTML',
  srt: 'SRT 字幕',
  vtt: 'VTT 字幕',
  json: 'JSON',
  pdf: 'PDF',
  docx: 'Word',
  epub: 'EPUB',
};

const fileInput = ref<HTMLInputElement | null>(null);
const dragover = ref(false);
const doc = ref<ParsedDocument | null>(null);
const parsing = ref(false);
const parseError = ref('');
const progress = ref({ done: 0, total: 0 });
const sourceLang = ref('auto');
const targetLang = ref('zh');
const viewMode = ref<'bilingual' | 'translation' | 'original'>('bilingual');
const literaryMode = ref(false);
/** 文学审校开关：关闭=快速模式，每批省一次审校 LLM 调用。 */
const literaryReview = ref(true);
const currentPageIndex = ref(0);
const savedSessionSummary = ref<ActiveDocumentSessionSummary | null>(null);
/** 当 IndexedDB 不可用时，仅凭 SQLite 的轻量摘要也要显示恢复入口。 */
const localSessionSummary = ref<{ title: string; format: string; updatedAt: string } | null>(null);
const persistenceMessage = ref('');
const activeSessionReady = ref(false);
/** 该阅读会话是否已成功落入 IndexedDB；失败时仍允许写入独立的 SQLite 恢复副本。 */
let activeSessionIndexedDbWritable = false;
const persistedTranslations = ref(new Map<string, string>());
let persistenceQueue: Promise<void> = Promise.resolve();
const readerRef = ref<HTMLElement | null>(null);
/** 原始文本，json 导出回填时用。 */
let rawText = '';
/**
 * 文档术语表（解析后从正文抽出，专有名词不被翻错）。
 * 必须在 startTranslate / retry 之间复用同一份，否则重试批次与初次翻译的 cacheKey
 * 会不一致（P0：cacheKey 含 glossary hash），导致命中不到初次翻译的缓存，浪费 LLM。
 */
const glossary = ref<Glossary | undefined>(undefined);
/** 保留真实上传文件名；PDF 标题可能从正文提取，不应覆盖文件名。 */
let documentFileName = 'document';

const {
  state,
  run,
  retryFailed,
  stop: stopTranslation,
  reset: resetTranslation,
  literaryMemory,
  literaryStatus,
  getSnapshot,
  restoreSnapshot,
} = useDocumentTranslation();

/** 页级分页不改变原始片段顺序，导出仍以完整文档为准。 */
const pages = computed(() => doc.value ? buildDocumentPages(doc.value) : []);
const currentPage = computed(() => pages.value[currentPageIndex.value] ?? null);
const visibleSegments = computed(() => currentPage.value?.segments ?? []);
const currentPageTranslatedCount = computed(() =>
  visibleSegments.value.filter((segment) => !!state.value.translations.get(segment.id)?.trim()).length,
);
const translatedSegmentCount = computed(() =>
  doc.value?.segments.filter((segment) => !!state.value.translations.get(segment.id)?.trim()).length ?? 0,
);
/** 阅读 Tab 默认首屏；书籍记忆/审校移到第二个 Tab，避免挤占正文主屏。 */
const activeTab = ref<'reading' | 'memory'>('reading');
/** 当前页是否还有未译段落：决定按钮文案是"翻译本章"还是"继续翻译下一章"。 */
const currentChapterPending = computed(() =>
  visibleSegments.value.some((segment) => !state.value.translations.get(segment.id)?.trim()),
);
/** 开始按钮文案：书籍模式永远先翻当前页所在章节，不从头开始。 */
const startLabel = computed(() =>
  literaryMode.value
    ? (state.value.total > 0 && !currentChapterPending.value ? '继续翻译下一章' : '翻译本章')
    : (state.value.total > 0 ? '继续翻译剩余内容' : '翻译全文（先翻本页）'),
);
/** 正在翻译的章节是否就是当前页所在章节（用于提示/跳转）。 */
const isTranslatingCurrentChapter = computed(() => {
  const work = state.value.workChapter;
  if (!work) return true;
  return visibleSegments.value.some((segment) =>
    (segment.contextPath?.trim() || '') === work,
  ) || (currentPage.value?.title || '').includes(work) || (currentPage.value?.sectionTitle || '') === work;
});

function jumpToWorkChapter() {
  const work = state.value.workChapter;
  if (!work || !pages.value.length) return;
  let target = pages.value.findIndex((page) =>
    page.segments.some((segment) => (segment.contextPath?.trim() || '') === work),
  );
  if (target < 0) {
    target = pages.value.findIndex((page) =>
      page.title.includes(work) || page.sectionTitle === work,
    );
  }
  if (target >= 0) {
    activeTab.value = 'reading';
    currentPageIndex.value = target;
  }
}

watch(currentPageIndex, async () => {
  await nextTick();
  readerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/** 阅读位置与显示设置也是会话的一部分；保存失败只提示用户，不中断阅读或翻译。 */
watch([currentPageIndex, sourceLang, targetLang, viewMode, literaryMode], () => {
  void persistCurrentSession();
});

watch(literaryMemory, () => {
  if (literaryMode.value) void persistCurrentSession();
}, { deep: true });

onMounted(async () => {
  // The global literary profile enables the book-level entity/style workflow by default for EPUB/PDF.
  // The checkbox remains an explicit opt-out for users who want literary wording without the extra pass.
  const config = await getConfig();
  if (config.translationMode === 'literary') literaryMode.value = true;
  await refreshSavedSessionSummary();
});

async function refreshSavedSessionSummary() {
  savedSessionSummary.value = null;
  try {
    savedSessionSummary.value = await getActiveDocumentSessionSummary();
  } catch (error) {
    // IndexedDB 可能在无痕模式/配额异常时不可用；仍继续探测 SQLite 备份。
    if (typeof indexedDB !== 'undefined') {
      persistenceMessage.value = '无法读取扩展恢复记录：' +
        (error instanceof Error ? error.message : String(error));
    }
  }
  if (!savedSessionSummary.value) await refreshLocalSessionSummary();
}

const LOCAL_DOCUMENT_SESSION_ID = 'active-document-session-v1';
let localSessionDocumentSaved = false;
let localSessionDisabled = false;
/** 只跟踪真正成功写入 SQLite 的译文，不能复用 IndexedDB 的持久化游标。 */
let localPersistedTranslations = new Map<string, string>();

async function refreshLocalSessionSummary() {
  localSessionSummary.value = null;
  try {
    const config = await getConfig();
    // SQLite 中只读摘要，不会调用模型。即使当前切回远程翻译模式，也允许找回之前保存的本机阅读会话。
    const base = new URL(config.localAgentUrl || 'http://127.0.0.1:8789');
    base.pathname = '/api/documents/session/summary';
    base.search = '';
    base.hash = '';
    const response = await fetch(base.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.localAgentToken ? { Authorization: 'Bearer ' + config.localAgentToken } : {}),
      },
      body: JSON.stringify({ sessionId: LOCAL_DOCUMENT_SESSION_ID }),
    });
    if (!response.ok) return;
    const result = await response.json() as {
      found?: boolean;
      session?: { title?: string; format?: string; updatedAt?: string };
    };
    if (result.found && result.session) {
      localSessionSummary.value = {
        title: result.session.title || '本机阅读记录',
        format: result.session.format || 'txt',
        updatedAt: result.session.updatedAt || new Date().toISOString(),
      };
    }
  } catch {
    // SQLite 是恢复副本；摘要检查失败不影响正常阅读。
  }
}

async function persistDocumentCheckpointToLocalService(input: {
  sourceLang: string; targetLang: string; viewMode: SavedViewMode; literaryMode: boolean;
  currentPageIndex: number; snapshot: ReturnType<typeof getSnapshot>;
  translationDelta: Array<[string, string]>; translatedSegmentCount: number;
}): Promise<boolean> {
  const config = await getConfig();
  if (!config.useLocalAgent || !doc.value || localSessionDisabled) return false;
  try {
    const base = new URL(config.localAgentUrl || 'http://127.0.0.1:8789');
    base.pathname = '/api/documents/session/save';
    base.search = '';
    base.hash = '';

    // 增量基于已确认写入 SQLite 的数据，而不是 IndexedDB 的游标。
    // 服务暂时离线后，之前未成功写入的译文仍会包含在下次请求中。
    const localTranslationDelta = input.snapshot.translations.filter(([id, text]) =>
      localPersistedTranslations.get(id) !== text,
    );
    const { translations: _allTranslations, ...snapshotWithoutTranslations } = input.snapshot;
    const localSnapshot = localSessionDocumentSaved ? snapshotWithoutTranslations : input.snapshot;
    const payload = {
      ...input,
      snapshot: localSnapshot,
      // 首次写入已有完整 snapshot.translations，不重复携带同样大小的增量数组。
      translationDelta: localSessionDocumentSaved ? localTranslationDelta : [],
      ...(!localSessionDocumentSaved ? { document: doc.value, rawText, fileName: documentFileName, glossary: glossary.value } : {}),
    };

    const response = await fetch(base.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.localAgentToken ? { Authorization: 'Bearer ' + config.localAgentToken } : {}),
      },
      body: JSON.stringify({
        sessionId: LOCAL_DOCUMENT_SESSION_ID,
        title: doc.value.title || documentFileName,
        format: doc.value.format,
        mergeExisting: localSessionDocumentSaved,
        payload,
      }),
    });
    if (!response.ok) {
      if (response.status === 413) localSessionDisabled = true;
      console.debug('[document-reader] local SQLite checkpoint skipped:', response.status);
      return false;
    }

    localSessionDocumentSaved = true;
    for (const [id, text] of localTranslationDelta) localPersistedTranslations.set(id, text);
    localSessionSummary.value = {
      title: doc.value.title || documentFileName,
      format: doc.value.format,
      updatedAt: new Date().toISOString(),
    };
    return true;
  } catch (error) {
    // SQLite 是独立备份；本机服务未启动不应中断用户翻译。
    console.debug('[document-reader] local SQLite checkpoint unavailable:', error);
    return false;
  }
}

async function loadDocumentCheckpointFromLocalService(): Promise<LoadedActiveDocumentSession | null> {
  const config = await getConfig();
  try {
    // 仅恢复此前的本机快照，不调用本机模型；恢复不应依赖当前翻译 Provider 开关。
    const base = new URL(config.localAgentUrl || 'http://127.0.0.1:8789');
    base.pathname = '/api/documents/session/get';
    base.search = '';
    base.hash = '';
    const response = await fetch(base.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.localAgentToken ? { Authorization: 'Bearer ' + config.localAgentToken } : {}),
      },
      body: JSON.stringify({ sessionId: LOCAL_DOCUMENT_SESSION_ID }),
    });
    if (!response.ok) return null;
    const result = await response.json() as {
      found?: boolean;
      session?: { title?: string; format?: string; updatedAt?: string; payload?: Record<string, any> };
    };
    const session = result.session;
    const payload = session?.payload;
    if (!result.found || !payload?.document || !payload?.snapshot) return null;

    const snapshot = payload.snapshot;
    const document = payload.document as ParsedDocument;
    const translations = Array.isArray(snapshot.translations)
      ? snapshot.translations.filter((entry: unknown): entry is [string, string] =>
          Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
      : [];
    const literaryMemory = (snapshot.literaryMemory ?? createEmptyLiteraryMemory()) as ReturnType<typeof getSnapshot>['literaryMemory'];
    const literaryStatus = (snapshot.literaryStatus ?? {
      enabled: payload.literaryMode === true,
      bookProfileReady: false,
      chapterTitle: '',
      analyzedChapters: 0,
      reviewedSegments: 0,
      warnings: [],
      reviewFindings: [],
    }) as ReturnType<typeof getSnapshot>['literaryStatus'];
    return {
      fileName: typeof payload.fileName === 'string' ? payload.fileName : (session?.title || document.title || 'document'),
      title: session?.title || document.title || '未命名文档',
      format: session?.format || document.format || 'txt',
      segmentCount: Number.isFinite(document.meta?.segmentCount) ? document.meta.segmentCount : document.segments.length,
      charCount: Number.isFinite(document.meta?.charCount) ? document.meta.charCount : 0,
      updatedAt: Date.parse(session?.updatedAt || '') || Date.now(),
      translatedSegmentCount: translations.length,
      total: Number.isFinite(snapshot.total) ? snapshot.total : 0,
      done: Number.isFinite(snapshot.done) ? snapshot.done : 0,
      currentPageIndex: Number.isFinite(payload.currentPageIndex) ? Math.max(0, Math.floor(payload.currentPageIndex)) : 0,
      literaryMode: payload.literaryMode === true,
      document,
      rawText: typeof payload.rawText === 'string' ? payload.rawText : '',
      ...(payload.glossary ? { glossary: payload.glossary as Glossary } : {}),
      sourceLang: typeof payload.sourceLang === 'string' ? payload.sourceLang : 'auto',
      targetLang: typeof payload.targetLang === 'string' ? payload.targetLang : 'zh',
      viewMode: (['bilingual', 'translation', 'original'].includes(payload.viewMode) ? payload.viewMode : 'bilingual') as SavedViewMode,
      failedBatches: Array.isArray(snapshot.failedBatches) ? snapshot.failedBatches.filter(Number.isInteger) : [],
      error: typeof snapshot.error === 'string' ? snapshot.error : '',
      literaryMemory,
      literaryStatus,
      analyzedChapterKeys: Array.isArray(snapshot.analyzedChapterKeys) ? snapshot.analyzedChapterKeys.filter((key: unknown): key is string => typeof key === 'string') : [],
      lastRunSegmentIds: Array.isArray(snapshot.lastRunSegmentIds) ? snapshot.lastRunSegmentIds.filter((id: unknown): id is string => typeof id === 'string') : [],
      translations,
    };
  } catch {
    return null;
  }
}

async function persistCurrentSession() {
  if (!activeSessionReady.value || !doc.value) return;
  const snapshot = getSnapshot();
  const delta = snapshot.translations.filter(([id, text]) =>
    persistedTranslations.value.get(id) !== text,
  );
  const input = {
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
    viewMode: viewMode.value as SavedViewMode,
    literaryMode: literaryMode.value,
    currentPageIndex: currentPageIndex.value,
    snapshot,
    translationDelta: delta,
    translatedSegmentCount: snapshot.translations.length,
  };

  // 多个 Vue watcher 和翻译批次可能同时请求保存，按顺序写入，避免旧快照覆盖新状态。
  const write = persistenceQueue.then(async () => {
    let indexedDbError: unknown;
    let indexedDbSaved = false;
    if (activeSessionIndexedDbWritable) {
      try {
        await saveActiveDocumentProgress(input);
        indexedDbSaved = true;
        for (const [id, text] of delta) persistedTranslations.value.set(id, text);
      } catch (error) {
        indexedDbError = error;
      }
    }

    // 两份存储必须独立尝试。IndexedDB 配额/权限失败时，不能连带跳过 SQLite 备份。
    const sqliteSaved = await persistDocumentCheckpointToLocalService(input);
    if (indexedDbSaved && sqliteSaved) {
      persistenceMessage.value = '阅读位置、译文和书籍记忆已保存到扩展存储与本机 SQLite。';
    } else if (indexedDbSaved) {
      persistenceMessage.value = '阅读位置和译文已保存到扩展本地存储；本机 SQLite 备份当前不可用。';
    } else if (sqliteSaved) {
      persistenceMessage.value = '扩展 IndexedDB 当前不可用；阅读位置、译文和书籍记忆已保存到本机 SQLite。';
    } else {
      throw indexedDbError instanceof Error
        ? indexedDbError
        : new Error('扩展 IndexedDB 与本机 SQLite 均未能保存阅读检查点');
    }
  });
  persistenceQueue = write.catch(() => undefined);
  try {
    await write;
  } catch (error) {
    persistenceMessage.value = '本地自动保存失败；翻译仍会继续。请检查浏览器扩展存储空间。' +
      (error instanceof Error ? ' ' + error.message : '');
  }
}

async function restoreLastSession() {
  parsing.value = true;
  parseError.value = '';
  persistenceMessage.value = '';
  try {
    let saved: LoadedActiveDocumentSession | null = null;
    let restoredFromLocalService = false;
    try { saved = await loadActiveDocumentSession(); } catch { /* local SQLite may recover the session below */ }
    if (!saved) {
      saved = await loadDocumentCheckpointFromLocalService();
      restoredFromLocalService = !!saved;
    }
    if (!saved) {
      savedSessionSummary.value = null;
      persistenceMessage.value = '没有可恢复的阅读记录。';
      return;
    }

    resetTranslation();
    activeSessionReady.value = false;
    activeSessionIndexedDbWritable = false;
    persistedTranslations.value = new Map(saved.translations);
    localPersistedTranslations = restoredFromLocalService
      ? new Map(saved.translations)
      : new Map<string, string>();
    documentFileName = saved.fileName;
    rawText = saved.rawText;
    localSessionDocumentSaved = restoredFromLocalService;
    localSessionDisabled = false;
    doc.value = saved.document;
    glossary.value = saved.glossary;
    sourceLang.value = saved.sourceLang;
    targetLang.value = saved.targetLang;
    viewMode.value = saved.viewMode;
    literaryMode.value = saved.literaryMode;
    currentPageIndex.value = Math.min(
      Math.max(0, saved.currentPageIndex),
      Math.max(0, buildDocumentPages(saved.document).length - 1),
    );

    restoreSnapshot({
      translations: saved.translations,
      total: saved.total,
      done: saved.done,
      failedBatches: saved.failedBatches,
      error: saved.error,
      literaryMemory: saved.literaryMemory,
      literaryStatus: saved.literaryStatus,
      analyzedChapterKeys: saved.analyzedChapterKeys,
      lastRunSegmentIds: saved.lastRunSegmentIds,
    });

    // SQLite 恢复成功后，尽力重建 IndexedDB 主存储。失败仍可继续使用 SQLite 检查点。
    if (restoredFromLocalService) {
      try {
        await createActiveDocumentSession({
          fileName: documentFileName,
          document: saved.document,
          rawText,
          glossary: glossary.value,
          sourceLang: sourceLang.value,
          targetLang: targetLang.value,
          viewMode: viewMode.value,
          literaryMode: literaryMode.value,
          currentPageIndex: currentPageIndex.value,
        });
        activeSessionIndexedDbWritable = true;
        persistedTranslations.value.clear(); // 新记录还没有译文，需要随后写回全部已完成译文
      } catch {
        activeSessionIndexedDbWritable = false;
      }
    } else {
      activeSessionIndexedDbWritable = true;
    }

    activeSessionReady.value = true;
    await nextTick();
    await persistCurrentSession();
  } catch (error) {
    parseError.value = '恢复上次阅读失败：' +
      (error instanceof Error ? error.message : String(error));
  } finally {
    parsing.value = false;
  }
}

async function clearSavedSession() {
  let indexedDbCleared = false;
  try {
    await clearActiveDocumentSession();
    indexedDbCleared = true;
    savedSessionSummary.value = null;
  } catch (error) {
    persistenceMessage.value = '清除扩展恢复记录失败：' +
      (error instanceof Error ? error.message : String(error));
  }

  // 即使当前已切回远程翻译模式，也不能留下用户通过“清除记录”明确要求删除的 SQLite 副本。
  try {
    const config = await getConfig();
    const base = new URL(config.localAgentUrl || 'http://127.0.0.1:8789');
    base.pathname = '/api/documents/session/' + encodeURIComponent(LOCAL_DOCUMENT_SESSION_ID);
    base.search = '';
    base.hash = '';
    const response = await fetch(base.toString(), {
      method: 'DELETE',
      headers: {
        ...(config.localAgentToken ? { Authorization: 'Bearer ' + config.localAgentToken } : {}),
      },
    });
    if (!response.ok) throw new Error('本机 SQLite 返回 HTTP ' + response.status);
    localSessionSummary.value = null;
    localSessionDocumentSaved = false;
    localPersistedTranslations.clear();
    if (indexedDbCleared) persistenceMessage.value = '已清除扩展与本机 SQLite 中保存的阅读记录。';
  } catch (error) {
    // SQLite 未能删除时保留摘要，用户可以重新启动服务后再次执行删除。
    if (indexedDbCleared) {
      persistenceMessage.value = '已清除扩展恢复记录，但本机 SQLite 副本未能删除（服务未运行或连接失败）。';
    } else {
      persistenceMessage.value = '清除恢复记录失败：' +
        (error instanceof Error ? error.message : String(error));
    }
  }
}

function markEntitySuggested(entity: LiteraryEntity) {
  entity.reviewStatus = 'suggested';
}
function confirmEntity(entity: LiteraryEntity) {
  if (!entity.source.trim() || !entity.target.trim()) return;
  entity.reviewStatus = 'confirmed';
  persistenceMessage.value = '已确认规范译名：' + entity.source + ' → ' + entity.target;
}
// 剩余待确认一键确认：内容为空的跳过（confirmEntity 本来就会拒绝）。
function confirmAllEntities() {
  let count = 0;
  for (const entity of literaryMemory.value.entities) {
    if (entity.reviewStatus !== 'confirmed' && entity.source.trim() && entity.target.trim()) {
      entity.reviewStatus = 'confirmed';
      count++;
    }
  }
  persistenceMessage.value = count > 0 ? '已确认剩余规范译名 ' + count + ' 项' : '没有待确认的规范译名';
}
function setEntityAliases(entity: LiteraryEntity, event: Event) {
  const value = (event.target as HTMLInputElement | null)?.value ?? '';
  entity.aliases = Array.from(new Set(value.split(',').map((alias) => alias.trim()).filter(Boolean))).slice(0, 8);
  entity.reviewStatus = 'suggested';
}
function addEntity() {
  literaryMemory.value.entities.push({ source: '', target: '', kind: 'other', aliases: [], reviewStatus: 'suggested' });
}
function removeEntity(index: number) {
  literaryMemory.value.entities.splice(index, 1);
}
function markRelationshipSuggested(relation: LiteraryRelationship) {
  relation.reviewStatus = 'suggested';
}
function confirmRelationship(relation: LiteraryRelationship) {
  if (!relation.subject.trim() || !relation.predicate.trim() || !relation.object.trim()) return;
  relation.reviewStatus = 'confirmed';
  persistenceMessage.value = '已确认关系：' + relation.subject + ' — ' + relation.predicate + ' → ' + relation.object;
}
function confirmAllRelationships() {
  let count = 0;
  for (const relation of literaryMemory.value.relationships) {
    if (relation.reviewStatus !== 'confirmed' && relation.subject.trim() && relation.predicate.trim() && relation.object.trim()) {
      relation.reviewStatus = 'confirmed';
      count++;
    }
  }
  persistenceMessage.value = count > 0 ? '已确认剩余关系 ' + count + ' 项' : '没有待确认的关系';
}
function addRelationship() {
  literaryMemory.value.relationships.push({ subject: '', predicate: '', object: '', reviewStatus: 'suggested' });
}
function removeRelationship(index: number) {
  literaryMemory.value.relationships.splice(index, 1);
}

function pickFile() {
  fileInput.value?.click();
}

function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) loadFile(file);
}

function onDrop(event: DragEvent) {
  dragover.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
}

async function loadFile(file: File) {
  // 先落盘上一册的最新状态，再开始解析新文件。
  await persistCurrentSession();
  stopTranslation();
  documentFileName = file.name;
  activeSessionReady.value = false;
  persistedTranslations.value = new Map();
  persistenceMessage.value = '';
  resetTranslation();
  currentPageIndex.value = 0;
  activeTab.value = 'reading';
  parseError.value = '';
  localSessionDocumentSaved = false;
  localSessionDisabled = false;
  localPersistedTranslations = new Map<string, string>();
  localSessionSummary.value = null;
  doc.value = null;
  parsing.value = true;
  progress.value = { done: 0, total: 0 };
  try {
    // 文本类格式直接读字符串，二进制走 arrayBuffer，避免 PDF/zip 被 utf-8 解码破坏
    const isBinary = /\.(pdf|docx|epub)$/i.test(file.name);
    const input = isBinary
      ? { fileName: file.name, mime: file.type, arrayBuffer: await file.arrayBuffer() }
      : { fileName: file.name, mime: file.type, text: await file.text() };
    rawText = input.text ?? '';
    doc.value = await parseDocument(input, {
      onProgress: (done, total) => { progress.value = { done, total }; },
    });
    // EPUB/PDF 默认启用书籍级实体记忆和独立文风审校；用户可以在工具栏关闭。
    literaryMode.value = doc.value.format === 'epub' || doc.value.format === 'pdf';
    // 术语抽取不需要扫描整本书：限制在前 12,000 个字符，避免超长 EPUB
    // 在首次显示阅读器前把整本内容拼接、复制并交给 NLP 分析。重试继续复用这份结果。
    const glossaryLimit = 12_000;
    let glossarySample = '';
    for (const segment of doc.value.segments) {
      if (glossarySample.length >= glossaryLimit) break;
      const remaining = glossaryLimit - glossarySample.length;
      glossarySample += segment.text.slice(0, remaining) + '\n';
    }
    glossary.value = extractGlossaryLocal(glossarySample);
    const config = await getConfig();
    sourceLang.value = config.sourceLang || 'auto';
    targetLang.value = config.targetLang || 'zh';

    // 保存已解析的结构化文档一次；后续翻译过程只增量写译文与小型状态。
    // IndexedDB 配额/权限异常不会阻止正常翻译。
    try {
      await createActiveDocumentSession({
        fileName: documentFileName,
        document: doc.value,
        rawText,
        glossary: glossary.value,
        sourceLang: sourceLang.value,
        targetLang: targetLang.value,
        viewMode: viewMode.value,
        literaryMode: literaryMode.value,
        currentPageIndex: currentPageIndex.value,
      });
      activeSessionIndexedDbWritable = true;
      activeSessionReady.value = true;
      await persistCurrentSession();
      savedSessionSummary.value = await getActiveDocumentSessionSummary();
    } catch (storageError) {
      // 文件已在内存解析完成。即使 IndexedDB 无法创建，也尝试先建立 SQLite 恢复副本。
      activeSessionIndexedDbWritable = false;
      activeSessionReady.value = true;
      persistenceMessage.value = '扩展本地会话创建失败，正在尝试保存到本机 SQLite。' +
        (storageError instanceof Error ? ' ' + storageError.message : '');
      await persistCurrentSession();
      await refreshLocalSessionSummary();
    }
  } catch (err) {
    parseError.value = (err as Error).message;
  } finally {
    parsing.value = false;
  }
}

/** 所有翻译入口共用同一份设置，重试时保持 provider、术语表和服务端模式不变。 */
async function buildTranslationOptions() {
  if (!doc.value) throw new Error('尚未打开文档');
  const config = await getConfig();
  return {
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
    glossary: glossary.value,
    promptStyle: config.promptStyle,
    translationMode: config.translationMode || 'technical',
    // 文档本身始终先在本机解析。useServerTranslation 只决定规整后的片段在哪里翻译。
    useServerTranslation: config.useServerTranslation && !config.useLocalAgent,
    useLocalAgent: config.useLocalAgent,
    localAgentProvider: config.localAgentProvider,
    localAgentUrl: config.localAgentUrl,
    localAgentModel: config.localAgentModel,
    localAgentToken: config.localAgentToken,
    // Global literary profile enables entity/style memory for any structured document;
    // the EPUB/PDF checkbox remains an opt-in for users on the technical profile.
    literaryMode: config.translationMode === 'literary' ||
      (literaryMode.value && (doc.value.format === 'epub' || doc.value.format === 'pdf')),
    skipReview: !literaryReview.value,
    // 本地与 vocal-saga 服务端翻译都按批执行，先提交当前阅读页的译文。
    prioritySegmentIds: currentPage.value?.segments.map((segment) => segment.id) ?? [],
    serverUrl: config.serverUrl,
    provider: config.provider,
    apiKey: config.deepseekApiKey,
    documentFileName,
    documentTitle: doc.value.title,
    documentFormat: doc.value.format,
    documentWarnings: doc.value.meta.warnings,
    onCheckpoint: persistCurrentSession,
  };
}

async function startTranslate() {
  if (!doc.value) return;
  const options = await buildTranslationOptions();
  // 停止、网络中断或部分失败后继续执行；保留已有译文并只发送缺失片段。
  await run(doc.value.segments, options, state.value.total > 0);
}

async function retry() {
  if (!doc.value) return;
  // 重试复用同一份 provider / 文风 / glossary，并且服务端模式只重传缺失片段。
  const options = await buildTranslationOptions();
  await retryFailed(doc.value.segments, options);
}

function doExport(format: ExportFormat) {
  if (!doc.value) return;
  const content = exportDocument(doc.value, state.value.translations, format, {
    mode: viewMode.value === 'original' ? 'bilingual' : viewMode.value,
    jsonRoot: rawText,
  });
  const mime = format === 'json'
    ? 'application/json'
    : format === 'html'
      ? 'text/html'
      : 'text/plain';
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildExportFileName(doc.value, format, targetLang.value);
  a.click();
  URL.revokeObjectURL(url);
}

async function resetAll() {
  // 先等待最后一笔 checkpoint 落盘；换文件不会删除上一本书的恢复快照。
  await persistCurrentSession();
  activeSessionReady.value = false;
  localSessionDocumentSaved = false;
  localSessionDisabled = false;
  resetTranslation();
  doc.value = null;
  currentPageIndex.value = 0;
  activeTab.value = 'reading';
  literaryMode.value = false;
  parseError.value = '';
  rawText = '';
  documentFileName = 'document';
  glossary.value = undefined;
  progress.value = { done: 0, total: 0 };
  persistedTranslations.value = new Map();
  await refreshSavedSessionSummary();
}
</script>

<style scoped>
.doc-page {
  max-width: 52rem;
  margin: 0 auto;
  padding: 1.5rem 1.25rem 4rem;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #1f2328;
}
.doc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}
.doc-header h1 { font-size: 1.25rem; margin: 0; }

.tabs {
  display: flex;
  gap: .5rem;
  margin-bottom: .75rem;
}
.tab {
  border: 1px solid #d0d7de;
  background: #f6f8fa;
  border-radius: 999px;
  padding: .4rem 1rem;
  cursor: pointer;
  font-size: .85rem;
  color: #57606a;
}
.tab.active {
  background: #0969da;
  border-color: #0969da;
  color: #fff;
}
.tab-badge {
  font-size: .72rem;
  opacity: .85;
  margin-left: .35rem;
}
.translating-hint { display: block; margin-top: .2rem; }
.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  flex-wrap: wrap;
}
.action-title {
  display: flex;
  flex-direction: column;
  gap: .2rem;
  min-width: 10rem;
  flex: 1;
}
.action-title strong {
  font-size: .95rem;
  overflow-wrap: anywhere;
}
.action-controls {
  display: flex;
  align-items: flex-end;
  gap: .5rem;
  flex-wrap: wrap;
}
.field.inline { flex-direction: row; align-items: center; }
.field.inline select { padding: .35rem .5rem; }
.link-btn {
  border: none;
  background: none;
  color: #0969da;
  cursor: pointer;
  font-size: .78rem;
  padding: 0;
  text-decoration: underline;
}
.tr-idle { color: #8b949e; font-size: .8rem; }

.saved-session {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  border-color: #c9d8ea;
}
.saved-session-copy {
  display: flex;
  flex-direction: column;
  gap: .3rem;
  min-width: 12rem;
  flex: 1;
}
.saved-session-copy strong { font-size: .95rem; }
.saved-session-copy > span:nth-child(2) { overflow-wrap: anywhere; }
.saved-session-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.persistence-notice {
  background: #f6f8fa;
  color: #57606a;
  font-size: .8rem;
  overflow-wrap: anywhere;
}

.dropzone {
  border: 2px dashed #d0d7de;
  border-radius: 12px;
  padding: 3rem 1rem;
  text-align: center;
  background: #fafbfc;
}
.dropzone.dragover { border-color: #0969da; background: #eaf3ff; }
.dz-title { margin: 0 0 .75rem; color: #57606a; }
.dz-hint { margin: .75rem 0 0; font-size: .8rem; color: #8b949e; }
.hidden-input { display: none; }

.panel {
  border: 1px solid #d0d7de;
  border-radius: 10px;
  padding: .75rem .875rem;
  margin-bottom: .75rem;
  background: #fff;
}
.meta-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.doc-title { font-size: 1rem; }
.chip {
  font-size: .75rem; color: #57606a; background: #f0f3f6;
  border-radius: 999px; padding: .1rem .55rem;
}
.warn { margin: .4rem 0 0; font-size: .8rem; color: #9a6700; }
.error-box { border-color: #f0c1c1; background: #fff5f5; color: #a40e26; }

.controls { display: flex; align-items: flex-end; gap: .75rem; flex-wrap: wrap; }
.controls .grow { flex: 1; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .8rem; color: #57606a; }
.field select { padding: .35rem .5rem; border: 1px solid #d0d7de; border-radius: 6px; }

.btn {
  border: 1px solid #d0d7de; background: #fff; border-radius: 6px;
  padding: .4rem .85rem; cursor: pointer; font-size: .85rem; color: #1f2328;
}
.btn:hover { background: #f3f4f6; }
.btn.primary { background: #0969da; border-color: #0969da; color: #fff; }
.btn.primary:hover { background: #0860ca; }
.btn.ghost { background: transparent; }
.btn.warn { border-color: #d4a72c; color: #7d4e00; }

.progress-panel { display: flex; align-items: center; gap: .75rem; }
.progress { flex: 1; height: 6px; background: #eaeef2; border-radius: 999px; overflow: hidden; }
.bar { height: 100%; background: #0969da; transition: width .2s ease; }
.muted { color: #57606a; }
.small { font-size: .78rem; }
.err-text { color: #a40e26; }

.literary-toggle-control {
  display: flex;
  align-items: center;
  gap: .4rem;
  color: #1f2328;
  white-space: nowrap;
}
.literary-toggle-control input { accent-color: #6b4e9b; }
.literary-status-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .5rem;
}
.literary-status-title strong { font-size: .9rem; }
.literary-status .warn { overflow-wrap: anywhere; }

.reader-navigation {
  position: sticky;
  top: .5rem;
  z-index: 5;
  background: rgba(255, 255, 255, .97);
  backdrop-filter: blur(10px);
}
.reader-navigation-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.reader-location {
  display: flex;
  flex-direction: column;
  gap: .3rem;
  min-width: 10rem;
  flex: 1;
}
.reader-location strong {
  font-size: .98rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.reader-navigation-controls {
  display: flex;
  align-items: center;
  gap: .45rem;
}
.page-select {
  max-width: min(42vw, 21rem);
  min-width: 8rem;
  padding: .4rem .5rem;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #fff;
  color: #1f2328;
}
.reader-progress {
  margin-top: .75rem;
  height: 3px;
  background: #eaeef2;
  border-radius: 999px;
  overflow: hidden;
}
.reader-progress-bar {
  height: 100%;
  background: #0969da;
  transition: width .2s ease;
}
.reader {
  max-width: 56rem;
  min-height: 55vh;
  margin: 1rem auto;
  padding: clamp(1.1rem, 4vw, 3rem);
  background: #fff;
  border: 1px solid #e6e9ed;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(31, 35, 40, .035);
}
.seg {
  padding: .8rem .25rem;
  border-bottom: 1px solid #f0f2f4;
  content-visibility: auto;
  contain-intrinsic-size: auto 5rem;
  /* 正文基准字号：PDF 解析出的段落默认偏小，0.98rem 太小、1.06rem 接近书页阅读密度。 */
  font-size: 1.06rem;
  line-height: 1.75;
}
/* 正在翻译的段：左侧色条 + 淡底，让当前焦点可见；排队的段保持无占位。 */
.seg.is-active {
  border-left: 2px solid #0969da;
  background: linear-gradient(90deg, rgba(9, 105, 218, .045), transparent 40%);
  padding-left: .85rem;
}
.seg .or { color: #1f2328; white-space: pre-wrap; }
.seg .tr { color: #0a5fb4; white-space: pre-wrap; margin-top: .2em; }
.tr-pending { color: #b0b8c0; font-size: .92rem; }
.seg.kind-heading .or, .seg.kind-heading .tr { font-weight: 650; }
.seg.kind-heading { border-bottom: 0; padding-top: 1.35rem; }
.seg.kind-heading.level-1 { font-size: 1.7rem; line-height: 1.45; }
.seg.kind-heading.level-2 { font-size: 1.4rem; line-height: 1.55; }
.seg.kind-quote { border-left: 3px solid #d0d7de; padding-left: .75rem; color: #57606a; }
.seg.kind-quote.is-active { border-left-color: #0969da; }
.seg.kind-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .96rem; background: #f6f8fa; }
.timecode { font-size: .78rem; color: #8b949e; }

.export { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }

.literary-dictionary details + details { margin-top: .65rem; }
.literary-dictionary summary { cursor: pointer; padding: .35rem 0; }
.literary-editor-list { display: grid; gap: .55rem; margin-top: .6rem; }
.literary-editor-row {
  display: grid;
  grid-template-columns: minmax(7rem, 1fr) minmax(7rem, 1fr) minmax(7rem, 1fr) auto auto auto;
  align-items: end;
  gap: .45rem;
  padding: .6rem 0;
  border-bottom: 1px solid #eaeef2;
}
.literary-editor-row label { display: flex; flex-direction: column; gap: .2rem; min-width: 0; font-size: .75rem; color: #57606a; }
.literary-editor-row input { min-width: 0; width: 100%; box-sizing: border-box; padding: .4rem .45rem; border: 1px solid #d0d7de; border-radius: 6px; color: #1f2328; }
.literary-review-finding { margin-top: .65rem; padding-top: .65rem; border-top: 1px solid #eaeef2; overflow-wrap: anywhere; }
.literary-review-finding p { margin: .35rem 0 0; line-height: 1.5; }
.literary-review-finding .chip { margin-right: .4rem; }

@media (max-width: 640px) {
  .doc-page { padding: 1rem .75rem 3rem; }
  .reader-navigation { position: static; }
  .reader-navigation-controls { width: 100%; justify-content: space-between; }
  .page-select { flex: 1; max-width: none; }
  .reader { min-height: 50vh; padding: 1rem; border-radius: 8px; }
  .literary-editor-row { grid-template-columns: 1fr 1fr; }
  .literary-editor-row .chip { align-self: center; }
}
</style>
