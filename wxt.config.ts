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
      // 桌面 Firefox 完整支持 contextMenus，Android Firefox 会静默忽略不支持的 API。
      // 网页翻译和网页对话需要直接访问用户打开的任意网站，因此安装时申请全站访问。
      // Firefox 不实现 Chrome debugger API；页面读取仍由 Content Script + Scripting 完成。
      manifest.permissions = [
        'storage',
        'contextMenus',
        'tabs',
        'activeTab',
        'scripting',
        '<all_urls>',
      ];
      // Optional Firefox desktop Containers support; Android may not expose this API.
      // Page Control 按需申请网络监听 / 响应流读取 / Cookie 访问权限。
      manifest.optional_permissions = [
        'contextualIdentities',
        'cookies',
        'webRequest',
        'webRequestBlocking',
      ];
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
      // debugger 用于常规页面读取失败时的 Chrome DevTools Protocol 兜底。
      // <all_urls> 覆盖网页翻译、网页对话和自定义 API 主机，不再逐站点申请权限。
      manifest.permissions = [
        'storage',
        'contextMenus',
        'debugger',
        'tabs',
        'activeTab',
        'scripting',
        'offscreen',
      ];
      // 网络监听与 Cookie API 由 Page Control 在用户启用时申请。
      manifest.optional_permissions = ['cookies', 'webRequest'];
      manifest.host_permissions = ['<all_urls>'];
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
