<template>
  <div class="chat-root">
    <!-- 顶部：页面来源 + 重新加载 -->
    <header class="chat-header">
      <div class="src">
        <div class="src-title">{{ pageContext?.title || '网页对话' }}</div>
        <div class="src-url" v-if="pageContext">{{ shortUrl(pageContext.url) }}</div>
      </div>
      <button class="close-btn" :disabled="status === 'loading'" @click="clearChat" title="清空对话">×</button>
      <button class="reload-btn" :disabled="status === 'loading'" @click="loadContext">
        {{ status === 'loading' ? '加载中…' : '重新加载' }}
      </button>
    </header>

    <!-- KV Cache 命中率指示（多轮时 system 前缀命中缓存，输入 token 大幅下降） -->
    <div v-if="usageText" class="usage-hint">{{ usageText }}</div>

    <!-- 提示条 -->
    <div v-if="status === 'error'" class="banner error">
      {{ errorMsg }}
      <div class="banner-hint">提示：在普通网页（http/https）上打开本页，或在插件设置中填写 DeepSeek API Key。</div>
    </div>
    <div v-else-if="status === 'loading'" class="banner">正在读取当前页面内容…</div>
    <div v-else-if="pageContext" class="banner ok">
      已加载页面正文（约 {{ pageContext.text.length }} 字）作为对话上下文。
    </div>

    <!--
      手动输入上下文：自动读取失败时（Chrome 安全拦截、无 content script、非 http(s) 页等）
      仍能让用户粘贴正文继续对话，实现"任何页面都能聊"。
    -->
    <div v-if="manualMode" class="manual-context">
      <div class="manual-label">无法自动读取本页（可能被 Chrome 屏蔽 / 扩展未授权）。粘贴正文继续对话：</div>
      <textarea
        v-model="manualText"
        class="manual-input"
        rows="6"
        placeholder="粘贴文章正文或要点…（也可粘贴 URL 文本作为参考）"
      ></textarea>
      <button class="manual-btn" :disabled="!manualText.trim()" @click="applyManualContext">用此内容对话</button>
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
      <button
        class="json-toggle"
        :class="{ active: jsonMode }"
        :disabled="streaming"
        :title="jsonMode ? '关闭结构化 JSON 输出' : '开启结构化 JSON 输出'"
        @click="jsonMode = !jsonMode"
      >JSON</button>
      <textarea
        v-model="input"
        class="input"
        rows="1"
        :placeholder="status === 'ready' ? (jsonMode ? '要求以 JSON 形式回答…' : '输入你的问题…') : '请先加载页面内容'"
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
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import browser from 'webextension-polyfill';
import type { PageContext, GetPageContextResponse } from '@/types/messages';
import type { ChatUsage } from '@/entrypoints/service/chat';

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
const jsonMode = ref(false);
const lastUsage = ref<ChatUsage | null>(null);
const currentPort = ref<browser.Runtime.Port | null>(null);
// 手动输入上下文模式：自动读取失败时启用，让用户粘贴正文继续对话
const manualMode = ref(false);
const manualText = ref('');

const canSend = computed(() => input.value.trim().length > 0 && !!pageContext.value && !streaming.value);

/** KV Cache 命中率摘要：多轮对话时 system 前缀命中缓存，命中率越高越省 token。 */
const usageText = computed(() => {
  const u = lastUsage.value;
  if (!u || u.promptTokens === 0) return '';
  const hitRate = Math.round((u.cacheHitTokens / u.promptTokens) * 100);
  return `KV 缓存命中 ${hitRate}% · 输入 ${u.promptTokens} / 命中 ${u.cacheHitTokens}`;
});

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
  manualMode.value = false;
  manualText.value = '';
  try {
    const resp = (await browser.runtime.sendMessage({
      action: 'getPageContext',
      sourceTabId: getSourceTabId(),
    })) as GetPageContextResponse;
    if (resp.success) {
      pageContext.value = resp.context;
      status.value = 'ready';
    } else {
      // 自动读取失败（Chrome 安全拦截 / 无 content script / 非普通网页）→ 启用手动输入兜底
      errorMsg.value = resp.error;
      status.value = 'error';
      manualMode.value = true;
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '加载失败';
    status.value = 'error';
    manualMode.value = true;
  }
}

/** 将用户手动粘贴的内容作为对话上下文，绕过任何"无法读取原页"的情形。 */
function applyManualContext() {
  const text = manualText.value.trim();
  if (!text) return;
  pageContext.value = {
    title: '手动输入的内容',
    url: '',
    text,
  };
  manualMode.value = false;
  manualText.value = '';
  status.value = 'ready';
}

function usePrompt(text: string) {
  input.value = text;
  const ta = document.querySelector('.input') as HTMLTextAreaElement | null;
  ta?.focus();
}

/**
 * 清空当前对话（断开在途流式请求 + 重置消息）。
 * Chrome 侧栏没有"编程关闭" API（由浏览器原生 × 关闭），
 * 所以这里的 × 按钮语义为"清空对话、重新开始"，保持面板常驻、可立即再聊。
 * Firefox 侧栏用 browser.sidebarAction.close() 关闭（见 sidePanel 工具）。
 */
function clearChat() {
  // 先断开对话端口，background 会 abort 在途请求（不再浪费配额）
  disconnectPort();
  messages.value = [];
  input.value = '';
  lastUsage.value = null;
}

/** 断开对话端口（关闭/卸载时调用），让 background 中断在途流式请求。 */
function disconnectPort() {
  const port = currentPort.value;
  if (!port) return;
  currentPort.value = null;
  try {
    // 面板卸载 / 对方断开时 Chrome 已自动断开端口，再次 disconnect 会抛
    // "Illegal invocation: Function must be called on an object of type Port"，
    // 这里吞掉即可（断开已是目标状态，幂等）。
    port.disconnect();
  } catch {
    /* 端口已被 Chrome 自动断开，忽略 */
  }
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
  lastUsage.value = null;
  streaming.value = true;
  scrollToBottom();

  const port = browser.runtime.connect({ name: 'chat' });
  currentPort.value = port;
  port.onMessage.addListener((msg: unknown) => {
    const m = msg as {
      type?: string;
      text?: string;
      message?: string;
      usage?: ChatUsage;
    };
    if (m.type === 'partial' && typeof m.text === 'string') {
      assistantTurn.content = m.text;
      scrollToBottom();
    } else if (m.type === 'usage' && m.usage) {
      // 实时更新缓存命中率（多轮时随 system 前缀命中而升高）
      lastUsage.value = m.usage;
    } else if (m.type === 'done') {
      if (m.usage) lastUsage.value = m.usage;
      streaming.value = false;
      disconnectPort();
      scrollToBottom();
    } else if (m.type === 'error') {
      assistantTurn.content = '⚠️ ' + (m.message || '对话出错');
      streaming.value = false;
      disconnectPort();
      scrollToBottom();
    }
  });
  port.postMessage({ type: 'chat', context: pageContext.value, history, jsonMode: jsonMode.value });
}

onMounted(loadContext);
onUnmounted(disconnectPort);
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

.close-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  min-height: 32px;
  padding: 0;
  font-size: 20px;
  line-height: 1;
  border: 1px solid #d9d9d9;
  border-radius: 50%;
  background: #fff;
  color: #666;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.close-btn:hover {
  background: #f5f5f5;
  color: #1a1a1a;
}
.close-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 嵌入侧栏 iframe 时视口只有 ~380px，挤掉 URL 行避免头栏换行 */
@media (max-width: 480px) {
  .src-url {
    display: none;
  }
  .src-title {
    max-width: 50vw;
  }
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

/* KV Cache 命中率提示条 */
.usage-hint {
  padding: 4px 12px;
  font-size: 11px;
  color: #8a8a8a;
  background: #fafafa;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
  text-align: right;
}

.banner-hint {
  margin-top: 4px;
  color: #c4564f;
  line-height: 1.4;
}

/* 手动输入上下文：自动读取失败时的兜底，保证"任何页面都能聊" */
.manual-context {
  padding: 10px 12px;
  background: #fffbe6;
  border-bottom: 1px solid #ffe58f;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}
.manual-label {
  font-size: 12px;
  color: #ad6800;
  line-height: 1.5;
}
.manual-input {
  width: 100%;
  resize: vertical;
  min-height: 96px;
  max-height: 240px;
  padding: 8px 10px;
  font-size: 14px;
  line-height: 1.5;
  border: 1px solid #ffe58f;
  border-radius: 8px;
  outline: none;
  font-family: inherit;
  background: #fff;
  box-sizing: border-box;
}
.manual-input:focus {
  border-color: #409eff;
}
.manual-btn {
  align-self: flex-end;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: #409eff;
  color: #fff;
  cursor: pointer;
  min-height: 36px;
}
.manual-btn:disabled {
  background: #a0cfff;
  cursor: default;
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

.json-toggle {
  flex-shrink: 0;
  min-width: 44px;
  min-height: 42px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid #d9d9d9;
  border-radius: 12px;
  background: #fff;
  color: #888;
  cursor: pointer;
}

.json-toggle.active {
  border-color: #409eff;
  background: #409eff;
  color: #fff;
}

.json-toggle:disabled {
  opacity: 0.5;
  cursor: default;
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
