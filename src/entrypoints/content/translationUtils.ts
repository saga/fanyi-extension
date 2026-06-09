import browser from 'webextension-polyfill';
import type { TextBlock } from '../utils/blockExtractor';
import { buildChunks } from '../utils/chunkBuilder';
import {
  applyBlockTranslation,
  restoreBlock,
  toggleBlockTranslation,
} from '../utils/translationDisplay';
import { DOMObserverManager } from '../utils/domObserver';
import { getConfig } from '../utils/config';
import { showStatus, hideStatus } from './statusOverlay';
import { updateButtonState } from './floatingButton';
import { translateChunksViaBackground } from './chunkTranslation';
import type { TranslationState } from './translationTypes';

// ============================================================
// 全局 missing 兜底重试
// ============================================================

export async function retryGlobalMissing(
  blocks: TextBlock[],
  nodeMap: Map<string, Node>,
  translatedIds: Set<string>,
  config: { sourceLang: string; targetLang: string; mode: 'bilingual' | 'target' },
  isMobile: boolean,
): Promise<void> {
  const stillMissingIds: string[] = [];
  for (const [id] of nodeMap) {
    if (!translatedIds.has(id)) stillMissingIds.push(id);
  }
  if (stillMissingIds.length === 0) return;

  console.log(
    `[ContentScript] Global retry: ${stillMissingIds.length}/${nodeMap.size} blocks still missing`,
  );

  showStatus(`补译 ${stillMissingIds.length} 段...`, 'loading');

  const missingSet = new Set(stillMissingIds);
  const retryBlocks = blocks.filter((b) => missingSet.has(b.id));
  const retryChunks = buildChunks(retryBlocks);

  const { translatedIds: retryTranslatedIds } = await translateChunksViaBackground(
    retryChunks,
    config.sourceLang,
    config.targetLang,
    nodeMap,
    config.mode,
    [],
    undefined,
    isMobile,
  );

  let recoveredCount = 0;
  for (const id of retryTranslatedIds) {
    if (!translatedIds.has(id)) {
      translatedIds.add(id);
      recoveredCount++;
    }
  }
  console.log(`[ContentScript] Retry recovered ${recoveredCount}/${stillMissingIds.length} block(s)`);
}

// ============================================================
// missing 标记
// ============================================================

export function markMissingBlocks(
  nodeMap: Map<string, Node>,
  translatedIds: Set<string>,
): string[] {
  const missingIds: string[] = [];
  for (const [id, node] of nodeMap) {
    if (translatedIds.has(id)) continue;
    missingIds.push(id);
    if (node instanceof HTMLElement) {
      node.classList.add('fanyi-missing');
      node.title = '翻译响应中缺少该段落，点击扩展图标重新翻译';
    }
  }
  return missingIds;
}

// ============================================================
// 状态工具
// ============================================================

export function isPageTranslated(): boolean {
  return document.querySelector('.fanyi-translated') !== null;
}

export function warnOnNodeMapMismatch(blocks: TextBlock[], nodeMap: Map<string, Node>): void {
  if (nodeMap.size === blocks.length) return;
  console.warn(
    `[ContentScript] NodeMap mismatch: ${nodeMap.size}/${blocks.length} blocks mapped to DOM. ` +
    `This usually means some blocks share an xpath and were collapsed — see extractors.`,
  );
}

export function saveOriginalTexts(
  blocks: TextBlock[],
  nodeMap: Map<string, Node>,
  state: TranslationState,
): void {
  for (const block of blocks) {
    const node = nodeMap.get(block.id);
    if (node && node instanceof HTMLElement) {
      state.originalTexts.set(block.id, node.textContent || '');
    }
  }
}

function cleanupTempAttrs(): void {
  const tempAttrNodes = document.querySelectorAll('[data-fanyi-block-id]');
  for (const node of Array.from(tempAttrNodes)) {
    const el = node as HTMLElement;
    delete el.dataset.fanyiBlockId;
  }
}

export function restoreOriginal(): void {
  for (const node of Array.from(document.querySelectorAll('.fanyi-translated'))) {
    restoreBlock(node as HTMLElement);
  }
  for (const node of Array.from(document.querySelectorAll('.fanyi-missing'))) {
    const el = node as HTMLElement;
    el.classList.remove('fanyi-missing');
    el.removeAttribute('title');
  }
  cleanupTempAttrs();
  updateButtonState(false);
  showStatus('已恢复原文', 'success');
  setTimeout(hideStatus, 2000);
}

export function toggleTranslation(): void {
  for (const node of Array.from(document.querySelectorAll('.fanyi-translated'))) {
    toggleBlockTranslation(node as HTMLElement);
  }
}

// ============================================================
// 动态内容监听
// ============================================================

export function setupDynamicContentObserver(
  state: TranslationState,
): DOMObserverManager {
  const observer = new DOMObserverManager(
    async (newBlocks: TextBlock[]) => {
      const config = await getConfig();
      for (const block of newBlocks) {
        if (!block.text || block.text.length <= 10) continue;
        try {
          const response: any = await browser.runtime.sendMessage({
            action: 'translateChunk',
            jsonContent: JSON.stringify([{ id: block.id, text: block.text }]),
            sourceLang: config.sourceLang,
            targetLang: config.targetLang,
            pageUrl: window.location.href,
          });
          if (response.success && response.result?.length > 0) {
            const node = findNodeByText(block.text);
            if (node) {
              applyBlockTranslation(node, response.result[0][1], config.mode);
              state.translatedBlocks.add(block.id);
            }
          }
        } catch (error) {
          console.error('Dynamic content translation failed:', error);
        }
      }
    },
    () => {},
    /* debounceMs */ 1500,
  );
  observer.startMutationObserver();
  return observer;
}

function findNodeByText(text: string): HTMLElement | null {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node: Node): number => {
        const el = node as Element;
        if (el.classList.contains('fanyi-translated')) return NodeFilter.FILTER_REJECT;
        if (el.textContent?.trim() === text) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      },
    },
  );

  let current: Element | null;
  while ((current = walker.nextNode() as Element | null)) {
    if (current.textContent?.trim() === text) {
      return current as HTMLElement;
    }
  }
  return null;
}
