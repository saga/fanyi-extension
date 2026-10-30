<template>
  <div class="doc-page" :class="{ 'is-empty': !doc }" :style="documentStyleVars">
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
        <span class="muted small">上次保存：{{ formatAgentDateTime(savedSessionSummary?.updatedAt ?? localSessionSummary?.updatedAt ?? Date.now()) }}</span>
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
        支持 TXT / Markdown / HTML / SRT / VTT / JSON / PDF / DOCX / EPUB。启用本机 Agent 时，EPUB/PDF 由本机解析（默认原文件上限 512 MiB）；其他模式仍受扩展本地解析上限约束。
      </p>
      <input ref="fileInput" type="file" class="hidden-input" :accept="DOCUMENT_ACCEPT_ATTR"
        @change="onFilePicked" />
    </section>

    <!-- 选择文件前也可先配置源/目标语言、翻译类型、文风与运行服务。 -->
    <DocumentTranslationSettings
      v-if="!doc && !parsing"
      :active-source-lang="doc ? sourceLang : undefined"
      :active-target-lang="doc ? targetLang : undefined"
      @updated="onTranslationSettingsUpdated"
    />

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
        <button class="tab" :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">
          设置
        </button>
        <button class="tab" :class="{ active: activeTab === 'prompt' }" @click="activeTab = 'prompt'">
          提示词
        </button>
        <button class="tab" :class="{ active: activeTab === 'characters' }" @click="activeTab = 'characters'">
          人物与预处理
          <span v-if="literaryMode" class="tab-badge">{{ managedPeople.length }}人物·{{ nonPersonEntities.length }}实体</span>
        </button>
        <button v-if="doc.format === 'epub' || doc.format === 'pdf'" class="tab" :class="{ active: activeTab === 'agent' }" @click="activeTab = 'agent'">
          翻译 Agent
        </button>
        <button v-if="doc.format === 'epub' || doc.format === 'pdf'" class="tab" :class="{ active: activeTab === 'trajectory' }" @click="activeTab = 'trajectory'">
          Agent 轨迹
          <span v-if="agentTrajectoryActiveTasks.length" class="tab-badge">{{ agentTrajectoryActiveTasks.length }} 运行中</span>
          <span v-else-if="agentTrajectoryEvents.length" class="tab-badge">{{ agentTrajectoryEvents.length }} 事件</span>
        </button>
      </nav>

      <!-- 阅读区只保留操作条、章节导航和正文；配置与人物/预处理分别放在独立 Tab。 -->
      <template v-if="activeTab === 'reading'">
      <section
        v-if="translationPreprocessingNeedsAttention"
        class="panel preprocessing-gate-banner"
        :class="'preprocessing-gate-' + translationPreprocessingReadiness.reason"
        role="status"
        aria-live="polite"
      >
        <div class="preprocessing-gate-copy">
          <strong>{{ preprocessingGateTitle(translationPreprocessingReadiness.reason) }}</strong>
          <p>点击开始文学翻译后，local-agent-service 会核对原文版本、分析版本和语言，并在服务端自动启动或等待预处理。全书分析、原文证据和章节摘要不会复制进扩展的 LiteraryMemory。</p>
          <p v-if="contextGraphState.runId" class="preprocessing-gate-meta">
            预处理任务 {{ contextGraphState.runId }}
            <span v-if="contextGraphPhaseLabel"> · {{ contextGraphPhaseLabel }}</span>
            <span v-if="preprocessingElapsedLabel"> · {{ preprocessingElapsedLabel }}</span>
          </p>
          <div v-if="translationPreprocessingReadiness.reason === 'queued' || translationPreprocessingReadiness.reason === 'running'" class="preprocessing-gate-progress" role="progressbar" :aria-valuenow="contextGraphProgressPercent" aria-valuemin="0" aria-valuemax="100">
            <div :style="{ width: contextGraphProgressPercent + '%' }"></div>
          </div>
        </div>
        <button class="btn" type="button" @click="openPreprocessingAndEnsure">查看预处理状态</button>
      </section>
      <section class="panel action-bar">
        <div class="action-title">
          <strong>{{ doc.title }}</strong>
          <span class="muted small">
            本页 {{ currentPageTranslatedCount }}/{{ visibleSegments.length }} 段
            · 全书 {{ translatedSegmentCount }}/{{ doc.meta.segmentCount }} 段
            <template v-if="state.running && state.workChapter"> · 正在翻译「{{ state.workChapter }}」{{ state.workTotal > 0 ? `${state.workDone}/${state.workTotal} ${workspaceTranslationActive ? '段' : '批'}` : '' }}{{ state.workStage ? ` · ${state.workStage}` : '' }}</template>
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
          <label v-if="literaryMode" class="field inline" title="关闭后每批减少一次审校调用；译文为初译水平，实际耗时取决于模型与文档">
            <span>审校</span>
            <input v-model="literaryReview" type="checkbox" />
          </label>
          <button
            v-if="!state.running"
            class="btn primary"
            :disabled="!hasPendingDocument"
            @click="startTranslate">
            {{ startLabel }}
          </button>
          <button v-if="!state.running && visibleSegments.length" class="btn warn"  @click="forceTranslateCurrentPage">
            强制重译当前页
          </button>
          <button v-if="state.running" class="btn" @click="stopCurrentTranslation">停止</button>
          <button v-if="state.failedBatches.length" class="btn warn"  @click="retry">
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
          <div v-if="viewMode !== 'translation'" class="or"
            :class="[languageFontClass(sourceLang, seg.text), { 'is-translated': !!state.translations.get(seg.id)?.trim() }]">{{ seg.text }}</div>
          <div v-if="viewMode !== 'original'" class="tr"
            :class="[languageFontClass(targetLang, displayTranslation(seg.id)), { 'is-workspace-candidate': workspaceCandidateTranslations.has(seg.id) }]">
            <span v-if="workspaceCandidateTranslations.has(seg.id)" class="workspace-candidate-label">Agent 候选 · 尚未采纳</span>
            <template v-if="displayTranslation(seg.id)">{{ displayTranslation(seg.id) }}</template>
            <span v-else-if="state.running && state.activeSegmentIds?.has(seg.id)" class="tr-pending">翻译中…</span>
            <span v-else-if="!state.running && state.total > 0" class="tr-idle">待翻译 — 点击上方「{{ startLabel }}」</span>
          </div>
          <div v-if="seg.kind === 'caption' && (seg.start || seg.end)" class="timecode">
            {{ seg.start }} → {{ seg.end }}
          </div>
        </div>
      </article>

      <!-- 阅读时常驻的小型翻译控制器，避免用户滚回页面顶部操作。 -->
      <div v-if="activeTab === 'reading'" class="reader-quick-actions" role="group" aria-label="快速翻译控制">
        <button class="quick-action" :disabled="state.running || !hasPendingPageAhead" @click="translatePages(1)">翻译下一页</button>
        <button class="quick-action" :disabled="state.running || !hasPendingPageAhead" @click="translatePages(3)">翻译下三页</button>
        <button class="quick-action quick-action-stop" :disabled="!state.running" @click="stopCurrentTranslation">停止翻译</button>
      </div>

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

      <template v-else-if="activeTab === 'settings'">
      <DocumentTranslationSettings
        :active-source-lang="sourceLang"
        :active-target-lang="targetLang"
        @updated="onTranslationSettingsUpdated"
      />
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
          <span>显示</span>
          <select v-model="viewMode">
            <option value="bilingual">双语对照</option>
            <option value="translation">仅译文</option>
            <option value="original">仅原文</option>
          </select>
        </label>
        <label v-if="doc.format === 'epub' || doc.format === 'pdf'" class="field literary-toggle">
          <span>整本书记忆（覆盖翻译类型）</span>
          <span class="literary-toggle-control">
            <input v-model="literaryMode" type="checkbox" :disabled="state.running" />
            实体一致性与文风审校
          </span>
          <small class="muted">启用后使用文学翻译流程，并跨章节维护实体与文风记忆；关闭后按上面的翻译类型执行。</small>
        </label>
      </section>

      <section class="panel reader-appearance-settings">
        <div class="settings-heading">
          <div>
            <h3>阅读排版</h3>
            <p class="muted small">英文原文和中文译文的字体、字号分别设置，立即影响阅读显示，不会修改译文内容。</p>
          </div>
        </div>
        <div class="reader-font-grid">
          <label class="field">
            <span>英文字体</span>
            <select v-model="englishFontFamily">
              <option value="Georgia">Georgia（衬线）</option>
              <option value="Times New Roman">Times New Roman</option>
              <option value="Arial">Arial（无衬线）</option>
              <option value="Verdana">Verdana</option>
              <option value="system-ui">系统默认</option>
              <option value="serif">系统衬线</option>
            </select>
          </label>
          <label class="field">
            <span>英文原文字号</span>
            <select v-model.number="englishFontSize">
              <option v-for="size in [14, 15, 16, 17, 18, 20, 22, 24, 26, 28]" :key="'en-size-' + size" :value="size">{{ size }} px</option>
            </select>
          </label>
          <label class="field">
            <span>中文字体</span>
            <select v-model="chineseFontFamily">
              <option value="Noto Serif CJK SC">Noto Serif CJK SC（衬线）</option>
              <option value="PingFang SC">苹方</option>
              <option value="Microsoft YaHei">微软雅黑</option>
              <option value="SimSun">宋体</option>
              <option value="system-ui">系统默认</option>
              <option value="serif">系统衬线</option>
              <option value="sans-serif">系统无衬线</option>
            </select>
          </label>
          <label class="field">
            <span>中文译文字号</span>
            <select v-model.number="chineseFontSize">
              <option v-for="size in [14, 15, 16, 17, 18, 20, 22, 24, 26, 28]" :key="'zh-size-' + size" :value="size">{{ size }} px</option>
            </select>
          </label>
        </div>
        <div class="settings-actions">
          <button class="btn primary" @click="saveDocumentTypography">保存阅读排版</button>
          <span class="muted small">字号可随时调节；阅读位置与译文不会受影响。</span>
        </div>
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

      </template>

      <template v-else-if="activeTab === 'prompt'">
      <section class="panel prompt-editor-panel">
        <div class="settings-heading">
          <div>
            <h3>文档翻译 Prompt</h3>
            <p class="muted small">这里显示当前文档使用的 System Prompt 和 User Prompt 模板。保存后仅影响后续请求；已有译文不会自动重写。强制重译当前页可绕过旧译文缓存。</p>
          </div>
        </div>
        <label class="prompt-editor-label">
          <span><strong>System Prompt</strong> · 系统指令</span>
          <textarea v-model="documentSystemPromptEditor" rows="12" spellcheck="false"
            aria-label="文档 System Prompt"></textarea>
          <small class="muted">默认显示当前翻译类型与文风对应的内置系统指令。修改后会覆盖内置指令，包括其中的输出格式要求；请保留准确性、ID 和 JSON 结构约束。</small>
        </label>
        <details class="built-in-prompt-preview">
          <summary>查看当前内置 System Prompt（用于对照/恢复）</summary>
          <pre>{{ builtInDocumentSystemPrompt }}</pre>
        </details>
        <label class="prompt-editor-label">
          <span><strong>User Prompt</strong> · 用户消息模板</span>
          <textarea v-model="documentUserPromptEditor" rows="7" spellcheck="false"
            aria-label="文档 User Prompt 模板"></textarea>
          <small class="muted">在模板中使用双大括号包住 CONTENT 作为本批内容占位符。内容是包含片段 ID、原文和结构元数据的 JSON；不要删除占位符，否则系统会自动在末尾追加 JSON。</small>
        </label>
        <details class="built-in-prompt-preview">
          <summary>查看完整模板会怎样替换本批内容</summary>
          <p class="muted small">预览展示占位符替换后的效果；实际发送时只注入本批片段，不会把整本书塞进单条请求。</p>
          <pre>{{ userPromptPreview }}</pre>
        </details>
        <div class="settings-actions">
          <button class="btn primary" @click="saveDocumentPromptSettings">保存 Prompt</button>
          <button class="btn" @click="restoreBuiltInDocumentPrompts">恢复内置 Prompt</button>
          <span class="muted small">Prompt 会保存在扩展配置中，重启后仍可恢复。</span>
        </div>
      </section>
      <p class="muted small">准确性/术语、人物声音/文风、章节文学分析、全书预处理等任务的内置 Prompt 与覆盖项，见“设置”Tab 的“按任务配置 CodeBuddy 思考、推理强度与 Prompt”。</p>
      </template>
      <template v-else-if="activeTab === 'characters'">
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

      <section v-if="literaryMode" class="panel context-graph-status">
        <div class="context-graph-toolbar">
          <strong>全书预处理与规范译名</strong>
          <div class="context-graph-actions">
            <button class="btn" type="button" :disabled="readerConfig?.documentUseLocalAgent !== true || contextGraphState.loading" @click="refreshContextGraphStatus()">
              {{ contextGraphState.loading ? '刷新中…' : '刷新预处理状态' }}
            </button>
            <button class="btn primary" type="button"
              :disabled="readerConfig?.documentUseLocalAgent !== true || contextGraphBusy"
              @click="reanalyzeContextGraph">
              {{ contextGraphBusy ? '正在分析全书…' : '重新分析全书' }}
            </button>
            <button class="btn" type="button"
              v-if="workspaceActiveRun && ['queued','running','paused','awaiting_acceptance','partial'].includes(workspaceActiveRun.status)"
              :disabled="contextGraphBusy"
              @click="cancelTranslationRunAndReanalyzeContextGraph">
              {{ contextGraphBusy ? '正在分析全书…' : '取消运行并重新分析全书' }}
            </button>
          </div>
        </div>
        <div class="literary-status-title">
          <span class="chip" :class="'diagnostic-' + contextGraphState.status">{{ contextGraphStatusLabel }}</span>
          <span v-if="readerConfig?.documentUseLocalAgent !== true" class="chip">需要启用本机 Agent</span>
          <span class="chip">当前原文 {{ contextGraphState.segmentCount.toLocaleString() }} 段</span>
          <span class="chip">章节 {{ contextGraphState.counts.chapters }}</span>
          <span class="chip">人物 {{ contextGraphState.counts.characters }}</span>
          <span class="chip">人物画像 {{ literaryMemory.characterVoices.length }}</span>
          <span class="chip">其他实体 {{ contextGraphState.counts.entities }}</span>
          <span class="chip">关系 {{ contextGraphState.counts.relationships }}</span>
        </div>
        <p>{{ contextGraphPhaseLabel }}<template v-if="contextGraphState.runId"> · Run {{ contextGraphState.runId.slice(0, 8) }}</template><template v-if="preprocessingElapsedLabel"> · {{ preprocessingElapsedLabel }}</template></p>
        <p v-if="readerConfig?.documentUseLocalAgent !== true" class="muted small">
          全书实体预处理需要使用本机 Agent。启用后，已有小说也会自动检查并补做分析；不会删除已有译文。
        </p>
        <div v-if="contextGraphState.status === 'running' || contextGraphState.status === 'queued'" class="progress context-graph-progress">
          <div class="bar" :style="{ width: contextGraphProgressPercent + '%' }"></div>
        </div>
        <p class="muted small" v-if="contextGraphState.progress && Object.keys(contextGraphState.progress).length">
          分析语言 {{ contextGraphState.progress.sourceLang || 'auto' }} → {{ contextGraphState.progress.targetLang || targetLang }}；
          已扫描 {{ contextGraphState.progress.scan?.segmentCount ?? contextGraphState.segmentCount }} 段、
          {{ contextGraphState.progress.scan?.chapterCount ?? contextGraphState.progress.chapterCount ?? contextGraphState.counts.chapters }} 章；
          扫描到 {{ contextGraphState.progress.scan?.nameCandidateCount ?? 0 }} 个名称候选；
          本轮抽样 {{ contextGraphState.progress.sampleCount ?? contextGraphState.progress.scan?.samplePlan?.length ?? 0 }} 段。
          <template v-if="contextGraphState.progress.strategy">策略 {{ contextGraphState.progress.strategy }}。</template>
          <template v-if="contextGraphState.progress.strategy === 'B'">已保存步骤 {{ contextGraphState.progress.completedStages?.length ?? 0 }}/5。</template>
          <template v-if="contextGraphState.progress.workflowElapsedMs != null">模型分析耗时 {{ (contextGraphState.progress.workflowElapsedMs / 1000).toFixed(1) }} 秒。</template>
          已核验人物 {{ contextGraphState.progress.characterCount ?? contextGraphState.counts.characters }} 个、
          其他实体 {{ contextGraphState.progress.entityCount ?? contextGraphState.counts.entities }} 个；
          有规范译名 {{ contextGraphState.progress.canonicalNameMappingCount ?? 0 }} 个。
          <template v-if="contextGraphState.progress.invalidEvidenceCount != null">拒绝无效证据 {{ contextGraphState.progress.invalidEvidenceCount }} 条。</template>
        </p>
        <p class="muted small" v-if="contextGraphState.sourceRevisionId">
          来源版本：{{ contextGraphState.sourceRevisionId.slice(0, 12) }}
          <template v-if="contextGraphState.startedAt"> · 开始 {{ formatAgentDateTime(contextGraphState.startedAt) }}</template>
          <template v-if="contextGraphState.finishedAt"> · 结束 {{ formatAgentDateTime(contextGraphState.finishedAt) }}</template>
          <template v-if="contextGraphState.checkedAt"> · 最近检查 {{ formatAgentTime(contextGraphState.checkedAt) }}</template>
        </p>
        <p class="warn" v-if="contextGraphState.error">{{ contextGraphState.error }}</p>
        <p class="warn" v-else-if="contextGraphState.status === 'completed' && translationPreprocessingReadiness.reason === 'version'">
          这条记录由旧版预处理产出（{{ contextGraphState.analysisVersion || '未知版本' }}），当前服务端版本是 {{ contextGraphState.currentAnalysisVersion }}。翻译 Run 会自动按当前版本重新分析；也可以点击“重新分析全书”。已有译文不会被改写。
        </p>
        <p class="warn" v-else-if="contextGraphState.status === 'completed' && contextGraphState.counts.characters + contextGraphState.counts.entities === 0">
          预处理已结束，但没有保存任何有原文证据的人物或实体。请检查本轮模型响应、抽样内容与证据校验计数；可重新分析。
        </p>
        <p class="muted small" v-else-if="contextGraphState.status === 'not-started'">
          这本书尚无当前原文版本的预处理记录。开启后会先扫描全书，再进行有原文证据的人物、专名、关系和章节分析；不会自动覆盖已确认译名。
        </p>
        <p class="muted small">图谱会约束后续翻译与审校；已有译文不会自动改写。确认规范译名后，可点击“强制重译当前页”修复旧译文中的专名漂移。</p>
      </section>

      <section v-if="literaryMode" class="panel literary-style-guide">
        <div class="dictionary-heading">
          <div>
            <h3>全书文风基准</h3>
            <p class="muted small">当前预处理版本的文风基准会直接进入初译和两类 Reviewer，不需要确认。改动任一字段后立即生效；整块可以停用。文风只约束语气、句法和用词，不用来推断剧情。</p>
          </div>
          <span class="entity-status" :class="styleGuideBadge.tone === 'active' ? 'is-confirmed' : 'is-pending'">
            {{ styleGuideBadge.label }}
          </span>
        </div>
        <div class="settings-actions">
          <button class="btn" type="button"
            :disabled="!contextGraphState.styleGuideReady"
            @click="importContextGraphStyleGuide">用预处理结果重置字段</button>
          <button v-if="contextGraphState.styleGuideReady" class="btn" type="button"
            @click="setStyleGuideAutoDisabled(!literaryMemory.styleGuideAutoDisabled)">
            {{ literaryMemory.styleGuideAutoDisabled ? '恢复机器文风基准' : '停用机器文风基准' }}
          </button>
        </div>
        <div class="literary-style-grid">
          <label class="field">
            <span>叙述声音</span>
            <textarea v-model="literaryMemory.styleGuide.narrativeVoice" rows="3" @change="markStyleGuideCandidate"></textarea>
          </label>
          <label class="field">
            <span>语域</span>
            <textarea v-model="literaryMemory.styleGuide.register" rows="2" @change="markStyleGuideCandidate"></textarea>
          </label>
          <label class="field">
            <span>节奏与句法</span>
            <textarea v-model="literaryMemory.styleGuide.rhythm" rows="2" @change="markStyleGuideCandidate"></textarea>
          </label>
          <label class="field">
            <span>对白特征</span>
            <textarea v-model="literaryMemory.styleGuide.dialogue" rows="2" @change="markStyleGuideCandidate"></textarea>
          </label>
          <label class="field">
            <span>措辞与词汇</span>
            <textarea v-model="literaryMemory.styleGuide.diction" rows="2" @change="markStyleGuideCandidate"></textarea>
          </label>
          <label class="field">
            <span>规则（每行一条）</span>
            <textarea :value="(literaryMemory.styleGuide.rules || []).join('\n')" rows="4"
              @change="setStyleGuideLines('rules', $event)"></textarea>
          </label>
          <label class="field">
            <span>避免的风格问题（每行一条）</span>
            <textarea :value="(literaryMemory.styleGuide.avoid || []).join('\n')" rows="3"
              @change="setStyleGuideLines('avoid', $event)"></textarea>
          </label>
        </div>
        <p class="muted small">这里只放风格约束，不要写人物身份、秘密或剧情结论。</p>
      </section>

      <details v-if="literaryStatus.enabled" class="panel literary-diagnostics">
        <summary>翻译诊断轨迹（{{ literaryStatus.diagnostics.length }}）</summary>
        <p class="muted small">用于定位分析、上下文注入、翻译请求和审校阶段。只记录状态、配置与计数，不保存完整原文或译文。</p>
        <button class="btn ghost" type="button" :disabled="!literaryStatus.diagnostics.length" @click="exportLiteraryDiagnostics">
          导出诊断 JSON
        </button>
        <div v-if="!literaryStatus.diagnostics.length" class="review-empty">
          尚无诊断事件。开始翻译后，这里会记录各阶段是否真正执行及其结果。
        </div>
        <article
          v-for="entry in [...literaryStatus.diagnostics].slice(-40).reverse()"
          :key="entry.id"
          class="literary-diagnostic-row"
        >
          <div class="literary-diagnostic-heading">
            <span class="chip">{{ entry.stage }}</span>
            <span class="chip" :class="'diagnostic-' + entry.status">{{ entry.status }}</span>
            <time class="muted small">{{ formatAgentTime(entry.at) }}</time>
          </div>
          <p>{{ entry.message }}</p>
          <p v-if="entry.details" class="muted small literary-diagnostic-details">{{ entry.details }}</p>
        </article>
      </details>

      <!-- 非人物实体仍使用独立译名表；人物名称、译名、角色和声音统一在下方人物管理中维护。 -->
      <section v-if="literaryMode" class="panel literary-dictionary">
        <div class="dictionary-heading">
          <div>
            <h3>实体译名表</h3>
            <p class="muted small">这里只管理地点、组织、物品、概念等非人物实体。人物的规范名、译名、别名和角色/声音信息统一在下方「人物管理」中编辑。其他实体有原文依据且译名明确时会自动纳入规范。</p>
          </div>
          <span class="chip">规范候选 {{ nonPersonEntities.length }} 项</span><span v-if="suppressedEntityCount" class="chip">已折叠 {{ suppressedEntityCount }} 项</span>
        </div>

        <div class="dictionary-toolbar">
          <input v-model.trim="entitySearch" type="search" class="entity-search"
            placeholder="搜索原文名、译名或别名…" aria-label="搜索实体译名" />
          <div class="entity-filters" aria-label="筛选实体状态">
            <button class="filter-chip" :class="{ active: entityFilter === 'all' }" @click="entityFilter = 'all'">
              全部 {{ nonPersonEntities.length }}
            </button>
            <button class="filter-chip" :class="{ active: entityFilter === 'pending' }" @click="entityFilter = 'pending'">
              待核对 {{ pendingEntityCount }}
            </button>
            <button class="filter-chip" :class="{ active: entityFilter === 'confirmed' }" @click="entityFilter = 'confirmed'">
              已纳入规范 {{ confirmedEntityCount }}
            </button>
          </div>
          <div class="dictionary-actions">
            <button v-if="suppressedEntityCount" class="btn" type="button" @click="toggleSuppressedEntities">
              {{ showSuppressedEntities ? '隐藏低价值/异常项' : '展开低价值/异常项' }}（{{ suppressedEntityCount }}）
            </button>
            <button class="btn primary" @click="addEntity">添加实体映射</button>
          </div>
        </div>

        <div v-if="filteredLiteraryEntities.length" class="entity-card-list">
          <article v-for="{ entity, index } in filteredLiteraryEntities"
            :key="'entity-' + index + '-' + entity.source" class="entity-card" :class="{ 'is-pending-card': entity.reviewStatus !== 'confirmed' }">
            <div class="entity-card-header">
              <span class="entity-status" :class="entity.reviewStatus === 'confirmed' ? 'is-confirmed' : 'is-pending'">
                {{ entity.reviewStatus !== 'confirmed' ? '待补全' : entity.confirmationSource === 'user-confirmed' ? '用户确认' : entity.confirmationSource === 'evidence-verified' ? '证据验证' : '历史来源不明' }}
              </span>
              <span v-if="entity.kind" class="entity-kind">{{ entityKindLabel(entity.kind) }}</span>
              <span class="entity-card-spacer"></span>
              <button class="btn ghost danger-text" @click="removeEntity(index)">移除</button>
            </div>

            <div class="entity-fields">
              <label>
                <span>原文名称 / 写法</span>
                <input v-model.trim="entity.source" placeholder="例如：Snowflake"
                  @focus="rememberEntitySource(entity)" @change="markEntitySuggested(entity)" />
              </label>
              <div class="entity-arrow" aria-hidden="true">→</div>
              <label>
                <span>统一译名（后续章节采用）</span>
                <input v-model.trim="entity.target" placeholder="例如：Snowflake"
                  @change="markEntitySuggested(entity)" />
              </label>
            </div>

            <details class="entity-aliases">
              <summary>别名与其他写法（{{ (entity.aliases || []).length }} 项，可选）</summary>
              <label>
                <span>用英文逗号分隔</span>
                <input :value="(entity.aliases || []).join(', ')"
                  placeholder="原文中的缩写、别称、其他拼写"
                  @change="setEntityAliases(entity, $event)" />
              </label>
            </details>
            <p v-if="entity.evidence" class="entity-evidence"><strong>提取依据：</strong>{{ entity.evidence }}</p>
          </article>
        </div>
        <div v-else class="entity-empty">
          <strong>{{ nonPersonEntities.length ? '没有符合条件的实体' : '暂无非人物实体' }}</strong>
          <p class="muted small">
            {{ nonPersonEntities.length
              ? '试试其他关键词或切换筛选条件。'
              : '完成预处理后，地点、组织、物品和术语等非人物实体会显示在这里。' }}
          </p>
          <button v-if="nonPersonEntities.length" class="btn" @click="entitySearch = ''; entityFilter = 'all'">
            清除筛选
          </button>
          <button v-else class="btn primary" @click="addEntity">手动添加实体映射</button>
        </div>

        <p class="muted small dictionary-footnote">状态说明：证据验证表示系统验证了来源依据；用户确认表示你明确修改或确认了条目；历史来源不明表示旧版本未记录来源，系统不会推断为用户确认。条目启用状态与确认来源分开记录。</p>
      </section>

      <section v-if="literaryMode" class="panel character-management">
        <div class="dictionary-heading">
          <div>
            <h3>人物管理（译名、角色与声音）</h3>
            <p class="muted small">每个人物只维护一份资料：规范原文名、统一译名、别名、角色定位、人物特征、说话风格与原文证据。带原文证据的声音/角色观察默认作为弱提示用于翻译；无需逐个确认，可随时停用。</p>
          </div>
          <div class="voice-counts">
            <span class="chip">人物 {{ managedPeople.length }}</span>
            <span class="chip">已启用 {{ confirmedCharacterVoiceCount }}</span>
            <span class="chip">待核对 {{ pendingCharacterVoiceCount }}</span>
          </div>
        </div>

        <div class="dictionary-toolbar">
          <input v-model.trim="personSearch" type="search" class="entity-search"
            placeholder="搜索人物原文名、译名、别名或角色特征…" aria-label="搜索人物管理" />
          <div class="dictionary-actions">
            <button class="btn primary" @click="addManagedPerson">添加人物</button>
          </div>
        </div>

        <div v-if="filteredManagedPeople.length" class="entity-card-list">
          <article v-for="item in filteredManagedPeople" :key="item.key" class="entity-card person-management-card">
            <div class="entity-card-header">
              <span class="entity-kind">人物</span>
              <span v-if="item.profile" class="entity-status"
                :class="item.profile.status === 'confirmed' ? 'is-confirmed' : item.profile.status === 'rejected' ? 'is-rejected' : 'is-pending'">
                {{ item.profile.status === 'confirmed' ? (item.profile.confirmationSource === 'user-confirmed' ? '用户确认' : item.profile.confirmationSource === 'evidence-verified' ? '证据验证' : '历史来源不明') : item.profile.status === 'rejected' ? '已拒绝' : '角色/声音候选' }}
              </span>
              <span v-else class="entity-status"
                :class="item.entity?.reviewStatus === 'confirmed' ? 'is-confirmed' : 'is-pending'">
                {{ item.entity?.reviewStatus !== 'confirmed' ? '译名待补全' : item.entity?.confirmationSource === 'user-confirmed' ? '译名：用户确认' : item.entity?.confirmationSource === 'evidence-verified' ? '译名：证据验证' : '译名：历史来源不明' }}
              </span>
              <span v-if="item.profile" class="entity-status"
                :class="item.profile.useForTranslation ? 'is-confirmed' : 'is-pending'">
                {{ item.profile.useForTranslation ? '默认用于翻译' : '已停用' }}
              </span>
              <span class="entity-card-spacer"></span>
              <button class="btn ghost danger-text" @click="removeManagedPerson(item)">移除人物</button>
            </div>

            <div class="entity-fields">
              <label>
                <span>规范原文名</span>
                <input :value="managedPersonSource(item)" placeholder="人物原文名"
                  @change="updateManagedPerson(item, 'source', $event)" />
              </label>
              <div class="entity-arrow" aria-hidden="true">→</div>
              <label>
                <span>统一译名（后续章节采用）</span>
                <input :value="managedPersonTarget(item)" placeholder="统一中文译名"
                  @change="updateManagedPerson(item, 'target', $event)" />
              </label>
            </div>

            <details class="entity-aliases">
              <summary>别名与其他写法（{{ managedPersonAliases(item).length }} 项）</summary>
              <label>
                <span>用英文逗号分隔</span>
                <input :value="managedPersonAliases(item).join(', ')"
                  placeholder="原文中的简称、头衔或其他写法"
                  @change="updateManagedPerson(item, 'aliases', $event)" />
              </label>
            </details>
            <p v-if="item.entity?.evidence" class="entity-evidence"><strong>译名提取依据：</strong>{{ item.entity.evidence }}</p>

            <template v-if="item.profile">
              <div class="voice-profile-fields">
                <p v-if="item.profile.role"><strong>角色定位（默认弱提示；标记已核实后增强）：</strong>{{ item.profile.role }}</p>
                <p v-if="item.profile.traits?.length"><strong>人物特征（默认弱提示；标记已核实后增强）：</strong>{{ item.profile.traits.join('；') }}</p>
                <p v-if="item.profile.voiceCore.register"><strong>语域：</strong>{{ item.profile.voiceCore.register }}</p>
                <p v-if="item.profile.voiceCore.syntaxRhythm?.length"><strong>句法 / 节奏：</strong>{{ item.profile.voiceCore.syntaxRhythm.join('；') }}</p>
                <p v-if="item.profile.voiceCore.lexicalPreferences?.length"><strong>词汇：</strong>{{ item.profile.voiceCore.lexicalPreferences.join('；') }}</p>
                <p v-if="item.profile.voiceCore.discourseHabits?.length"><strong>对话策略：</strong>{{ item.profile.voiceCore.discourseHabits.join('；') }}</p>
                <p v-if="item.profile.voiceCore.stanceModality?.length"><strong>立场 / 情态：</strong>{{ item.profile.voiceCore.stanceModality.join('；') }}</p>
                <p v-if="item.profile.voiceCore.humorIrony"><strong>幽默 / 反讽：</strong>{{ item.profile.voiceCore.humorIrony }}</p>
                <p v-if="item.profile.voiceCore.disfluency"><strong>口语特征：</strong>{{ item.profile.voiceCore.disfluency }}</p>
                <p v-if="item.profile.voiceCore.avoid?.length"><strong>避免：</strong>{{ item.profile.voiceCore.avoid.join('；') }}</p>
              </div>
              <details>
                <summary>原文证据（{{ item.profile.evidence.length }}）与人物对比（{{ item.profile.contrastRules.length }}）</summary>
                <div v-for="(evidence, index) in item.profile.evidence" :key="item.profile.characterId + '-ev-' + index" class="voice-evidence">
                  <p><strong>{{ evidence.dimension === 'role_traits' ? '人物角色/特征' : evidence.dimension }} · {{ evidence.confidenceSource === 'model_self_report' && evidence.confidence !== null ? '模型自报 ' + Math.round(evidence.confidence * 100) + '%' : '置信度未评估' }}</strong> · {{ evidence.observation }}</p>
                  <blockquote>{{ evidence.sourceQuote }}</blockquote>
                  <button class="btn ghost" @click="showReviewSegment(evidence.segmentId)">定位证据片段 {{ evidence.segmentId }}</button>
                </div>
                <p v-for="(rule, index) in item.profile.contrastRules" :key="item.profile.characterId + '-contrast-' + index" class="muted small">
                  与 {{ characterName(rule.otherCharacterId) }} 的差异：{{ rule.difference }}（证据：{{ rule.evidenceSegmentIds.join('、') }}）
                </p>
                <p v-for="(question, index) in item.profile.openQuestions" :key="item.profile.characterId + '-q-' + index" class="warn small">待确认：{{ question }}</p>
              </details>
              <div class="voice-profile-actions">
                <button class="btn primary" :disabled="item.profile.status === 'confirmed' || !item.profile.evidence.length" @click="setCharacterVoiceStatus(item.profile, 'confirmed')">标记已核实</button>
                <button class="btn" :disabled="!item.profile.evidence.length" @click="setCharacterVoiceUse(item.profile, !item.profile.useForTranslation)">{{ item.profile.useForTranslation ? '停用用于翻译' : '启用用于翻译' }}</button>
                <button class="btn" :disabled="item.profile.status === 'rejected'" @click="setCharacterVoiceStatus(item.profile, 'rejected')">拒绝此画像</button>
                <button class="btn ghost" :disabled="item.profile.status === 'candidate' && item.profile.useForTranslation" @click="setCharacterVoiceStatus(item.profile, 'candidate')">恢复为候选并启用</button>
              </div>
            </template>
            <p v-else class="muted small">该人物暂时只有译名映射。完成全书预处理、获得可核验的原文证据后，角色定位和声音观察会合并显示在这张卡片中。</p>
          </article>
        </div>
        <div v-else class="entity-empty">
          <strong>{{ managedPeople.length ? '没有符合条件的人物' : '暂无人物资料' }}</strong>
          <p class="muted small">{{ managedPeople.length ? '试试其他关键词。' : '完成全书预处理后，人物译名、角色定位与声音观察会集中显示在这里。' }}</p>
          <button v-if="managedPeople.length" class="btn" @click="personSearch = ''">清除筛选</button>
        </div>

        <details class="relationship-section">
          <summary><strong>人物 / 事物关系</strong>（{{ literaryMemory.relationships.length }} 项）</summary>
          <p class="muted small relationship-help">这里记录“谁与谁是什么关系”，用于消歧，不是译名表。只确认有明确原文依据的关系。</p>
          <div class="literary-editor-list">
            <div v-for="(relation, index) in literaryMemory.relationships" :key="'relation-' + index" class="literary-editor-row">
              <label>主体<input v-model="relation.subject" @change="markRelationshipSuggested(relation)" /></label>
              <label>关系<input v-model="relation.predicate" @change="markRelationshipSuggested(relation)" /></label>
              <label>对象<input v-model="relation.object" @change="markRelationshipSuggested(relation)" /></label>
              <span class="chip">{{ relation.reviewStatus !== 'confirmed' ? '候选' : relation.confirmationSource === 'user-confirmed' ? '用户确认' : relation.confirmationSource === 'evidence-verified' ? '证据验证' : '历史来源不明' }}</span>
              <button class="btn ghost" :disabled="!relation.subject.trim() || !relation.predicate.trim() || !relation.object.trim()" @click="confirmRelationship(relation)">确认并应用</button>
              <button class="btn ghost danger-text" @click="removeRelationship(index)">移除</button>
            </div>
            <div class="relationship-actions">
              <button class="btn" @click="addRelationship">添加关系</button>
              <button class="btn" :disabled="confirmableRelationshipCount === 0" @click="confirmAllRelationships">一键确认待核对项（{{ pendingRelationshipCount }}）</button>
            </div>
          </div>
        </details>

        <details v-if="literaryMemory.relationshipVoiceRules.length" class="relationship-section">
          <summary><strong>人物对的说话规则</strong>（{{ literaryMemory.relationshipVoiceRules.length }} 项）</summary>
          <p class="muted small">方向不可互换：A 对 B 的称谓和语域，不代表 B 对 A 的说话方式。</p>
          <article v-for="(rule, index) in literaryMemory.relationshipVoiceRules" :key="'voice-rule-' + index" class="voice-profile-card">
            <div class="voice-profile-heading">
              <strong>{{ characterName(rule.speakerId) }} → {{ characterName(rule.addresseeId) }}</strong>
              <span class="entity-status" :class="rule.status === 'confirmed' ? 'is-confirmed' : rule.status === 'rejected' ? 'is-rejected' : 'is-pending'">{{ rule.status === 'confirmed' ? (rule.confirmationSource === 'user-confirmed' ? '用户确认' : rule.confirmationSource === 'evidence-verified' ? '证据验证' : '历史来源不明') : rule.status === 'rejected' ? '已拒绝' : '候选' }}</span>
            </div>
            <p v-if="rule.baselineRegister"><strong>语域：</strong>{{ rule.baselineRegister }}</p>
            <p v-if="rule.addressTerms.length"><strong>称呼：</strong>{{ rule.addressTerms.join('、') }}</p>
            <p v-if="rule.directness"><strong>直接程度：</strong>{{ rule.directness }}</p>
            <p v-if="rule.emotionalDistance"><strong>情感距离：</strong>{{ rule.emotionalDistance }}</p>
            <p v-if="rule.sceneDependentShift"><strong>场景变化：</strong>{{ rule.sceneDependentShift }}</p>
            <p class="muted small">证据片段：{{ rule.evidenceSegmentIds.join('、') }}</p>
            <div class="voice-profile-actions">
              <button class="btn primary" :disabled="rule.status === 'confirmed' || !rule.evidenceSegmentIds.length" @click="setRelationshipVoiceStatus(rule, 'confirmed')">确认规则</button>
              <button class="btn" :disabled="rule.status === 'rejected'" @click="setRelationshipVoiceStatus(rule, 'rejected')">拒绝</button>
              <button class="btn ghost" :disabled="rule.status === 'candidate'" @click="setRelationshipVoiceStatus(rule, 'candidate')">恢复候选</button>
            </div>
          </article>
        </details>
        <details v-if="literaryMemory.voiceAnchors.length" class="relationship-section">
          <summary><strong>原文—译文声音锚点</strong>（{{ literaryMemory.voiceAnchors.length }} 项）</summary>
          <p class="muted small">仅批准的锚点会用于常规翻译。来源对不上、说话人不可靠或译文还未确定时，不应批准。</p>
          <article v-for="anchor in literaryMemory.voiceAnchors" :key="anchor.anchorId" class="voice-profile-card">
            <div class="voice-profile-heading">
              <strong>{{ characterName(anchor.speakerId) }} · {{ anchor.chapter || '未标章节' }}</strong>
              <span class="entity-status" :class="anchor.status === 'approved' ? 'is-confirmed' : anchor.status === 'rejected' ? 'is-rejected' : 'is-pending'">{{ anchor.status === 'approved' ? (anchor.confirmationSource === 'user-confirmed' ? '用户确认' : anchor.confirmationSource === 'evidence-verified' ? '证据验证' : '历史来源不明') : anchor.status === 'rejected' ? '已拒绝' : '候选' }}</span>
            </div>
            <p><strong>原文：</strong>{{ anchor.source }}</p>
            <label class="voice-anchor-target">
              <span><strong>译文锚点</strong> · 应对应阅读器中当前已采纳译文的原文片段</span>
              <textarea v-model="anchor.target" rows="2" @change="editVoiceAnchor(anchor)"></textarea>
            </label>
            <p class="muted small">来源片段 {{ anchor.segmentId }} · {{ anchor.tags.join('、') }}</p>
            <p v-if="anchor.attributionEvidence"><strong>说话人归属证据：</strong>{{ anchor.attributionEvidence }}（置信度 {{ Math.round((anchor.attributionConfidence || 0) * 100) }}%）</p>
            <p v-else class="warn small">缺少可核验的说话人归属证据；这个锚点只能保留为候选。</p>
            <div class="voice-profile-actions">
              <button class="btn primary" :disabled="anchor.status === 'approved'" @click="setVoiceAnchorStatus(anchor, 'approved')">批准并作为声音示例</button>
              <button class="btn" :disabled="anchor.status === 'rejected'" @click="setVoiceAnchorStatus(anchor, 'rejected')">拒绝</button>
              <button class="btn ghost" :disabled="anchor.status === 'candidate'" @click="setVoiceAnchorStatus(anchor, 'candidate')">恢复候选</button>
            </div>
          </article>
        </details>
      </section>

      <section class="panel literary-review-findings">
        <div class="review-workspace-heading">
          <div>
            <h3>审校工作区</h3>
            <p class="muted small">这里只列出 Reviewer 发现的问题，不是待办通知。事实/实体译名错误会自动修正；纯文风建议保留为候选稿，需你比较后决定是否替换正文。</p>
          </div>
          <span class="chip">{{ literaryStatus.reviewFindings.length }} 条记录</span>
        </div>
        <div v-if="!literaryStatus.reviewFindings.length" class="review-empty">
          <strong>还没有审校记录</strong>
          <p class="muted small">完成当前页翻译并开启“审校”后，记录会出现在这里。文学审校关闭时只做初译，不会生成审校建议。</p>
        </div>
        <div v-for="(finding, index) in [...literaryStatus.reviewFindings].reverse()" :key="'finding-' + index" class="literary-review-card">
          <div class="review-card-heading">
            <span class="review-category" :class="'category-' + finding.category">
              {{ finding.category === 'accuracy' ? '意义 / 事实' : finding.category === 'terminology' ? '实体译名' : '文风建议' }}
            </span>
            <span class="muted small">片段 {{ finding.id }}</span>
            <span class="review-status" :class="'status-' + (finding.applicationStatus || (finding.priority === 'must_fix' ? 'applied' : 'pending'))">
              {{ finding.applicationStatus === 'applied' || finding.priority === 'must_fix'
                ? '已应用'
                : finding.applicationStatus === 'dismissed'
                  ? '已保留当前译文'
                  : finding.proposedTranslation
                    ? '等待你选择'
                    : '参考记录' }}
            </span>
          </div>
          <p v-if="finding.sourceExcerpt"><strong>原文摘录：</strong>{{ finding.sourceExcerpt }}</p>
          <p v-if="finding.draftExcerpt"><strong>初译摘录：</strong>{{ finding.draftExcerpt }}</p>
          <p v-if="finding.reason"><strong>问题：</strong>{{ finding.reason }}</p>
          <p v-if="finding.suggestion"><strong>审校意见：</strong>{{ finding.suggestion }}</p>
          <p v-if="finding.dimension"><strong>专项维度：</strong>
            {{ finding.dimension === 'character_voice' ? '人物声音' : finding.dimension === 'register' ? '语域' : finding.dimension === 'narrative_style' ? '叙述风格' : '节奏 / 停顿' }}
            <template v-if="finding.characterId"> · 人物 {{ characterName(finding.characterId) }}</template>
            <template v-if="finding.relatedCharacterId"> · 对照人物 {{ characterName(finding.relatedCharacterId) }}</template>
          </p>
          <p v-if="finding.evidenceSegmentIds?.length"><strong>证据片段：</strong>{{ finding.evidenceSegmentIds.join('、') }}</p>

          <div v-if="finding.category === 'style' && finding.proposedTranslation" class="review-proposal">
            <strong>完整候选译文</strong>
            <p>{{ finding.proposedTranslation }}</p>
            <div class="review-proposal-actions">
              <button class="btn primary" :disabled="finding.applicationStatus === 'applied'"
                @click="applyReviewProposal(finding)">
                {{ finding.applicationStatus === 'applied' ? '已采用此译文' : '采用候选译文并保存' }}
              </button>
              <button class="btn" :disabled="finding.applicationStatus === 'dismissed' || finding.applicationStatus === 'applied'"
                @click="dismissReviewProposal(finding)">保留当前译文</button>
              <button class="btn ghost" @click="showReviewSegment(finding.id)">定位到正文</button>
            </div>
          </div>
          <div v-else-if="finding.category === 'style'" class="review-legacy-note muted small">
            这条是旧版记录，只保存了建议，没有保存 Reviewer 的完整候选稿。点击“重新审校此段”会以当前译文为底稿再审一次，返回完整候选稿后你再决定是否替换。
            <div class="review-proposal-actions">
              <button class="btn primary" :disabled="state.running" @click="rereviewSegment(finding.id)">重新审校此段</button>
              <button class="btn ghost" @click="showReviewSegment(finding.id)">定位到正文</button>
            </div>
          </div>
          <div v-else class="review-auto-note muted small">
            事实/实体类问题已按高优先级处理。查看正文可核对当前结果；若你手动改过译文，可重新审校确认是否仍有问题。
            <div class="review-proposal-actions">
              <button class="btn" :disabled="state.running" @click="rereviewSegment(finding.id)">重新审校此段</button>
              <button class="btn ghost" @click="showReviewSegment(finding.id)">查看正文</button>
            </div>
          </div>
        </div>
      </section>
      <section v-if="!literaryMode && !literaryStatus.enabled" class="panel">
        <p class="muted small">当前文档未启用书籍翻译模式。EPUB / PDF 打开时默认启用；也可在本页上方勾选「实体一致性与文风审校」。</p>
      </section>
      </template>
      <section v-if="activeTab === 'trajectory'" class="agent-trajectory-page">
        <div class="agent-trajectory-header">
          <div>
            <h2>Agent 轨迹</h2>
            <p class="muted small">显示本机服务持久化的真实执行事件，不是根据动画推测的进度。并发运行的初译、准确性审校、文风审校和全书预处理会分别记录。</p>
          </div>
          <div class="agent-trajectory-controls">
            <select v-model="agentTrajectoryFilter" aria-label="筛选 Agent 轨迹">
              <option value="all">全部事件</option>
              <option value="model">模型调用</option>
              <option value="issues">警告与失败</option>
            </select>
            <button class="btn ghost" :disabled="agentTrajectoryLoading" @click="refreshAgentTrajectory(true)">
              {{ agentTrajectoryLoading ? '刷新中…' : '刷新轨迹' }}
            </button>
          </div>
        </div>

        <div class="agent-trajectory-summary">
          <span class="chip" :class="'diagnostic-' + (workspaceActiveRun?.status || 'idle')">
            {{ workspaceActiveRun?.status === 'running' || workspaceActiveRun?.status === 'queued'
              ? '翻译任务运行中' : workspaceActiveRun?.status === 'failed' ? '最近任务失败' : '显示持久化执行记录' }}
          </span>
          <span class="chip">project-id {{ workspaceProject?.projectId || '未连接' }}</span>
          <span class="chip">事件 {{ agentTrajectoryEvents.length }}</span>
          <span class="chip">最近事件 ID {{ agentTrajectoryCursor || '—' }}</span>
        </div>

        <p v-if="agentTrajectoryError" class="warn agent-trajectory-error">{{ agentTrajectoryError }}</p>
        <p v-else-if="readerConfig?.documentUseLocalAgent !== true" class="warn agent-trajectory-error">
          尚未启用本机 Local Agent。启用后，翻译批次和审校阶段才会记录在这里。
        </p>
        <p v-else-if="agentTrajectoryLoading && !agentTrajectoryEvents.length" class="muted small">正在读取 SQLite 中保存的 Agent 事件…</p>

        <div class="agent-trajectory-current" v-if="agentTrajectoryActiveTasks.length">
          <h3>当前正在执行</h3>
          <div class="agent-trajectory-active-grid">
            <article v-for="task in agentTrajectoryActiveTasks" :key="task.key" class="agent-task-card">
              <span class="agent-task-pulse"></span>
              <div class="agent-task-main">
                <strong>{{ task.role }}</strong>
                <span>{{ task.title }}</span>
                <small class="muted">{{ task.runId ? 'run-id ' + task.runId : '' }}{{ task.batchLabel ? ' · ' + task.batchLabel : '' }}</small>
              </div>
            </article>
          </div>
        </div>
        <div v-else-if="agentTrajectoryEvents.length" class="agent-trajectory-idle">
          最近没有未完成的 Agent 阶段。下面保留了本次项目的执行历史，包括已经结束的模型调用。
        </div>

        <div class="agent-trajectory-list">
          <article
            v-for="event in agentTrajectoryVisibleEvents"
            :key="event.eventId"
            class="agent-trace-row"
            :class="'trace-' + agentTrajectoryStatus(event)"
          >
            <div class="agent-trace-rail">
              <span class="agent-trace-dot"></span>
              <span class="agent-trace-line"></span>
            </div>
            <div class="agent-trace-body">
              <div class="agent-trace-heading">
                <strong>{{ agentTrajectoryTitle(event) }}</strong>
                <span class="chip">{{ agentTrajectoryRole(event) }}</span>
                <span class="chip" :class="'diagnostic-' + agentTrajectoryStatus(event)">{{ agentTrajectoryStatusLabel(event) }}</span>
                <time class="muted small">{{ formatAgentTime(event.createdAt) }}</time>
              </div>
              <p class="agent-trace-detail">{{ agentTrajectoryDetail(event) }}</p>
              <div class="agent-trace-meta">
                <span v-if="workspaceProject?.projectId">project-id {{ workspaceProject.projectId }}</span>
                <span v-if="event.runId">run-id {{ event.runId }}</span>
                <span v-if="event.payload?.provider || event.payload?.model">model {{ event.payload?.provider || '?' }}/{{ event.payload?.model || '运行时默认' }}</span>
                <span v-if="event.payload?.thinkingMode || event.payload?.thinking_mode">thinking {{ event.payload?.thinkingMode || event.payload?.thinking_mode }}{{ (event.payload?.thinkingBudgetTokens || event.payload?.thinking_budget_tokens) ? ' ' + (event.payload?.thinkingBudgetTokens || event.payload?.thinking_budget_tokens) : '' }}</span>
                <span v-if="event.payload?.effort">effort {{ event.payload.effort }}</span>
                <span v-if="event.payload?.fallbackModel || event.payload?.fallback_model">fallback {{ event.payload?.fallbackModel || event.payload?.fallback_model }}</span>
                <span>事件 #{{ event.eventId }}</span>
                <span v-if="event.payload?.batchIndex">批次 {{ event.payload.batchIndex }}{{ event.payload.batchCount ? '/' + event.payload.batchCount : '' }}</span>
                <span v-if="event.payload?.durationMs != null">耗时 {{ formatAgentDuration(event.payload.durationMs) }}</span>
                <span v-if="event.payload?.requestId">Request {{ event.payload.requestId.slice(0, 12) }}</span>
              </div>
              <button
                v-if="agentTrajectoryHasFailureDetails(event)"
                type="button"
                class="btn ghost agent-trace-failure-toggle"
                @click="toggleAgentTrajectoryFailureDetails(event)"
              >
                {{ expandedAgentFailureEventId === event.eventId ? '收起失败详情' : '查看失败片段（' + agentTrajectoryFailureCount(event) + '）' }}
              </button>
              <div v-if="expandedAgentFailureEventId === event.eventId" class="agent-trace-failure-details">
                <p v-if="agentTrajectoryFailureLoading[event.runId]" class="muted small">正在读取本次运行的片段状态和失败原因…</p>
                <p v-if="agentTrajectoryFailureErrors[event.runId]" class="agent-trajectory-error">{{ agentTrajectoryFailureErrors[event.runId] }}</p>
                <template v-else-if="!agentTrajectoryFailureLoading[event.runId]">
                  <p v-if="!(agentTrajectoryFailureDetails[event.runId] || []).length" class="muted small">
                    未找到失败片段明细。请刷新轨迹，或在 Agent 工作区查看运行状态。
                  </p>
                  <article
                    v-for="item in (agentTrajectoryFailureDetails[event.runId] || [])"
                    :key="item.id"
                    class="agent-trace-failure-item"
                  >
                    <div class="agent-trace-failure-item-heading">
                      <strong>{{ item.contextPath || '失败片段' }}</strong>
                      <span class="chip">{{ item.id }}</span>
                      <span class="chip" :class="item.status === 'failed' ? 'diagnostic-failed' : 'diagnostic-warning'">
                        {{ item.status === 'failed' ? '失败' : '当前状态：' + item.status }}
                      </span>
                      <span class="muted small">尝试 {{ item.attempts || 0 }} 次</span>
                    </div>
                    <p class="agent-trace-failure-reason">{{ item.error || (item.status === 'failed'
                      ? '服务没有保存该片段的独立错误原因；请核对同一批次的模型调用、缺失片段和输出校验事件。'
                      : '该片段曾被批次失败事件报告，但当前运行记录显示它已不再处于失败状态。') }}</p>
                    <p v-if="item.sourceExcerpt" class="agent-trace-failure-source">原文摘要：{{ item.sourceExcerpt }}</p>
                  </article>
                  <div v-if="agentTrajectoryRelatedFailureEvents(event).length" class="agent-trace-failure-related">
                    <strong>相关 Agent 轨迹</strong>
                    <p v-for="related in agentTrajectoryRelatedFailureEvents(event)" :key="related.eventId">
                      {{ formatAgentTime(related.createdAt) }} · {{ agentTrajectoryTitle(related) }} · {{ agentTrajectoryDetail(related) }}
                    </p>
                  </div>
                </template>
              </div>
            </div>
          </article>
          <p v-if="!agentTrajectoryLoading && !agentTrajectoryVisibleEvents.length" class="review-empty">
            {{ agentTrajectoryEvents.length ? '当前筛选条件下没有事件。' : '还没有 Agent 事件。打开本机 Agent 并启动一次翻译或全书预处理后，这里会自动显示各阶段轨迹。' }}
          </p>
        </div>
      </section>

      <!-- 保持 Agent workspace 实例常驻；切换阅读页或设置 Tab 时只隐藏，不销毁已建立的项目关联。 -->
      <DocumentAgentWorkspace
        v-if="doc"
        v-show="activeTab === 'agent'"
        :active="activeTab === 'agent'"
        :key="documentAgentWorkspaceKey"
        :title="doc.title"
        :format="doc.format"
        :source-file-name="documentFileName"
        :source-file="loadedSourceFile"
        :segments="doc.segments"
        :visible-segments="visibleSegments"
        :translations="state.translations"
        :source-lang="sourceLang"
        :target-lang="targetLang"
        :translation-mode="effectiveDocumentTranslationMode"
        :literary-review="literaryReview"
        :use-local-agent="readerConfig?.documentUseLocalAgent === true"
        :local-agent-provider="readerConfig?.documentLocalAgentProvider || 'workbuddy'"
        :local-agent-url="readerConfig?.documentLocalAgentUrl || 'http://127.0.0.1:8789'"
        :local-agent-model="readerConfig?.documentLocalAgentModel || 'auto'"
        :local-agent-token="readerConfig?.documentLocalAgentToken || ''"
        :code-buddy-task-profiles="readerConfig?.documentCodeBuddyTaskProfiles"
        :system-prompt="documentSystemPromptEditor || builtInDocumentSystemPrompt"
        :user-prompt-template="documentUserPromptEditor || BUILT_IN_USER_PROMPT_TEMPLATE"
        :literary-memory="literaryMemory"
        :glossary="glossary"
        :preprocessing-state="translationPreprocessingUiState"
        @accepted-translations="applyAgentTranslations"
        @workspace-sync="syncWorkspaceTranslations"
        @project-updated="handleAgentWorkspaceProjectUpdated"
        @open-preprocessing="openPreprocessingAndEnsure"
        @preprocessing-status-refresh-requested="handlePreprocessingStatusRefreshRequested"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { getConfig, setConfig, type Config } from '@/entrypoints/utils/config';
import DocumentTranslationSettings from './DocumentTranslationSettings.vue';
import DocumentAgentWorkspace from './DocumentAgentWorkspace.vue';
import { useAgentTrajectory } from './useAgentTrajectory';
import { useLiteraryMemoryEditor } from './useLiteraryMemoryEditor';
import { createEmptyContextGraphOverview, useContextGraph } from './useContextGraph';
import {
  BUILT_IN_USER_PROMPT_TEMPLATE,
  FORMAT_LABEL,
  languageFontClass,
} from './documentReaderFormat';
import { buildDocumentAgentSessionId } from './documentSessionId';
import {
  agentTrajectoryDetail,
  agentTrajectoryFailureCount,
  agentTrajectoryHasFailureDetails,
  agentTrajectoryRelatedFailureEvents as agentTrajectoryRelatedFailureEventsOf,
  agentTrajectoryRole,
  agentTrajectoryStatus,
  agentTrajectoryStatusLabel,
  agentTrajectoryTitle,
  computeAgentTrajectoryActiveTasks,
  filterAgentTrajectoryEvents,
  formatAgentDuration,
  formatAgentTime,
  formatAgentDateTime,
  type AgentTrajectoryFilter,
} from './documentAgentTrajectory';
import {
  backupWorkspaceSourceFile,
  importDocumentFileViaLocalAgent,
  importWorkspaceTranslations,
  isServiceUnreachableError,
  loadWorkspaceAcceptedTranslations,
  loadWorkspaceParsedDocument,
  parsedDocumentFromLocalAgentPreview,
  lookupWorkspaceProject,
  rememberWorkspaceProject,
  resolveWorkspaceProject,
  workspaceApi,
  WorkspaceApiError,
} from './documentWorkspaceClient';
import { preprocessingGateTitle, resolveDocumentTranslationMode, styleGuideBadge as computeStyleGuideBadge } from './documentPreprocessing';
import { extractGlossaryLocal } from '@/entrypoints/utils/glossaryExtractor';
import type { Glossary } from '@/entrypoints/service/_service';
import { buildStyledSystemContent } from '@/entrypoints/service/prompt-style';
import {
  DOCUMENT_ACCEPT_ATTR,
  exportDocument,
  buildExportFileName,
  parseDocument,
  type ExportFormat,
} from '@/entrypoints/utils/document';
import type { ParsedDocument } from '@/entrypoints/utils/document/types';
import { buildDocumentPages, nextUntranslatedPageWindow } from '@/entrypoints/utils/document/pagination';
import {
  clearActiveDocumentSession,
  createActiveDocumentSession,
  getActiveDocumentSessionSummary,
  loadActiveDocumentSession,
  saveActiveDocumentProgress,
  type ActiveDocumentSessionSummary,
  type LoadedActiveDocumentSession,
  type SavedViewMode,
  type SavedDocumentTab,
} from '@/entrypoints/utils/document/sessionStore';
import { useDocumentTranslation } from './useDocumentTranslation';
import { buildLiteraryTranslationContextPrompt, createEmptyLiteraryMemory, refreshLiteraryExampleTargets, sanitizeLiteraryMemory, type LiteraryReviewFinding } from '@/entrypoints/utils/document/literary';

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
const readerConfig = ref<Config | null>(null);
/** 当前文档对应的本机 workspace；阅读页与 Agent Tab 都从这里读写同一份 SQLite。 */
const workspaceProject = ref<any>(null);
const workspaceActiveRun = ref<any>(null);
const workspaceRunId = ref('');
const workspaceSourceChanged = ref(false);
const workspaceTranslationActive = ref(false);
const workspaceRunGeneration = ref(0);
let ensureWorkspacePromise: Promise<any | null> | null = null;
let ensureWorkspacePromiseKey: string | null = null;
/** Invalidates asynchronous work when the reader switches to another document. */
let workspaceDocumentGeneration = 0;
/** A file imported and parsed by Local Agent is already authoritative; don't resend all segments to resolve/create it. */
let localAgentImportBinding: { documentKey: string; projectId: string; createdNewProject: boolean; sourceChanged?: boolean; sourceFingerprint?: string } | null = null;
/** Session hydration must not be mistaken for explicit user changes that update the service Prompt. */
let suppressWorkspacePromptSync = false;
/** Avoid creating a new service project before the existing browser/session snapshot has been compared. */
let suppressWorkspaceAutoEnsure = false;
/** Count overlapping hydration writes so one completed request cannot unsuppress another. */
let sessionPersistenceSuppressionCount = 0;
/** Agent 候选在运行结束时自动采纳；此 Map 仅用于运行中的临时预览或保存失败时提示。 */
const workspaceCandidateTranslations = ref(new Map<string, string>());
const englishFontFamily = ref('Georgia');
const chineseFontFamily = ref('Noto Serif CJK SC');
const englishFontSize = ref(17);
const chineseFontSize = ref(18);
const documentSystemPromptOverride = ref('');
const documentSystemPromptEditor = ref('');
const documentUserPromptTemplate = ref('');
const documentUserPromptEditor = ref('');
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
/** 当前加载的原始 File：仅用于把原始 EPUB/PDF 备份进本机文档项目，不持久化到扩展配置。 */
const loadedSourceFile = ref<File | null>(null);
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
/**
 * Agent 面板常驻后，必须按文档内容身份而不是只按文件名重建实例。
 * 同名 EPUB/PDF 被重新打开时，新来源不能继承前一个文档的项目状态。
 */
const documentAgentWorkspaceKey = computed(() =>
  doc.value ? buildDocumentAgentSessionId(doc.value, documentFileName) : 'empty-document',
);

const {
  state,
  run,
  retryFailed,
  reviewExistingSegments,
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
/** 片段是否已有非空译文；分页推进与按钮状态共用同一判据。 */
function isSegmentTranslated(segmentId: string): boolean {
  return !!state.value.translations.get(segmentId)?.trim();
}
const currentPagePending = computed(() => visibleSegments.value.some((segment) => !isSegmentTranslated(segment.id)));
/** 当前阅读位置（含当前页）之后是否还有未译页面：决定预翻译按钮是否可用。 */
const hasPendingPageAhead = computed(() =>
  nextUntranslatedPageWindow(pages.value, currentPageIndex.value, 1, isSegmentTranslated).length > 0);
const hasPendingDocument = computed(() =>
  doc.value?.segments.some((segment) => !state.value.translations.get(segment.id)?.trim()) ?? false,
);

const builtInDocumentSystemPrompt = computed(() => {
  const base = buildStyledSystemContent(
    sourceLang.value,
    targetLang.value,
    effectiveDocumentTranslationMode.value === 'literary' ? undefined : glossary.value,
    readerConfig.value?.documentPromptStyle || 'default',
    effectiveDocumentTranslationMode.value,
  );
  // Include the static book workflow instructions shown to the model, not just the generic profile.
  return effectiveDocumentTranslationMode.value === 'literary' ? base + '\n\n' + buildLiteraryTranslationContextPrompt() : base;
});
const documentStyleVars = computed(() => ({
  '--document-font-en': englishFontFamily.value,
  '--document-font-zh': chineseFontFamily.value,
  '--document-size-en': englishFontSize.value + 'px',
  '--document-size-zh': chineseFontSize.value + 'px',
}));
const userPromptPreview = computed(() => documentUserPromptEditor.value
  .split('{'.repeat(2) + 'CONTENT' + '}'.repeat(2))
  .join('[当前页片段 JSON 在发送时插入]'));
const effectiveDocumentTranslationMode = computed(() =>
  resolveDocumentTranslationMode(literaryMode.value, readerConfig.value?.documentTranslationMode),
);

/** 阅读、配置、人物/预处理、Agent 工作区和轨迹分区相互独立。 */
const activeTab = ref<SavedDocumentTab>('reading');

// 预处理文风基准由两个 composable 共享，必须在这里先创建：
// `useLiteraryMemoryEditor` 的 watcher 会在 setup 阶段立即读取一次。
const contextGraphOverview = ref(createEmptyContextGraphOverview());

const {
  entitySearch,
  entityFilter,
  personSearch,
  nonPersonEntities,
  suppressedEntityCount,
  showSuppressedEntities,
  toggleSuppressedEntities,
  setStyleGuideAutoDisabled,
  pendingEntityCount,
  confirmedEntityCount,
  managedPeople,
  filteredManagedPeople,
  pendingRelationshipCount,
  pendingCharacterVoiceCount,
  confirmedCharacterVoiceCount,
  confirmableRelationshipCount,
  filteredLiteraryEntities,
  rememberEntitySource,
  managedPersonSource,
  managedPersonTarget,
  managedPersonAliases,
  updateManagedPerson,
  addManagedPerson,
  removeManagedPerson,
  markEntitySuggested,
  entityKindLabel,
  setEntityAliases,
  addEntity,
  removeEntity,
  markRelationshipSuggested,
  confirmRelationship,
  confirmAllRelationships,
  characterName,
  setCharacterVoiceStatus,
  setCharacterVoiceUse,
  setRelationshipVoiceStatus,
  editVoiceAnchor,
  setVoiceAnchorStatus,
  addRelationship,
  removeRelationship,
  persistLiteraryMemoryToWorkspace,
  awaitLiteraryMemoryWrites,
  markStyleGuideCandidate,
  setStyleGuideLines,
  importContextGraphStyleGuide,
} = useLiteraryMemoryEditor({
  literaryMemory,
  doc,
  state,
  readerConfig,
  workspaceProject,
  ensureWorkspace: ensureDocumentWorkspace,
  persistenceMessage,
  persistSession: persistCurrentSession,
  contextGraphOverview,
});

// 文风基准默认生效，徽章只陈述当前在用的版本，不暗示还需要确认。
const styleGuideBadge = computed(() => computeStyleGuideBadge({
  autoDisabled: literaryMemory.value.styleGuideAutoDisabled === true,
  origin: String(literaryMemory.value.styleGuideOrigin || ''),
  graphReady: contextGraphOverview.value.styleGuideReady === true,
}));

const {
  contextGraphState,
  contextGraphAnalyzing,
  contextGraphBusy,
  contextGraphStatusLabel,
  contextGraphPhaseLabel,
  contextGraphProgressPercent,
  translationPreprocessingReadiness,
  translationPreprocessingNeedsAttention,
  translationPreprocessingUiState,
  clearContextGraphPoll,
  loadContextGraph,
  refreshContextGraphStatus,
  handlePreprocessingStatusRefreshRequested,
  openPreprocessingAndEnsure,
  reanalyzeContextGraph,
  resetContextGraph,
} = useContextGraph({
  readerConfig,
  workspaceProject,
  doc,
  sourceLang,
  targetLang,
  effectiveDocumentTranslationMode,
  persistenceMessage,
  activeTab,
  ensureWorkspace: ensureDocumentWorkspace,
  contextGraphOverview,
});

async function cancelTranslationRunAndReanalyzeContextGraph() {
  const active = workspaceActiveRun.value;
  if (!active?.runId) return;
  if (['queued', 'running'].includes(active.status)) {
    if (!window.confirm('当前翻译运行尚未结束。取消后将停止本轮翻译并重新分析全书，是否继续？')) return;
  }
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  const project = workspaceProject.value || await ensureDocumentWorkspace();
  if (!project?.projectId) return;
  const base = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
  const token = config.documentLocalAgentToken || '';
  try {
    const response = await workspaceApi<{ run?: any }>(
      base, token,
      '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs/' + encodeURIComponent(active.runId) + '/cancel',
      { method: 'POST', body: '{}' },
    );
    const next = response?.run || null;
    if (next && ['completed', 'cancelled'].includes(next.status)) {
      workspaceActiveRun.value = null;
    } else {
      workspaceActiveRun.value = next || workspaceActiveRun.value;
      persistenceMessage.value = '运行尚未取消（状态：' + (workspaceActiveRun.value?.status || '未知') + '），请到 Agent 面板处理后再重新分析全书。';
      return;
    }
    await reanalyzeContextGraph();
  } catch (error) {
    persistenceMessage.value = '取消运行失败：' + (error instanceof Error ? error.message : String(error));
  }
}

const currentPageTranslatedCount = computed(() =>
  visibleSegments.value.filter((segment) => !!state.value.translations.get(segment.id)?.trim()).length,
);
const translatedSegmentCount = computed(() =>
  doc.value?.segments.filter((segment) => !!state.value.translations.get(segment.id)?.trim()).length ?? 0,
);
/** 当前页是否还有未译段落：决定按钮文案是"翻译本章"还是"继续翻译下一章"。 */
const startLabel = computed(() => currentPagePending.value
  ? '翻译当前页'
  : hasPendingDocument.value ? '继续翻译下一待译页' : '全文已翻译');
/** 正在翻译的章节是否就是当前页所在章节（用于提示/跳转）。 */
const isTranslatingCurrentChapter = computed(() => {
  const work = state.value.workChapter;
  if (!work) return true;
  return visibleSegments.value.some((segment) =>
    (segment.contextPath?.trim() || '') === work,
  ) || (currentPage.value?.title || '').includes(work) || (currentPage.value?.sectionTitle || '') === work;
});

/**
 * 预处理耗时展示：全书分析要跑几分钟到十几分钟，界面只写「进行中」时，
 * 用户无法区分「在跑」和「卡死」。时钟只在运行期间按秒推进，结束后立即停，避免空转。
 */
const preprocessingClock = ref(Date.now());
let preprocessingClockTimer: number | null = null;
const preprocessingElapsedLabel = computed(() => {
  const status = contextGraphState.value.status;
  if (status !== 'queued' && status !== 'running') return '';
  const startedAt = Date.parse(String(contextGraphState.value.startedAt || ''));
  if (!Number.isFinite(startedAt)) return '';
  const seconds = Math.max(0, Math.floor((preprocessingClock.value - startedAt) / 1000));
  if (seconds < 60) return '已进行 ' + seconds + ' 秒';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return '已进行 ' + minutes + ' 分' + (rest ? ' ' + rest + ' 秒' : '');
});
watch(
  () => [contextGraphState.value.status, contextGraphState.value.startedAt] as const,
  ([status]) => {
    const active = status === 'queued' || status === 'running';
    if (active && preprocessingClockTimer === null) {
      preprocessingClockTimer = window.setInterval(() => { preprocessingClock.value = Date.now(); }, 1000);
    } else if (!active && preprocessingClockTimer !== null) {
      window.clearInterval(preprocessingClockTimer);
      preprocessingClockTimer = null;
    }
  },
  { immediate: true },
);

function jumpToWorkChapter() {  const work = state.value.workChapter;
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

const {
  agentTrajectoryEvents,
  agentTrajectoryCursor,
  agentTrajectoryLoading,
  agentTrajectoryError,
  agentTrajectoryFilter,
  expandedAgentFailureEventId,
  agentTrajectoryFailureDetails,
  agentTrajectoryFailureLoading,
  agentTrajectoryFailureErrors,
  agentTrajectoryVisibleEvents,
  agentTrajectoryActiveTasks,
  stopAgentTrajectoryPolling,
  refreshAgentTrajectory,
  startAgentTrajectoryPolling,
  toggleAgentTrajectoryFailureDetails,
  agentTrajectoryRelatedFailureEvents,
} = useAgentTrajectory({
  activeTab,
  readerConfig,
  workspaceProject,
  doc,
  ensureWorkspace: ensureDocumentWorkspace,
});

watch(activeTab, (nextTab) => {
  if (nextTab === 'trajectory') void startAgentTrajectoryPolling();
  else stopAgentTrajectoryPolling();
  // 当前工作 Tab 也是会话状态；保存它以便刷新后回到同一工作界面。
  void persistCurrentSession();
});

watch(activeTab, async (nextTab, previousTab) => {
  if (nextTab !== 'reading' || previousTab !== 'agent' || !doc.value) return;
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  if (!config.documentUseLocalAgent) return;
  try {
    const project = await ensureDocumentWorkspace();
    if (!project) return;
    const active = workspaceActiveRun.value;
    if (active && ['queued', 'running', 'awaiting_acceptance', 'partial', 'paused'].includes(active.status)) {
      await followWorkspaceRun(project, active);
    }
  } catch (error) {
    state.value.error = '同步 workspace 状态失败：' + (error instanceof Error ? error.message : String(error));
  }
});

watch(currentPageIndex, async () => {
  await nextTick();
  readerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/** 阅读位置与显示设置也是会话的一部分；保存失败只提示用户，不中断阅读或翻译。 */
watch([currentPageIndex, sourceLang, targetLang, viewMode, literaryMode], () => {
  void persistCurrentSession();
});

watch(literaryMemory, () => {
  if (effectiveDocumentTranslationMode.value === 'literary') void persistCurrentSession();
}, { deep: true });

watch(
  [doc, effectiveDocumentTranslationMode, () => readerConfig.value?.documentUseLocalAgent],
  ([currentDoc, translationMode, useLocalAgent], previous) => {
    if (suppressWorkspaceAutoEnsure || !currentDoc || useLocalAgent !== true) return;

    const wasUsingLocalAgent = previous?.[2] === true;
    const isBookFile = /^(epub|pdf)$/i.test(currentDoc.format);
    if (isBookFile && !wasUsingLocalAgent && loadedSourceFile.value && !localAgentImportBinding) {
      // Local Agent enabled after the reader opened this book in offline/remote mode.
      // Re-import the original bytes and replace extension-parser segments with server segments;
      // never promote client-generated full-book JSON into the authoritative project.
      void loadFile(loadedSourceFile.value);
      return;
    }

    if (translationMode !== 'literary') return;
    // Existing documents must receive preprocessing too; opening an old reading snapshot must not
    // be mistaken for a completed whole-book analysis.
    void ensureDocumentWorkspace().catch((error) => {
      contextGraphState.value = {
        ...contextGraphState.value,
        status: 'failed',
        error: '无法准备全书预处理：' + (error instanceof Error ? error.message : String(error)),
      };
    });
  },
  { flush: 'post' },
);

onUnmounted(() => {
  clearContextGraphPoll();
  stopAgentTrajectoryPolling();
  clearServiceReconnectProbe();
  if (preprocessingClockTimer !== null) {
    window.clearInterval(preprocessingClockTimer);
    preprocessingClockTimer = null;
  }
});

onMounted(async () => {
  // 文档翻译默认沿用 popup 的全局配置；恢复旧会话时，保存的语言选择仍由恢复逻辑覆盖。
  const config = await getConfig();
  readerConfig.value = config;
  sourceLang.value = config.documentSourceLang || 'auto';
  targetLang.value = config.documentTargetLang || 'zh';
  literaryReview.value = config.documentLiteraryReviewEnabled !== false;
  englishFontFamily.value = config.documentEnglishFontFamily || 'Georgia';
  chineseFontFamily.value = config.documentChineseFontFamily || 'Noto Serif CJK SC';
  englishFontSize.value = Number.isFinite(config.documentEnglishFontSize) ? config.documentEnglishFontSize : 17;
  chineseFontSize.value = Number.isFinite(config.documentChineseFontSize) ? config.documentChineseFontSize : 18;
  documentSystemPromptOverride.value = config.documentSystemPromptOverride || '';
  documentSystemPromptEditor.value = documentSystemPromptOverride.value || builtInDocumentSystemPrompt.value;
  documentUserPromptTemplate.value = config.documentUserPromptTemplate || '';
  documentUserPromptEditor.value = documentUserPromptTemplate.value || BUILT_IN_USER_PROMPT_TEMPLATE;
  if (config.documentTranslationMode === 'literary') literaryMode.value = true;
  await refreshSavedSessionSummary();
  // 文档页是可继续的工作区：有已保存会话时，刷新后直接还原，不要求用户再点一次“恢复阅读”。
  if (savedSessionSummary.value || localSessionSummary.value) {
    await restoreLastSession();
  }
});

/** 将当前轻量诊断轨迹导出为 JSON，便于复现问题；不包含整段原文、译文或完整 Prompt。 */
function exportLiteraryDiagnostics() {
  const payload = {
    exportedAt: new Date().toISOString(),
    document: {
      title: doc.value?.title || '',
      format: doc.value?.format || '',
      sourceLang: sourceLang.value,
      targetLang: targetLang.value,
      literaryMode: literaryMode.value,
      localAgentEnabled: readerConfig.value?.documentUseLocalAgent === true,
      provider: readerConfig.value?.documentLocalAgentProvider || 'workbuddy',
      model: readerConfig.value?.documentLocalAgentModel || 'auto',
    },
    status: {
      bookProfileReady: literaryStatus.value.bookProfileReady,
      analyzedChapters: literaryStatus.value.analyzedChapters,
      reviewedSegments: literaryStatus.value.reviewedSegments,
      entities: literaryMemory.value.entities.length,
      characterVoices: literaryMemory.value.characterVoices.length,
      reviewFindings: literaryStatus.value.reviewFindings.length,
      warnings: literaryStatus.value.warnings,
    },
    contextGraph: {
      projectId: contextGraphState.value.projectId,
      sourceRevisionId: contextGraphState.value.sourceRevisionId,
      status: contextGraphState.value.status,
      phase: contextGraphState.value.phase,
      counts: contextGraphState.value.counts,
      progress: contextGraphState.value.progress,
      error: contextGraphState.value.error,
    },
    events: literaryStatus.value.diagnostics,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'literary-translation-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 子设置面板只提交用户实际改动的字段，避免打开第二个 Tab 时覆盖会话语言。 */
/** 将 Reviewer 的完整文风候选稿明确应用到正文，而不是只把一条建议标成已读。 */
async function applyAgentTranslations(items: Array<{ id: string; text: string }>) {
  if (!doc.value || !items.length) return;
  for (const item of items) {
    if (doc.value.segments.some((segment) => segment.id === item.id) && item.text.trim()) {
      state.value.translations.set(item.id, item.text);
      workspaceCandidateTranslations.value.delete(item.id);
    }
  }
  persistedTranslations.value = new Map(state.value.translations);
  await persistCurrentSession();
}

async function applyReviewProposal(finding: LiteraryReviewFinding) {
  if (!doc.value || !finding.proposedTranslation?.trim()) return;
  const segmentExists = doc.value.segments.some((segment) => segment.id === finding.id);
  if (!segmentExists) {
    persistenceMessage.value = '无法定位片段 ' + finding.id + '，当前文档可能已更换。';
    return;
  }
  // 文风候选一旦被用户采用，要同时成为 workspace 的人工版本，不能只留在阅读器缓存。
  if (readerConfig.value?.documentUseLocalAgent) {
    try {
      const project = await ensureDocumentWorkspace();
      if (!project) return;
      await workspaceApi(readerConfig.value.documentLocalAgentUrl || 'http://127.0.0.1:8789', readerConfig.value.documentLocalAgentToken || '',
        '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/segments/' + encodeURIComponent(finding.id) + '/translation',
        { method: 'PUT', body: JSON.stringify({ text: finding.proposedTranslation }) });
    } catch (error) {
      persistenceMessage.value = '采用候选前保存 workspace 失败：' + (error instanceof Error ? error.message : String(error));
      return;
    }
  }
  state.value.translations.set(finding.id, finding.proposedTranslation);
  workspaceCandidateTranslations.value.delete(finding.id);
  const sourceSegment = doc.value.segments.find((segment) => segment.id === finding.id);
  if (sourceSegment) {
    literaryMemory.value = refreshLiteraryExampleTargets(literaryMemory.value, [{
      source: sourceSegment.text,
      target: finding.proposedTranslation,
      chapter: sourceSegment.contextPath || currentPage.value?.title || '',
    }]);
  }
  for (const item of literaryStatus.value.reviewFindings) {
    if (item.id === finding.id && item.category === 'style' &&
        item.proposedTranslation === finding.proposedTranslation) {
      item.applicationStatus = 'applied';
    }
  }
  persistenceMessage.value = '已采用 Reviewer 候选译文：' + finding.id + '。你可以在阅读页继续编辑并导出。';
  await persistCurrentSession();
}

async function dismissReviewProposal(finding: LiteraryReviewFinding) {
  for (const item of literaryStatus.value.reviewFindings) {
    if (item.id === finding.id && item.category === 'style' &&
        item.proposedTranslation === finding.proposedTranslation) {
      item.applicationStatus = 'dismissed';
    }
  }
  persistenceMessage.value = '已保留当前译文：' + finding.id;
  await persistCurrentSession();
}

async function rereviewSegment(id: string) {
  if (!doc.value || state.value.running) return;
  const segment = doc.value.segments.find((item) => item.id === id);
  if (!segment || !state.value.translations.get(id)?.trim()) {
    persistenceMessage.value = '没有找到这段现有译文。请先翻译对应页面，再重新审校。';
    return;
  }
  activeTab.value = 'characters';
  const options = await buildTranslationOptions();
  await reviewExistingSegments([segment], options);
  if (!state.value.error) {
    persistenceMessage.value = '片段 ' + id + ' 已重新审校。纯文风候选不会自动覆盖正文，可在审校工作区中采用或保留。';
  }
}

function showReviewSegment(id: string) {
  const pageIndex = pages.value.findIndex((page) => page.segments.some((segment) => segment.id === id));
  if (pageIndex < 0) {
    persistenceMessage.value = '当前文档中找不到片段 ' + id + '。';
    return;
  }
  currentPageIndex.value = pageIndex;
  activeTab.value = 'reading';
}

/** 文档设置只更新文档专用配置，不写回网页/选中文本翻译配置。 */
function onTranslationSettingsUpdated(config: Config, changedFields: (keyof Config)[]) {
  readerConfig.value = config;
  if (changedFields.includes('documentSourceLang')) sourceLang.value = config.documentSourceLang;
  if (changedFields.includes('documentTargetLang')) targetLang.value = config.documentTargetLang;
  if (changedFields.includes('documentTranslationMode')) {
    literaryMode.value = config.documentTranslationMode === 'literary';
  }
  if (changedFields.includes('documentLiteraryReviewEnabled')) {
    literaryReview.value = config.documentLiteraryReviewEnabled;
  }
  if (!documentSystemPromptOverride.value) documentSystemPromptEditor.value = builtInDocumentSystemPrompt.value;
  if (!documentUserPromptTemplate.value) documentUserPromptEditor.value = BUILT_IN_USER_PROMPT_TEMPLATE;
}

watch([sourceLang, targetLang, literaryMode], () => {
  if (!documentSystemPromptOverride.value) documentSystemPromptEditor.value = builtInDocumentSystemPrompt.value;
});

async function saveDocumentTypography() {
  await setConfig({
    documentEnglishFontFamily: englishFontFamily.value,
    documentChineseFontFamily: chineseFontFamily.value,
    documentEnglishFontSize: englishFontSize.value,
    documentChineseFontSize: chineseFontSize.value,
  });
  readerConfig.value = await getConfig();
  persistenceMessage.value = '阅读字体设置已保存。';
}

async function saveDocumentPromptSettings() {
  const systemDraft = documentSystemPromptEditor.value.trim();
  const userDraft = documentUserPromptEditor.value.trim();
  const systemOverride = systemDraft && systemDraft !== builtInDocumentSystemPrompt.value.trim()
    ? systemDraft
    : '';
  const userTemplate = userDraft && userDraft !== BUILT_IN_USER_PROMPT_TEMPLATE.trim()
    ? userDraft
    : '';
  await setConfig({
    documentSystemPromptOverride: systemOverride,
    documentUserPromptTemplate: userTemplate,
  });
  // Prompt edits are global defaults, but the selected project's model/provider/strategy remain
  // hydrated from its server Prompt and must not be reset from the global config here.
  readerConfig.value = {
    ...(readerConfig.value || await getConfig()),
    documentSystemPromptOverride: systemOverride,
    documentUserPromptTemplate: userTemplate,
  };
  documentSystemPromptOverride.value = systemOverride;
  documentUserPromptTemplate.value = userTemplate;
  if (readerConfig.value.documentUseLocalAgent && workspaceProject.value?.projectId) {
    await workspaceApi(
      readerConfig.value.documentLocalAgentUrl || 'http://127.0.0.1:8789',
      readerConfig.value.documentLocalAgentToken || '',
      '/api/documents/projects/' + encodeURIComponent(workspaceProject.value.projectId) + '/prompts',
      { method: 'POST', body: JSON.stringify(workspacePromptInput()) },
    );
  }
  documentSystemPromptEditor.value = systemOverride || builtInDocumentSystemPrompt.value;
  documentUserPromptEditor.value = userTemplate || BUILT_IN_USER_PROMPT_TEMPLATE;
  persistenceMessage.value = '文档翻译 Prompt 已保存；新请求和强制重译会使用新设置，已有译文不会自动改写。';
}

async function restoreBuiltInDocumentPrompts() {
  await setConfig({ documentSystemPromptOverride: '', documentUserPromptTemplate: '' });
  readerConfig.value = {
    ...(readerConfig.value || await getConfig()),
    documentSystemPromptOverride: '',
    documentUserPromptTemplate: '',
  };
  documentSystemPromptOverride.value = '';
  documentUserPromptTemplate.value = '';
  documentSystemPromptEditor.value = builtInDocumentSystemPrompt.value;
  documentUserPromptEditor.value = BUILT_IN_USER_PROMPT_TEMPLATE;
  if (readerConfig.value.documentUseLocalAgent && workspaceProject.value?.projectId) {
    await workspaceApi(
      readerConfig.value.documentLocalAgentUrl || 'http://127.0.0.1:8789',
      readerConfig.value.documentLocalAgentToken || '',
      '/api/documents/projects/' + encodeURIComponent(workspaceProject.value.projectId) + '/prompts',
      { method: 'POST', body: JSON.stringify(workspacePromptInput()) },
    );
  }
  persistenceMessage.value = '已恢复内置文档翻译 Prompt，并同步到当前本机项目。';
}

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
    const base = new URL(config.documentLocalAgentUrl || 'http://127.0.0.1:8789');
    base.pathname = '/api/documents/session/summary';
    base.search = '';
    base.hash = '';
    const response = await fetch(base.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.documentLocalAgentToken ? { Authorization: 'Bearer ' + config.documentLocalAgentToken } : {}),
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
  if (!config.documentUseLocalAgent || !doc.value || localSessionDisabled) return false;

  // Local Agent projects already persist immutable source segments, accepted translations,
  // Prompt revisions, LiteraryMemory and Run history in their project SQLite database.
  // Never duplicate the whole document or memory into the generic reader-session table.
  const projectId = workspaceProject.value?.projectId as string | undefined;
  if (!projectId) return false;

  try {
    const base = new URL(config.documentLocalAgentUrl || 'http://127.0.0.1:8789');
    base.pathname = '/api/documents/session/save';
    base.search = '';
    base.hash = '';

    const payload = {
      projectBacked: true,
      projectId,
      fileName: documentFileName,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      viewMode: input.viewMode,
      literaryMode: input.literaryMode,
      currentPageIndex: input.currentPageIndex,
      translatedSegmentCount: input.translatedSegmentCount,
      // This table is only a reader-resume pointer. Project content and translation state are
      // recovered from document_projects, not copied here.
      snapshot: {
        total: input.snapshot.total,
        done: input.snapshot.done,
        failedBatches: input.snapshot.failedBatches.slice(-100),
        error: input.snapshot.error,
      },
      translationDelta: [],
    };
    const response = await fetch(base.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.documentLocalAgentToken ? { Authorization: 'Bearer ' + config.documentLocalAgentToken } : {}),
      },
      // Replace a legacy full-document checkpoint on the first pointer write; otherwise the
      // server's merge semantics could retain its obsolete document/rawText/literaryMemory.
      body: JSON.stringify({
        sessionId: LOCAL_DOCUMENT_SESSION_ID,
        title: doc.value.title || documentFileName,
        format: doc.value.format,
        mergeExisting: false,
        payload,
      }),
    });
    if (!response.ok) {
      console.debug('[document-reader] local SQLite reader pointer skipped:', response.status);
      return false;
    }

    localSessionDocumentSaved = true;
    localPersistedTranslations = new Map(input.snapshot.translations);
    localSessionSummary.value = {
      title: doc.value.title || documentFileName,
      format: doc.value.format,
      updatedAt: new Date().toISOString(),
    };
    return true;
  } catch (error) {
    console.debug('[document-reader] local SQLite checkpoint unavailable:', error);
    return false;
  }
}

async function loadDocumentCheckpointFromLocalService(): Promise<(LoadedActiveDocumentSession & { projectId?: string; sourceFingerprint?: string }) | null> {
  const config = await getConfig();
  const baseUrl = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
  const token = config.documentLocalAgentToken || '';
  try {
    // This endpoint contains only reader-resume metadata for new project-backed sessions.
    const endpoint = new URL(baseUrl);
    endpoint.pathname = '/api/documents/session/get';
    endpoint.search = '';
    endpoint.hash = '';
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
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
    if (!result.found || !payload?.snapshot) return null;

    const snapshot = payload.snapshot as Record<string, any>;
    let document: ParsedDocument;
    let sourceFingerprint: string | undefined;
    let translations: Array<[string, string]> = [];
    let literaryMemory: ReturnType<typeof getSnapshot>['literaryMemory'];

    if (payload.projectBacked === true && typeof payload.projectId === 'string') {
      // Rehydrate source, adopted translations and LiteraryMemory from the authoritative project
      // database. The generic reader-session table deliberately stores none of that content.
      const projectResponse = await workspaceApi<{ project: any }>(
        baseUrl, token,
        '/api/documents/projects/' + encodeURIComponent(payload.projectId),
      );
      document = await loadWorkspaceParsedDocument(baseUrl, token, projectResponse.project);
      sourceFingerprint = projectResponse.project.sourceFingerprint;
      const accepted = await loadWorkspaceAcceptedTranslations(
        baseUrl, token, payload.projectId, Number(projectResponse.project?.segmentCount) || document.segments.length,
      );
      translations = accepted.map((entry) => [entry.id, entry.text]);
      const memoryResponse = await workspaceApi<{ current?: { memory?: unknown } }>(
        baseUrl, token,
        '/api/documents/projects/' + encodeURIComponent(payload.projectId) + '/literary-memory',
      );
      literaryMemory = sanitizeLiteraryMemory(memoryResponse.current?.memory);
    } else {
      // Backwards compatibility for old session checkpoints created before project-backed
      // recovery. New writes never include these fields.
      if (!payload.document) return null;
      document = payload.document as ParsedDocument;
      translations = Array.isArray(snapshot.translations)
        ? snapshot.translations.filter((entry: unknown): entry is [string, string] =>
            Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
        : [];
      literaryMemory = sanitizeLiteraryMemory(snapshot.literaryMemory ?? createEmptyLiteraryMemory());
    }

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
      fileName: typeof payload.fileName === 'string'
        ? payload.fileName
        : (session?.title || document.title || 'document'),
      ...(payload.projectBacked === true && typeof payload.projectId === 'string'
        ? {
            projectId: payload.projectId,
            ...(sourceFingerprint ? { sourceFingerprint } : {}),
          }
        : {}),
      title: session?.title || document.title || '未命名文档',
      format: session?.format || document.format || 'txt',
      segmentCount: Number.isFinite(document.meta?.segmentCount) ? document.meta.segmentCount : document.segments.length,
      charCount: Number.isFinite(document.meta?.charCount)
        ? document.meta.charCount
        : document.segments.reduce((sum, segment) => sum + segment.text.length, 0),
      updatedAt: Date.parse(session?.updatedAt || '') || Date.now(),
      translatedSegmentCount: translations.length,
      total: Number.isFinite(snapshot.total) ? snapshot.total : document.segments.length,
      done: Number.isFinite(snapshot.done) ? snapshot.done : translations.length,
      currentPageIndex: Number.isFinite(payload.currentPageIndex) ? Math.max(0, Math.floor(payload.currentPageIndex)) : 0,
      activeTab: (['reading', 'settings', 'prompt', 'characters', 'agent', 'trajectory'].includes(payload.activeTab) ? payload.activeTab : 'reading') as SavedDocumentTab,
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
      analyzedChapterKeys: Array.isArray(snapshot.analyzedChapterKeys)
        ? snapshot.analyzedChapterKeys.filter((key: unknown): key is string => typeof key === 'string')
        : [],
      lastRunSegmentIds: Array.isArray(snapshot.lastRunSegmentIds)
        ? snapshot.lastRunSegmentIds.filter((id: unknown): id is string => typeof id === 'string')
        : [],
      translations,
    };
  } catch {
    return null;
  }
}

async function persistCurrentSession() {
  if (sessionPersistenceSuppressionCount > 0 || !activeSessionReady.value || !doc.value) return;
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
    activeTab: activeTab.value,
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

function currentWorkspaceDocumentKey(): string {
  return doc.value ? buildDocumentAgentSessionId(doc.value, documentFileName) : '';
}

function isWorkspaceDocumentCurrent(documentKey: string, generation: number): boolean {
  return !!documentKey &&
    workspaceDocumentGeneration === generation &&
    currentWorkspaceDocumentKey() === documentKey;
}

/** Clear only ephemeral project bindings; durable service projects are never deleted here. */
function resetWorkspaceBindingForDocument(): void {
  workspaceDocumentGeneration++;
  localAgentImportBinding = null;
  ensureWorkspacePromise = null;
  ensureWorkspacePromiseKey = null;
  workspaceProject.value = null;
  workspaceActiveRun.value = null;
  workspaceSourceChanged.value = false;
  workspaceRunId.value = '';
  workspaceTranslationActive.value = false;
  workspaceRunGeneration.value++;
  workspaceCandidateTranslations.value = new Map();
  resetContextGraph();
  stopAgentTrajectoryPolling();
  agentTrajectoryEvents.value = [];
  agentTrajectoryCursor.value = 0;
  agentTrajectoryLoading.value = false;
  agentTrajectoryError.value = '';
}

async function restoreLastSession() {
  loadedSourceFile.value = null;
  parsing.value = true;
  parseError.value = '';
  persistenceMessage.value = '';
  try {
    const restoreConfig = await getConfig();
    readerConfig.value = restoreConfig;
    let saved: (LoadedActiveDocumentSession & { projectId?: string; sourceFingerprint?: string }) | null = null;
    let restoredFromLocalService = false;

    // When Local Agent is enabled, prefer its lightweight project pointer over an older IndexedDB
    // copy. It rehydrates server-owned EPUB/PDF segments and accepted translations from SQLite.
    if (restoreConfig.documentUseLocalAgent) {
      try {
        saved = await loadDocumentCheckpointFromLocalService();
        restoredFromLocalService = !!saved;
      } catch { /* fall back to the extension copy when the service is unavailable */ }
    }
    if (!saved) {
      try { saved = await loadActiveDocumentSession(); } catch { /* local SQLite may recover the session below */ }
    }
    if (!saved && !restoredFromLocalService) {
      try {
        saved = await loadDocumentCheckpointFromLocalService();
        restoredFromLocalService = !!saved;
      } catch { /* report the missing snapshot below */ }
    }
    if (!saved) {
      savedSessionSummary.value = null;
      persistenceMessage.value = '没有可恢复的阅读记录。';
      return;
    }

    resetWorkspaceBindingForDocument();
    suppressWorkspacePromptSync = true;
    suppressWorkspaceAutoEnsure = true;
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
    if (restoredFromLocalService && saved.projectId) {
      localAgentImportBinding = {
        documentKey: buildDocumentAgentSessionId(saved.document, saved.fileName),
        projectId: saved.projectId,
        createdNewProject: false,
        sourceFingerprint: saved.sourceFingerprint,
      };
      try {
        await rememberWorkspaceProject(workspaceInput(), saved.projectId, saved.sourceFingerprint);
      } catch {
        // The checkpoint projectId remains authoritative even when extension map persistence fails.
      }
    }
    glossary.value = saved.glossary;
    sourceLang.value = saved.sourceLang;
    targetLang.value = saved.targetLang;
    viewMode.value = saved.viewMode;
    activeTab.value = saved.activeTab || 'reading';
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
          activeTab: activeTab.value,
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

    // First hydrate from the service, then use IndexedDB / the SQLite session checkpoint as a
    // local cache. If the service is offline, keep the restored local snapshot without pushing it
    // back into a project when connectivity returns.
    try {
      let project = await refreshExistingWorkspaceFromService();
      if (readerConfig.value?.documentUseLocalAgent && doc.value &&
          !project && !workspaceSourceChanged.value) {
        project = await ensureDocumentWorkspace();
      }
      const activeRun = workspaceActiveRun.value;
      if (readerConfig.value?.documentUseLocalAgent && project && activeRun &&
          ['queued', 'running', 'awaiting_acceptance', 'partial'].includes(activeRun.status)) {
        void followWorkspaceRun(project, activeRun);
      }
      if (readerConfig.value?.documentUseLocalAgent && activeTab.value === 'trajectory') {
        void startAgentTrajectoryPolling();
      }
    } catch (error) {
      persistenceMessage.value = '阅读会话已恢复，Local Agent 暂不可用；当前显示扩展保存的备份副本。恢复服务后会重新同步。' +
        (error instanceof Error ? ' ' + error.message : '');
    }
    await persistCurrentSession();
  } catch (error) {
    parseError.value = '恢复上次阅读失败：' +
      (error instanceof Error ? error.message : String(error));
  } finally {
    suppressWorkspacePromptSync = false;
    suppressWorkspaceAutoEnsure = false;
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
    const base = new URL(config.documentLocalAgentUrl || 'http://127.0.0.1:8789');
    base.pathname = '/api/documents/session/' + encodeURIComponent(LOCAL_DOCUMENT_SESSION_ID);
    base.search = '';
    base.hash = '';
    const response = await fetch(base.toString(), {
      method: 'DELETE',
      headers: {
        ...(config.documentLocalAgentToken ? { Authorization: 'Bearer ' + config.documentLocalAgentToken } : {}),
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
  suppressWorkspacePromptSync = true;
  suppressWorkspaceAutoEnsure = true;
  // 先落盘上一册的最新状态，再开始解析新文件；此时仍保留旧文档身份。
  await persistCurrentSession();
  await stopCurrentTranslation();
  resetWorkspaceBindingForDocument();
  loadedSourceFile.value = file;
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
    const config = await getConfig();
    readerConfig.value = config;
    sourceLang.value = config.documentSourceLang || 'auto';
    targetLang.value = config.documentTargetLang || 'zh';

    // With Local Agent enabled, the service receives the original EPUB/PDF bytes and owns
    // parsing, segmentation and SQLite persistence. The extension only pages back segments
    // needed to render the reader; it no longer parses the binary or posts a whole-book JSON.
    if (config.documentUseLocalAgent && /\.(pdf|epub)$/i.test(file.name)) {
      progress.value = { done: 0, total: 1 };
      const base = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
      const token = config.documentLocalAgentToken || '';
      const imported = await importDocumentFileViaLocalAgent(base, token, file);
      rawText = '';
      if (imported.sourceChanged && imported.document && imported.relatedProject?.projectId) {
        doc.value = parsedDocumentFromLocalAgentPreview(imported.document);
        localAgentImportBinding = {
          documentKey: buildDocumentAgentSessionId(doc.value, documentFileName),
          projectId: imported.relatedProject.projectId,
          createdNewProject: false,
          sourceChanged: true,
        };
      } else if (imported.project?.projectId) {
        doc.value = await loadWorkspaceParsedDocument(base, token, imported.project);
        localAgentImportBinding = {
          documentKey: buildDocumentAgentSessionId(doc.value, documentFileName),
          projectId: imported.project.projectId,
          createdNewProject: imported.reusedExisting !== true,
          sourceFingerprint: imported.project.sourceFingerprint,
        };
      } else {
        throw new Error('本机服务没有返回已解析的文档项目。');
      }
      progress.value = { done: 1, total: 1 };
    } else {
      // Remote-only / offline translation keeps the existing extension parser. In Local Agent
      // mode, EPUB/PDF never falls back to browser parsing on a server import error.
      const isBinary = /\.(pdf|docx|epub)$/i.test(file.name);
      const input = isBinary
        ? { fileName: file.name, mime: file.type, arrayBuffer: await file.arrayBuffer() }
        : { fileName: file.name, mime: file.type, text: await file.text() };
      rawText = input.text ?? '';
      doc.value = await parseDocument(input, {
        onProgress: (done, total) => { progress.value = { done, total }; },
      });
    }
    // EPUB/PDF 默认启用书籍级实体记忆和独立文风审校；用户可以在工具栏关闭。
    literaryMode.value = doc.value.format === 'epub' || doc.value.format === 'pdf';
    // 术语抽取不需要扫描整本书：限制在前 12,000 个字符，避免超长 EPUB
    // 在首次显示阅读器前把整本内容拼接、复制并交给 NLP 分析。重试继续复用这份结果。
    if (config.documentUseLocalAgent && /^(epub|pdf)$/i.test(doc.value.format) && literaryMode.value) {
      // Literary EPUB/PDF terminology and canonical names come from Local Agent's project
      // memory/Context Graph. Do not run a second extension-side heuristic glossary pipeline.
      glossary.value = undefined;
    } else {
      const glossaryLimit = 12_000;
      let glossarySample = '';
      for (const segment of doc.value.segments) {
        if (glossarySample.length >= glossaryLimit) break;
        const remaining = glossaryLimit - glossarySample.length;
        glossarySample += segment.text.slice(0, remaining) + '\n';
      }
      glossary.value = extractGlossaryLocal(glossarySample);
    }
    // Re-selecting the same file restores the active IndexedDB reading session before a new
    // empty session replaces it. Translation cache remains a fallback for documents without a
    // matching saved reader session.
    let previousSession: LoadedActiveDocumentSession | null = null;
    try { previousSession = await loadActiveDocumentSession(); } catch { /* cache still supports reuse */ }
    const localAgentOwnsSelectedSource = config.documentUseLocalAgent === true &&
      /\.(?:epub|pdf)$/i.test(file.name);
    const sameServerSourceSegments = !!previousSession && !!doc.value &&
      previousSession.document.segments.length === doc.value.segments.length &&
      previousSession.document.segments.every((segment, index) =>
        segment.id === doc.value!.segments[index]?.id &&
        segment.text === doc.value!.segments[index]?.text,
      );
    if (previousSession &&
        previousSession.fileName === documentFileName &&
        buildDocumentAgentSessionId(previousSession.document, previousSession.fileName) ===
          buildDocumentAgentSessionId(doc.value, documentFileName) &&
        (!localAgentOwnsSelectedSource || sameServerSourceSegments)) {
      // Local Agent owns EPUB/PDF source segments. Reuse the old reader snapshot only when the
      // segment IDs and text are identical, and never replace service-parsed metadata with an
      // older browser-parser document object. Legacy translations can still be migrated for a
      // newly created project when they map to the exact same source segments.
      if (!localAgentOwnsSelectedSource) {
        doc.value = previousSession.document;
        rawText = previousSession.rawText;
        glossary.value = previousSession.glossary;
      }
      sourceLang.value = previousSession.sourceLang;
      targetLang.value = previousSession.targetLang;
      viewMode.value = previousSession.viewMode;
      literaryMode.value = previousSession.literaryMode;
      currentPageIndex.value = Math.min(
        Math.max(0, previousSession.currentPageIndex),
        Math.max(0, buildDocumentPages(previousSession.document).length - 1),
      );
      persistedTranslations.value = new Map(previousSession.translations);
      localPersistedTranslations = new Map<string, string>();
      localSessionDocumentSaved = false;
      localSessionDisabled = false;
      restoreSnapshot({
        translations: previousSession.translations,
        total: previousSession.total,
        done: previousSession.done,
        failedBatches: previousSession.failedBatches,
        error: previousSession.error,
        literaryMemory: previousSession.literaryMemory,
        literaryStatus: previousSession.literaryStatus,
        analyzedChapterKeys: previousSession.analyzedChapterKeys,
        lastRunSegmentIds: previousSession.lastRunSegmentIds,
      });
      activeSessionIndexedDbWritable = true;
      activeSessionReady.value = true;
      savedSessionSummary.value = await getActiveDocumentSessionSummary();
      persistenceMessage.value = '已恢复这份文档上次的阅读位置、译文和书籍记忆。需要重新生成译文时，点击“强制重译当前页”。';
      try {
          await refreshExistingWorkspaceFromService();
        savedSessionSummary.value = await getActiveDocumentSessionSummary();
      } catch (error) {
        persistenceMessage.value = '已恢复扩展本地副本；本机服务暂不可用，恢复连接后将重新同步。' +
          (error instanceof Error ? ' ' + error.message : '');
      }
      return;
    }

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
        activeTab: activeTab.value,
      });
      activeSessionIndexedDbWritable = true;
      activeSessionReady.value = true;
      let synchronizedFromService = false;
      try {
        synchronizedFromService = !!(await refreshExistingWorkspaceFromService());
      } catch (error) {
        // The service is unavailable, so preserve this parsed document as an offline backup.
        persistenceMessage.value = '文档已打开并保留扩展副本；本机服务暂不可用，恢复连接后将重新同步。' +
          (error instanceof Error ? ' ' + error.message : '');
      }
      // Do not persist the initial empty snapshot before a matching service project has been
      // checked. If no project exists or the service is offline, this becomes the backup copy.
      if (!synchronizedFromService) await persistCurrentSession();
      savedSessionSummary.value = await getActiveDocumentSessionSummary();
    } catch (storageError) {
      // 文件已在内存解析完成。即使 IndexedDB 无法创建，也尝试先建立 SQLite 恢复副本。
      activeSessionIndexedDbWritable = false;
      activeSessionReady.value = true;
      persistenceMessage.value = '扩展本地会话创建失败，正在尝试保存到本机 SQLite。' +
        (storageError instanceof Error ? ' ' + storageError.message : '');
      let synchronizedFromService = false;
      try {
        synchronizedFromService = !!(await refreshExistingWorkspaceFromService());
      } catch (error) {
        persistenceMessage.value = '本机服务暂不可用，继续保留当前内存文档；服务恢复后重新同步。' +
          (error instanceof Error ? ' ' + error.message : '');
      }
      if (!synchronizedFromService) await persistCurrentSession();
      await refreshLocalSessionSummary();
    }
  } catch (err) {
    parseError.value = (err as Error).message;
  } finally {
    suppressWorkspacePromptSync = false;
    suppressWorkspaceAutoEnsure = false;
    parsing.value = false;
    if (doc.value && readerConfig.value?.documentUseLocalAgent === true &&
        effectiveDocumentTranslationMode.value === 'literary') {
      void ensureDocumentWorkspace().catch((error) => {
        persistenceMessage.value = '无法准备本机文学翻译项目：' +
          (error instanceof Error ? error.message : String(error));
      });
    }
  }
}

/**
 * Stable, opaque identity for a parsed document. The same book gets the same local Agent
 * session scope after page reload/SQLite restore, while different books do not share SDK history.
 * This fingerprint never sends raw document text as an ID; only the hash leaves the extension.
 */
/** 所有翻译入口共用同一份设置，重试时保持 provider、术语表和服务端模式不变。 */
async function buildTranslationOptions() {
  if (!doc.value) throw new Error('尚未打开文档');
  const config = await getConfig();
  readerConfig.value = config;
  return {
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
    glossary: glossary.value,
    promptStyle: config.documentPromptStyle,
    translationMode: effectiveDocumentTranslationMode.value,
    // Send exactly the prompt shown in this editor even when the user is using built-in defaults.
    // This keeps local Agent and direct server/provider request formats consistent and editable.
    documentSystemPromptOverride: config.documentSystemPromptOverride?.trim() || builtInDocumentSystemPrompt.value,
    documentUserPromptTemplate: config.documentUserPromptTemplate?.trim() || BUILT_IN_USER_PROMPT_TEMPLATE,
    // 文档本身始终先在本机解析。useServerTranslation 只决定规整后的片段在哪里翻译。
    useServerTranslation: config.documentUseServerTranslation && !config.documentUseLocalAgent,
    useLocalAgent: config.documentUseLocalAgent,
    localAgentProvider: config.documentLocalAgentProvider,
    localAgentUrl: config.documentLocalAgentUrl,
    localAgentModel: config.documentLocalAgentModel,
    localAgentToken: config.documentLocalAgentToken,
    codeBuddyTaskProfiles: config.documentCodeBuddyTaskProfiles,
    // Global literary profile enables entity/style memory for any structured document;
    // the EPUB/PDF checkbox remains an opt-in for users on the technical profile.
    literaryMode: effectiveDocumentTranslationMode.value === 'literary',
    skipReview: !literaryReview.value,
    // 本地与 vocal-saga 服务端翻译都按批执行，先提交当前阅读页的译文。
    prioritySegmentIds: currentPage.value?.segments.map((segment) => segment.id) ?? [],
    serverUrl: config.documentServerUrl,
    provider: config.documentProvider,
    apiKey: config.documentDeepseekApiKey,
    documentFileName,
    documentSessionId: buildDocumentAgentSessionId(doc.value, documentFileName),
    documentTitle: doc.value.title,
    documentFormat: doc.value.format,
    documentWarnings: doc.value.meta.warnings,
    onCheckpoint: persistCurrentSession,
  };
}

function workspaceInput() {
  if (!doc.value) throw new Error('尚未打开文档');
  return {
    title: doc.value.title,
    format: doc.value.format,
    sourceFileName: documentFileName,
    segments: doc.value.segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      kind: segment.kind,
      contextPath: segment.contextPath,
      page: segment.page,
      level: segment.level,
      marker: segment.marker,
      path: (segment as any).path,
      start: segment.start,
      end: segment.end,
    })),
  };
}

function workspacePromptInput() {
  const config = readerConfig.value;
  return {
    systemPrompt: documentSystemPromptEditor.value || builtInDocumentSystemPrompt.value,
    userPromptTemplate: documentUserPromptEditor.value || BUILT_IN_USER_PROMPT_TEMPLATE,
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
    provider: config?.documentLocalAgentProvider || 'workbuddy',
    model: config?.documentLocalAgentModel || 'auto',
    taskProfiles: config?.documentCodeBuddyTaskProfiles,
    translationMode: effectiveDocumentTranslationMode.value as 'technical' | 'literary',
    literaryReview: effectiveDocumentTranslationMode.value === 'literary' && literaryReview.value,
    glossary: glossary.value,
    translationStrategy: {
      maxBatchSegments: config?.documentBatchMaxSegments ?? 16,
      maxBatchSourceChars: config?.documentBatchMaxSourceChars ?? 8000,
      translationConcurrency: config?.documentTranslationConcurrency ?? 4,
      reviewConcurrency: config?.documentReviewConcurrency ?? 2,
      precedingContextSegments: config?.documentPrecedingContextSegments ?? 4,
      contextBudgetChars: config?.documentContextBudgetChars ?? 18000,
      maxModelAttempts: config?.documentMaxModelAttempts ?? 2,
    },
  };
}

async function replaceCurrentTranslations(items: Array<{ id: string; text: string }>) {
  if (!doc.value) return;
  const validIds = new Set(doc.value.segments.map((segment) => segment.id));
  const next = new Map<string, string>();
  for (const item of items) {
    if (validIds.has(item.id) && item.text.trim()) next.set(item.id, item.text);
  }
  state.value.translations.clear();
  for (const [id, text] of next) state.value.translations.set(id, text);
  workspaceCandidateTranslations.value = new Map();
  persistedTranslations.value = new Map(next);
  await persistCurrentSession();
}

async function syncWorkspaceTranslations(items: Array<{ id: string; text: string }>) {
  if (workspaceSourceChanged.value) workspaceSourceChanged.value = false;
  await replaceCurrentTranslations(items);
}

async function refreshWorkspaceLiteraryMemory(
  projectId: string,
  baseUrl?: string,
  token?: string,
  expectedDocumentKey = currentWorkspaceDocumentKey(),
  expectedGeneration = workspaceDocumentGeneration,
): Promise<void> {
  if (!projectId) return;
  const config = readerConfig.value || await getConfig();
  if (!isWorkspaceDocumentCurrent(expectedDocumentKey, expectedGeneration)) return;
  const response = await workspaceApi<{ current?: { memory?: unknown } }>(
    baseUrl || config.documentLocalAgentUrl || 'http://127.0.0.1:8789',
    token ?? config.documentLocalAgentToken ?? '',
    '/api/documents/projects/' + encodeURIComponent(projectId) + '/literary-memory',
  );
  if (!isWorkspaceDocumentCurrent(expectedDocumentKey, expectedGeneration)) return;
  literaryMemory.value = sanitizeLiteraryMemory(response.current?.memory);
  await persistCurrentSession();
}



watch([
  sourceLang,
  targetLang,
  effectiveDocumentTranslationMode,
  literaryReview,
  () => JSON.stringify(glossary.value),
  () => readerConfig.value?.documentLocalAgentProvider,
  () => readerConfig.value?.documentLocalAgentModel,
  () => readerConfig.value?.documentUseLocalAgent,
  () => JSON.stringify(readerConfig.value?.documentCodeBuddyTaskProfiles),
  () => readerConfig.value?.documentBatchMaxSegments,
  () => readerConfig.value?.documentBatchMaxSourceChars,
  () => readerConfig.value?.documentTranslationConcurrency,
  () => readerConfig.value?.documentReviewConcurrency,
  () => readerConfig.value?.documentPrecedingContextSegments,
  () => readerConfig.value?.documentContextBudgetChars,
  () => readerConfig.value?.documentMaxModelAttempts,
], async (next, previous) => {
  if (next.every((value, index) => value === previous[index])) return;
  const nextTranslationMode = next[2];
  if (suppressWorkspacePromptSync || !activeSessionReady.value ||
      readerConfig.value?.documentUseLocalAgent !== true || !workspaceProject.value?.projectId) return;
  const config = readerConfig.value;
  const projectId = workspaceProject.value.projectId as string;
  const base = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
  const token = config.documentLocalAgentToken || '';
  try {
    // Explicit settings edits update the persisted Prompt used by future Runs. Run creation itself
    // submits only scope, so stale UI config must not silently replace the service's current Prompt.
    await workspaceApi(
      base, token,
      '/api/documents/projects/' + encodeURIComponent(projectId) + '/prompts',
      { method: 'POST', body: JSON.stringify(workspacePromptInput()) },
    );
    if (workspaceProject.value?.projectId !== projectId) return;
    const graphContextChanged = next[0] !== previous[0] ||
      next[1] !== previous[1] || next[2] !== previous[2];
    if (nextTranslationMode === 'literary' && graphContextChanged) {
      // This is display state only. The Local Agent Run worker owns preprocessing and readiness.
      await refreshContextGraphStatus(workspaceProject.value, true);
    }
  } catch (error) {
    if (workspaceProject.value?.projectId === projectId) {
      persistenceMessage.value = '更新文档项目 Prompt 失败：' + (error instanceof Error ? error.message : String(error));
    }
  }
});

async function handleAgentWorkspaceProjectUpdated(project: any, sourceChanged = false) {
  if (!project?.projectId) return;
  const expectedDocumentKey = currentWorkspaceDocumentKey();
  const expectedGeneration = workspaceDocumentGeneration;
  if (!isWorkspaceDocumentCurrent(expectedDocumentKey, expectedGeneration)) return;
  workspaceProject.value = project;
  workspaceSourceChanged.value = sourceChanged;
  if (sourceChanged) {
    persistenceMessage.value = '本机服务中的项目原文版本与当前文档不同；旧译文不会自动应用。请明确更新来源版本或另建项目。';
    return;
  }

  sessionPersistenceSuppressionCount++;
  let stateHydrated = false;
  const isCurrent = () => isWorkspaceDocumentCurrent(expectedDocumentKey, expectedGeneration);
  try {
    const config = readerConfig.value || await getConfig();
    if (!isCurrent()) return;
    readerConfig.value = config;
    const base = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
    const token = config.documentLocalAgentToken || '';

    // Agent tab may be the first place that discovers a project. Hydrate Prompt and memory
    // from SQLite here too; never let the local props/session snapshot overwrite the project.
    await hydrateWorkspacePrompt(base, token, project.projectId, expectedDocumentKey, expectedGeneration);
    if (!isCurrent()) return;
    await refreshWorkspaceLiteraryMemory(project.projectId, base, token, expectedDocumentKey, expectedGeneration);
    if (!isCurrent()) return;

    const refreshed = await workspaceApi<{ project: any; runs?: any[] }>(
      base, token, '/api/documents/projects/' + encodeURIComponent(project.projectId),
    );
    if (!isCurrent()) return;
    workspaceProject.value = refreshed.project;
    workspaceActiveRun.value = (refreshed.runs || []).find((run) =>
      ['queued', 'running', 'awaiting_acceptance', 'partial', 'paused'].includes(run.status)) || null;

    const accepted = await loadWorkspaceAcceptedTranslations(
      base, token, project.projectId, refreshed.project.segmentCount || doc.value?.segments.length || 0,
    );
    if (!isCurrent()) return;
    await replaceCurrentTranslations(accepted);
    stateHydrated = true;

    // Refresh the status projection only. Never start full-book analysis during hydration.
    await refreshContextGraphStatus(refreshed.project, true);
  } catch (error) {
    if (isCurrent()) {
      persistenceMessage.value = '同步本机项目状态失败：' + (error instanceof Error ? error.message : String(error));
    }
  } finally {
    sessionPersistenceSuppressionCount = Math.max(0, sessionPersistenceSuppressionCount - 1);
    if (stateHydrated && isCurrent()) await persistCurrentSession();
  }
}

/** 合并并发的阅读器初始化，防止自动预处理与用户点击翻译同时创建同一本书的项目。 */
async function ensureDocumentWorkspace(): Promise<any | null> {
  const documentKey = currentWorkspaceDocumentKey();
  const generation = workspaceDocumentGeneration;
  if (!documentKey) return null;
  if (ensureWorkspacePromise && ensureWorkspacePromiseKey === documentKey) return ensureWorkspacePromise;
  const pending = ensureDocumentWorkspaceInternal(true, documentKey, generation);
  ensureWorkspacePromise = pending;
  ensureWorkspacePromiseKey = documentKey;
  try {
    return await pending;
  } finally {
    if (ensureWorkspacePromise === pending) {
      ensureWorkspacePromise = null;
      ensureWorkspacePromiseKey = null;
    }
  }
}

/**
 * Hydrate the current reader controls from the latest persisted project Prompt.
 * These values are project/session scoped: do not write them into global extension configuration.
 */
async function hydrateWorkspacePrompt(
  baseUrl: string,
  token: string,
  projectId: string,
  expectedDocumentKey = currentWorkspaceDocumentKey(),
  expectedGeneration = workspaceDocumentGeneration,
): Promise<void> {
  const response = await workspaceApi<{ prompts?: any[] }>(
    baseUrl, token,
    '/api/documents/projects/' + encodeURIComponent(projectId) + '/prompts',
  );
  if (!isWorkspaceDocumentCurrent(expectedDocumentKey, expectedGeneration)) return;
  const prompt = response.prompts?.[0];
  if (!prompt) return;
  const promptConfig = prompt.config && typeof prompt.config === 'object' ? prompt.config : {};
  const strategy = promptConfig.translationStrategy && typeof promptConfig.translationStrategy === 'object'
    ? promptConfig.translationStrategy : {};

  suppressWorkspacePromptSync = true;
  try {
    sourceLang.value = typeof promptConfig.sourceLang === 'string' ? promptConfig.sourceLang : sourceLang.value;
    targetLang.value = typeof promptConfig.targetLang === 'string' ? promptConfig.targetLang : targetLang.value;
    literaryMode.value = promptConfig.translationMode === 'literary';
    literaryReview.value = promptConfig.literaryReview === true;
    if (promptConfig.glossary) glossary.value = promptConfig.glossary as Glossary;
    readerConfig.value = {
      ...(readerConfig.value || await getConfig()),
      documentTranslationMode: promptConfig.translationMode === 'literary' ? 'literary' : 'technical',
      documentLocalAgentProvider: promptConfig.provider === 'opencode' ? 'opencode' : 'workbuddy',
      documentLocalAgentModel: typeof promptConfig.model === 'string' ? promptConfig.model : 'auto',
      documentBatchMaxSegments: Number.isFinite(strategy.maxBatchSegments) ? strategy.maxBatchSegments : readerConfig.value?.documentBatchMaxSegments,
      documentBatchMaxSourceChars: Number.isFinite(strategy.maxBatchSourceChars) ? strategy.maxBatchSourceChars : readerConfig.value?.documentBatchMaxSourceChars,
      documentTranslationConcurrency: Number.isFinite(strategy.translationConcurrency) ? strategy.translationConcurrency : readerConfig.value?.documentTranslationConcurrency,
      documentReviewConcurrency: Number.isFinite(strategy.reviewConcurrency) ? strategy.reviewConcurrency : readerConfig.value?.documentReviewConcurrency,
      documentPrecedingContextSegments: Number.isFinite(strategy.precedingContextSegments) ? strategy.precedingContextSegments : readerConfig.value?.documentPrecedingContextSegments,
      documentContextBudgetChars: Number.isFinite(strategy.contextBudgetChars) ? strategy.contextBudgetChars : readerConfig.value?.documentContextBudgetChars,
      documentMaxModelAttempts: Number.isFinite(strategy.maxModelAttempts) ? strategy.maxModelAttempts : readerConfig.value?.documentMaxModelAttempts,
    };
    documentSystemPromptOverride.value = typeof prompt.systemPrompt === 'string' ? prompt.systemPrompt : '';
    documentUserPromptTemplate.value = typeof prompt.userPromptTemplate === 'string' ? prompt.userPromptTemplate : '';
    await nextTick();
    if (!isWorkspaceDocumentCurrent(expectedDocumentKey, expectedGeneration)) return;
    documentSystemPromptEditor.value = documentSystemPromptOverride.value || builtInDocumentSystemPrompt.value;
    documentUserPromptEditor.value = documentUserPromptTemplate.value || BUILT_IN_USER_PROMPT_TEMPLATE;
  } finally {
    suppressWorkspacePromptSync = false;
  }
}

/**
 * Refresh an existing service-backed project on document open/restore, without creating a new one.
 * A failed service request leaves the last local snapshot intact as an offline backup.
 */
async function refreshExistingWorkspaceFromService(): Promise<any | null> {
  const documentKey = currentWorkspaceDocumentKey();
  const generation = workspaceDocumentGeneration;
  if (!documentKey) return null;
  if (ensureWorkspacePromise && ensureWorkspacePromiseKey === documentKey) return ensureWorkspacePromise;
  const pending = ensureDocumentWorkspaceInternal(false, documentKey, generation);
  ensureWorkspacePromise = pending;
  ensureWorkspacePromiseKey = documentKey;
  try {
    return await pending;
  } finally {
    if (ensureWorkspacePromise === pending) {
      ensureWorkspacePromise = null;
      ensureWorkspacePromiseKey = null;
    }
  }
}

/** 保证只有一份本机项目：导入旧阅读记录、刷新 SQLite 的当前版本，并备份原件。 */
async function ensureDocumentWorkspaceInternal(
  createIfMissing = true,
  expectedDocumentKey = currentWorkspaceDocumentKey(),
  expectedGeneration = workspaceDocumentGeneration,
): Promise<any | null> {
  if (!isWorkspaceDocumentCurrent(expectedDocumentKey, expectedGeneration)) return null;
  const input = workspaceInput();
  const initialPrompt = workspacePromptInput();
  const legacyTranslations = new Map(state.value.translations);
  const legacyMemory = sanitizeLiteraryMemory(JSON.parse(JSON.stringify(literaryMemory.value)));
  const sourceFileAtStart = loadedSourceFile.value;
  const isCurrent = () => isWorkspaceDocumentCurrent(expectedDocumentKey, expectedGeneration);
  const config = await getConfig();
  if (!isCurrent()) return null;
  readerConfig.value = config;
  if (!config.documentUseLocalAgent && createIfMissing) return null;
  const base = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
  const token = config.documentLocalAgentToken || '';

  // The extension map is only a hint. Always ask the service to compare the current parsed
  // source against its authoritative fingerprint, even when a local mapping exists. The project
  // might have been updated from another UI since this extension snapshot was saved.
  const importBinding = localAgentImportBinding?.documentKey === expectedDocumentKey
    ? localAgentImportBinding
    : null;
  const mapping = importBinding
    ? { projectId: importBinding.projectId, sourceChanged: false, documentKey: expectedDocumentKey }
    : await lookupWorkspaceProject(input);
  if (!isCurrent()) return null;
  let mappedProject: any = null;
  let mappedDetails: { project: any; runs?: any[] } | null = null;
  if (mapping.projectId) {
    try {
      mappedDetails = await workspaceApi<{ project: any; runs?: any[] }>(
        base, token, '/api/documents/projects/' + encodeURIComponent(mapping.projectId),
      );
      if (!isCurrent()) return null;
      mappedProject = mappedDetails.project;
    } catch (error) {
      if (!isCurrent()) return null;
      // Only a definitive 404 permits discovery recovery. Network/auth failures must preserve the
      // local backup and must never be reinterpreted as a nonexistent project.
      if (!(error instanceof WorkspaceApiError) || error.status !== 404) throw error;
    }
  }

  // Resolve on every open/restore. If a mapped project still exists but no longer has the exact
  // current source fingerprint, it is a source-change candidate, not a valid translation source.
  if (importBinding && !mappedProject) {
    throw new Error('本机服务已导入文件，但对应项目不存在；请重新选择文件导入。');
  }
  const isLocalAgentBook = config.documentUseLocalAgent === true &&
    /^(epub|pdf)$/i.test(input.format);
  if (importBinding?.sourceChanged && mappedProject) {
    workspaceProject.value = mappedProject;
    workspaceActiveRun.value = (mappedDetails?.runs || []).find((run) =>
      ['queued', 'running', 'awaiting_acceptance', 'partial', 'paused'].includes(run.status)) || null;
    workspaceSourceChanged.value = true;
    persistenceMessage.value = '本机服务中存在同名但原文不同的项目。请在 Agent 面板明确更新来源版本或另建项目；解析由本机服务负责。';
    activeTab.value = 'agent';
    return null;
  }
  let resolution: { exactProject: any | null; relatedProject: any | null };
  if (importBinding) {
    resolution = { exactProject: mappedProject, relatedProject: null };
  } else if (isLocalAgentBook && !sourceFileAtStart) {
    // After restoration the source file bytes may no longer be in the browser session. Use the
    // durable exact mapping and its recorded server fingerprint; never upload the whole book
    // again just to resolve a project. A legacy mapping without a baseline fingerprint is kept
    // for compatibility, but any new mapping records the server fingerprint.
    if (!mappedProject) {
      persistenceMessage.value = '本机项目映射不可用，无法在不重传原文件的情况下安全确认 EPUB/PDF 来源。请重新选择原始文件；本机服务会负责解析。';
      return null;
    }
    const fingerprintChanged = !!mapping.sourceFingerprint &&
      mapping.sourceFingerprint !== mappedProject.sourceFingerprint;
    resolution = fingerprintChanged || mapping.sourceChanged
      ? { exactProject: null, relatedProject: mappedProject }
      : { exactProject: mappedProject, relatedProject: null };
  } else if (isLocalAgentBook) {
    // In Local Agent mode raw EPUB/PDF imports must pass through import-file. Falling back to
    // a full-book JSON resolve would reintroduce the payload-size problem this path removes.
    if (!importBinding && sourceFileAtStart) {
      persistenceMessage.value = '本机服务尚未完成原文件导入。请重新选择该 EPUB/PDF 文件重试。';
      return null;
    }
    resolution = { exactProject: null, relatedProject: null };
  } else {
    resolution = await resolveWorkspaceProject(base, token, input);
  }
  if (!isCurrent()) return null;
  let project: any = null;
  let projectDetails: { project: any; runs?: any[] } | null = null;
  let sourceChanged = false;
  if (resolution.exactProject?.projectId) {
    // Preserve an explicit project choice when two projects contain the same source revision.
    // Otherwise follow the service's exact-source result and repair the local mapping.
    if (mappedProject &&
        mappedProject.sourceFingerprint === resolution.exactProject.sourceFingerprint) {
      project = mappedProject;
      projectDetails = mappedDetails;
    } else {
      projectDetails = await workspaceApi<{ project: any; runs?: any[] }>(
        base, token, '/api/documents/projects/' + encodeURIComponent(resolution.exactProject.projectId),
      );
      if (!isCurrent()) return null;
      project = projectDetails.project;
    }
    if (mapping.projectId !== project.projectId || importBinding) {
      await rememberWorkspaceProject(input, project.projectId, project.sourceFingerprint);
    }
  } else if (mappedProject) {
    project = mappedProject;
    projectDetails = mappedDetails;
    sourceChanged = true;
  } else if (resolution.relatedProject?.projectId) {
    projectDetails = await workspaceApi<{ project: any; runs?: any[] }>(
      base, token, '/api/documents/projects/' + encodeURIComponent(resolution.relatedProject.projectId),
    );
    if (!isCurrent()) return null;
    project = projectDetails.project;
    sourceChanged = true;
  }

  if (!isCurrent()) return null;
  if (sourceChanged && project) {
    workspaceProject.value = project;
    workspaceActiveRun.value = (projectDetails?.runs || []).find((run) =>
      ['queued', 'running', 'awaiting_acceptance', 'partial', 'paused'].includes(run.status)) || null;
    workspaceSourceChanged.value = true;
    persistenceMessage.value = '本机服务中存在关联文档，但当前原文指纹与其保存的来源版本不同。请选择更新来源版本或另建项目；旧译文不会自动套用。';
    if (config.documentUseLocalAgent) activeTab.value = 'agent';
    return null;
  }

  if (!project && !createIfMissing) return null;

  let createdNewProject = importBinding?.createdNewProject ?? false;
  if (!project) {
    if (!isCurrent()) return null;
    if (isLocalAgentBook) {
      persistenceMessage.value = '本机服务模式下 EPUB/PDF 必须通过原始文件导入，不能回退到整本片段 JSON。请重新选择原文件后再试。';
      return null;
    }
    const created = await workspaceApi<{ project: any; reusedExisting?: boolean }>(base, token, '/api/documents/projects', {
      method: 'POST',
      body: JSON.stringify({ ...input, prompt: initialPrompt }),
    });
    project = created.project;
    createdNewProject = created.reusedExisting !== true;
    await rememberWorkspaceProject(input, project.projectId, project.sourceFingerprint);
    // A server project created just as the user switches documents still needs the one-time
    // migration from the captured old session, but must not mutate the new document's UI.
  }

  if (!isCurrent() && !createdNewProject) return null;
  if (isCurrent()) workspaceSourceChanged.value = false;

  sessionPersistenceSuppressionCount++;
  let refreshed: { project: any; runs?: any[] } | null = null;
  try {
    // Migrate legacy data once, and only when the service project itself has just been created.
    // On an existing service project, cached translations, Prompt and literary memory are never
    // pushed back during open/restore; the next block hydrates the extension from SQLite instead.
    if (createdNewProject) {
      // File imports are created by the service with a minimal default Prompt. Save the reader's
      // configured Prompt separately; LiteraryMemory always has its own compact DTO endpoint.
      if (importBinding) {
        await workspaceApi(base, token,
          '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/prompts',
          { method: 'POST', body: JSON.stringify(initialPrompt) },
        );
      }
      await importWorkspaceTranslations(base, token, project.projectId, legacyTranslations);
      await workspaceApi(base, token,
        '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/literary-memory',
        { method: 'POST', body: JSON.stringify({ memory: legacyMemory }) },
      );
      if (importBinding) importBinding.createdNewProject = false;
    }
    if (!isCurrent()) return null;

    await hydrateWorkspacePrompt(base, token, project.projectId, expectedDocumentKey, expectedGeneration);
    if (!isCurrent()) return null;
    const memoryPath = '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/literary-memory';
    const currentMemory = await workspaceApi<{ current?: { memoryRevisionId?: string | null; memory?: unknown } }>(
      base, token, memoryPath,
    );
    if (!isCurrent()) return null;
    literaryMemory.value = sanitizeLiteraryMemory(currentMemory.current?.memory);

    // Original bytes are a backup concern, not project-state authority. Upload only when the
    // exact source project has no saved original file yet; this does not alter translations/runs.
    if (!project.sourceFileSaved && sourceFileAtStart) {
      try {
        await backupWorkspaceSourceFile(base, token, project.projectId, sourceFileAtStart);
      } catch (error) {
        if (isCurrent()) {
          persistenceMessage.value = 'workspace 已保存解析文本，但原始文件备份失败：' +
            (error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (!isCurrent()) return null;
    refreshed = await workspaceApi<{ project: any; runs?: any[] }>(
      base, token, '/api/documents/projects/' + encodeURIComponent(project.projectId),
    );
    if (!isCurrent()) return null;
    workspaceProject.value = refreshed.project;
    workspaceActiveRun.value = (refreshed.runs || []).find((run) =>
      ['queued', 'running', 'awaiting_acceptance', 'partial', 'paused'].includes(run.status)) || null;
    const accepted = await loadWorkspaceAcceptedTranslations(
      base, token, project.projectId, refreshed.project.segmentCount || doc.value.segments.length,
    );
    if (!isCurrent()) return null;
    await replaceCurrentTranslations(accepted);
  } finally {
    sessionPersistenceSuppressionCount = Math.max(0, sessionPersistenceSuppressionCount - 1);
  }
  if (!isCurrent() || !refreshed) return null;
  await persistCurrentSession();

  // Project details, translations and memory are now hydrated from the service; only session UI
  // state is persisted locally. Opening/restoring a project reads status but never starts analysis.
  if (config.documentUseLocalAgent) {
    void refreshContextGraphStatus(refreshed.project, true);
  }
  return refreshed.project;
}

/**
 * 运行结束后统一采纳已生成的译文。服务端负责保护同一原文版本的人工修订；
 * 同一个 run 被阅读页和 Agent 面板同时观察时，重复调用也是幂等的。
 */
async function autoAcceptWorkspaceRunCandidates(
  baseUrl: string,
  token: string,
  projectId: string,
  run: any,
): Promise<any> {
  if (!run || run.status === 'cancelled') return run;
  const candidateIds = (Array.isArray(run.segments) ? run.segments : [])
    .filter((row: any) => row.status === 'candidate' && typeof row.candidateTranslation === 'string' && row.candidateTranslation.trim())
    .map((row: any) => row.id as string);
  if (!candidateIds.length) return run;
  const response = await workspaceApi<{ run: any }>(
    baseUrl, token,
    '/api/documents/projects/' + encodeURIComponent(projectId) + '/runs/' + encodeURIComponent(run.runId) + '/accept',
    { method: 'POST', body: JSON.stringify({ segmentIds: candidateIds }) },
  );
  return response.run;
}

/**
 * 本机服务重启（`tsx watch` 改一个文件就会重启）期间，轮询里的某一次请求必然拿不到响应。
 *
 * 以前这里直接让错误冒泡，整条轮询链就此结束：服务几十秒后恢复了，界面却永远停在
 * 「无法连接本机服务」，因为已经没有东西会再去问它一次。现在只在连续失败超过上限后
 * 才真正放弃，期间把阶段文案换成"正在重连"，让用户看到它还在努力。
 */
const WORKSPACE_RECONNECT_MAX_ATTEMPTS = 20;
const WORKSPACE_RECONNECT_DELAY_MS = 3_000;

async function workspaceApiWithReconnect<T>(
  call: () => Promise<T>,
  options: { shouldContinue?: () => boolean; onWaiting?: (attempt: number) => void } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const retryable = isServiceUnreachableError(error) &&
        attempt <= WORKSPACE_RECONNECT_MAX_ATTEMPTS &&
        (options.shouldContinue ? options.shouldContinue() : true);
      if (!retryable) throw error;
      options.onWaiting?.(attempt);
      await new Promise((resolve) => setTimeout(resolve, WORKSPACE_RECONNECT_DELAY_MS));
    }
  }
}

/**
 * 轮询结束后残留的连接类错误需要有人清掉。
 *
 * 这条文案是上一轮轮询写的，而那一轮已经结束，所以服务恢复后没有任何代码会再碰它。
 * 只要当前显示的错误仍然是"连不上"，就用最便宜的列表接口有限次重探，一应答就抹掉文案。
 */
const SERVICE_RECONNECT_PROBE_DELAY_MS = 3_000;
const SERVICE_RECONNECT_PROBE_MAX_ATTEMPTS = 60;
let serviceReconnectProbeTimer: ReturnType<typeof setTimeout> | null = null;
let serviceReconnectProbeAttempts = 0;
let serviceUnreachableMessage = '';

function clearServiceReconnectProbe() {
  if (serviceReconnectProbeTimer !== null) clearTimeout(serviceReconnectProbeTimer);
  serviceReconnectProbeTimer = null;
  serviceReconnectProbeAttempts = 0;
  serviceUnreachableMessage = '';
}

function scheduleServiceReconnectProbe() {
  if (serviceReconnectProbeTimer !== null) return;
  serviceReconnectProbeTimer = setTimeout(async () => {
    serviceReconnectProbeTimer = null;
    // 用户已经做了别的操作（文案被清空或被换成新内容），就不该再动这条错误。
    if (!serviceUnreachableMessage || state.value.error !== serviceUnreachableMessage) {
      clearServiceReconnectProbe();
      return;
    }
    if (serviceReconnectProbeAttempts >= SERVICE_RECONNECT_PROBE_MAX_ATTEMPTS) return;
    serviceReconnectProbeAttempts++;
    try {
      await workspaceApi(
        readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
        readerConfig.value?.documentLocalAgentToken || '',
        '/api/documents/projects',
      );
      const staleMessage = serviceUnreachableMessage;
      clearServiceReconnectProbe();
      if (state.value.error === staleMessage) {
        state.value.error = '';
        await persistCurrentSession();
      }
    } catch {
      scheduleServiceReconnectProbe();
    }
  }, SERVICE_RECONNECT_PROBE_DELAY_MS);
}

/** 只在确实是"连不上"时才启动重探；404/409 这类服务已应答的错误不重试。 */
function reportWorkspaceConnectionFailure(prefix: string, error: unknown) {
  const message = prefix + (error instanceof Error ? error.message : String(error));
  state.value.error = message;
  if (!isServiceUnreachableError(error)) return;
  clearServiceReconnectProbe();
  serviceUnreachableMessage = message;
  scheduleServiceReconnectProbe();
}

/**
 * 当用户从 Agent Tab 回到阅读页时，接管同一条已经存在的运行记录。
 * 两个界面遵守相同规则：后台运行完成后自动保存译文，不再要求用户逐条采纳。
 */
async function followWorkspaceRun(project: any, initialRun: any) {
  if (!doc.value || !project?.projectId || !initialRun?.runId) return;
  if (workspaceRunId.value === initialRun.runId && state.value.running) return;
  if (workspaceRunId.value && state.value.running) return;
  const generation = ++workspaceRunGeneration.value;
  const runId = initialRun.runId as string;
  workspaceProject.value = project;
  workspaceActiveRun.value = initialRun;
  workspaceRunId.value = runId;
  workspaceTranslationActive.value = true;
  state.value.running = true;
  state.value.error = '';
  state.value.workChapter = currentPage.value?.title || doc.value.title || 'document';
  state.value.workStage = '连接到 workspace 现有运行';
  state.value.workTotal = initialRun.counts?.total || 0;
  state.value.workDone = (initialRun.counts?.candidate || 0) + (initialRun.counts?.accepted || 0) + (initialRun.counts?.failed || 0);
  try {
    let run = initialRun;
    while (workspaceRunId.value === runId && workspaceRunGeneration.value === generation) {
      const current = await workspaceApiWithReconnect(
        () => workspaceApi<{ run: any }>(
          readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
          readerConfig.value?.documentLocalAgentToken || '',
          '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs/' + encodeURIComponent(runId),
        ),
        {
          shouldContinue: () => workspaceRunId.value === runId && workspaceRunGeneration.value === generation,
          onWaiting: (attempt) => {
            state.value.workStage = '本机服务暂时不可达，正在重连（第 ' + attempt + ' 次）';
          },
        },
      );
      run = current.run;
      workspaceActiveRun.value = run;
      const rows = Array.isArray(run.segments) ? run.segments : [];
      workspaceCandidateTranslations.value = new Map(
        rows.filter((row: any) => row.status === 'candidate' && typeof row.candidateTranslation === 'string' && row.candidateTranslation.trim())
          .map((row: any) => [row.id, row.candidateTranslation]),
      );
      const counts = run.counts || {};
      state.value.workTotal = counts.total || state.value.workTotal;
      state.value.workDone = (counts.candidate || 0) + (counts.accepted || 0) + (counts.failed || 0);
      state.value.workStage = 'workspace Agent：' + run.status;
      state.value.activeSegmentIds = new Set(rows.filter((row: any) => ['pending', 'running'].includes(row.status)).map((row: any) => row.id));
      if (!['queued', 'running'].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    if (workspaceRunGeneration.value !== generation || workspaceRunId.value !== runId) return;
    if (run.status !== 'cancelled') {
      run = await autoAcceptWorkspaceRunCandidates(
        readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
        readerConfig.value?.documentLocalAgentToken || '',
        project.projectId,
        run,
      );
      workspaceActiveRun.value = run;
    }
    const latest = await workspaceApi<{ project: any; runs?: any[] }>(
      readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
      readerConfig.value?.documentLocalAgentToken || '',
      '/api/documents/projects/' + encodeURIComponent(project.projectId),
    );
    workspaceProject.value = latest.project;
    workspaceActiveRun.value = (latest.runs || []).find((item) => item.runId === runId) || run;
    if (effectiveDocumentTranslationMode.value === 'literary') {
      await refreshWorkspaceLiteraryMemory(
        project.projectId,
        readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
        readerConfig.value?.documentLocalAgentToken || '',
      );
    }
    const accepted = await loadWorkspaceAcceptedTranslations(
      readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
      readerConfig.value?.documentLocalAgentToken || '',
      project.projectId,
      latest.project.segmentCount || doc.value.segments.length,
    );
    await replaceCurrentTranslations(accepted);
    // 成功采纳后不再把候选叠加显示成正文；只有运行失败/暂停时才保留诊断状态。
    workspaceCandidateTranslations.value = new Map();
    if (run.status === 'completed') workspaceActiveRun.value = null;
    if (run.counts?.failed || ['partial', 'failed', 'paused'].includes(run.status)) {
      state.value.error = run.error || 'workspace 运行尚未全部完成，可到“翻译 Agent”继续或重试。';
    }
  } catch (error) {
    // 用户主动停止会改动 generation，这时不该把"已取消"显示成失败。
    if (workspaceRunGeneration.value === generation) {
      reportWorkspaceConnectionFailure('读取 workspace 运行状态失败：', error);
    }
  } finally {
    if (workspaceRunGeneration.value === generation && workspaceRunId.value === runId) {
      state.value.running = false;
      state.value.workStage = '';
      state.value.activeSegmentIds = new Set();
      workspaceRunId.value = '';
      workspaceTranslationActive.value = false;
      await persistCurrentSession();
    }
  }
}

async function runWorkspaceTranslation(options: {
  ids?: string[];
  scope?: { type: 'failed' } | { type: 'stale' } | { type: 'all' };
  forceRefresh?: boolean;
  /** Display label for background work; it must never change the reader's current page. */
  chapterTitle?: string;
}) {
  if (!doc.value || state.value.running) return;
  // 显式修改 Voice Bible 后立即翻译时，先等待排队中的 SQLite 记忆写入完成。
  await awaitLiteraryMemoryWrites();
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  if (!config.documentUseLocalAgent) return;
  const project = await ensureDocumentWorkspace();
  if (!project) return;
  const base = config.documentLocalAgentUrl || 'http://127.0.0.1:8789';
  const token = config.documentLocalAgentToken || '';
  const activeRun = workspaceActiveRun.value;
  if (activeRun && ['queued', 'running'].includes(activeRun.status)) {
    await followWorkspaceRun(project, activeRun);
    return;
  }
  if (activeRun && ['awaiting_acceptance', 'partial'].includes(activeRun.status) && (activeRun.counts?.candidate || 0) > 0) {
    // 兼容升级前留下的待采纳结果，先自动写入当前版本，再继续用户请求。
    try {
      const fullRun = await workspaceApi<{ run: any }>(
        config.documentLocalAgentUrl || 'http://127.0.0.1:8789',
        config.documentLocalAgentToken || '',
        '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs/' + encodeURIComponent(activeRun.runId),
      );
      await autoAcceptWorkspaceRunCandidates(config.documentLocalAgentUrl || 'http://127.0.0.1:8789', config.documentLocalAgentToken || '', project.projectId, fullRun.run);
      const refreshed = await workspaceApi<{ project: any; runs?: any[] }>(config.documentLocalAgentUrl || 'http://127.0.0.1:8789', config.documentLocalAgentToken || '', '/api/documents/projects/' + encodeURIComponent(project.projectId));
      const accepted = await loadWorkspaceAcceptedTranslations(config.documentLocalAgentUrl || 'http://127.0.0.1:8789', config.documentLocalAgentToken || '', project.projectId, refreshed.project.segmentCount || doc.value?.segments.length || 0);
      workspaceProject.value = refreshed.project;
      if (effectiveDocumentTranslationMode.value === 'literary') await refreshWorkspaceLiteraryMemory(project.projectId, base, token);
      // Keep interrupted/failed remainder visible; only clear a fully resolved legacy run.
      workspaceActiveRun.value = (refreshed.runs || []).find((run) => run.runId === activeRun.runId && ['paused', 'partial', 'failed'].includes(run.status)) || null;
      workspaceCandidateTranslations.value = new Map();
      await replaceCurrentTranslations(accepted);
    } catch (error) {
      activeTab.value = 'agent';
      persistenceMessage.value = '译文已经生成，但自动保存失败：' + (error instanceof Error ? error.message : String(error)) + '。请在 Agent 面板重试保存。';
      return;
    }
  }
  const scope: { type: 'ids'; ids: string[] } | { type: 'failed' } | { type: 'stale' } | { type: 'all' } =
    options.scope || { type: 'ids', ids: options.ids || [] };
  if (scope.type === 'ids' && (!scope.ids || !scope.ids.length)) return;
  const response = await workspaceApi<{ run: any; started: boolean }>(
    base, token, '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs',
    { method: 'POST', body: JSON.stringify({ scope }) },
  );
  const runId = response.run.runId as string;
  const generation = ++workspaceRunGeneration.value;
  workspaceActiveRun.value = response.run;
  workspaceRunId.value = runId;
  workspaceTranslationActive.value = true;
  workspaceCandidateTranslations.value = new Map();
  state.value.running = response.started;
  state.value.error = '';
  state.value.failedBatches = [];
  state.value.activeSegmentIds = new Set(
    scope.type === 'ids' ? (scope.ids || []) : doc.value.segments.filter((segment) => !state.value.translations.get(segment.id)?.trim()).map((segment) => segment.id),
  );
  state.value.workChapter = options.chapterTitle || currentPage.value?.title || doc.value.title || 'document';
  state.value.workStage = options.chapterTitle ? '后台预翻译' : 'workspace Agent 正在翻译';
  state.value.workDone = 0;
  state.value.workTotal = response.run.counts?.total || 0;
  if (!response.started) {
    state.value.running = false;
    workspaceRunId.value = '';
    workspaceTranslationActive.value = false;
    state.value.activeSegmentIds = new Set();
    return;
  }
  try {
    let terminalRun: any = response.run;
    while (workspaceRunId.value === runId && workspaceRunGeneration.value === generation) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const current = await workspaceApi<{ run: any }>(
        base, token, '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs/' + encodeURIComponent(runId),
      );
      terminalRun = current.run;
      workspaceActiveRun.value = terminalRun;
      const candidates = Array.isArray(terminalRun.segments) ? terminalRun.segments : [];
      for (const row of candidates) {
        if (typeof row.candidateTranslation !== 'string' || !row.candidateTranslation.trim()) continue;
        // 候选与已采纳版本分开存储；阅读页可以预览，但切换 Tab 时不会把它导入为已采纳版本。
        workspaceCandidateTranslations.value.set(row.id, row.candidateTranslation);
      }
      const counts = terminalRun.counts || {};
      state.value.workTotal = counts.total || state.value.workTotal;
      state.value.workDone = (counts.candidate || 0) + (counts.accepted || 0) + (counts.failed || 0);
      state.value.workStage = 'workspace Agent：' + terminalRun.status;
      if (!['queued', 'running'].includes(terminalRun.status)) break;
    }
    if (workspaceRunGeneration.value !== generation || workspaceRunId.value !== runId) return;
    if (terminalRun.status !== 'cancelled') {
      terminalRun = await autoAcceptWorkspaceRunCandidates(base, token, project.projectId, terminalRun);
      workspaceActiveRun.value = terminalRun;
      const finalProject = await workspaceApi<{ project: any }>(base, token, '/api/documents/projects/' + encodeURIComponent(project.projectId));
      workspaceProject.value = finalProject.project;
      if (effectiveDocumentTranslationMode.value === 'literary') await refreshWorkspaceLiteraryMemory(project.projectId, base, token);
      const accepted = await loadWorkspaceAcceptedTranslations(base, token, project.projectId, finalProject.project.segmentCount || doc.value.segments.length);
      await replaceCurrentTranslations(accepted);
      if (terminalRun.counts?.failed || terminalRun.status === 'partial' || terminalRun.status === 'failed' || terminalRun.status === 'paused') {
        state.value.error = terminalRun.error || '部分片段尚未完成，可在“翻译 Agent”中继续或重试失败项。';
        state.value.failedBatches = terminalRun.counts?.failed ? [0] : [];
      }
    }
  } catch (error) {
    state.value.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (workspaceRunGeneration.value === generation && workspaceRunId.value === runId) {
      state.value.running = false;
      state.value.workStage = '';
      state.value.activeSegmentIds = new Set();
      workspaceRunId.value = '';
      workspaceTranslationActive.value = false;
      workspaceCandidateTranslations.value = new Map();
      if (workspaceActiveRun.value?.runId === runId && ['completed', 'cancelled'].includes(workspaceActiveRun.value.status)) {
        workspaceActiveRun.value = null;
      }
      await persistCurrentSession();
    }
  }
}

async function stopCurrentTranslation() {
  if (workspaceRunId.value && workspaceProject.value && readerConfig.value?.documentUseLocalAgent) {
    const runId = workspaceRunId.value;
    const generation = workspaceRunGeneration.value;
    workspaceRunGeneration.value++;
    workspaceRunId.value = '';
    try {
      const response = await workspaceApi<{ run: any }>(readerConfig.value.documentLocalAgentUrl || 'http://127.0.0.1:8789', readerConfig.value.documentLocalAgentToken || '',
        '/api/documents/projects/' + encodeURIComponent(workspaceProject.value.projectId) + '/runs/' + encodeURIComponent(runId) + '/cancel',
        { method: 'POST', body: '{}' });
      workspaceActiveRun.value = response.run;
    } catch (error) {
      state.value.error = '停止 workspace 运行失败：' + (error instanceof Error ? error.message : String(error));
    }
    state.value.running = false;
    state.value.workStage = '';
    state.value.activeSegmentIds = new Set();
    workspaceTranslationActive.value = false;
    workspaceCandidateTranslations.value = new Map();
    await persistCurrentSession();
    void generation;
    return;
  }
  stopTranslation();
}

function displayTranslation(segmentId: string): string {
  return workspaceCandidateTranslations.value.get(segmentId) || state.value.translations.get(segmentId) || '';
}

/**
 * 预翻译当前阅读位置之后的页面，不修改 currentPageIndex。
 *
 * 锚点是已译区域的末端而不是固定的当前页：从当前页起跳过已经译完的页面，向后收集
 * pageCount 个仍有待译片段的页面。连续点击会持续向后推进（3 页 → 6 页 → 9 页），
 * 不会在同一窗口空转。当前页未译完时它就在窗口内，所以「翻译下三页」共 3 页。
 */
async function translatePages(pageCount: number) {
  if (!doc.value || state.value.running || pageCount < 1) return;

  const targetPages = nextUntranslatedPageWindow(
    pages.value, currentPageIndex.value, pageCount, isSegmentTranslated,
  );
  if (!targetPages.length) return;

  const pendingSegments = targetPages
    .flatMap((page) => page.segments)
    .filter((segment) => !isSegmentTranslated(segment.id));
  if (!pendingSegments.length) return;

  const ids = pendingSegments.map((segment) => segment.id);
  const chapterTitle = '后台预翻译：' + targetPages.map((page) => page.title).join('、');
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;

  if (config.documentUseLocalAgent) {
    // Workspace 的任务范围是 segment IDs，与用户当前显示哪一页无关。
    await runWorkspaceTranslation({ ids, chapterTitle });
    return;
  }

  const options = await buildTranslationOptions();
  await run(doc.value.segments, {
    ...options,
    onlyPrioritySegments: true,
    prioritySegmentIds: ids,
    currentPageTitle: chapterTitle,
  }, true);
}

async function startTranslate() {
  if (!doc.value || !visibleSegments.value.length || state.value.running) return;
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  if (config.documentUseLocalAgent) {
    try {
      const project = await ensureDocumentWorkspace();
      if (workspaceSourceChanged.value) return;
      if (project && workspaceActiveRun.value && ['queued', 'running'].includes(workspaceActiveRun.value.status)) {
        await followWorkspaceRun(project, workspaceActiveRun.value);
        return;
      }
      if (workspaceActiveRun.value &&
          ['awaiting_acceptance', 'partial'].includes(workspaceActiveRun.value.status) &&
          (workspaceActiveRun.value.counts?.candidate || 0) > 0) {
        // 兼容旧会话：先自动完成最后的保存步骤，不再强迫用户切换页面手工采纳。
        const fullRun = await workspaceApi<{ run: any }>(
          readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
          readerConfig.value?.documentLocalAgentToken || '',
          '/api/documents/projects/' + encodeURIComponent(workspaceProject.value?.projectId || '') + '/runs/' + encodeURIComponent(workspaceActiveRun.value.runId),
        );
        await autoAcceptWorkspaceRunCandidates(
          readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
          readerConfig.value?.documentLocalAgentToken || '',
          workspaceProject.value?.projectId || '',
          fullRun.run,
        );
        const refreshed = await workspaceApi<{ project: any; runs?: any[] }>(
          readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
          readerConfig.value?.documentLocalAgentToken || '',
          '/api/documents/projects/' + encodeURIComponent(workspaceProject.value?.projectId || ''),
        );
        const accepted = await loadWorkspaceAcceptedTranslations(
          readerConfig.value?.documentLocalAgentUrl || 'http://127.0.0.1:8789',
          readerConfig.value?.documentLocalAgentToken || '',
          refreshed.project.projectId,
          refreshed.project.segmentCount || doc.value.segments.length,
        );
        workspaceProject.value = refreshed.project;
        workspaceActiveRun.value = (refreshed.runs || []).find((run) => run.runId === workspaceActiveRun.value?.runId && ['paused', 'partial', 'failed'].includes(run.status)) || null;
        workspaceCandidateTranslations.value = new Map();
        await replaceCurrentTranslations(accepted);
      }
    } catch (error) {
      state.value.error = '无法准备文档 workspace：' + (error instanceof Error ? error.message : String(error));
      return;
    }
  }
  // 当前页已完成但文档尚未完成时，继续按钮自动跳到后面最近的待译页；走到末尾后再回绕查找。
  if (!currentPagePending.value) {
    const pageCount = pages.value.length;
    const hasPendingPage = (index: number) =>
      pages.value[index]?.segments.some((segment) => !state.value.translations.get(segment.id)?.trim()) ?? false;
    let nextIndex = -1;
    for (let offset = 1; offset < pageCount; offset++) {
      const candidate = (currentPageIndex.value + offset) % pageCount;
      if (hasPendingPage(candidate)) { nextIndex = candidate; break; }
    }
    if (nextIndex < 0) return;
    currentPageIndex.value = nextIndex;
    await nextTick();
  }
  if (!currentPage.value || !visibleSegments.value.length) return;
  if (config.documentUseLocalAgent) {
    const ids = visibleSegments.value
      .filter((segment) => !state.value.translations.get(segment.id)?.trim())
      .map((segment) => segment.id);
    await runWorkspaceTranslation({ ids });
    return;
  }
  const options = await buildTranslationOptions();
  // 非本机模式仍走原来的扩展翻译器；启用本机服务后，阅读页与 Agent 统一走 workspace pipeline。
  await run(doc.value.segments, {
    ...options,
    onlyPrioritySegments: true,
    prioritySegmentIds: visibleSegments.value.map((segment) => segment.id),
    currentPageTitle: currentPage.value?.title || doc.value?.title || 'document',
  }, true);
}

async function forceTranslateCurrentPage() {
  if (!doc.value || !visibleSegments.value.length || state.value.running) return;
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  if (config.documentUseLocalAgent) {
    await runWorkspaceTranslation({ ids: visibleSegments.value.map((segment) => segment.id), forceRefresh: true });
    return;
  }
  const options = await buildTranslationOptions();
  await run(doc.value.segments, {
    ...options,
    forceRefresh: true,
    onlyPrioritySegments: true,
    prioritySegmentIds: visibleSegments.value.map((segment) => segment.id),
    currentPageTitle: currentPage.value?.title || doc.value.title,
  }, true);
}

async function retry() {
  if (!doc.value) return;
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  if (config.documentUseLocalAgent) {
    await runWorkspaceTranslation({ scope: { type: 'failed' } });
    return;
  }
  // 非本机模式重试复用同一份 provider / 文风 / glossary。
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
  loadedSourceFile.value = null;
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

<style scoped src="./documentReaderStyles.css"></style>
