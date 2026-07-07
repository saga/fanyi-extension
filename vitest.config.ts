import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['other-ref/**', 'node_modules', 'dist'],
  },
});
