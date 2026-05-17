<template>
  <div class="popup-container">
    <h2>翻译插件</h2>
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
          @change="saveConfig"
        />
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

      <div class="actions">
        <button @click="restoreOriginal">恢复原文</button>
        <button @click="clearCache">清除缓存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getConfig, setConfig, type Config } from '@/entrypoints/utils/config';

const config = ref<Config>({
  enabled: true,
  sourceLang: 'auto',
  targetLang: 'zh',
  mode: 'bilingual',
  deepseekApiKey: '',
});

onMounted(async () => {
  config.value = await getConfig();
});

async function saveConfig() {
  await setConfig(config.value);
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

.actions button:hover {
  background: #f5f5f5;
  border-color: #409eff;
  color: #409eff;
}
</style>
