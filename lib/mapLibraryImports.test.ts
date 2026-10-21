// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The map library stays out of every page's first load (NFR-11, TR-14).
 *
 * `@vis.gl/react-google-maps` is about the size of a small page on its own, and it is
 * needed only while the route picker is open with a browser key, while a saved mileage
 * line on screen draws its small map, or while an admin checks that key. The bundler splits a module into its own chunk only when everything
 * that reaches it does so through a dynamic `import()`; ONE static import anywhere on
 * the expense page's graph and the library is in that page's first load for everybody,
 * map or no map. Nothing at runtime would show it — the page just gets heavier.
 *
 * So, from the source:
 *   · exactly three files import the library — `RouteMap.tsx`, `RouteLineMap.tsx` and
 *     `MapKeyProbe.tsx`;
 *   · nothing imports any of those three except through a dynamic `import()` wrapped in
 *     `React.lazy` (a type-only import is erased and allowed);
 *   · the version is pinned exactly, as ruled.
 *
 * Test files are left out of the scan: they mock the library, which loads nothing.
 *
 * VeloExpense (eos batch 5): the app's source is the repository's `app`, `components` and
 * `lib` (ExpenseOS: `apps/web/src`), and there is no admin key check (`MapKeyProbe`), since
 * the keys are platform settings rather than pasted per tenant (`server/platform/googleMaps.ts`)
 * — so two files import the library, not three.
 */

const WEB = join(__dirname, '..');
const SOURCE_DIRS = ['app', 'components', 'lib'];
const LIBRARY = '@vis.gl/react-google-maps';

const ALLOWED_IMPORTERS = [
  'app/(app)/expenses/_workbench/RouteMap.tsx',
  'app/(app)/expenses/_workbench/RouteLineMap.tsx',
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

/** Any mention of a module as an import source: static, re-export, dynamic or require. */
function importsOf(text: string, specifier: RegExp): string[] {
  const source = specifier.source;
  const found: string[] = [];
  const patterns = [
    new RegExp(`\\b(?:import|export)\\b[^;'"]*?\\bfrom\\s*['"]${source}['"]`, 'g'),
    new RegExp(`\\bimport\\s*['"]${source}['"]`, 'g'),
    new RegExp(`\\bimport\\s*\\(\\s*['"]${source}['"]\\s*\\)`, 'g'),
    new RegExp(`\\brequire\\s*\\(\\s*['"]${source}['"]\\s*\\)`, 'g'),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[0]);
  }
  return found;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/@-]/g, '\\$&');

describe('who loads the map library', () => {
  it('scans the app source, so an empty answer means something', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(ALLOWED_IMPORTERS));
  });

  it(`only ${ALLOWED_IMPORTERS.length} files import ${LIBRARY}`, () => {
    const importers = files
      .filter((f) => importsOf(f.text, new RegExp(escapeRegExp(LIBRARY))).length > 0)
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual([...ALLOWED_IMPORTERS].sort());
  });

  it.each([
    ['RouteMap', 'app/(app)/expenses/_workbench/RoutePickerModal.tsx'],
    ['RouteLineMap', 'app/(app)/expenses/_workbench/RouteLine.tsx'],
  ])('%s is reached only through React.lazy(import()), from %s', (module, lazyImporter) => {
    const specifier = new RegExp(`(?:\\.{1,2}/|@/)[^'"]*\\b${module}`);
    const reaching = files.flatMap((f) =>
      importsOf(f.text, specifier).map((statement) => ({ path: f.path, statement })),
    );

    // Every route to it is a dynamic import() or an erased `import type`.
    const eager = reaching.filter(
      ({ statement }) => !/^import\s*\(/.test(statement) && !/^import\s+type\b/.test(statement),
    );
    expect(eager, `a static import of ${module} puts the map library in first load`).toEqual([]);

    // And the dynamic one is the lazy component in its one consumer.
    const dynamic = reaching.filter(({ statement }) => /^import\s*\(/.test(statement));
    expect(dynamic.map((d) => d.path)).toEqual([lazyImporter]);
    const consumer = files.find((f) => f.path === lazyImporter)?.text ?? '';
    expect(consumer).toMatch(
      new RegExp(`lazy(?:<[^(]*>)?\\(\\s*\\(\\)\\s*=>\\s*import\\('\\./${module}'\\)\\.catch\\(`),
    );
  });

  it('pins the library to exactly 1.10.1', () => {
    const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies[LIBRARY]).toBe('1.10.1');
  });
});
