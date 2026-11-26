export type BrowserFamily = 'firefox' | 'chromium' | 'unknown';
export type RuntimePlatform = 'desktop' | 'android' | 'ios' | 'unknown';
export interface BrowserCapabilities {
  browser: BrowserFamily; platform: RuntimePlatform;
  pageDomModification: boolean; scriptInjection: boolean; mainWorldExecution: boolean;
  nonActiveTabAccess: boolean; webRequest: boolean; responseBodyCapture: boolean;
  webAuthnExtensionRpId: 'supported-by-version' | 'unknown';
  contextualIdentities: boolean; firefoxPageObjectBridge: boolean;
}
export function detectBrowserCapabilities(browserApi: any = (globalThis as any).browser, chromeApi: any = (globalThis as any).chrome, userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): BrowserCapabilities {
  const firefox = !!browserApi?.runtime?.getBrowserInfo || /Firefox\//i.test(userAgent);
  const chromium = !firefox && (!!chromeApi?.runtime?.id || /Chrome\//i.test(userAgent));
  const scripting = !!(browserApi?.scripting?.executeScript || chromeApi?.scripting?.executeScript);
  const firefoxMajor = Number(userAgent.match(/Firefox\/(\d+)/i)?.[1] ?? 0);
  const mainWorld = scripting && (!firefox || firefoxMajor >= 128);
  return {
    browser: firefox ? 'firefox' : chromium ? 'chromium' : 'unknown',
    platform: /Android/i.test(userAgent) ? 'android' : /iPhone|iPad|iPod/i.test(userAgent) ? 'ios' : userAgent ? 'desktop' : 'unknown',
    pageDomModification: scripting || !!browserApi?.tabs?.executeScript,
    scriptInjection: scripting || !!browserApi?.tabs?.executeScript,
    mainWorldExecution: mainWorld,
    nonActiveTabAccess: !!browserApi?.tabs?.get && !!browserApi?.tabs?.sendMessage,
    webRequest: !!browserApi?.webRequest,
    responseBodyCapture: typeof browserApi?.webRequest?.filterResponseData === 'function',
    webAuthnExtensionRpId: firefox || chromium ? 'supported-by-version' : 'unknown',
    contextualIdentities: !!browserApi?.contextualIdentities,
    firefoxPageObjectBridge: firefox,
  };
}
export async function requestContextualIdentities(browserApi: any = (globalThis as any).browser): Promise<boolean> {
  try {
    if (browserApi?.permissions?.contains && !(await browserApi.permissions.contains({ permissions: ['contextualIdentities'] }))) {
      if (!browserApi.permissions.request || !(await browserApi.permissions.request({ permissions: ['contextualIdentities'] }))) return false;
    }
    return !!browserApi?.contextualIdentities?.query;
  } catch { return false; }
}
