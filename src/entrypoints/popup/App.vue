<template>
  <div class="popup-container">
    <h2>简简单单翻译</h2>
    <div class="settings">
      <label class="switch-item">
        <input type="checkbox" v-model="config.enabled" @change="saveConfig" />
        <span>启用翻译</span>
      </label>

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

      <div class="radio-item">
        <label>翻译模式</label>
        <div class="radio-group">
          <label><input type="radio" value="bilingual" v-model="config.mode" @change="saveConfig" /> 双语对照</label>
          <label><input type="radio" value="target" v-model="config.mode" @change="saveConfig" /> 仅译文</label>
        </div>
      </div>

      <div class="select-item">
        <label>触屏手势</label>
        <select v-model="config.touchGesture" @change="saveConfig">
          <option value="TripleTap">三击翻译</option>
          <option value="ThreeFinger">三指翻译</option>
          <option value="FourFinger">四指翻译</option>
        </select>
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
  enabled: true,
  sourceLang: 'auto',
  targetLang: 'zh',
  mode: 'bilingual',
  deepseekApiKey: '',
  touchGesture: 'TripleTap',
});

const apiStatus = ref<'checking' | 'ok' | 'fail' | 'unknown'>('unknown');
let checkTimer: number | null = null;

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
    browser.tabs.sendMessage(tab.id, { action: 'translatePage' });
    window.close();
  }
}

async function restoreOriginal() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    browser.tabs.sendMessage(tab.id, { action: 'restoreOriginal' });
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
  margin-top: 4px;
}
.status-text.checking { color: #909399; }
.status-text.success { color: #67c23a; }
.status-text.error { color: #f56c6c; }
</style>
