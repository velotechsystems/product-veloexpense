/**
 * UD-16 — the half `scripts/check-page-titles.mjs` cannot check.
 *
 * That script asks whether every route declares a title. It deliberately does not
 * read what the title IS, so a page could name itself with another page's key and
 * pass. These tests close the two gaps that are mechanically checkable:
 *
 *   · every `title.*` key in the catalogue is referenced by some page — so a key
 *     left behind by a deleted route, or one added and never wired up, is visible;
 *   · no two routes claim the same key — which is how a copy-pasted
 *     `generateMetadata` block announces itself.
 *
 * What remains unchecked, and is left as a human question: whether the title
 * DESCRIBES the page. `title.admin.budgets` on the reimbursements screen would
 * satisfy everything here.
 *
 * Filesystem-reading tests rather than a registry, for the reason
 * `check-page-titles.mjs` gives at length: a registry is a second enumeration of
 * the routes and it drifts silently. These read the same tree the router does.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_KEYS } from '@/lib/i18n/catalog/ui';

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...pages(path));
      continue;
    }
    if (entry.name === 'page.tsx' || entry.name === 'page.ts') out.push(path);
  }
  return out;
}

const PAGES = pages('app').sort();
const SOURCES = new Map(PAGES.map((p) => [p, readFileSync(p, 'utf8')]));
const TITLE_KEYS = UI_KEYS.filter((k) => k.startsWith('title.'));

/** The `title.*` keys each page mentions, from `pageTitle`/`dataTitle` calls. */
function keysIn(src: string): string[] {
  return [...src.matchAll(/'(title\.[a-z0-9.]+)'/g)].map((m) => m[1]);
}

describe('UD-16: the route tree and the title catalogue agree', () => {
  it('found the routes at all', () => {
    // The vacuity guard. Every assertion below passes trivially against an empty
    // list, which is the one way a filesystem-reading test lies.
    expect(PAGES.length).toBeGreaterThan(20);
    expect(TITLE_KEYS.length).toBeGreaterThan(20);
  });

  it('every title.* key is used by some page', () => {
    const used = new Set(PAGES.flatMap((p) => keysIn(SOURCES.get(p) ?? '')));
    const orphans = TITLE_KEYS.filter((k) => !used.has(k));
    expect(orphans, 'title keys no page references').toEqual([]);
  });

  it('every key a page names exists in the catalogue', () => {
    // The compiler already refuses an unknown `UiKey`, so this is belt and
    // braces — but it is also the assertion that survives somebody widening the
    // parameter type to `string` for convenience.
    const known = new Set<string>(UI_KEYS);
    for (const [path, src] of SOURCES) {
      for (const key of keysIn(src)) {
        expect(known.has(key), `${path} names ${key}, which is not in UI_COPY`).toBe(true);
      }
    }
  });

  it('no two routes claim the same title key', () => {
    const owners = new Map<string, string[]>();
    for (const [path, src] of SOURCES) {
      for (const key of keysIn(src)) {
        owners.set(key, [...(owners.get(key) ?? []), path]);
      }
    }
    const shared = [...owners.entries()].filter(([, paths]) => paths.length > 1);
    expect(shared, 'a title key claimed by more than one route').toEqual([]);
  });

  it('a title is never a bare literal — it comes from the catalogue', () => {
    // The defect this would catch is the tempting one: somebody adds a route,
    // `check:titles` tells them to declare a title, and they write
    // `return { title: 'Budgets' }` because it is one line shorter. That passes
    // the guard, ships an uncatalogued string, and the crawl cannot see it
    // because a <title> is in <head>.
    for (const [path, src] of SOURCES) {
      const block = src.match(/generateMetadata[\s\S]{0,400}?\n}/)?.[0];
      if (block === undefined) continue;
      expect(
        /title:\s*['"`]/.test(block),
        `${path} sets a literal title — use pageTitle() or dataTitle()`,
      ).toBe(false);
    }
  });
});
