// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No Google key reaches the browser by a build-time or bundling path (NFR-8).
 *
 * The browser key leaves the server through one door — the signed-in
 * `mileageRoute.mapConfig` read — and the server key through none. Two other doors
 * would bypass every check on that one, and neither shows up in a router test:
 *
 *   · **A `NEXT_PUBLIC_*` variable.** Next inlines it into the client bundle at build
 *     time, so the key is in public JavaScript that anyone can fetch without signing in.
 *   · **A client import of the key-handling modules.** `import 'server-only'` turns that
 *     into a build error in Next; this pins that the marker is there to do it.
 *
 * The third layer, a canary build grepped for the key, needs a full `next build` and runs
 * as a local command with the map phase rather than in the unit suite.
 */

/** VeloExpense (eos batch 5): the repository root is two levels up (ExpenseOS: five, from
 *  `apps/web/src/server/platform`), and the paths below are VeloExpense's. */
const ROOT = join(__dirname, '..', '..');

/** Built from parts so this file cannot match itself. */
const PUBLIC_MAPS_VAR = new RegExp(`${'NEXT_'}PUBLIC_[A-Z0-9_]*(?:GOOGLE|MAPS)`);

/**
 * Where a variable could be declared or read: code, config, env files, CI, images.
 * `*.local` env files are skipped: they are gitignored and per developer, so scanning
 * them would make this suite's answer depend on whose machine ran it.
 */
const SCANNED = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml)$|^\.env(?!.*\.local$)|^Dockerfile/;
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'coverage',
  'cdk.out',
  'archive',
  'playwright-report',
  'test-results',
  'tasks',
]);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) yield* files(path);
    } else if (SCANNED.test(name)) {
      yield path;
    }
  }
}

describe('the Maps key boundary', () => {
  it('scans the places a variable could live, so an empty result means something', () => {
    const scanned = [...files(ROOT)].map((f) => relative(ROOT, f));
    expect(scanned).toContain('next.config.ts');
    expect(scanned).toContain('server/platform/googleMaps.ts');
    expect(scanned.some((f) => f.startsWith('infrastructure/cdk/lib/'))).toBe(true);
    expect(scanned.some((f) => f.startsWith('.github/workflows/'))).toBe(true);
  });

  it('declares no NEXT_PUBLIC_ Google or Maps variable anywhere', () => {
    const offenders: string[] = [];
    for (const file of files(ROOT)) {
      const text = readFileSync(file, 'utf8');
      if (PUBLIC_MAPS_VAR.test(text)) offenders.push(relative(ROOT, file));
    }
    expect(
      offenders,
      'A NEXT_PUBLIC_ variable is inlined into public JavaScript at build time. The ' +
        'browser key goes out only through mileageRoute.mapConfig; the server key never does.',
    ).toEqual([]);
  });

  it.each([
    'server/platform/googleMaps.ts',
    'server/routers/mileageRoute.ts',
  ])('%s is marked server-only, so a client import fails the build', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text).toMatch(/^import 'server-only';$/m);
  });
});
