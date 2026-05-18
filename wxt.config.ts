import { defineConfig } from 'wxt';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  modules: ['@wxt-dev/module-vue', '@wxt-dev/webextension-polyfill'],
  outDir: 'output',
  srcDir: 'src',
  vite: () => ({
    build: {
      minify: false,
    },
  }),
  manifest: {
    permissions: ['storage', 'contextMenus'],
    commands: {
      'translate-page': {
        suggested_key: {
          default: 'Alt+T',
        },
        description: '翻译此页面',
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
  hooks: {
    'build:done': async (wxt, output) => {
      const chromeDir = join(process.cwd(), 'output', 'chrome-mv3');
      if (existsSync(chromeDir)) fixHtmlPaths(chromeDir);

      const firefoxDir = join(process.cwd(), 'output', 'firefox-mv2');
      if (existsSync(firefoxDir)) fixHtmlPaths(firefoxDir);
    },
  },
});

function fixHtmlPaths(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      fixHtmlPaths(fullPath);
    } else if (entry.name.endsWith('.html')) {
      let content = readFileSync(fullPath, 'utf-8');
      content = content.replace(/src="\//g, 'src="./').replace(/href="\//g, 'href="./');
      writeFileSync(fullPath, content);
    }
  }
}
