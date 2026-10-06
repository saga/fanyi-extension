import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DOMObserverManager } from '../entrypoints/utils/domObserver';
import type { TextBlock } from '../entrypoints/utils/blockExtractor';

// Mock IntersectionObserver (jsdom doesn't support it)
const mockObserve = vi.fn();
const mockUnobserve = vi.fn();
const mockDisconnect = vi.fn();
let capturedCallback: IntersectionObserverCallback | null = null;

class MockIntersectionObserver {
  observe = mockObserve;
  unobserve = mockUnobserve;
  disconnect = mockDisconnect;
  root = null;
  rootMargin = '';
  thresholds = [];
  takeRecords = () => [];

  constructor(callback: IntersectionObserverCallback) {
    capturedCallback = callback;
  }
}

globalThis.IntersectionObserver = MockIntersectionObserver as any;

const mockObserverInstance = new MockIntersectionObserver(() => {});
// Reset capturedCallback since we just used it to create the mock
capturedCallback = null;

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('DOMObserverManager', () => {
  let manager: DOMObserverManager;
  let onNewContent: ReturnType<typeof vi.fn>;
  let onNodeVisible: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onNewContent = vi.fn();
    onNodeVisible = vi.fn();
    manager = new DOMObserverManager(onNewContent as any, onNodeVisible as any, 10);
  });

  afterEach(() => {
    manager.destroy();
    document.body.innerHTML = '';
  });

  // --- startMutationObserver ---

  it('observes mutations on document', () => {
    manager.startMutationObserver();
    manager.stopMutationObserver();
  });

  it('detects added paragraphs and calls onNewContent', async () => {
    manager.startMutationObserver();

    const div = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = 'Hello world this is a test paragraph with enough content';
    div.appendChild(p);

    document.body.appendChild(div);

    await wait(50);

    expect(onNewContent).toHaveBeenCalled();
    const blocks = onNewContent.mock.calls[0][0] as TextBlock[];
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some((b: TextBlock) => b.text.includes('Hello world'))).toBe(true);
  });

  it('detects added list items', async () => {
    manager.startMutationObserver();

    const ul = document.createElement('ul');
    const li = document.createElement('li');
    li.textContent = 'List item with enough content to be detected';
    ul.appendChild(li);

    document.body.appendChild(ul);

    await wait(50);

    expect(onNewContent).toHaveBeenCalled();
  });

  it('ignores script and style elements', async () => {
    manager.startMutationObserver();

    const script = document.createElement('script');
    script.textContent = 'console.log("hello")';
    document.body.appendChild(script);

    const style = document.createElement('style');
    style.textContent = '.test { color: red; }';
    document.body.appendChild(style);

    await wait(50);

    expect(onNewContent).not.toHaveBeenCalled();
  });


  // --- stopMutationObserver ---

  it('stops observing after stopMutationObserver', async () => {
    manager.startMutationObserver();
    manager.stopMutationObserver();

    const p = document.createElement('p');
    p.textContent = 'This should not be detected';
    document.body.appendChild(p);

    await wait(50);
    expect(onNewContent).not.toHaveBeenCalled();
  });

  // --- destroy ---


  // --- characterData mutations ---

  it('detects direct text node mutations', async () => {
    const p = document.createElement('p');
    const textNode = document.createTextNode('Initial text content for testing');
    p.appendChild(textNode);
    document.body.appendChild(p);

    manager.startMutationObserver();

    textNode.data = 'Updated text content for testing character data mutation';

    await wait(50);

    expect(onNewContent).toHaveBeenCalled();
  });

  // --- extractBlocksFromNode ---


  // --- intersection observer ---


  it('intersection observer fires onNodeVisible for intersecting elements', () => {
    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/p[1]', tag: 'p', text: 'Test' },
    ];
    const nodeMap = new Map<string, Node>();
    const p = document.createElement('p');
    p.textContent = 'Test';
    document.body.appendChild(p);
    nodeMap.set('b1', p);

    manager.startIntersectionObserver(blocks, nodeMap);

    // Simulate intersection observer callback
    capturedCallback!([
      {
        isIntersecting: true,
        target: p,
        intersectionRatio: 0.5,
        boundingClientRect: {} as DOMRectReadOnly,
        intersectionRect: {} as DOMRectReadOnly,
        rootBounds: null,
        time: Date.now(),
      },
    ], mockObserverInstance as unknown as IntersectionObserver);

    expect(onNodeVisible).toHaveBeenCalledWith('b1', p);
    manager.stopIntersectionObserver();
  });


});