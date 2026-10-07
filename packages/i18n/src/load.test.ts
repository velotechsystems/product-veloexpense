import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from './load';
import { SUPPORTED_LOCALES } from './locales';

/**
 * THE ONE THING IN THIS PACKAGE NO OTHER GATE CAN SEE.
 *
 * `loadCatalog` resolves `./catalogs/${locale}/${area}.json` from a template literal.
 * No static analysis can follow that, so an area listed in `FEATURE_AREAS` with no JSON
 * file behind it type-checks clean, passes `check-coverage` with OK and passes
 * `check-used-keys` with OK — and then throws on EVERY request, in EVERY locale, because
 * next-intl's `getRequestConfig` calls this on each one. It is the only edit in the
 * package that can take the whole application down with all three gates green.
 *
 * The half-deletion in the other direction is just as quiet: dropping `en/<area>.json`
 * while leaving `fr-CA/<area>.json` also passes `check-coverage`, because that script
 * walks `Object.keys(catalogs[en])` and so cannot notice an area the reference locale
 * has itself lost.
 *
 * These tests close both directions by CALLING THE REAL LOADER. That is the whole point
 * and the reason nothing here is stubbed: the assertion has to run the same dynamic
 * `import()` expression the app runs, because the expression is the thing that breaks.
 * A test that reimplemented the import — even one character differently — would be
 * asserting about its own copy, and both the bundler's module map and the resolution
 * are per-call-site.
 *
 * The verification this replaces was "start the dev server and load a page in each
 * locale", which protects exactly the person who remembers to do it.
 */

/**
 * The on-disk truth, read straight from the directory rather than from any list.
 *
 * Built with `dirname(fileURLToPath(import.meta.url))` — the same shape the package's
 * gate scripts use — and NOT with `new URL(`./catalogs/${locale}/`, import.meta.url)`.
 * Vite rewrites a `new URL(<template literal>, import.meta.url)` into a glob asset
 * lookup, and a directory matches no asset, so that spelling resolves to the string
 * "undefined" instead of throwing. It would have made this guard read a path that
 * cannot exist, in a test whose entire job is to notice a path that does not exist.
 */
async function areaFilesOnDisk(locale: string): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'catalogs', locale);
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

describe('loadCatalog', () => {
  for (const locale of SUPPORTED_LOCALES) {
    describe(locale, () => {
      it('resolves every area listed in FEATURE_AREAS', async () => {
        // If ANY listed area has no JSON file, the dynamic import rejects and this line
        // throws — which is the failure the production app would otherwise be the first
        // thing to discover.
        const catalog = await loadCatalog(locale);

        const empty = Object.entries(catalog)
          .filter(([, messages]) => {
            if (messages === null || typeof messages !== 'object') return true;
            return Object.keys(messages).length === 0;
          })
          .map(([area]) => area);
        // A present-but-empty file resolves happily and then renders MISSING_MESSAGE
        // everywhere its namespace is read, so "the import worked" is not enough.
        expect(empty).toEqual([]);
        expect(Object.keys(catalog).length).toBeGreaterThan(0);
      });

      it('returns the real parsed catalog content, not an empty object', async () => {
        /**
         * `apps/worker/src/handlers/channels.test.ts` records the opposite as fact —
         * that this loader's templated dynamic import "resolves to an EMPTY catalog
         * under vitest" — and reads the JSON off disk itself to avoid it. That is no
         * longer true on this toolchain: vite declines to rewrite the import (the
         * `with: { type: 'json' }` attribute defeats `vite:dynamic-import-vars`, which
         * warns and leaves it alone), so it stays a genuine runtime import and returns
         * real content.
         *
         * Pinned here because the two beliefs cannot both hold, and the stale one is
         * the reason the loader had no test at all: every other caller in the repo
         * mocks it. If a toolchain change ever does hollow the catalog out, the
         * assertions above would all still pass on an empty-but-present file — this is
         * the one that would not.
         */
        const catalog = await loadCatalog(locale);
        const onDisk = JSON.parse(
          await readFile(
            join(dirname(fileURLToPath(import.meta.url)), 'catalogs', locale, 'nav.json'),
            'utf8',
          ),
        );
        expect(catalog.nav).toEqual(onDisk);
      });

      it('lists exactly the area files that exist on disk, in both directions', async () => {
        // `loadCatalog`'s returned keys ARE `FEATURE_AREAS` — it builds one entry per
        // area — so this compares the list against the filesystem without needing the
        // array exported, and without a second hardcoded copy of it to drift.
        const listed = Object.keys(await loadCatalog(locale)).sort();
        const onDisk = (await areaFilesOnDisk(locale)).sort();

        // Named both ways so a failure says WHICH side is wrong: an area with no file
        // is the outage above; a file with no area is a catalog nothing ever loads,
        // which is how a namespace ends up quietly dead.
        const listedWithNoFile = listed.filter((a) => !onDisk.includes(a));
        const fileWithNoArea = onDisk.filter((f) => !listed.includes(f));
        expect({ listedWithNoFile, fileWithNoArea }).toEqual({
          listedWithNoFile: [],
          fileWithNoArea: [],
        });
      });
    });
  }

  it('carries the identical set of areas in every locale', async () => {
    // The half-deletion `check-coverage` structurally cannot see. Compared between the
    // locales rather than against a reference one, so neither direction is privileged.
    const perLocale = await Promise.all(
      SUPPORTED_LOCALES.map(
        async (locale) => [locale, (await areaFilesOnDisk(locale)).sort()] as const,
      ),
    );
    const reference = perLocale[0][1];
    for (const [locale, areas] of perLocale) {
      expect(areas, `${locale} catalog areas`).toEqual(reference);
    }
  });
});
