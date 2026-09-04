/**
 * chatSidebar.ts
 *
 * 把"用本页内容对话"渲染为内容页内嵌的侧边栏，而不是新开一个 tab。
 * 实现：
 *   - 在 document.body 注入一个 host 元素（带 shadow DOM 隔离页面 CSS）
 *   - 内部放一个 iframe，加载 chat.html?sourceTabId=<tabId>
 *   - 桌面：右侧 380px 面板，页面正文在左侧继续可见
 *   - 移动端 (≤768px)：100vw 全屏覆盖
 *
 * 关闭侧边栏通过 closeChatSidebar() 移除 host 元素。
 * 该函数由 content.ts 监听 runtime.onMessage 触发，
 * 也可由 chat.html 通过 tabs.sendMessage 触发（见 chat/App.vue 的关闭按钮）。
 */
import browser from 'webextension-polyfill';

const HOST_ID = 'fanyi-chat-sidebar-host';

const SHADOW_STYLES = `
  :host {
    /* 用 all:initial 把页面通用选择器（* { display:none } 等）的影响清掉，
       再显式声明我们需要的属性。shadow DOM 内的 :host 规则会盖过 light DOM
       对 host 元素的样式，这是 Web 标准的隔离模式。 */
    all: initial;
    display: block;
    position: fixed;
    top: 0;
    right: 0;
    width: 380px;
    max-width: 90vw;
    height: 100vh;
    height: 100dvh;
    z-index: 2147483647;
    background: #fff;
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    box-shadow: -2px 0 16px rgba(0, 0, 0, 0.12);
    overflow: hidden;
    pointer-events: auto;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #fff;
  }
  /* 移动端：侧栏变全屏聊天面板，去掉阴影 */
  @media (max-width: 768px) {
    :host {
      width: 100vw;
      max-width: 100vw;
      box-shadow: none;
    }
  }
  /* 窄屏 (<=420px，比如侧栏模式下的 chat.html iframe) 隐藏 URL 行避免拥挤 */
  @media (max-width: 420px) {
    :host { font-size: 14px; }
  }
`;

/**
 * 注入聊天侧边栏。如果已经存在则把焦点切回 iframe（切换页面上下文时复用）。
 */
export function openChatSidebar(sourceTabId: number): void {
  if (!document.body) return;

  const existing = document.getElementById(HOST_ID);
  if (existing) {
    const iframe = existing.shadowRoot?.querySelector('iframe') as HTMLIFrameElement | null;
    iframe?.focus();
    return;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  // host 元素本身是 light DOM，可能被页面 CSS 影响。
  // 把关键定位属性用 inline style 设上，作为 :host 规则加载前的兜底。
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.right = '0';
  host.style.zIndex = '2147483647';

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = SHADOW_STYLES;
  shadow.appendChild(styleEl);

  const iframe = document.createElement('iframe');
  iframe.src = browser.runtime.getURL('chat.html') + `?sourceTabId=${sourceTabId}`;
  iframe.title = 'Chat with this page';
  // 让 chat.html 能读写剪贴板（用户复制答案/粘贴）
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  shadow.appendChild(iframe);

  document.body.appendChild(host);
}

/** 移除聊天侧边栏。无副作用：不存在时直接返回。 */
export function closeChatSidebar(): void {
  const host = document.getElementById(HOST_ID);
  if (host) host.remove();
}

/** 当前页面是否已经打开了侧边栏。供 SPA 导航时判断。 */
export function isChatSidebarOpen(): boolean {
  return document.getElementById(HOST_ID) != null;
}
