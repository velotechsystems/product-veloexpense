#!/usr/bin/env node
/**
 * UD-16 — every route names itself, and a new route that does not is a FAILURE.
 *
 * ── WHY THIS IS A GLOB AND NOT A LIST ──────────────────────────────────────
 *
 * Upstream's #398 was three pages missing from a hand-maintained title map. A map
 * is a second enumeration of the routes: it drifts from the first, and the drift
 * is silent, because nothing compares them. UD-9 is the standing note about that
 * shape in this tree and this project has paid for it three times.
 *
 * So there is no list of routes here. The route set is DISCOVERED — every
 * `app/**​/page.tsx` — and the rule is applied to whatever it finds. Add a route
 * and this fails until it names itself. Delete one and nothing has to be tidied.
 * The only list is of EXEMPTIONS, which is a different thing: an exemption has to
 * be written down with a reason, and an empty exemption list is the healthy state.
 *
 * ── WHAT IT CANNOT CHECK ───────────────────────────────────────────────────
 *
 * That the title is RIGHT. It reads for the presence of a `generateMetadata` or
 * `metadata` export, not for what it returns — a page could title itself
 * "Approvals" while showing employees and this would pass. Two other things
 * narrow that: the key has to exist in `UI_COPY` or the build fails, and
 * `test/page-titles.test.ts` asserts every `title.*` key is actually referenced
 * by some page, so a key nobody uses and a page using the wrong key are both
 * visible. Neither of those is "the title describes the page", which is a human
 * question and is left as one.
 *
 * Also not checked: that a `<title>` reaches the browser. The pseudo-locale crawl
 * cannot help — `visibleStrings` walks `document.body` and a title lives in
 * `<head>` — which is exactly why these strings needed a catalogue and a compiler
 * rather than a ratchet.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'app';

/**
 * Routes that legitimately have no title of their own, each with the reason.
 *
 * EMPTY, and that is the intended state. It exists so that a future exemption is
 * a decision somebody wrote down rather than a page quietly not appearing in a
 * map — which is the failure mode this whole script replaces.
 */
const EXEMPT = new Map([
  // ['app/example/page.tsx', 'why this route has no title of its own'],
]);

function pages(dir) {
  const out = [];
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

if (!statSync(ROOT, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`check-page-titles: no ${ROOT}/ directory — run this from the repo root.`);
  process.exit(1);
}

const found = pages(ROOT).sort();

// A glob that matches nothing passes every rule, which is the one way a discovery
// gate can be vacuous. Refuse rather than congratulate.
if (found.length === 0) {
  console.error('check-page-titles: found no pages at all. That is a broken check, not a clean tree.');
  process.exit(1);
}

const untitled = [];
const staleExemptions = [...EXEMPT.keys()].filter((p) => !found.includes(p));

for (const path of found) {
  if (EXEMPT.has(path)) continue;
  const src = readFileSync(path, 'utf8');
  const declares =
    /export\s+(?:async\s+)?function\s+generateMetadata\b/.test(src) ||
    /export\s+const\s+generateMetadata\b/.test(src) ||
    /export\s+const\s+metadata\b/.test(src);
  if (!declares) untitled.push(path);
}

if (untitled.length > 0 || staleExemptions.length > 0) {
  if (untitled.length > 0) {
    console.error(
      `check-page-titles: ${untitled.length} route(s) do not name themselves.\n\n` +
        untitled.map((p) => `  ${p}`).join('\n') +
        '\n\n' +
        '  Every tab, bookmark, back-history entry and screen-reader page\n' +
        '  announcement comes from this one string. Before UD-16 all thirty-two\n' +
        '  routes shared it, which is why this is a gate and not a convention.\n\n' +
        '  Add, with a key from UI_COPY:\n\n' +
        "    import { pageTitle } from '@/lib/i18n/page-title';\n\n" +
        '    export function generateMetadata() {\n' +
        "      return pageTitle('title.your.page');\n" +
        '    }\n\n' +
        '  A page titled by its own data uses `dataTitle` instead — see\n' +
        '  app/expenses/[reportId]/page.tsx.\n',
    );
  }
  if (staleExemptions.length > 0) {
    console.error(
      `check-page-titles: ${staleExemptions.length} exemption(s) name a route that no longer exists:\n\n` +
        staleExemptions.map((p) => `  ${p}`).join('\n') +
        '\n\n  Remove them. A stale exemption is the beginning of the map this' +
        '\n  script exists to avoid.\n',
    );
  }
  process.exit(1);
}

console.log(
  `check-page-titles OK — ${found.length} route(s), every one names itself` +
    (EXEMPT.size > 0 ? `, ${EXEMPT.size} exempt` : '') +
    '.',
);
