<template>
  <div class="popup-container">
    <h2>翻译插件</h2>
    <div class="settings">
      <el-switch v-model="enabled" active-text="启用翻译" />
      <el-select v-model="engine" placeholder="选择翻译引擎">
        <el-option label="微软翻译" value="microsoft" />
        <el-option label="Google 翻译" value="google" />
        <el-option label="DeepL" value="deepl" />
      </el-select>
      <el-select v-model="sourceLang" placeholder="源语言">
        <el-option label="自动检测" value="auto" />
        <el-option label="英语" value="en" />
        <el-option label="中文" value="zh" />
        <el-option label="日语" value="ja" />
      </el-select>
      <el-select v-model="targetLang" placeholder="目标语言">
        <el-option label="中文" value="zh" />
        <el-option label="英语" value="en" />
        <el-option label="日语" value="ja" />
      </el-select>
      <el-radio-group v-model="mode">
        <el-radio label="bilingual">双语对照</el-radio>
        <el-radio label="target">仅译文</el-radio>
      </el-radio-group>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const enabled = ref(true);
const engine = ref('microsoft');
const sourceLang = ref('auto');
const targetLang = ref('zh');
const mode = ref('bilingual');
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
</style>
