import { describe, expect, it, vi } from 'vitest';
import { executeAgentToolInExtension, previewAgentPageClick } from '../entrypoints/utils/agentToolExecution';
import { validateAgentToolRequest } from '../entrypoints/utils/agentToolProtocol';

describe('Agent tool execution gates', () => {
  it('does not request or emulate Firefox containers in Chromium', async () => {
    const permissions = { contains: vi.fn(), request: vi.fn() };
    const browserApi = { runtime: { id: 'chrome-extension-id' }, permissions };
    const request = validateAgentToolRequest({
      tool: 'browser.containers.list', arguments: {}, reason: '列出容器',
    });
    await expect(executeAgentToolInExtension(request, undefined, browserApi)).rejects.toThrow(/不支持/);
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it('requests optional permissions immediately and before querying container identities', async () => {
    const browserApi = {
      runtime: { getBrowserInfo: vi.fn().mockResolvedValue({ name: 'Firefox', version: '150' }) },
      permissions: {
        request: vi.fn().mockImplementation(async () => false),
      },
      contextualIdentities: { query: vi.fn() },
    };
    const request = validateAgentToolRequest({
      tool: 'browser.containers.open',
      arguments: { url: 'https://example.com', identityName: 'Work' },
      reason: '在工作容器中打开页面',
    });
    await expect(executeAgentToolInExtension(request, undefined, browserApi)).rejects.toThrow(/未授予/);
    expect(browserApi.permissions.request).toHaveBeenCalledWith({
      permissions: ['contextualIdentities', 'cookies'],
    });
    expect(browserApi.contextualIdentities.query).not.toHaveBeenCalled();
    expect(browserApi.permissions.request.mock.invocationCallOrder[0])
      .toBeLessThan(browserApi.contextualIdentities.query.mock.invocationCallOrder[0] ?? Infinity);
  });

  it('starts Passkey creation immediately from the approval call without an awaited permission preflight', async () => {
    const attestation = new Uint8Array([1, 2, 3]).buffer;
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      origin: 'chrome-extension://test-id',
    })).buffer;
    class FakePublicKeyCredential {
      id = 'credential-id';
      rawId = new Uint8Array([4, 5, 6]).buffer;
      type = 'public-key';
      authenticatorAttachment = 'platform';
      response = {
        clientDataJSON,
        attestationObject: attestation,
        getTransports: () => ['internal'],
      };
      getClientExtensionResults() { return {}; }
    }
    vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential);
    const create = vi.fn().mockResolvedValue(new FakePublicKeyCredential());
    const original = Object.getOwnPropertyDescriptor(navigator, 'credentials');
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create, get: vi.fn() } });
    const permissions = { contains: vi.fn().mockResolvedValue(false) };
    try {
      const request = validateAgentToolRequest({
        tool: 'webauthn.create',
        arguments: {
          options: {
            rp: { id: 'example.com', name: 'Example' },
            user: { id: 'dXNlcjE=', name: 'user@example.com', displayName: 'Example User' },
            challenge: 'Y2hhbGxlbmdl',
          },
        },
        reason: '注册当前账户的 Passkey',
      });
      const operation = executeAgentToolInExtension(request, undefined, { permissions });
      // This assertion happens before awaiting operation: credentials.create must
      // already have been invoked while the approval click still has user activation.
      expect(create).toHaveBeenCalledTimes(1);
      expect(permissions.contains).not.toHaveBeenCalled();
      const result = await operation;
      expect(result.artifact?.json).toContain('chrome-extension://test-id');
    } finally {
      if (original) Object.defineProperty(navigator, 'credentials', original);
      else delete (navigator as any).credentials;
      vi.unstubAllGlobals();
    }
  });

  it('previews the click target and verifies the source tab has not navigated', async () => {
    const executeScript = vi.fn().mockResolvedValue([{
      frameId: 0,
      result: { ok: true, message: 'preview', target: { tag: 'a', label: 'Docs', href: 'https://example.com/docs' } },
    }]);
    const browserApi = {
      tabs: { get: vi.fn().mockResolvedValue({ url: 'https://example.com/page' }) },
      scripting: { executeScript },
    };
    const result = await previewAgentPageClick(8, '#docs', 'https://example.com/page#section', browserApi);
    expect(result.target?.href).toBe('https://example.com/docs');
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 8 }, args: [{ type: 'clickPreview', selector: '#docs', expectedPageUrl: 'https://example.com/page#section' }],
    }));
  });

  it('does not run page tools when the chat has no real HTTP(S) page context', async () => {
    const browserApi = {
      tabs: { get: vi.fn() },
      scripting: { executeScript: vi.fn() },
    };
    const request = validateAgentToolRequest({
      tool: 'page.inspect', arguments: {}, reason: '读取页面',
    });
    await expect(executeAgentToolInExtension(request, 8, browserApi, undefined))
      .rejects.toThrow(/没有已读取的 HTTP\(S\) 网页上下文/);
    expect(browserApi.tabs.get).not.toHaveBeenCalled();
    expect(browserApi.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('rejects page actions when the source tab navigated since context extraction', async () => {
    const browserApi = {
      tabs: { get: vi.fn().mockResolvedValue({ url: 'https://other.example/' }) },
      scripting: { executeScript: vi.fn() },
    };
    const request = validateAgentToolRequest({
      tool: 'page.inspect', arguments: {}, reason: '读取页面',
    });
    await expect(executeAgentToolInExtension(request, 8, browserApi, 'https://example.com/page'))
      .rejects.toThrow(/已导航/);
    expect(browserApi.scripting.executeScript).not.toHaveBeenCalled();
  });
});
