#!/usr/bin/env node
/**
 * i18n coverage gate.
 *
 * Walks every JSON catalog under src/catalogs/<locale>/ and asserts
 * that every key present in the DEFAULT_LOCALE catalog is also present
 * (with a non-empty value) in every other supported locale. Exits
 * non-zero if any locale is missing a key — wire into CI.
 *
 * Escape hatch: a translator can stub a key with the literal string
 * "// TODO: fr-CA" (or any locale tag) to unblock a PR. The script
 * counts those and prints a weekly-warning summary but does not fail
 * the build for them. Use sparingly.
 *
 * Usage:
 *   node packages/i18n/scripts/check-coverage.mjs
 *
 * Exit codes:
 *   0  — all locales fully covered (TODOs allowed).
 *   1  — at least one missing key in a non-default locale.
 *   2  — structural mismatch (object vs primitive at the same path).
 *   3  — a key next-intl will refuse to load (see `dottedKeys`).
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_LOCALES = ['en', 'fr-CA'];
const DEFAULT_LOCALE = 'en';

const here = dirname(fileURLToPath(import.meta.url));
const catalogsRoot = join(here, '..', 'src', 'catalogs');

/** Recursively collect leaf keypaths from a JSON object. */
function leaves(obj, prefix = []) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return [{ path: prefix, value: obj }];
  }
  return Object.entries(obj).flatMap(([k, v]) => leaves(v, [...prefix, k]));
}

function getAt(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Keys next-intl refuses outright.
 *
 * A dot in a key is how next-intl expresses NESTING, so a flat `"status.PENDING"` is
 * rejected at load with `INVALID_KEY` — and the whole catalog with it. Neither of the
 * other gates can see this: parity passes because both locales are equally wrong, and
 * `check-used-keys` passes because the code asks for `status.PENDING`, which is a
 * perfectly well-formed request for a nested key that happens not to exist.
 *
 * It reached dev and stayed there. Every page that touched the namespace logged the
 * error on render — 1.6 million lines in one e2e run — while every unit test passed,
 * because component tests mock `useTranslations` and never load a catalog at all.
 */
function dottedKeys(obj, prefix = []) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj).flatMap(([k, v]) => [
    ...(k.includes('.') ? [[...prefix, k]] : []),
    ...dottedKeys(v, [...prefix, k]),
  ]);
}

function isTodoStub(value) {
  return typeof value === 'string' && /^\/\/\s*TODO:/i.test(value.trim());
}

async function loadLocaleCatalog(locale) {
  const dir = join(catalogsRoot, locale);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const out = {};
  for (const file of files) {
    const area = file.replace(/\.json$/, '');
    out[area] = JSON.parse(await readFile(join(dir, file), 'utf8'));
  }
  return out;
}

async function main() {
  const catalogs = Object.fromEntries(
    await Promise.all(SUPPORTED_LOCALES.map(async (l) => [l, await loadLocaleCatalog(l)])),
  );

  // Before parity: a catalog next-intl will not load is not a translation problem, and
  // reporting it as one sends somebody looking for a missing French string.
  const invalid = [];
  for (const locale of SUPPORTED_LOCALES) {
    for (const [area, cat] of Object.entries(catalogs[locale])) {
      for (const keyPath of dottedKeys(cat)) invalid.push({ locale, area, path: keyPath });
    }
  }
  if (invalid.length > 0) {
    console.error(`\nKeys next-intl will refuse (${invalid.length}):`);
    for (const i of invalid) {
      const bad = i.path.at(-1);
      console.error(
        `  [${i.locale}] ${i.area}.${i.path.join('.')} — "${bad}" contains a dot; ` +
          `nest it instead (${bad.split('.').join(' → ')})`,
      );
    }
    console.error('\nnext-intl reads a dot as nesting, so it rejects the whole catalog.');
    process.exit(3);
  }

  const referenceAreas = Object.keys(catalogs[DEFAULT_LOCALE]);
  const missing = [];
  const structural = [];
  const todos = [];
  let totalKeys = 0;

  for (const area of referenceAreas) {
    const refLeaves = leaves(catalogs[DEFAULT_LOCALE][area]);
    totalKeys += refLeaves.length;
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      const cat = catalogs[locale][area];
      if (cat === undefined) {
        missing.push({ locale, area, path: [], reason: 'missing-area' });
        continue;
      }
      for (const { path: keyPath, value: refValue } of refLeaves) {
        const v = getAt(cat, keyPath);
        if (v === undefined) {
          missing.push({ locale, area, path: keyPath, reason: 'missing-key' });
        } else if (typeof v !== typeof refValue) {
          structural.push({ locale, area, path: keyPath });
        } else if (isTodoStub(v)) {
          todos.push({ locale, area, path: keyPath });
        } else if (
          typeof v === 'string' &&
          v.length === 0 &&
          typeof refValue === 'string' &&
          refValue.length > 0
        ) {
          // Only flag an empty translation when the reference value is non-empty.
          // A key intentionally empty in the reference (e.g. an unlabeled
          // actions-column header) must not be reported as a locale failure.
          missing.push({ locale, area, path: keyPath, reason: 'empty-string' });
        }
      }
    }
  }

  // Report.
  const total = SUPPORTED_LOCALES.length * totalKeys;
  console.log(
    `Locales: ${SUPPORTED_LOCALES.join(', ')}  Reference: ${DEFAULT_LOCALE}  ` +
      `Total reference keys: ${totalKeys}  Cells to verify: ${total - totalKeys}`,
  );

  if (todos.length > 0) {
    console.warn(`\nTODO stubs (${todos.length}) — translate before they rot:`);
    for (const t of todos) {
      console.warn(`  [${t.locale}] ${t.area}.${t.path.join('.')}`);
    }
  }

  if (structural.length > 0) {
    console.error(`\nStructural mismatches (${structural.length}):`);
    for (const s of structural) {
      console.error(
        `  [${s.locale}] ${s.area}.${s.path.join('.')} — type differs from ${DEFAULT_LOCALE}`,
      );
    }
    process.exit(2);
  }

  if (missing.length > 0) {
    console.error(`\nMissing translations (${missing.length}):`);
    for (const m of missing) {
      const where = m.path.length ? `${m.area}.${m.path.join('.')}` : m.area;
      console.error(`  [${m.locale}] ${where} (${m.reason})`);
    }
    process.exit(1);
  }

  console.log('\ni18n coverage: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
