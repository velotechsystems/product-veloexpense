#!/usr/bin/env node
/**
 * The harness-leak guard — a build-environment path must never reach a commit.
 *
 * ── WHY THIS EXISTS, WITH THE INCIDENT THAT CAUSED IT ───────────────────────
 *
 * This repo is worked on from two machines: the checkout on John's device, which
 * is what gets committed, and a cloud harness that carries the Linux
 * `node_modules` where `npm run build`, `check:actions` and the full Playwright
 * suite actually run. The harness needs exactly two local edits to work, and
 * NEITHER may be committed:
 *
 *   1. `playwright.config.ts` — the chromium project needs
 *      `launchOptions.executablePath` pointed at the harness's own Chromium,
 *      because `PLAYWRIGHT_BROWSERS_PATH` alone is not enough there.
 *   2. `app/layout.tsx` — the two `next/font/google` calls are replaced with
 *      plain objects, because the harness's egress blocks `fonts.googleapis.com`
 *      and `next build` otherwise fails fetching them.
 *
 * On 2026-09-03, PR #90 (VX4-7 part 3) was the first change to edit
 * `playwright.config.ts` itself. The file was copied back from the harness rather
 * than patched, so `executablePath: '/opt/pw-browsers/…/chrome'` went into the
 * commit. CI installs its own browser and has nothing at that path, so **all 123
 * specs failed at launch** — before a line of test code ran. Nothing was wrong
 * with the change; the transfer step shipped the bug.
 *
 * A written rule already covered this and was not followed. That is the argument
 * for a guard rather than another paragraph: this is a mechanical property, and a
 * mechanical property belongs in CI.
 *
 * ── WHAT IS CHECKED, AND WHY IT IS NOT JUST A LIST OF TWO FILES ─────────────
 *
 * Naming the two files above would be IL-7's shape — a gate that restates the
 * list it polices passes the day the list is wrong, which is the day a THIRD
 * harness edit is invented. So two of the three checks are derived properties
 * that know nothing about which files were edited:
 *
 *   A. No committed source names a path that exists only in a build environment.
 *   B. No Playwright config pins a browser BINARY. (Today that is the same defect
 *      as A. It is checked separately because the next harness's Chromium will
 *      live somewhere else, and A only knows about this one.)
 *   C. Every binding imported from `next/font/google` is actually CALLED.
 *
 * C is the interesting one. The font stub is a DELETION — it removes two calls
 * and leaves the import — so no string scan can see it; there is no bad text to
 * find. What IS checkable is the contradiction it leaves behind: a module that
 * imports a font loader and never calls it. That catches the stub without this
 * file ever knowing `app/layout.tsx` exists.
 *
 * ── WHAT IS DELIBERATELY NOT CHECKED ────────────────────────────────────────
 *
 *   · MARKDOWN. `HANDOFF.md` names `/opt/pw-browsers/…` on purpose — that is the
 *     instruction for standing the harness up, and a guard that forbade writing
 *     it down would delete the documentation to protect the code. Docs are not
 *     scanned, and that hole is the point of the hole.
 *   · The harness edits themselves, in the harness. This runs in CI and on a
 *     laptop against the committed tree; a working copy that has them applied is
 *     working correctly, which is why the guard is not a pre-commit hook.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';

const ROOT = process.cwd();

/**
 * Absolute paths that exist in a build environment and nowhere a customer runs.
 *
 * This IS an enumeration, and it is worth being honest about what kind. It does
 * not list FILES — the thing that rots is which file somebody edited, and that is
 * exactly what checks A and C avoid knowing. It lists FACTS ABOUT TWO MACHINES,
 * which change only when a machine changes, and a new one announces itself by
 * breaking a build rather than by passing quietly.
 *
 * `/home/` and `/opt/` are NOT banned wholesale: `Dockerfile` legitimately creates
 * `/home/nextjs`, and a guard that fails on correct code teaches people to delete
 * guards. Each entry below is a path that could only have come from a tool run.
 */
const HARNESS_PATHS = [
  { path: '/opt/pw-browsers', why: "the cloud harness's Chromium install" },
  { path: '/home/claude', why: "the cloud harness's home directory" },
  { path: '/tmp/pgsock', why: "the cloud harness's Postgres socket" },
  { path: '/tmp/pgdata', why: "the cloud harness's Postgres data directory" },
  { path: '/sessions/', why: "the device VM's mount root — a path only that VM has" },
];

/** Files where naming a harness path is this file's whole job. */
const ALLOWED = new Set(['scripts/check-harness-leak.mjs']);

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'test-results', 'playwright-report']);

/**
 * Scanned extensions, plus `Dockerfile` by name. Markdown is absent on purpose —
 * see the header.
 */
const SCAN_EXT = ['.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '.yml', '.yaml', '.sql'];
const SCAN_NAMES = new Set(['Dockerfile']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Comments blanked, newlines and offsets preserved, so a hit's line number in the
 * scanned text is its line number in the original. Same approach and same reason
 * as `check-vendor-neutral.mjs`, including the reason it is not a parser: a `//`
 * inside a URL blanks the rest of that line, and a false NEGATIVE (a harness path
 * hiding behind a URL on one line) is a far better failure than a guard that
 * cannot be lived with.
 *
 * COMMENTS ARE STRIPPED, and the first draft of this file got that wrong in a way
 * worth keeping. It scanned comments too, on the argument that a commented-out
 * `executablePath` is a copied file one keystroke from live. Then the CI step
 * added in the same commit — a comment explaining THIS INCIDENT, which quotes the
 * path — failed the guard. That is precisely the shape this project keeps
 * naming: a gate that fails the build on correct code teaches people to delete
 * gates, and the correct code here is the documentation of why the gate exists.
 *
 * The case that argument was protecting is not lost, because check B does not use
 * this function: a commented-out `executablePath` in a Playwright config still
 * fails, which is the only place the disabled-line risk is real. A harness path
 * commented out anywhere else is prose, and prose is allowed to be accurate.
 */
const COMMENT_SYNTAX = { js: 'js', hash: 'hash', sql: 'sql', none: 'none' };

function stripComments(text, syntax) {
  if (syntax === COMMENT_SYNTAX.none) return text;
  let out = text;
  if (syntax !== COMMENT_SYNTAX.hash) {
    out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  }
  const line =
    syntax === COMMENT_SYNTAX.hash ? /#.*$/gm : syntax === COMMENT_SYNTAX.sql ? /--.*$/gm : /\/\/.*$/gm;
  return out.replace(line, (m) => ' '.repeat(m.length));
}

/** Which comment syntax a file uses. JSON has none, and that is a value here. */
function syntaxOf(rel, name) {
  if (name === 'Dockerfile' || rel.endsWith('.yml') || rel.endsWith('.yaml')) return COMMENT_SYNTAX.hash;
  if (rel.endsWith('.sql')) return COMMENT_SYNTAX.sql;
  if (rel.endsWith('.json')) return COMMENT_SYNTAX.none;
  return COMMENT_SYNTAX.js;
}

const offenders = [];

function record(file, text, index, what, why, fix) {
  offenders.push({
    file,
    line: text.slice(0, index).split('\n').length,
    what,
    why,
    fix,
    text: (text.split('\n')[text.slice(0, index).split('\n').length - 1] ?? '').trim().slice(0, 120),
  });
}

const files = walk(ROOT)
  .map((full) => ({ full, rel: relative(ROOT, full).split(sep).join('/') }))
  .filter(({ rel, full }) => {
    if (ALLOWED.has(rel)) return false;
    return SCAN_NAMES.has(basename(full)) || SCAN_EXT.some((e) => rel.endsWith(e));
  });

let fontModules = 0;

for (const { full, rel } of files) {
  const original = readFileSync(full, 'utf8');
  // Blanked with spaces and newlines kept, so an index into `code` is the same
  // index into `original` — which is what lets `record` quote the real line.
  const code = stripComments(original, syntaxOf(rel, basename(full)));

  // ── A. A build environment's path in committed source ────────────────────
  for (const { path, why } of HARNESS_PATHS) {
    let i = code.indexOf(path);
    while (i !== -1) {
      record(rel, original, i, path, why, 'Patch this file in place on the device — never copy it back from the harness.');
      i = code.indexOf(path, i + 1);
    }
  }

  // ── B. A Playwright config that pins a browser binary ────────────────────
  if (/^playwright.*\.config\.ts$/.test(basename(full))) {
    const i = original.indexOf('executablePath');
    if (i !== -1) {
      record(
        rel,
        original,
        i,
        'executablePath',
        'a Playwright config pinning a browser BINARY — CI installs its own with `npx playwright install`',
        'Remove the clause. To run the suite in the harness, add it THERE and do not commit it.',
      );
    }
  }

  // ── C. A font loader imported and never called ───────────────────────────
  const imports = code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]next\/font\/google['"]/g);
  for (const m of imports) {
    fontModules++;
    for (const clause of m[1].split(',')) {
      // `Geist as Sans` binds `Sans`; the local name is what has to be called.
      const local = clause.trim().split(/\s+as\s+/).pop()?.trim();
      if (!local) continue;
      if (!new RegExp(`\\b${local}\\s*\\(`).test(code)) {
        record(
          rel,
          original,
          m.index,
          `${local} imported from next/font/google and never called`,
          "the harness stubs these calls out because its egress blocks fonts.googleapis.com — a stub is an ABSENCE, so this contradiction is the only thing left to detect",
          `Restore the real \`const … = ${local}({ … })\` call.`,
        );
      }
    }
  }
}

if (offenders.length > 0) {
  console.error('');
  console.error('check-harness-leak FAILED — a build environment reached the commit.');
  console.error('');
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.what}`);
    console.error(`      ${o.why}`);
    console.error(`      ${o.text}`);
    console.error(`      → ${o.fix}`);
    console.error('');
  }
  console.error('  Two files carry harness-only edits and must be PATCHED IN PLACE, never');
  console.error('  copied back wholesale: playwright.config.ts and app/layout.tsx.');
  console.error('  See HANDOFF.md, "the cloud harness".');
  console.error('');
  process.exit(1);
}

console.log(
  `check-harness-leak OK — ${files.length} files scanned; no harness path, ` +
    `no pinned browser binary, ${fontModules} next/font module(s) all calling what they import.`,
);
