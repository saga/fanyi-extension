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
  config: { sourceLang: string; targetLang: string },
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
    {},
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
  // 页面级标记 + 节点级标记同时检查：
  // 1. body 上的 data-fanyi-translated 在翻译完成后设置，restore 时移除，toggle 不会移除；
  // 2. .fanyi-translated class / data-original-text 在 applyBlockTranslation 时设置。
  // 这样即使 toggle 隐藏译文、或服务端翻译清理了节点标记，仍能判断已翻译。
  return (
    document.body?.dataset.fanyiTranslated === 'true' ||
    document.querySelector('.fanyi-translated') !== null ||
    document.querySelector('[data-original-text]') !== null
  );
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

export function restoreOriginal(state?: TranslationState): void {
  for (const node of Array.from(document.querySelectorAll('.fanyi-translated'))) {
    restoreBlock(node as HTMLElement);
  }
  for (const node of Array.from(document.querySelectorAll('.fanyi-missing'))) {
    const el = node as HTMLElement;
    el.classList.remove('fanyi-missing');
    el.removeAttribute('title');
  }
  cleanupTempAttrs();
  if (document.body) {
    delete document.body.dataset.fanyiTranslated;
  }
  if (state) {
    state.originalTexts.clear();
    state.translatedBlocks.clear();
    state.translatedTexts.clear();
  }
  updateButtonState(false);
  showStatus('已恢复原文', 'success');
  setTimeout(hideStatus, 4000);
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
              applyBlockTranslation(node, response.result[0][1]);
              state.translatedBlocks.add(block.id);
            }
          }
        } catch (error) {
          console.error('Dynamic content translation failed:', error);
        }
      }
      // 新增内容处理完后，也尝试恢复被 React/Next.js 重新渲染覆盖的翻译
      reapplyLostTranslations(state);
    },
    () => {},
    /* debounceMs */ 1500,
  );
  observer.startMutationObserver();

  // 监听滚动：React/Next.js 站点在滚动时可能重新渲染可见段落，导致译文消失。
  // 这里加一个轻量节流，滚动停止后尝试恢复已保存的译文。
  let scrollTimer: number | null = null;
  const onScroll = () => {
    if (scrollTimer) window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      reapplyLostTranslations(state);
    }, 500);
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // 包装 observer，在 stop 时也移除 scroll 监听
  const originalStop = observer.stopMutationObserver.bind(observer);
  const originalDestroy = observer.destroy.bind(observer);
  observer.stopMutationObserver = () => {
    window.removeEventListener('scroll', onScroll);
    if (scrollTimer) window.clearTimeout(scrollTimer);
    originalStop();
  };
  observer.destroy = () => {
    window.removeEventListener('scroll', onScroll);
    if (scrollTimer) window.clearTimeout(scrollTimer);
    originalDestroy();
  };

  return observer;
}

/**
 * 恢复被 React/Next.js 重新渲染覆盖的翻译。
 *
 * 某些前端框架（如 Next.js App Router）会在滚动或交互后重新渲染 DOM，
 * 把我们插入的 .fanyi-translation / .fanyi-original 等节点清除掉。
 * 这里根据保存的 originalTexts + translatedTexts 映射，重新把译文应用回去。
 */
export function reapplyLostTranslations(state: TranslationState): void {
  if (state.originalTexts.size === 0 || state.translatedTexts.size === 0) return;

  // 建立 originalText -> blockId 的反向索引（取第一个匹配）。
  // 注意：同一原文可能出现多次，这里只恢复至少一次。
  const textToIds = new Map<string, string[]>();
  for (const [blockId, originalText] of state.originalTexts) {
    const list = textToIds.get(originalText);
    if (list) {
      list.push(blockId);
    } else {
      textToIds.set(originalText, [blockId]);
    }
  }

  const REAPPLYABLE_TAGS = new Set([
    'P', 'LI', 'DD', 'BLOCKQUOTE', 'FIGCAPTION',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  ]);

  const candidates = document.querySelectorAll(
    Array.from(REAPPLYABLE_TAGS).join(','),
  );

  let reapplied = 0;
  for (const el of Array.from(candidates)) {
    if (!(el instanceof HTMLElement)) continue;
    // 已经翻译的跳过
    if (el.classList.contains('fanyi-translated')) continue;

    const text = (el.textContent || '').trim();
    if (!text) continue;

    const ids = textToIds.get(text);
    if (!ids || ids.length === 0) continue;

    // 找到第一个有译文的 blockId
    for (const blockId of ids) {
      const translated = state.translatedTexts.get(blockId);
      if (translated) {
        applyBlockTranslation(el, translated);
        reapplied++;
        break;
      }
    }
  }

  if (reapplied > 0) {
    console.log(`[ContentScript] Reapplied ${reapplied} lost translation(s)`);
  }
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
