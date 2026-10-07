#!/usr/bin/env node
/**
 * i18n resolution gate — does every key the CODE asks for actually exist?
 *
 * `check-coverage.mjs` compares locales against each other, so a key written
 * into the wrong nested block passes: both locales are equally wrong. That is
 * exactly how `vcc.requests.colSpend` shipped as `vcc.cardImport.colSpend` and
 * blew up at render time with MISSING_MESSAGE.
 *
 * This script closes that hole from the other side. It finds each
 * `useTranslations('<namespace>')` / `getTranslations('<namespace>')` binding,
 * collects the LITERAL keys called on that binding, and resolves
 * `<namespace>.<key>` against the default catalog.
 *
 * Deliberately literal-only: a computed key (`t(`syncState.${x}`)`) can't be
 * resolved without running the app, so those are skipped rather than guessed
 * at. It's a net, not a proof — but it catches the whole class of typo and
 * wrong-block mistakes, which is what actually happens.
 *
 * Usage:  node packages/i18n/scripts/check-used-keys.mjs
 * Exit:   0 — every literal key resolves.  1 — at least one does not.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LOCALE = 'en';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const catalogsRoot = join(here, '..', 'src', 'catalogs');
/**
 * Where translated code lives.
 *
 * VeloExpense: ported code sits at the repo root, at the paths it had under ExpenseOS's
 * `apps/web/src`, plus `packages/`. VeloExpense's own screens use `lib/i18n` rather than
 * next-intl, so they declare no `useTranslations` binding and this script skips them.
 */
const SOURCE_ROOTS = ['app', 'components', 'lib', 'server', 'packages'].map((d) => join(repoRoot, d));

async function loadCatalog() {
  const dir = join(catalogsRoot, DEFAULT_LOCALE);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const out = {};
  for (const f of files) {
    out[f.replace(/\.json$/, '')] = JSON.parse(await readFile(join(dir, f), 'utf8'));
  }
  return out;
}

function resolves(catalog, dottedPath) {
  const parts = dottedPath.split('.');
  let cur = catalog;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) return false;
    cur = cur[p];
  }
  // A namespace object is not a message.
  return typeof cur === 'string';
}

async function* sourceFiles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      yield* sourceFiles(full);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

/** `const t = useTranslations('vcc')` → binding name ↦ namespace. */
const BINDING_RE =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*'([^']+)'\s*\)/g;

const files = [];
for (const root of SOURCE_ROOTS) {
  for await (const f of sourceFiles(root)) files.push(f);
}

const catalog = await loadCatalog();
const misses = [];
let checked = 0;

for (const file of files) {
  const src = await readFile(file, 'utf8');
  if (!src.includes('Translations(')) continue;

  // A file routinely declares `const t` once per component, each with its own
  // namespace, and this is a regex not a scope analyser. So collect EVERY
  // namespace a given binding name is bound to in the file and accept a key
  // that resolves under any of them. Ambiguity costs a little sensitivity;
  // guessing the wrong one costs false alarms, which get the gate switched off.
  const namespacesOf = new Map();
  for (const m of src.matchAll(BINDING_RE)) {
    const list = namespacesOf.get(m[1]) ?? [];
    list.push(m[2]);
    namespacesOf.set(m[1], list);
  }
  if (namespacesOf.size === 0) continue;

  // A translator passed AS AN ARGUMENT shadows the module's own binding of the
  // same name, and its namespace is whatever the caller scoped it to — which
  // this script can't see. `buildPolicySchema(t: (k: string) => string)` is the
  // real case: `t('receiptRequired')` inside it is a different `t`. Skip such
  // names rather than blame them on the wrong namespace.
  for (const name of [...namespacesOf.keys()]) {
    const shadowed = new RegExp(`[(,]\\s*${name}\\s*:\\s*\\(`).test(src);
    if (shadowed) namespacesOf.delete(name);
  }

  for (const [binding, namespaces] of namespacesOf) {
    // Literal single-quoted first argument only; template literals are skipped.
    const callRe = new RegExp(`\\b${binding}\\(\\s*'([^']+)'`, 'g');
    for (const call of src.matchAll(callRe)) {
      const key = call[1];
      checked += 1;
      if (namespaces.some((ns) => resolves(catalog, `${ns}.${key}`))) continue;
      const line = src.slice(0, call.index).split('\n').length;
      const tried = namespaces.map((ns) => `${ns}.${key}`).join(' | ');
      misses.push(`${relative(repoRoot, file)}:${line}  ${tried}`);
    }
  }
}

console.log(`i18n used-key check: ${checked} literal keys across ${files.length} files`);
if (misses.length > 0) {
  console.error(
    `\n✗ ${misses.length} key(s) the code asks for do not resolve in '${DEFAULT_LOCALE}':\n`,
  );
  for (const m of misses) console.error(`  ${m}`);
  console.error('');
  process.exit(1);
}
console.log('i18n used keys: OK');
