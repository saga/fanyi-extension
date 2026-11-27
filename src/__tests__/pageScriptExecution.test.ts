import { describe, expect, it, vi } from 'vitest';
import { executePageAction, executePageScript } from '../entrypoints/utils/pageScriptExecution';

describe('allow-listed page actions', () => {
  it('runs a static action in the isolated world for an explicit tab', async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: true, message: 'ok' } }]);
    const result = await executePageAction(23, { type: 'inspect' }, { scripting: { executeScript } }, {});
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 23 }, world: 'ISOLATED', args: [{ type: 'inspect' }],
    }));
    expect(result.result?.ok).toBe(true);
  });

  it('rejects a stale expected URL inside the injected page function', async () => {
    const executeScript = vi.fn(async (details: any) => [{
      result: details.func(...details.args),
    }]);
    const result = await executePageAction(23, {
      type: 'inspect',
      expectedPageUrl: 'https://example.com/old-page',
    }, { scripting: { executeScript } }, {});
    expect(result.result?.ok).toBe(false);
    expect(result.result?.message).toMatch(/地址已变化/);
  });

  it('passes the captured page URL into the injected action for in-page race checking', async () => {
    const executeScript = vi.fn().mockResolvedValue([{ result: { ok: false, message: '页面地址已变化' } }]);
    await executePageAction(
      23,
      { type: 'inspect', expectedPageUrl: 'https://example.com/article' },
      { scripting: { executeScript } },
      {},
    );
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      args: [{ type: 'inspect', expectedPageUrl: 'https://example.com/article' }],
    }));
  });

  it('filters hidden and editable DOM text from page inspection', async () => {
    document.body.innerHTML = `
      <main>
        <p>Visible article text</p>
        <div hidden>Hidden secret</div>
        <div aria-hidden="true">ARIA hidden text</div>
        <div contenteditable="true">Private draft text</div>
        <input value="input secret" />
      </main>`;
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects')
      .mockReturnValue([{ } as DOMRect] as any);
    const executeScript = vi.fn(async (details: any) => [{
      result: details.func(...details.args),
    }]);
    try {
      const result = await executePageAction(23, { type: 'inspect' }, { scripting: { executeScript } }, {});
      expect(result.result?.text).toContain('Visible article text');
      expect(result.result?.text).not.toContain('Hidden secret');
      expect(result.result?.text).not.toContain('ARIA hidden text');
      expect(result.result?.text).not.toContain('Private draft text');
      expect(result.result?.text).not.toContain('input secret');
    } finally {
      rects.mockRestore();
      document.body.innerHTML = '';
    }
  });

  it('previews the actual link target and requires the approved target to remain unchanged', async () => {
    document.body.innerHTML = '<a id="docs" href="https://example.com/docs">Documentation</a>';
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects')
      .mockReturnValue([{ } as DOMRect] as any);
    const executeScript = vi.fn(async (details: any) => [{
      result: details.func(...details.args),
    }]);
    const clicked = vi.fn();
    document.querySelector('#docs')?.addEventListener('click', clicked);
    try {
      const preview = await executePageAction(23, { type: 'clickPreview', selector: '#docs' }, { scripting: { executeScript } }, {});
      expect(preview.result?.target).toEqual({
        tag: 'a', label: 'Documentation', href: 'https://example.com/docs',
      });
      expect(clicked).not.toHaveBeenCalled();

      const mismatch = await executePageAction(23, {
        type: 'click', selector: '#docs',
        expectedTarget: { tag: 'a', label: 'Other target', href: 'https://example.com/docs' },
      }, { scripting: { executeScript } }, {});
      expect(mismatch.result?.ok).toBe(false);
      expect(clicked).not.toHaveBeenCalled();

      const approved = await executePageAction(23, {
        type: 'click', selector: '#docs',
        expectedTarget: { tag: 'a', label: 'Documentation', href: 'https://example.com/docs' },
      }, { scripting: { executeScript } }, {});
      expect(approved.result?.ok).toBe(true);
      expect(clicked).toHaveBeenCalledTimes(1);
    } finally {
      rects.mockRestore();
      document.body.innerHTML = '';
    }
  });

  it('does not pass the MAIN world option to Firefox versions before 128', async () => {
    const mainExecute = vi.fn().mockResolvedValue([{ result: 'unexpected' }]);
    const legacyExecute = vi.fn().mockResolvedValue(['legacy']);
    const result = await executePageScript(
      17,
      'document.title',
      {
        runtime: { getBrowserInfo: vi.fn().mockResolvedValue({ name: 'Firefox', version: '127.0' }) },
        scripting: { executeScript: mainExecute },
        tabs: { executeScript: legacyExecute },
      },
      {},
    );
    expect(mainExecute).not.toHaveBeenCalled();
    expect(legacyExecute).toHaveBeenCalledWith(17, expect.objectContaining({ runAt: 'document_idle' }));
    expect(result.result).toBe('legacy');
  });

  it('uses MAIN world only for Firefox 128 and later', async () => {
    const executeScript = vi.fn().mockResolvedValue([{ result: 'main' }]);
    const result = await executePageScript(
      18,
      'document.title',
      {
        runtime: { getBrowserInfo: vi.fn().mockResolvedValue({ name: 'Firefox', version: '128.0' }) },
        scripting: { executeScript },
      },
      {},
    );
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 18 }, world: 'MAIN',
    }));
    expect(result.result).toBe('main');
  });

  it('blocks submit buttons even when they have an innocuous label', async () => {
    document.body.innerHTML = '<form><button id="continue" type="submit">Continue</button></form>';
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ } as DOMRect] as any);
    const clicked = vi.fn();
    document.querySelector('#continue')?.addEventListener('click', clicked);
    const executeScript = vi.fn(async (details: any) => [{
      result: details.func(...details.args),
    }]);
    try {
      const preview = await executePageAction(23, { type: 'clickPreview', selector: '#continue' }, { scripting: { executeScript } }, {});
      expect(preview.result?.ok).toBe(false);
      expect(preview.result?.message).toMatch(/高影响操作/);
      expect(clicked).not.toHaveBeenCalled();
    } finally {
      rects.mockRestore();
      document.body.innerHTML = '';
    }
  });

  it('blocks links that embed credentials in their URL', async () => {
    document.body.innerHTML = '<a id="unsafe" href="https://user:secret@example.com/path">Open</a>';
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ } as DOMRect] as any);
    const executeScript = vi.fn(async (details: any) => [{
      result: details.func(...details.args),
    }]);
    try {
      const result = await executePageAction(23, { type: 'clickPreview', selector: '#unsafe' }, { scripting: { executeScript } }, {});
      expect(result.result?.ok).toBe(false);
      expect(result.result?.message).toMatch(/账号或密码/);
    } finally {
      rects.mockRestore();
      document.body.innerHTML = '';
    }
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
