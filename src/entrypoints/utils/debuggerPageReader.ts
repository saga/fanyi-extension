/**
 * Chrome Debugger API 的页面 HTML 兜底读取器。
 *
 * 仅在 Content Script 与 scripting.executeScript 都无法提供正文时使用。
 * attach 后只执行只读 Runtime.evaluate，拿到 HTML 后立即 detach。
 * Firefox 不实现 debugger API；浏览器内部页面仍由浏览器自身策略拦截。
 */

type Debuggee = { tabId: number };

interface ChromeDebuggerApi {
  attach(target: Debuggee, requiredVersion: string): Promise<void>;
  sendCommand(target: Debuggee, method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  detach(target: Debuggee): Promise<void>;
}

interface RuntimeEvaluateResponse {
  result?: {
    type?: string;
    value?: unknown;
  };
  exceptionDetails?: unknown;
}

/**
 * 接受 API 对象作为参数，便于在不启动真实 Chrome 的情况下测试 attach/evaluate/detach 生命周期。
 */
export async function readPageHtmlWithDebugger(
  api: ChromeDebuggerApi | undefined,
  tabId: number,
): Promise<string | null> {
  if (!api || !Number.isInteger(tabId) || tabId < 0) return null;

  const target: Debuggee = { tabId };
  let attached = false;
  try {
    await api.attach(target, '1.3');
    attached = true;

    const response = await api.sendCommand(target, 'Runtime.evaluate', {
      expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
      returnByValue: true,
      awaitPromise: true,
    }) as RuntimeEvaluateResponse | undefined;

    if (response?.exceptionDetails) return null;
    const html = response?.result?.value;
    return typeof html === 'string' && html.length > 0 ? html : null;
  } catch {
    // Debugger may be unavailable, blocked by policy, or already attached by DevTools/another extension.
    return null;
  } finally {
    if (attached) {
      try {
        await api.detach(target);
      } catch {
        // Detach is best-effort; never mask the extraction result.
      }
    }
  }
}

/** Chrome-only API; Firefox has no chrome.debugger implementation. */
export async function getPageHtmlViaDebugger(tabId: number): Promise<string | null> {
  const chromeApi = (globalThis as typeof globalThis & {
    chrome?: { debugger?: ChromeDebuggerApi };
  }).chrome;
  return readPageHtmlWithDebugger(chromeApi?.debugger, tabId);
}
