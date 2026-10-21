// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No React Query persister anywhere in the web app (NFR-13, paralegal B1 and B4).
 *
 * A mileage line's drawn path and pass-through points reach the writer's browser through
 * React Query, and they must never reach browser storage: the in-memory client cache dies
 * on reload, and that is the only cache they may sit in. A persister would write every
 * cached query — paths included — to `localStorage` or IndexedDB, and outlive the 30-day
 * rule the server enforces. Beside the service worker's test because it is the same
 * promise: nothing from `/api/*` is kept on the device.
 *
 * This fails when any non-test source file under `apps/web/src` names one of TanStack's
 * persister entry points.
 *
 * VeloExpense (eos batch 5): ExpenseOS's `apps/web/src/sw/noQueryPersister.test.ts`
 * (67db2e33). VeloExpense has no service worker folder, so it lives in `test/`, and the web
 * source is the repository's `app`, `components`, `lib` and `hooks`.
 */

const WEB = join(__dirname, '..');
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks'];

const PERSISTERS = [
  'persistQueryClient',
  'PersistQueryClientProvider',
  'createSyncStoragePersister',
  'createAsyncStoragePersister',
  'experimental_createPersister',
];

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) {
      yield path;
    }
  }
}

const files = SOURCE_DIRS.flatMap((dir) => [...sourceFiles(join(WEB, dir))]).map((path) => ({
  path: relative(WEB, path),
  text: readFileSync(path, 'utf8'),
}));

describe('React Query is never persisted', () => {
  it('scans the web source, so an empty answer means something', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((f) => f.path)).toContain('lib/trpc/client.tsx');
  });

  it('no source file names a persister', () => {
    const naming = files
      .filter((f) => PERSISTERS.some((name) => f.text.includes(name)))
      .map((f) => f.path);
    expect(naming).toEqual([]);
  });
});
