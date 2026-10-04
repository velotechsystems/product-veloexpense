/**
 * VX2-10 — the post-e2e audit-chain verification, on its own.
 *
 * The Phase-2 board asks for "chain verification runs on every build", and until
 * this ticket it did not: `verifyChain` was exercised by `test/audit.db.test.ts`
 * and by VX2-9's suite, over rows those suites wrote themselves. That proves the
 * verifier works. It does not prove the APPLICATION writes a verifiable chain.
 *
 * This config runs one file, after the seed and after the e2e, against whatever
 * the app actually wrote through its real paths — which is the only version of
 * the check that could catch a regression in `lib/audit/chain.ts` or in a caller
 * that hands it a payload the canonicalizer treats differently.
 *
 *   npx vitest run --config vitest.chain.config.ts
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['test/**/*.check.ts'],
    // Same guard as the main config. This file runs LAST in `npm run e2e`, so
    // an environment fault here would otherwise appear after the whole build
    // and seed had already gone by, as far from its cause as it can get.
    globalSetup: ['./test/support/require-db-env.ts'],
    fileParallelism: false,
  },
});
