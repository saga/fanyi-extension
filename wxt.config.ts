import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  outDir: 'output',
  manifest: {
    permissions: ['storage', 'contextMenus'],
    commands: {
      'translate-page': {
        suggested_key: {
          default: 'Alt+T',
        },
        description: '翻译此页面',
      },
      'translate-selection': {
        suggested_key: {
          default: 'Alt+S',
        },
        description: '划词翻译',
      },
      'restore-original': {
        suggested_key: {
          default: 'Alt+R',
        },
        description: '恢复原文',
      },
      'toggle-translation': {
        suggested_key: {
          default: 'Alt+V',
        },
        description: '切换译文显示',
      },
    },
  },
  srcDir: 'src',
});
