export interface PageScriptExecutionResult<T = unknown> { tabId: number; frameId?: number; result?: T }
/** Invoke only from explicit extension UI. Never pass page text or model output as source. */
export async function executePageScript<T = unknown>(tabId: number, source: string, browserApi: any = (globalThis as any).browser, chromeApi: any = (globalThis as any).chrome): Promise<PageScriptExecutionResult<T>> {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab ID');
  if (!source.trim()) throw new Error('Script is empty');
  const scripting = chromeApi?.scripting ?? browserApi?.scripting;
  let supportsMainWorld = !!scripting?.executeScript;
  if (browserApi?.runtime?.getBrowserInfo) {
    try {
      const info = await browserApi.runtime.getBrowserInfo();
      const major = Number.parseInt(String(info.version).split('.')[0], 10);
      supportsMainWorld = supportsMainWorld && Number.isFinite(major) && major >= 128;
    } catch { supportsMainWorld = false; }
  }
  if (supportsMainWorld) {
    const results = await scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (code: string) => (0, eval)(code),
      args: [source],
    });
    const first = results?.[0];
    return { tabId, frameId: first?.frameId, result: first?.result as T };
  }
  if (browserApi?.tabs?.executeScript) {
    const results = await browserApi.tabs.executeScript(tabId, {
      code: '(function(){ return (0, eval)(' + JSON.stringify(source) + '); })()',
      runAt: 'document_idle',
    });
    return { tabId, result: results?.[0] as T };
  }
  throw new Error('This browser does not expose a script injection API');
}
