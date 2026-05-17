export default defineBackground(() => {
  console.log('Background script loaded');

  browser.runtime.onInstalled.addListener(() => {
    console.log('Extension installed');

    browser.contextMenus.create({
      id: 'translate-page',
      title: '翻译此页面',
      contexts: ['page'],
    });

    browser.contextMenus.create({
      id: 'translate-selection',
      title: '翻译选中内容',
      contexts: ['selection'],
    });

    browser.contextMenus.create({
      id: 'restore-original',
      title: '恢复原文',
      contexts: ['page'],
    });

    browser.contextMenus.create({
      id: 'toggle-translation',
      title: '切换译文显示',
      contexts: ['page'],
    });
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;

    switch (info.menuItemId) {
      case 'translate-page':
        browser.tabs.sendMessage(tab.id, { action: 'translatePage' });
        break;
      case 'translate-selection':
        browser.tabs.sendMessage(tab.id, {
          action: 'translateSelection',
          text: info.selectionText,
        });
        break;
      case 'restore-original':
        browser.tabs.sendMessage(tab.id, { action: 'restoreOriginal' });
        break;
      case 'toggle-translation':
        browser.tabs.sendMessage(tab.id, { action: 'toggleTranslation' });
        break;
    }
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'proxyRequest') {
      handleProxyRequest(message, sendResponse);
      return true;
    }

    if (message.action === 'clearCache') {
      handleClearCache(sendResponse);
      return true;
    }

    if (message.action === 'translatePage') {
      if (sender.tab?.id) {
        browser.tabs.sendMessage(sender.tab.id, { action: 'translatePage' });
      }
    }
  });

  async function handleProxyRequest(
    message: any,
    sendResponse: (response: any) => void
  ) {
    try {
      const { url, method, headers, body } = message;

      const response = await fetch(url, {
        method: method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = await response.json();
      sendResponse({ success: true, data });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleClearCache(sendResponse: (response: any) => void) {
    try {
      await browser.storage.local.clear();
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
});
