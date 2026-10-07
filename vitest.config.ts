import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(`./${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Code ported from ExpenseOS keeps its package imports (`@expenseos/rbac`, …); these
      // mirror tsconfig.json's `paths`, which vitest does not read.
      { find: /^@expenseos\/rbac\/server$/, replacement: r('packages/rbac/src/server.ts') },
      { find: /^@expenseos\/rbac\/(.*)$/, replacement: r('packages/rbac/src/$1.ts') },
      { find: /^@expenseos\/rbac$/, replacement: r('packages/rbac/src/index.ts') },
      { find: /^@expenseos\/platform$/, replacement: r('server/platform/modules.ts') },
      { find: /^@expenseos\/i18n\/catalogs\/(.*)$/, replacement: r('packages/i18n/src/catalogs/$1.json') },
      { find: /^@expenseos\/i18n\/(.*)$/, replacement: r('packages/i18n/src/$1.ts') },
      { find: /^@expenseos\/i18n$/, replacement: r('packages/i18n/src/index.ts') },
      { find: /^@expenseos\/design-system$/, replacement: r('packages/design-system/src/index.ts') },
      { find: /^@\//, replacement: r('') },
    ],
  },
  test: {
    environment: 'node',
    // ExpenseOS's setting. Testing Library unmounts between tests through a global
    // `afterEach`, so without it the ported DOM tests see the previous test's render.
    globals: true,
    include: [
      'test/**/*.test.ts',
      // Tests ported from ExpenseOS stay beside the code they test, as they were there.
      '{packages,server,lib,app,components,i18n}/**/*.test.{ts,tsx}',
    ],
    // ExpenseOS runs its colocated tests under jsdom (its `unit` project); a file that
    // needs node says so with `// @vitest-environment node`, as several do.
    environmentMatchGlobs: [['{packages,server,lib,app,components,i18n}/**/*.test.{ts,tsx}', 'jsdom']],
    // Fails the run ONCE, naming the shell, when DATABASE_URL /
    // ADMIN_DATABASE_URL are missing or point at nothing. Without it a
    // forgotten `. scripts/dev-env.sh` surfaces as 55 files reporting
    // `database "<your login>" does not exist` — a message that names the
    // database for a fault that is entirely in the shell. See the file.
    globalSetup: ['./test/support/require-db-env.ts'],
    // ExpenseOS's per-file setup for its component tests (jsdom polyfills, jest-dom).
    setupFiles: ['./test/support/ported-dom-setup.ts'],
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
