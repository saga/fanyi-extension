import browser from 'webextension-polyfill';
import {
  prepareDocument,
  type Chunk,
} from './utils/contentHelper';
import { buildNodeMap } from './utils/blockExtractor';
import { getConfig, setConfig } from './utils/config';
import { DOMObserverManager } from './utils/domObserver';
import type { TextBlock } from './utils/blockExtractor';
import { GESTURES } from './utils/constants';
import { getCenterPoint } from './utils/common';

// Detect if we're on mobile/Android Firefox
const isAndroid = /Android/i.test(navigator.userAgent);
const isMobile = isAndroid || /iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

export default defineContentScript({
  matches: ['*://*/*'],
  main() {
    console.log('Content script loaded, isAndroid:', isAndroid, 'isMobile:', isMobile);

    let isTranslating = false;
    let translationOverlay: HTMLElement | null = null;
    let originalTexts = new Map<string, string>();
    let translatedBlocks = new Set<string>();
    let domObserver: DOMObserverManager | null = null;

    browser.runtime.onMessage.addListener(async (message) => {
      if (message.action === 'translatePage') {
        await handleFullTranslation();
      } else if (message.action === 'restoreOriginal') {
        restoreOriginal();
      } else if (message.action === 'toggleTranslation') {
        toggleTranslation();
      }
    });

    setupTouchEvents();
    setupFloatingButton();

    function setupTouchEvents() {
      let tapCount = 0;
      let tapTimer: number | undefined;

      document.body.addEventListener('touchstart', async (event: TouchEvent) => {
        // Ignore if touching UI elements
        const target = event.target as Element;
        if (target.closest('.fanyi-config-panel') || 
            target.closest('.fanyi-floating-btn') || 
            target.closest('.fanyi-status-overlay')) {
          return;
        }

        const config = await getConfig();
        const gesture = config.touchGesture || 'DoubleTap';

        const multiFingerGestures = [GESTURES.TwoFinger, GESTURES.ThreeFinger, GESTURES.FourFinger];
        const tapGestures = [GESTURES.DoubleTap, GESTURES.TripleTap];

        if (multiFingerGestures.includes(gesture)) {
          const requiredFingers = gesture === GESTURES.TwoFinger ? 2 : gesture === GESTURES.ThreeFinger ? 3 : 4;
          if (event.touches.length === requiredFingers) {
            const center = getCenterPoint(event.touches, requiredFingers);
            if (center && config.enabled) {
              try { event.preventDefault(); } catch(e) {}
              handleFullTranslation();
            }
          }
          return;
        }

        if (tapGestures.includes(gesture)) {
          if (event.touches.length !== 1) return;

          const requiredTaps = gesture === GESTURES.DoubleTap ? 2 : 3;
          tapCount++;

          if (tapCount === 1) {
            tapTimer = window.setTimeout(() => {
              tapCount = 0;
            }, 500);
          } else if (tapCount === requiredTaps) {
            if (tapTimer) clearTimeout(tapTimer);
            tapCount = 0;
            if (config.enabled) {
              try { event.preventDefault(); } catch(e) {}
              handleFullTranslation();
            }
          }
        }
      }, { passive: true });
    }

    function setupFloatingButton() {
      const btn = document.createElement('div');
      btn.className = 'fanyi-floating-btn';
      btn.innerHTML = '译';
      btn.title = isMobile ? '点击翻译，长按设置' : '点击翻译，长按设置';

      // Load saved position
      const savedPosition = localStorage.getItem('fanyi-btn-position');
      if (savedPosition) {
        try {
          const pos = JSON.parse(savedPosition);
          btn.style.right = pos.right + 'px';
          btn.style.bottom = pos.bottom + 'px';
        } catch {
          // Use defaults based on device
          btn.style.right = isMobile ? '12px' : '20px';
          btn.style.bottom = isMobile ? '100px' : '100px';
        }
      } else {
        btn.style.right = isMobile ? '12px' : '20px';
        btn.style.bottom = isMobile ? '100px' : '100px';
      }

      let isDragging = false;
      let startX = 0, startY = 0;
      let startRight = 0, startBottom = 0;
      let longPressTimer: number | null = null;
      let hasMoved = false;

      btn.addEventListener('mousedown', startDrag);
      btn.addEventListener('touchstart', startDrag, { passive: false });

      function startDrag(e: MouseEvent | TouchEvent) {
        try { e.preventDefault(); } catch(err) {}
        hasMoved = false;
        isDragging = false;

        longPressTimer = window.setTimeout(() => {
          if (!hasMoved) {
            showConfigPanel();
          }
        }, isMobile ? 500 : 600);

        if (e instanceof MouseEvent) {
          startX = e.clientX;
          startY = e.clientY;
        } else {
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
        }

        const rect = btn.getBoundingClientRect();
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;

        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', endDrag);
        document.addEventListener('touchmove', onDrag, { passive: false });
        document.addEventListener('touchend', endDrag);
      }

      function onDrag(e: MouseEvent | TouchEvent) {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }

        let clientX: number, clientY: number;
        if (e instanceof MouseEvent) {
          clientX = e.clientX;
          clientY = e.clientY;
        } else {
          clientX = e.touches[0].clientX;
          clientY = e.touches[0].clientY;
        }

        const dx = Math.abs(clientX - startX);
        const dy = Math.abs(clientY - startY);
        const moveThreshold = isMobile ? 10 : 5;

        if (dx > moveThreshold || dy > moveThreshold) {
          hasMoved = true;
          isDragging = true;
        }

        if (isDragging) {
          const newRight = window.innerWidth - clientX - btn.offsetWidth / 2;
          const newBottom = window.innerHeight - clientY - btn.offsetHeight / 2;
          btn.style.right = Math.max(0, Math.min(newRight, window.innerWidth - btn.offsetWidth)) + 'px';
          btn.style.bottom = Math.max(0, Math.min(newBottom, window.innerHeight - btn.offsetHeight)) + 'px';
        }

        if (e instanceof TouchEvent) {
          try { e.preventDefault(); } catch(err) {}
        }
      }

      function endDrag() {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }

        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', endDrag);
        document.removeEventListener('touchmove', onDrag);
        document.removeEventListener('touchend', endDrag);

        if (!hasMoved) {
          handleFullTranslation();
        } else {
          const right = parseInt(btn.style.right) || (isMobile ? 12 : 20);
          const bottom = parseInt(btn.style.bottom) || 100;
          localStorage.setItem('fanyi-btn-position', JSON.stringify({ right, bottom }));
        }

        isDragging = false;
      }

      document.body.appendChild(btn);
    }

    function showConfigPanel() {
      const existing = document.querySelector('.fanyi-config-panel');
      if (existing) {
        existing.remove();
        return;
      }

      const panel = document.createElement('div');
      panel.className = 'fanyi-config-panel';
      panel.innerHTML = `
        <div class="fanyi-config-header">
          <span>翻译设置</span>
          <button class="fanyi-config-close">&times;</button>
        </div>
        <div class="fanyi-config-body">
          <div class="fanyi-config-row">
            <label>DeepSeek API Key</label>
            <input type="password" class="fanyi-api-input" placeholder="输入 DeepSeek API Key" />
          </div>
          <div class="fanyi-config-row">
            <label>源语言</label>
            <select class="fanyi-source-lang">
              <option value="auto">自动检测</option>
              <option value="en">英语</option>
              <option value="zh">中文</option>
              <option value="ja">日语</option>
            </select>
          </div>
          <div class="fanyi-config-row">
            <label>目标语言</label>
            <select class="fanyi-target-lang">
              <option value="zh">中文</option>
              <option value="en">英语</option>
              <option value="ja">日语</option>
            </select>
          </div>
          <div class="fanyi-config-row">
            <label>翻译模式</label>
            <div class="fanyi-radio-group">
              <label><input type="radio" name="mode" value="bilingual" /> 双语对照</label>
              <label><input type="radio" name="mode" value="target" /> 仅译文</label>
            </div>
          </div>
          ${isMobile ? `
          <div class="fanyi-config-row">
            <label>触摸手势</label>
            <select class="fanyi-touch-gesture">
              <option value="DoubleTap">双击翻译</option>
              <option value="TripleTap">三击翻译</option>
              <option value="TwoFinger">双指翻译</option>
              <option value="ThreeFinger">三指翻译</option>
              <option value="FourFinger">四指翻译</option>
            </select>
          </div>
          ` : ''}
          <div class="fanyi-config-actions">
            <button class="fanyi-btn-save">保存</button>
            <button class="fanyi-btn-translate">翻译</button>
            <button class="fanyi-btn-restore">恢复</button>
          </div>
        </div>
      `;

      getConfig().then(config => {
        (panel.querySelector('.fanyi-api-input') as HTMLInputElement).value = config.deepseekApiKey || '';
        (panel.querySelector('.fanyi-source-lang') as HTMLSelectElement).value = config.sourceLang || 'auto';
        (panel.querySelector('.fanyi-target-lang') as HTMLSelectElement).value = config.targetLang || 'zh';
        const modeRadio = panel.querySelector(`input[name="mode"][value="${config.mode || 'bilingual'}"]`) as HTMLInputElement;
        if (modeRadio) modeRadio.checked = true;
        
        if (isMobile) {
          const gestureSelect = panel.querySelector('.fanyi-touch-gesture') as HTMLSelectElement;
          if (gestureSelect) gestureSelect.value = config.touchGesture || 'DoubleTap';
        }
      });

      panel.querySelector('.fanyi-config-close')?.addEventListener('click', () => panel.remove());

      panel.querySelector('.fanyi-btn-save')?.addEventListener('click', async () => {
        const apiKey = (panel.querySelector('.fanyi-api-input') as HTMLInputElement).value.trim();
        if (!apiKey) {
          showStatus('API Key 不能为空', 'error');
          setTimeout(() => hideStatus(), 2000);
          return;
        }

        showStatus('正在验证 API Key...', 'loading');

        try {
          const response = await browser.runtime.sendMessage({
            action: 'validateApiKey',
            apiKey,
          });

          console.log('[ContentScript] Validation response:', response);

          if (response && response.success) {
            const config = await getConfig();
            config.deepseekApiKey = apiKey;
            config.sourceLang = (panel.querySelector('.fanyi-source-lang') as HTMLSelectElement).value;
            config.targetLang = (panel.querySelector('.fanyi-target-lang') as HTMLSelectElement).value;
            const modeRadio = panel.querySelector('input[name="mode"]:checked') as HTMLInputElement;
            config.mode = modeRadio?.value || 'bilingual';
            
            if (isMobile) {
              const gestureSelect = panel.querySelector('.fanyi-touch-gesture') as HTMLSelectElement;
              if (gestureSelect) config.touchGesture = gestureSelect.value;
            }
            
            await setConfig(config);
            showStatus('设置已保存', 'success');
            setTimeout(() => hideStatus(), 2000);
          } else {
            const errorMsg = response?.error || '未知错误';
            console.error('[ContentScript] Validation failed:', errorMsg);
            showStatus('API Key 无效: ' + errorMsg, 'error');
            setTimeout(() => hideStatus(), 5000);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : '网络错误';
          console.error('[ContentScript] Validation error:', error);
          showStatus('验证失败: ' + errorMsg, 'error');
          setTimeout(() => hideStatus(), 5000);
        }
      });

      panel.querySelector('.fanyi-btn-translate')?.addEventListener('click', () => {
        panel.remove();
        handleFullTranslation();
      });

      panel.querySelector('.fanyi-btn-restore')?.addEventListener('click', () => {
        panel.remove();
        restoreOriginal();
      });

      // Close when clicking outside (desktop only)
      if (!isMobile) {
        setTimeout(() => {
          document.addEventListener('click', function closeOnOutside(ev: MouseEvent) {
            if (!panel.contains(ev.target as Node) && 
                !(ev.target as Element).closest('.fanyi-floating-btn')) {
              panel.remove();
              document.removeEventListener('click', closeOnOutside);
            }
          });
        }, 0);
      }

      document.body.appendChild(panel);
    }

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
        console.log(`[ContentScript] API Request Estimate: ${chunks.length} requests`);

        if (blocks.length === 0) {
          console.warn('[ContentScript] No blocks found!');
          throw new Error('没有找到可翻译的内容');
        }

        showStatus(
          `共 ${blocks.length} 个文本块`,
          'loading'
        );

        const nodeMap = buildNodeMap(blocks, document);
        saveOriginalTexts(blocks, nodeMap);

        await translateChunksViaBackground(
          chunks,
          config.sourceLang,
          config.targetLang,
          nodeMap,
          config.mode,
          (current, total) => {
            showStatus(`翻译进度: ${current}/${total}`, 'loading');
          }
        );

        translatedBlocks = new Set(nodeMap.keys());

        console.log(`[ContentScript] Translation applied: ${nodeMap.size} blocks translated`);

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

    async function translateChunksViaBackground(
      chunks: Chunk[],
      sourceLang: string,
      targetLang: string,
      nodeMap: Map<string, Node>,
      mode: 'bilingual' | 'target',
      onProgress?: (current: number, total: number) => void
    ): Promise<void> {
      console.log('[ContentScript] translateChunksViaBackground called, chunks:', chunks.length);
      let completedCount = 0;

      async function translateChunk(index: number): Promise<void> {
        const chunk = chunks[index];
        console.log(`[ContentScript] Translating chunk ${index + 1}/${chunks.length}, blocks: ${chunk.blocks.length}`);

        const startTime = Date.now();
        
        try {
          const response = await browser.runtime.sendMessage({
            action: 'translateChunk',
            jsonContent: chunk.jsonContent,
            sourceLang,
            targetLang,
            pageUrl: window.location.href,
          });
          
          const elapsed = Date.now() - startTime;
          console.log(`[ContentScript] Chunk ${index + 1} response time: ${elapsed}ms, success: ${response.success}`);

          if (response.success) {
            console.log(`[ContentScript] Chunk ${index + 1} result blocks:`, response.result?.length || 0);
            const chunkMap = new Map<string, string>();
            for (const [id, text] of response.result) {
              chunkMap.set(id, text);
            }
            applyTranslations(chunkMap, nodeMap, mode);
          } else {
            console.error(`Chunk ${chunk.id} translation failed:`, response.error);
          }
        } catch (error) {
          console.error(`[ContentScript] Chunk ${index + 1} error:`, error);
        }

        completedCount++;
        onProgress?.(completedCount, chunks.length);
      }

      // Process chunks sequentially for better mobile performance
      for (let i = 0; i < chunks.length; i++) {
        await translateChunk(i);
        // Small delay between chunks
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, isMobile ? 200 : 100));
        }
      }

      console.log('[ContentScript] translateChunksViaBackground complete');
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
          
          const config = await getConfig();
          for (const block of newBlocks) {
            if (block.text && block.text.length > 10) {
              try {
                const response = await browser.runtime.sendMessage({
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
                    translatedBlocks.add(block.id);
                    console.log('[ContentScript] Dynamic block translated:', block.id);
                  }
                }
              } catch (error) {
                console.error('Dynamic content translation failed:', error);
              }
            }
          }
        },
        () => {},
        isMobile ? 1500 : 1000
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

    function escapeHtml(text: string): string {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    const style = document.createElement('style');
    style.textContent = `
      .fanyi-status-overlay {
        position: fixed;
        bottom: ${isMobile ? '60px' : '20px'};
        left: 50%;
        transform: translateX(-50%);
        padding: 8px 14px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        border-radius: 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        z-index: 999999;
        font-size: ${isMobile ? '12px' : '13px'};
        display: none;
        max-width: 80%;
        text-align: center;
      }
      .fanyi-loading { border: 1px solid #409eff; }
      .fanyi-success { border: 1px solid #67c23a; }
      .fanyi-error { border: 1px solid #f56c6c; }

      .fanyi-bilingual-block {
        margin: 6px 0;
        padding: 10px;
        border-radius: 6px;
        background: rgba(64, 158, 255, 0.08);
      }
      .fanyi-source {
        color: #606266;
        margin-bottom: 8px;
        line-height: 1.6;
        font-size: 0.95em;
      }
      .fanyi-target {
        color: #303133;
        font-weight: 500;
        line-height: 1.6;
      }

      .fanyi-translated {
        position: relative;
      }

      .fanyi-floating-btn {
        position: fixed;
        right: ${isMobile ? '12px' : '16px'};
        bottom: ${isMobile ? '80px' : '80px'};
        width: ${isMobile ? '32px' : '32px'};
        height: ${isMobile ? '32px' : '32px'};
        background: #409eff;
        color: white;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: ${isMobile ? '14px' : '13px'};
        font-weight: bold;
        opacity: 0.85;
        box-shadow: 0 4px 12px rgba(64, 158, 255, 0.4);
        z-index: 999998;
        cursor: pointer;
        user-select: none;
        touch-action: none;
        -webkit-tap-highlight-color: transparent;
        transition: transform 0.2s ease, opacity 0.2s ease;
      }
      .fanyi-floating-btn:hover {
        background: #66b1ff;
        opacity: 1;
      }
      .fanyi-floating-btn:active {
        transform: scale(0.9);
      }

      .fanyi-config-panel {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: ${isMobile ? '92%' : '90%'};
        max-width: ${isMobile ? '400px' : '340px'};
        max-height: ${isMobile ? '88vh' : '85vh'};
        background: white;
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        z-index: 999999;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        font-size: ${isMobile ? '15px' : '13px'};
      }
      .fanyi-config-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: ${isMobile ? '16px 18px' : '12px 16px'};
        background: linear-gradient(135deg, #409eff, #66b1ff);
        color: white;
        font-size: ${isMobile ? '17px' : '15px'};
        font-weight: 600;
      }
      .fanyi-config-close {
        background: none;
        border: none;
        font-size: ${isMobile ? '24px' : '20px'};
        cursor: pointer;
        padding: 4px 10px;
        color: white;
        opacity: 0.9;
      }
      .fanyi-config-close:hover {
        opacity: 1;
      }
      .fanyi-config-body {
        padding: ${isMobile ? '18px' : '14px'};
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: ${isMobile ? '14px' : '12px'};
      }
      .fanyi-config-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .fanyi-config-row label {
        font-size: ${isMobile ? '13px' : '12px'};
        color: #606266;
        font-weight: 500;
      }
      .fanyi-api-input,
      .fanyi-source-lang,
      .fanyi-target-lang,
      .fanyi-touch-gesture {
        padding: ${isMobile ? '12px 14px' : '10px 12px'};
        border: 1px solid #e0e0e0;
        border-radius: 10px;
        font-size: ${isMobile ? '15px' : '14px'};
        -webkit-appearance: none;
        appearance: none;
        background: #fafafa;
      }
      .fanyi-api-input:focus,
      .fanyi-source-lang:focus,
      .fanyi-target-lang:focus,
      .fanyi-touch-gesture:focus {
        outline: none;
        border-color: #409eff;
        background: white;
      }
      .fanyi-radio-group {
        display: flex;
        gap: ${isMobile ? '20px' : '16px'};
        flex-wrap: wrap;
      }
      .fanyi-radio-group label {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        font-size: ${isMobile ? '14px' : '13px'};
        color: #303133;
      }
      .fanyi-radio-group input[type="radio"] {
        width: ${isMobile ? '20px' : '18px'};
        height: ${isMobile ? '20px' : '18px'};
        margin: 0;
        accent-color: #409eff;
      }
      .fanyi-config-actions {
        display: flex;
        gap: ${isMobile ? '10px' : '8px'};
        padding-top: ${isMobile ? '10px' : '8px'};
        margin-top: auto;
      }
      .fanyi-btn-save,
      .fanyi-btn-translate,
      .fanyi-btn-restore {
        flex: 1;
        padding: ${isMobile ? '12px 14px' : '10px 12px'};
        border: 1px solid #e0e0e0;
        border-radius: 10px;
        background: white;
        cursor: pointer;
        font-size: ${isMobile ? '14px' : '13px'};
        font-weight: 600;
        white-space: nowrap;
      }
      .fanyi-btn-save {
        background: linear-gradient(135deg, #409eff, #66b1ff);
        color: white;
        border: none;
      }
      .fanyi-btn-translate {
        background: linear-gradient(135deg, #67c23a, #85ce61);
        color: white;
        border: none;
      }
      .fanyi-btn-restore {
        background: linear-gradient(135deg, #e6a23c, #ebb563);
        color: white;
        border: none;
      }
      .fanyi-btn-save:active,
      .fanyi-btn-translate:active,
      .fanyi-btn-restore:active {
        opacity: 0.8;
        transform: scale(0.98);
      }
    `;
    document.head.appendChild(style);
  },
});
