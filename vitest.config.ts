import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['other-ref/**', '.cross-sync/**', 'node_modules', 'dist'],
  },
});
