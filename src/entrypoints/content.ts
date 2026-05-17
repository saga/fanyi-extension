export default defineContentScript({
  matches: ['*://*/*'],
  main() {
    console.log('Content script loaded');
  },
});
