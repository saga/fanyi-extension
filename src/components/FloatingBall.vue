<template>
  <div
    class="floating-ball"
    :style="{ left: position.x + 'px', top: position.y + 'px' }"
    @mousedown="startDrag"
    @click="handleClick"
  >
    <span class="icon">🌐</span>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { getConfig, setConfig } from '@/entrypoints/utils/config';

const position = ref({ x: 100, y: 100 });
const isDragging = ref(false);
const dragStart = ref({ x: 0, y: 0 });

const startDrag = (e: MouseEvent) => {
  isDragging.value = true;
  dragStart.value = {
    x: e.clientX - position.value.x,
    y: e.clientY - position.value.y,
  };

  const onMove = (e: MouseEvent) => {
    if (!isDragging.value) return;
    position.value = {
      x: e.clientX - dragStart.value.x,
      y: e.clientY - dragStart.value.y,
    };
  };

  const onUp = () => {
    isDragging.value = false;
    setConfig({ floatingBallPosition: position.value });
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
};

const handleClick = async () => {
  if (isDragging.value) return;
  browser.runtime.sendMessage({ action: 'translatePage' });
};

onMounted(async () => {
  const config = await getConfig();
  if (config.floatingBallPosition) {
    position.value = config.floatingBallPosition;
  }
});
</script>

<style scoped>
.floating-ball {
  position: fixed;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #409eff;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: move;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  z-index: 999999;
  user-select: none;
  transition: transform 0.2s;
}

.floating-ball:hover {
  transform: scale(1.1);
}

.icon {
  font-size: 24px;
}
</style>
