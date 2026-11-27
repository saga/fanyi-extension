<template>
  <div class="chat-root">
    <!-- 顶部：页面来源 + 重新加载 -->
    <header class="chat-header">
      <div class="src">
        <div class="src-title">{{ pageContext?.title || '网页对话' }}</div>
        <div class="src-url" v-if="pageContext">{{ shortUrl(pageContext.url) }}</div>
      </div>
      <button class="close-btn" :disabled="status === 'loading'" @click="clearChat" title="清空对话">×</button>
      <button class="reload-btn" :disabled="status === 'loading'" @click="reloadContext">
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
          <span>浏览器控制：自动选择（{{ debuggerPermissionLabel }}）</span>
        </div>
      </section>
    </details>

    <details class="page-control-panel">
      <summary>Page Control <span class="settings-summary">{{ pageControlEnabled ? '已启用' : '已关闭' }} · {{ pageControlSourceLabel }}</span></summary>
      <section class="page-control-content">
        <label class="page-control-master">
          <input v-model="pageControlEnabled" type="checkbox" @change="onPageControlChange" />
          启用当前网页的 Page Control
        </label>
        <p class="page-control-warning">只作用于当前对话来源标签页。网页操作仍采用固定工具和逐次确认，不开放任意 JavaScript / eval。</p>

        <template v-if="pageControlEnabled">
          <div class="page-control-row">
            <label>
              <input v-model="pageDomEnabled" type="checkbox" @change="onPageDomControlChange" />
              网页 DOM 读取与操作
            </label>
            <span>{{ pageDomEnabled ? '已允许' : '关闭' }}</span>
          </div>
          <p class="page-control-help">开启后，Agent 可以按需读取可见内容、查找/高亮文字、滚动和点击页面控件。点击、提交等动作仍需单独批准；不支持任意脚本执行。</p>

          <div class="page-control-row">
            <label>
              <input v-model="pageNetworkEnabled" type="checkbox" @change="onPageNetworkChange" />
              网络请求捕获
            </label>
            <select v-model="pageNetworkMode" :disabled="!pageControlEnabled" @change="onPageNetworkModeChange">
              <option value="auto">自动选择</option>
              <option v-if="!isFirefox" value="cdp">CDP / Debugger</option>
              <option value="webRequest">webRequest</option>
            </select>
          </div>
          <p class="page-control-help">自动模式在 Chromium 优先使用 CDP，失败后降级；Firefox 使用 webRequest。CDP 可读取受支持的文本响应体、WebSocket 帧和 EventSource 消息；Chrome MV3 webRequest 通道主要提供请求元数据和请求体，不提供通用响应体或 WebSocket 帧读取。</p>
          <div class="page-control-permissions">
            <span>当前站点：{{ pagePermissionLabel }}</span>
            <span>Debugger：{{ debuggerPermissionLabel }}</span>
            <span>webRequest：{{ webRequestPermissionLabel }}</span>
            <span>Cookie：{{ cookiePermissionLabel }}</span>
          </div>
          <p v-if="!isFirefox" class="page-control-help">Chrome 的 debugger 是安装期声明权限，不能通过 runtime optional permission 单独弹窗申请；实际 CDP attach/detach 由上面的网络开关控制。</p>

          <div class="page-control-section">
            <strong>当前站点 Cookie（只读）</strong>
            <div class="page-control-actions">
              <button :disabled="!pageContext || cookieLoading" @click="readSiteCookies">{{ cookieLoading ? '读取中…' : cookiePermissionGranted ? '重新读取当前站点 Cookie' : '授权并读取当前站点 Cookie' }}</button>
              <button :disabled="!cookiePermissionGranted" @click="disableCookieAccess">关闭 Cookie 访问</button>
            </div>
            <p class="page-control-help">仅查询当前页面 URL 匹配的 Cookie，包括 HttpOnly Cookie。值默认隐藏，按需逐条显示；数据只在侧栏内存中展示，不写入聊天历史，也不会发送给模型。</p>
            <p v-if="cookieError" class="network-error">{{ cookieError }}</p>
            <div v-if="cookieRecords.length" class="cookie-list">
              <div v-for="cookie in cookieRecords" :key="cookieKey(cookie)" class="cookie-row">
                <div class="cookie-meta">
                  <strong>{{ cookie.name }}</strong>
                  <span>{{ cookie.domain }}{{ cookie.path }}</span>
                  <span>{{ [cookie.httpOnly ? 'HttpOnly' : '', cookie.secure ? 'Secure' : '', cookie.sameSite].filter(Boolean).join(' · ') }}</span>
                </div>
                <code>{{ revealedCookieKeys.has(cookieKey(cookie)) ? cookie.value : '••••••••' }}</code>
                <button @click="toggleCookieReveal(cookie)">{{ revealedCookieKeys.has(cookieKey(cookie)) ? '隐藏' : '显示' }}</button>
              </div>
            </div>
            <p v-else-if="cookiePermissionGranted && !cookieLoading" class="page-control-help">当前页面 URL 没有可读取的 Cookie，或浏览器未返回匹配项。</p>
          </div>

          <div class="page-control-section">
            <strong>完整 DOM 快照</strong>
            <button :disabled="!pageDomEnabled || !pageContext || pageDomLoading" @click="capturePageDom">
              {{ pageDomLoading ? '读取中…' : '读取当前页面 DOM' }}
            </button>
            <p class="page-control-help">读取当前页面 documentElement.outerHTML，最多保留 300 KB；快照可能包含页面中的个人信息，只在侧栏内存中显示，不进入聊天上下文。</p>
            <p v-if="pageDomError" class="network-error">{{ pageDomError }}</p>
            <details v-if="pageDomSnapshot" class="page-dom-preview">
              <summary>查看 DOM（原始 {{ pageDomSnapshot.originalLength }} 字节{{ pageDomSnapshot.truncated ? '，已截断至 300 KB' : '' }}）</summary>
              <pre>{{ pageDomSnapshot.html }}</pre>
            </details>
          </div>

          <div class="page-control-section">
            <strong>页面存储</strong>
            <button :disabled="!pageDomEnabled || !pageContext || pageStorageLoading" @click="capturePageStorage">{{ pageStorageLoading ? '读取中…' : '读取 localStorage / sessionStorage' }}</button>
            <p class="page-control-help">只读取当前页面 Origin 的 localStorage 和当前顶层标签页 sessionStorage。值默认遮蔽，只在侧栏内存中展示；不会保存到历史或发送给模型。</p>
            <p v-if="pageStorageError" class="network-error">{{ pageStorageError }}</p>
            <div v-if="pageStorageSnapshot" class="storage-preview">
              <details>
                <summary>localStorage（{{ pageStorageSnapshot.local.length }} 项）</summary>
                <div v-for="entry in pageStorageSnapshot.local" :key="'local:' + entry.key" class="storage-row">
                  <strong>{{ entry.key }}</strong>
                  <code>{{ revealedStorageKeys.has('local:' + entry.key) ? entry.value : '••••••••' }}</code>
                  <button @click="toggleStorageReveal('local:' + entry.key)">{{ revealedStorageKeys.has('local:' + entry.key) ? '隐藏' : '显示' }}</button>
                </div>
              </details>
              <details>
                <summary>sessionStorage（{{ pageStorageSnapshot.session.length }} 项）</summary>
                <div v-for="entry in pageStorageSnapshot.session" :key="'session:' + entry.key" class="storage-row">
                  <strong>{{ entry.key }}</strong>
                  <code>{{ revealedStorageKeys.has('session:' + entry.key) ? entry.value : '••••••••' }}</code>
                  <button @click="toggleStorageReveal('session:' + entry.key)">{{ revealedStorageKeys.has('session:' + entry.key) ? '隐藏' : '显示' }}</button>
                </div>
              </details>
              <p v-if="pageStorageSnapshot.truncated" class="page-control-help">数据已达到 100 KB 上限并截断。</p>
            </div>
          </div>
        </template>
      </section>
    </details>

    <details class="page-control-panel">
      <summary>Page Control <span class="settings-summary">{{ pageControlEnabled ? '已启用' : '已关闭' }} · {{ pageControlSourceLabel }}</span></summary>
      <section class="page-control-content">
        <label class="page-control-master">
          <input v-model="pageControlEnabled" type="checkbox" @change="onPageControlChange" />
          启用当前网页的 Page Control
        </label>
        <p class="page-control-warning">只作用于当前对话来源标签页。网页操作采用固定工具和逐次确认，不开放任意 JavaScript / eval。</p>
        <p class="page-control-help">此开关控制额外的 Agent 网页操作与数据检查，不撤销翻译功能依赖的基础站点访问权限。扩展可访问哪些网站，仍由浏览器扩展设置中的“站点访问权限”控制。</p>

        <template v-if="pageControlEnabled">
          <div class="page-control-row">
            <label><input v-model="pageDomEnabled" type="checkbox" @change="onPageDomControlChange" /> 网页 DOM 读取与操作</label>
            <span>{{ pageDomEnabled ? '已允许' : '关闭' }}</span>
          </div>
          <p class="page-control-help">开启后，Agent 可以读取可见内容、查找/高亮文字、滚动和点击页面控件。点击等动作仍需单独批准；不支持任意脚本执行。若当前站点访问权限被浏览器设置为“仅点击时”，请在扩展的站点访问设置中允许此站点。</p>

          <div class="page-control-row">
            <label><input v-model="pageNetworkEnabled" type="checkbox" @change="onPageNetworkChange" /> 网络请求捕获</label>
            <select v-model="pageNetworkMode" :disabled="!pageNetworkEnabled || isFirefox" @change="onPageNetworkModeChange">
              <option value="auto">自动选择</option>
              <option value="cdp">CDP / Debugger</option>
              <option value="webRequest">webRequest</option>
            </select>
          </div>
          <p class="page-control-help">自动模式在 Chromium 优先使用 CDP，失败后降级；Firefox 使用 webRequest。CDP 可读取受支持的文本响应体；Chrome MV3 webRequest 备用通道主要提供请求元数据和请求体，不提供通用响应体读取。</p>
          <div class="page-control-permissions">
            <span>Debugger：{{ debuggerPermissionLabel }}</span>
            <span>webRequest：{{ webRequestPermissionLabel }}</span>
            <span>Cookie：{{ cookiePermissionLabel }}</span>
          </div>
          <p v-if="!isFirefox" class="page-control-help">Chrome 的 debugger 是安装期声明权限，不能通过 runtime optional permission 单独弹窗申请；实际 CDP attach/detach 由网络开关控制。</p>

          <div class="page-control-section">
            <strong>当前站点 Cookie</strong>
            <div class="page-control-actions">
              <button :disabled="!pageContext || cookieLoading" @click="readSiteCookies">{{ cookieLoading ? '读取中…' : cookiePermissionGranted ? '重新读取当前站点 Cookie' : '授权并读取当前站点 Cookie' }}</button>
              <button :disabled="!cookiePermissionGranted" @click="disableCookieAccess">关闭 Cookie 访问</button>
            </div>
            <p class="page-control-help">仅查询当前页面 URL 匹配的 Cookie，包括 HttpOnly Cookie。值默认隐藏，按需逐条显示；数据只在侧栏内存中展示，不写入聊天历史，也不会发送给模型。</p>
            <p v-if="cookieError" class="network-error">{{ cookieError }}</p>
            <div v-if="cookieRecords.length" class="cookie-list">
              <div v-for="cookie in cookieRecords" :key="cookieKey(cookie)" class="cookie-row">
                <div class="cookie-meta">
                  <strong>{{ cookie.name }}</strong>
                  <span>{{ cookie.domain }}{{ cookie.path }}</span>
                  <span>{{ [cookie.httpOnly ? 'HttpOnly' : '', cookie.secure ? 'Secure' : '', cookie.sameSite].filter(Boolean).join(' · ') }}</span>
                </div>
                <code>{{ revealedCookieKeys.has(cookieKey(cookie)) ? cookie.value : '••••••••' }}</code>
                <button @click="toggleCookieReveal(cookie)">{{ revealedCookieKeys.has(cookieKey(cookie)) ? '隐藏' : '显示' }}</button>
              </div>
            </div>
            <p v-else-if="cookiePermissionGranted && !cookieLoading" class="page-control-help">当前页面 URL 没有可读取的 Cookie，或浏览器未返回匹配项。</p>
          </div>

          <div class="page-control-section">
            <strong>完整 DOM 快照</strong>
            <button :disabled="!pageDomEnabled || !pageContext || pageDomLoading" @click="capturePageDom">{{ pageDomLoading ? '读取中…' : '读取当前页面 DOM' }}</button>
            <p class="page-control-help">读取当前页面 documentElement.outerHTML，最多保留 300 KB；内容可能包含个人信息，只在侧栏内存中显示，不进入聊天上下文。</p>
            <p v-if="pageDomError" class="network-error">{{ pageDomError }}</p>
            <details v-if="pageDomSnapshot" class="page-dom-preview">
              <summary>查看 DOM（原始 {{ pageDomSnapshot.originalLength }} 字节{{ pageDomSnapshot.truncated ? '，已截断至 300 KB' : '' }}）</summary>
              <pre>{{ pageDomSnapshot.html }}</pre>
            </details>
          </div>
        </template>
      </section>
    </details>

    <details class="network-panel">
      <summary>网络请求 <span class="settings-summary">{{ networkSnapshot.active ? networkModeLabel + ' 采集中' : networkError ? '采集不可用' : '手动关闭' }} · {{ networkSnapshot.requests.length }} 条</span></summary>
      <section class="network-inspector">
        <div class="network-toolbar"><button @click="clearNetworkCapture">清空</button></div>
        <p class="network-help">只在 Page Control 启用并打开“网络请求捕获”后开始。范围限定当前来源标签页；最多保留 150 条请求，每个正文最多 32 KB，并对凭证字段脱敏。浏览器内部/受保护请求仍可能不可见。</p>
        <p v-if="networkError" class="network-error">{{ networkError }}</p>
        <div class="network-list">
          <button v-for="item in networkSnapshot.requests" :key="item.id" @click="selectedNetworkId = item.id" :class="{ selected: selectedNetworkId === item.id }">
            <b>{{ item.method }}</b><span>{{ item.status || item.error || '…' }}</span><span>{{ networkLabel(item.url) }}</span>
          </button>
          <p v-if="!networkSnapshot.requests.length">没有缓存的网络请求。</p>
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

      <section v-if="pendingAgentTool" class="agent-tool-confirm" aria-live="polite">
        <strong>Agent 请求执行浏览器操作</strong>
        <div class="agent-tool-name">{{ agentToolTitle(pendingAgentTool.request) }}</div>
        <p>{{ pendingAgentTool.request.reason }}</p>
        <p class="agent-tool-target">{{ agentToolTarget(pendingAgentTool.request) }}</p>
        <template v-if="pendingAgentTool.request.tool === 'page.click'">
          <p v-if="pendingAgentTool.previewLoading" class="agent-tool-warning">正在读取实际点击目标（不会执行点击）…</p>
          <p v-else-if="pendingAgentTool.previewError" class="agent-tool-error">{{ pendingAgentTool.previewError }}</p>
          <div v-else-if="pendingAgentTool.previewTarget" class="agent-tool-click-preview">
            <strong>实际点击目标</strong>
            <p>{{ pendingAgentTool.previewTarget.tag }} · {{ pendingAgentTool.previewTarget.label || '无可见文字' }}</p>
            <p v-if="pendingAgentTool.previewTarget.href">链接地址：{{ pendingAgentTool.previewTarget.href }}</p>
          </div>
        </template>
        <p class="agent-tool-warning">只有在确认实际目标和影响后才批准。页面点击会再次核对目标，若页面已变化则取消操作。</p>
        <div class="agent-tool-actions">
          <button :disabled="agentToolExecuting || (pendingAgentTool.request.tool === 'page.click' && (pendingAgentTool.previewLoading || !pendingAgentTool.previewTarget))" @click="approveAgentTool">批准并执行</button>
          <button :disabled="agentToolExecuting" @click="rejectAgentTool">拒绝</button>
        </div>
      </section>

      <section v-if="agentToolError" class="agent-tool-error" role="alert">{{ agentToolError }}</section>

      <section v-if="agentCredentialArtifact" class="agent-credential-artifact">
        <strong>{{ agentCredentialArtifact.title }}</strong>
        <p>响应只保存在扩展界面，没有发送给模型。扩展无法验证注册/认证 options 是否由 RP 服务端签发；请只使用可信服务端提供的参数。服务端仍须验证 challenge、origin、RP ID 和签名。</p>
        <details>
          <summary>查看 WebAuthn 响应 JSON</summary>
          <pre>{{ agentCredentialArtifact.json }}</pre>
        </details>
        <button @click="copyAgentCredentialArtifact">{{ agentCredentialCopied ? '已复制' : '复制响应 JSON' }}</button>
      </section>
    </main>

    <!-- 输入区 -->
    <footer class="composer">
      <textarea
        v-model="input"
        enterkeyhint="send"
        autocapitalize="sentences"
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
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import browser from 'webextension-polyfill';
import { isSidebarSupported } from '@/entrypoints/utils/sidePanel';
import type { PageContext, GetPageContextResponse, NetworkCaptureCommandResponse } from '@/types/messages';
import type { NetworkCapturePreference, NetworkCaptureSnapshot, NetworkRequestRecord } from '@/entrypoints/utils/networkCapture';
import { shouldUseJsonMode, type ChatUsage } from '@/entrypoints/service/chat';
import type { AgentToolRequest } from '@/entrypoints/utils/agentToolProtocol';
import { executeAgentToolInExtension, previewAgentPageClick, type AgentToolArtifact } from '@/entrypoints/utils/agentToolExecution';
import type { PageActionResult } from '@/entrypoints/utils/pageScriptExecution';
import { getConfig, setConfig } from '@/entrypoints/utils/config';
import { createChatHistoryKey as historyKey } from './chatHistory';
import { CHAT_API_DEFAULTS, validateChatApiSettings } from '@/entrypoints/service/chatApi';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface PageCookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  session: boolean;
  expirationDate?: number;
  storeId?: string;
}

interface PageDomSnapshot {
  title: string;
  url: string;
  html: string;
  originalLength: number;
  truncated: boolean;
}

interface PageStorageEntry {
  key: string;
  value: string;
}

interface PageStorageSnapshot {
  local: PageStorageEntry[];
  session: PageStorageEntry[];
  truncated: boolean;
}

interface PageCookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  session: boolean;
  expirationDate?: number;
  storeId?: string;
}

interface PageDomSnapshot {
  title: string;
  url: string;
  html: string;
  originalLength: number;
  truncated: boolean;
}

interface PendingAgentTool {
  requestId: string;
  request: AgentToolRequest;
  previewLoading?: boolean;
  previewError?: string;
  previewTarget?: PageActionResult['target'];
}

const pageContext = ref<PageContext | null>(null);
const resolvedSourceTabId = ref<number | undefined>(undefined);
const pageControlEnabled = ref(false);
const pageDomEnabled = ref(false);
const pageNetworkEnabled = ref(false);
const pageNetworkMode = ref<NetworkCapturePreference>('auto');
const cookiePermissionGranted = ref(false);
const cookieLoading = ref(false);
const cookieError = ref('');
const cookieRecords = ref<PageCookieRecord[]>([]);
const revealedCookieKeys = ref<Set<string>>(new Set());
const pageDomLoading = ref(false);
const pageDomError = ref('');
const pageDomSnapshot = ref<PageDomSnapshot | null>(null);
const pageStorageLoading = ref(false);
const pageStorageError = ref('');
const pageStorageSnapshot = ref<PageStorageSnapshot | null>(null);
const revealedStorageKeys = ref<Set<string>>(new Set());
const webRequestPermissionState = ref<'checking' | 'granted' | 'missing' | 'unsupported'>('checking');
const cookiePermissionState = ref<'checking' | 'granted' | 'missing' | 'unsupported'>('checking');
const networkSnapshot = ref<NetworkCaptureSnapshot>({ active: false, tabId: null, startedAt: null, includeBodies: false, mode: null, requests: [] });
const networkError = ref('');
const selectedNetworkId = ref('');
let networkPort: browser.Runtime.Port | null = null;
let networkInspectorEnabled = false;
let networkCaptureStartPromise: Promise<void> | null = null;
let networkCaptureStartTabId: number | null = null;
let agentToolHeartbeatTimer: number | null = null;
const selectedNetworkRequest = computed<NetworkRequestRecord | null>(() => networkSnapshot.value.requests.find((item) => item.id === selectedNetworkId.value) ?? networkSnapshot.value.requests[0] ?? null);
const networkModeLabel = computed(() => {
  const mode = networkSnapshot.value.mode;
  if (mode === 'chromium-cdp') return 'CDP';
  if (mode === 'chromium-webRequest' || mode === 'firefox-webRequest') return 'webRequest';
  return '自动控制';
});
const status = ref<'loading' | 'ready' | 'error'>('loading');
const errorMsg = ref('');
const messages = ref<ChatTurn[]>([]);
const input = ref('');
const streaming = ref(false);
const messagesEl = ref<HTMLElement | null>(null);
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
const pendingAgentTool = ref<PendingAgentTool | null>(null);
const agentToolError = ref('');
const agentToolExecuting = ref(false);
const agentCredentialArtifact = ref<AgentToolArtifact | null>(null);
const agentCredentialCopied = ref(false);


const isMobile = computed(() => window.matchMedia?.('(max-width: 640px)').matches ?? false);
const isFirefox = computed(() => typeof (browser.runtime as any).getBrowserInfo === 'function');
const pageControlSourceLabel = computed(() => {
  try { return pageContext.value?.url ? new URL(pageContext.value.url).host : '无来源页面'; }
  catch { return '无来源页面'; }
});
const webRequestPermissionLabel = computed(() => ({
  checking: '检查中', granted: '已授权', missing: '未授权', unsupported: '不支持',
}[webRequestPermissionState.value]));
const cookiePermissionLabel = computed(() => ({
  checking: '检查中', granted: '已授权', missing: '未授权', unsupported: '不支持',
}[cookiePermissionState.value]));
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
  granted: '当前站点已授权',
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
  if (!networkInspectorEnabled || networkPort) return;
  try {
    const port = browser.runtime.connect({ name: 'network-inspector' });
    networkPort = port;
    port.onMessage.addListener((message: unknown) => {
      const event = message as { type?: string; snapshot?: NetworkCaptureSnapshot };
      if (event.type !== 'snapshot' || !event.snapshot) return;
      networkSnapshot.value = event.snapshot;
      if (!event.snapshot.requests.some((item) => item.id === selectedNetworkId.value)) {
        selectedNetworkId.value = event.snapshot.requests[0]?.id || '';
      }
    });
    port.onDisconnect.addListener(() => {
      if (networkPort !== port) return;
      networkPort = null;
      // Service worker 重启或短暂断连后自动重连；只有用户仍开启网络捕获时才恢复。
      if (networkInspectorEnabled) {
        window.setTimeout(() => {
          if (!networkInspectorEnabled || networkPort) return;
          connectNetworkInspector();
          if (pageControlEnabled.value && pageNetworkEnabled.value) void ensureNetworkCapture();
        }, 800);
      }
    });
  } catch (error) {
    networkError.value = error instanceof Error ? error.message : String(error);
  }
}

/** 网络捕获只在用户从 Page Control 手动打开后启动。 */
async function ensureNetworkCapture() {
  if (!pageControlEnabled.value || !pageNetworkEnabled.value) return;
  const tabId = getCurrentSourceTabId();
  if (tabId == null) return;
  const modeMatches = pageNetworkMode.value === 'auto'
    ? networkSnapshot.value.mode !== null
    : pageNetworkMode.value === 'cdp'
      ? networkSnapshot.value.mode === 'chromium-cdp'
      : networkSnapshot.value.mode === 'chromium-webRequest' || networkSnapshot.value.mode === 'firefox-webRequest';
  if (networkSnapshot.value.active && networkSnapshot.value.tabId === tabId
    && networkSnapshot.value.includeBodies && modeMatches) return;
  if (networkCaptureStartPromise && networkCaptureStartTabId === tabId) return networkCaptureStartPromise;

  networkError.value = '';
  networkCaptureStartTabId = tabId;
  const task = (async () => {
    try {
      const response = await browser.runtime.sendMessage({
        action: 'networkCaptureStart',
        sourceTabId: tabId,
        includeBodies: true,
        preferredMode: pageNetworkMode.value,
      }) as NetworkCaptureCommandResponse;
      if (!response.success) throw new Error(response.error);
      networkSnapshot.value = response.snapshot;
      selectedNetworkId.value = response.snapshot.requests[0]?.id || '';
    } catch (error) {
      networkError.value = error instanceof Error ? error.message : String(error);
      pageNetworkEnabled.value = false;
    }
  })();
  networkCaptureStartPromise = task;
  try {
    await task;
  } finally {
    if (networkCaptureStartPromise === task) {
      networkCaptureStartPromise = null;
      networkCaptureStartTabId = null;
    }
  }
}

async function clearNetworkCapture() {
  try {
    const response = await browser.runtime.sendMessage({ action: 'networkCaptureClear' }) as NetworkCaptureCommandResponse;
    if (!response.success) throw new Error(response.error);
    networkSnapshot.value = response.snapshot;
    selectedNetworkId.value = '';
  } catch (error) {
    networkError.value = error instanceof Error ? error.message : String(error);
  }
}

function normalizePageUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

function cookieKey(cookie: PageCookieRecord): string {
  return [cookie.storeId || '', cookie.domain, cookie.path, cookie.name].join('|');
}

function toggleCookieReveal(cookie: PageCookieRecord) {
  const key = cookieKey(cookie);
  const next = new Set(revealedCookieKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  revealedCookieKeys.value = next;
}

function clearCookieSnapshot() {
  cookieRecords.value = [];
  revealedCookieKeys.value = new Set();
  cookieError.value = '';
}

function clearPageSnapshots() {
  pageDomSnapshot.value = null;
  pageStorageSnapshot.value = null;
  revealedStorageKeys.value = new Set();
  pageDomError.value = '';
  pageStorageError.value = '';
}

function toggleStorageReveal(key: string) {
  const next = new Set(revealedStorageKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  revealedStorageKeys.value = next;
}

async function stopNetworkCapture(revokePermission = true) {
  try {
    const stopped = await browser.runtime.sendMessage({ action: 'networkCaptureStop' }) as NetworkCaptureCommandResponse;
    if (!stopped.success) throw new Error(stopped.error);
    const cleared = await browser.runtime.sendMessage({ action: 'networkCaptureClear' }) as NetworkCaptureCommandResponse;
    if (!cleared.success) throw new Error(cleared.error);
    networkSnapshot.value = cleared.snapshot;
    selectedNetworkId.value = '';
  } catch (error) {
    networkError.value = error instanceof Error ? error.message : String(error);
  }
  if (revokePermission) {
    try {
      if (isFirefox.value) {
        await browser.permissions.remove({ permissions: ['webRequest', 'webRequestBlocking'] });
      } else {
        await browser.permissions.remove({ permissions: ['webRequest'] });
      }
      webRequestPermissionState.value = 'missing';
    } catch {
      /* A browser may refuse to remove a permission declared by another feature. */
    }
  }
}

async function onPageControlChange() {
  if (pageControlEnabled.value) {
    await refreshPermissionStatus();
    return;
  }
  pageDomEnabled.value = false;
  pageNetworkEnabled.value = false;
  clearPageSnapshots();
  await stopNetworkCapture(true);
  await disableCookieAccess();
}

async function onPageDomControlChange() {
  pageDomError.value = '';
  if (!pageDomEnabled.value) {
    clearPageSnapshots();
    return;
  }
  if (!pageControlEnabled.value) {
    pageDomEnabled.value = false;
    pageDomError.value = '请先启用 Page Control。';
  }
}

async function requestNetworkPermissions(): Promise<boolean> {
  if (pageNetworkMode.value === 'cdp') return debuggerPermissionState.value === 'granted';
  try {
    // Must be called directly from the user's Page Control interaction.
    const granted = isFirefox.value
      ? await browser.permissions.request({ permissions: ['webRequest', 'webRequestBlocking'] })
      : await browser.permissions.request({ permissions: ['webRequest'] });
    webRequestPermissionState.value = granted ? 'granted' : 'missing';
    return granted;
  } catch (error) {
    networkError.value = error instanceof Error ? error.message : String(error);
    webRequestPermissionState.value = 'missing';
    return false;
  }
}

async function onPageNetworkChange() {
  if (!pageControlEnabled.value) {
    pageNetworkEnabled.value = false;
    return;
  }
  if (!pageNetworkEnabled.value) {
    await stopNetworkCapture(true);
    return;
  }
  const granted = await requestNetworkPermissions();
  if (!granted) {
    if (!isFirefox.value && pageNetworkMode.value === 'auto' && debuggerPermissionState.value === 'granted') {
      // webRequest is optional; continue with CDP only if its install-time permission exists.
      pageNetworkMode.value = 'cdp';
      await ensureNetworkCapture();
    } else {
      pageNetworkEnabled.value = false;
      networkError.value = '未授予网络捕获所需权限，已保持关闭。';
    }
    return;
  }
  await ensureNetworkCapture();
}

async function onPageNetworkModeChange() {
  if (!pageNetworkEnabled.value || !pageControlEnabled.value) return;
  const granted = await requestNetworkPermissions();
  if (!granted) {
    pageNetworkEnabled.value = false;
    await stopNetworkCapture(true);
    networkError.value = '所选网络通道的权限未获批准。';
    return;
  }
  await ensureNetworkCapture();
}

async function readSiteCookies() {
  const pageUrl = pageContext.value?.url || '';
  const tabId = getCurrentSourceTabId();
  if (!pageControlEnabled.value || !pageUrl || tabId == null) return;

  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Cookie API 仅支持 HTTP(S) 网页。');
    }
  } catch (error) {
    cookieError.value = error instanceof Error ? error.message : String(error);
    return;
  }

  cookieLoading.value = true;
  cookieError.value = '';
  // This must be the first asynchronous browser API call from the click handler.
  try {
    const granted = await browser.permissions.request({ permissions: ['cookies'] });
    if (!granted) throw new Error('未授予 Cookie 访问权限。');
    cookiePermissionGranted.value = true;
    cookiePermissionState.value = 'granted';

    const tab = await browser.tabs.get(tabId);
    if (!tab.url || normalizePageUrl(tab.url) !== normalizePageUrl(pageUrl)) {
      throw new Error('来源标签页已导航到其他地址，请重新加载网页上下文后再读取 Cookie。');
    }
    const hostGranted = await browser.permissions.contains({ origins: [parsed.origin + '/*'] });
    if (!hostGranted) {
      throw new Error('当前站点的访问权限未授予。请在浏览器扩展设置中允许访问此站点。');
    }
    const cookieApi = (browser as any).cookies;
    if (typeof cookieApi?.getAll !== 'function') throw new Error('当前浏览器未提供 Cookies API。');
    const result = await cookieApi.getAll({ url: pageUrl }) as PageCookieRecord[];
    cookieRecords.value = result.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      session: cookie.session,
      expirationDate: cookie.expirationDate,
      storeId: cookie.storeId,
    }));
    revealedCookieKeys.value = new Set();
  } catch (error) {
    cookieError.value = error instanceof Error ? error.message : String(error);
  } finally {
    cookieLoading.value = false;
  }
}

async function disableCookieAccess() {
  clearCookieSnapshot();
  cookiePermissionGranted.value = false;
  try {
    await browser.permissions.remove({ permissions: ['cookies'] });
    cookiePermissionState.value = 'missing';
  } catch (error) {
    cookieError.value = error instanceof Error ? error.message : String(error);
  }
}

async function capturePageDom() {
  const pageUrl = pageContext.value?.url || '';
  const tabId = getCurrentSourceTabId();
  if (!pageControlEnabled.value || !pageDomEnabled.value || !pageUrl || tabId == null) return;

  pageDomLoading.value = true;
  pageDomError.value = '';
  pageDomSnapshot.value = null;
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.url || normalizePageUrl(tab.url) !== normalizePageUrl(pageUrl)) {
      throw new Error('来源标签页已导航，请先重新加载页面上下文。');
    }
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const html = document.documentElement?.outerHTML || '';
        const limit = 300 * 1024;
        const bytes = new TextEncoder().encode(html);
        return {
          title: document.title,
          url: location.href,
          html: bytes.byteLength > limit
            ? new TextDecoder().decode(bytes.subarray(0, limit))
            : html,
          originalLength: bytes.byteLength,
          truncated: bytes.byteLength > limit,
        };
      },
    });
    const snapshot = results[0]?.result as PageDomSnapshot | undefined;
    if (!snapshot) throw new Error('浏览器没有返回 DOM 快照。');
    pageDomSnapshot.value = snapshot;
  } catch (error) {
    pageDomError.value = error instanceof Error ? error.message : String(error);
  } finally {
    pageDomLoading.value = false;
  }
}
function networkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function getSourceTabId(): number | undefined {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('sourceTabId');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Firefox desktop sidebar is window-scoped and has no sourceTabId URL; use the tab selected by background. */
function getCurrentSourceTabId(): number | undefined {
  return resolvedSourceTabId.value ?? getSourceTabId();
}

function reloadContext() {
  void loadContext();
}

async function loadContext(preferredTabId?: number, restoreHistory = true) {
  resolvedSourceTabId.value = preferredTabId ?? getSourceTabId();
  if (networkSnapshot.value.active && networkSnapshot.value.tabId !== resolvedSourceTabId.value) {
    await stopNetworkCapture(false);
  }
  clearCookieSnapshot();
  clearPageSnapshots();
  status.value = 'loading';
  errorMsg.value = '';
  pageContext.value = null;
  manualMode.value = false;
  manualText.value = '';
  try {
    const resp = (await browser.runtime.sendMessage({
      action: 'getPageContext',
      sourceTabId: preferredTabId ?? getSourceTabId(),
    })) as GetPageContextResponse;
    if (resp.success) {
      pageContext.value = resp.context;
      resolvedSourceTabId.value = resp.tabId ?? getSourceTabId();
      clearCookieSnapshot();
      clearPageSnapshots();
      void refreshPermissionStatus();
      void ensureNetworkCapture();
      // Firefox's desktop sidebar has no sourceTabId query parameter. Once
      // background resolves the active page, try restoring that tab's history.
      const restored = restoreHistory ? await loadHistory() : false;
      status.value = 'ready';
      if (!restored) void saveHistory();
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
  const sid = getCurrentSourceTabId();
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
  const sid = getCurrentSourceTabId();
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
    void refreshPermissionStatus();
    void ensureNetworkCapture();
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
  pendingAgentTool.value = null;
  agentToolError.value = '';
  agentCredentialArtifact.value = null;
  agentCredentialCopied.value = false;
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
function stopAgentToolHeartbeat() {
  if (agentToolHeartbeatTimer != null) {
    window.clearInterval(agentToolHeartbeatTimer);
    agentToolHeartbeatTimer = null;
  }
}

function startAgentToolHeartbeat(port: browser.Runtime.Port) {
  stopAgentToolHeartbeat();
  agentToolHeartbeatTimer = window.setInterval(() => {
    if (currentPort.value !== port) {
      stopAgentToolHeartbeat();
      return;
    }
    try {
      // Sending a message (rather than merely keeping a Port open) renews
      // activity for MV3 service workers while the user reviews the request.
      port.postMessage({ type: 'tool_heartbeat' });
    } catch {
      stopAgentToolHeartbeat();
    }
  }, 20000);
}

function disconnectPort() {
  stopAgentToolHeartbeat();
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
  const jsonMode = shouldUseJsonMode(question);
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
    stopAgentToolHeartbeat();
    currentPort.value = null;
    if (streaming.value) {
      pendingAgentTool.value = null;
      agentToolExecuting.value = false;
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
      requestId?: string;
      request?: AgentToolRequest;
    };
    if (m.type === 'tool_request' && typeof m.requestId === 'string' && m.request) {
      const pending: PendingAgentTool = {
        requestId: m.requestId,
        request: m.request,
        ...(m.request.tool === 'page.click' ? { previewLoading: true } : {}),
      };
      pendingAgentTool.value = pending;
      startAgentToolHeartbeat(port);
      assistantTurn.content = '等待确认浏览器操作：' + agentToolTitle(m.request);
      scrollToBottom();
      if (m.request.tool === 'page.click') void prepareAgentToolPreview(pending);
    } else if (m.type === 'partial' && typeof m.text === 'string') {
      assistantTurn.content = m.text;
      scrollToBottom();
    } else if (m.type === 'usage' && m.usage) {
      // 实时更新缓存命中率（多轮时随 system 前缀命中而升高）
      lastUsage.value = m.usage;
    } else if (m.type === 'done') {
      if (m.usage) lastUsage.value = m.usage;
      stopAgentToolHeartbeat();
      pendingAgentTool.value = null;
      streaming.value = false;
      disconnectPort();
      void saveHistory();
      scrollToBottom();
    } else if (m.type === 'error') {
      assistantTurn.content = '⚠️ ' + (m.message || '对话出错');
      stopAgentToolHeartbeat();
      pendingAgentTool.value = null;
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
    jsonMode,
    backend: chatBackend.value,
    model: chatModel.value.trim(),
    thinkingMode: chatThinkingMode.value,
    effort: chatEffort.value,
    skillIds: chatSkillIds.value,
    remoteServiceToken: remoteServiceToken.value.trim(),
    pageControlEnabled: pageControlEnabled.value && pageDomEnabled.value,
  });
}

function agentToolTitle(request: AgentToolRequest): string {
  const labels: Record<AgentToolRequest['tool'], string> = {
    'page.inspect': '读取页面可见内容',
    'page.find': '查找页面文字',
    'page.highlight': '定位并选中文字',
    'page.scroll': '滚动到页面元素',
    'page.click': '点击页面按钮或链接',
    'browser.containers.list': '读取 Firefox 容器列表',
    'browser.containers.open': '在 Firefox 容器中打开标签页',
    'webauthn.capability': '检查 Passkey 支持情况',
    'webauthn.create': '创建 Passkey',
    'webauthn.get': '使用 Passkey 认证',
  };
  return labels[request.tool];
}

function agentToolTarget(request: AgentToolRequest): string {
  const args = request.arguments;
  switch (request.tool) {
    case 'page.inspect': return args.selector ? `CSS selector：${String(args.selector)}` : '当前来源页面的可见正文';
    case 'page.find':
    case 'page.highlight': return `文字：${String(args.text)}`;
    case 'page.scroll': return `CSS selector：${String(args.selector)}`;
    case 'page.click': return `请求匹配 CSS selector：${String(args.selector)}`;
    case 'browser.containers.list': return '读取容器名称、颜色和图标，不读取 Cookie 内容';
    case 'browser.containers.open': return `容器：${String(args.identityName)}；URL：${String(args.url)}`;
    case 'webauthn.capability': return '检查当前浏览器扩展页面的 WebAuthn API 和版本支持';
    case 'webauthn.create': {
      const options = args.options as any;
      const user = options?.user || {};
      return `RP ID：${String(options?.rp?.id || '')}；账户：${String(user.displayName || user.name || '未提供账户名称')}；使用服务端注册 challenge`;
    }
    case 'webauthn.get': return `RP ID：${String((args.options as any)?.rpId || '')}；使用已提供的服务端认证 challenge`;
  }
  return '';
}

async function prepareAgentToolPreview(pending: PendingAgentTool) {
  const tabId = getCurrentSourceTabId();
  if (tabId == null) {
    if (pendingAgentTool.value?.requestId === pending.requestId) {
      pendingAgentTool.value.previewLoading = false;
      pendingAgentTool.value.previewError = '没有可用的来源标签页，无法预览点击目标';
    }
    return;
  }
  try {
    const result = await previewAgentPageClick(
      tabId,
      String(pending.request.arguments.selector),
      pageContext.value?.url || undefined,
      browser,
    );
    if (pendingAgentTool.value?.requestId !== pending.requestId) return;
    pendingAgentTool.value.previewLoading = false;
    if (!result.ok || !result.target) {
      pendingAgentTool.value.previewError = result.message || '无法确认实际点击目标，已禁止执行';
    } else {
      pendingAgentTool.value.previewTarget = result.target;
    }
  } catch (error) {
    if (pendingAgentTool.value?.requestId !== pending.requestId) return;
    pendingAgentTool.value.previewLoading = false;
    pendingAgentTool.value.previewError = error instanceof Error ? error.message : String(error);
  }
}

async function waitForTabComplete(tabId: number, timeoutMs = 20000): Promise<void> {
  const current = await browser.tabs.get(tabId);
  if (current.status === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutId: number | undefined;
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
      browser.tabs.onUpdated.removeListener(listener as any);
      if (error) reject(error);
      else resolve();
    };
    browser.tabs.onUpdated.addListener(listener as any);
    timeoutId = window.setTimeout(() => finish(new Error('等待新标签页加载超时')), timeoutMs);
    // Re-check after registering to avoid missing a fast completion event.
    void browser.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

async function approveAgentTool() {
  const pending = pendingAgentTool.value;
  const port = currentPort.value;
  if (!pending || !port || agentToolExecuting.value) return;
  if (pending.request.tool.startsWith('page.')
    && (!pageControlEnabled.value || !pageDomEnabled.value)) {
    stopAgentToolHeartbeat();
    pendingAgentTool.value = null;
    port.postMessage({
      type: 'tool_result',
      requestId: pending.requestId,
      approved: false,
      summary: 'Page Control 的网页 DOM 读取/操作能力当前处于关闭状态。请先在 Page Control 中启用后再请求页面工具。',
    });
    return;
  }
  agentToolExecuting.value = true;
  agentToolError.value = '';
  try {
    // This is called directly from the user's click. WebAuthn and optional
    // permission requests need the transient user-activation context.
    const outcome = await executeAgentToolInExtension(
      pending.request,
      getCurrentSourceTabId(),
      browser,
      pageContext.value?.url || undefined,
      pending.previewTarget,
    );
    if (outcome.sourceTabId != null) {
      // The tab was created inside a Firefox container. Make it the new chat target
      // and refresh the page context before allowing subsequent tools in this turn.
      resolvedSourceTabId.value = outcome.sourceTabId;
      try {
        await waitForTabComplete(outcome.sourceTabId);
        // Keep the in-flight conversation in memory; do not replace it with
        // another tab's persisted chat history while this turn is awaiting tools.
        await loadContext(outcome.sourceTabId, false);
      } catch (error) {
        agentToolError.value = error instanceof Error ? error.message : String(error);
      }
    }
    if (outcome.artifact) {
      agentCredentialArtifact.value = outcome.artifact;
      agentCredentialCopied.value = false;
    }
    if (currentPort.value === port) {
      port.postMessage({
        type: 'tool_result',
        requestId: pending.requestId,
        approved: true,
        summary: outcome.summary,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentToolError.value = message;
    if (currentPort.value === port) {
      port.postMessage({
        type: 'tool_result',
        requestId: pending.requestId,
        approved: true,
        summary: '工具已获用户批准，但执行失败：' + message,
      });
    }
  } finally {
    stopAgentToolHeartbeat();
    pendingAgentTool.value = null;
    agentToolExecuting.value = false;
  }
}

function rejectAgentTool() {
  const pending = pendingAgentTool.value;
  const port = currentPort.value;
  if (!pending || !port || agentToolExecuting.value) return;
  stopAgentToolHeartbeat();
  pendingAgentTool.value = null;
  port.postMessage({
    type: 'tool_result',
    requestId: pending.requestId,
    approved: false,
    summary: '用户拒绝执行该操作。不要再次请求相同操作。',
  });
}

async function copyAgentCredentialArtifact() {
  if (!agentCredentialArtifact.value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(agentCredentialArtifact.value.json);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = agentCredentialArtifact.value.json;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      if (!copied) throw new Error('当前浏览器不支持复制，请展开后手动复制 JSON');
    }
    agentCredentialCopied.value = true;
  } catch (error) {
    agentToolError.value = error instanceof Error ? error.message : String(error);
  }
}

async function refreshPermissionStatus() {
  pagePermissionState.value = 'checking';
  debuggerPermissionState.value = 'checking';
  webRequestPermissionState.value = 'checking';
  cookiePermissionState.value = 'checking';
  try {
    debuggerPermissionState.value = isFirefox.value
      ? 'unsupported'
      : await browser.permissions.contains({ permissions: ['debugger'] }) ? 'granted' : 'missing';
    webRequestPermissionState.value = await browser.permissions.contains({ permissions: ['webRequest'] })
      ? 'granted' : 'missing';
    cookiePermissionState.value = await browser.permissions.contains({ permissions: ['cookies'] })
      ? 'granted' : 'missing';
    cookiePermissionGranted.value = cookiePermissionState.value === 'granted';

    const tabId = getCurrentSourceTabId();
    const tab = tabId == null ? null : await browser.tabs.get(tabId).catch(() => null);
    const rawUrl = tab?.url || pageContext.value?.url || '';
    if (!rawUrl) return;

    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol === 'file:') {
      pagePermissionState.value = 'unknown';
      chatOptionsError.value = '读取本地文件还需要在扩展详情页开启“允许访问文件网址”。';
    } else if (pageUrl.protocol === 'http:' || pageUrl.protocol === 'https:') {
      pagePermissionState.value = await browser.permissions.contains({
        origins: [pageUrl.origin + '/*'],
        permissions: ['scripting'],
      }) ? 'granted' : 'missing';
    } else {
      pagePermissionState.value = 'unknown';
      chatOptionsError.value = '当前是浏览器内部或扩展页面，浏览器可能禁止扩展读取其内容。';
    }
  } catch {
    pagePermissionState.value = 'unknown';
    if (debuggerPermissionState.value === 'checking') debuggerPermissionState.value = 'unknown';
    if (webRequestPermissionState.value === 'checking') webRequestPermissionState.value = 'unsupported';
    if (cookiePermissionState.value === 'checking') cookiePermissionState.value = 'unsupported';
  }
}


async function capturePageStorage() {
  const pageUrl = pageContext.value?.url || '';
  const tabId = getCurrentSourceTabId();
  if (!pageControlEnabled.value || !pageDomEnabled.value || !pageUrl || tabId == null) return;

  pageStorageLoading.value = true;
  pageStorageError.value = '';
  pageStorageSnapshot.value = null;
  try {
    const expectedUrl = normalizePageUrl(pageUrl);
    const tab = await browser.tabs.get(tabId);
    if (!tab.url || normalizePageUrl(tab.url) !== expectedUrl) {
      throw new Error('来源标签页已导航，请先重新加载页面上下文。');
    }
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const limit = 100 * 1024;
        let used = 0;
        let truncated = false;
        const readStorage = (storage: Storage): Array<{ key: string; value: string }> => {
          const items: Array<{ key: string; value: string }> = [];
          for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (key === null) continue;
            const value = storage.getItem(key) ?? '';
            const bytes = new TextEncoder().encode(key + value).byteLength;
            if (used + bytes > limit) {
              truncated = true;
              break;
            }
            used += bytes;
            items.push({ key, value });
          }
          return items;
        };
        try {
          return {
            local: readStorage(window.localStorage),
            session: readStorage(window.sessionStorage),
            truncated,
          };
        } catch (error) {
          return {
            local: [],
            session: [],
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
    const result = results[0]?.result as (PageStorageSnapshot & { error?: string }) | undefined;
    if (!result) throw new Error('浏览器没有返回页面存储数据。');
    if (result.error) throw new Error(result.error);
    pageStorageSnapshot.value = {
      local: result.local,
      session: result.session,
      truncated: result.truncated,
    };
    revealedStorageKeys.value = new Set();
  } catch (error) {
    pageStorageError.value = error instanceof Error ? error.message : String(error);
  } finally {
    pageStorageLoading.value = false;
  }
}

function syncVisualViewport() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--chat-viewport-height', `${Math.round(height)}px`);
}

onMounted(async () => {
  networkInspectorEnabled = true;
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
  networkInspectorEnabled = false;
  clearCookieSnapshot();
  clearPageSnapshots();
  stopAgentToolHeartbeat();
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

  /* 移动端输入区保持输入框与发送按钮可见，不会溢出视口。 */
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
  /* 窄屏下允许输入框与发送按钮换行，避免发送按钮跑到视口外。 */
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px max(8px, env(safe-area-inset-bottom));
  background: #fff;
  border-top: 1px solid #ececec;
  flex-shrink: 0;
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
.page-control-panel { border-bottom: 1px solid #ececec; max-height: min(55dvh, 520px); overflow: auto; }
.page-control-panel > summary { padding: 9px 12px; cursor: pointer; font-size: 13px; font-weight: 600; }
.page-control-content { padding: 0 12px 12px; }
.page-control-master, .page-control-row { display: flex; align-items: center; gap: 8px; min-height: 36px; font-size: 12px; color: #262626; }
.page-control-master { font-weight: 600; border-bottom: 1px solid #f0f0f0; }
.page-control-row { justify-content: space-between; flex-wrap: wrap; }
.page-control-row label { display: inline-flex; align-items: center; gap: 7px; }
.page-control-row select { min-width: 130px; max-width: 48%; padding: 5px 7px; border: 1px solid #d9d9d9; border-radius: 6px; background: #fff; }
.page-control-row span { color: #8c8c8c; font-size: 11px; }
.page-control-warning { margin: 7px 0; color: #ad6800; font-size: 11px; }
.page-control-help { margin: 5px 0 8px; color: #8c8c8c; font-size: 11px; line-height: 1.5; }
.page-control-permissions { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 5px 0 8px; color: #595959; font-size: 11px; }
.page-control-section { margin-top: 10px; padding-top: 9px; border-top: 1px solid #f0f0f0; }
.page-control-section > strong { display: block; margin-bottom: 7px; font-size: 12px; }
.page-control-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.page-control-actions button, .page-control-section > button { padding: 5px 9px; border: 1px solid #d9d9d9; border-radius: 6px; background: #fff; color: #262626; font-size: 11px; }
.page-control-actions button:disabled, .page-control-section > button:disabled { opacity: .5; }
.cookie-list { max-height: 180px; overflow: auto; border: 1px solid #eee; border-radius: 6px; }
.cookie-row { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr) auto; align-items: center; gap: 7px; padding: 7px; border-bottom: 1px solid #f3f3f3; }
.cookie-meta { min-width: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
.cookie-meta strong { font-size: 11px; }
.cookie-meta span { color: #999; font-size: 10px; }
.cookie-row code { overflow-wrap: anywhere; color: #595959; font-size: 10px; }
.cookie-row button { padding: 4px 6px; border: 1px solid #d9d9d9; border-radius: 5px; background: #fff; font-size: 10px; }
.page-dom-preview { margin-top: 7px; }
.page-dom-preview > summary { cursor: pointer; font-size: 11px; color: #595959; }
.page-dom-preview pre { max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 10px; background: #fafafa; border: 1px solid #eee; padding: 8px; }
.storage-preview { margin-top: 7px; }
.storage-preview details { margin-top: 6px; border: 1px solid #eee; border-radius: 6px; }
.storage-preview summary { padding: 6px 8px; cursor: pointer; font-size: 11px; }
.storage-row { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr) auto; align-items: center; gap: 7px; padding: 6px 8px; border-top: 1px solid #f3f3f3; }
.storage-row strong { min-width: 0; overflow-wrap: anywhere; font-size: 10px; }
.storage-row code { min-width: 0; overflow-wrap: anywhere; color: #595959; font-size: 10px; }
.storage-row button { padding: 3px 6px; border: 1px solid #d9d9d9; border-radius: 5px; background: #fff; font-size: 10px; }
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
.agent-tool-confirm, .agent-credential-artifact { margin: 8px 0; padding: 12px; border: 1px solid #91caff; border-radius: 10px; background: #f0f7ff; color: #1f1f1f; }
.agent-tool-confirm strong, .agent-credential-artifact strong { display: block; font-size: 13px; }
.agent-tool-name { margin-top: 6px; font-weight: 600; }
.agent-tool-confirm p, .agent-credential-artifact p { margin: 6px 0; font-size: 12px; line-height: 1.5; }
.agent-tool-target { overflow-wrap: anywhere; color: #444; }
.agent-tool-click-preview { margin: 8px 0; padding: 8px; border: 1px solid #d9d9d9; border-radius: 7px; background: #fff; overflow-wrap: anywhere; }
.agent-tool-click-preview strong { font-size: 12px; }
.agent-tool-click-preview p { margin: 4px 0; }

.agent-tool-warning { color: #ad6800; }
.agent-tool-actions { display: flex; gap: 8px; margin-top: 10px; }
.agent-tool-actions button, .agent-credential-artifact button { border: 1px solid #1677ff; border-radius: 6px; padding: 6px 12px; background: #1677ff; color: #fff; cursor: pointer; }
.agent-tool-actions button:last-child { background: #fff; color: #595959; border-color: #d9d9d9; }
.agent-tool-actions button:disabled { opacity: .55; cursor: default; }
.agent-tool-error { margin: 8px 0; padding: 8px 10px; border: 1px solid #ffccc7; border-radius: 8px; color: #cf1322; background: #fff2f0; font-size: 12px; }
.agent-credential-artifact details { margin: 8px 0; }
.agent-credential-artifact pre { max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 10px; background: #fff; border: 1px solid #e8e8e8; padding: 8px; }

</style>
