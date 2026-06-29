<template>
  <div class="popup-container">
    <h2>简简单单翻译</h2>
    <div class="settings">
      <div class="input-item">
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

      <label class="switch-item">
        <input type="checkbox" v-model="config.useServerTranslation" @change="saveConfig" />
        <span>通过远程服务器翻译当前页面（发送 HTML）</span>
      </label>

      <div v-if="config.useServerTranslation" class="server-group">
        <div class="input-item">
          <label>服务端翻译地址</label>
          <input
            type="text"
            v-model="config.serverUrl"
            placeholder="https://s.sunxiunan.com/fanyi/page"
            @input="onServerUrlChange"
          />
          <span class="hint-text">把当前页面发送到远程服务器翻译</span>
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
          <span class="hint-text">选择服务端翻译使用的 LLM Provider，仅对"通过远程服务器翻译"生效。</span>
        </div>
      </div>

      <div class="actions">
        <button @click="triggerTranslate" class="primary">翻译</button>
        <button @click="restoreOriginal">恢复</button>
        <button @click="clearCache">清除缓存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { getConfig, setConfig, type Config } from '@/entrypoints/utils/config';

const config = ref<Config>({
  sourceLang: 'auto',
  targetLang: 'zh',
  deepseekApiKey: '',
  provider: 'deepseek',
  shortcuts: {
    translatePage: 'Alt+T',
    translateSelection: 'Alt+S',
    restoreOriginal: 'Alt+R',
    toggleTranslation: 'Alt+V',
  },
  useServerTranslation: false,
  serverUrl: 'https://s.sunxiunan.com/fanyi/page',
});

const apiStatus = ref<'checking' | 'ok' | 'fail' | 'unknown'>('unknown');
let checkTimer: number | null = null;
let serverUrlTimer: number | null = null;

onMounted(async () => {
  config.value = await getConfig();
  checkApiKey();
});

async function saveConfig() {
  await setConfig(config.value);
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
  if (!config.value.deepseekApiKey) {
    apiStatus.value = 'fail';
    return;
  }
  
  apiStatus.value = 'checking';
  try {
    const response = await browser.runtime.sendMessage({ action: 'checkConfig' });
    apiStatus.value = response.success ? 'ok' : 'fail';
  } catch {
    apiStatus.value = 'fail';
  }
}

async function triggerTranslate() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    browser.tabs.sendMessage(tab.id, { action: 'translatePage' }).catch(() => {});
    window.close();
  }
}

async function restoreOriginal() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    browser.tabs.sendMessage(tab.id, { action: 'restoreOriginal' }).catch(() => {});
  }
}

async function clearCache() {
  await browser.runtime.sendMessage({ action: 'clearCache' });
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
  justify-content: flex-end;
  margin-top: 8px;
}

.actions button {
  padding: 6px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  font-size: 13px;
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

.status-text {
  font-size: 12px;
  margin-top: 2px;
}
.status-text.checking { color: #909399; }
.status-text.success { color: #67c23a; }
.status-text.error { color: #f56c6c; }

.hint-text {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
  line-height: 1.4;
}
</style>
