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

    <!-- 选择文件前也可先配置源/目标语言、翻译类型、文风与运行服务。 -->
    <DocumentTranslationSettings
      v-if="!doc && !parsing"
      :active-source-lang="sourceLang"
      :active-target-lang="targetLang"
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
        <button class="tab" :class="{ active: activeTab === 'memory' }" @click="activeTab = 'memory'">
          设置与记忆
          <span v-if="literaryMode" class="tab-badge">{{ literaryMemory.entities.length }}实体·{{ literaryStatus.reviewFindings.length }}审校</span>
        </button>
        <button v-if="doc.format === 'epub' || doc.format === 'pdf'" class="tab" :class="{ active: activeTab === 'agent' }" @click="activeTab = 'agent'">
          翻译 Agent
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
          <label v-if="literaryMode" class="field inline" title="关闭后每批省一次审校调用，速度翻倍；译文为初译水平">
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
          <button v-if="!state.running && visibleSegments.length" class="btn warn" @click="forceTranslateCurrentPage">
            强制重译当前页
          </button>
          <button v-if="state.running" class="btn" @click="stopCurrentTranslation">停止</button>
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
          <div v-if="viewMode !== 'translation'" class="or" :class="languageFontClass(sourceLang, seg.text)">{{ seg.text }}</div>
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

      <template v-else-if="activeTab === 'memory'">
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


      <!-- 实体映射决定同一人物、地点、组织或重要物品在后续章节统一使用什么译名。 -->
      <section v-if="literaryMode" class="panel literary-dictionary">
        <div class="dictionary-heading">
          <div>
            <h3>实体译名表</h3>
            <p class="muted small">检查原文名称与统一译名是否正确。已有原文依据的 AI 结果会自动纳入规范；没有依据的结果需要核对。修改任何字段后，请点击“确认并应用”。</p>
          </div>
          <span class="chip">共 {{ literaryMemory.entities.length }} 项</span>
        </div>

        <div class="dictionary-toolbar">
          <input v-model.trim="entitySearch" type="search" class="entity-search"
            placeholder="搜索原文名、译名或别名…" aria-label="搜索实体译名" />
          <div class="entity-filters" aria-label="筛选实体状态">
            <button class="filter-chip" :class="{ active: entityFilter === 'all' }" @click="entityFilter = 'all'">
              全部 {{ literaryMemory.entities.length }}
            </button>
            <button class="filter-chip" :class="{ active: entityFilter === 'pending' }" @click="entityFilter = 'pending'">
              待核对 {{ pendingEntityCount }}
            </button>
            <button class="filter-chip" :class="{ active: entityFilter === 'confirmed' }" @click="entityFilter = 'confirmed'">
              已纳入规范 {{ confirmedEntityCount }}
            </button>
          </div>
          <div class="dictionary-actions">
            <button class="btn primary" @click="addEntity">添加实体映射</button>
            <button class="btn" :disabled="confirmableEntityCount === 0" @click="confirmAllEntities">
              一键确认待核对项（{{ pendingEntityCount }}）
            </button>
          </div>
        </div>

        <div v-if="filteredLiteraryEntities.length" class="entity-card-list">
          <article v-for="{ entity, index } in filteredLiteraryEntities"
            :key="'entity-' + index + '-' + entity.source" class="entity-card" :class="{ 'is-pending-card': entity.reviewStatus !== 'confirmed' }">
            <div class="entity-card-header">
              <span class="entity-status" :class="entity.reviewStatus === 'confirmed' ? 'is-confirmed' : 'is-pending'">
                {{ entity.reviewStatus === 'confirmed' ? '已纳入规范' : '待核对' }}
              </span>
              <span v-if="entity.kind" class="entity-kind">{{ entityKindLabel(entity.kind) }}</span>
              <span class="entity-card-spacer"></span>
              <button class="btn ghost" :disabled="!entity.source.trim() || !entity.target.trim()"
                @click="toggleEntityConfirmation(entity)">
                {{ entity.reviewStatus === 'confirmed' ? '撤销确认' : '确认并应用' }}
              </button>
              <button class="btn ghost danger-text" @click="removeEntity(index)">移除</button>
            </div>

            <div class="entity-fields">
              <label>
                <span>原文名称 / 写法</span>
                <input v-model.trim="entity.source" placeholder="例如：Snowflake"
                  @change="markEntitySuggested(entity)" />
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
          <strong>{{ literaryMemory.entities.length ? '没有符合条件的实体' : '实体表还是空的' }}</strong>
          <p class="muted small">
            {{ literaryMemory.entities.length
              ? '试试其他关键词或切换筛选条件。'
              : '开始文学翻译后，系统会从正文中提取实体；也可以手动添加实体映射。' }}
          </p>
          <button v-if="literaryMemory.entities.length" class="btn" @click="entitySearch = ''; entityFilter = 'all'">
            清除筛选
          </button>
          <button v-else class="btn primary" @click="addEntity">手动添加实体映射</button>
        </div>

        <details class="relationship-section">
          <summary><strong>人物 / 事物关系</strong>（{{ literaryMemory.relationships.length }} 项）</summary>
          <p class="muted small relationship-help">这里记录“谁与谁是什么关系”，用于消歧，不是译名表。只确认有明确原文依据的关系。</p>
          <div class="literary-editor-list">
            <div v-for="(relation, index) in literaryMemory.relationships" :key="'relation-' + index" class="literary-editor-row">
              <label>主体<input v-model="relation.subject" @change="markRelationshipSuggested(relation)" /></label>
              <label>关系<input v-model="relation.predicate" @change="markRelationshipSuggested(relation)" /></label>
              <label>对象<input v-model="relation.object" @change="markRelationshipSuggested(relation)" /></label>
              <span class="chip">{{ relation.reviewStatus === 'confirmed' ? '已纳入规范' : '待核对' }}</span>
              <button class="btn ghost" :disabled="!relation.subject.trim() || !relation.predicate.trim() || !relation.object.trim()" @click="confirmRelationship(relation)">确认并应用</button>
              <button class="btn ghost danger-text" @click="removeRelationship(index)">移除</button>
            </div>
            <div class="relationship-actions">
              <button class="btn" @click="addRelationship">添加关系</button>
              <button class="btn" :disabled="confirmableRelationshipCount === 0" @click="confirmAllRelationships">一键确认待核对项（{{ pendingRelationshipCount }}）</button>
            </div>
          </div>
        </details>
        <p class="muted small dictionary-footnote">状态含义：已纳入规范＝已有原文依据的自动纳入结果或用户确认的译名；待核对＝AI 建议或被编辑过的映射。变更会保存在本机阅读会话中，并供后续章节参考。</p>
      </section>

      <section v-if="literaryMode" class="panel character-voice-bible">
        <div class="dictionary-heading">
          <div>
            <h3>人物声音档案</h3>
            <p class="muted small">只记录有原文证据、能落实到措辞与句式的声音特征。候选画像不会强制套用到译文；确认后才进入常规翻译上下文。</p>
          </div>
          <div class="voice-counts">
            <span class="chip">人物 {{ literaryMemory.characterVoices.length }}</span>
            <span class="chip">已确认 {{ confirmedCharacterVoiceCount }}</span>
            <span class="chip">待核对 {{ pendingCharacterVoiceCount }}</span>
          </div>
        </div>
        <div v-if="!literaryMemory.characterVoices.length" class="review-empty">
          <strong>尚未建立人物声音档案</strong>
          <p class="muted small">翻译流程分析到足够的对白证据后，会生成候选画像。系统不会为了填满档案而猜测人物口头禅、方言或性格。</p>
        </div>
        <article v-for="profile in literaryMemory.characterVoices" :key="profile.characterId" class="voice-profile-card">
          <div class="voice-profile-heading">
            <div>
              <strong>{{ profile.canonicalSourceName }}<template v-if="profile.targetName"> → {{ profile.targetName }}</template></strong>
              <p class="muted small">{{ profile.characterId }} · 置信度 {{ Math.round(profile.confidence * 100) }}% · {{ profile.aliases.join('、') || '暂无别名' }}</p>
            </div>
            <span class="entity-status" :class="profile.status === 'confirmed' ? 'is-confirmed' : profile.status === 'rejected' ? 'is-rejected' : 'is-pending'">
              {{ profile.status === 'confirmed' ? '已确认' : profile.status === 'rejected' ? '已拒绝' : '候选' }}
            </span>
          </div>
          <div class="voice-profile-fields">
            <p v-if="profile.voiceCore.register"><strong>语域：</strong>{{ profile.voiceCore.register }}</p>
            <p v-if="profile.voiceCore.syntaxRhythm?.length"><strong>句法 / 节奏：</strong>{{ profile.voiceCore.syntaxRhythm.join('；') }}</p>
            <p v-if="profile.voiceCore.lexicalPreferences?.length"><strong>词汇：</strong>{{ profile.voiceCore.lexicalPreferences.join('；') }}</p>
            <p v-if="profile.voiceCore.discourseHabits?.length"><strong>对话策略：</strong>{{ profile.voiceCore.discourseHabits.join('；') }}</p>
            <p v-if="profile.voiceCore.stanceModality?.length"><strong>立场 / 情态：</strong>{{ profile.voiceCore.stanceModality.join('；') }}</p>
            <p v-if="profile.voiceCore.humorIrony"><strong>幽默 / 反讽：</strong>{{ profile.voiceCore.humorIrony }}</p>
            <p v-if="profile.voiceCore.disfluency"><strong>口语特征：</strong>{{ profile.voiceCore.disfluency }}</p>
            <p v-if="profile.voiceCore.avoid?.length"><strong>避免：</strong>{{ profile.voiceCore.avoid.join('；') }}</p>
          </div>
          <details>
            <summary>原文证据（{{ profile.evidence.length }}）与人物对比（{{ profile.contrastRules.length }}）</summary>
            <div v-for="(evidence, index) in profile.evidence" :key="profile.characterId + '-ev-' + index" class="voice-evidence">
              <p><strong>{{ evidence.dimension }} · {{ Math.round(evidence.confidence * 100) }}%</strong> · {{ evidence.observation }}</p>
              <blockquote>{{ evidence.sourceQuote }}</blockquote>
              <button class="btn ghost" @click="showReviewSegment(evidence.segmentId)">定位证据片段 {{ evidence.segmentId }}</button>
            </div>
            <p v-for="(rule, index) in profile.contrastRules" :key="profile.characterId + '-contrast-' + index" class="muted small">
              与 {{ characterName(rule.otherCharacterId) }} 的差异：{{ rule.difference }}（证据：{{ rule.evidenceSegmentIds.join('、') }}）
            </p>
            <p v-for="(question, index) in profile.openQuestions" :key="profile.characterId + '-q-' + index" class="warn small">待确认：{{ question }}</p>
          </details>
          <div class="voice-profile-actions">
            <button class="btn primary" :disabled="profile.status === 'confirmed' || !profile.evidence.length" @click="setCharacterVoiceStatus(profile, 'confirmed')">确认并用于翻译</button>
            <button class="btn" :disabled="profile.status === 'rejected'" @click="setCharacterVoiceStatus(profile, 'rejected')">拒绝此画像</button>
            <button class="btn ghost" :disabled="profile.status === 'candidate'" @click="setCharacterVoiceStatus(profile, 'candidate')">恢复为候选</button>
          </div>
        </article>

        <details v-if="literaryMemory.relationshipVoiceRules.length" class="relationship-section">
          <summary><strong>人物对的说话规则</strong>（{{ literaryMemory.relationshipVoiceRules.length }} 项）</summary>
          <p class="muted small">方向不可互换：A 对 B 的称谓和语域，不代表 B 对 A 的说话方式。</p>
          <article v-for="(rule, index) in literaryMemory.relationshipVoiceRules" :key="'voice-rule-' + index" class="voice-profile-card">
            <div class="voice-profile-heading">
              <strong>{{ characterName(rule.speakerId) }} → {{ characterName(rule.addresseeId) }}</strong>
              <span class="entity-status" :class="rule.status === 'confirmed' ? 'is-confirmed' : rule.status === 'rejected' ? 'is-rejected' : 'is-pending'">{{ rule.status === 'confirmed' ? '已确认' : rule.status === 'rejected' ? '已拒绝' : '候选' }}</span>
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
              <span class="entity-status" :class="anchor.status === 'approved' ? 'is-confirmed' : anchor.status === 'rejected' ? 'is-rejected' : 'is-pending'">{{ anchor.status === 'approved' ? '已批准' : anchor.status === 'rejected' ? '已拒绝' : '候选' }}</span>
            </div>
            <p><strong>原文：</strong>{{ anchor.source }}</p>
            <p><strong>译文：</strong>{{ anchor.target }}</p>
            <p class="muted small">来源片段 {{ anchor.segmentId }} · {{ anchor.tags.join('、') }}</p>
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
      <template v-else>
        <DocumentAgentWorkspace
          v-if="doc"
          :key="documentFileName + ':' + doc.format"
          :title="doc.title"
          :format="doc.format"
          :source-file-name="documentFileName"
          :source-file="loadedSourceFile"
          :segments="doc.segments"
          :visible-segments="visibleSegments"
          :translations="state.translations"
          :source-lang="sourceLang"
          :target-lang="targetLang"
          :translation-mode="literaryMode ? 'literary' : (readerConfig?.translationMode || 'technical')"
          :literary-review="literaryReview"
          :use-local-agent="readerConfig?.useLocalAgent === true"
          :local-agent-provider="readerConfig?.localAgentProvider || 'workbuddy'"
          :local-agent-url="readerConfig?.localAgentUrl || 'http://127.0.0.1:8789'"
          :local-agent-model="readerConfig?.localAgentModel || 'auto'"
          :local-agent-token="readerConfig?.localAgentToken || ''"
          :system-prompt="documentSystemPromptEditor || builtInDocumentSystemPrompt"
          :user-prompt-template="documentUserPromptEditor || BUILT_IN_USER_PROMPT_TEMPLATE"
          :literary-memory="literaryMemory"
          :glossary="glossary"
          @accepted-translations="applyAgentTranslations"
          @workspace-sync="syncWorkspaceTranslations"
        />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { getConfig, setConfig, type Config } from '@/entrypoints/utils/config';
import DocumentTranslationSettings from './DocumentTranslationSettings.vue';
import DocumentAgentWorkspace from './DocumentAgentWorkspace.vue';
import {
  backupWorkspaceSourceFile,
  importWorkspaceTranslations,
  loadWorkspaceAcceptedTranslations,
  lookupWorkspaceProject,
  rememberWorkspaceProject,
  workspaceApi,
} from './documentWorkspaceClient';
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
import { buildLiteraryTranslationContextPrompt, createEmptyLiteraryMemory, refreshLiteraryExampleTargets, type LiteraryEntity, type LiteraryRelationship, type LiteraryReviewFinding } from '@/entrypoints/utils/document/literary';

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
const readerConfig = ref<Config | null>(null);
/** 当前文档对应的本机 workspace；阅读页与 Agent Tab 都从这里读写同一份 SQLite。 */
const workspaceProject = ref<any>(null);
const workspaceActiveRun = ref<any>(null);
const workspaceRunId = ref('');
const workspaceSourceChanged = ref(false);
const workspaceTranslationActive = ref(false);
const workspaceRunGeneration = ref(0);
/** 尚未被用户/阅读页运行采纳的 workspace 候选只用于预览，不混进当前正式译文 Map。 */
const workspaceCandidateTranslations = ref(new Map<string, string>());
const englishFontFamily = ref('Georgia');
const chineseFontFamily = ref('Noto Serif CJK SC');
const englishFontSize = ref(17);
const chineseFontSize = ref(18);
const documentSystemPromptOverride = ref('');
const documentSystemPromptEditor = ref('');
const documentUserPromptTemplate = ref('');
const documentUserPromptEditor = ref('');
const BUILT_IN_USER_PROMPT_TEMPLATE = [
  '请翻译以下 JSON 数组中的每个对象。只翻译 text 字段，必须保留 id、顺序、段落边界和结构信息。',
  'contextPath、kind、level、marker 等字段是只读元数据，不能写入译文。只返回与输入 ID 一一对应的 JSON 译文，不要增加解释或额外字段。',
  '', 'JSON:', '', '{{CONTENT}}',
].join(String.fromCharCode(10));
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
const currentPagePending = computed(() => visibleSegments.value.some((segment) => !state.value.translations.get(segment.id)?.trim()));
const hasPendingDocument = computed(() =>
  doc.value?.segments.some((segment) => !state.value.translations.get(segment.id)?.trim()) ?? false,
);

function languageFontClass(language: string, text: string): 'font-en' | 'font-zh' {
  const normalized = (language || 'auto').toLowerCase();
  if (normalized.startsWith('zh')) return 'font-zh';
  if (normalized.startsWith('en')) return 'font-en';
  if (normalized === 'auto') {
    // Use the Chinese font when CJK is a meaningful part of the segment, not for a lone
    // Chinese name embedded in an otherwise English paragraph.
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return cjk > 0 && cjk >= latin * 0.25 ? 'font-zh' : 'font-en';
  }
  // This reader exposes separate English/Chinese typography; other scripts use the English fallback.
  return 'font-en';
}
const builtInDocumentSystemPrompt = computed(() => {
  const base = buildStyledSystemContent(
    sourceLang.value,
    targetLang.value,
    literaryMode.value ? undefined : glossary.value,
    readerConfig.value?.promptStyle || 'default',
    literaryMode.value ? 'literary' : (readerConfig.value?.translationMode || 'technical'),
  );
  // Include the static book workflow instructions shown to the model, not just the generic profile.
  return literaryMode.value ? base + '\n\n' + buildLiteraryTranslationContextPrompt() : base;
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
const entitySearch = ref('');
const entityFilter = ref<'all' | 'pending' | 'confirmed'>('all');
const pendingEntityCount = computed(() => literaryMemory.value.entities.filter((entity) => entity.reviewStatus !== 'confirmed').length);
const confirmedEntityCount = computed(() => literaryMemory.value.entities.filter((entity) => entity.reviewStatus === 'confirmed').length);
const confirmableEntityCount = computed(() => literaryMemory.value.entities.filter((entity) =>
  entity.reviewStatus !== 'confirmed' && !!entity.source.trim() && !!entity.target.trim(),
).length);
const pendingRelationshipCount = computed(() => literaryMemory.value.relationships.filter((relation) => relation.reviewStatus !== 'confirmed').length);
const confirmableRelationshipCount = computed(() => literaryMemory.value.relationships.filter((relation) =>
  relation.reviewStatus !== 'confirmed' && !!relation.subject.trim() && !!relation.predicate.trim() && !!relation.object.trim(),
).length);
const filteredLiteraryEntities = computed(() => {
  const query = entitySearch.value.toLocaleLowerCase();
  return literaryMemory.value.entities
    .map((entity, index) => ({ entity, index }))
    .filter(({ entity }) => {
      if (entityFilter.value === 'pending' && entity.reviewStatus === 'confirmed') return false;
      if (entityFilter.value === 'confirmed' && entity.reviewStatus !== 'confirmed') return false;
      if (!query) return true;
      return [entity.source, entity.target, ...(entity.aliases ?? [])]
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
});

const currentPageTranslatedCount = computed(() =>
  visibleSegments.value.filter((segment) => !!state.value.translations.get(segment.id)?.trim()).length,
);
const translatedSegmentCount = computed(() =>
  doc.value?.segments.filter((segment) => !!state.value.translations.get(segment.id)?.trim()).length ?? 0,
);
/** 阅读 Tab 默认首屏；书籍记忆/审校移到第二个 Tab，避免挤占正文主屏。 */
const activeTab = ref<'reading' | 'memory' | 'agent'>('reading');
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

watch(activeTab, async (nextTab, previousTab) => {
  if (nextTab !== 'reading' || previousTab !== 'agent' || !doc.value) return;
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  if (!config.useLocalAgent) return;
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
  if (literaryMode.value) void persistCurrentSession();
}, { deep: true });

onMounted(async () => {
  // 文档翻译默认沿用 popup 的全局配置；恢复旧会话时，保存的语言选择仍由恢复逻辑覆盖。
  const config = await getConfig();
  readerConfig.value = config;
  sourceLang.value = config.sourceLang || 'auto';
  targetLang.value = config.targetLang || 'zh';
  englishFontFamily.value = config.documentEnglishFontFamily || 'Georgia';
  chineseFontFamily.value = config.documentChineseFontFamily || 'Noto Serif CJK SC';
  englishFontSize.value = Number.isFinite(config.documentEnglishFontSize) ? config.documentEnglishFontSize : 17;
  chineseFontSize.value = Number.isFinite(config.documentChineseFontSize) ? config.documentChineseFontSize : 18;
  documentSystemPromptOverride.value = config.documentSystemPromptOverride || '';
  documentSystemPromptEditor.value = documentSystemPromptOverride.value || builtInDocumentSystemPrompt.value;
  documentUserPromptTemplate.value = config.documentUserPromptTemplate || '';
  documentUserPromptEditor.value = documentUserPromptTemplate.value || BUILT_IN_USER_PROMPT_TEMPLATE;
  if (config.translationMode === 'literary') literaryMode.value = true;
  await refreshSavedSessionSummary();
});

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
  if (readerConfig.value?.useLocalAgent) {
    try {
      const project = await ensureDocumentWorkspace();
      if (!project) return;
      await workspaceApi(readerConfig.value.localAgentUrl || 'http://127.0.0.1:8789', readerConfig.value.localAgentToken || '',
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
  activeTab.value = 'memory';
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

/** 子设置面板只提交用户实际改动的字段，避免打开第二个 Tab 时覆盖会话语言。 */
function onTranslationSettingsUpdated(config: Config, changedFields: (keyof Config)[]) {
  readerConfig.value = config;
  if (changedFields.includes('sourceLang')) sourceLang.value = config.sourceLang;
  if (changedFields.includes('targetLang')) targetLang.value = config.targetLang;
  if (changedFields.includes('translationMode')) {
    // 全局翻译类型变化时同步整本书记忆开关，避免界面显示“科技翻译”但后台仍跑文学流程。
    // EPUB/PDF 用户仍可在确认选择科技模式后，手动再次启用“整本书记忆”覆盖项。
    literaryMode.value = config.translationMode === 'literary';
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
  readerConfig.value = await getConfig();
  documentSystemPromptOverride.value = systemOverride;
  documentUserPromptTemplate.value = userTemplate;
  documentSystemPromptEditor.value = systemOverride || builtInDocumentSystemPrompt.value;
  documentUserPromptEditor.value = userTemplate || BUILT_IN_USER_PROMPT_TEMPLATE;
  persistenceMessage.value = '文档翻译 Prompt 已保存；新请求和强制重译会使用新设置，已有译文不会自动改写。';
}

async function restoreBuiltInDocumentPrompts() {
  await setConfig({ documentSystemPromptOverride: '', documentUserPromptTemplate: '' });
  readerConfig.value = await getConfig();
  documentSystemPromptOverride.value = '';
  documentUserPromptTemplate.value = '';
  documentSystemPromptEditor.value = builtInDocumentSystemPrompt.value;
  documentUserPromptEditor.value = BUILT_IN_USER_PROMPT_TEMPLATE;
  persistenceMessage.value = '已恢复内置文档翻译 Prompt。';
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
  loadedSourceFile.value = null;
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
function entityKindLabel(kind: LiteraryEntity['kind']) {
  const labels: Record<LiteraryEntity['kind'], string> = {
    person: '人物', place: '地点', object: '物品', organization: '组织', concept: '概念', other: '其他实体',
  };
  return labels[kind] || '其他实体';
}
function confirmEntity(entity: LiteraryEntity) {
  if (!entity.source.trim() || !entity.target.trim()) return;
  entity.reviewStatus = 'confirmed';
  persistenceMessage.value = '已纳入规范译名：' + entity.source + ' → ' + entity.target;
}
function toggleEntityConfirmation(entity: LiteraryEntity) {
  if (entity.reviewStatus === 'confirmed') {
    entity.reviewStatus = 'suggested';
    persistenceMessage.value = '已将“' + entity.source + '”移回待核对列表';
    return;
  }
  confirmEntity(entity);
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
  persistenceMessage.value = count > 0 ? '已将 ' + count + ' 项译名纳入规范，后续章节会优先采用' : '没有待核对的译名';
}
function setEntityAliases(entity: LiteraryEntity, event: Event) {
  const value = (event.target as HTMLInputElement | null)?.value ?? '';
  entity.aliases = Array.from(new Set(value.split(',').map((alias) => alias.trim()).filter(Boolean))).slice(0, 8);
  entity.reviewStatus = 'suggested';
}
function addEntity() {
  entitySearch.value = '';
  entityFilter.value = 'all';
  literaryMemory.value.entities.push({ source: '', target: '', kind: 'other', aliases: [], reviewStatus: 'suggested' });
  persistenceMessage.value = '已添加空白映射：填写原文名称和统一译名，再点击“确认并应用”';
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
  loadedSourceFile.value = file;
  // 先落盘上一册的最新状态，再开始解析新文件。
  await persistCurrentSession();
  await stopCurrentTranslation();
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
    readerConfig.value = config;
    sourceLang.value = config.sourceLang || 'auto';
    targetLang.value = config.targetLang || 'zh';

    // Re-selecting the same file restores the active IndexedDB reading session before a new
    // empty session replaces it. Translation cache remains a fallback for documents without a
    // matching saved reader session.
    let previousSession: LoadedActiveDocumentSession | null = null;
    try { previousSession = await loadActiveDocumentSession(); } catch { /* cache still supports reuse */ }
    if (previousSession &&
        previousSession.fileName === documentFileName &&
        buildDocumentAgentSessionId(previousSession.document, previousSession.fileName) ===
          buildDocumentAgentSessionId(doc.value, documentFileName)) {
      doc.value = previousSession.document;
      rawText = previousSession.rawText;
      glossary.value = previousSession.glossary;
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

/**
 * Stable, opaque identity for a parsed document. The same book gets the same local Agent
 * session scope after page reload/SQLite restore, while different books do not share SDK history.
 * This fingerprint never sends raw document text as an ID; only the hash leaves the extension.
 */
function buildDocumentAgentSessionId(document: ParsedDocument, fileName: string): string {
  let firstHash = 0x811c9dc5;
  let secondHash = 0x9e3779b9;
  const feed = (value: string) => {
    // Feed fields incrementally instead of joining an entire PDF/EPUB into another large string.
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      firstHash = Math.imul(firstHash ^ code, 0x01000193);
      secondHash = Math.imul(secondHash ^ code, 0x85ebca6b);
    }
    // Field boundary prevents ambiguity between concatenations such as ["ab", "c"] and ["a", "bc"].
    firstHash = Math.imul(firstHash ^ 0, 0x01000193);
    secondHash = Math.imul(secondHash ^ 0, 0x85ebca6b);
  };
  for (const value of [
    fileName, document.title, document.format,
    String(document.meta.segmentCount), String(document.meta.charCount),
  ]) feed(value);
  // Hash all source segments so edits anywhere in the same-length book start a clean session.
  for (const segment of document.segments) {
    feed(segment.id);
    feed(segment.text);
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return 'doc-' + hex(firstHash) + hex(secondHash);
}

/** 所有翻译入口共用同一份设置，重试时保持 provider、术语表和服务端模式不变。 */
async function buildTranslationOptions() {
  if (!doc.value) throw new Error('尚未打开文档');
  const config = await getConfig();
  readerConfig.value = config;
  return {
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
    glossary: glossary.value,
    promptStyle: config.promptStyle,
    translationMode: config.translationMode || 'technical',
    // Send exactly the prompt shown in this editor even when the user is using built-in defaults.
    // This keeps local Agent and direct server/provider request formats consistent and editable.
    documentSystemPromptOverride: config.documentSystemPromptOverride?.trim() || builtInDocumentSystemPrompt.value,
    documentUserPromptTemplate: config.documentUserPromptTemplate?.trim() || BUILT_IN_USER_PROMPT_TEMPLATE,
    // 文档本身始终先在本机解析。useServerTranslation 只决定规整后的片段在哪里翻译。
    useServerTranslation: config.useServerTranslation && !config.useLocalAgent,
    useLocalAgent: config.useLocalAgent,
    localAgentProvider: config.localAgentProvider,
    localAgentUrl: config.localAgentUrl,
    localAgentModel: config.localAgentModel,
    localAgentToken: config.localAgentToken,
    // Global literary profile enables entity/style memory for any structured document;
    // the EPUB/PDF checkbox remains an opt-in for users on the technical profile.
    literaryMode: literaryMode.value &&
      (config.translationMode === 'literary' || doc.value.format === 'epub' || doc.value.format === 'pdf'),
    skipReview: !literaryReview.value,
    // 本地与 vocal-saga 服务端翻译都按批执行，先提交当前阅读页的译文。
    prioritySegmentIds: currentPage.value?.segments.map((segment) => segment.id) ?? [],
    serverUrl: config.serverUrl,
    provider: config.provider,
    apiKey: config.deepseekApiKey,
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
    provider: config?.localAgentProvider || 'workbuddy',
    model: config?.localAgentModel || 'auto',
    translationMode: (literaryMode.value ? 'literary' : (config?.translationMode || 'technical')) as 'technical' | 'literary',
    literaryReview: (literaryMode.value || config?.translationMode === 'literary') && literaryReview.value,
    glossary: glossary.value,
    literaryMemory: literaryMemory.value,
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

/** 保证只有一份本机项目：导入旧阅读记录、刷新 SQLite 的当前版本，并备份原件。 */
async function ensureDocumentWorkspace(): Promise<any | null> {
  if (!doc.value) return null;
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  if (!config.useLocalAgent) return null;
  const base = config.localAgentUrl || 'http://127.0.0.1:8789';
  const token = config.localAgentToken || '';
  const input = workspaceInput();
  const prompt = workspacePromptInput();
  const mapping = await lookupWorkspaceProject(input);
  let project: any = null;
  if (mapping.projectId) {
    try {
      const current = await workspaceApi<{ project: any; runs?: any[] }>(
        base, token, '/api/documents/projects/' + encodeURIComponent(mapping.projectId),
      );
      project = current.project;
      workspaceActiveRun.value = (current.runs || []).find((run) => ['queued', 'running', 'awaiting_acceptance', 'partial', 'paused'].includes(run.status)) || null;
    } catch (error) {
      // 映射可能指向已归档/清理的项目，只有确认服务真的返回 404 才创建新项目。
      if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error;
    }
  }
  if (project && mapping.sourceChanged) {
    workspaceProject.value = project;
    workspaceSourceChanged.value = true;
    persistenceMessage.value = '同名文档的原文内容已变化。请切换到“翻译 Agent”，明确选择导入新来源版本或另建项目后再继续翻译。';
    activeTab.value = 'agent';
    return null;
  }
  workspaceSourceChanged.value = false;
  if (!project) {
    const created = await workspaceApi<{ project: any }>(base, token, '/api/documents/projects', {
      method: 'POST',
      body: JSON.stringify({ ...input, prompt }),
    });
    project = created.project;
    await rememberWorkspaceProject(input, project.projectId);
  } else {
    // 保存同一份 Prompt 配置；两个 Tab 的下一次运行会拿到同一个版本指纹。
    await workspaceApi(base, token, '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/prompts', {
      method: 'POST',
      body: JSON.stringify(prompt),
    });
  }
  // 首次切换时迁移 IndexedDB 已有译文；只填数据库中没有当前来源版本的片段。
  await importWorkspaceTranslations(base, token, project.projectId, state.value.translations);
  if (!project.sourceFileSaved && loadedSourceFile.value) {
    try {
      await backupWorkspaceSourceFile(base, token, project.projectId, loadedSourceFile.value);
    } catch (error) {
      // 原文备份是 workspace 的重要能力，但失败不应丢失已有译文或阻断可恢复运行。
      persistenceMessage.value = 'workspace 已保存解析文本，但原始文件备份失败：' + (error instanceof Error ? error.message : String(error));
    }
  }
  const refreshed = await workspaceApi<{ project: any; runs?: any[] }>(
    base, token, '/api/documents/projects/' + encodeURIComponent(project.projectId),
  );
  workspaceProject.value = refreshed.project;
  workspaceActiveRun.value = (refreshed.runs || []).find((run) => ['queued', 'running', 'awaiting_acceptance', 'partial', 'paused'].includes(run.status)) || null;
  const accepted = await loadWorkspaceAcceptedTranslations(base, token, project.projectId, refreshed.project.segmentCount || doc.value.segments.length);
  await replaceCurrentTranslations(accepted);
  return refreshed.project;
}

/**
 * 当用户从 Agent Tab 回到阅读页时，接管同一条已经存在的运行记录。
 * 这里不自动采纳 Agent Tab 的候选；只有从阅读页主动发起的普通翻译才自动采纳。
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
      const current = await workspaceApi<{ run: any }>(
        readerConfig.value?.localAgentUrl || 'http://127.0.0.1:8789',
        readerConfig.value?.localAgentToken || '',
        '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs/' + encodeURIComponent(runId),
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
    const latest = await workspaceApi<{ project: any; runs?: any[] }>(
      readerConfig.value?.localAgentUrl || 'http://127.0.0.1:8789',
      readerConfig.value?.localAgentToken || '',
      '/api/documents/projects/' + encodeURIComponent(project.projectId),
    );
    workspaceProject.value = latest.project;
    workspaceActiveRun.value = (latest.runs || []).find((item) => item.runId === runId) || run;
    const accepted = await loadWorkspaceAcceptedTranslations(
      readerConfig.value?.localAgentUrl || 'http://127.0.0.1:8789',
      readerConfig.value?.localAgentToken || '',
      project.projectId,
      latest.project.segmentCount || doc.value.segments.length,
    );
    const pendingCandidates = workspaceCandidateTranslations.value;
    await replaceCurrentTranslations(accepted);
    if (['awaiting_acceptance', 'partial', 'paused'].includes(run.status) && pendingCandidates.size) {
      workspaceCandidateTranslations.value = pendingCandidates;
      persistenceMessage.value = 'workspace 中有尚未采纳的候选译文；前往“翻译 Agent”比较并决定是否采用。';
    } else {
      workspaceCandidateTranslations.value = new Map();
      if (run.status === 'completed') workspaceActiveRun.value = null;
    }
    if (run.counts?.failed || ['partial', 'failed', 'paused'].includes(run.status)) {
      state.value.error = run.error || 'workspace 运行尚未全部完成，可到“翻译 Agent”继续或重试。';
    }
  } catch (error) {
    state.value.error = '读取 workspace 运行状态失败：' + (error instanceof Error ? error.message : String(error));
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
}) {
  if (!doc.value || state.value.running) return;
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  if (!config.useLocalAgent) return;
  const project = await ensureDocumentWorkspace();
  if (!project) return;
  const activeRun = workspaceActiveRun.value;
  if (activeRun && ['queued', 'running'].includes(activeRun.status)) {
    await followWorkspaceRun(project, activeRun);
    return;
  }
  if (activeRun && ['awaiting_acceptance', 'partial'].includes(activeRun.status) && (activeRun.counts?.candidate || 0) > 0) {
    activeTab.value = 'agent';
    persistenceMessage.value = '当前文档已有待采纳的 Agent 候选，请先在“翻译 Agent”中比较结果。';
    return;
  }
  const scope: { type: 'ids'; ids: string[] } | { type: 'failed' } | { type: 'stale' } | { type: 'all' } =
    options.scope || { type: 'ids', ids: options.ids || [] };
  if (scope.type === 'ids' && (!scope.ids || !scope.ids.length)) return;
  const base = config.localAgentUrl || 'http://127.0.0.1:8789';
  const token = config.localAgentToken || '';
  const response = await workspaceApi<{ run: any; started: boolean }>(
    base, token, '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs',
    { method: 'POST', body: JSON.stringify({ scope, prompt: workspacePromptInput() }) },
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
  state.value.workChapter = currentPage.value?.title || doc.value.title || 'document';
  state.value.workStage = 'workspace Agent 正在翻译';
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
      const candidateIds = (terminalRun.segments || [])
        .filter((row: any) => row.status === 'candidate' && typeof row.candidateTranslation === 'string')
        .map((row: any) => row.id as string);
      if (candidateIds.length) {
        const acceptedRun = await workspaceApi<{ run: any }>(base, token,
          '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/runs/' + encodeURIComponent(runId) + '/accept',
          { method: 'POST', body: JSON.stringify({ segmentIds: candidateIds }) });
        workspaceActiveRun.value = acceptedRun.run;
      }
      const finalProject = await workspaceApi<{ project: any }>(base, token, '/api/documents/projects/' + encodeURIComponent(project.projectId));
      workspaceProject.value = finalProject.project;
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
  if (workspaceRunId.value && workspaceProject.value && readerConfig.value?.useLocalAgent) {
    const runId = workspaceRunId.value;
    const generation = workspaceRunGeneration.value;
    workspaceRunGeneration.value++;
    workspaceRunId.value = '';
    try {
      const response = await workspaceApi<{ run: any }>(readerConfig.value.localAgentUrl || 'http://127.0.0.1:8789', readerConfig.value.localAgentToken || '',
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

async function startTranslate() {
  if (!doc.value || !visibleSegments.value.length || state.value.running) return;
  const config = readerConfig.value || await getConfig();
  readerConfig.value = config;
  if (config.useLocalAgent) {
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
        activeTab.value = 'agent';
        persistenceMessage.value = '当前文档已有待采纳的 Agent 候选，请先在“翻译 Agent”中比较结果。';
        return;
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
  if (config.useLocalAgent) {
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
  if (config.useLocalAgent) {
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
  if (config.useLocalAgent) {
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

.reader-font-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: .7rem;
  margin-top: .8rem;
}
.reader-appearance-settings .settings-heading h3,
.prompt-editor-panel .settings-heading h3,
.review-workspace-heading h3 {
  margin: 0;
  font-size: 1rem;
}
.reader-appearance-settings .settings-heading p,
.prompt-editor-panel .settings-heading p,
.review-workspace-heading p {
  margin: .3rem 0 0;
  line-height: 1.55;
}
.settings-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .55rem;
  margin-top: .75rem;
}
.prompt-editor-panel { display: grid; gap: .85rem; }
.prompt-editor-label {
  display: flex;
  flex-direction: column;
  gap: .35rem;
  min-width: 0;
  color: #24292f;
}
.prompt-editor-label textarea {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: .7rem;
  border: 1px solid #c8d1dc;
  border-radius: 8px;
  background: #fbfcfe;
  color: #1f2328;
  font: .82rem/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  tab-size: 2;
}
.prompt-editor-label textarea:focus {
  outline: 2px solid rgba(9, 105, 218, .22);
  border-color: #0969da;
}
.built-in-prompt-preview {
  border: 1px solid #e1e6ec;
  border-radius: 7px;
  padding: .55rem .7rem;
  background: #f8fafc;
}
.built-in-prompt-preview summary { cursor: pointer; color: #57606a; font-size: .82rem; }
.built-in-prompt-preview pre {
  max-height: 22rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: .65rem 0 0;
  color: #24292f;
  font: .78rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.review-workspace-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: .7rem;
}
.review-empty {
  margin-top: .8rem;
  padding: 1rem;
  border: 1px dashed #cbd4df;
  border-radius: 8px;
  background: #fafbfc;
}
.review-empty p { margin: .3rem 0 0; }
.review-proposal {
  margin-top: .75rem;
  padding: .8rem;
  border: 1px solid #b6d6fb;
  border-radius: 8px;
  background: #f5f9ff;
}
.review-proposal > p { margin: .45rem 0 .7rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.review-proposal-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .45rem;
  margin-top: .55rem;
}
.review-legacy-note, .review-auto-note { line-height: 1.55; }
.review-category { display: inline-flex; border-radius: 999px; padding: .2rem .55rem; font-size: .74rem; font-weight: 650; }
.category-style { color: #6e40c9; background: #fbefff; }
.category-accuracy { color: #9a3412; background: #fff1e5; }
.category-terminology { color: #0550ae; background: #ddf4ff; }
.review-status { margin-left: auto; border-radius: 999px; padding: .2rem .5rem; font-size: .72rem; background: #f0f3f6; color: #57606a; }
.status-pending { color: #7d4e00; background: #fff1c2; }
.status-applied { color: #1a7f37; background: #dafbe1; }
.status-dismissed { color: #57606a; background: #f0f3f6; }

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
.workspace-candidate-label {
  display: block;
  width: fit-content;
  margin: 0 0 .4rem;
  padding: .12rem .4rem;
  border-radius: 4px;
  background: #fff7e6;
  color: #ad6800;
  border: 1px solid #ffe7ba;
  font-size: .72rem;
  line-height: 1.4;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.seg .tr.is-workspace-candidate { border-left: 2px solid #d48806; padding-left: .7rem; }
.seg .font-en { font-family: var(--document-font-en, Georgia), serif; font-size: var(--document-size-en, 17px); }
.seg .font-zh { font-family: var(--document-font-zh, 'Noto Serif CJK SC'), serif; font-size: var(--document-size-zh, 18px); }
.seg.kind-heading.level-1 .font-en, .seg.kind-heading.level-1 .font-zh { font-size: 1.7em; }
.seg.kind-heading.level-2 .font-en, .seg.kind-heading.level-2 .font-zh { font-size: 1.4em; }
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

.character-voice-bible { display: flex; flex-direction: column; gap: .9rem; }
.voice-counts { display: flex; flex-wrap: wrap; gap: .35rem; }
.voice-profile-card { border: 1px solid #e8e8e8; border-radius: 8px; padding: .85rem; display: flex; flex-direction: column; gap: .55rem; }
.voice-profile-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; }
.voice-profile-heading p { margin: .2rem 0 0; }
.voice-profile-fields p, .voice-profile-card > p { margin: .25rem 0; line-height: 1.55; }
.voice-evidence { border-top: 1px solid #f0f0f0; padding: .5rem 0; }
.voice-evidence p { margin: 0 0 .35rem; }
.voice-evidence blockquote { margin: .3rem 0; padding: .4rem .7rem; border-left: 2px solid #d0d7de; background: #f6f8fa; white-space: pre-wrap; }
.voice-profile-actions { display: flex; gap: .4rem; flex-wrap: wrap; }
.entity-status.is-rejected { background: #fff1f0; color: #a8071a; }
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

.dictionary-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: .8rem;
}
.dictionary-heading h3 { margin: 0; font-size: 1rem; }
.dictionary-heading p { margin: .3rem 0 0; line-height: 1.55; }
.dictionary-toolbar {
  display: grid;
  gap: .65rem;
  margin: .85rem 0;
  padding-bottom: .8rem;
  border-bottom: 1px solid #eaeef2;
}
.entity-search {
  width: 100%;
  padding: .55rem .65rem;
  border: 1px solid #d0d7de;
  border-radius: 7px;
  font: inherit;
}
.entity-filters, .dictionary-actions, .relationship-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .45rem;
}
.filter-chip {
  padding: .28rem .65rem;
  border: 1px solid transparent;
  border-radius: 999px;
  background: #f0f3f6;
  color: #57606a;
  cursor: pointer;
  font-size: .78rem;
}
.filter-chip.active {
  border-color: #0969da;
  background: #eaf3ff;
  color: #0969da;
}
.dictionary-actions { margin-top: .1rem; }
.entity-card-list { display: grid; gap: .7rem; }
.entity-card {
  min-width: 0;
  padding: .8rem;
  border: 1px solid #dce2e8;
  border-radius: 9px;
  background: #fff;
}
.entity-card.is-pending-card { border-left: 3px solid #bf8700; }
.entity-card-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .45rem;
}
.entity-card-spacer { flex: 1; }
.entity-status {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: .18rem .55rem;
  font-size: .73rem;
  font-weight: 600;
}
.entity-status.is-confirmed { color: #1a7f37; background: #dafbe1; }
.entity-status.is-pending { color: #7d4e00; background: #fff1c2; }
.entity-kind { color: #57606a; font-size: .75rem; }
.entity-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: end;
  gap: .65rem;
  margin-top: .75rem;
}
.entity-fields label, .entity-aliases label {
  display: flex;
  flex-direction: column;
  gap: .3rem;
  min-width: 0;
  color: #57606a;
  font-size: .77rem;
}
.entity-fields input, .entity-aliases input {
  min-width: 0;
  width: 100%;
  padding: .48rem .55rem;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  color: #1f2328;
  font: inherit;
  font-size: .9rem;
}
.entity-arrow { color: #8c959f; padding-bottom: .5rem; }
.entity-aliases { margin-top: .65rem; }
.entity-aliases summary { font-size: .78rem; color: #57606a; }
.entity-aliases label { margin-top: .5rem; }
.entity-evidence {
  margin: .55rem 0 0;
  color: #57606a;
  font-size: .76rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.entity-evidence strong { color: #1f2328; }
.entity-empty {
  display: grid;
  justify-items: start;
  gap: .4rem;
  padding: 1.4rem .8rem;
  border: 1px dashed #d0d7de;
  border-radius: 8px;
  background: #fafbfc;
}
.entity-empty p { margin: 0; }
.relationship-section {
  margin-top: 1rem;
  padding-top: .8rem;
  border-top: 1px solid #eaeef2;
}
.relationship-section summary { font-size: .9rem; }
.relationship-help { margin: .35rem 0 .55rem; line-height: 1.5; }
.relationship-actions { margin-top: .5rem; }
.dictionary-footnote { margin: .9rem 0 0; padding-top: .7rem; border-top: 1px solid #eaeef2; line-height: 1.55; }
.danger-text { color: #a40e26; }

@media (max-width: 640px) {
  .reader-font-grid { grid-template-columns: 1fr 1fr; }
  .prompt-editor-label textarea { font-size: .76rem; }
  .doc-page { padding: 1rem .75rem 3rem; }
  .reader-navigation { position: static; }
  .reader-navigation-controls { width: 100%; justify-content: space-between; }
  .page-select { flex: 1; max-width: none; }
  .reader { min-height: 50vh; padding: 1rem; border-radius: 8px; }
  .literary-editor-row { grid-template-columns: 1fr 1fr; }
  .literary-editor-row .chip { align-self: center; }
  .entity-fields { grid-template-columns: 1fr; }
  .entity-arrow { display: none; }
  .entity-card-header { align-items: flex-start; }
  .entity-card-spacer { display: none; }
  .dictionary-actions { align-items: stretch; }
}
</style>
