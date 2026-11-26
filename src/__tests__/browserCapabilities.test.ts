import { describe, expect, it, vi } from 'vitest';
import { detectBrowserCapabilities, requestContextualIdentities } from '../entrypoints/utils/browserCapabilities';
import { hasContextualIdentities, listContextualIdentities, createTabInIdentity } from '../entrypoints/utils/contextualIdentities';
import { executePageScript } from '../entrypoints/utils/pageScriptExecution';
import { getWebAuthnCapability, getWebAuthnClientOrigin } from '../entrypoints/utils/webAuthn';

describe('cross-browser capability adapters', () => {
  it('detects Firefox Android without assuming desktop-only APIs', () => {
    const caps = detectBrowserCapabilities({ runtime: { getBrowserInfo: vi.fn() }, tabs: { get: vi.fn(), sendMessage: vi.fn() }, webRequest: { filterResponseData: vi.fn() } }, {}, 'Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0');
    expect(caps.browser).toBe('firefox');
    expect(caps.platform).toBe('android');
    expect(caps.nonActiveTabAccess).toBe(true);
    expect(caps.responseBodyCapture).toBe(true);
    expect(caps.contextualIdentities).toBe(false);
  });

  it('reports Chromium MAIN-world support only when scripting exists', () => {
    const caps = detectBrowserCapabilities({}, { runtime: { id: 'extension' }, scripting: { executeScript: vi.fn() } }, 'Chrome/158');
    expect(caps.browser).toBe('chromium');
    expect(caps.mainWorldExecution).toBe(true);
  });

  it('requests optional Firefox container permission and reports absence cleanly', async () => {
    const api = {
      permissions: { contains: vi.fn().mockResolvedValue(false), request: vi.fn().mockResolvedValue(true) },
      contextualIdentities: { query: vi.fn().mockResolvedValue([{ cookieStoreId: 'firefox-container-1', name: 'Work', color: 'blue', icon: 'briefcase' }]) },
    };
    expect(await requestContextualIdentities(api)).toBe(true);
    expect(api.permissions.request).toHaveBeenCalledWith({ permissions: ['contextualIdentities'] });
    expect(hasContextualIdentities(api)).toBe(true);
    expect(await listContextualIdentities(api)).toHaveLength(1);
    await createTabInIdentity('https://example.com', 'firefox-container-1', { ...api, tabs: { create: vi.fn().mockResolvedValue({ id: 4 }) } });
    expect(await requestContextualIdentities({})).toBe(false);
    await expect(listContextualIdentities({})).rejects.toThrow(/不支持/);
  });

  it('executes a script against an explicitly selected non-active tab', async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: 'changed' }]);
    const result = await executePageScript(42, 'document.title = "changed"', { scripting: { executeScript } }, {});
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 42 }, world: 'MAIN', args: ['document.title = "changed"'] }));
    expect(result).toEqual({ tabId: 42, frameId: 0, result: 'changed' });
  });

  it('falls back to MV2 isolated-world execution for older Firefox', async () => {
    const executeScript = vi.fn().mockResolvedValue([123]);
    const result = await executePageScript(7, '1 + 2', { tabs: { executeScript } }, {});
    expect(executeScript).toHaveBeenCalledWith(7, expect.objectContaining({ runAt: 'document_idle' }));
    expect(result.result).toBe(123);
  });

  it('detects WebAuthn API and extracts extension origin for RP validation', () => {
    const credentials = { create: vi.fn(), get: vi.fn() } as any;
    expect(getWebAuthnCapability(credentials, 'Firefox/149').available).toBe(false);
    expect(getWebAuthnCapability(credentials, 'Chrome/121').available).toBe(false);
    expect(getWebAuthnCapability(credentials, 'Firefox/150').available).toBe(true);
    expect(getWebAuthnCapability(credentials, 'Chrome/122').available).toBe(true);
    const credential = { response: { clientDataJSON: new TextEncoder().encode(JSON.stringify({ origin: 'moz-extension://stable-id' })).buffer } } as any;
    expect(getWebAuthnClientOrigin(credential)).toBe('moz-extension://stable-id');
  });
});
