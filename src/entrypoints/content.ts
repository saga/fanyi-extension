import {
  prepareDocument,
  type Chunk,
} from './utils/contentHelper';
import { buildNodeMap } from './utils/blockExtractor';
import { getConfig } from './utils/config';
import { DOMObserverManager } from './utils/domObserver';
import type { TextBlock } from './utils/blockExtractor';

export default defineContentScript({
  matches: ['*://*/*'],
  main() {
    console.log('Content script loaded');

    let isTranslating = false;
    let translationOverlay: HTMLElement | null = null;
    let originalTexts = new Map<string, string>();
    let translatedBlocks = new Set<string>();
    let domObserver: DOMObserverManager | null = null;

    browser.runtime.onMessage.addListener(async (message) => {
      if (message.action === 'translatePage') {
        await handleFullTranslation();
      } else if (message.action === 'translateSelection') {
        await handleSelectionTranslation(message.text);
      } else if (message.action === 'restoreOriginal') {
        restoreOriginal();
      } else if (message.action === 'toggleTranslation') {
        toggleTranslation();
      }
    });

    async function handleFullTranslation() {
      if (isTranslating) return;

      const config = await getConfig();
      console.log('[ContentScript] handleFullTranslation called, config:', { enabled: config.enabled, sourceLang: config.sourceLang, targetLang: config.targetLang });
      if (!config.enabled) return;

      isTranslating = true;
      showStatus('正在提取文本...', 'loading');

      try {
        console.log('[ContentScript] Calling prepareDocument...');
        const { blocks, chunks, fullText } = prepareDocument(document);
        console.log('[ContentScript] prepareDocument result:', { blocksCount: blocks.length, chunksCount: chunks.length, fullTextLength: fullText.length });
        console.log(`[ContentScript] API Request Estimate: ${chunks.length} requests (concurrent)`);

        if (blocks.length === 0) {
          console.warn('[ContentScript] No blocks found! Page structure:');
          console.log('[ContentScript] document.body children:', Array.from(document.body.children).map(c => c.tagName));
          console.log('[ContentScript] document.body innerText length:', document.body.innerText?.length);
          throw new Error('No translatable content found');
        }

        showStatus(
          `共 ${blocks.length} 个文本块，${chunks.length} 个翻译块`,
          'loading'
        );

        const nodeMap = buildNodeMap(blocks, document);
        saveOriginalTexts(blocks, nodeMap);

        const translationMap = await translateChunksViaBackground(
          chunks,
          config.sourceLang,
          config.targetLang,
          (current, total) => {
            showStatus(`翻译进度: ${current}/${total}`, 'loading');
          }
        );

        applyTranslations(translationMap, nodeMap, config.mode);
        translatedBlocks = new Set(translationMap.keys());

        console.log(`[ContentScript] Translation applied: ${translationMap.size} blocks translated`);

        setupDynamicContentObserver(config.mode);

        showStatus('翻译完成', 'success');
        setTimeout(() => hideStatus(), 2000);
      } catch (error) {
        console.error('Translation failed:', error);
        showStatus(
          error instanceof Error ? error.message : '翻译失败',
          'error'
        );
      } finally {
        isTranslating = false;
      }
    }

    async function handleSelectionTranslation(text: string) {
      if (!text || text.length < 2) return;

      try {
        const config = await getConfig();
        const response = await browser.runtime.sendMessage({
          action: 'translateSelection',
          text,
          sourceLang: config.sourceLang,
          targetLang: config.targetLang,
        });

        if (response.success) {
          showSelectionPopup(response.translated, text);
        } else {
          console.error('Selection translation failed:', response.error);
        }
      } catch (error) {
        console.error('Selection translation failed:', error);
      }
    }

    async function translateChunksViaBackground(
      chunks: Chunk[],
      sourceLang: string,
      targetLang: string,
      onProgress?: (current: number, total: number) => void
    ): Promise<Map<string, string>> {
      console.log('[ContentScript] translateChunksViaBackground called, chunks:', chunks.length);
      const translationMap = new Map<string, string>();
      const concurrency = 3;
      let completedCount = 0;

      async function translateChunk(index: number): Promise<void> {
        const chunk = chunks[index];
        console.log(`[ContentScript] Translating chunk ${index + 1}/${chunks.length}, blocks: ${chunk.blocks.length}`);

        const startTime = Date.now();
        const response = await browser.runtime.sendMessage({
          action: 'translateChunk',
          jsonContent: chunk.jsonContent,
          sourceLang,
          targetLang,
        });
        const elapsed = Date.now() - startTime;
        console.log(`[ContentScript] Chunk ${index + 1} response time: ${elapsed}ms, success: ${response.success}`);

        if (response.success) {
          console.log(`[ContentScript] Chunk ${index + 1} result blocks:`, response.result?.length || 0);
          for (const [id, text] of response.result) {
            translationMap.set(id, text);
          }
        } else {
          console.error(`Chunk ${chunk.id} translation failed:`, response.error);
        }

        completedCount++;
        onProgress?.(completedCount, chunks.length);
      }

      async function worker(startIndex: number): Promise<void> {
        for (let i = startIndex; i < chunks.length; i += concurrency) {
          await translateChunk(i);
        }
      }

      const workers: Promise<void>[] = [];
      for (let i = 0; i < concurrency && i < chunks.length; i++) {
        workers.push(worker(i));
      }

      await Promise.all(workers);
      console.log('[ContentScript] translateChunksViaBackground complete, total blocks:', translationMap.size);
      return translationMap;
    }

    function saveOriginalTexts(blocks: TextBlock[], nodeMap: Map<string, Node>) {
      for (const block of blocks) {
        const node = nodeMap.get(block.id);
        if (node && node instanceof HTMLElement) {
          originalTexts.set(block.id, node.textContent || '');
        }
      }
    }

    function applyTranslations(
      translationMap: Map<string, string>,
      nodeMap: Map<string, Node>,
      mode: 'bilingual' | 'target'
    ) {
      for (const [blockId, translatedText] of translationMap) {
        const node = nodeMap.get(blockId);
        if (!node || !(node instanceof HTMLElement)) continue;
        applyBlockTranslation(node, translatedText, mode);
      }
    }

    function applyBlockTranslation(
      node: HTMLElement,
      translatedText: string,
      mode: 'bilingual' | 'target'
    ) {
      if (node.classList.contains('fanyi-translated')) return;

      const originalText = node.textContent || '';

      if (mode === 'bilingual') {
        const wrapper = document.createElement('div');
        wrapper.className = 'fanyi-bilingual-block';
        wrapper.innerHTML = `
          <div class="fanyi-source">${escapeHtml(originalText)}</div>
          <div class="fanyi-target">${escapeHtml(translatedText)}</div>
        `;

        node.textContent = '';
        node.appendChild(wrapper);
      } else {
        node.textContent = translatedText;
      }

      node.classList.add('fanyi-translated');
      node.dataset.originalText = originalText;
    }

    function setupDynamicContentObserver(mode: 'bilingual' | 'target') {
      if (domObserver) {
        domObserver.destroy();
      }

      domObserver = new DOMObserverManager(
        async (newBlocks: TextBlock[]) => {
          console.log('[ContentScript] Dynamic content detected:', newBlocks.length, 'new blocks');
          
          for (const block of newBlocks) {
            if (block.text && block.text.length > 10) {
              try {
                const config = await getConfig();
                const response = await browser.runtime.sendMessage({
                  action: 'translateSelection',
                  text: block.text,
                  sourceLang: config.sourceLang,
                  targetLang: config.targetLang,
                });

                if (response.success) {
                  const node = findNodeByText(block.text);
                  if (node) {
                    applyBlockTranslation(node, response.translated, mode);
                    translatedBlocks.add(block.id);
                    console.log('[ContentScript] Dynamic block translated:', block.id);
                  } else {
                    console.warn('[ContentScript] Could not find node for block:', block.id);
                  }
                }
              } catch (error) {
                console.error('Dynamic content translation failed:', error);
              }
            }
          }
        },
        () => {},
        1000
      );

      domObserver.startMutationObserver();
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
          }
        }
      );

      let current: Element | null;
      while (current = walker.nextNode() as Element) {
        if (current.textContent?.trim() === text) {
          return current;
        }
      }
      return null;
    }

    function restoreOriginal() {
      for (const [blockId, originalText] of originalTexts) {
        const nodes = document.querySelectorAll(`[data-original-text]`);
        for (const node of Array.from(nodes)) {
          const el = node as HTMLElement;
          if (el.dataset.originalText === originalText) {
            el.textContent = originalText;
            el.classList.remove('fanyi-translated');
            delete el.dataset.originalText;
          }
        }
      }

      const translatedElements = document.querySelectorAll('.fanyi-bilingual-block');
      for (const el of Array.from(translatedElements)) {
        const parent = el.parentElement;
        if (parent && parent.dataset.originalText) {
          parent.textContent = parent.dataset.originalText;
          parent.classList.remove('fanyi-translated');
          delete parent.dataset.originalText;
        }
      }

      showStatus('已恢复原文', 'success');
      setTimeout(() => hideStatus(), 2000);
    }

    function toggleTranslation() {
      const translatedElements = document.querySelectorAll('.fanyi-target');
      for (const el of Array.from(translatedElements)) {
        const isVisible = (el as HTMLElement).style.display !== 'none';
        (el as HTMLElement).style.display = isVisible ? 'none' : 'block';
      }
    }

    function showStatus(message: string, type: 'loading' | 'success' | 'error') {
      if (!translationOverlay) {
        translationOverlay = document.createElement('div');
        translationOverlay.className = 'fanyi-status-overlay';
        document.body.appendChild(translationOverlay);
      }

      translationOverlay.className = `fanyi-status-overlay fanyi-${type}`;
      translationOverlay.textContent = message;
      translationOverlay.style.display = 'flex';
    }

    function hideStatus() {
      if (translationOverlay) {
        translationOverlay.style.display = 'none';
      }
    }

    function showSelectionPopup(translated: string, original: string) {
      const existing = document.querySelector('.fanyi-selection-popup');
      if (existing) existing.remove();

      const popup = document.createElement('div');
      popup.className = 'fanyi-selection-popup';
      popup.innerHTML = `
        <div class="fanyi-popup-header">
          <span class="fanyi-original-text">${escapeHtml(original.substring(0, 50))}${original.length > 50 ? '...' : ''}</span>
          <div class="fanyi-popup-actions">
            <button class="fanyi-copy-btn" title="复制译文">📋</button>
            <button class="fanyi-close-btn" title="关闭">✕</button>
          </div>
        </div>
        <div class="fanyi-popup-content">
          <p class="fanyi-source">${escapeHtml(original)}</p>
          <p class="fanyi-target">${escapeHtml(translated)}</p>
        </div>
      `;

      popup.querySelector('.fanyi-close-btn')?.addEventListener('click', () => {
        popup.remove();
      });

      popup.querySelector('.fanyi-copy-btn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(translated);
        showStatus('已复制', 'success');
        setTimeout(() => hideStatus(), 1000);
      });

      const selection = window.getSelection();
      if (selection?.rangeCount) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        popup.style.left = `${rect.left + window.scrollX}px`;
        popup.style.top = `${rect.bottom + window.scrollY + 8}px`;
      }

      document.body.appendChild(popup);

      setTimeout(() => {
        document.addEventListener('click', (e) => {
          if (!popup.contains(e.target as Node)) {
            popup.remove();
          }
        }, { once: true });
      }, 100);
    }

    function escapeHtml(text: string): string {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    const style = document.createElement('style');
    style.textContent = `
      .fanyi-status-overlay {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 12px 20px;
        background: white;
        border-radius: 8px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.15);
        z-index: 999999;
        font-size: 14px;
        display: none;
      }
      .fanyi-loading { border-left: 4px solid #409eff; }
      .fanyi-success { border-left: 4px solid #67c23a; }
      .fanyi-error { border-left: 4px solid #f56c6c; }

      .fanyi-bilingual-block {
        margin: 4px 0;
        padding: 8px;
        border-radius: 4px;
        background: rgba(64, 158, 255, 0.05);
      }
      .fanyi-source {
        color: #606266;
        margin-bottom: 6px;
        line-height: 1.6;
      }
      .fanyi-target {
        color: #303133;
        font-weight: 500;
        line-height: 1.6;
      }

      .fanyi-selection-popup {
        position: absolute;
        max-width: 400px;
        min-width: 250px;
        background: white;
        border: 1px solid #e4e7ed;
        border-radius: 8px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.15);
        z-index: 999998;
        padding: 12px;
      }
      .fanyi-popup-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
        padding-bottom: 8px;
        border-bottom: 1px solid #ebeef5;
      }
      .fanyi-original-text {
        font-size: 12px;
        color: #909399;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 280px;
      }
      .fanyi-popup-actions {
        display: flex;
        gap: 4px;
      }
      .fanyi-close-btn, .fanyi-copy-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px 8px;
        font-size: 14px;
        border-radius: 4px;
      }
      .fanyi-close-btn:hover, .fanyi-copy-btn:hover {
        background: #f5f7fa;
      }
      .fanyi-popup-content {
        font-size: 14px;
        line-height: 1.6;
      }
      .fanyi-popup-content .fanyi-source {
        color: #606266;
        margin: 0 0 8px;
      }
      .fanyi-popup-content .fanyi-target {
        color: #303133;
        margin: 0;
        font-weight: 500;
      }

      .fanyi-translated {
        position: relative;
      }
    `;
    document.head.appendChild(style);
  },
});
