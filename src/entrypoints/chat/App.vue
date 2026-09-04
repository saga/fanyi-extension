<template>
  <div class="chat-root">
    <!-- 顶部：页面来源 + 重新加载 -->
    <header class="chat-header">
      <div class="src">
        <div class="src-title">{{ pageContext?.title || '网页对话' }}</div>
        <div class="src-url" v-if="pageContext">{{ shortUrl(pageContext.url) }}</div>
      </div>
      <button class="reload-btn" :disabled="status === 'loading'" @click="loadContext">
        {{ status === 'loading' ? '加载中…' : '重新加载' }}
      </button>
    </header>

    <!-- 提示条 -->
    <div v-if="status === 'error'" class="banner error">
      {{ errorMsg }}
      <div class="banner-hint">提示：在普通网页（http/https）上打开本页，或在插件设置中填写 DeepSeek API Key。</div>
    </div>
    <div v-else-if="status === 'loading'" class="banner">正在读取当前页面内容…</div>
    <div v-else-if="pageContext" class="banner ok">
      已加载页面正文（约 {{ pageContext.text.length }} 字）作为对话上下文。
    </div>

    <!-- 消息列表 -->
    <main class="messages" ref="messagesEl">
      <div v-if="messages.length === 0" class="empty">
        问点关于这个网页的问题吧，比如：
        <ul>
          <li @click="usePrompt('用一句话总结这篇文章')">用一句话总结这篇文章</li>
          <li @click="usePrompt('列出文中的关键论点')">列出文中的关键论点</li>
          <li @click="usePrompt('这篇文章的目标读者是谁？')">这篇文章的目标读者是谁？</li>
        </ul>
      </div>

      <div
        v-for="(m, i) in messages"
        :key="i"
        class="msg"
        :class="m.role"
      >
        <div class="bubble">{{ m.content || '…' }}</div>
      </div>
    </main>

    <!-- 输入区 -->
    <footer class="composer">
      <textarea
        v-model="input"
        class="input"
        rows="1"
        :placeholder="status === 'ready' ? '输入你的问题…' : '请先加载页面内容'"
        :disabled="status !== 'ready'"
        @keydown.enter.exact.prevent="send"
      ></textarea>
      <button class="send-btn" :disabled="streaming || !canSend" @click="send">
        {{ streaming ? '生成中' : '发送' }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import browser from 'webextension-polyfill';
import type { PageContext, GetPageContextResponse } from '@/types/messages';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const pageContext = ref<PageContext | null>(null);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const errorMsg = ref('');
const messages = ref<ChatTurn[]>([]);
const input = ref('');
const streaming = ref(false);
const messagesEl = ref<HTMLElement | null>(null);

const canSend = computed(() => input.value.trim().length > 0 && !!pageContext.value && !streaming.value);

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

function scrollToBottom() {
  nextTick(() => {
    const el = messagesEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function getSourceTabId(): number | undefined {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('sourceTabId');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function loadContext() {
  status.value = 'loading';
  errorMsg.value = '';
  pageContext.value = null;
  try {
    const resp = (await browser.runtime.sendMessage({
      action: 'getPageContext',
      sourceTabId: getSourceTabId(),
    })) as GetPageContextResponse;
    if (resp.success) {
      pageContext.value = resp.context;
      status.value = 'ready';
    } else {
      errorMsg.value = resp.error;
      status.value = 'error';
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '加载失败';
    status.value = 'error';
  }
}

function usePrompt(text: string) {
  input.value = text;
  const ta = document.querySelector('.input') as HTMLTextAreaElement | null;
  ta?.focus();
}

async function send() {
  const question = input.value.trim();
  if (!question || !pageContext.value || streaming.value) return;

  // 把当前问题追加进历史，连同之前的多轮对话一起发给模型
  const history = [
    ...messages.value.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: question },
  ];

  messages.value.push({ role: 'user', content: question });
  // 持有引用，避免 noUncheckedIndexedAccess 下的 undefined 报错
  const assistantTurn: ChatTurn = { role: 'assistant', content: '' };
  messages.value.push(assistantTurn);
  input.value = '';
  streaming.value = true;
  scrollToBottom();

  const port = browser.runtime.connect({ name: 'chat' });
  port.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; text?: string; message?: string };
    if (m.type === 'partial' && typeof m.text === 'string') {
      assistantTurn.content = m.text;
      scrollToBottom();
    } else if (m.type === 'done') {
      streaming.value = false;
      port.disconnect();
      scrollToBottom();
    } else if (m.type === 'error') {
      assistantTurn.content = '⚠️ ' + (m.message || '对话出错');
      streaming.value = false;
      port.disconnect();
      scrollToBottom();
    }
  });
  port.postMessage({ type: 'chat', context: pageContext.value, history });
}

onMounted(loadContext);
</script>

<style scoped>
* {
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

.chat-root {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  /* 适配刘海屏 / 手势条 */
  padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
  background: #f7f8fa;
  color: #1a1a1a;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 15px;
  line-height: 1.6;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  background: #fff;
  border-bottom: 1px solid #ececec;
  flex-shrink: 0;
}

.src {
  min-width: 0;
}

.src-title {
  font-weight: 600;
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60vw;
}

.src-url {
  font-size: 11px;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.reload-btn {
  flex-shrink: 0;
  padding: 7px 12px;
  font-size: 13px;
  border: 1px solid #d9d9d9;
  border-radius: 8px;
  background: #fff;
  color: #409eff;
  cursor: pointer;
  min-height: 36px;
}

.reload-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.banner {
  padding: 8px 12px;
  font-size: 12px;
  background: #eef4ff;
  color: #409eff;
  flex-shrink: 0;
}

.banner.ok {
  background: #f0f9eb;
  color: #67a646;
}

.banner.error {
  background: #fef0f0;
  color: #f56c6c;
}

.banner-hint {
  margin-top: 4px;
  color: #c4564f;
  line-height: 1.4;
}

.messages {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.empty {
  margin: auto;
  color: #999;
  font-size: 13px;
  text-align: center;
}

.empty ul {
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty li {
  background: #fff;
  border: 1px solid #ececec;
  border-radius: 8px;
  padding: 10px 12px;
  color: #409eff;
  cursor: pointer;
  text-align: left;
}

.msg {
  display: flex;
}

.msg.user {
  justify-content: flex-end;
}

.msg.assistant {
  justify-content: flex-start;
}

.bubble {
  max-width: 85%;
  padding: 10px 12px;
  border-radius: 14px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.msg.user .bubble {
  background: #409eff;
  color: #fff;
  border-bottom-right-radius: 4px;
}

.msg.assistant .bubble {
  background: #fff;
  color: #1a1a1a;
  border: 1px solid #ececec;
  border-bottom-left-radius: 4px;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 10px;
  background: #fff;
  border-top: 1px solid #ececec;
  flex-shrink: 0;
}

.input {
  flex: 1;
  resize: none;
  max-height: 120px;
  padding: 10px 12px;
  font-size: 15px;
  line-height: 1.5;
  border: 1px solid #d9d9d9;
  border-radius: 12px;
  outline: none;
  font-family: inherit;
}

.input:focus {
  border-color: #409eff;
}

.input:disabled {
  background: #f5f5f5;
}

.send-btn {
  flex-shrink: 0;
  min-width: 56px;
  min-height: 42px;
  padding: 0 16px;
  border: none;
  border-radius: 12px;
  background: #409eff;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.send-btn:disabled {
  background: #a0cfff;
  cursor: default;
}
</style>
