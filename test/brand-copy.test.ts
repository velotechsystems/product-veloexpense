/**
 * f65 — no reader sees the source app's name.
 *
 * VeloExpense ports ExpenseOS's screens with ExpenseOS's catalogues (packages/i18n), and those
 * said "ExpenseOS" in 37 places a person reads: the app name, the sign-in title, the offline
 * notice, the install prompts, NetSuite reconciliation. They now say VeloExpense, and this
 * fails the moment a port brings one back.
 *
 * What it walks: every string VALUE in every locale's ported catalogue, and every string in
 * VeloExpense's own copy modules (lib/i18n/catalog). Keys are not copy (`KEEP_EXPENSEOS` is a
 * stored enum value, and renaming it would orphan rows), and code comments — where naming
 * ExpenseOS is how this project records why it differs — are not read here at all.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as controlMessages from '@/lib/i18n/catalog/control-messages';
import * as enums from '@/lib/i18n/catalog/enums';
import * as errors from '@/lib/i18n/catalog/errors';
import * as fraudMessages from '@/lib/i18n/catalog/fraud-messages';
import * as ui from '@/lib/i18n/catalog/ui';

const SOURCE_NAME = /expense\s*os/i;

/** Every string reachable from `value`, with the path that reached it. */
function strings(value: unknown, path: string, out: Array<[string, string]>, seen = new Set<unknown>()) {
  if (typeof value === 'string') {
    out.push([path, value]);
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out, seen);
}

const CATALOGS = join(process.cwd(), 'packages/i18n/src/catalogs');

describe('f65: the product is VeloExpense wherever a reader sees its name', () => {
  it('no ported catalogue value, in any locale, names ExpenseOS', async () => {
    const found: Array<[string, string]> = [];
    for (const locale of await readdir(CATALOGS)) {
      for (const file of await readdir(join(CATALOGS, locale))) {
        if (!file.endsWith('.json')) continue;
        const json: unknown = JSON.parse(await readFile(join(CATALOGS, locale, file), 'utf8'));
        strings(json, `${locale}/${file}`, found);
      }
    }
    expect(found.length).toBeGreaterThan(1000);
    expect(found.filter(([, v]) => SOURCE_NAME.test(v))).toEqual([]);
    // The app's own name, which the tab title, the sign-in page and the shell read.
    const common = JSON.parse(await readFile(join(CATALOGS, 'en', 'common.json'), 'utf8'));
    expect(common.appName).toBe('VeloExpense');
  });

  it('no VeloExpense copy module names ExpenseOS', () => {
    const found: Array<[string, string]> = [];
    for (const [name, mod] of Object.entries({ controlMessages, enums, errors, fraudMessages, ui })) {
      strings(mod, name, found);
    }
    expect(found.length).toBeGreaterThan(100);
    expect(found.filter(([, v]) => SOURCE_NAME.test(v))).toEqual([]);
  });
});
