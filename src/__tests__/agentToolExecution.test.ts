import { describe, expect, it, vi } from 'vitest';
import { executeAgentToolInExtension } from '../entrypoints/utils/agentToolExecution';
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

  it('requests optional container and cookies permissions only for the selected action', async () => {
    const browserApi = {
      runtime: { getBrowserInfo: vi.fn().mockResolvedValue({ name: 'Firefox', version: '150' }) },
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request: vi.fn().mockResolvedValue(false),
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
  });
});
