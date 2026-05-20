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
  manifest: (env) => {
    const manifest: any = {};
    if (env.browser === 'firefox') {
      manifest.permissions = ['storage', 'contextMenus', 'https://api.deepseek.com/*'];
      // Firefox MV2 doesn't support host_permissions, use permissions instead
      manifest.browser_specific_settings = {
        gecko: {
          id: '{ad94258c-d45d-4b70-93a9-ff88cf914b92}',
          strict_min_version: '109.0',
        },
        gecko_android: {
          strict_min_version: '120.0',
        },
      };
      // Note: default_area is not supported on Firefox Android, removed to avoid warnings
    } else {
      manifest.permissions = ['storage', 'contextMenus'];
    }
    manifest.commands = {
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
    };
    return manifest;
  },
  suppressWarnings: {
    firefoxDataCollection: true,
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
