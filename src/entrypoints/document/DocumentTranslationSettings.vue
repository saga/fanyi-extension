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
          @change="saveConfig('documentLocalAgentModel')" />
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
import { getConfig, setConfig, type Config } from '@/entrypoints/utils/config';
import { isLocalAgentServiceAvailable } from '@/entrypoints/utils/localAgentHealth';

const props = defineProps<{
  activeSourceLang?: string;
  activeTargetLang?: string;
}>();
const emit = defineEmits<{
  updated: [config: Config, changedFields: (keyof Config)[]];
}>();

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
  documentLocalAgentProvider: 'workbuddy',
  documentLocalAgentUrl: 'http://127.0.0.1:8789',
  documentLocalAgentModel: 'auto',
  documentLocalAgentToken: '',
});
const initialized = ref(false);
const saving = ref(false);
const saveMessage = ref('');
const checking = ref(false);
const localStatus = ref<'unknown' | 'ok' | 'fail'>('unknown');
const configStatus = ref<'unknown' | 'ok' | 'fail'>('unknown');
const configStatusDetail = ref('');

onMounted(async () => {
  config.value = await getConfig();
  applyActiveDocumentLanguages();
  initialized.value = true;
  if (config.value.documentUseLocalAgent) void checkLocalService();
});

watch(
  () => [props.activeSourceLang, props.activeTargetLang],
  () => {
    if (initialized.value) applyActiveDocumentLanguages();
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
  'documentUseLocalAgent', 'documentLocalAgentProvider', 'documentLocalAgentUrl',
  'documentLocalAgentModel', 'documentLocalAgentToken',
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

async function onLocalAgentToggle() {
  if (config.value.documentUseLocalAgent) {
    config.value.documentUseServerTranslation = false;
    localStatus.value = 'unknown';
  } else {
    localStatus.value = 'unknown';
  }
  await saveConfig('documentUseLocalAgent', 'documentUseServerTranslation');
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
    localStatus.value = await isLocalAgentServiceAvailable(
      config.value.documentLocalAgentUrl || 'http://127.0.0.1:8789',
    ) ? 'ok' : 'fail';
  } catch {
    localStatus.value = 'fail';
  } finally {
    checking.value = false;
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
.server-settings summary {
  cursor: pointer;
  color: #57606a;
  font-size: .82rem;
  margin-bottom: .25rem;
}
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
