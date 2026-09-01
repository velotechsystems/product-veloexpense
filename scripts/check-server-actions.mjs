/**
 * VX2-10 — every page that has server actions must have them REGISTERED.
 *
 * ── The failure this exists to catch ────────────────────────────────────────
 *
 * `app/approve/actions.ts` shipped with one extra line:
 *
 *     export { inspectToken };
 *
 * a plain re-export, out of a `'use server'` module, of a function declared in
 * `lib/notifications/approve.ts`. It typechecked. It linted. It BUILT. And the
 * build produced `app/approve/page` with NO server actions registered at all —
 * not the re-export missing, the whole module's registration absent from
 * `.next/server/server-reference-manifest.json`, while all twelve other pages
 * were there. Next treats every export of a `'use server'` file as an action to
 * wrap; a re-exported binding is not something it can wrap, and it does not say
 * so.
 *
 * What the browser got was this, on the POST:
 *
 *     Failed to find Server Action "4066e8…". This request might be from an
 *     older or newer deployment.
 *
 * A message about DEPLOYMENTS, for a problem that is not one — nothing was
 * stale, the action had never existed. It cost a confident wrong diagnosis (a
 * reused e2e app server) that survived until somebody read the manifest. The
 * only visible symptom was a browser test failing on the assertion AFTER the
 * click, which points nowhere near the cause.
 *
 * So this checks the two things the compiler will not:
 *
 *   1. SOURCE — every top-level export of a `'use server'` file is
 *      `export async function`. Nothing else: no re-export, no `export const`,
 *      no `export type` (the house rule already says types do not leave a
 *      `'use server'` module — a page reads shapes via
 *      `Awaited<ReturnType<typeof …>>`), no `export default`.
 *   2. BUILD — every page with a co-located `'use server'` file has at least one
 *      action in the manifest naming it. Check 1 encodes the cause we found;
 *      check 2 catches the class of failure whatever the next cause turns out to
 *      be, which is the one worth having.
 *
 * Run after `next build`:  node scripts/check-server-actions.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP = 'app';
const MANIFEST = '.next/server/server-reference-manifest.json';

/** Files under app/ whose FIRST statement is the 'use server' directive. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(APP);
const problems = [];

/** Strip the leading comment block(s) so the directive check sees real code. */
function firstStatement(src) {
  let i = 0;
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i);
      if (end < 0) return '';
      i = end + 2;
      continue;
    }
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      if (end < 0) return '';
      i = end + 1;
      continue;
    }
    break;
  }
  return src.slice(i, i + 20);
}

const serverModules = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!/^['"]use server['"]/.test(firstStatement(src))) continue;
  serverModules.push(file);

  // Top-level exports only: a line starting at column 0 with `export`.
  const lines = src.split(/\r?\n/);
  lines.forEach((line, n) => {
    if (!/^export\b/.test(line)) return;
    if (/^export async function \w/.test(line)) return;
    problems.push(
      `${file}:${n + 1}  every export of a 'use server' module must be ` +
        `\`export async function\`, and this is not:\n      ${line.trim()}\n` +
        `      Next registers each export as a server action. It cannot wrap this one, ` +
        `and rather than failing the build it registers NONE of the module's actions — ` +
        `so every form on the page posts an id the server has never heard of.`,
    );
  });
}

// ── Check 1 needs NO MANIFEST, so it reports before anything can suppress it ──
//
// THIS ORDER IS A FIX, and the bug it fixes is the guard's own. Check 1 is pure
// source analysis; check 2 reads the build. Both used to report together at the
// bottom — after the two manifest bail-outs below — so a stale or missing
// manifest THREW AWAY an already-collected check-1 finding and printed "This is
// not a finding" while holding one. VX4-3 hit it exactly that way: an
// `export interface` in a new 'use server' module, reported by CI (which builds
// first) and silently swallowed by every local run (which does not), so the
// author read "not a finding", believed it, and pushed.
//
// That is this project's recurring lesson wearing the guard's own clothes — a
// check that cannot produce one of its two outcomes hides every defect in the
// outcome it cannot produce. A guard whose findings depend on a build it does not
// need is worse than no guard, because it answers.
if (problems.length) {
  console.error('check-server-actions FAILED:\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  process.exit(1);
}

if (!existsSync(MANIFEST)) {
  console.error(
    `check-server-actions: ${MANIFEST} is missing. Run \`npm run build\` first — ` +
      `this check reads what the build registered, so it cannot run without one.`,
  );
  process.exit(1);
}
// ── Is the manifest older than the sources it is being judged against? ──────
// Without this the check has a false failure with a badly misleading message: add
// a page, run `npm run check:actions` before `npm run build`, and it reports that
// the build registered no actions for it — which is true and useless, because the
// build has not seen the page. `npm run e2e` and CI both build immediately before
// this runs, so it only ever bites someone running the guard by hand, which is
// exactly the person who does not need a puzzle.
const manifestMtime = statSync(MANIFEST).mtimeMs;
const newestSource = serverModules.reduce((newest, file) => {
  const m = statSync(file).mtimeMs;
  return m > newest ? m : newest;
}, 0);
if (newestSource > manifestMtime) {
  const stale = serverModules.filter((f) => statSync(f).mtimeMs > manifestMtime);
  console.error(
    `check-server-actions: ${MANIFEST} is OLDER than ${stale.length} 'use server' ` +
      `module(s), so it cannot say anything about them:\n` +
      stale.map((f) => `  · ${f}`).join('\n') +
      `\nRun \`npm run build\` and try again. (This is not a finding — the build ` +
      `simply has not seen these files yet.)`,
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const registered = new Set();
for (const entry of Object.values(manifest.node ?? {})) {
  for (const worker of Object.keys(entry.workers ?? {})) registered.add(worker);
}
for (const entry of Object.values(manifest.edge ?? {})) {
  for (const worker of Object.keys(entry.workers ?? {})) registered.add(worker);
}

// A `'use server'` file is normally consumed by the page beside it. Shared ones
// (app/receipts/actions.ts) have no page of their own and are covered through
// whichever pages import them, so "no sibling page.tsx" is not a finding.
for (const file of serverModules) {
  const dir = file.slice(0, file.lastIndexOf('/'));
  if (!existsSync(join(dir, 'page.tsx'))) continue;
  const worker = `${dir}/page`;
  if (registered.has(worker)) continue;
  problems.push(
    `${worker} has a co-located 'use server' module (${file}) but the build ` +
      `registered NO server actions for it.\n` +
      `      Its forms will fail at runtime with "Failed to find Server Action …", ` +
      `which reads like a stale deployment and is not one.`,
  );
}

if (problems.length) {
  console.error('check-server-actions FAILED:\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  process.exit(1);
}
console.log(
  `check-server-actions OK — ${serverModules.length} 'use server' modules, ` +
    `${registered.size} page(s) with registered actions.`,
);
