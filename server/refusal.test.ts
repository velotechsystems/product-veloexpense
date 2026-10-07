import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { REFUSAL_KEYS, Refusal, refusal, refusalData } from './refusal';

/**
 * A refusal the browser can translate.
 *
 * The keys in `REFUSAL_KEYS` are composed at runtime — `t(error.data.refusal.key)` — so
 * neither i18n gate can see them: `check-used-keys` looks for `t('literal')` call sites,
 * and `check-coverage` compares EN against FR-CA, which agree when a key is absent from
 * BOTH. The client falls back to the English message when a key is missing, so a key
 * that was never written fails no test and no build; it just shows an FR-CA reader an
 * English sentence. This file is where such a key is caught.
 */

// VeloExpense: ported code sits at the repo root, so the catalogues are one level up.
const CATALOGS = resolve(__dirname, '../packages/i18n/src/catalogs');
const catalog = (locale: string) =>
  JSON.parse(readFileSync(resolve(CATALOGS, locale, 'refusals.json'), 'utf8')) as Record<
    string,
    unknown
  >;

/** Resolve `refusals.expenses.reportNotEditable` against the `refusals` area's JSON. */
function lookup(area: Record<string, unknown>, key: string): unknown {
  const [head, ...rest] = key.split('.');
  expect(head).toBe('refusals');
  let cur: unknown = area;
  for (const p of rest) {
    if (cur === null || typeof cur !== 'object' || !(p in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** The `{name` argument names an ICU message asks for. */
const icuArgs = (msg: string) =>
  new Set([...msg.matchAll(/\{\s*([A-Za-z_]\w*)/g)].map((m) => m[1]));

describe('REFUSAL_KEYS', () => {
  const keys = Object.values(REFUSAL_KEYS);

  it('are all full paths under the refusals area, and distinct', () => {
    // The area may be camelCase (`expenseCategories`), as catalog areas already are.
    for (const k of keys) expect(k).toMatch(/^refusals\.[a-z][A-Za-z]*\.[A-Za-z]+$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(['en', 'fr-CA'])('every key has a sentence in %s', (locale) => {
    const area = catalog(locale);
    for (const k of keys) {
      const msg = lookup(area, k);
      expect(typeof msg, `${k} in ${locale}`).toBe('string');
      expect((msg as string).trim().length, `${k} in ${locale}`).toBeGreaterThan(0);
    }
  });

  it('asks for the same ICU arguments in both locales', () => {
    // A French sentence that dropped `{amount}` would render fine and say less; one that
    // added `{merchant}` would render the raw token. Both are parity failures the
    // coverage gate cannot see, because it checks presence, not content.
    const en = catalog('en');
    const fr = catalog('fr-CA');
    for (const k of keys) {
      expect(icuArgs(lookup(fr, k) as string), k).toEqual(icuArgs(lookup(en, k) as string));
    }
  });
});

/** Two detail lines, as the reference delete builds them: one per foreign key. */
const IN_USE_ROWS = [
  {
    key: 'ledger.reference.deleteTable.row',
    params: { table: 'Expense', column: 'categoryId', count: 4 },
  },
  {
    key: 'ledger.reference.deleteTable.row',
    params: { table: 'Report', column: 'locationId', count: 1 },
  },
];

/**
 * VeloExpense: ExpenseOS demonstrates detail rows with its NetSuite refusals, which arrive
 * (renamed) with the ledger integration in Wave 5. The rows mechanism does not care which key
 * carries them, so these cases use the Expense categories refusal instead; the row KEYS are
 * still ExpenseOS's catalogue paths, which is all `refusalData` passes through.
 */
const ROWS_KEY = REFUSAL_KEYS.expenseCategoryNsMissing;

describe('refusal()', () => {
  it('is a TRPCError with the English message and the key in its cause', () => {
    const err = refusal('BAD_REQUEST', REFUSAL_KEYS.reportNotEditable, 'Report is not editable.');
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('Report is not editable.');
    expect(err.cause).toBeInstanceOf(Refusal);
    expect(refusalData(err)).toEqual({ key: REFUSAL_KEYS.reportNotEditable });
  });

  it('carries the sentence arguments beside the key', () => {
    const err = refusal('BAD_REQUEST', REFUSAL_KEYS.fxRateOutOfBounds, 'Rate must be…', {
      max: 1_000_000,
    });
    expect(refusalData(err)).toEqual({
      key: REFUSAL_KEYS.fxRateOutOfBounds,
      params: { max: 1_000_000 },
    });
  });

  it('carries detail rows as the fifth argument, past an empty fourth', () => {
    // The call shape a future caller will get wrong. A refusal that enumerates usually
    // has NO ICU arguments of its own — the figures are in the rows — so `params` is an
    // explicit `undefined` placeholder. Pinned here so that reading is not lost.
    const err = refusal(
      'CONFLICT',
      ROWS_KEY,
      'Reference is still in use.',
      undefined,
      IN_USE_ROWS,
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('Reference is still in use.');
    expect(refusalData(err)).toEqual({
      key: ROWS_KEY,
      rows: IN_USE_ROWS,
    });
  });
});

describe('refusalData()', () => {
  it('is null for every error that was not thrown as a refusal', () => {
    expect(refusalData(new TRPCError({ code: 'NOT_FOUND' }))).toBeNull();
    expect(refusalData(new TRPCError({ code: 'BAD_REQUEST', cause: new Error('x') }))).toBeNull();
    expect(refusalData(new Error('plain'))).toBeNull();
    expect(refusalData(null)).toBeNull();
    expect(refusalData(undefined)).toBeNull();
    expect(refusalData('string')).toBeNull();
  });

  it('OMITS an absent `rows` rather than setting it to undefined', () => {
    // `toEqual` cannot see this regression — it treats `{ key, rows: undefined }` as
    // equal to `{ key }` — so the shape is asserted by its own keys instead. The
    // distinction is load-bearing twice over: the router suites assert this object whole
    // with `toEqual`, and the browser reads `refusal.rows` as "are there detail lines",
    // which an explicit `undefined` would answer the same way but a serialiser need not
    // carry the same way. Absent means absent.
    const data = refusalData(refusal('BAD_REQUEST', REFUSAL_KEYS.documentsClosed, 'Closed.'));
    expect(Object.keys(data ?? {})).toEqual(['key']);
    expect(data).toEqual({ key: REFUSAL_KEYS.documentsClosed });
  });

  it('includes `rows` when the refusal carries them, beside any params', () => {
    const data = refusalData(
      refusal('CONFLICT', ROWS_KEY, 'x', { value: 'Meals' }, IN_USE_ROWS),
    );
    expect(Object.keys(data ?? {})).toEqual(['key', 'params', 'rows']);
    expect(data).toEqual({
      key: ROWS_KEY,
      params: { value: 'Meals' },
      rows: IN_USE_ROWS,
    });
  });
});
