import { defineConfig } from 'wxt';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  modules: ['@wxt-dev/module-vue', '@wxt-dev/webextension-polyfill'],
  outDir: 'output',
  srcDir: 'src',
  vite: () => ({
    build: {
      // 关闭 minify / uglify，便于在 DevTools 调试 content script。
      // 注意：dev 和 build 都走这个配置，意味着 *所有* 产出（包含
      // `pnpm zip` 出的 release 包）都是可读的。release 前如果要
      // 重新开启 minify，单独写一个 `mode === 'production'` 分支即可。
      // 参考：
      //   - https://wxt.dev/api/config.html#vite
      //   - https://vite.dev/config/build-options#build-minify
      minify: false,
    },
  }),
  manifest: (env) => {
    const manifest: any = {
      name: '简简单单翻译',
      description: '浏览器翻译插件 - 支持 Chrome, Firefox, Android Firefox'
    };

    if (env.browser === 'firefox') {
      // Firefox (Desktop & Android)
      // 需要访问默认翻译服务端 s.sunxiunan.com，以及 DeepSeek API。
      manifest.permissions = ['storage', 'https://s.sunxiunan.com/*', 'https://ss.dal.workers.dev/*', 'https://api.deepseek.com/*'];
      manifest.browser_specific_settings = {
        gecko: {
          id: '{ad94258c-d45d-4b70-93a9-ff88cf914b92}',
          strict_min_version: '109.0',
        },
        gecko_android: {
          strict_min_version: '120.0',
        },
      };
    } else {
      // Chrome & other Chromium browsers
      manifest.permissions = ['storage', 'contextMenus'];
      manifest.host_permissions = ['https://api.deepseek.com/*'];
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
    }
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
