import { defineConfig } from 'vitest/config';

// Standalone config, so the app's root vitest.config.ts (test/**) never picks these up.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
