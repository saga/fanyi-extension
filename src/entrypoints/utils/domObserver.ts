import type { TextBlock } from './blockExtractor';

export class DOMObserverManager {
  private mutationObserver: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private observedNodes = new WeakMap<Node, string>();
  private onNewContent: (blocks: TextBlock[]) => void;
  private onNodeVisible: (blockId: string, node: Node) => void;
  private debounceTimer: number | null = null;
  private debounceDelay: number;

  constructor(
    onNewContent: (blocks: TextBlock[]) => void,
    onNodeVisible: (blockId: string, node: Node) => void,
    debounceDelay = 500
  ) {
    this.onNewContent = onNewContent;
    this.onNodeVisible = onNodeVisible;
    this.debounceDelay = debounceDelay;
  }

  startMutationObserver(root: Document | Element = document) {
    this.stopMutationObserver();

    this.mutationObserver = new MutationObserver((mutations) => {
      this.handleMutations(mutations);
    });

    this.mutationObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  stopMutationObserver() {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private handleMutations(mutations: MutationRecord[]) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      const newBlocks: TextBlock[] = [];

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const blocks = this.extractBlocksFromNode(node as Element);
              newBlocks.push(...blocks);
            }
          });
        } else if (mutation.type === 'characterData') {
          const target = mutation.target.parentElement;
          if (target && this.shouldProcessElement(target)) {
            newBlocks.push({
              id: `dynamic_${Date.now()}`,
              xpath: '',
              tag: target.tagName.toLowerCase(),
              text: target.textContent?.trim() || '',
            });
          }
        }
      }

      if (newBlocks.length > 0) {
        this.onNewContent(newBlocks);
      }
    }, this.debounceDelay);
  }

  startIntersectionObserver(
    blocks: TextBlock[],
    nodeMap: Map<string, Node>,
    root: Document | Element = document
  ) {
    this.stopIntersectionObserver();

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const blockId = this.observedNodes.get(entry.target);
            if (blockId) {
              this.onNodeVisible(blockId, entry.target);
              this.intersectionObserver?.unobserve(entry.target);
              this.observedNodes.delete(entry.target);
            }
          }
        }
      },
      {
        root: null,
        rootMargin: '100px',
        threshold: 0.1,
      }
    );

    for (const block of blocks) {
      const node = nodeMap.get(block.id);
      if (node && node instanceof Element) {
        this.observedNodes.set(node, block.id);
        this.intersectionObserver.observe(node);
      }
    }
  }

  stopIntersectionObserver() {
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    this.observedNodes = new WeakMap();
  }

  private extractBlocksFromNode(element: Element): TextBlock[] {
    const blocks: TextBlock[] = [];
    const PROCESSABLE_TAGS = new Set([
      'P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'TD', 'TH', 'CAPTION', 'FIGCAPTION', 'LABEL', 'LEGEND',
    ]);

    const IGNORE_TAGS = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'SVG',
      'BUTTON', 'NAV', 'TEXTAREA', 'INPUT', 'SELECT',
    ]);

    function traverse(node: Node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const el = node as Element;

      if (IGNORE_TAGS.has(el.tagName)) return;

      if (PROCESSABLE_TAGS.has(el.tagName)) {
        const text = el.textContent?.trim();
        if (text && text.length > 0) {
          blocks.push({
            id: `dynamic_${Date.now()}_${blocks.length}`,
            xpath: '',
            tag: el.tagName.toLowerCase(),
            text,
          });
        }
      }

      for (const child of Array.from(el.children)) {
        traverse(child);
      }
    }

    traverse(element);
    return blocks;
  }

  private shouldProcessElement(element: Element): boolean {
    const PROCESSABLE_TAGS = new Set([
      'P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'TD', 'TH', 'CAPTION', 'FIGCAPTION', 'LABEL', 'LEGEND',
    ]);
    return PROCESSABLE_TAGS.has(element.tagName);
  }

  destroy() {
    this.stopMutationObserver();
    this.stopIntersectionObserver();
  }
}
