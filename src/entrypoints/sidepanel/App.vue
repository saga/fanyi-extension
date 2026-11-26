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

    <!-- 对话执行配置独立于网页/文档翻译配置；远端调用 Vocal Saga Cloud，本地调用 local-agent-service。 -->
    <details class="chat-settings" :open="!isMobile">
      <summary>模型与权限 <span class="settings-summary">{{ backendSummary }} · {{ pagePermissionLabel }}{{ chatConfigIssues.length ? ' · 配置未完成' : '' }}</span></summary>
      <section class="chat-controls">
        <label>执行服务
          <select v-model="chatBackend" :disabled="streaming" @change="onBackendChange">
            <option value="remote">Vocal Saga 远端服务</option>
            <option value="workbuddy">本地 Workbuddy</option>
            <option value="opencode">本地 OpenCode</option>
            <option value="api">直接调用模型 API</option>
          </select>
        </label>
        <template v-if="chatBackend === 'api'">
          <label>API Provider
            <select v-model="chatProvider" :disabled="streaming" @change="onApiProviderChange">
              <option value="deepseek">DeepSeek</option>
              <option value="gemini">Google Gemini</option>
              <option value="openai">OpenAI</option>
              <option value="compatible">OpenAI-compatible</option>
            </select>
          </label>
          <label class="wide-field">API Base URL
            <input v-model="chatApiBaseUrl" :disabled="streaming" autocomplete="url" spellcheck="false" placeholder="https://api.example.com/v1" @change="saveChatSettings" />
          </label>
          <label class="wide-field">API Key
            <input v-model="chatApiKey" type="password" :disabled="streaming" autocomplete="off" placeholder="输入 API Key" @change="saveChatSettings" />
          </label>
        </template>
        <label>模型 ID
          <input v-model="chatModel" list="chat-model-options" :disabled="streaming" placeholder="输入模型 ID" @change="saveChatSettings" />
          <datalist id="chat-model-options">
            <option v-for="model in availableModels" :key="model.id" :value="model.id" />
          </datalist>
        </label>
        <label>思考模式
          <select v-model="chatThinkingMode" :disabled="streaming" @change="saveChatSettings">
            <option value="disabled">关闭</option>
            <option value="adaptive">自适应</option>
            <option value="enabled">开启</option>
          </select>
        </label>
        <label>思考强度
          <select v-model="chatEffort" :disabled="streaming" @change="saveChatSettings">
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
            <option value="xhigh">极高</option>
          </select>
        </label>
        <label v-if="chatBackend === 'remote'" class="wide-field">远端服务 Token
          <input v-model="remoteServiceToken" type="password" autocomplete="off" placeholder="Vocal Saga AUTH_KEY" @change="onRemoteTokenChange" />
        </label>
        <label v-if="chatBackend !== 'remote' && chatBackend !== 'api' && availableSkills.length" class="wide-field">Agent Skills（服务端）
          <select v-model="chatSkillIds" multiple :disabled="streaming" @change="saveChatSettings">
            <option v-for="skill in availableSkills" :key="skill.id" :value="skill.id">{{ skill.name }}</option>
          </select>
        </label>
        <div class="permission-status">
          <span>网站访问：{{ pagePermissionLabel }}</span>
          <span>Debugger：{{ debuggerPermissionLabel }}</span>
        </div>
      </section>
    </details>

    <details class="network-panel">
      <summary>网络请求 <span class="settings-summary">{{ networkSnapshot.active ? '采集中' : '已停止' }} · {{ networkSnapshot.requests.length }} 条</span></summary>
      <section class="network-inspector">
        <div class="network-toolbar">
          <button :disabled="networkSnapshot.active" @click="startNetworkCapture">开始</button>
          <button :disabled="!networkSnapshot.active" @click="stopNetworkCapture">停止</button>
          <button @click="clearNetworkCapture">清空</button>
          <label><input v-model="networkIncludeBodies" type="checkbox" :disabled="networkSnapshot.active" /> 捕获正文</label>
        </div>
        <p class="network-help">仅捕获当前对话来源标签页。正文捕获默认关闭；开启后仅保留小体积文本/JSON，敏感字段脱敏。</p>
        <p v-if="networkError" class="network-error">{{ networkError }}</p>
        <div class="network-list">
          <button v-for="item in networkSnapshot.requests" :key="item.id" @click="selectedNetworkId = item.id" :class="{ selected: selectedNetworkId === item.id }">
            <b>{{ item.method }}</b><span>{{ item.status || item.error || '…' }}</span><span>{{ networkLabel(item.url) }}</span>
          </button>
          <p v-if="!networkSnapshot.requests.length">暂无请求。开始捕获后，在网页中执行操作。</p>
        </div>
        <pre v-if="selectedNetworkRequest">{{ JSON.stringify(selectedNetworkRequest, null, 2) }}</pre>
      </section>
    </details>

    <div v-if="chatConfigIssues.length" class="banner config-warning" role="alert">
      对话配置未完成：{{ chatConfigIssues.join('；') }}
    </div>
    <div v-if="chatOptionsError" class="banner config-error" role="alert">{{ chatOptionsError }}</div>

    <!-- KV Cache 命中率指示（多轮时 system 前缀命中缓存，输入 token 大幅下降） -->
    <div v-if="usageText" class="usage-hint">{{ usageText }}</div>

    <!-- 提示条 -->
    <div v-if="status === 'error'" class="banner error">
      {{ errorMsg }}
      <div class="banner-hint">请检查所选执行服务、模型配置及远端 Token / 本机 local-agent-service 是否可用。</div>
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
      <div class="manual-label">
        无法自动读取本页。扩展会依次尝试 Content Script、Scripting 和 Chrome Debugger。
        浏览器内部页面、扩展页面、Chrome Web Store 和浏览器 PDF 查看器仍可能被浏览器禁止读取；
        本地文件还需要在扩展详情中开启“允许访问文件网址”。
        <span v-if="pagePermissionState === 'missing'">当前扩展尚未获得全站访问权限，请在扩展管理页将网站访问设置为“所有网站”。</span>
      </div>
      <div class="manual-label">也可以粘贴正文继续对话：</div>
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
        enterkeyhint="send"
        autocapitalize="sentences"
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
import { isSidebarSupported } from '@/entrypoints/utils/sidePanel';
import type { PageContext, GetPageContextResponse, NetworkCaptureCommandResponse } from '@/types/messages';
import type { NetworkCaptureSnapshot, NetworkRequestRecord } from '@/entrypoints/utils/networkCapture';
import type { ChatUsage } from '@/entrypoints/service/chat';
import { getConfig, setConfig } from '@/entrypoints/utils/config';
import { createChatHistoryKey as historyKey } from './chatHistory';
import { CHAT_API_DEFAULTS, validateChatApiSettings } from '@/entrypoints/service/chatApi';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const pageContext = ref<PageContext | null>(null);
const networkSnapshot = ref<NetworkCaptureSnapshot>({ active: false, tabId: null, startedAt: null, includeBodies: false, mode: null, requests: [] });
const networkIncludeBodies = ref(false);
const networkError = ref('');
const selectedNetworkId = ref('');
let networkPort: browser.Runtime.Port | null = null;
const selectedNetworkRequest = computed<NetworkRequestRecord | null>(() => networkSnapshot.value.requests.find((item) => item.id === selectedNetworkId.value) ?? networkSnapshot.value.requests[0] ?? null);
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
const chatBackend = ref<'remote' | 'workbuddy' | 'opencode' | 'api'>('remote');
const chatProvider = ref<'deepseek' | 'gemini' | 'openai' | 'compatible'>('deepseek');
const chatApiBaseUrl = ref('');
const chatApiKey = ref('');
const previousApiProvider = ref<'deepseek' | 'gemini' | 'openai' | 'compatible'>('deepseek');
const pagePermissionState = ref<'checking' | 'granted' | 'missing' | 'unknown'>('checking');
const debuggerPermissionState = ref<'checking' | 'granted' | 'missing' | 'unsupported' | 'unknown'>('checking');
const chatModel = ref('');
const chatThinkingMode = ref<'disabled' | 'adaptive' | 'enabled'>('adaptive');
const chatEffort = ref<'low' | 'medium' | 'high' | 'xhigh'>('medium');
const chatSkillIds = ref<string[]>([]);
const remoteServiceToken = ref('');
const availableModels = ref<Array<{ id: string }>>([]);
const availableSkills = ref<Array<{ id: string; name: string; description: string }>>([]);
const chatOptionsError = ref('');


const isMobile = computed(() => window.matchMedia?.('(max-width: 640px)').matches ?? false);
const backendSummary = computed(() => chatBackend.value === 'api'
  ? `${chatProvider.value} · ${chatModel.value || '未选择模型'}`
  : chatBackend.value === 'remote' ? 'Vocal Saga' : chatBackend.value === 'workbuddy' ? 'Workbuddy' : chatBackend.value === 'opencode' ? 'OpenCode' : '模型 API');
const chatConfigIssues = computed(() => {
  if (chatBackend.value === 'api') {
    return validateChatApiSettings({
      provider: chatProvider.value,
      baseUrl: chatApiBaseUrl.value,
      apiKey: chatApiKey.value,
      model: chatModel.value,
    });
  }
  if (chatBackend.value === 'remote') return remoteServiceToken.value.trim() ? [] : ['尚未填写 Vocal Saga 远端服务 Token'];
  return [];
});
const pagePermissionLabel = computed(() => ({
  checking: '检查中',
  granted: '所有网站',
  missing: '未获得全站访问权限',
  unknown: '浏览器受限页面 / 未知',
}[pagePermissionState.value]));
const debuggerPermissionLabel = computed(() => ({
  checking: '检查中', granted: '已授权', missing: '未授权', unsupported: 'Firefox 不支持', unknown: '无法确认',
}[debuggerPermissionState.value]));
const canSend = computed(() => input.value.trim().length > 0 && !!pageContext.value && !streaming.value);

/** KV Cache 命中率摘要：多轮对话时 system 前缀命中缓存，命中率越高越省 token。 */
const usageText = computed(() => {
  const u = lastUsage.value;
  if (!u || u.promptTokens === 0) return '';
  const hitRate = Math.round((u.cacheHitTokens / u.promptTokens) * 100);
  return `KV 缓存命中 ${hitRate}% · 输入 ${u.promptTokens} / 命中 ${u.cacheHitTokens}`;
});


async function saveChatSettings() {
  try {
    await setConfig({
      chatBackend: chatBackend.value,
      chatProvider: chatProvider.value,
      chatApiBaseUrl: chatApiBaseUrl.value.trim(),
      chatApiKey: chatApiKey.value.trim(),
      chatModel: chatModel.value.trim(),
      chatThinkingMode: chatThinkingMode.value,
      chatEffort: chatEffort.value,
      chatSkillIds: [...chatSkillIds.value],
      remoteServiceToken: remoteServiceToken.value.trim(),
    });
  } catch (error) {
    chatOptionsError.value = error instanceof Error ? error.message : '保存对话设置失败';
  }
}

async function loadChatOptions() {
  const config = await getConfig();
  chatBackend.value = config.chatBackend || 'remote';
  chatProvider.value = config.chatProvider || 'deepseek';
  previousApiProvider.value = chatProvider.value;
  const savedApiBaseUrl = config.chatApiBaseUrl || '';
  chatApiBaseUrl.value = chatProvider.value === 'deepseek' && savedApiBaseUrl === 'https://api.deepseek.com/v1'
    ? CHAT_API_DEFAULTS.deepseek.baseUrl
    : savedApiBaseUrl || CHAT_API_DEFAULTS[chatProvider.value].baseUrl;
  chatApiKey.value = config.chatApiKey || '';
  const savedModel = config.chatModel || '';
  const obsoleteDefaultModel = (chatProvider.value === 'deepseek' && ['deepseek-chat', 'deepseek-v4-flash'].includes(savedModel))
    || (chatProvider.value === 'gemini' && savedModel === 'gemini-2.5-flash');
  chatModel.value = chatBackend.value === 'api'
    ? (!savedModel || obsoleteDefaultModel ? CHAT_API_DEFAULTS[chatProvider.value].model : savedModel)
    : savedModel;
  chatThinkingMode.value = config.chatThinkingMode || 'adaptive';
  chatEffort.value = config.chatEffort || 'medium';
  chatSkillIds.value = config.chatSkillIds || [];
  remoteServiceToken.value = config.remoteServiceToken || '';
  await refreshChatOptions();
}

async function refreshChatOptions() {
  availableModels.value = [];
  availableSkills.value = [];
  chatOptionsError.value = '';
  try {
    if (chatBackend.value === 'api') {
      const defaults = CHAT_API_DEFAULTS[chatProvider.value];
      availableModels.value = defaults.model ? [{ id: defaults.model }] : [];
      return;
    }
    if (chatBackend.value === 'remote') {
      const config = await getConfig();
      const token = remoteServiceToken.value.trim() || config.remoteServiceToken;
      const base = new URL(config.serverUrl || 'https://s.sunxiunan.com/fanyi/page');
      const response = await fetch(new URL('/api/v1/models', base), {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      if (!response.ok) throw new Error('Vocal Saga 模型目录请求失败：HTTP ' + response.status);
      const data = await response.json() as { data?: Array<{ id?: string }> };
      availableModels.value = (data.data || []).filter((item): item is { id: string } => typeof item.id === 'string');
    } else {
      const config = await getConfig();
      const base = (config.localAgentUrl || 'http://127.0.0.1:8789').replace(/\/+$/, '');
      const headers: Record<string, string> = config.localAgentToken ? { Authorization: 'Bearer ' + config.localAgentToken } : {};
      const [capabilityResponse, skillResponse] = await Promise.all([
        fetch(base + '/api/agent/capabilities', { headers }),
        fetch(base + '/api/agent/skills', { headers }),
      ]);
      if (!capabilityResponse.ok) throw new Error('本机 Agent 能力目录请求失败：HTTP ' + capabilityResponse.status);
      if (!skillResponse.ok) throw new Error('本机 Agent Skill 目录请求失败：HTTP ' + skillResponse.status);
      const capabilities = await capabilityResponse.json() as { providers?: Array<{ id: string; models?: Array<{ id: string }> }> };
      const skills = await skillResponse.json() as { skills?: Array<{ id: string; name: string; description: string }> };
      const provider = capabilities.providers?.find((item) => item.id === chatBackend.value);
      availableModels.value = provider?.models || [];
      availableSkills.value = skills.skills || [];
      if (chatSkillIds.value.some((id) => !availableSkills.value.some((skill) => skill.id === id))) {
        chatSkillIds.value = chatSkillIds.value.filter((id) => availableSkills.value.some((skill) => skill.id === id));
      }
    }
  } catch (error) {
    chatOptionsError.value = error instanceof Error ? error.message : String(error);
  }
}

async function onRemoteTokenChange() {
  await saveChatSettings();
  await refreshChatOptions();
}

async function onBackendChange() {
  if (chatBackend.value === 'api') {
    const defaults = CHAT_API_DEFAULTS[chatProvider.value];
    chatModel.value = defaults.model;
    chatApiBaseUrl.value = defaults.baseUrl;
  } else {
    chatModel.value = '';
  }
  await saveChatSettings();
  await refreshChatOptions();
}

async function onApiProviderChange() {
  const previousDefaults = CHAT_API_DEFAULTS[previousApiProvider.value];
  const nextDefaults = CHAT_API_DEFAULTS[chatProvider.value];
  if (!chatApiBaseUrl.value || chatApiBaseUrl.value === previousDefaults.baseUrl) {
    chatApiBaseUrl.value = nextDefaults.baseUrl;
  }
  if (!chatModel.value || chatModel.value === previousDefaults.model) {
    chatModel.value = nextDefaults.model;
  }
  previousApiProvider.value = chatProvider.value;
  await saveChatSettings();
  await refreshChatOptions();
}

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

function connectNetworkInspector() {
  const port = browser.runtime.connect({ name: 'network-inspector' });
  networkPort = port;
  port.onMessage.addListener((message: unknown) => {
    const event = message as { type?: string; snapshot?: NetworkCaptureSnapshot };
    if (event.type !== 'snapshot' || !event.snapshot) return;
    networkSnapshot.value = event.snapshot;
    if (!event.snapshot.requests.some((item) => item.id === selectedNetworkId.value)) selectedNetworkId.value = event.snapshot.requests[0]?.id || '';
  });
  port.onDisconnect.addListener(() => { if (networkPort === port) networkPort = null; });
}
async function startNetworkCapture() {
  networkError.value = '';
  try {
    const response = await browser.runtime.sendMessage({ action: 'networkCaptureStart', sourceTabId: getSourceTabId(), includeBodies: networkIncludeBodies.value }) as NetworkCaptureCommandResponse;
    if (!response.success) throw new Error(response.error);
    networkSnapshot.value = response.snapshot;
    selectedNetworkId.value = response.snapshot.requests[0]?.id || '';
  } catch (error) { networkError.value = error instanceof Error ? error.message : String(error); }
}
async function stopNetworkCapture() {
  try { const response = await browser.runtime.sendMessage({ action: 'networkCaptureStop' }) as NetworkCaptureCommandResponse; if (!response.success) throw new Error(response.error); networkSnapshot.value = response.snapshot; }
  catch (error) { networkError.value = error instanceof Error ? error.message : String(error); }
}
async function clearNetworkCapture() {
  try { const response = await browser.runtime.sendMessage({ action: 'networkCaptureClear' }) as NetworkCaptureCommandResponse; if (!response.success) throw new Error(response.error); networkSnapshot.value = response.snapshot; selectedNetworkId.value = ''; }
  catch (error) { networkError.value = error instanceof Error ? error.message : String(error); }
}
function networkLabel(url: string): string { try { const parsed = new URL(url); return parsed.host + parsed.pathname + parsed.search; } catch { return url; } }

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
      void saveHistory();
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
  void saveHistory();
}

const HISTORY_PREFIX = 'chatHistory:';

function historyStore() {
  return (browser.storage as { session?: typeof browser.storage } & typeof browser.storage).session ?? browser.storage;
}

/** 把当前对话存到 session；同一 tab 的不同 URL 使用不同记录。 */
async function saveHistory() {
  const sid = getSourceTabId();
  const context = pageContext.value;
  if (sid == null || !context) return;
  const store = historyStore();
  try {
    await store.set({
      [historyKey(sid, context.url)]: {
        pageContext: context,
        messages: messages.value.map((m) => ({ role: m.role, content: m.content })),
        usage: lastUsage.value,
        savedAt: Date.now(),
      },
    });
  } catch {
    /* storage 不可用时忽略 */
  }
}

/** 仅恢复当前标签页当前 URL 的历史，绝不把上一页面的对话带到新页面。 */
async function loadHistory(): Promise<boolean> {
  const sid = getSourceTabId();
  if (sid == null) return false;
  const store = historyStore();
  try {
    const tab = await browser.tabs.get(sid);
    const url = tab.url || '';
    const key = historyKey(sid, url);
    const result = (await store.get(key)) as Record<string, any> | undefined;
    const data = result?.[key];
    if (data && Array.isArray(data.messages) && data.messages.length > 0
      && data.pageContext && historyKey(sid, data.pageContext.url || '') === key) {
      pageContext.value = data.pageContext as PageContext;
      messages.value = data.messages as ChatTurn[];
      lastUsage.value = (data.usage as ChatUsage) ?? null;
      return true;
    }

    // 兼容升级前按 tabId 保存的历史，但必须先核对 URL，避免跨页面串话。
    const legacyKey = HISTORY_PREFIX + sid;
    const legacyResult = (await store.get(legacyKey)) as Record<string, any> | undefined;
    const legacy = legacyResult?.[legacyKey];
    if (legacy?.pageContext && historyKey(sid, legacy.pageContext.url || '') === key
      && Array.isArray(legacy.messages) && legacy.messages.length > 0) {
      pageContext.value = legacy.pageContext as PageContext;
      messages.value = legacy.messages as ChatTurn[];
      lastUsage.value = (legacy.usage as ChatUsage) ?? null;
      await store.set({ [key]: legacy });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** 初始化：先读当前页面对应的历史；没有匹配记录才重新提取正文。 */
async function initChat() {
  const restored = await loadHistory();
  if (restored && pageContext.value) {
    status.value = 'ready';
  } else {
    await loadContext();
  }
}

function usePrompt(text: string) {
  input.value = text;
  const ta = document.querySelector('.input') as HTMLTextAreaElement | null;
  ta?.focus();
}

/**
 * 清空当前对话（断开在途流式请求 + 重置消息）。
 * - 桌面侧栏（Chrome sidePanel / Firefox sidebarAction）：浏览器原生 × 关闭面板，
 *   这里的 × 语义为"清空对话、重新开始"，保持面板常驻、可立即再聊。
 * - 移动端（Firefox Android，无侧栏）：对话以标签页打开，× 直接关掉该标签页，
 *   否则会留一个空白标签。Chrome 侧栏下 tabs.getCurrent() 返回 undefined，不会误关。
 */
async function clearChat() {
  // 先断开对话端口，background 会 abort 在途请求（不再浪费配额）
  disconnectPort();
  messages.value = [];
  input.value = '';
  lastUsage.value = null;
  void saveHistory();

  // 不支持侧栏的环境（Firefox Android 等）：聊天是独立标签页，× 关掉它
  if (!isSidebarSupported()) {
    try {
      const tab = await browser.tabs.getCurrent();
      if (tab?.id != null) {
        await browser.tabs.remove(tab.id);
        return;
      }
    } catch {
      /* 关闭失败（如权限/竞态）则保持页面，用户可手动关标签或点"重新加载" */
    }
  }
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
  if (chatConfigIssues.value.length) {
    chatOptionsError.value = '请先补全配置：' + chatConfigIssues.value.join('；');
    return;
  }
  chatOptionsError.value = '';
  if (chatBackend.value === 'api') {
    try {
      const endpoint = new URL(chatApiBaseUrl.value.trim() || CHAT_API_DEFAULTS[chatProvider.value].baseUrl);
      const originPattern = `${endpoint.protocol}//${endpoint.host}/*`;
      // 主机权限由 Manifest 的 <all_urls> 统一授予；不再在发送消息时逐个申请 API 域名。
      const granted = await browser.permissions.contains({ origins: [originPattern] });
      if (!granted) {
        chatOptionsError.value = `扩展尚未获得全站访问权限，无法访问模型 API 主机：${endpoint.host}。请在扩展管理页将网站访问设置为“所有网站”。`;
        return;
      }
    } catch (error) {
      chatOptionsError.value = error instanceof Error ? error.message : '无法检查模型 API 主机权限';
      return;
    }
  }

  // 确保刚刚编辑的 Provider / API Key / Model 已写入 storage，再由 background 读取。
  await saveChatSettings();

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
  port.onDisconnect.addListener(() => {
    // Background service worker 重启或端口意外断开时，不能让 UI 永久停留在生成中。
    if (currentPort.value !== port) return;
    currentPort.value = null;
    if (streaming.value) {
      assistantTurn.content = assistantTurn.content || '⚠️ 对话连接意外中断，请重试。';
      streaming.value = false;
      void saveHistory();
    }
  });
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
      void saveHistory();
      scrollToBottom();
    } else if (m.type === 'error') {
      assistantTurn.content = '⚠️ ' + (m.message || '对话出错');
      streaming.value = false;
      disconnectPort();
      void saveHistory();
      scrollToBottom();
    }
  });
  port.postMessage({
    type: 'chat',
    context: pageContext.value,
    history,
    jsonMode: jsonMode.value,
    backend: chatBackend.value,
    model: chatModel.value.trim(),
    thinkingMode: chatThinkingMode.value,
    effort: chatEffort.value,
    skillIds: chatSkillIds.value,
    remoteServiceToken: remoteServiceToken.value.trim(),
  });
}

async function refreshPermissionStatus() {
  pagePermissionState.value = 'checking';
  debuggerPermissionState.value = 'checking';
  try {
    const firefox = /Firefox\//i.test(navigator.userAgent);
    if (firefox) {
      debuggerPermissionState.value = 'unsupported';
    } else {
      debuggerPermissionState.value = await browser.permissions.contains({ permissions: ['debugger'] })
        ? 'granted'
        : 'missing';
    }

    // 全站权限在 Manifest 中统一声明，安装/升级时由浏览器一次性授予。
    pagePermissionState.value = await browser.permissions.contains({ origins: ['<all_urls>'] })
      ? 'granted'
      : 'missing';

    const tabId = getSourceTabId();
    const tab = tabId == null ? null : await browser.tabs.get(tabId).catch(() => null);
    const rawUrl = tab?.url || pageContext.value?.url || '';
    if (!rawUrl) return;

    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol === 'file:') {
      pagePermissionState.value = 'unknown';
      chatOptionsError.value = '读取本地文件还需要在扩展详情页开启“允许访问文件网址”。';
    } else if (pageUrl.protocol !== 'http:' && pageUrl.protocol !== 'https:') {
      pagePermissionState.value = 'unknown';
      chatOptionsError.value = '当前是浏览器内部或扩展页面，浏览器可能禁止扩展读取其内容。';
    }
  } catch {
    pagePermissionState.value = 'unknown';
    if (debuggerPermissionState.value === 'checking') debuggerPermissionState.value = 'unknown';
  }
}

function syncVisualViewport() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--chat-viewport-height', `${Math.round(height)}px`);
}

onMounted(async () => {
  connectNetworkInspector();
  syncVisualViewport();
  window.visualViewport?.addEventListener('resize', syncVisualViewport);
  window.visualViewport?.addEventListener('scroll', syncVisualViewport);
  window.addEventListener('resize', syncVisualViewport);
  // 模型目录不可用不应阻塞正文加载和基础对话。
  void loadChatOptions().catch((error) => { chatOptionsError.value = error instanceof Error ? error.message : String(error); });
  void refreshPermissionStatus();
  await initChat();
});
onUnmounted(() => {
  try { networkPort?.disconnect(); } catch { /* already disconnected */ }
  networkPort = null;
  window.visualViewport?.removeEventListener('resize', syncVisualViewport);
  window.visualViewport?.removeEventListener('scroll', syncVisualViewport);
  window.removeEventListener('resize', syncVisualViewport);
  document.documentElement.style.removeProperty('--chat-viewport-height');
  disconnectPort();
});
</script>

<style scoped>
* {
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

.chat-root {
  display: flex;
  flex-direction: column;
  height: var(--chat-viewport-height, 100dvh);
  min-height: 0;
  overflow: hidden;
  /* 适配刘海屏 / 手势条 */
  padding: env(safe-area-inset-top) 0 0;
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
  color: #1677ff;
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
  .close-btn {
    width: 40px;
    height: 40px;
    min-height: 40px;
  }
  .reload-btn { min-height: 40px; }
  .src-title {
    max-width: 50vw;
  }

  /* 移动端输入区：压缩两侧固定控件的占位，让"输入框 + 发送"尽量保持同一行；
     发送按钮独占一行时靠 wrap 兜底，不会溢出视口。 */
  .json-toggle {
    min-width: 40px;
    min-height: 44px;
    padding: 0 6px;
    font-size: 11px;
  }
  .send-btn {
    min-width: 48px;
    min-height: 44px;
    padding: 0 10px;
    font-size: 14px;
  }
  .input {
    padding: 9px 10px;
    font-size: 15px;
  }
}


.chat-settings {
  flex: 0 0 auto;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
}
.chat-settings > summary {
  min-height: 42px;
  padding: 9px 12px;
  color: #262626;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.chat-settings > summary::-webkit-details-marker { display: none; }
.settings-summary {
  min-width: 0;
  color: #8c8c8c;
  font-size: 11px;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 12px;
  padding: 10px 12px 12px;
  background: #fff;
}
.chat-controls label {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  min-width: 150px;
  color: #595959;
  font-size: 12px;
  flex: 1 1 170px;
}
.chat-controls .wide-field { flex-basis: 100%; }
.chat-controls select,
.chat-controls input {
  width: 100%;
  min-width: 0;
  max-width: none;
  height: 36px;
  padding: 6px 10px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  background: #fff;
  color: #262626;
  font: inherit;
}
.chat-controls select:focus,
.chat-controls input:focus {
  border-color: #1677ff;
  outline: 2px solid rgb(22 119 255 / 12%);
}
.chat-controls select[multiple] { height: 76px; }
.chat-config-warning {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  color: #ad6800;
  background: #fffbe6;
  border: 1px solid #ffe58f;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
}
.chat-options-error {
  flex-basis: 100%;
  color: #cf1322;
  font-size: 12px;
  line-height: 1.5;
}
.permission-status {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  color: #8c8c8c;
  font-size: 11px;
}
.permission-status button {
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid #91caff;
  border-radius: 6px;
  background: #e6f4ff;
  color: #0958d9;
  font-size: 12px;
}
@media (max-width: 640px) {
  .chat-settings:not([open]) { flex-shrink: 0; }
  .chat-settings[open] .chat-controls {
    max-height: min(48dvh, 360px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .chat-controls label { flex-basis: 100%; }
}

.banner {
  padding: 8px 12px;
  font-size: 12px;
  background: #eef4ff;
  color: #1677ff;
  flex-shrink: 0;
}

.banner.config-warning {
  background: #fffbe6;
  color: #ad6800;
}
.banner.config-error {
  background: #fff2f0;
  color: #cf1322;
}

.banner.ok {
  background: #f6ffed;
  color: #52c41a;
}

.banner.error {
  background: #fef0f0;
  color: #ff4d4f;
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
  border-color: #1677ff;
}
.manual-btn {
  align-self: flex-end;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: #1677ff;
  color: #fff;
  cursor: pointer;
  min-height: 36px;
}
.manual-btn:disabled {
  background: #91caff;
  cursor: default;
}

.messages {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
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
  color: #1677ff;
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
  background: #1677ff;
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
  /* 允许换行：窄屏（Firefox Android 聊天以标签页打开）下 JSON / 输入框 / 发送
     三个控件挤在一行会超出视口，导致发送按钮跑到屏幕外。wrap 保证控件不越界。 */
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px max(8px, env(safe-area-inset-bottom));
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
  border-color: #1677ff;
  background: #1677ff;
  color: #fff;
}

.json-toggle:disabled {
  opacity: 0.5;
  cursor: default;
}

.input {
  flex: 1;
  /* min-width:0 是关键：flex 项默认 min-width:auto = min-content，而 textarea
     的 min-content 约为 cols 默认值（20 字符）。移动端窄屏下这个下限 + 两侧固定
     按钮会超过视口宽度，把发送按钮挤出屏幕。归零后输入框可收缩，按钮回到屏内。 */
  min-width: 0;
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
  border-color: #1677ff;
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
  background: #1677ff;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.send-btn:disabled {
  background: #91caff;
  cursor: default;
}
.network-panel { border-bottom: 1px solid #ececec; max-height: min(45dvh, 420px); overflow: auto; }
.network-panel > summary { padding: 9px 12px; cursor: pointer; font-size: 13px; font-weight: 600; }
.network-inspector { padding: 0 10px 10px; }
.network-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.network-toolbar button { padding: 5px 10px; border: 1px solid #d9d9d9; border-radius: 6px; background: #fff; }
.network-toolbar label, .network-help { font-size: 11px; color: #8c8c8c; }
.network-list { max-height: 150px; overflow: auto; border: 1px solid #eee; }
.network-list button { width: 100%; display: grid; grid-template-columns: 48px 55px minmax(0,1fr); gap: 6px; padding: 6px; border: 0; border-bottom: 1px solid #f3f3f3; text-align: left; background: #fff; font-size: 11px; }
.network-list button.selected { background: #e6f4ff; }
.network-list button span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.network-list p, .network-error { padding: 6px; font-size: 11px; }
.network-error { color: #cf1322; }
.network-inspector pre { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 10px; background: #fafafa; padding: 8px; }
</style>
