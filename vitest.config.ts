import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // VX2-10. `chain-verify.check.ts` is deliberately OUTSIDE the normal run and
    // has its own config, because it verifies the database AS IT STANDS rather
    // than data it wrote itself. Two reasons it cannot live here:
    //   · `test/rls-isolation.test.ts` inserts audit rows with DELIBERATELY fake
    //     hashes ('a'.repeat(64) — it tests RLS, not the chain), so a real
    //     verification running after it would fail on correct code;
    //   · it has to run AFTER the seed and the e2e to be worth anything, and
    //     `npm test` runs before both.
    // Named `.check.ts` rather than `.test.ts` as a second line of defence, so a
    // future glob change cannot silently pull it back in.
    exclude: ['test/**/*.check.ts', 'node_modules/**'],
    // The DB tests share ONE Postgres database and each TRUNCATEs in beforeAll,
    // so they must not run concurrently: parallel files race and fail with
    // duplicate-slug and FK-violation errors (two files were already racing;
    // adding a third made it deterministic). Keep this false while the suites
    // share a database.
    fileParallelism: false,
  },
});
