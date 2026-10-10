<template>
  <div class="doc-page" :class="{ 'is-empty': !doc }">
    <header class="doc-header">
      <h1>文档翻译</h1>
      <div class="header-actions">
        <button v-if="doc" class="btn ghost" @click="resetAll">换一个文件</button>
      </div>
    </header>

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
      <p class="muted">正在解析{{ progress.total > 1 ? `（${progress.done}/${progress.total} 页）` : '…' }}</p>
      <div v-if="progress.total > 1" class="progress"><div class="bar"
        :style="{ width: (progress.done / progress.total) * 100 + '%' }"></div></div>
    </section>

    <!-- 3. 解析错误 -->
    <section v-if="parseError" class="panel error-box">
      <p>{{ parseError }}</p>
      <button class="btn" @click="resetAll">重新选择</button>
    </section>

    <!-- 4. 已解析：控制条 + 正文 -->
    <template v-if="doc">
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

        <div class="grow"></div>

        <button v-if="!state.running && state.done === 0" class="btn primary" @click="startTranslate">
          开始翻译
        </button>
        <button v-if="state.running" class="btn" @click="stopTranslation">停止</button>
        <button v-if="state.failedBatches.length" class="btn warn" @click="retry">
          重试失败批次（{{ state.failedBatches.length }}）
        </button>
      </section>

      <section v-if="state.total > 0" class="panel progress-panel">
        <div class="progress"><div class="bar"
          :style="{ width: (state.done / state.total) * 100 + '%' }"></div></div>
        <span class="muted small">
          {{ state.done }}/{{ state.total }} 批
          <template v-if="state.error"> · <span class="err-text">{{ state.error }}</span></template>
        </span>
      </section>

      <!-- 正文 -->
      <article class="reader">
        <div v-for="seg in doc.segments" :key="seg.id" class="seg"
          :class="['kind-' + seg.kind, 'level-' + (seg.level ?? 0)]">
          <div v-if="viewMode !== 'translation'" class="or">{{ seg.text }}</div>
          <div v-if="viewMode !== 'original'" class="tr">
            <template v-if="state.translations.get(seg.id)">{{ state.translations.get(seg.id) }}</template>
            <span v-else-if="state.running || state.done > 0" class="tr-pending">翻译中…</span>
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
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
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
import { useDocumentTranslation } from './useDocumentTranslation';

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
/** 原始文本，json 导出回填时用。 */
let rawText = '';
/**
 * 文档术语表（解析后从正文抽出，专有名词不被翻错）。
 * 必须在 startTranslate / retry 之间复用同一份，否则重试批次与初次翻译的 cacheKey
 * 会不一致（P0：cacheKey 含 glossary hash），导致命中不到初次翻译的缓存，浪费 LLM。
 */
const glossary = ref<Glossary | undefined>(undefined);

const { state, run, retryFailed, stop: stopTranslation } = useDocumentTranslation();

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
  parseError.value = '';
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
    // 一次性抽出术语表，startTranslate / retry 必须复用同一份（见 glossary ref 注释）
    const fullText = doc.value.segments.map((s) => s.text).join('\n');
    glossary.value = extractGlossaryLocal(fullText);
    const config = await getConfig();
    sourceLang.value = config.sourceLang || 'auto';
    targetLang.value = config.targetLang || 'zh';
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
    // 文档本身始终先在本机解析。useServerTranslation 只决定规整后的片段在哪里翻译。
    useServerTranslation: config.useServerTranslation,
    serverUrl: config.serverUrl,
    provider: config.provider,
    apiKey: config.deepseekApiKey,
    documentFileName: doc.value.title + '.' + doc.value.format,
    documentTitle: doc.value.title,
    documentFormat: doc.value.format,
    documentWarnings: doc.value.meta.warnings,
  };
}

async function startTranslate() {
  if (!doc.value) return;
  const options = await buildTranslationOptions();
  await run(doc.value.segments, options);
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

function resetAll() {
  doc.value = null;
  parseError.value = '';
  rawText = '';
  glossary.value = undefined;
  progress.value = { done: 0, total: 0 };
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

.reader { margin: 1rem 0; }
.seg {
  padding: .5rem .25rem;
  border-bottom: 1px solid #f0f2f4;
  content-visibility: auto;
  contain-intrinsic-size: auto 4rem;
  line-height: 1.75;
}
.seg .or { color: #1f2328; white-space: pre-wrap; }
.seg .tr { color: #0a5fb4; white-space: pre-wrap; margin-top: .15em; }
.tr-pending { color: #b0b8c0; font-size: .8rem; }
.seg.kind-heading .or, .seg.kind-heading .tr { font-weight: 600; }
.seg.kind-heading.level-1 { font-size: 1.3rem; }
.seg.kind-heading.level-2 { font-size: 1.15rem; }
.seg.kind-quote { border-left: 3px solid #d0d7de; padding-left: .75rem; color: #57606a; }
.seg.kind-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; background: #f6f8fa; }
.timecode { font-size: .72rem; color: #8b949e; }

.export { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
</style>
