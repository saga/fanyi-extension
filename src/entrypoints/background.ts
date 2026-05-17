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
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;

    if (info.menuItemId === 'translate-page') {
      browser.tabs.sendMessage(tab.id, { action: 'translatePage' });
    } else if (info.menuItemId === 'translate-selection') {
      browser.tabs.sendMessage(tab.id, {
        action: 'translateSelection',
        text: info.selectionText,
      });
    }
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'translatePage') {
      if (sender.tab?.id) {
        browser.tabs.sendMessage(sender.tab.id, { action: 'translatePage' });
      }
    }
  });
});
