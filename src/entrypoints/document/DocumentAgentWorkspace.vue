<template>
  <section class="document-agent-workspace">
    <header class="agent-hero">
      <div class="agent-kicker">文档翻译 · Agent</div>
      <div class="agent-hero-main">
        <div class="agent-title-copy">
          <h2>{{ title }}</h2>
          <p>翻译、审校、保存进度会自动完成。你可以随时回到阅读页查看结果。</p>
        </div>
        <span class="agent-format">{{ format.toUpperCase() }}</span>
      </div>
      <div class="agent-meta">
        <span>{{ segments.length.toLocaleString() }} 段内容</span>
        <span class="agent-meta-dot">·</span>
        <span>{{ sourceLang }} → {{ targetLang }}</span>
        <span class="agent-meta-dot">·</span>
        <span>{{ translationMode === 'literary' ? '文学翻译' : '通用翻译' }}</span>
      </div>
    </header>

    <section v-if="!useLocalAgent" class="agent-notice">
      <strong>启用本机 Agent 后即可开始</strong>
      <p>请先到“设置与记忆”启用 Workbuddy 或 OpenCode。启用后，Agent 会自动建立项目、翻译内容并保存进度。</p>
    </section>

    <section
      v-if="preprocessingState.required && !preprocessingState.ready"
      class="agent-notice agent-preprocessing-notice"
      :class="'agent-preprocessing-' + preprocessingState.reason"
      role="status"
      aria-live="polite"
    >
      <div class="agent-preprocessing-copy">
        <strong>
          {{ ['queued', 'running'].includes(preprocessingState.status)
            ? '本机服务正在准备全书上下文'
            : preprocessingState.reason === 'failed'
              ? '上次全书预处理失败'
              : '当前预处理状态尚未就绪' }}
        </strong>
        <p>{{ preprocessingState.message }}</p>
        <p v-if="preprocessingState.runId" class="agent-footnote">
          预处理任务 {{ preprocessingState.runId }} · {{ preprocessingState.phase || '等待状态' }}
        </p>
        <div
          v-if="['queued', 'running'].includes(preprocessingState.status)"
          class="agent-preprocessing-progress"
          role="progressbar"
          :aria-valuenow="preprocessingState.progressPercent || 0"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div :style="{ width: (preprocessingState.progressPercent || 0) + '%' }"></div>
        </div>
      </div>
      <button class="agent-button agent-button-secondary" type="button" @click="emit('openPreprocessing')">
        {{ ['queued', 'running'].includes(preprocessingState.status) ? '查看预处理进度' : '打开预处理状态' }}
      </button>
    </section>

    <section v-if="restoringProject && !project" class="agent-notice">
      <span class="agent-spinner" aria-hidden="true"></span>
      <div>
        <strong>正在恢复文档进度</strong>
        <p>正在连接这份文档已有的本机项目，不需要重新创建。</p>
      </div>
    </section>

    <section v-if="restorationError && !project" class="agent-notice agent-notice-error">
      <strong>暂时无法恢复文档进度</strong>
      <p>{{ restorationError }}</p>
      <div class="agent-inline-actions">
        <button class="agent-button agent-button-secondary" :disabled="restoringProject || busy" @click="loadExistingProject">重试</button>
        <button v-if="restorationProjectMissing" class="agent-button agent-button-primary" :disabled="restoringProject || busy" @click="recreateMissingProject">重建项目</button>
      </div>
    </section>

    <template v-if="!project && !restoringProject && !restorationError">
      <section class="agent-work-card agent-ready-card">
        <div class="agent-state-mark" aria-hidden="true">文</div>
        <div class="agent-ready-copy">
          <h3>准备好开始翻译</h3>
          <p>首次运行会自动建立本机项目。之后直接续译未完成内容，不会要求你手动填写译文。</p>
        </div>
        <button
          class="agent-button agent-button-primary agent-button-large"
          :disabled="busy || restoringProject || segments.length === 0"
          @click="startRun('stale')"
        >
          {{ busy ? '正在准备…' : '初始化项目并开始翻译' }}
        </button>
      </section>
    </template>

    <template v-if="project">
      <section v-if="sourceChanged" class="agent-notice agent-notice-warning">
        <strong>这份文档的原文已经变化</strong>
        <p>为了避免把旧译文错配到新原文，需要先登记新来源版本。旧版本和历史记录会保留。</p>
        <div class="agent-inline-actions">
          <button class="agent-button agent-button-primary" :disabled="busy || isRunning || !segments.length" @click="updateSourceRevision">更新来源并保留历史</button>
          <button class="agent-button agent-button-secondary" :disabled="busy || isRunning" @click="createSeparateProject">另建项目</button>
        </div>
      </section>

      <section v-else class="agent-work-card agent-progress-card">
        <div class="agent-progress-heading">
          <div class="agent-progress-copy">
            <div class="agent-section-kicker">{{ isRunning ? '正在处理' : pendingSegmentCount > 0 ? '等待继续' : '翻译状态' }}</div>
            <h3>{{ isRunning ? 'Agent 正在翻译这份文档' : pendingSegmentCount > 0 ? '继续完成这份文档' : '这份文档已完成' }}</h3>
            <p v-if="isRunning">翻译结果会自动保存。关闭此页面也不会删除已经记录的进度。</p>
            <p v-else-if="pendingSegmentCount > 0">Agent 会自动处理所有未完成或已过期的内容，并保留已完成的人工修订。</p>
            <p v-else>所有段落都已有当前有效译文。可以返回阅读，或在“更多选项”中重新翻译。</p>
          </div>
          <div class="agent-progress-number" :class="{ 'is-complete': pendingSegmentCount === 0 && !isRunning }">
            <strong>{{ isRunning ? runProgressPercent : documentProgressPercent }}%</strong>
            <span>{{ isRunning ? '本次任务' : '全书完成度' }}</span>
          </div>
        </div>

        <div class="agent-progress-track" role="progressbar" :aria-valuenow="isRunning ? runProgressPercent : documentProgressPercent" aria-valuemin="0" aria-valuemax="100">
          <div class="agent-progress-fill" :style="{ width: (isRunning ? runProgressPercent : documentProgressPercent) + '%' }"></div>
        </div>

        <div class="agent-progress-foot">
          <span>{{ acceptedSegmentCount.toLocaleString() }} / {{ totalSegmentCount.toLocaleString() }} 段已采用</span>
          <span v-if="pendingSegmentCount > 0">{{ pendingSegmentCount.toLocaleString() }} 段待处理</span>
          <span v-else>没有待处理段落</span>
        </div>

        <div class="agent-main-actions">
          <button
            v-if="isRunning"
            class="agent-button agent-button-primary agent-button-large"
            disabled
          >
            <span class="agent-spinner" aria-hidden="true"></span>
            正在翻译…
          </button>
          <button
            v-else-if="pendingSegmentCount > 0"
            class="agent-button agent-button-primary agent-button-large"
            :disabled="busy || sourceChanged"
            @click="startRun('stale')"
          >
            {{ busy ? '正在准备…' : acceptedSegmentCount > 0 ? '继续翻译' : '开始翻译' }}
            <span v-if="pendingSegmentCount > 0" class="agent-button-count">{{ pendingSegmentCount.toLocaleString() }}</span>
          </button>
          <span v-else class="agent-complete-label"><span aria-hidden="true">✓</span> 翻译已完成</span>
          <button v-if="isRunning" class="agent-button agent-button-secondary" :disabled="busy" @click="cancelRun">停止</button>
        </div>

        <div v-if="autoAcceptingRunId && autoAcceptingRunId === activeRun?.runId" class="agent-inline-status">
          正在自动保存译文并同步到阅读页…
        </div>
        <div v-else-if="activeRun && !isRunning && (activeRun.counts?.candidate || 0) > 0" class="agent-pending-output">
          <div>
            <strong>{{ autoAcceptError ? '自动保存失败' : '译文已生成，正在保存' }}</strong>
            <p>{{ autoAcceptError || '正在把已生成的译文写入项目并同步到阅读页；不需要重新翻译。' }}</p>
          </div>
          <button class="agent-button agent-button-secondary" :disabled="busy || !!autoAcceptingRunId" @click="autoAcceptReadyCandidates">
            {{ autoAcceptError ? '重试保存' : '立即保存' }}
          </button>
        </div>

        <div v-if="activeRun" class="agent-run-summary">
          <span class="agent-status-dot" :class="'status-' + activeRun.status"></span>
          <span>{{ runStatusLabel(activeRun.status) }}</span>
          <span class="agent-meta-dot">·</span>
          <span>最近运行 {{ new Date(activeRun.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}</span>
          <span v-if="activeRun.counts?.failed" class="agent-run-failure">{{ activeRun.counts.failed }} 段未完成，可仅重试这些片段</span>
        </div>
        <p v-if="activeRun.error" class="agent-failed-segment-error agent-run-error">{{ activeRun.error }}</p>
        <details v-if="failedRunSegments.length" class="agent-failed-segments">
          <summary>查看未完成片段的原因（{{ failedRunSegments.length }} 段）</summary>
          <p class="agent-detail-description">这里列出每个未完成片段最后一次记录的原因、尝试次数和原文摘要。若提示“模型未返回完整的片段集合”，请展开“Agent 执行轨迹”，查看模型调用与重试事件。</p>
          <article v-for="item in failedRunSegments" :key="item.id" class="agent-failed-segment">
            <div class="agent-failed-segment-heading">
              <strong>{{ item.contextPath || '未完成片段' }}</strong>
              <span class="agent-segment-id">{{ item.id }}</span>
              <span class="agent-segment-attempts">尝试 {{ item.attempts || 0 }} 次</span>
            </div>
            <p class="agent-failed-segment-error">{{ item.error || '没有保存该片段的具体错误；请检查 Agent 执行轨迹中的模型调用事件。' }}</p>
            <p v-if="item.sourceExcerpt" class="agent-failed-segment-source">原文：{{ item.sourceExcerpt }}</p>
          </article>
        </details>
      </section>

      <p v-if="message" class="agent-feedback" role="status">{{ message }}</p>
      <p v-if="error" class="agent-feedback agent-feedback-error" role="alert">{{ error }}</p>

      <details class="agent-options">
        <summary>
          <span>更多选项</span>
          <span class="agent-options-hint">手动修订、重试、重新翻译与历史记录</span>
        </summary>
        <div class="agent-options-content">
          <section class="agent-option-group">
            <div class="agent-option-heading">
              <h4>翻译控制</h4>
              <p>一般情况下只需使用上方的开始 / 继续翻译。以下操作用于有明确需要时。</p>
            </div>
            <div class="agent-inline-actions">
              <button class="agent-button agent-button-secondary" :disabled="busy || isRunning || !(activeRun?.counts?.failed)" @click="startRun('failed')">
                重试未完成片段<span v-if="activeRun?.counts?.failed">（{{ activeRun.counts.failed }}）</span>
              </button>
              <button class="agent-button agent-button-secondary" :disabled="busy || isRunning || !visibleSegments.length" @click="startRun('visible')">重新翻译当前阅读页</button>
              <button class="agent-button agent-button-secondary" :disabled="busy || isRunning" @click="startRun('all')">重新翻译全文</button>
              <button v-if="['paused', 'failed', 'partial'].includes(activeRun?.status)" class="agent-button agent-button-secondary" :disabled="busy || isRunning" @click="resumeRun">恢复中断任务</button>
              <button class="agent-button agent-button-tertiary" :disabled="busy || isRunning" @click="refreshProject">刷新状态</button>
            </div>
            <p class="agent-footnote">重新翻译会生成新结果。相同原文版本下已有的人工修订会优先保留。</p>
          </section>

          <section class="agent-option-group agent-quality-audit">
            <div class="agent-option-heading">
              <h4>全书质量审计</h4>
              <p>检查缺译、规范译名冲突、英文残留、数字差异与重复表达。审计只生成问题清单，不会直接改写已采纳译文。</p>
            </div>
            <div class="agent-inline-actions">
              <button
                class="agent-button agent-button-secondary"
                :disabled="qualityAuditLoading || qualityAuditBlocked"
                @click="runQualityAudit"
              >
                {{ qualityAuditLoading ? '正在审计…' : '执行全书审计' }}
              </button>
              <button
                v-if="qualityAudit"
                class="agent-button agent-button-tertiary"
                :disabled="qualityAuditLoading || !project"
                @click="refreshQualityAudit"
              >读取最近报告</button>
              <button
                v-if="qualityAuditMatchesSource && selectedQualityRepairCount"
                class="agent-button agent-button-primary"
                :disabled="qualityAuditRepairing || busy || isRunning || sourceChanged"
                @click="repairSelectedQualityFindings"
              >
                {{ qualityAuditRepairing ? '正在创建返工任务…' : '定点返工（' + selectedQualityRepairCount + '）' }}
              </button>
            </div>
            <p v-if="qualityAuditUnavailable" class="agent-footnote">全书审计需等待当前任务结束，并确保来源版本没有待确认变更。</p>
            <p v-if="qualityAuditError" class="agent-feedback agent-feedback-error" role="alert">{{ qualityAuditError }}</p>
            <p v-if="qualityAudit && !qualityAuditMatchesSource" class="agent-quality-stale" role="status">
              这份报告对应旧的原文版本，不能用于当前版本的返工。请重新执行审计。
            </p>
            <template v-else-if="qualityAuditMatchesSource">
              <div class="agent-quality-metrics">
                <span>缺译 <strong>{{ qualityAudit.metrics?.missingTranslationCount || 0 }}</strong></span>
                <span>规范名冲突 <strong>{{ qualityAudit.metrics?.canonicalNameMappingConflictCount || 0 }}</strong></span>
                <span>译名漂移 <strong>{{ qualityAudit.metrics?.terminologyDriftCount || 0 }}</strong></span>
                <span>英文残留 <strong>{{ qualityAudit.metrics?.englishResidueCount || 0 }}</strong></span>
                <span>数字差异 <strong>{{ qualityAudit.metrics?.numericTokenMismatchCount || 0 }}</strong></span>
                <span>重复表达组 <strong>{{ qualityAudit.metrics?.repeatedExpressionDriftGroups || 0 }}</strong></span>
              </div>
              <p class="agent-footnote">
                报告共 {{ qualityAudit.findings?.length || 0 }} 项。可勾选可返工的问题创建新的候选 Run；规范译名冲突需要先在“人物角色/声音”或 LiteraryMemory 中人工统一，不允许自动猜选。
              </p>
              <div v-if="qualityAudit.findings?.length" class="agent-quality-findings">
                <div class="agent-quality-filter">
                  <label class="agent-quality-filter-label" for="quality-audit-filter">筛选问题</label>
                  <input
                    id="quality-audit-filter"
                    v-model="qualityAuditQuery"
                    type="search"
                    placeholder="人物名、规范译名、章节、片段 ID、英文残留…"
                    autocomplete="off"
                  >
                  <span class="agent-quality-filter-count">
                    {{ qualityAuditFilteredFindings.length }} / {{ qualityAudit.findings.length }} 项
                  </span>
                  <button
                    v-if="qualityAuditQuery"
                    class="agent-button agent-button-tertiary"
                    type="button"
                    @click="qualityAuditQuery = ''"
                  >清除</button>
                </div>
                <article
                  v-for="finding in qualityAuditDisplayedFindings"
                  :key="finding.findingId"
                  class="agent-quality-finding"
                >
                  <div class="agent-quality-finding-heading">
                    <label v-if="finding.repairable === true" class="agent-quality-select">
                      <input v-model="selectedQualityFindingIds" type="checkbox" :value="String(finding.findingId)">
                      <span>定点返工</span>
                    </label>
                    <span class="agent-finding-kind">{{ qualityFindingLabel(finding) }}</span>
                    <span class="agent-quality-severity" :class="'severity-' + String(finding.severity || 'review')">
                      {{ qualitySeverityLabel(finding.severity) }}
                    </span>
                    <span class="agent-segment-id">{{ (finding.segmentIds || []).length }} 段</span>
                  </div>
                  <p class="agent-quality-explanation">{{ finding.explanation || finding.reason || '需要结合原文和上下文复核。' }}</p>
                  <p v-if="finding.entity?.source" class="agent-quality-evidence">
                    规范原文名：{{ finding.entity.source }}
                    <span v-if="finding.entity?.target"> · 规范译名：{{ finding.entity.target }}</span>
                    <span v-if="finding.entity?.targets?.length"> · 冲突译名：{{ finding.entity.targets.join(' / ') }}</span>
                  </p>
                  <p v-if="finding.residueExamples?.length" class="agent-quality-evidence">
                    疑似残留：{{ finding.residueExamples.join(' / ') }}
                  </p>
                  <details class="agent-quality-detail">
                    <summary>查看片段证据</summary>
                    <p v-if="finding.chapter">章节：{{ finding.chapter }}</p>
                    <p v-if="finding.sourceExcerpt">原文：{{ finding.sourceExcerpt }}</p>
                    <p v-if="finding.translationExcerpt">译文：{{ finding.translationExcerpt }}</p>
                    <p v-else-if="finding.draftExcerpt">译文：{{ finding.draftExcerpt }}</p>
                    <p v-if="finding.segmentIds?.length">片段 ID：{{ finding.segmentIds.slice(0, 12).join('、') }}{{ finding.segmentIds.length > 12 ? '…' : '' }}</p>
                  </details>
                </article>
                <p v-if="qualityAuditFilteredFindings.length > 80" class="agent-footnote">
                  当前筛选结果较多，仅展示前 80 项。输入人物名、译名或片段 ID 可缩小范围；完整报告仍保存在本机项目数据库中。
                </p>
              </div>
              <p v-else-if="qualityAuditQuery" class="agent-detail-description">当前筛选条件没有匹配项。可以尝试人物规范名、目标译名、章节或片段 ID。</p>
              <p v-else class="agent-detail-description">当前审计没有发现上述规则能够识别的问题。这不代表模型审校已证明译文完全正确。</p>
            </template>
          </section>

          <section v-if="!project.sourceFileSaved && sourceFile" class="agent-option-group">
            <div class="agent-option-heading">
              <h4>原始文件备份</h4>
              <p>项目已保存解析后的原文。备份原始 EPUB/PDF，方便将来恢复和核对。</p>
            </div>
            <button class="agent-button agent-button-secondary" :disabled="busy" @click="uploadCurrentSourceFile">备份原文件</button>
          </section>

          <details class="agent-subdetails">
            <summary>手动修订（可选）</summary>
            <p class="agent-detail-description">只有当你想纠正某一段时才需要使用。Agent 翻译不需要你预先提供译文；保存的修订会作为人工版本留档。</p>
            <label class="agent-field">
              <span>当前阅读页片段</span>
              <select v-model="selectedSegmentId" @change="loadSelectedTranslation">
                <option v-for="segment in visibleSegments" :key="segment.id" :value="segment.id">
                  {{ segment.id }} · {{ segment.text.slice(0, 70) }}
                </option>
              </select>
            </label>
            <label v-if="selectedSegment" class="agent-field">
              <span>原文</span>
              <div class="agent-source-preview">{{ selectedSegment.text }}</div>
            </label>
            <label class="agent-field">
              <span>修订后的译文</span>
              <textarea v-model="manualText" rows="4" placeholder="仅在需要人工纠正时填写"></textarea>
            </label>
            <div class="agent-inline-actions">
              <button class="agent-button agent-button-secondary" :disabled="busy || !selectedSegmentId || !manualText.trim()" @click="saveManualEdit">保存修订</button>
              <span class="agent-footnote">人工修订会同步到阅读器，并优先于同一原文版本的模型结果。</span>
            </div>
          </details>

          <details class="agent-subdetails">
            <summary>运行历史（{{ runs.length }}）</summary>
            <div v-if="runs.length" class="agent-history-list">
              <div v-for="run in runs" :key="run.runId" class="agent-history-row">
                <div class="agent-history-copy">
                  <strong>{{ new Date(run.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}</strong>
                  <span>{{ run.scope?.type === 'stale' ? '未完成内容' : run.scope?.type === 'all' ? '全文重译' : run.scope?.type === 'failed' ? '未完成片段重试' : '指定范围' }} · {{ run.runId.slice(0, 8) }}</span>
                </div>
                <span class="agent-history-status">{{ runStatusLabel(run.status) }}</span>
                <button class="agent-button agent-button-tertiary" :disabled="busy" @click="selectRun(run.runId)">查看</button>
              </div>
            </div>
            <p v-else class="agent-detail-description">完成首次翻译后，这里会保留每次运行记录。</p>
          </details>

          <details v-if="activeRun?.findings?.length" class="agent-subdetails">
            <summary>审校意见（{{ activeRun.findings.length }}）</summary>
            <div class="agent-findings">
              <div v-for="finding in activeRun.findings.slice(0, 12)" :key="finding.findingId" class="agent-finding-row">
                <span class="agent-finding-kind">{{ finding.category === 'accuracy' ? '准确性' : finding.category === 'terminology' ? '术语' : '文风' }}</span>
                <span class="agent-finding-id">{{ finding.segmentId }}</span>
                <p>{{ finding.finding?.reason || finding.finding?.suggestion || '审校建议' }}</p>
                <div v-if="finding.finding?.proposedTranslation" class="agent-style-proposal">
                  <strong>文风候选译文</strong>
                  <p>{{ finding.finding.proposedTranslation }}</p>
                  <div class="agent-style-proposal-actions">
                    <button class="agent-button agent-button-primary"
                      :disabled="busy || finding.status === 'applied' || finding.finding?.applicationStatus === 'applied'"
                      @click="applyStyleFinding(finding)">
                      {{ finding.status === 'applied' || finding.finding?.applicationStatus === 'applied' ? '已采用' : '采用并保存' }}
                    </button>
                    <button class="agent-button agent-button-tertiary"
                      :disabled="busy || finding.status === 'dismissed' || finding.finding?.applicationStatus === 'dismissed' || finding.status === 'applied'"
                      @click="dismissStyleFinding(finding)">保留当前译文</button>
                  </div>
                </div>
              </div>
            </div>
          </details>

          <details v-if="project" class="agent-subdetails">
            <summary>Agent 执行轨迹（{{ runEvents.length }} 条）</summary>
            <p class="agent-detail-description">显示本次运行实际执行的阶段、上下文注入计数、模型响应和异常。轨迹不包含完整原文、译文或 Prompt。</p>
            <div v-if="runEvents.length" class="agent-trace-list">
              <article v-for="event in [...runEvents].slice(-80).reverse()" :key="event.eventId" class="agent-trace-row">
                <div class="agent-trace-heading">
                  <strong>{{ eventTitle(event.type) }}</strong>
                  <span>{{ event.type }}</span>
                  <time>{{ new Date(event.createdAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}</time>
                </div>
                <p v-if="eventSummary(event)">{{ eventSummary(event) }}</p>
              </article>
            </div>
            <p v-else class="agent-detail-description">该运行还没有可显示的持久化事件。启动或刷新运行后会自动读取。</p>
          </details>
        </div>
      </details>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  backupWorkspaceSourceFile,
  importDocumentFileViaLocalAgent,
  importWorkspaceTranslations,
  loadWorkspaceAcceptedTranslations,
  lookupWorkspaceProject,
  rememberWorkspaceProject,
  resolveWorkspaceProject,
  updateWorkspaceSourceFromFile,
  workspaceApi,
  WorkspaceApiError,
} from './documentWorkspaceClient';

interface Segment {
  id: string;
  text: string;
  kind?: string;
  contextPath?: string;
  page?: number | null;
  level?: number;
  marker?: string;
  path?: string;
  start?: string;
  end?: string;
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
  glossary: unknown;
  taskProfiles: unknown;
}
const props = defineProps<{
  /** 父级 Agent Tab 当前是否可见；用于显示时恢复关联，但不因切换 Tab 销毁本组件。 */
  active: boolean;
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
  codeBuddyTaskProfiles?: Record<string, unknown>;
  systemPrompt: string;
  userPromptTemplate: string;
  literaryMemory: unknown;
  glossary: unknown;
  preprocessingState: {
    required: boolean;
    ready: boolean;
    reason: string;
    message: string;
    status: string;
    phase: string;
    runId: string;
    progressPercent: number;
    projectId: string;
    sourceRevisionId: string;
    expectedProjectId: string;
    expectedSourceRevisionId: string;
    sourceLang: string;
    targetLang: string;
    loading?: boolean;
  };
}>();
const emit = defineEmits<{
  acceptedTranslations: [items: Array<{ id: string; text: string }>];
  workspaceSync: [items: Array<{ id: string; text: string }>];
  projectUpdated: [project: any, sourceChanged?: boolean];
  openPreprocessing: [];
  preprocessingStatusRefreshRequested: [project?: any];
}>();

const project = ref<any>(null);
const sourceChanged = ref(false);
const restoringProject = ref(false);
const restorationError = ref('');
const restorationProjectMissing = ref(false);
const verification = ref<any>(null);
const activeRun = ref<any>(null);
const runs = ref<any[]>([]);
const runEvents = ref<any[]>([]);
let eventCursor = 0;
const busy = ref(false);
const error = ref('');
const message = ref('');
const selectedSegmentId = ref('');
const manualText = ref('');
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
/** Invalidates async responses when the parent switches the currently open document. */
let workspaceSourceGeneration = 0;
const autoAcceptingRunId = ref('');
const queuedAutoAcceptRunId = ref('');
const autoAcceptError = ref('');
const qualityAudit = ref<any>(null);
const qualityAuditLoading = ref(false);
const qualityAuditRepairing = ref(false);
const qualityAuditError = ref('');
const qualityAuditQuery = ref('');
const selectedQualityFindingIds = ref<string[]>([]);
const isRunning = computed(() => !!activeRun.value && ['queued', 'running'].includes(activeRun.value.status));
const selectedSegment = computed(() => props.visibleSegments.find((segment) => segment.id === selectedSegmentId.value));
const failedRunSegments = computed(() => {
  const segments = Array.isArray(activeRun.value?.segments) ? activeRun.value.segments : [];
  return segments.filter((segment: any) => segment.status === 'failed').map((segment: any) => {
    const source = props.segments.find((item: any) => String(item.id) === String(segment.id));
    return {
      ...segment,
      contextPath: String(source?.contextPath || source?.chapter || ''),
      sourceExcerpt: String(source?.text || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    };
  });
});
const totalSegmentCount = computed(() =>
  Number(verification.value?.totalSegments ?? project.value?.segmentCount ?? props.segments.length),
);
const acceptedSegmentCount = computed(() => Number(verification.value?.acceptedSegments ?? 0));
const pendingSegmentCount = computed(() => {
  const current = verification.value;
  if (!current) return props.segments.length;
  const ids = [
    ...(Array.isArray(current.missingSegmentIds) ? current.missingSegmentIds : []),
    ...(Array.isArray(current.staleSourceIds) ? current.staleSourceIds : []),
    ...(Array.isArray(current.stalePromptIds) ? current.stalePromptIds : []),
  ];
  return new Set(ids).size;
});
const documentProgressPercent = computed(() => totalSegmentCount.value
  ? Math.round(Math.min(100, acceptedSegmentCount.value / totalSegmentCount.value * 100))
  : 100);
const runProgressPercent = computed(() => {
  const counts = activeRun.value?.counts;
  if (!counts || !Number(counts.total)) return documentProgressPercent.value;
  // 未完成片段不能算作已处理，否则大规模失败时进度条也会显示 100%。
  const resolved = Number(counts.accepted || 0) + Number(counts.candidate || 0);
  return Math.round(Math.min(100, resolved / Number(counts.total) * 100));
});
const qualityAuditUnavailable = computed(() =>
  !project.value || busy.value || sourceChanged.value ||
  ['queued', 'running', 'paused'].includes(String(activeRun.value?.status || '')),
);
const qualityAuditBlocked = computed(() =>
  qualityAuditUnavailable.value || qualityAuditLoading.value || qualityAuditRepairing.value,
);
const qualityAuditMatchesSource = computed(() =>
  !!qualityAudit.value && !!project.value?.currentSourceRevisionId &&
  qualityAudit.value.sourceRevisionId === project.value.currentSourceRevisionId,
);
const qualityAuditFilteredFindings = computed(() => {
  const findings = Array.isArray(qualityAudit.value?.findings) ? qualityAudit.value.findings : [];
  const query = String(qualityAuditQuery.value || '').normalize('NFKC').toLocaleLowerCase().trim();
  if (!query) return findings;
  return findings.filter((finding: any) => {
    const haystack = [
      finding?.type, finding?.category, finding?.severity, finding?.chapter,
      finding?.explanation, finding?.reason, finding?.suggestion,
      finding?.entity?.source, finding?.entity?.target,
      ...(Array.isArray(finding?.entity?.targets) ? finding.entity.targets : []),
      ...(Array.isArray(finding?.residueExamples) ? finding.residueExamples : []),
      finding?.sourceExcerpt, finding?.translationExcerpt, finding?.draftExcerpt,
      ...(Array.isArray(finding?.segmentIds) ? finding.segmentIds : []),
    ].filter((value) => value !== null && value !== undefined).join(' ');
    return haystack.normalize('NFKC').toLocaleLowerCase().includes(query);
  });
});
const qualityAuditDisplayedFindings = computed(() => qualityAuditFilteredFindings.value.slice(0, 80));
const selectedQualityRepairCount = computed(() => {
  const repairableIds = new Set(
    (Array.isArray(qualityAudit.value?.findings) ? qualityAudit.value.findings : [])
      .filter((finding: any) => finding.repairable === true)
      .map((finding: any) => String(finding.findingId)),
  );
  return selectedQualityFindingIds.value.filter((id) => repairableIds.has(id)).length;
});
const runLabels: Record<string, string> = {
  queued: '排队中', running: '运行中', paused: '已暂停', awaiting_acceptance: '待采纳',
  partial: '部分完成', completed: '已完成', failed: '失败', cancelled: '已停止',
};
function runStatusLabel(status: string): string { return runLabels[status] || status; }

const eventLabels: Record<string, string> = {
  'run.context.ready': '上下文准备完成',
  'plan.ready': '批次计划',
  'stage.started': '阶段开始',
  'stage.completed': '阶段完成',
  'stage.warning': '阶段警告',
  'batch.started': '批次开始',
  'batch.prompt.ready': '翻译请求上下文',
  'batch.model.response': '模型返回结果',
  'model.usage': 'token 消耗',
  'batch.translation.completed': '初译完成',
  'batch.completed': '批次完成',
  'batch.partial': '批次部分返回',
  'model.call.failed': '模型调用失败',
  'run.failed': '运行失败',
  'run.completed': '运行完成',
  'review.context.ready': '审校上下文',
  'review.discarded': '审校结果已丢弃',
  'translations.accepted': '译文已采纳',
  'translation.context-delta.parsed': '初译上下文证据校验',
  'translation.context-delta.saved': '人物与上下文候选已保存',
  'translation.context-wave.ready': '后续翻译上下文已冻结',
  'translation.context-memory.persisted': '项目人物记忆已更新',
  'translation.context-memory.skipped': '项目记忆更新已跳过',
  'translation.context-memory.unchanged': '没有新的上下文候选',
};
function eventTitle(type: string): string { return eventLabels[type] || type; }
function eventSummary(event: any): string {
  const payload = event?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  // 仅显示有限元数据。Prompt/正文/译文类字段严格按名称排除，避免连 promptRevisionId
  // 和 prompt 长度等诊断字段一起过滤；嵌套对象不展开，避免意外显示原文片段。
  const sensitiveKey = /^(?:source|sourceText|sourceExcerpt|draft|draftExcerpt|translation|translationText|translatedText|finalTranslation|prompt|systemPrompt|userPrompt|promptText|rawOutput|content|segments)$/i;
  const rows: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (sensitiveKey.test(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) continue;
    let rendered = '';
    if (Array.isArray(value)) {
      // Only show identifier arrays, never arbitrary text arrays.
      if (!/(?:ids|segmentIds)$/i.test(key)) continue;
      rendered = value.slice(0, 8).map(String).join(', ') + (value.length > 8 ? '…' : '');
    } else {
      rendered = String(value);
    }
    rows.push(key + '=' + rendered.slice(0, 240));
  }
  return rows.join(' · ').slice(0, 900);
}

function promptInput(): PromptInput {
  return {
    systemPrompt: props.systemPrompt,
    userPromptTemplate: props.userPromptTemplate,
    sourceLang: props.sourceLang,
    targetLang: props.targetLang,
    provider: props.localAgentProvider,
    model: props.localAgentModel || 'auto',
    taskProfiles: props.codeBuddyTaskProfiles,
    translationMode: props.translationMode,
    literaryReview: props.translationMode === 'literary' && props.literaryReview,
    glossary: props.glossary,
  };
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  return workspaceApi(props.localAgentUrl, props.localAgentToken, path, init);
}

async function recreateMissingProject() {
  // Retry authoritative discovery before creating anything. A network/auth failure is not the
  // same as a missing project and must stop this action without creating another project.
  restorationError.value = '';
  restorationProjectMissing.value = false;
  await loadExistingProject();
  if (project.value || sourceChanged.value) return;
  if (restorationError.value && !restorationProjectMissing.value) return;

  // The user explicitly confirmed rebuild after discovery returned no usable server project.
  // The service endpoint remains idempotent and can still reuse a project created in this race.
  restorationError.value = '';
  restorationProjectMissing.value = false;
  await createProject(false, true);
}

async function createProject(forceNew = false, explicitRebuild = false) {
  if (!props.useLocalAgent) { error.value = '请先启用本机 Agent。'; return; }
  if (!props.segments.length) return;
  const initialGeneration = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(initialGeneration);

  // Another part of the UI may have initialized the durable project after this panel rendered.
  // Re-resolve immediately before create instead of trusting a stale empty local map.
  if (!forceNew && !explicitRebuild && !restorationProjectMissing.value && !project.value) {
    await loadExistingProject();
    if (!isCurrent()) return;
    if (project.value || sourceChanged.value || restorationError.value || restorationProjectMissing.value) return;
  }

  if (!isCurrent()) return;
  const input = projectInput();
  const legacyTranslations = new Map(props.translations);
  const legacyMemory = JSON.parse(JSON.stringify(props.literaryMemory));
  const sourceFileAtStart = props.sourceFile;
  const promptAtStart = promptInput();
  busy.value = true; error.value = ''; message.value = '';
  restorationError.value = '';
  restorationProjectMissing.value = false;
  try {
    const useRawFileImport = !!sourceFileAtStart && /\.(?:epub|pdf)$/i.test(sourceFileAtStart.name);
    const response = useRawFileImport
      ? await importDocumentFileViaLocalAgent(
          props.localAgentUrl,
          props.localAgentToken,
          sourceFileAtStart,
          forceNew || explicitRebuild ? 'separate' : 'default',
        )
      : await api('/api/documents/projects', {
          method: 'POST',
          body: JSON.stringify({ ...input, prompt: promptAtStart, allowDuplicate: forceNew }),
        });

    if (response.sourceChanged === true && response.relatedProject?.projectId) {
      project.value = response.relatedProject;
      sourceChanged.value = true;
      await refreshProject();
      if (!isCurrent()) return;
      emit('projectUpdated', project.value, true);
      message.value = '本机服务检测到同名但内容不同的来源；请明确更新现有项目或另建项目。';
      return;
    }

    if (response.reusedExisting === true) {
      // Server-side deduplication won a concurrent create race. Repair only this source's map.
      await rememberWorkspaceProject(input, response.project.projectId);
      if (!isCurrent()) return;
      project.value = null;
      await loadExistingProject();
      if (!isCurrent()) return;
      if (!project.value) throw new Error('本机服务已找到相同来源项目，但刷新项目状态失败。');
      message.value = '已恢复本机服务中已有的相同来源项目，没有新建重复项目。';
      return;
    }

    await rememberWorkspaceProject(input, response.project.projectId);
    // Finish one-time migration from the snapshot captured for the request. If the user switches
    // documents during these writes, complete the old project durably but never bind it to the
    // newly opened document's reader state.
    if (useRawFileImport) {
      // The import endpoint starts with a minimal Prompt; persist the user-selected one separately.
      await api('/api/documents/projects/' + encodeURIComponent(response.project.projectId) + '/prompts', {
        method: 'POST',
        body: JSON.stringify(promptAtStart),
      });
    }
    await importWorkspaceTranslations(props.localAgentUrl, props.localAgentToken, response.project.projectId, legacyTranslations);
    await api('/api/documents/projects/' + encodeURIComponent(response.project.projectId) + '/literary-memory', {
      method: 'POST',
      body: JSON.stringify({ memory: legacyMemory }),
    });
    if (sourceFileAtStart && !useRawFileImport) {
      try {
        await backupWorkspaceSourceFile(props.localAgentUrl, props.localAgentToken, response.project.projectId, sourceFileAtStart);
      } catch (uploadError) {
        if (isCurrent()) {
          message.value = '项目已创建，但原始文件备份失败：' +
            (uploadError instanceof Error ? uploadError.message : String(uploadError)) + '。可点击“备份原始文件”重试。';
        }
      }
    }
    if (!isCurrent()) return;
    project.value = response.project;
    await refreshProject();
    if (!isCurrent()) return;
    emit('projectUpdated', project.value, false);
    await emitWorkspaceSnapshot();
    if (!isCurrent()) return;
    message.value = '文档 workspace 已创建；原始文件、SQLite、译文版本、Prompt 和运行记录共用同一份项目状态。';
  } catch (e) {
    if (isCurrent()) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (isCurrent()) busy.value = false;
  }
}

async function loadExistingProject() {
  if (!props.useLocalAgent || !props.segments.length || project.value || restoringProject.value) return;
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  restoringProject.value = true;
  restorationError.value = '';
  restorationProjectMissing.value = false;
  try {
    const input = projectInput();
    const mapping = await lookupWorkspaceProject(input);
    if (!isCurrent()) return;
    let mappedResult: any = null;

    if (mapping.projectId) {
      try {
        mappedResult = await api('/api/documents/projects/' + encodeURIComponent(mapping.projectId));
        if (!isCurrent()) return;
      } catch (e) {
        if (!isCurrent()) return;
        // A missing mapped project can be repaired from the service catalog; connectivity/auth
        // failures must remain errors, never be mistaken for a missing project.
        if (!(e instanceof WorkspaceApiError) || e.status !== 404) throw e;
      }
    }

    // Validate the actual current source against the service on every open. A local mapping can
    // still point to a live project whose source revision changed elsewhere.
    const resolution = await resolveWorkspaceProject(props.localAgentUrl, props.localAgentToken, input);
    if (!isCurrent()) return;
    let projectId: string | null = null;
    let hasSourceChanged = false;
    let result: any = null;

    if (resolution.exactProject?.projectId) {
      // Preserve a user's explicit project choice when duplicate projects share the same source.
      // A mapped project is reusable only if the service says its current fingerprint is exact.
      if (mappedResult?.project?.sourceFingerprint === resolution.exactProject.sourceFingerprint) {
        projectId = mapping.projectId!;
        result = mappedResult;
      } else {
        projectId = resolution.exactProject.projectId;
        if (mapping.projectId !== projectId) await rememberWorkspaceProject(input, projectId);
        if (!isCurrent()) return;
        result = await api('/api/documents/projects/' + encodeURIComponent(projectId));
        if (!isCurrent()) return;
      }
    } else if (mappedResult) {
      // The old project still exists, but it no longer represents this document's source.
      // Surface the mismatch rather than loading its translations into the current reader.
      projectId = mapping.projectId!;
      hasSourceChanged = true;
      result = mappedResult;
    } else if (resolution.relatedProject?.projectId) {
      projectId = resolution.relatedProject.projectId;
      hasSourceChanged = true;
      result = await api('/api/documents/projects/' + encodeURIComponent(projectId));
      if (!isCurrent()) return;
    } else {
      // No server-side match is a normal first-open case. Do not create until the user starts
      // the workflow; importantly, don't re-upload stale local session data to "discover" it.
      if (mapping.projectId) {
        restorationProjectMissing.value = true;
        restorationError.value = '原有关联的项目已不在本机服务中，服务目录也未找到同一原文版本。确认后可以新建项目；本地译文备份仍会保留。';
      }
      return;
    }

    if (!isCurrent()) return;
    // Once a project is found, preserve its handle immediately; later refresh failures must not
    // make the component forget which durable project was discovered.
    project.value = result.project;
    sourceChanged.value = hasSourceChanged;
    emit('projectUpdated', project.value, sourceChanged.value);
    verification.value = result.verification;
    runs.value = result.runs || [];
    if (sourceChanged.value) return;

    // Existing service projects are read-only during discovery. Do not push cached Prompt,
    // accepted translations or literary-memory snapshots over the authoritative SQLite state.
    const active = runs.value.find((run) => ['queued', 'running', 'paused', 'awaiting_acceptance', 'partial'].includes(run.status)) || runs.value[0];
    if (active) await selectRun(active.runId);
    if (!isCurrent()) return;
    // A previous session may have ended after candidates were saved but before they were applied.
    // Complete that server-side finalization step; it does not import extension-side state.
    await autoAcceptReadyCandidates();
    if (!isCurrent()) return;
    await emitWorkspaceSnapshot();
    if (!isCurrent()) return;
    loadSelectedTranslation();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (project.value) {
      error.value = '文档项目已找到，但读取部分服务端状态失败：' + detail + '。项目关联已保留，可点击“刷新状态”或重试。';
    } else {
      // Network/authentication errors are not equivalent to "not found"; never auto-create on them.
      restorationError.value = '读取本机文档项目失败：' + detail + '。系统不会自动新建重复项目，请检查本机 Agent 服务后重试。';
    }
  } finally {
    if (isCurrent()) restoringProject.value = false;
  }
}

async function refreshProject() {
  if (!project.value) return;
  const generation = workspaceSourceGeneration;
  const projectId = project.value.projectId as string;
  const result = await api('/api/documents/projects/' + encodeURIComponent(projectId));
  if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
  project.value = result.project;
  verification.value = result.verification;
  runs.value = result.runs || [];
  if (activeRun.value) await refreshRun(activeRun.value.runId);
  await refreshQualityAudit();
}

async function refreshQualityAudit() {
  if (!project.value) return;
  const generation = workspaceSourceGeneration;
  const projectId = project.value.projectId as string;
  qualityAuditError.value = '';
  try {
    const result = await api('/api/documents/projects/' + encodeURIComponent(projectId) + '/quality-audit');
    if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
    const nextReport = result.report || null;
    const sameReport = !!nextReport &&
      nextReport.auditId === qualityAudit.value?.auditId &&
      nextReport.sourceRevisionId === qualityAudit.value?.sourceRevisionId;
    qualityAudit.value = nextReport;
    // Preserve in-progress UI selection while reloading the same report (for example after
    // refreshing project status). A different audit/source version is a new selection context.
    if (!sameReport) {
      selectedQualityFindingIds.value = [];
      qualityAuditQuery.value = '';
    }
  } catch (e) {
    if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
    if (e instanceof WorkspaceApiError && e.status === 404) {
      qualityAudit.value = null;
      selectedQualityFindingIds.value = [];
      qualityAuditQuery.value = '';
      return;
    }
    qualityAuditError.value = e instanceof Error ? e.message : String(e);
  }
}

async function runQualityAudit() {
  if (!project.value) return;
  if (qualityAuditUnavailable.value) {
    qualityAuditError.value = '请先完成或结束当前运行，并确认来源版本。';
    return;
  }
  if (qualityAuditLoading.value || qualityAuditRepairing.value) return;
  const generation = workspaceSourceGeneration;
  const projectId = project.value.projectId as string;
  qualityAuditLoading.value = true;
  qualityAuditError.value = '';
  try {
    const finishedRunId = ['completed', 'awaiting_acceptance'].includes(String(activeRun.value?.status || ''))
      ? String(activeRun.value.runId || '')
      : '';
    const result = await api('/api/documents/projects/' + encodeURIComponent(projectId) + '/quality-audit', {
      method: 'POST',
      body: JSON.stringify(finishedRunId ? { runId: finishedRunId } : {}),
    });
    if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
    qualityAudit.value = result.report || null;
    qualityAuditQuery.value = '';
    selectedQualityFindingIds.value = [];
    message.value = '全书质量审计完成：共 ' + Number(result.report?.findings?.length || 0) +
      ' 项问题提示。报告已保存在本机项目数据库中。';
  } catch (e) {
    if (isCurrentWorkspaceGeneration(generation)) {
      qualityAuditError.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (isCurrentWorkspaceGeneration(generation)) qualityAuditLoading.value = false;
  }
}

async function repairSelectedQualityFindings() {
  if (!project.value || !qualityAuditMatchesSource.value || !qualityAudit.value?.auditId) return;
  if (qualityAuditBlocked.value || qualityAuditRepairing.value) return;
  const repairableIds = new Set(
    (Array.isArray(qualityAudit.value.findings) ? qualityAudit.value.findings : [])
      .filter((finding: any) => finding.repairable === true)
      .map((finding: any) => String(finding.findingId)),
  );
  const findingIds = selectedQualityFindingIds.value.filter((id) => repairableIds.has(id));
  if (!findingIds.length) {
    qualityAuditError.value = '请选择至少一项可返工的问题。';
    return;
  }
  const generation = workspaceSourceGeneration;
  const projectId = project.value.projectId as string;
  qualityAuditRepairing.value = true;
  qualityAuditError.value = '';
  try {
    const response = await api('/api/documents/projects/' + encodeURIComponent(projectId) + '/quality-audit/repair', {
      method: 'POST',
      body: JSON.stringify({ auditId: qualityAudit.value.auditId, findingIds }),
    });
    if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
    selectedQualityFindingIds.value = [];
    if (response.repair?.run) {
      runEvents.value = [];
      eventCursor = 0;
      activeRun.value = response.repair.run;
      await refreshProject();
      if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
      if (isRunning.value) schedulePoll(activeRun.value.runId);
    }
    message.value = response.started
      ? '已创建定点返工任务。返工结果是新的候选 Run，完成后仍需由你确认；旧译文不会被直接覆盖。'
      : '没有创建新的返工任务。请检查所选问题是否仍属于当前来源版本。';
  } catch (e) {
    if (isCurrentWorkspaceGeneration(generation)) {
      qualityAuditError.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (isCurrentWorkspaceGeneration(generation)) qualityAuditRepairing.value = false;
  }
}

function qualityFindingLabel(finding: any): string {
  const labels: Record<string, string> = {
    'missing-translation': '缺译片段',
    'canonical-name-mapping-conflict': '规范译名冲突',
    'terminology-drift': '规范译名漂移',
    'english-residue': '疑似英文残留',
    'numeric-token-mismatch': '数字/单位差异',
    'repeated-expression-drift': '重复表达不一致',
    'repeated-expression-alignment-review': '重复表达需人工对齐',
    'entity-mention-drift': '实体表面译名漂移',
    'context-delta-conflict': '候选译名冲突',
    'duplicate-output-id': '重复输出 ID',
    'unexpected-output-id': '未知输出 ID',
    'malformed-output-row': '模型输出结构异常',
    'accuracy-review': '准确性审校',
    'reviewer-terminology-review': '术语审校',
    'character-voice-review': '人物声音审校',
    'style-review': '文风审校',
  };
  return labels[String(finding?.type || '')] || String(finding?.type || '质量问题');
}

function qualitySeverityLabel(severity: string | undefined): string {
  if (severity === 'must-fix') return '必须修复';
  if (severity === 'warning') return '警告';
  if (severity === 'review') return '人工复核';
  return '提示';
}

async function refreshRunEvents(runId: string): Promise<void> {
  if (!project.value || !runId) return;
  const generation = workspaceSourceGeneration;
  const projectId = project.value.projectId as string;
  const cursor = eventCursor;
  const endpoint = '/api/documents/projects/' + encodeURIComponent(projectId) +
    '/events?runId=' + encodeURIComponent(runId) + '&after=' + cursor + '&limit=1000';
  const result = await api(endpoint);
  if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
  const incoming = Array.isArray(result.events) ? result.events : [];
  if (!incoming.length) return;
  runEvents.value = [...runEvents.value, ...incoming].slice(-1000);
  eventCursor = Math.max(eventCursor, ...incoming.map((item: any) => Number(item.eventId) || 0));
}

function projectInput() {
  return {
    title: props.title,
    format: props.format,
    sourceFileName: props.sourceFileName,
    segments: props.segments,
  };
}

function isCurrentWorkspaceGeneration(generation: number): boolean {
  return generation === workspaceSourceGeneration && !disposed;
}

function resetProjectStateForSourceChange(): void {
  workspaceSourceGeneration++;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
  project.value = null;
  sourceChanged.value = false;
  restoringProject.value = false;
  restorationError.value = '';
  restorationProjectMissing.value = false;
  verification.value = null;
  activeRun.value = null;
  runs.value = [];
  runEvents.value = [];
  eventCursor = 0;
  autoAcceptingRunId.value = '';
  queuedAutoAcceptRunId.value = '';
  autoAcceptError.value = '';
  qualityAudit.value = null;
  qualityAuditLoading.value = false;
  qualityAuditRepairing.value = false;
  qualityAuditError.value = '';
  qualityAuditQuery.value = '';
  selectedQualityFindingIds.value = [];
  selectedSegmentId.value = props.visibleSegments[0]?.id || '';
  manualText.value = '';
  busy.value = false;
  error.value = '';
  message.value = '';
}

async function emitWorkspaceSnapshot() {
  if (!project.value) return;
  const generation = workspaceSourceGeneration;
  const projectId = project.value.projectId as string;
  const segmentCount = project.value.segmentCount || props.segments.length;
  const accepted = await loadWorkspaceAcceptedTranslations(
    props.localAgentUrl, props.localAgentToken, projectId, segmentCount,
  );
  if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
  emit('workspaceSync', accepted);
}

async function uploadCurrentSourceFile() {
  if (!project.value || !props.sourceFile) throw new Error('当前没有可上传的原始文件');
  const generation = workspaceSourceGeneration;
  const projectId = project.value.projectId as string;
  const sourceFile = props.sourceFile;
  await backupWorkspaceSourceFile(props.localAgentUrl, props.localAgentToken, projectId, sourceFile);
  if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
  project.value = { ...project.value, sourceFileSaved: true, sourceFileSize: sourceFile.size };
  await refreshProject();
}

async function updateSourceRevision() {
  if (!project.value || !sourceChanged.value) return;
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  const projectId = project.value.projectId as string;
  const input = projectInput();
  const sourceFileAtStart = props.sourceFile;
  const baseUrl = props.localAgentUrl;
  const token = props.localAgentToken;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const updateFromRawFile = !!sourceFileAtStart && /\.(?:epub|pdf)$/i.test(sourceFileAtStart.name);
    const result = updateFromRawFile
      ? await updateWorkspaceSourceFromFile(baseUrl, token, projectId, sourceFileAtStart)
      : await api('/api/documents/projects/' + encodeURIComponent(projectId) + '/source', {
          method: 'POST',
          body: JSON.stringify({
            title: input.title,
            sourceFileName: input.sourceFileName,
            format: input.format,
            segments: input.segments,
          }),
        });
    // Keep the association tied to the captured source, even if the user has since switched books.
    await rememberWorkspaceProject(input, projectId);
    if (sourceFileAtStart && !updateFromRawFile) {
      try {
        await backupWorkspaceSourceFile(baseUrl, token, projectId, sourceFileAtStart);
      } catch (uploadError) {
        if (isCurrent()) {
          message.value = '新来源片段已保存，但原始文件备份失败：' +
            (uploadError instanceof Error ? uploadError.message : String(uploadError));
        }
      }
    }
    if (!isCurrent() || project.value?.projectId !== projectId) return;

    project.value = result.project;
    sourceChanged.value = false;
    await refreshProject();
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    emit('projectUpdated', project.value, false);
    await emitWorkspaceSnapshot();
    if (!isCurrent()) return;
    message.value = (message.value ? message.value + ' ' : '') + '新来源版本已保存；未变化片段保留有效译文，变化片段等待重译。';
  } catch (e) {
    if (isCurrent()) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (isCurrent()) busy.value = false;
  }
}

async function createSeparateProject() {
  if (busy.value || isRunning.value) return;
  project.value = null;
  activeRun.value = null;
  verification.value = null;
  runs.value = [];
  qualityAudit.value = null;
  selectedQualityFindingIds.value = [];
  qualityAuditQuery.value = '';
  qualityAuditError.value = '';
  sourceChanged.value = false;
  await createProject(true);
}

async function startRun(scope: 'stale' | 'all' | 'failed' | 'visible') {
  if (sourceChanged.value) { error.value = '请先确认是否导入新的来源版本。'; return; }
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  busy.value = true; error.value = ''; message.value = '';
  try {
    if (!project.value) await createProject();
    if (!isCurrent() || !project.value) return;
    if (!isCurrent() || !project.value) return;
    const projectId = project.value.projectId as string;
    const runScope = scope === 'visible'
      ? { type: 'ids', ids: props.visibleSegments.map((segment) => segment.id) }
      : { type: scope };
    const response = await api('/api/documents/projects/' + projectId + '/runs', {
      method: 'POST',
      body: JSON.stringify({ scope: runScope }),
    });
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    runEvents.value = [];
    eventCursor = 0;
    activeRun.value = response.run;
    message.value = response.started ? '翻译 Agent 已启动；进度和模型调用结果会持久化到项目数据库。' : '当前范围没有需要处理的片段。';
    await refreshProject();
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    if (isRunning.value) schedulePoll(activeRun.value.runId);
  } catch (e) {
    if (isCurrent()) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (isCurrent()) busy.value = false;
  }
}

async function selectRun(runId: string) {
  const generation = workspaceSourceGeneration;
  try {
    runEvents.value = [];
    eventCursor = 0;
    await refreshRun(runId);
    if (!isCurrentWorkspaceGeneration(generation)) return;
    if (isRunning.value) schedulePoll(runId);
  } catch (e) {
    if (isCurrentWorkspaceGeneration(generation)) error.value = e instanceof Error ? e.message : String(e);
  }
}

async function refreshRun(runId: string) {
  if (!project.value) return;
  const generation = workspaceSourceGeneration;
  const projectId = project.value.projectId as string;
  const result = await api('/api/documents/projects/' + encodeURIComponent(projectId) + '/runs/' + encodeURIComponent(runId));
  if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
  activeRun.value = result.run;
  await refreshRunEvents(runId);
}

function schedulePoll(runId: string) {
  if (pollTimer) clearTimeout(pollTimer);
  const generation = workspaceSourceGeneration;
  const projectId = project.value?.projectId as string | undefined;
  pollTimer = setTimeout(async () => {
    if (!isCurrentWorkspaceGeneration(generation) || !projectId || project.value?.projectId !== projectId) return;
    try {
      await refreshRun(runId);
      if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
      if (isRunning.value) schedulePoll(runId);
      else {
        await refreshProjectWithoutRun();
        if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
        await refreshQualityAudit();
        if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
        // Local Agent may start a bounded automatic quality-repair Run after the parent Run finishes.
        // Follow that child so its progress/results remain visible; the service already auto-accepts it.
        const automaticChild = runs.value.find((run: any) =>
          run.parentRunId === runId && run.scope?.automation?.kind === 'quality-audit-repair');
        if (automaticChild && automaticChild.runId !== runId) {
          activeRun.value = automaticChild;
          runEvents.value = [];
          eventCursor = 0;
          await refreshRun(automaticChild.runId);
          if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
          if (isRunning.value) schedulePoll(automaticChild.runId);
          return;
        }
        // Compatibility/recovery only: current Local Agent runs auto-accept inside the server worker.
        await autoAcceptReadyCandidates();
      }
    } catch (e) {
      if (isCurrentWorkspaceGeneration(generation)) error.value = e instanceof Error ? e.message : String(e);
    }
  }, 1200);
}

async function refreshProjectWithoutRun() {
  if (!project.value) return;
  const generation = workspaceSourceGeneration;
  const projectId = project.value.projectId as string;
  const result = await api('/api/documents/projects/' + encodeURIComponent(projectId));
  if (!isCurrentWorkspaceGeneration(generation) || project.value?.projectId !== projectId) return;
  project.value = result.project;
  verification.value = result.verification;
  runs.value = result.runs || [];
}

async function resumeRun() {
  if (!activeRun.value || !project.value) return;
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  const projectId = project.value.projectId as string;
  const runId = activeRun.value.runId as string;
  busy.value = true; error.value = '';
  try {
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    const response = await api('/api/documents/projects/' + projectId + '/runs/' + runId + '/resume', {
      method: 'POST', body: '{}',
    });
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    activeRun.value = response.run;
    if (['queued', 'running'].includes(activeRun.value.status)) schedulePoll(activeRun.value.runId);
  } catch (e) { if (isCurrent()) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (isCurrent()) busy.value = false; }
}

async function cancelRun() {
  if (!activeRun.value || !project.value) return;
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  const projectId = project.value.projectId as string;
  const runId = activeRun.value.runId as string;
  busy.value = true; error.value = '';
  try {
    const response = await api('/api/documents/projects/' + projectId + '/runs/' + runId + '/cancel', {
      method: 'POST', body: '{}',
    });
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    activeRun.value = response.run;
    await refreshRunEvents(activeRun.value.runId);
    if (!isCurrent()) return;
    message.value = '已请求停止；已持久化的候选不会删除。';
    if (pollTimer) clearTimeout(pollTimer);
  } catch (e) { if (isCurrent()) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (isCurrent()) busy.value = false; }
}

async function autoAcceptReadyCandidates() {
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  const run = activeRun.value;
  if (!run || !project.value || isRunning.value || Number(run.counts?.candidate || 0) <= 0) return;
  if (autoAcceptingRunId.value === run.runId) return;
  if (busy.value) {
    // Do not silently drop the only automatic save attempt. A busy manual refresh/edit can
    // overlap the terminal poll; queue one retry and run it as soon as that operation finishes.
    queuedAutoAcceptRunId.value = run.runId;
    return;
  }

  const runId = run.runId as string;
  autoAcceptingRunId.value = runId;
  autoAcceptError.value = '';
  try {
    const succeeded = await acceptCandidates(undefined, true);
    if (isCurrent() && !succeeded && activeRun.value?.runId === runId && Number(activeRun.value.counts?.candidate || 0) > 0) {
      autoAcceptError.value = error.value || '保存接口未能确认候选已写入。请重试保存；原始模型结果仍保存在运行记录中。';
    }
  } finally {
    if (isCurrent() && autoAcceptingRunId.value === runId) autoAcceptingRunId.value = '';
  }
}

async function applyStyleFinding(finding: any) {
  if (!project.value || !activeRun.value || !finding?.findingId) return;
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  const projectId = project.value.projectId as string;
  const runId = activeRun.value.runId as string;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const response = await api(
      '/api/documents/projects/' + encodeURIComponent(projectId) +
        '/runs/' + encodeURIComponent(runId) + '/findings/' + encodeURIComponent(String(finding.findingId)),
      { method: 'POST', body: JSON.stringify({ action: 'apply' }) },
    );
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    activeRun.value = response.run;
    await emitWorkspaceSnapshot();
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    await refreshProjectWithoutRun();
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    message.value = '文风候选已作为人工译文保存，并同步到阅读器：' + finding.segmentId;
  } catch (e) {
    if (isCurrent()) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (isCurrent()) busy.value = false;
  }
}

async function dismissStyleFinding(finding: any) {
  if (!project.value || !activeRun.value || !finding?.findingId) return;
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  const projectId = project.value.projectId as string;
  const runId = activeRun.value.runId as string;
  busy.value = true;
  error.value = '';
  try {
    const response = await api(
      '/api/documents/projects/' + encodeURIComponent(projectId) +
        '/runs/' + encodeURIComponent(runId) + '/findings/' + encodeURIComponent(String(finding.findingId)),
      { method: 'POST', body: JSON.stringify({ action: 'dismiss' }) },
    );
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    activeRun.value = response.run;
    message.value = '已保留当前译文，并记录对文风建议的决定：' + finding.segmentId;
  } catch (e) {
    if (isCurrent()) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (isCurrent()) busy.value = false;
  }
}

async function acceptCandidates(segmentIds?: string[], automatic = false): Promise<boolean> {
  if (!activeRun.value || !project.value) return false;
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  const projectId = project.value.projectId as string;
  const runId = activeRun.value.runId as string;
  // Snapshot candidates before the response changes their run-segment status.
  const candidates = (activeRun.value.segments || [])
    .filter((segment: any) => segment.status === 'candidate' && typeof segment.candidateTranslation === 'string')
    .map((segment: any) => ({ id: segment.id as string, text: segment.candidateTranslation as string }));
  const requested = segmentIds?.length ? new Set(segmentIds) : new Set(candidates.map((item) => item.id));
  if (!requested.size) {
    error.value = '运行记录显示有候选数量，但没有读取到对应的候选片段。正在重新读取运行详情，请稍后重试。';
    if (automatic) {
      try {
        const latest = await api('/api/documents/projects/' + encodeURIComponent(projectId) + '/runs/' + encodeURIComponent(runId));
        if (isCurrent() && project.value?.projectId === projectId && activeRun.value?.runId === runId) activeRun.value = latest.run;
      } catch (e) {
        error.value += '读取运行详情失败：' + (e instanceof Error ? e.message : String(e));
      }
    }
    return false;
  }
  busy.value = true; error.value = '';
  try {
    const response = await api('/api/documents/projects/' + encodeURIComponent(projectId) + '/runs/' + encodeURIComponent(runId) + '/accept', {
      method: 'POST', body: JSON.stringify({ segmentIds: Array.from(requested) }),
    });
    if (!isCurrent() || project.value?.projectId !== projectId) return false;
    if (activeRun.value?.runId === runId) activeRun.value = response.run;
    // Only sync the authoritative accepted versions from SQLite. The store may have preserved
    // a human edit instead of accepting a model candidate for one or more segments.
    await emitWorkspaceSnapshot();
    if (!isCurrent() || project.value?.projectId !== projectId) return false;
    message.value = automatic
      ? '翻译结果已自动保存，并同步到阅读器。'
      : segmentIds?.length
        ? '已采纳所选片段并同步到阅读器；其他候选仍可单独选择。'
        : '已采纳本次候选并同步到阅读器；历史运行仍可查看。';
    autoAcceptError.value = '';
    await refreshProjectWithoutRun();
    if (!isCurrent() || project.value?.projectId !== projectId) return false;
    return true;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (isCurrent()) error.value = detail;
    if (isCurrent() && automatic) autoAcceptError.value = '自动保存失败：' + detail;
    return false;
  } finally {
    if (isCurrent()) busy.value = false;
  }
}

function loadSelectedTranslation() {
  const segment = selectedSegment.value;
  if (segment) manualText.value = props.translations.get(segment.id) || '';
}
async function saveManualEdit() {
  if (!project.value || !selectedSegmentId.value || !manualText.value.trim()) return;
  const generation = workspaceSourceGeneration;
  const isCurrent = () => isCurrentWorkspaceGeneration(generation);
  const projectId = project.value.projectId as string;
  const segmentId = selectedSegmentId.value;
  const text = manualText.value;
  busy.value = true; error.value = '';
  try {
    await api('/api/documents/projects/' + projectId + '/segments/' + encodeURIComponent(segmentId) + '/translation', {
      method: 'PUT', body: JSON.stringify({ text }),
    });
    if (!isCurrent() || project.value?.projectId !== projectId) return;
    emit('acceptedTranslations', [{ id: segmentId, text }]);
    message.value = '人工修订已单独存档，并已更新阅读器当前译文。';
    await refreshProject();
  } catch (e) { if (isCurrent()) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (isCurrent()) busy.value = false; }
}

watch(() => props.visibleSegments.map((segment) => segment.id).join('|'), () => {
  if (!props.visibleSegments.some((segment) => segment.id === selectedSegmentId.value)) {
    selectedSegmentId.value = props.visibleSegments[0]?.id || '';
  }
  loadSelectedTranslation();
});
// If automatic acceptance met another foreground operation, retry exactly once when that operation
// finishes. Failed API calls are not retried in a loop; their actual error is shown to the user.
watch(busy, (isBusy) => {
  if (isBusy || !queuedAutoAcceptRunId.value || disposed) return;
  const queuedRunId = queuedAutoAcceptRunId.value;
  queuedAutoAcceptRunId.value = '';
  if (activeRun.value?.runId === queuedRunId && Number(activeRun.value.counts?.candidate || 0) > 0) {
    void autoAcceptReadyCandidates();
  }
});

// The component instance can survive while the reader opens another file. A project ref
// must never outlive the source document it was resolved for.
watch(
  () => [props.title, props.format, props.sourceFileName, props.segments] as const,
  () => {
    resetProjectStateForSourceChange();
    if (props.active && props.useLocalAgent) void loadExistingProject();
  },
  { flush: 'post' },
);

// 只在 Agent Tab 激活且本机 Agent 可用时查找关联。切回 Tab 时仅在当前组件尚无项目状态时恢复。
watch(
  () => [props.active, props.useLocalAgent] as const,
  ([active, enabled]) => {
    if (active && enabled && !project.value && !restoringProject.value) void loadExistingProject();
  },
  { immediate: true },
);

onMounted(() => {
  if (!selectedSegmentId.value) selectedSegmentId.value = props.visibleSegments[0]?.id || '';
  loadSelectedTranslation();
});
onUnmounted(() => {
  disposed = true;
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<style scoped>
.document-agent-workspace {
  --agent-blue: #0071e3;
  --agent-blue-hover: #0077ed;
  --agent-ink: #1d1d1f;
  --agent-secondary: #6e6e73;
  --agent-line: #e5e5ea;
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
  color: var(--agent-ink);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif;
}
.agent-hero { padding: .25rem .1rem .5rem; }
.agent-kicker, .agent-section-kicker {
  color: var(--agent-secondary);
  font-size: .76rem;
  font-weight: 650;
  letter-spacing: .055em;
}
.agent-hero-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-top: .35rem;
}
.agent-title-copy { min-width: 0; }
.agent-title-copy h2 {
  margin: 0;
  font-size: clamp(1.45rem, 3vw, 1.9rem);
  line-height: 1.22;
  font-weight: 680;
  letter-spacing: -.035em;
  overflow-wrap: anywhere;
}
.agent-title-copy p {
  max-width: 42rem;
  margin: .55rem 0 0;
  color: var(--agent-secondary);
  line-height: 1.6;
  font-size: .94rem;
}
.agent-format {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: .35rem .7rem;
  background: #f5f5f7;
  color: #424245;
  font-size: .76rem;
  font-weight: 650;
  letter-spacing: .025em;
}
.agent-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .5rem;
  margin-top: .9rem;
  color: var(--agent-secondary);
  font-size: .82rem;
}
.agent-meta-dot { color: #c7c7cc; }
.agent-work-card {
  border: 1px solid var(--agent-line);
  border-radius: 18px;
  background: #fff;
  padding: clamp(1.1rem, 3vw, 1.6rem);
  box-shadow: 0 4px 18px rgba(0, 0, 0, .025);
}
.agent-ready-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  column-gap: 1rem;
  row-gap: 1rem;
}
.agent-state-mark {
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  border-radius: 13px;
  background: #f0f6ff;
  color: var(--agent-blue);
  font-size: 1.15rem;
  font-weight: 700;
}
.agent-ready-copy h3, .agent-progress-copy h3 {
  margin: .2rem 0 0;
  font-size: 1.15rem;
  font-weight: 670;
  letter-spacing: -.02em;
  line-height: 1.4;
}
.agent-ready-copy p, .agent-progress-copy p {
  margin: .4rem 0 0;
  color: var(--agent-secondary);
  font-size: .9rem;
  line-height: 1.6;
}
.agent-ready-card .agent-button { grid-column: 2; justify-self: start; }
.agent-progress-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1.5rem;
}
.agent-progress-copy { min-width: 0; }
.agent-progress-number {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  align-items: flex-end;
  gap: .2rem;
  min-width: 5.4rem;
}
.agent-progress-number strong {
  font-size: 2rem;
  line-height: 1;
  font-weight: 680;
  letter-spacing: -.055em;
  font-variant-numeric: tabular-nums;
}
.agent-progress-number span { color: var(--agent-secondary); font-size: .73rem; }
.agent-progress-number.is-complete strong { color: #248a3d; }
.agent-progress-track {
  height: 7px;
  margin-top: 1.35rem;
  overflow: hidden;
  border-radius: 99px;
  background: #ededf0;
}
.agent-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--agent-blue);
  transition: width .35s ease;
}
.agent-progress-foot {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: .5rem;
  margin-top: .65rem;
  color: var(--agent-secondary);
  font-size: .78rem;
  font-variant-numeric: tabular-nums;
}
.agent-main-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .6rem;
  margin-top: 1.35rem;
}
.agent-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .5rem;
  min-height: 2.35rem;
  padding: .55rem .95rem;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--agent-ink);
  font: inherit;
  font-size: .86rem;
  font-weight: 570;
  line-height: 1.25;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, transform .15s ease;
}
.agent-button:focus-visible, .agent-options summary:focus-visible, .agent-subdetails summary:focus-visible {
  outline: 3px solid rgba(0, 113, 227, .28);
  outline-offset: 2px;
}
.agent-button:disabled { opacity: .52; cursor: not-allowed; transform: none; }
.agent-button-primary {
  background: var(--agent-blue);
  color: #fff;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .04);
}
.agent-button-primary:hover:not(:disabled) { background: var(--agent-blue-hover); }
.agent-button-secondary {
  background: #f5f5f7;
  border-color: #e5e5ea;
  color: #1d1d1f;
}
.agent-button-secondary:hover:not(:disabled) { background: #ececf0; }
.agent-button-tertiary {
  min-height: 2rem;
  padding: .35rem .55rem;
  color: var(--agent-blue);
  background: transparent;
}
.agent-button-tertiary:hover:not(:disabled) { background: #f0f6ff; }
.agent-button-large { min-height: 2.8rem; padding: .75rem 1.25rem; font-size: .94rem; }
.agent-button-count {
  display: inline-grid;
  place-items: center;
  min-width: 1.5rem;
  min-height: 1.5rem;
  padding: 0 .3rem;
  border-radius: 99px;
  background: rgba(255, 255, 255, .2);
  font-size: .78rem;
  font-variant-numeric: tabular-nums;
}
.agent-complete-label {
  display: inline-flex;
  align-items: center;
  gap: .5rem;
  padding: .75rem .1rem;
  color: #248a3d;
  font-weight: 650;
  font-size: .94rem;
}
.agent-complete-label > span {
  display: grid;
  place-items: center;
  width: 1.45rem;
  height: 1.45rem;
  border-radius: 50%;
  background: #e8f6ec;
}
.agent-run-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .45rem;
  margin-top: 1.3rem;
  padding-top: .95rem;
  border-top: 1px solid #f0f0f2;
  color: var(--agent-secondary);
  font-size: .77rem;
}
.agent-status-dot {
  width: .42rem;
  height: .42rem;
  border-radius: 50%;
  background: #8e8e93;
}
.agent-status-dot.status-running, .agent-status-dot.status-queued { background: var(--agent-blue); }
.agent-status-dot.status-completed { background: #248a3d; }
.agent-status-dot.status-failed, .agent-status-dot.status-partial { background: #d94841; }
.agent-run-failure { color: #b42318; }
.agent-inline-status {
  margin-top: 1rem;
  padding: .7rem .85rem;
  border-radius: 10px;
  background: #f0f6ff;
  color: #145ea8;
  font-size: .84rem;
}
.agent-pending-output {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-top: 1rem;
  padding: .9rem;
  border: 1px solid #f0d7a4;
  border-radius: 12px;
  background: #fffbf2;
}
.agent-pending-output strong { font-size: .87rem; }
.agent-pending-output p { margin: .3rem 0 0; color: var(--agent-secondary); font-size: .8rem; line-height: 1.5; }
.agent-notice {
  display: flex;
  align-items: flex-start;
  gap: .8rem;
  padding: 1rem 1.1rem;
  border: 1px solid var(--agent-line);
  border-radius: 14px;
  background: #f8f8fa;
  color: var(--agent-ink);
}
.agent-notice > div { min-width: 0; }
.agent-notice strong { font-size: .9rem; }
.agent-notice p { margin: .35rem 0 0; color: var(--agent-secondary); font-size: .86rem; line-height: 1.6; overflow-wrap: anywhere; }
.agent-notice-error { border-color: #f1c8c5; background: #fff8f7; }
.agent-preprocessing-notice { align-items: center; border-color: #f0d7a4; background: #fffbf2; }
.agent-preprocessing-copy { flex: 1; min-width: 0; }
.agent-preprocessing-notice strong { color: #7d4e00; }
.agent-preprocessing-failed { border-color: #f1c8c5; background: #fff8f7; }
.agent-preprocessing-failed strong { color: #a61d24; }
.agent-preprocessing-progress { height: 6px; margin-top: .65rem; overflow: hidden; border-radius: 99px; background: #f1e3c8; }
.agent-preprocessing-progress > div { height: 100%; border-radius: inherit; background: #b78125; transition: width .25s ease; }

.agent-notice-warning { border-color: #f0d7a4; background: #fffbf2; display: block; }
.agent-notice-warning > p { margin-bottom: .8rem; }
.agent-inline-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
.agent-feedback {
  margin: -.35rem 0 0;
  padding: .1rem .1rem;
  color: #248a3d;
  font-size: .82rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.agent-feedback-error { color: #b42318; }
.agent-options {
  border: 1px solid var(--agent-line);
  border-radius: 14px;
  background: #fff;
  overflow: hidden;
}
.agent-options > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: .4rem .8rem;
  padding: .95rem 1.1rem;
  cursor: pointer;
  list-style-position: inside;
  font-size: .9rem;
  font-weight: 650;
}
.agent-options > summary::marker { color: #8e8e93; }
.agent-options-hint { color: var(--agent-secondary); font-size: .77rem; font-weight: 400; }
.agent-options-content { padding: 0 1.1rem 1rem; }
.agent-option-group { padding: 1rem 0; border-top: 1px solid #f0f0f2; }
.agent-option-heading h4 { margin: 0; font-size: .9rem; font-weight: 650; }
.agent-option-heading p, .agent-detail-description {
  margin: .35rem 0 .75rem;
  color: var(--agent-secondary);
  font-size: .82rem;
  line-height: 1.55;
}
.agent-footnote {
  margin: .15rem 0 0;
  color: var(--agent-secondary);
  font-size: .76rem;
  line-height: 1.5;
}
.agent-subdetails { padding: .8rem 0; border-top: 1px solid #f0f0f2; }
.agent-subdetails > summary { cursor: pointer; font-size: .86rem; font-weight: 600; }
.agent-subdetails .agent-detail-description { margin-top: .65rem; }
.agent-quality-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: .45rem;
  margin-top: .85rem;
}
.agent-quality-metrics span {
  display: inline-flex;
  gap: .35rem;
  align-items: center;
  border: 1px solid #e5e5ea;
  border-radius: 999px;
  padding: .3rem .6rem;
  color: #515158;
  background: #fafafc;
  font-size: .76rem;
}
.agent-quality-metrics strong { color: #1d1d1f; font-variant-numeric: tabular-nums; }
.agent-quality-stale {
  margin: .75rem 0 0;
  border-left: 3px solid #b45309;
  padding: .35rem .6rem;
  color: #854d0e;
  background: #fffbeb;
  font-size: .82rem;
}
.agent-quality-findings { display: grid; gap: .55rem; margin-top: .75rem; }
.agent-quality-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .45rem .6rem;
  padding: .7rem;
  border: 1px solid #e5e5ea;
  border-radius: 11px;
  background: #fafafc;
}
.agent-quality-filter-label { color: #515158; font-size: .78rem; font-weight: 600; }
.agent-quality-filter input {
  flex: 1 1 15rem;
  min-width: 8rem;
  max-width: 100%;
  border: 1px solid #d2d2d7;
  border-radius: 8px;
  padding: .48rem .6rem;
  background: #fff;
  color: var(--agent-ink);
  font: inherit;
  font-size: .8rem;
}
.agent-quality-filter-count { color: var(--agent-secondary); font-size: .75rem; font-variant-numeric: tabular-nums; }
.agent-quality-finding {
  min-width: 0;
  border: 1px solid #e5e5ea;
  border-radius: 12px;
  padding: .7rem .8rem;
  background: #fff;
}
.agent-quality-finding-heading { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.agent-quality-select { display: inline-flex; align-items: center; gap: .32rem; color: #515158; font-size: .76rem; }
.agent-quality-select input { accent-color: var(--agent-blue); }
.agent-quality-severity {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: .18rem .45rem;
  background: #f5f5f7;
  color: #515158;
  font-size: .7rem;
}
.agent-quality-severity.severity-must-fix { background: #fff1f0; color: #a61d24; }
.agent-quality-severity.severity-warning { background: #fff7e6; color: #ad6800; }
.agent-quality-finding p { overflow-wrap: anywhere; }
.agent-quality-explanation { margin: .5rem 0; font-size: .83rem; line-height: 1.5; }
.agent-quality-evidence { margin: .25rem 0; color: #515158; font-size: .78rem; line-height: 1.5; }
.agent-quality-detail { margin-top: .45rem; font-size: .78rem; }
.agent-quality-detail summary { cursor: pointer; color: #515158; }
.agent-quality-detail p { margin: .35rem 0 0; color: #515158; line-height: 1.5; }
.agent-field { display: flex; flex-direction: column; gap: .35rem; margin-top: .8rem; color: #424245; font-size: .8rem; }
.agent-field select, .agent-field textarea {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  border: 1px solid #d2d2d7;
  border-radius: 9px;
  background: #fff;
  padding: .65rem .75rem;
  color: var(--agent-ink);
  font: inherit;
  font-size: .88rem;
}
.agent-field select:focus, .agent-field textarea:focus { outline: 3px solid rgba(0, 113, 227, .18); border-color: var(--agent-blue); }
.agent-field textarea { resize: vertical; line-height: 1.55; }
.agent-source-preview {
  padding: .7rem .75rem;
  border-radius: 9px;
  background: #f5f5f7;
  color: #424245;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-history-list, .agent-findings { display: grid; gap: .6rem; margin-top: .75rem; }
.agent-history-row {
  display: flex;
  align-items: center;
  gap: .8rem;
  padding: .65rem 0;
  border-bottom: 1px solid #f0f0f2;
}
.agent-history-row:last-child { border-bottom: 0; }
.agent-history-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: .2rem; }
.agent-history-copy strong { font-size: .82rem; font-weight: 600; }
.agent-history-copy span, .agent-history-status { color: var(--agent-secondary); font-size: .76rem; }
.agent-history-status { white-space: nowrap; }
.agent-finding-row { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: start; gap: .6rem; padding: .6rem 0; border-bottom: 1px solid #f0f0f2; }
.agent-finding-row p { margin: 0; font-size: .82rem; line-height: 1.5; overflow-wrap: anywhere; }
.agent-style-proposal {
  grid-column: 3;
  margin-top: .25rem;
  padding: .65rem .7rem;
  border-left: 3px solid #8250df;
  border-radius: 4px;
  background: #f6f0ff;
  color: #3d2468;
  min-width: 0;
}
.agent-style-proposal strong { font-size: .75rem; }
.agent-style-proposal p { margin: .35rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-style-proposal-actions { display: flex; flex-wrap: wrap; gap: .45rem; margin-top: .5rem; }
.agent-finding-kind { padding: .16rem .4rem; border-radius: 6px; background: #f5f5f7; color: #424245; font-size: .72rem; white-space: nowrap; }
.agent-finding-id { color: var(--agent-secondary); font-size: .75rem; white-space: nowrap; }
.agent-spinner {
  display: inline-block;
  width: .85rem;
  height: .85rem;
  flex: 0 0 auto;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: agent-spin .75s linear infinite;
}
.agent-trace-list { display: grid; gap: .55rem; margin-top: .75rem; }
.agent-trace-row {
  padding: .7rem .75rem;
  border: 1px solid #e5e5ea;
  border-radius: 9px;
  background: #fafafa;
  min-width: 0;
}
.agent-trace-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: .45rem .7rem;
  color: var(--agent-secondary);
  font-size: .72rem;
}
.agent-trace-heading strong { color: var(--agent-ink); font-size: .8rem; }
.agent-trace-heading time { margin-left: auto; white-space: nowrap; }
.agent-trace-row p {
  margin: .4rem 0 0;
  color: #424245;
  font-size: .76rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
  word-break: break-word;
}
@keyframes agent-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .agent-spinner { animation: none; }
  .agent-progress-fill, .agent-button { transition: none; }
}
@media (max-width: 640px) {
  .agent-hero-main { align-items: flex-start; }
  .agent-title-copy h2 { font-size: 1.4rem; }
  .agent-title-copy p { font-size: .88rem; }
  .agent-ready-card { grid-template-columns: auto minmax(0, 1fr); }
  .agent-ready-card .agent-button { grid-column: 1 / -1; justify-self: stretch; }
  .agent-progress-heading { gap: .7rem; }
  .agent-progress-number strong { font-size: 1.7rem; }
  .agent-progress-number { min-width: 4.3rem; }
  .agent-progress-copy h3 { font-size: 1.04rem; }
  .agent-pending-output { align-items: flex-start; flex-direction: column; }
  .agent-options > summary { align-items: flex-start; flex-direction: column; }
  .agent-history-row { align-items: flex-start; flex-wrap: wrap; }
  .agent-history-status { margin-left: auto; }
  .agent-finding-row { grid-template-columns: auto minmax(0, 1fr); }
  .agent-finding-row p { grid-column: 1 / -1; }
}

.agent-failed-segments { margin-top: .8rem; padding: .75rem .85rem; border: 1px solid #f1c8c5; border-radius: 11px; background: #fff8f7; }
.agent-failed-segments > summary { cursor: pointer; color: #b42318; font-size: .85rem; font-weight: 650; }
.agent-failed-segment { padding: .7rem 0; border-top: 1px solid #f1d8d5; }
.agent-failed-segment:first-of-type { margin-top: .6rem; }
.agent-failed-segment-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: .35rem .7rem; overflow-wrap: anywhere; }
.agent-failed-segment-heading strong { font-size: .82rem; }
.agent-segment-id, .agent-segment-attempts { color: var(--agent-secondary); font-size: .74rem; }
.agent-failed-segment-error { margin: .4rem 0; color: #912018; font-size: .8rem; line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; }
.agent-failed-segment-source { margin: .35rem 0 0; color: var(--agent-secondary); font-size: .77rem; line-height: 1.5; overflow-wrap: anywhere; }

</style>
