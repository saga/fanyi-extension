<template>
  <div class="popup-container">
    <h2>翻译插件</h2>
    <div class="settings">
      <el-switch v-model="config.enabled" active-text="启用翻译" @change="saveConfig" />

      <el-input
        v-model="config.deepseekApiKey"
        placeholder="输入 DeepSeek API Key"
        show-password
        @change="saveConfig"
      />

      <el-select v-model="config.sourceLang" placeholder="源语言" @change="saveConfig">
        <el-option label="自动检测" value="auto" />
        <el-option label="英语" value="en" />
        <el-option label="中文" value="zh" />
        <el-option label="日语" value="ja" />
      </el-select>

      <el-select v-model="config.targetLang" placeholder="目标语言" @change="saveConfig">
        <el-option label="中文" value="zh" />
        <el-option label="英语" value="en" />
        <el-option label="日语" value="ja" />
      </el-select>

      <el-radio-group v-model="config.mode" @change="saveConfig">
        <el-radio label="bilingual">双语对照</el-radio>
        <el-radio label="target">仅译文</el-radio>
      </el-radio-group>

      <div class="actions">
        <el-button @click="restoreOriginal" size="small">恢复原文</el-button>
        <el-button @click="clearCache" size="small">清除缓存</el-button>
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

<style scoped>
.popup-container {
  padding: 16px;
  min-width: 300px;
}

h2 {
  margin: 0 0 16px;
  font-size: 18px;
}

.settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
