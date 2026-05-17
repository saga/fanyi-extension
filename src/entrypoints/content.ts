import { analyzeDocument, translateChunks, translateText } from './utils/translateApi';
import { buildNodeMap } from './utils/blockExtractor';
import { getConfig } from './utils/config';

export default defineContentScript({
  matches: ['*://*/*'],
  main() {
    console.log('Content script loaded');

    let isTranslating = false;
    let translationOverlay: HTMLElement | null = null;

    browser.runtime.onMessage.addListener(async (message) => {
      if (message.action === 'translatePage') {
        await handleFullTranslation();
      } else if (message.action === 'translateSelection') {
        await handleSelectionTranslation(message.text);
      }
    });

    async function handleFullTranslation() {
      if (isTranslating) return;

      const config = await getConfig();
      if (!config.enabled) return;

      isTranslating = true;
      showStatus('正在分析文档...', 'loading');

      try {
        const { blocks, analysis, chunks } = await analyzeDocument(document);

        showStatus(
          `分析完成，共 ${blocks.length} 个文本块，${chunks.length} 个翻译块`,
          'loading'
        );

        const nodeMap = buildNodeMap(blocks, document);

        const translationMap = await translateChunks(
          chunks,
          analysis,
          (current, total) => {
            showStatus(`翻译进度: ${current}/${total}`, 'loading');
          }
        );

        applyTranslations(translationMap, nodeMap, config.mode);
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
        const translated = await translateText(text);
        showSelectionPopup(translated, text);
      } catch (error) {
        console.error('Selection translation failed:', error);
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
      }
    }

    function escapeHtml(text: string): string {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
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
          <button class="fanyi-close-btn">✕</button>
        </div>
        <div class="fanyi-popup-content">
          <p class="fanyi-source">${escapeHtml(original)}</p>
          <p class="fanyi-target">${escapeHtml(translated)}</p>
        </div>
      `;

      popup.querySelector('.fanyi-close-btn')?.addEventListener('click', () => {
        popup.remove();
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
      }
      .fanyi-source {
        color: #606266;
        margin-bottom: 4px;
      }
      .fanyi-target {
        color: #303133;
        font-weight: 500;
      }

      .fanyi-selection-popup {
        position: absolute;
        max-width: 400px;
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
        max-width: 320px;
      }
      .fanyi-close-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        font-size: 14px;
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
    `;
    document.head.appendChild(style);
  },
});
