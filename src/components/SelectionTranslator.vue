<template>
  <div
    v-if="visible"
    class="selection-translator"
    :style="{ left: position.x + 'px', top: position.y + 'px' }"
  >
    <div class="header">
      <span class="source-text">{{ sourceText }}</span>
      <div class="actions">
        <button @click="copyTranslation" title="复制译文">📋</button>
        <button @click="close" title="关闭">✕</button>
      </div>
    </div>
    <div class="translation-result">
      <p class="source">{{ sourceText }}</p>
      <p class="target">{{ translatedText }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { translateText } from '@/entrypoints/utils/translateApi';

import { logger } from '../utils/logger';
const visible = ref(false);
const position = ref({ x: 0, y: 0 });
const sourceText = ref('');
const translatedText = ref('');

let selectionTimeout: number | null = null;

const handleSelection = async () => {
  const selection = window.getSelection();
  const text = selection?.toString().trim();

  if (!text || text.length < 2) {
    visible.value = false;
    return;
  }

  sourceText.value = text;

  try {
    const result = await translateText(text);
    translatedText.value = result.translatedText;

    const range = selection!.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    position.value = {
      x: rect.left + window.scrollX,
      y: rect.bottom + window.scrollY + 8,
    };

    visible.value = true;
  } catch (error) {
    logger.error('Translation failed:', error);
  }
};

const copyTranslation = () => {
  navigator.clipboard.writeText(translatedText.value);
};

const close = () => {
  visible.value = false;
};

onMounted(() => {
  document.addEventListener('mouseup', () => {
    if (selectionTimeout) clearTimeout(selectionTimeout);
    selectionTimeout = window.setTimeout(handleSelection, 300);
  });
});

onUnmounted(() => {
  if (selectionTimeout) clearTimeout(selectionTimeout);
  document.removeEventListener('mouseup', handleSelection);
});
</script>

<style scoped>
.selection-translator {
  position: absolute;
  max-width: 400px;
  background: white;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  z-index: 999998;
  padding: 12px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #ebeef5;
}

.source-text {
  font-size: 12px;
  color: #909399;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.actions {
  display: flex;
  gap: 4px;
}

.actions button {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}

.actions button:hover {
  background: #f5f7fa;
}

.translation-result {
  font-size: 14px;
  line-height: 1.6;
}

.source {
  color: #606266;
  margin: 0 0 8px;
}

.target {
  color: #303133;
  margin: 0;
}
</style>
