import { describe, expect, it, vi } from 'vitest';
import { executePageAction } from '../entrypoints/utils/pageScriptExecution';

describe('allow-listed page actions', () => {
  it('runs a static action in the isolated world for an explicit tab', async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: true, message: 'ok' } }]);
    const result = await executePageAction(23, { type: 'inspect' }, { scripting: { executeScript } }, {});
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 23 }, world: 'ISOLATED', args: [{ type: 'inspect' }],
    }));
    expect(result.result?.ok).toBe(true);
  });

  it('uses the static adapter for legacy tabs.executeScript without page-supplied source', async () => {
    const executeScript = vi.fn().mockResolvedValue([{ ok: true, message: 'ok' }]);
    await executePageAction(9, { type: 'find', text: 'needle' }, { tabs: { executeScript } }, {});
    const code = executeScript.mock.calls[0]?.[1]?.code as string;
    expect(code).toContain('runPageAction');
    expect(code).not.toContain('eval(');
    expect(code).toContain('needle');
  });

  it('rejects oversized payloads and invalid tab IDs', async () => {
    await expect(executePageAction(-1, { type: 'inspect' })).rejects.toThrow(/Invalid/);
    await expect(executePageAction(1, { type: 'find', text: 'x'.repeat(5000) })).rejects.toThrow(/过长/);
  });
});
