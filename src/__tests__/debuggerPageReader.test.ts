import { describe, expect, it, vi } from 'vitest';
import { readPageHtmlWithDebugger } from '../entrypoints/utils/debuggerPageReader';

describe('readPageHtmlWithDebugger', () => {
  it('reads the document HTML and always detaches after a successful attach', async () => {
    const api = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({
        result: { type: 'string', value: '<html><body>article</body></html>' },
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };

    await expect(readPageHtmlWithDebugger(api, 42)).resolves.toBe('<html><body>article</body></html>');
    expect(api.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 42 }, 'Runtime.evaluate', expect.objectContaining({
      returnByValue: true,
    }));
    expect(api.detach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('does not attempt to attach when the debugger API is unavailable', async () => {
    await expect(readPageHtmlWithDebugger(undefined, 42)).resolves.toBeNull();
  });

  it('returns null and does not detach when attach fails', async () => {
    const api = {
      attach: vi.fn().mockRejectedValue(new Error('Debugger is already attached')),
      sendCommand: vi.fn(),
      detach: vi.fn(),
    };

    await expect(readPageHtmlWithDebugger(api, 42)).resolves.toBeNull();
    expect(api.sendCommand).not.toHaveBeenCalled();
    expect(api.detach).not.toHaveBeenCalled();
  });

  it('detaches after Runtime.evaluate fails', async () => {
    const api = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockRejectedValue(new Error('Target closed')),
      detach: vi.fn().mockResolvedValue(undefined),
    };

    await expect(readPageHtmlWithDebugger(api, 42)).resolves.toBeNull();
    expect(api.detach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('returns null for a CDP exception or a non-string result', async () => {
    const api = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({ exceptionDetails: { text: 'execution failed' } }),
      detach: vi.fn().mockResolvedValue(undefined),
    };

    await expect(readPageHtmlWithDebugger(api, 42)).resolves.toBeNull();
    expect(api.detach).toHaveBeenCalledWith({ tabId: 42 });
  });
});
