#!/usr/bin/env node
/**
 * VX4-10 part 1 — refuse to run the pseudo-locale crawl against a stale build.
 *
 * ── WHY THIS EXISTS, WITH THE MEASUREMENT THAT PUT IT HERE ──────────────────
 *
 * `npm run e2e:crawl` seeds and then starts `npm run start:standalone`, which
 * serves whatever `.next/standalone` happens to hold. It does NOT build. `npm run
 * e2e` does, and the crawl was split off from it for the pseudo flag (see
 * playwright.pseudo.config.ts) — the build went with the half it left behind, and
 * nobody noticed because CI builds at line 134 and crawls at line 289 of the same
 * job, so CI has always been correct.
 *
 * What that cost, measured rather than imagined: while sabotage-testing VX4-10 I
 * hardcoded a heading back onto `/admin/billing`, ran the crawl, and it reported
 * `0 un-catalogued (ceiling 0)` — GREEN, against a defect deliberately planted
 * where the ceiling would catch it. The sabotage had not been compiled. Rebuild
 * and the same run says `1 un-catalogued, ceiling 0 — Measured usage`.
 *
 * That is the worst failure mode a gate can have: not a false alarm, but a clean
 * pass that says the thing it was pointed at is fine. Had I not been running a
 * sabotage that turn, I would have read the green as a measurement.
 *
 * ── WHY A STALENESS CHECK AND NOT JUST ADDING `npm run build` ───────────────
 *
 * Prefixing `e2e:crawl` with a build is the obvious fix and the wrong one: CI has
 * already built by the time it gets here, so every PR would pay for a second full
 * Next build — about ninety seconds — to protect a mistake CI cannot make. This
 * costs milliseconds, is silent when the build is current, and fails loudly with
 * the command to run when it is not.
 *
 * ── WHAT IT CANNOT CATCH ───────────────────────────────────────────────────
 *
 * mtimes, not content hashes. `touch app/page.tsx` fails this with nothing
 * changed (annoying, safe), and a checkout that backdates files could pass it with
 * everything changed (silent, unsafe). Content hashing every source file would
 * close the second hole and is not worth its cost here, because the case this
 * guards is one person editing a file and re-running a command in the same shell —
 * where mtime is exactly right. Said out loud so the next person does not read
 * this as stronger than it is.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Source roots whose contents end up compiled into the standalone server. */
const ROOTS = ['app', 'lib', 'components', 'src'];

/** Plus the individual files a build depends on that do not live under a root. */
const FILES = ['next.config.ts', 'proxy.ts', 'auth.ts', 'package.json'];

const BUILD_MARKER = join('.next', 'standalone', 'server.js');

function newest(dir) {
  let latest = { path: null, mtimeMs: 0 };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const deeper = newest(path);
      if (deeper.mtimeMs > latest.mtimeMs) latest = deeper;
      continue;
    }
    if (!entry.isFile()) continue;
    const { mtimeMs } = statSync(path);
    if (mtimeMs > latest.mtimeMs) latest = { path, mtimeMs };
  }
  return latest;
}

if (!existsSync(BUILD_MARKER)) {
  console.error(
    `check:build-fresh: there is no build to crawl (${BUILD_MARKER} does not exist).\n` +
      '  The crawl serves the standalone build; it does not make one.\n' +
      '  Run:  npm run build\n',
  );
  process.exit(1);
}

const builtAt = statSync(BUILD_MARKER).mtimeMs;

let latest = { path: null, mtimeMs: 0 };
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  const candidate = newest(root);
  if (candidate.mtimeMs > latest.mtimeMs) latest = candidate;
}
for (const file of FILES) {
  if (!existsSync(file)) continue;
  const { mtimeMs } = statSync(file);
  if (mtimeMs > latest.mtimeMs) latest = { path: file, mtimeMs };
}

if (latest.path !== null && latest.mtimeMs > builtAt) {
  const seconds = Math.round((latest.mtimeMs - builtAt) / 1000);
  console.error(
    'check:build-fresh: the crawl would measure a STALE BUILD.\n' +
      `  ${latest.path} changed ${seconds}s after ${BUILD_MARKER} was written.\n` +
      '\n' +
      '  The crawl counts strings in rendered HTML, so a source change that is not\n' +
      '  in the build is invisible to it — and the run comes back GREEN, which reads\n' +
      '  as a measurement rather than as a miss.\n' +
      '\n' +
      '  Run:  npm run build && npm run e2e:crawl\n',
  );
  process.exit(1);
}

console.log('check:build-fresh: OK — the standalone build is newer than every source file.');
