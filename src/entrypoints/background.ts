export default defineBackground(() => {
  console.log('Background script loaded');

  browser.runtime.onInstalled.addListener(() => {
    console.log('Extension installed');
  });
});
