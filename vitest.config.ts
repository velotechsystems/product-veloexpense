import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The DB tests share ONE Postgres database and each TRUNCATEs in beforeAll,
    // so they must not run concurrently: parallel files race and fail with
    // duplicate-slug and FK-violation errors (two files were already racing;
    // adding a third made it deterministic). Keep this false while the suites
    // share a database.
    fileParallelism: false,
  },
});
