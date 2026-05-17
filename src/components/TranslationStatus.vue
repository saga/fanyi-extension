<template>
  <div v-if="visible" class="translation-status" :class="status">
    <div class="icon">
      <span v-if="status === 'loading'">⏳</span>
      <span v-else-if="status === 'success'">✅</span>
      <span v-else-if="status === 'error'">❌</span>
    </div>
    <div class="message">{{ message }}</div>
    <button v-if="status === 'error'" @click="retry" class="retry-btn">
      重试
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const visible = ref(false);
const status = ref<'loading' | 'success' | 'error'>('loading');
const message = ref('');
const onRetry = ref<(() => void) | null>(null);

export function showLoading(msg = '翻译中...') {
  visible.value = true;
  status.value = 'loading';
  message.value = msg;
}

export function showSuccess(msg = '翻译完成') {
  visible.value = true;
  status.value = 'success';
  message.value = msg;
  setTimeout(() => {
    visible.value = false;
  }, 2000);
}

export function showError(msg = '翻译失败', retry?: () => void) {
  visible.value = true;
  status.value = 'error';
  message.value = msg;
  onRetry.value = retry || null;
}

export function hide() {
  visible.value = false;
}

const retry = () => {
  if (onRetry.value) {
    onRetry.value();
  }
};
</script>

<style scoped>
.translation-status {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 12px 20px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 999999;
}

.translation-status.loading {
  border-left: 4px solid #409eff;
}

.translation-status.success {
  border-left: 4px solid #67c23a;
}

.translation-status.error {
  border-left: 4px solid #f56c6c;
}

.icon {
  font-size: 20px;
}

.message {
  font-size: 14px;
  color: #303133;
}

.retry-btn {
  padding: 4px 12px;
  background: #409eff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.retry-btn:hover {
  background: #66b1ff;
}
</style>
