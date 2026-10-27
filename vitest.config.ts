import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 与 tsconfig.json 的 `paths` 保持一致：测试直接 import 生产模块时
  // 这些模块内部用的是 `@/...`，vite 需要同一个别名才能解析。
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['other-ref/**', '.cross-sync/**', 'node_modules', 'dist'],
  },
});
