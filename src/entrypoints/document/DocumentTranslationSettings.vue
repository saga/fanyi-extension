<template>
  <section class="panel translation-settings">
    <div class="settings-heading">
      <div>
        <h3>翻译设置</h3>
        <p class="muted small">这些配置只影响文档翻译，不会改变网页或选中文本的翻译 Provider。正在运行的任务沿用启动时配置；更改对下一次翻译或重试生效。</p>
      </div>
      <span v-if="saving" class="save-state">保存中…</span>
      <span v-else-if="saveMessage" class="save-state">{{ saveMessage }}</span>
    </div>

    <div v-if="!config.documentUseLocalAgent" class="setting-field">
      <label for="document-deepseek-key">DeepSeek API Key</label>
      <input id="document-deepseek-key" v-model="config.documentDeepseekApiKey" type="password"
        autocomplete="off" placeholder="输入 DeepSeek API Key" @change="saveConfig('documentDeepseekApiKey')" />
    </div>

    <div class="settings-grid">
      <label class="setting-field">
        <span>源语言</span>
        <select v-model="config.documentSourceLang" @change="saveConfig('documentSourceLang')">
          <option value="auto">自动检测</option>
          <option value="en">英语</option>
          <option value="zh">中文</option>
          <option value="ja">日语</option>
          <option value="ko">韩语</option>
          <option value="fr">法语</option>
          <option value="de">德语</option>
        </select>
      </label>
      <label class="setting-field">
        <span>目标语言</span>
        <select v-model="config.documentTargetLang" @change="saveConfig('documentTargetLang')">
          <option value="zh">中文</option>
          <option value="en">英语</option>
          <option value="ja">日语</option>
          <option value="ko">韩语</option>
          <option value="fr">法语</option>
          <option value="de">德语</option>
        </select>
      </label>
    </div>

    <label class="setting-field">
      <span>翻译类型</span>
      <select v-model="config.documentTranslationMode" @change="saveConfig('documentTranslationMode')">
        <option value="technical">科技/信息翻译</option>
        <option value="literary">文学翻译</option>
      </select>
      <small class="muted">
        科技模式重准确、清晰和术语控制；文学模式重叙述声音、人物口吻、节奏与自然表达，不使用通用术语表。
      </small>
    </label>

    <label class="setting-field">
      <span>翻译文风</span>
      <select v-model="config.documentPromptStyle" @change="saveConfig('documentPromptStyle')">
        <option value="default">通用直译</option>
        <option value="ja-source-natural">日语原文汉译</option>
        <option value="jinyong">金庸武侠</option>
        <option value="acheng">阿城白描</option>
        <option value="wangxiaobo">王小波大白话</option>
      </select>
    </label>

    <label class="switch-line">
      <input v-model="config.documentUseLocalAgent" type="checkbox" @change="onLocalAgentToggle" />
      <span>使用本机 Workbuddy / OpenCode 翻译</span>
    </label>
    <small class="muted">文档翻译会独立检测本机服务；服务可用时默认启用。手动关闭后会记住选择，不影响网页翻译配置。</small>

    <div v-if="config.documentUseLocalAgent" class="settings-subpanel">
      <label class="setting-field">
        <span>本机 Agent</span>
        <select v-model="config.documentLocalAgentProvider" @change="saveConfig('documentLocalAgentProvider')">
          <option value="workbuddy">Workbuddy / CodeBuddy SDK</option>
          <option value="opencode">OpenCode CLI</option>
        </select>
      </label>
      <label class="setting-field">
        <span>本机服务地址</span>
        <input v-model="config.documentLocalAgentUrl" type="url" placeholder="http://127.0.0.1:8789"
          @change="saveLocalAgentUrl" />
      </label>
      <label class="setting-field">
        <span>模型覆盖（可选）</span>
        <input v-model="config.documentLocalAgentModel" placeholder="auto；或 provider/model"
          @change="onDocumentLocalAgentModelChange" />
        <small class="muted">auto 优先使用本机服务环境变量；OpenCode 示例：openai/gpt-5.4。</small>
      </label>
      <label class="setting-field">
        <span>本机服务 Token（可选）</span>
        <input v-model="config.documentLocalAgentToken" type="password" autocomplete="off"
          placeholder="服务端未配置 Token 时留空" @change="saveConfig('documentLocalAgentToken')" />
      </label>
      <div class="connection-row">
        <button type="button" class="btn" :disabled="checking" @click="checkLocalService">
          {{ checking ? '正在检查…' : '测试本机服务连接' }}
        </button>
        <span v-if="localStatus === 'ok'" class="connection-ok">本机服务可连接</span>
        <span v-else-if="localStatus === 'fail'" class="connection-fail">本机服务不可用，请检查地址和服务进程</span>
      </div>

      <details class="strategy-settings task-profile-settings" open>
        <summary>按任务配置 CodeBuddy 思考、推理强度与 Prompt</summary>
        <p class="muted small">
          初译、准确性/术语审校、人物声音/文风审校、文学分析、全书预处理分别保存。
          思考模式、effort 和 fallback model 使用 CodeBuddy SDK 的 query() 正式选项；预算只在“指定预算”模式生效。
          对声明了多档 context window 的模型，额外显示本任务的上下文窗口档位；留空仍使用模型 defaultLength，不改变默认设置。
          为确保参数生效，这些任务使用单次 query，而非复用 V2 Session；批量任务会有额外 CLI 启动开销，高 effort/大预算也会更慢。
        </p>
        <article v-for="task in codeBuddyTaskOptions" :key="task.key" class="task-profile-card">
          <div class="task-profile-heading">
            <div>
              <strong>{{ task.label }}</strong>
              <p class="muted small">{{ task.description }}</p>
            </div>
          </div>
          <template v-if="config.documentLocalAgentProvider === 'workbuddy'">
            <div class="settings-grid">
              <label class="setting-field">
                <span>本任务模型覆盖（可选）</span>
                <select v-model="config.documentCodeBuddyTaskProfiles[task.key].model"
                  @change="onTaskModelChange(task.key)">
                  <option value="">留空继承上面的模型覆盖</option>
                  <option v-for="model in codeBuddyModels" :key="model.id" :value="model.id">
                    {{ model.id }}{{ model.credits != null ? '（' + model.credits + ' credits）' : '' }}
                  </option>
                </select>
                <small class="muted">选择 CodeBuddy SDK 可识别的模型；列表来自本机服务 /api/codebuddy/models。</small>
              </label>
              <label v-if="codeBuddyContextWindowOptions[task.key]?.options.length >= 2" class="setting-field">
                <span>上下文窗口档位（可选）</span>
                <select :value="String(config.documentCodeBuddyTaskProfiles[task.key].contextWindow ?? '')"
                  @change="onContextWindowChange(task.key, $event)">
                  <option value="">默认（模型 defaultLength）</option>
                  <option v-for="option in codeBuddyContextWindowOptions[task.key]?.options || []"
                    :key="option.value" :value="option.value">
                    {{ option.name }}
                  </option>
                </select>
                <small class="muted">
                  留空使用模型默认档位；仅当模型声明多档窗口且每档不超过 maxInputTokens 时显示。
                  此设置不更改模型物理上限，也不等同于 autoCompactWindow。
                </small>
              </label>
              <label class="setting-field">
                <span>Fallback Model（可选）</span>
                <input v-model.trim="config.documentCodeBuddyTaskProfiles[task.key].fallbackModel"
                  placeholder="模型不可用时尝试的备用模型"
                  @change="saveConfig('documentCodeBuddyTaskProfiles')" />
              </label>
              <label class="setting-field">
                <span>Thinking 模式</span>
                <select v-model="config.documentCodeBuddyTaskProfiles[task.key].thinkingMode"
                  @change="saveConfig('documentCodeBuddyTaskProfiles')">
                  <option value="disabled">关闭思考</option>
                  <option value="adaptive">自适应思考</option>
                  <option value="enabled">指定思考预算</option>
                </select>
              </label>
              <label v-if="config.documentCodeBuddyTaskProfiles[task.key].thinkingMode === 'enabled'" class="setting-field">
                <span>Thinking Budget Tokens</span>
                <select v-model.number="config.documentCodeBuddyTaskProfiles[task.key].thinkingBudgetTokens"
                  @change="saveConfig('documentCodeBuddyTaskProfiles')">
                  <option :value="2048">2,048</option>
                  <option :value="4096">4,096</option>
                  <option :value="8192">8,192（默认）</option>
                  <option :value="16384">16,384</option>
                  <option :value="32768">32,768</option>
                  <option :value="65536">65,536</option>
                </select>
              </label>
              <label class="setting-field">
                <span>Effort（推理强度）</span>
                <select v-model="config.documentCodeBuddyTaskProfiles[task.key].effort"
                  @change="saveConfig('documentCodeBuddyTaskProfiles')">
                  <option value="low">Low · 较快</option>
                  <option value="medium">Medium · 均衡</option>
                  <option value="high">High · 深入</option>
                  <option value="xhigh">Extra High · 最深入</option>
                </select>
              </label>
            </div>
          </template>
          <label class="setting-field task-prompt-field">
            <span>本任务附加 System Prompt</span>
            <textarea v-model="config.documentCodeBuddyTaskProfiles[task.key].systemPromptAppendix"
              rows="3" spellcheck="false"
              placeholder="可选：补充本任务特有的指令；系统内置的证据、JSON 和安全约束仍会保留。"
              @change="saveConfig('documentCodeBuddyTaskProfiles')" />
            <small class="muted">附加指令放在内置任务契约之前，不会替换服务端必须保留的约束。</small>
          </label>
          <label v-if="task.key !== 'translation'" class="setting-field task-prompt-field">
            <span>本任务 User Prompt 模板（可选）</span>
            <textarea v-model="config.documentCodeBuddyTaskProfiles[task.key].userPromptTemplate"
              rows="3" spellcheck="false"
              placeholder="可用 {{CONTENT}} 插入系统构造的完整任务输入；留空使用内置模板。"
              @change="saveConfig('documentCodeBuddyTaskProfiles')" />
            <small class="muted">未填写占位符时，服务端会把完整内置任务输入追加到模板后，避免漏掉原文或 JSON 数据。</small>
          </label>
          <p v-if="task.key === 'translation'" class="muted small">
            完整初译 System/User Prompt 仍在文档页的“文档翻译 Prompt”编辑器中；此处配置翻译专属推理选项和附加指令。
          </p>
          <details v-else class="built-in-prompt-preview">
            <summary>查看服务端实际使用的内置 System Prompt（只读）</summary>
            <pre v-if="builtInTaskPrompts[task.key]">{{ builtInTaskPrompts[task.key] }}</pre>
            <p v-else-if="promptPreviewLoading" class="muted small">正在读取内置提示词…</p>
            <p v-else-if="promptPreviewError" class="muted small">{{ promptPreviewError }}</p>
            <p v-else class="muted small">请先启动并连接本机 Agent 服务，再读取内置提示词。</p>
          </details>
          <details v-if="task.key !== 'translation'" class="built-in-prompt-preview">
            <summary>查看服务端内置 User Prompt / 输入结构（只读示例）</summary>
            <pre v-if="builtInTaskUserPrompts[task.key]">{{ builtInTaskUserPrompts[task.key] }}</pre>
            <p v-else-if="promptPreviewLoading" class="muted small">正在读取内置提示词…</p>
            <p v-else-if="promptPreviewError" class="muted small">{{ promptPreviewError }}</p>
            <p v-else class="muted small">请先启动并连接本机 Agent 服务，再读取内置提示词。</p>
          </details>
        </article>
      </details>

      <details class="strategy-settings" open>
        <summary>高级运行策略</summary>
        <label class="switch-line">
          <input v-model="config.documentLiteraryReviewEnabled" type="checkbox"
            @change="saveConfig('documentLiteraryReviewEnabled')" />
          <span>默认启用文学审校（准确性/术语与人物声音/文风）</span>
        </label>
        <p class="muted small">
          仅影响通过本机 Local Agent 新建的翻译运行。修改后保存到文档配置，并在下一次运行生效。
          服务端会再次限制最大值；文学模式仍强制按章节分批，并保留证据边界与防剧透约束。
        </p>
        <div class="settings-grid">
          <label class="setting-field">
            <span>每批最多片段数</span>
            <select v-model.number="config.documentBatchMaxSegments" @change="saveConfig('documentBatchMaxSegments')">
              <option :value="8">8 段</option>
              <option :value="12">12 段</option>
              <option :value="16">16 段（默认）</option>
              <option :value="20">20 段</option>
              <option :value="24">24 段</option>
            </select>
          </label>
          <label class="setting-field">
            <span>每批原文字符上限</span>
            <select v-model.number="config.documentBatchMaxSourceChars" @change="saveConfig('documentBatchMaxSourceChars')">
              <option :value="4000">4,000 字符</option>
              <option :value="6000">6,000 字符</option>
              <option :value="8000">8,000 字符（默认）</option>
              <option :value="10000">10,000 字符</option>
              <option :value="12000">12,000 字符</option>
            </select>
          </label>
          <label class="setting-field">
            <span>初译并发上限</span>
            <select v-model.number="config.documentTranslationConcurrency" @change="saveConfig('documentTranslationConcurrency')">
              <option :value="1">1 路</option>
              <option :value="2">2 路</option>
              <option :value="3">3 路</option>
              <option :value="4">4 路（默认）</option>
              <option :value="5">5 路</option>
              <option :value="6">6 路</option>
            </select>
            <small class="muted">实际并发还受本机 Provider 会话池容量约束。</small>
          </label>
          <label class="setting-field">
            <span>审校并发上限</span>
            <select v-model.number="config.documentReviewConcurrency" @change="saveConfig('documentReviewConcurrency')">
              <option :value="1">1 路</option>
              <option :value="2">2 路（默认）</option>
              <option :value="3">3 路</option>
              <option :value="4">4 路</option>
            </select>
            <small class="muted">只在开启文学审校时生效，与初译共享会话池。</small>
          </label>
          <label class="setting-field">
            <span>前文参考片段数</span>
            <select v-model.number="config.documentPrecedingContextSegments" @change="saveConfig('documentPrecedingContextSegments')">
              <option :value="0">不注入前文</option>
              <option :value="2">2 段</option>
              <option :value="4">4 段（默认）</option>
              <option :value="6">6 段</option>
            </select>
            <small class="muted">只用于指代和场景消歧，不进入本批翻译结果；不能读取后续章节。</small>
          </label>
          <label class="setting-field">
            <span>TranslationBrief 上下文预算</span>
            <select v-model.number="config.documentContextBudgetChars" @change="saveConfig('documentContextBudgetChars')">
              <option :value="8000">8,000 字符</option>
              <option :value="12000">12,000 字符</option>
              <option :value="16000">16,000 字符</option>
              <option :value="18000">18,000 字符（默认）</option>
            </select>
            <small class="muted">预算不足时优先裁剪低优先级记忆；服务端硬上限为 18,000 字符。</small>
          </label>
          <label class="setting-field">
            <span>单批模型调用最大尝试次数</span>
            <select v-model.number="config.documentMaxModelAttempts" @change="saveConfig('documentMaxModelAttempts')">
              <option :value="1">1 次（不重试）</option>
              <option :value="2">2 次（默认，允许重试一次）</option>
            </select>
            <small class="muted">重试时只提交未返回的片段，不重发已成功的整批内容。</small>
          </label>
        </div>
      </details>
    </div>

    <label class="switch-line">
      <input v-model="config.documentUseServerTranslation" type="checkbox" :disabled="config.documentUseLocalAgent"
        @change="saveConfig('documentUseServerTranslation')" />
      <span>通过远程服务翻译</span>
    </label>
    <p v-if="config.documentUseLocalAgent" class="muted small">文档翻译使用本机 Agent；网页和选中文本翻译仍使用它们自己的配置。</p>

    <details v-if="config.documentUseServerTranslation" class="settings-subpanel server-settings" open>
      <summary>服务端翻译设置</summary>
      <label class="setting-field">
        <span>服务端翻译地址</span>
        <input v-model="config.documentServerUrl" type="url" placeholder="https://s.sunxiunan.com/fanyi/page"
          @change="saveConfig('documentServerUrl')" />
      </label>
      <label class="setting-field">
        <span>服务端翻译 Provider</span>
        <select v-model="config.documentProvider" @change="saveConfig('documentProvider')">
          <option value="deepseek">DeepSeek</option>
          <option value="openrouter">OpenRouter</option>
          <option value="nvidia">NVIDIA</option>
          <option value="cloudflare">Cloudflare</option>
          <option value="gemini">Gemini</option>
          <option value="opencode">OpenCode</option>
        </select>
      </label>
    </details>

    <div class="connection-footer">
      <button type="button" class="link-button" :disabled="checking" @click="checkConfiguration">
        {{ checking ? '检查中…' : '检查当前翻译配置' }}
      </button>
      <span v-if="configStatus === 'ok'" class="connection-ok">配置检查通过</span>
      <span v-else-if="configStatus === 'fail'" class="connection-fail">{{ configStatusDetail || '配置检查失败' }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES, getConfig, setConfig, type Config, type DocumentCodeBuddyTaskKey } from '@/entrypoints/utils/config';
import { isLocalAgentServiceAvailable } from '@/entrypoints/utils/localAgentHealth';
import { normalizeContextWindowOption, type CodeBuddyContextWindowOption } from '@/entrypoints/utils/codeBuddyContextWindow';

const props = defineProps<{
  activeSourceLang?: string;
  activeTargetLang?: string;
}>();
const emit = defineEmits<{
  updated: [config: Config, changedFields: (keyof Config)[]];
}>();

/**
 * 设置页读的是"当前服务能力"（内置 Prompt、模型列表、上下文窗口）。
 * 端口假活时 fetch 会一直悬着，按钮就永远停在"读取中…"，用户既看不到结果也看不到失败。
 * 这些读取都是可重试的展示数据，超时按失败处理比无限等待更有用。
 */
const SETTINGS_REQUEST_TIMEOUT_MS = 8_000;

const config = ref<Config>({
  sourceLang: 'auto',
  targetLang: 'zh',
  deepseekApiKey: '',
  provider: 'deepseek',
  promptStyle: 'default',
  translationMode: 'technical',
  shortcuts: {
    translatePage: 'Alt+T',
    translateSelection: 'Alt+S',
    restoreOriginal: 'Alt+R',
    toggleTranslation: 'Alt+V',
  },
  useServerTranslation: false,
  serverUrl: 'https://s.sunxiunan.com/fanyi/page',
  useLocalAgent: false,
  localAgentProvider: 'workbuddy',
  localAgentUrl: 'http://127.0.0.1:8789',
  localAgentModel: 'auto',
  localAgentToken: '',
  documentSourceLang: 'auto',
  documentTargetLang: 'zh',
  documentDeepseekApiKey: '',
  documentProvider: 'deepseek',
  documentPromptStyle: 'default',
  documentTranslationMode: 'technical',
  documentUseServerTranslation: false,
  documentServerUrl: 'https://s.sunxiunan.com/fanyi/page',
  documentUseLocalAgent: false,
  documentAutoSelectLocalAgent: true,
  documentLocalAgentProvider: 'workbuddy',
  documentLocalAgentUrl: 'http://127.0.0.1:8789',
  documentLocalAgentModel: 'auto',
  documentLocalAgentToken: '',
  documentCodeBuddyTaskProfiles: DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES,
  documentBatchMaxSegments: 16,
  documentBatchMaxSourceChars: 8000,
  documentTranslationConcurrency: 4,
  documentReviewConcurrency: 2,
  documentPrecedingContextSegments: 4,
  documentContextBudgetChars: 18000,
  documentMaxModelAttempts: 2,
  documentLiteraryReviewEnabled: true,
});
const codeBuddyTaskOptions: Array<{ key: DocumentCodeBuddyTaskKey; label: string; description: string }> = [
  { key: 'translation', label: '文档初译', description: '优先忠实原文与规范输出；默认关闭思考，以低 effort 提高批量吞吐。' },
  { key: 'accuracyReview', label: '准确性 / 术语审校', description: '核对意义、事实、漏译、增译、否定、指代和专名一致性。' },
  { key: 'styleReview', label: '人物声音 / 文风审校', description: '检查人物语气、叙述声音、语域、节奏与翻译腔。' },
  { key: 'literaryAnalysis', label: '章节文学分析', description: '分析当前章节的人物画像、关系语言、锚点与书籍记忆。' },
  { key: 'contextGraph', label: '全书预处理 / Context Graph', description: '跨章节抽样，建立人物、实体、关系和叙述风格图谱。' },
];
const initialized = ref(false);
const saving = ref(false);
const saveMessage = ref('');
const checking = ref(false);
const localStatus = ref<'unknown' | 'ok' | 'fail'>('unknown');
const configStatus = ref<'unknown' | 'ok' | 'fail'>('unknown');
const configStatusDetail = ref('');
const builtInTaskPrompts = ref<Partial<Record<DocumentCodeBuddyTaskKey, string>>>({});
const builtInTaskUserPrompts = ref<Partial<Record<DocumentCodeBuddyTaskKey, string>>>({});
const codeBuddyModels = ref<Array<{ id: string; credits?: number | null }>>([]);
const codeBuddyContextWindowOptions = ref<Partial<Record<DocumentCodeBuddyTaskKey, CodeBuddyContextWindowOption>>>({});
const codeBuddyContextOptionsRequestVersion = ref(0);
const promptPreviewLoading = ref(false);
const promptPreviewError = ref('');

onMounted(async () => {
  config.value = await getConfig();
  applyActiveDocumentLanguages();
  initialized.value = true;
  // Probe independently of the webpage profile. The saved auto-select preference
  // distinguishes first-run defaults from an explicit user opt-out.
  void checkLocalService();
});

watch(
  () => [props.activeSourceLang, props.activeTargetLang],
  () => {
    if (initialized.value) applyActiveDocumentLanguages();
  },
);

watch(
  () => [
    config.value.documentLocalAgentModel,
    config.value.documentLocalAgentProvider,
    ...codeBuddyTaskOptions.map((task) => config.value.documentCodeBuddyTaskProfiles[task.key].model),
  ],
  () => {
    if (initialized.value && localStatus.value === 'ok') void loadCodeBuddyContextWindowOptions();
  },
);

function applyActiveDocumentLanguages() {
  // 文档会话可以单独保存语言选择；打开第二个 Tab 时应显示当前文档实际使用的语言，
  // 而不是用网页翻译的全局设置覆盖当前文档会话。手动修改后会保存到文档专用配置。
  if (props.activeSourceLang) config.value.documentSourceLang = props.activeSourceLang;
  if (props.activeTargetLang) config.value.documentTargetLang = props.activeTargetLang;
}

const documentConfigFields: (keyof Config)[] = [
  'documentSourceLang', 'documentTargetLang', 'documentDeepseekApiKey', 'documentProvider',
  'documentPromptStyle', 'documentTranslationMode', 'documentUseServerTranslation', 'documentServerUrl',
  'documentUseLocalAgent', 'documentAutoSelectLocalAgent', 'documentLocalAgentProvider', 'documentLocalAgentUrl',
  'documentLocalAgentModel', 'documentLocalAgentToken', 'documentCodeBuddyTaskProfiles',
  'documentBatchMaxSegments', 'documentBatchMaxSourceChars', 'documentTranslationConcurrency',
  'documentReviewConcurrency', 'documentPrecedingContextSegments', 'documentContextBudgetChars',
  'documentMaxModelAttempts', 'documentLiteraryReviewEnabled',
];

async function saveConfig(...fields: (keyof Config)[]) {
  if (!initialized.value || fields.length === 0) return;
  // First document-setting edit snapshots inherited values into a complete document-only profile.
  const patch = Object.fromEntries(documentConfigFields.map((field) => [field, config.value[field]])) as Partial<Config>;
  saving.value = true;
  saveMessage.value = '';
  try {
    await setConfig(patch);
    emit('updated', JSON.parse(JSON.stringify(config.value)) as Config, fields);
    saveMessage.value = '文档配置已保存';
  } finally {
    saving.value = false;
  }
}

async function onTaskModelChange(task: DocumentCodeBuddyTaskKey) {
  // Context-window tiers belong to a model; clear a value that may not exist on the new model.
  delete config.value.documentCodeBuddyTaskProfiles[task].contextWindow;
  await saveConfig('documentCodeBuddyTaskProfiles');
  if (localStatus.value === 'ok') void loadCodeBuddyContextWindowOptions();
}

async function onDocumentLocalAgentModelChange() {
  let changedProfiles = false;
  for (const task of codeBuddyTaskOptions) {
    const profile = config.value.documentCodeBuddyTaskProfiles[task.key];
    if (!profile.model && profile.contextWindow !== undefined) {
      delete profile.contextWindow;
      changedProfiles = true;
    }
  }
  if (changedProfiles) {
    await saveConfig('documentLocalAgentModel', 'documentCodeBuddyTaskProfiles');
  } else {
    await saveConfig('documentLocalAgentModel');
  }
  if (localStatus.value === 'ok') void loadCodeBuddyContextWindowOptions();
}

async function onContextWindowChange(task: DocumentCodeBuddyTaskKey, event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  const profile = config.value.documentCodeBuddyTaskProfiles[task];
  const raw = target.value;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (raw === '') delete profile.contextWindow;
  else if (Number.isSafeInteger(value) && value > 0) profile.contextWindow = value;
  else return;
  await saveConfig('documentCodeBuddyTaskProfiles');
}
async function onLocalAgentToggle() {
  config.value.documentAutoSelectLocalAgent = config.value.documentUseLocalAgent;
  if (config.value.documentUseLocalAgent) {
    config.value.documentUseServerTranslation = false;
    localStatus.value = 'unknown';
  } else {
    // A manual opt-out must survive future settings-panel mounts.
    config.value.documentAutoSelectLocalAgent = false;
    localStatus.value = 'unknown';
  }
  await saveConfig('documentUseLocalAgent', 'documentAutoSelectLocalAgent', 'documentUseServerTranslation');
  if (config.value.documentUseLocalAgent) void checkLocalService();
}

async function saveLocalAgentUrl() {
  await saveConfig('documentLocalAgentUrl');
  if (config.value.documentUseLocalAgent) void checkLocalService();
}

async function checkLocalService() {
  checking.value = true;
  localStatus.value = 'unknown';
  try {
    const available = await isLocalAgentServiceAvailable(
      config.value.documentLocalAgentUrl || 'http://127.0.0.1:8789',
    );
    localStatus.value = available ? 'ok' : 'fail';
    if (available) {
      await loadBuiltInTaskPrompts();
      await loadCodeBuddyModels();
    } else {
      codeBuddyModels.value = [];
      codeBuddyContextWindowOptions.value = {};
    }
    if (available && config.value.documentAutoSelectLocalAgent && !config.value.documentUseLocalAgent) {
      config.value.documentUseLocalAgent = true;
      config.value.documentUseServerTranslation = false;
      await saveConfig('documentUseLocalAgent', 'documentUseServerTranslation');
    }
  } catch {
    localStatus.value = 'fail';
  } finally {
    checking.value = false;
  }
}

async function loadBuiltInTaskPrompts() {
  promptPreviewLoading.value = true;
  promptPreviewError.value = '';
  builtInTaskPrompts.value = {};
  builtInTaskUserPrompts.value = {};
  try {
    const url = new URL(config.value.documentLocalAgentUrl || 'http://127.0.0.1:8789');
    url.pathname = '/api/config/task-prompts';
    url.search = '';
    url.hash = '';
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        ...(config.value.documentLocalAgentToken
          ? { Authorization: 'Bearer ' + config.value.documentLocalAgentToken }
          : {}),
      },
      signal: AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('读取内置 Prompt 失败（HTTP ' + response.status + '）');
    const data = await response.json() as {
      prompts?: Partial<Record<DocumentCodeBuddyTaskKey, string>>;
      userPromptTemplates?: Partial<Record<DocumentCodeBuddyTaskKey, string>>;
    };
    builtInTaskPrompts.value = data.prompts && typeof data.prompts === 'object' ? data.prompts : {};
    builtInTaskUserPrompts.value = data.userPromptTemplates && typeof data.userPromptTemplates === 'object'
      ? data.userPromptTemplates : {};
  } catch (error) {
    promptPreviewError.value = error instanceof Error ? error.message : String(error);
  } finally {
    promptPreviewLoading.value = false;
  }
}

async function loadCodeBuddyModels() {
  try {
    const url = new URL(config.value.documentLocalAgentUrl || 'http://127.0.0.1:8789');
    url.pathname = '/api/codebuddy/models';
    url.search = '';
    url.hash = '';
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        ...(config.value.documentLocalAgentToken
          ? { Authorization: 'Bearer ' + config.value.documentLocalAgentToken }
          : {}),
      },
      signal: AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('读取 CodeBuddy 模型列表失败（HTTP ' + response.status + '）');
    const data = await response.json() as { data?: Array<{ id: string; credits?: number | null }> };
    codeBuddyModels.value = Array.isArray(data.data) ? data.data.map((item) => ({ id: item.id, credits: item.credits ?? null })) : [];
  } catch {
    codeBuddyModels.value = [];
  }
  if (localStatus.value === 'ok') await loadCodeBuddyContextWindowOptions();
}

async function loadCodeBuddyContextWindowOptions() {
  const requestVersion = ++codeBuddyContextOptionsRequestVersion.value;
  if (config.value.documentLocalAgentProvider !== 'workbuddy') {
    codeBuddyContextWindowOptions.value = {};
    return;
  }
  const next: Partial<Record<DocumentCodeBuddyTaskKey, CodeBuddyContextWindowOption>> = {};
  let couldValidateStoredSelections = false;
  const invalidStoredValues: DocumentCodeBuddyTaskKey[] = [];
  await Promise.all(codeBuddyTaskOptions.map(async (task) => {
    const profile = config.value.documentCodeBuddyTaskProfiles[task.key];
    const model = profile.model.trim() || config.value.documentLocalAgentModel.trim() || 'auto';
    try {
      const url = new URL(config.value.documentLocalAgentUrl || 'http://127.0.0.1:8789');
      url.pathname = '/api/codebuddy/config-options';
      url.search = '';
      url.hash = '';
      url.searchParams.set('model', model);
      if (profile.contextWindow !== undefined) url.searchParams.set('currentValue', String(profile.contextWindow));
      const response = await fetch(url.toString(), {
        method: 'GET',
        cache: 'no-store',
        headers: {
          ...(config.value.documentLocalAgentToken
            ? { Authorization: 'Bearer ' + config.value.documentLocalAgentToken }
            : {}),
        },
        signal: AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return;
      couldValidateStoredSelections = true;
      const payload = await response.json() as { configOptions?: unknown };
      const rawOption = Array.isArray(payload.configOptions) ? payload.configOptions[0] : undefined;
      const option = normalizeContextWindowOption(rawOption);
      if (option) {
        next[task.key] = option;
        if (profile.contextWindow !== undefined && !option.options.some((entry) => entry.value === String(profile.contextWindow))) {
          invalidStoredValues.push(task.key);
        }
      } else if (profile.contextWindow !== undefined) {
        // Successful response with no selector means this model no longer exposes multiple tiers.
        invalidStoredValues.push(task.key);
      }
    } catch {
      // The service may not yet expose this endpoint; retain user data and never infer tiers from /models.
    }
  }));
  if (requestVersion !== codeBuddyContextOptionsRequestVersion.value) return;
  codeBuddyContextWindowOptions.value = next;
  if (couldValidateStoredSelections && invalidStoredValues.length) {
    for (const task of invalidStoredValues) delete config.value.documentCodeBuddyTaskProfiles[task].contextWindow;
    await saveConfig('documentCodeBuddyTaskProfiles');
  }
}

async function checkConfiguration() {
  checking.value = true;
  configStatus.value = 'unknown';
  configStatusDetail.value = '';
  try {
    if (config.value.documentUseLocalAgent) {
      const available = await isLocalAgentServiceAvailable(config.value.documentLocalAgentUrl || 'http://127.0.0.1:8789');
      configStatus.value = available ? 'ok' : 'fail';
      configStatusDetail.value = available ? '' : '本机文档 Agent 服务不可连接';
      return;
    }
    if (config.value.documentUseServerTranslation) {
      const validUrl = /^https?:\/\//i.test(config.value.documentServerUrl || '');
      configStatus.value = validUrl ? 'ok' : 'fail';
      configStatusDetail.value = validUrl ? '远程文档翻译地址格式正常；Provider 密钥由服务端管理' : '请填写有效的文档翻译服务 URL';
      return;
    }
    if (config.value.documentProvider === 'deepseek' && !config.value.documentDeepseekApiKey) {
      configStatus.value = 'fail';
      configStatusDetail.value = '文档翻译尚未配置 DeepSeek API Key';
      return;
    }
    configStatus.value = 'ok';
    configStatusDetail.value = '文档 Provider 配置已保存';
  } catch (error) {
    configStatus.value = 'fail';
    configStatusDetail.value = error instanceof Error ? error.message : String(error);
  } finally {
    checking.value = false;
  }
}
</script>

<style scoped>
.translation-settings {
  display: grid;
  gap: .85rem;
}
.settings-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.settings-heading h3 {
  margin: 0;
  font-size: 1rem;
}
.settings-heading p { margin: .25rem 0 0; line-height: 1.5; }
.muted { color: #57606a; }
.small { font-size: .78rem; }
.save-state { color: #57606a; font-size: .78rem; white-space: nowrap; }
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .75rem;
}
.setting-field {
  display: flex;
  flex-direction: column;
  gap: .3rem;
  min-width: 0;
  color: #57606a;
  font-size: .8rem;
}
.setting-field input,
.setting-field select {
  width: 100%;
  min-width: 0;
  padding: .48rem .55rem;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #fff;
  color: #1f2328;
  font: inherit;
  font-size: .9rem;
}
.setting-field input:focus,
.setting-field select:focus {
  outline: none;
  border-color: #0969da;
  box-shadow: 0 0 0 2px rgba(9, 105, 218, .12);
}
.setting-field small { line-height: 1.45; }
.switch-line {
  display: flex;
  align-items: center;
  gap: .55rem;
  color: #1f2328;
  cursor: pointer;
}
.switch-line input { width: 1rem; height: 1rem; accent-color: #0969da; }
.settings-subpanel {
  display: grid;
  gap: .75rem;
  padding: .85rem;
  border: 1px solid #e1e6ec;
  border-radius: 8px;
  background: #f8fafc;
}
.server-settings summary,
.strategy-settings summary {
  cursor: pointer;
  color: #57606a;
  font-size: .82rem;
  margin-bottom: .25rem;
}
.task-profile-settings { margin-top: .2rem; }
.task-profile-card {
  display: grid;
  gap: .65rem;
  padding: .85rem .75rem;
  border-top: 1px solid #d8dee4;
  border-radius: 8px;
}
.task-profile-card:nth-child(odd) {
  background: #f6f8fa;
}
.task-profile-card:nth-child(even) {
  background: #fff8f0;
}
.task-profile-heading h4, .task-profile-heading p { margin: 0; }
.task-profile-heading p { margin-top: .2rem; }
.built-in-prompt-preview pre {
  max-height: 300px;
  overflow: auto;
  margin: .55rem 0 0;
  padding: .65rem;
  border: 1px solid #d8dee4;
  border-radius: 6px;
  background: #f6f8fa;
  color: #24292f;
  font: .76rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.task-prompt-field textarea {
  width: 100%;
  min-width: 0;
  padding: .5rem .6rem;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #fff;
  color: #1f2328;
  font: inherit;
  font-size: .88rem;
  resize: vertical;
}
.strategy-settings {
  display: grid;
  gap: .65rem;
  padding-top: .75rem;
  border-top: 1px solid #e1e6ec;
}
.strategy-settings > p { margin: 0; line-height: 1.5; }
.connection-row, .connection-footer {
  display: flex;
  align-items: center;
  gap: .65rem;
  flex-wrap: wrap;
}
.connection-footer {
  padding-top: .65rem;
  border-top: 1px solid #eaeef2;
}
.connection-ok { color: #1a7f37; font-size: .78rem; }
.connection-fail { color: #a40e26; font-size: .78rem; overflow-wrap: anywhere; }
.btn {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: .4rem .75rem;
  background: #fff;
  color: #1f2328;
  cursor: pointer;
  font-size: .82rem;
}
.btn.primary { background: #0969da; border-color: #0969da; color: #fff; }
.btn.primary:hover { background: #0860ca; }
.btn:disabled, .link-button:disabled { opacity: .55; cursor: not-allowed; }
.link-button {
  padding: 0;
  border: 0;
  color: #0969da;
  background: transparent;
  cursor: pointer;
  font-size: .8rem;
}
@media (max-width: 640px) {
  .settings-grid { grid-template-columns: 1fr; }
  .settings-heading { flex-direction: column; }
}
</style>
