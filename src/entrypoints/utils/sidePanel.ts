/**
 * sidePanel.ts — 跨浏览器打开对话侧栏的薄封装。
 *
 * WXT 会把名为 `sidepanel` 的 entrypoint 自动写进 Manifest：
 *   - Chrome MV3  → `side_panel.default_path`
 *   - Firefox MV2 → `sidebar_action.default_path`
 * 所以这里不需要手动改 Manifest，只负责"怎么打开它"。
 *
 * 关键差异：
 *   - Chrome：sidePanel.open({ tabId }) 可以按 tab 打开；还可以用
 *     setOptions({ tabId, path }) 给某个 tab 指定带 query 的面板路径，
 *     这样侧栏能精确"对话那一页"（sourceTabId 通过 URL 传进去）。
 *   - Firefox：sidebarAction 是窗口级、没有 per-tab 路径，open() 打开当前窗口侧栏，
 *     面板内部回退到"当前激活页"。
 */
import browser from 'webextension-polyfill';

interface BrowserWithSidePanel {
  sidePanel?: {
    setOptions(options: {
      tabId?: number;
      windowId?: number;
      path?: string;
      enabled?: boolean;
    }): Promise<void>;
    open(options: { tabId?: number; windowId?: number }): Promise<void>;
  };
}

interface BrowserWithSidebarAction {
  sidebarAction?: {
    open(options?: { windowId?: number }): Promise<void>;
    close(): Promise<void>;
    toggle(): Promise<void>;
  };
}

/** 打开对话侧栏，并让面板精确对话 sourceTabId 这一页（Chrome 有效，Firefox 回退激活页）。 */
export async function openSidePanel(sourceTabId: number): Promise<void> {
  const b = browser as typeof browser & BrowserWithSidePanel & BrowserWithSidebarAction;

  if (b.sidePanel?.open) {
    // Chrome：给该 tab 指定带 sourceTabId 的面板路径，再打开
    try {
      await b.sidePanel.setOptions({
        tabId: sourceTabId,
        path: `sidepanel.html?sourceTabId=${sourceTabId}`,
      });
    } catch {
      /* 个别 Chrome 版本对 per-tab path 较严格，忽略后打开默认面板 */
    }
    try {
      await b.sidePanel.open({ tabId: sourceTabId });
    } catch {
      /* 极端情况：tabId 不可用时退化为窗口级打开 */
      try {
        await b.sidePanel.open({ windowId: (await browser.windows.getCurrent())?.id ?? undefined });
      } catch {
        /* ignore */
      }
    }
    return;
  }

  if (b.sidebarAction?.open) {
    // Firefox：窗口级侧栏，打开当前窗口
    try {
      await b.sidebarAction.open();
    } catch {
      /* ignore */
    }
  }
}

/** 关闭侧栏。Chrome 无编程关闭 API（由浏览器原生 × 关闭），此处主要供 Firefox。 */
export async function closeSidePanel(): Promise<void> {
  const b = browser as typeof browser & BrowserWithSidebarAction;
  if (b.sidebarAction?.close) {
    try {
      await b.sidebarAction.close();
    } catch {
      /* ignore */
    }
  }
}
