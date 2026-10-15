<template>
  <div class="popup-container">
    <h2>简简单单翻译</h2>
    <p class="hint-text">这里配置网页与选中文本翻译。EPUB/PDF 等文档翻译使用文档页里的独立配置。</p>
    <div class="settings">
      <div v-if="!config.useLocalAgent" class="input-item">
        <label>DeepSeek API Key</label>
        <input
          type="password"
          v-model="config.deepseekApiKey"
          placeholder="输入 DeepSeek API Key"
          @input="onApiKeyChange"
        />
        <span v-if="apiStatus === 'checking'" class="status-text checking">验证中...</span>
        <span v-else-if="apiStatus === 'ok'" class="status-text success">已配置</span>
        <span v-else-if="apiStatus === 'fail'" class="status-text error">未配置或无效</span>
      </div>

      <div class="lang-row">
        <div class="select-item">
          <label>源语言</label>
          <select v-model="config.sourceLang" @change="saveConfig">
            <option value="auto">自动检测</option>
            <option value="en">英语</option>
            <option value="zh">中文</option>
            <option value="ja">日语</option>
          </select>
        </div>
        <div class="select-item">
          <label>目标语言</label>
          <select v-model="config.targetLang" @change="saveConfig">
            <option value="zh">中文</option>
            <option value="en">英语</option>
            <option value="ja">日语</option>
          </select>
        </div>
      </div>

      <div class="select-item">
        <label>翻译类型</label>
        <select v-model="config.translationMode" @change="saveConfig">
          <option value="technical">科技/信息翻译</option>
          <option value="literary">文学翻译</option>
        </select>
        <span class="hint-text">
          科技模式优先准确、清晰和术语控制；文学模式优先文学表达、人物声音、节奏与实体一致性，并关闭自动术语表。
        </span>
      </div>

      <div class="select-item">
        <label>翻译文风</label>
        <select v-model="config.promptStyle" @change="saveConfig">
          <option value="default">通用直译</option>
          <option value="ja-source-natural">日语原文汉译</option>
          <option value="jinyong">金庸武侠</option>
          <option value="acheng">阿城白描</option>
          <option value="wangxiaobo">王小波大白话</option>
        </select>
      </div>

      <label class="switch-item">
        <input type="checkbox" v-model="config.useLocalAgent" @change="onLocalAgentToggle" />
        <span>使用本机 Workbuddy/OpenCode 翻译</span>
      </label>

      <div
        v-if="config.useLocalAgent && !localAgentAvailable"
        class="local-agent-offline"
        role="status"
      >
        <span>本机翻译模式仍已启用，但检测不到本机服务。不会自动切换到远程 Provider；服务启动后即可直接使用。</span>
        <button type="button" class="server-toggle" @click="disableLocalAgent">关闭本机模式</button>
      </div>

      <div v-if="config.useLocalAgent" class="server-group local-agent-group">
        <div class="select-item">
          <label>本机 Agent</label>
          <select v-model="config.localAgentProvider" @change="saveConfig">
            <option value="workbuddy">Workbuddy / CodeBuddy SDK</option>
            <option value="opencode">OpenCode CLI</option>
          </select>
        </div>
        <div class="input-item">
          <label>本机服务地址</label>
          <input type="text" v-model="config.localAgentUrl" placeholder="http://127.0.0.1:8789" @change="saveConfig" />
          <span v-if="!localAgentAvailable" class="hint-text">
            当前未检测到服务。可以先在本页开启本机模式、填好地址，等服务启动后直接可用——不必先关掉再打开。
          </span>
        </div>
        <div class="input-item">
          <label>模型覆盖（可选）</label>
          <input type="text" v-model="config.localAgentModel" placeholder="auto；或 OpenCode 的 provider/model" @change="saveConfig" />
          <span class="hint-text">auto 优先使用本机服务环境变量；未设置时使用运行时默认模型。OpenCode 覆盖示例：openai/gpt-5.4；Workbuddy 填本机 SDK 模型 ID。</span>
        </div>
        <div class="input-item">
          <label>本机服务 Token（可选）</label>
          <input type="password" v-model="config.localAgentToken" placeholder="默认可留空；仅服务端配置 Token 时填写" @change="saveConfig" />
        </div>
        <button type="button" class="server-toggle" @click="checkApiKey">测试本机服务连接</button>
        <span v-if="apiStatus === 'checking'" class="status-text checking">正在检查本机服务…</span>
        <span v-else-if="apiStatus === 'ok'" class="status-text success">本机服务可连接</span>
        <span v-else-if="apiStatus === 'fail'" class="status-text error">本机服务不可用，请检查地址、Token 和服务进程</span>
        <span v-if="apiStatus === 'fail' && apiStatusDetail" class="hint-text">{{ apiStatusDetail }}</span>
      </div>

      <label class="switch-item">
        <input type="checkbox" v-model="config.useServerTranslation" :disabled="config.useLocalAgent" @change="saveConfig" />
        <span>通过远程服务翻译当前页面</span>
      </label>
      <span v-if="config.useLocalAgent" class="hint-text">本机 Provider 已启用，用于网页与选中文本翻译；EPUB/PDF 文档翻译在文档页单独配置。</span>

      <div v-if="config.useServerTranslation" class="server-section">
        <button
          type="button"
          class="server-toggle"
          :aria-expanded="serverExpanded"
          @click="serverExpanded = !serverExpanded"
        >
          <span>服务端翻译设置</span>
          <span class="chevron" :class="{ open: serverExpanded }">▸</span>
        </button>
        <div v-if="serverExpanded" class="server-group">
          <div class="input-item">
            <label>服务端翻译地址</label>
            <input
              type="text"
              v-model="config.serverUrl"
              placeholder="https://s.sunxiunan.com/fanyi/page"
              @input="onServerUrlChange"
            />
            <span class="hint-text">把当前页面发送到远程翻译</span>
          </div>

          <div class="select-item">
            <label>服务端翻译 Provider</label>
            <select v-model="config.provider" @change="saveConfig">
              <option value="deepseek">DeepSeek</option>
              <option value="openrouter">OpenRouter</option>
              <option value="nvidia">NVIDIA</option>
              <option value="cloudflare">Cloudflare</option>
              <option value="gemini">Gemini</option>
              <option value="opencode">OpenCode</option>
            </select>
            <span class="hint-text">选择服务端翻译使用的 LLM Provider</span>
          </div>
        </div>
      </div>

      <div class="actions">
        <button @click="triggerTranslate" class="primary">翻译</button>
        <button @click="openChat">对话</button>
      </div>
      <div class="actions-minor">
        <button @click="openDocument" title="翻译本地文档（txt/md/html/srt/vtt/json/pdf/docx/epub）">文档</button>
        <button @click="restoreOriginal" title="恢复原网页">恢复</button>
        <button @click="clearCache" title="清空所有翻译缓存">清除缓存</button>
      </div>
      <span v-if="cacheClearMessage" class="hint-text" role="status">{{ cacheClearMessage }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { getConfig, setConfig, type Config } from '@/entrypoints/utils/config';
import { isLocalAgentServiceAvailable } from '@/entrypoints/utils/localAgentHealth';
import { openSidePanel } from '@/entrypoints/utils/sidePanel';

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
});

const apiStatus = ref<'checking' | 'ok' | 'fail' | 'unknown'>('unknown');
/** 后端返回的失败原因（如「端口没在监听」），比笼统的「不可用」更可操作。 */
const apiStatusDetail = ref('');
const localAgentAvailable = ref(false);
const cacheClearMessage = ref('');
/** 服务端翻译设置面板折叠状态（默认收起，保持 popup 紧凑）。 */
const serverExpanded = ref(false);
let checkTimer: number | null = null;
let serverUrlTimer: number | null = null;
let healthPollTimer: number | null = null;
let healthCheckInProgress = false;

onMounted(async () => {
  config.value = await getConfig();
  await refreshLocalAgentAvailability();
  checkApiKey();
  // 弹窗打开期间持续更新：服务启动后状态提示自动转为可连接，服务停止后转为离线提示。
  // 开关本身常驻（不受可用性影响），否则「关掉本机 + 服务未起」会让用户失去恢复入口。
  healthPollTimer = window.setInterval(() => {
    void refreshLocalAgentAvailability();
  }, 4000);
});

onUnmounted(() => {
  if (checkTimer) clearTimeout(checkTimer);
  if (serverUrlTimer) clearTimeout(serverUrlTimer);
  if (healthPollTimer) clearInterval(healthPollTimer);
});

async function saveConfig() {
  // Popup settings are for webpage/selection translation only. Never write the resolved
  // document-prefixed values returned by getConfig(), as they may be inherited legacy defaults.
  const pageTranslationConfig = Object.fromEntries(
    Object.entries(config.value).filter(([key]) => !key.startsWith('document')),
  ) as Partial<Config>;
  await setConfig(pageTranslationConfig);
}

async function refreshLocalAgentAvailability() {
  if (healthCheckInProgress) return;
  healthCheckInProgress = true;
  try {
    localAgentAvailable.value = await isLocalAgentServiceAvailable(
      config.value.localAgentUrl || 'http://127.0.0.1:8789',
    );
  } finally {
    healthCheckInProgress = false;
  }
}

async function onLocalAgentToggle() {
  if (config.value.useLocalAgent) {
    // 服务可能恰好在上次轮询后退出。探测失败不再静默把开关弹回去：
    // 本机模式是用户的显式偏好，服务没起时也应能保持开启（地址/服务就绪后直接可用）。
    // 否则「服务未启动」与「开关不可见」互相锁死，用户没有恢复入口。
    await refreshLocalAgentAvailability();
    config.value.useServerTranslation = false;
  }
  await saveConfig();
  await checkApiKey();
}

async function disableLocalAgent() {
  // 这是显式切换操作；服务不可用时绝不静默转发原文到远程 Provider。
  config.value.useLocalAgent = false;
  await saveConfig();
  await checkApiKey();
}

function onApiKeyChange() {
  apiStatus.value = 'checking';
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = window.setTimeout(() => {
    saveConfig();
    checkApiKey();
  }, 800);
}

function onServerUrlChange() {
  if (serverUrlTimer) clearTimeout(serverUrlTimer);
  serverUrlTimer = window.setTimeout(() => {
    // 用户清空 → 恢复默认地址
    if (!config.value.serverUrl?.trim()) {
      config.value.serverUrl = 'https://s.sunxiunan.com/fanyi/page';
    }
    saveConfig();
  }, 400);
}

async function checkApiKey() {
  if (!config.value.useLocalAgent && !config.value.deepseekApiKey) {
    apiStatus.value = 'fail';
    apiStatusDetail.value = '未配置 API Key，也未启用本机模式';
    return;
  }
  apiStatus.value = 'checking';
  apiStatusDetail.value = '';
  try {
    const response = await browser.runtime.sendMessage({ action: 'checkConfig' });
    apiStatus.value = response.success ? 'ok' : 'fail';
    // 后端已把「连不上」翻译成可操作提示，这里直接展示，别只丢一句「不可用」。
    apiStatusDetail.value = response.success ? '' : (response.error || '');
  } catch (error) {
    apiStatus.value = 'fail';
    apiStatusDetail.value = error instanceof Error ? error.message : String(error);
  }
}

async function triggerTranslate() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    // 经 background 消息中枢转发到 content script（失败由 background 统一处理）
    browser.runtime.sendMessage({ action: 'relayToContent', tabId: tab.id, message: { action: 'translatePage' } })
      .catch(() => {});
    window.close();
  }
}

async function openChat() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    window.close();
    return;
  }
  // 打开浏览器级对话侧栏（Chrome sidePanel / Firefox sidebarAction）。
  // 面板自身向 background 取该页正文，不再用 iframe 注入网页 DOM。
  await openSidePanel(tab.id);
  window.close();
}

/**
 * 打开文档翻译页。
 * 独立标签页而不是侧栏：文档是长内容沉浸式阅读，侧栏 400px 太窄；
 * 而且 Firefox Android 根本没有侧栏 API，标签页在两端行为一致。
 */
async function openDocument() {
  await browser.tabs.create({ url: browser.runtime.getURL('document.html') });
  window.close();
}

async function restoreOriginal() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    browser.runtime.sendMessage({ action: 'relayToContent', tabId: tab.id, message: { action: 'restoreOriginal' } })
      .catch(() => {});
  }
}

async function clearCache() {
  cacheClearMessage.value = '正在清理翻译缓存…';
  try {
    const result = await browser.runtime.sendMessage({ action: 'clearCache' }) as {
      success?: boolean;
      error?: string;
    };
    cacheClearMessage.value = result?.success
      ? '翻译缓存清理完成。'
      : (result?.error || '清理缓存失败，请重试。');
  } catch (error) {
    cacheClearMessage.value = '清理缓存失败：' + (error instanceof Error ? error.message : String(error));
  }
}
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #333;
}

.popup-container {
  padding: 16px;
  min-width: 300px;
  max-width: 350px;
}

h2 {
  margin: 0 0 16px;
  font-size: 18px;
  color: #1a1a1a;
}

.settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.switch-item {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.switch-item input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.input-item,
.select-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.server-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 10px;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  background: #fafafa;
  margin-top: 4px;
}

/* 服务端翻译设置折叠触发器：默认收起，点开才显示 server-group */
.server-section {
  display: flex;
  flex-direction: column;
}

.server-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 10px;
  background: #fafafa;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #666;
  margin-top: 2px;
  text-align: left;
}

.server-toggle:hover {
  border-color: #409eff;
  color: #409eff;
}

.chevron {
  display: inline-block;
  font-size: 12px;
  transition: transform 0.2s;
  transform: rotate(0deg);
}

.chevron.open {
  transform: rotate(90deg);
}

.lang-row {
  display: flex;
  gap: 12px;
}

.lang-row > .select-item {
  flex: 1;
  min-width: 0;
}

.input-item label,
.select-item label,
.radio-item label:first-child {
  font-size: 12px;
  color: #666;
}

.input-item input,
.select-item select {
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}

.input-item input:focus,
.select-item select:focus {
  outline: none;
  border-color: #409eff;
}

.radio-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.radio-group {
  display: flex;
  gap: 16px;
}

.radio-group label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.actions button {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  font-size: 14px;
}

.actions button.primary {
  background: #409eff;
  color: white;
  border-color: #409eff;
}

.actions button.primary:hover {
  background: #66b1ff;
  border-color: #66b1ff;
}

.actions button:hover {
  background: #f5f5f5;
  border-color: #409eff;
  color: #409eff;
}

.actions button.success {
  border-color: #67c23a;
  color: #67c23a;
}

.actions button.error {
  border-color: #f56c6c;
  color: #f56c6c;
}

/* 次要操作：文档 / 恢复 / 清除缓存 — 矮小、低视觉权重，排在主操作下方 */
.actions-minor {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
  margin-top: 2px;
}

.actions-minor button {
  padding: 2px 8px;
  border: 1px solid transparent;
  background: transparent;
  color: #888;
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;
}

.actions-minor button:hover {
  border-color: #e4e7ed;
  color: #409eff;
  background: #f5f7fa;
}

.status-text {
  font-size: 12px;
  margin-top: 2px;
}
.status-text.checking { color: #909399; }
.status-text.success { color: #67c23a; }
.status-text.error { color: #f56c6c; }

.local-agent-offline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid #f0d5a8;
  border-radius: 6px;
  background: #fffaf0;
  color: #8a5a14;
  font-size: 12px;
  line-height: 1.5;
}

.hint-text {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
  line-height: 1.4;
}
</style>
