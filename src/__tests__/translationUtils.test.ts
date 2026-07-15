import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TextBlock } from '../entrypoints/utils/blockExtractor';
import type { TranslationState } from '../entrypoints/content/translationTypes';

vi.mock('webextension-polyfill', () => ({ default: {} }));
vi.mock('../entrypoints/content/statusOverlay', () => ({
  showStatus: vi.fn(),
  hideStatus: vi.fn(),
}));
vi.mock('../entrypoints/content/floatingButton', () => ({
  updateButtonState: vi.fn(),
}));

describe('translationUtils', () => {
  let mod: typeof import('../entrypoints/content/translationUtils');

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // Re-import to get fresh module state
    mod = await import('../entrypoints/content/translationUtils');
  });

  // ---- isPageTranslated ----

  it('isPageTranslated returns false when no .fanyi-translated elements exist', () => {
    expect(mod.isPageTranslated()).toBe(false);
  });

  it('isPageTranslated returns true when .fanyi-translated elements exist', () => {
    const el = document.createElement('div');
    el.classList.add('fanyi-translated');
    document.body.appendChild(el);
    expect(mod.isPageTranslated()).toBe(true);
  });

  it('isPageTranslated returns false after .fanyi-translated is removed', () => {
    const el = document.createElement('div');
    el.classList.add('fanyi-translated');
    document.body.appendChild(el);
    expect(mod.isPageTranslated()).toBe(true);
    el.classList.remove('fanyi-translated');
    expect(mod.isPageTranslated()).toBe(false);
  });

  // ---- warnOnNodeMapMismatch ----

  it('warnOnNodeMapMismatch does not warn when sizes match', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks: TextBlock[] = [
      { id: 'b1', tag: 'p', text: 'a', xpath: '/div[1]' },
      { id: 'b2', tag: 'p', text: 'b', xpath: '/div[2]' },
    ];
    const nodeMap = new Map<string, Node>([
      ['b1', document.createElement('div')],
      ['b2', document.createElement('div')],
    ]);
    mod.warnOnNodeMapMismatch(blocks, nodeMap);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warnOnNodeMapMismatch warns when sizes mismatch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks: TextBlock[] = [
      { id: 'b1', tag: 'p', text: 'a', xpath: '/div[1]' },
      { id: 'b2', tag: 'p', text: 'b', xpath: '/div[2]' },
    ];
    const nodeMap = new Map<string, Node>([['b1', document.createElement('div')]]);
    mod.warnOnNodeMapMismatch(blocks, nodeMap);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('NodeMap mismatch');
  });

  // ---- saveOriginalTexts ----

  it('saveOriginalTexts populates state with original text content', () => {
    const el1 = document.createElement('p');
    el1.textContent = 'Hello world';
    const el2 = document.createElement('p');
    el2.textContent = 'Second block';

    const blocks: TextBlock[] = [
      { id: 'b1', tag: 'p', text: 'Hello world', xpath: '/div[1]' },
      { id: 'b2', tag: 'p', text: 'Second block', xpath: '/div[2]' },
    ];
    const nodeMap = new Map<string, Node>([
      ['b1', el1],
      ['b2', el2],
    ]);
    const state: TranslationState = { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() };

    mod.saveOriginalTexts(blocks, nodeMap, state);
    expect(state.originalTexts.get('b1')).toBe('Hello world');
    expect(state.originalTexts.get('b2')).toBe('Second block');
    expect(state.originalTexts.size).toBe(2);
  });

  it('saveOriginalTexts skips nodes not in nodeMap', () => {
    const blocks: TextBlock[] = [
      { id: 'b1', tag: 'p', text: 'Hello', xpath: '/div[1]' },
      { id: 'b2', tag: 'p', text: 'World', xpath: '/div[2]' },
    ];
    const nodeMap = new Map<string, Node>([['b1', document.createElement('p')]]);
    const state: TranslationState = { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() };

    mod.saveOriginalTexts(blocks, nodeMap, state);
    expect(state.originalTexts.has('b1')).toBe(true);
    expect(state.originalTexts.has('b2')).toBe(false);
  });

  // ---- markMissingBlocks ----

  it('markMissingBlocks marks missing blocks with fanyi-missing class', () => {
    const el1 = document.createElement('p');
    el1.id = 'b1';
    const el2 = document.createElement('p');
    el2.id = 'b2';

    const nodeMap = new Map<string, Node>([
      ['b1', el1],
      ['b2', el2],
    ]);
    const translatedIds = new Set<string>(['b1']);

    const missing = mod.markMissingBlocks(nodeMap, translatedIds);
    expect(missing).toEqual(['b2']);
    expect(el1.classList.contains('fanyi-missing')).toBe(false);
    expect(el2.classList.contains('fanyi-missing')).toBe(true);
    expect(el2.getAttribute('title')).toBeTruthy();
  });

  it('markMissingBlocks returns all missing ids', () => {
    const el = document.createElement('p');
    const nodeMap = new Map<string, Node>([['b1', el]]);
    const translatedIds = new Set<string>();
    const missing = mod.markMissingBlocks(nodeMap, translatedIds);
    expect(missing).toEqual(['b1']);
  });

  it('markMissingBlocks handles non-HTMLElement nodes gracefully', () => {
    const textNode = document.createTextNode('hello');
    const nodeMap = new Map<string, Node>([['b1', textNode]]);
    const translatedIds = new Set<string>();
    // Should not throw when node is not HTMLElement
    expect(() => mod.markMissingBlocks(nodeMap, translatedIds)).not.toThrow();
    const missing = mod.markMissingBlocks(nodeMap, translatedIds);
    expect(missing).toEqual(['b1']);
  });

  // ---- applyTranslationsWithRAF (from chunkTranslation) ----

  it('applyTranslationsWithRAF applies translations to DOM elements', async () => {
    const { applyTranslationsWithRAF } = await import('../entrypoints/content/chunkTranslation');

    const el = document.createElement('p');
    el.textContent = 'Original';
    document.body.appendChild(el);

    const translationMap = new Map<string, string>([['b1', 'Translated']]);
    const nodeMap = new Map<string, Node>([['b1', el]]);

    await applyTranslationsWithRAF(translationMap, nodeMap, { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() });
    // After rAF, the translation should be applied
    expect(el.textContent).toContain('Translated');
  });

  it('applyTranslationsWithRAF skips non-HTMLElement nodes', async () => {
    const { applyTranslationsWithRAF } = await import('../entrypoints/content/chunkTranslation');

    const textNode = document.createTextNode('hello');
    document.body.appendChild(textNode);

    const translationMap = new Map<string, string>([['b1', 'translated']]);
    const nodeMap = new Map<string, Node>([['b1', textNode]]);

    // Should not throw when node is a text node
    await expect(
      applyTranslationsWithRAF(translationMap, nodeMap, { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() }),
    ).resolves.toBeUndefined();
  });

  it('applyTranslationsWithRAF handles empty translation map', async () => {
    const { applyTranslationsWithRAF } = await import('../entrypoints/content/chunkTranslation');

    const nodeMap = new Map<string, Node>();
    await expect(
      applyTranslationsWithRAF(new Map(), nodeMap, { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() }),
    ).resolves.toBeUndefined();
  });

  // ---- restoreOriginal ----
  // These functions use showStatus/updateButtonState which need mocking.
  // We test basic DOM cleanup behavior.

  it('restoreOriginal clears fanyi-translated and fanyi-missing classes', async () => {
    const el1 = document.createElement('p');
    el1.classList.add('fanyi-translated');
    const el2 = document.createElement('p');
    el2.classList.add('fanyi-missing');
    el2.setAttribute('title', 'missing');
    document.body.append(el1, el2);

    const utils = await import('../entrypoints/content/translationUtils');
    utils.restoreOriginal();

    expect(el1.classList.contains('fanyi-translated')).toBe(false);
    expect(el2.classList.contains('fanyi-missing')).toBe(false);
    expect(el2.hasAttribute('title')).toBe(false);
  });

  it('restoreOriginal removes body dataset and clears state when provided', async () => {
    document.body.dataset.fanyiTranslated = 'true';
    const state: TranslationState = {
      originalTexts: new Map([['b1', 'hello']]),
      translatedBlocks: new Set(['b1']),
      translatedTexts: new Map([['b1', '你好']]),
    };

    const utils = await import('../entrypoints/content/translationUtils');
    utils.restoreOriginal(state);

    expect(document.body.dataset.fanyiTranslated).toBeUndefined();
    expect(state.originalTexts.size).toBe(0);
    expect(state.translatedBlocks.size).toBe(0);
    expect(state.translatedTexts.size).toBe(0);
  });

  it('restoreOriginal with silent=true does not call showStatus', async () => {
    const { showStatus } = await import('../entrypoints/content/statusOverlay');
    document.body.dataset.fanyiTranslated = 'true';

    const utils = await import('../entrypoints/content/translationUtils');
    utils.restoreOriginal(undefined, true);

    expect(showStatus).not.toHaveBeenCalled();
    expect(document.body.dataset.fanyiTranslated).toBeUndefined();
  });

  it('restoreOriginal with silent=false calls showStatus', async () => {
    const { showStatus } = await import('../entrypoints/content/statusOverlay');
    document.body.dataset.fanyiTranslated = 'true';

    const utils = await import('../entrypoints/content/translationUtils');
    utils.restoreOriginal(undefined, false);

    expect(showStatus).toHaveBeenCalledWith('已恢复原文', 'success');
  });
});
