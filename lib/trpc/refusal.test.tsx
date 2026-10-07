import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { refusalDataOf, refusalText, useRefusalText } from './refusal';

/**
 * The browser half of a translatable refusal: `data.refusal` in, a sentence in the
 * reader's language out — and the English message when the catalog has no sentence,
 * because a refusal the server phrased is better than a MISSING_MESSAGE token.
 */

const h = vi.hoisted(() => ({
  /** Keys the mocked catalog claims to have. */
  known: new Set<string>(),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key;
    t.has = (key: string) => h.known.has(key);
    return t;
  },
}));

const refused = (key: string, params?: Record<string, string | number>, message = 'English.') =>
  Object.assign(new Error(message), { data: { refusal: params ? { key, params } : { key } } });

/** A refusal whose `rows` is whatever the wire happened to deliver, valid or not. */
const refusedWithRows = (rows: unknown, key = 'refusals.ledger.referenceInUse') =>
  Object.assign(new Error('English.'), { data: { refusal: { key, rows } } });

const ROW = {
  key: 'ledger.reference.deleteTable.row',
  params: { table: 'Expense', column: 'categoryId', count: 4 },
};

describe('refusalDataOf', () => {
  it('reads the key and params off a tRPC client error', () => {
    expect(refusalDataOf(refused('refusals.fx.rateOutOfBounds', { max: 5 }))).toEqual({
      key: 'refusals.fx.rateOutOfBounds',
      params: { max: 5 },
    });
    expect(refusalDataOf(refused('refusals.expenses.reportNotEditable'))).toEqual({
      key: 'refusals.expenses.reportNotEditable',
    });
  });

  it('is null for anything that is not a refusal', () => {
    expect(refusalDataOf(new Error('plain'))).toBeNull();
    expect(refusalDataOf(Object.assign(new Error('x'), { data: { refusal: null } }))).toBeNull();
    expect(
      refusalDataOf(Object.assign(new Error('x'), { data: { refusal: { key: '' } } })),
    ).toBeNull();
    expect(refusalDataOf(Object.assign(new Error('x'), { data: 'nope' }))).toBeNull();
    expect(refusalDataOf(null)).toBeNull();
    expect(refusalDataOf('a string')).toBeNull();
  });

  it('copies well-formed detail rows through', () => {
    const rows = [ROW, { key: 'ledger.reference.deleteTable.rowNoParams' }];
    expect(refusalDataOf(refusedWithRows(rows))).toEqual({
      key: 'refusals.ledger.referenceInUse',
      rows,
    });
  });

  it('drops a malformed row and keeps its well-formed siblings', () => {
    // Every field here crossed the wire, so none of it is trusted. But one bad line must
    // not cost the reader the other lines, nor the headline sentence that explains the
    // refusal — an enumerated refusal that renders nothing is worse than a short one.
    const rows = [ROW, { key: '' }, { params: { table: 'Report' } }, null, 'a string', 7];
    expect(refusalDataOf(refusedWithRows(rows))).toEqual({
      key: 'refusals.ledger.referenceInUse',
      rows: [ROW],
    });
  });

  it('omits `rows` when nothing survives, and when it is not an array at all', () => {
    // A consumer reads `rows` as "are there detail lines to show". An empty array would
    // answer yes and render an empty list under the headline, so absent means absent —
    // the same rule the server keeps when it builds the object.
    for (const rows of [[], [{ key: '' }, null], 'nope', { 0: ROW }, null, undefined]) {
      const data = refusalDataOf(refusedWithRows(rows));
      expect(Object.keys(data ?? {}), JSON.stringify(rows ?? null)).toEqual(['key']);
    }
  });
});

describe('useRefusalText', () => {
  it('translates a key the catalog has, with its arguments', () => {
    h.known = new Set(['refusals.fx.rateOutOfBounds']);
    const { result } = renderHook(() => useRefusalText());
    expect(result.current(refused('refusals.fx.rateOutOfBounds', { max: 1_000_000 }))).toBe(
      'refusals.fx.rateOutOfBounds:1000000',
    );
  });

  it('falls back to the English message for a key the catalog has not learned', () => {
    h.known = new Set();
    const { result } = renderHook(() => useRefusalText());
    expect(result.current(refused('refusals.fx.notYet', undefined, 'Not yet.'))).toBe('Not yet.');
  });

  it('shows the message of an ordinary error, and the fallback when there is none', () => {
    const { result } = renderHook(() => useRefusalText());
    expect(result.current(new Error('Somebody else changed this first.'))).toBe(
      'Somebody else changed this first.',
    );
    expect(result.current({ status: 500 }, 'Upload failed.')).toBe('Upload failed.');
    // A plain object's `message` is not a sentence anybody wrote for the reader.
    expect(result.current({ message: 'error' }, 'Upload failed.')).toBe('Upload failed.');
    expect(result.current(undefined)).toBe('');
  });
});

describe('refusalText', () => {
  it('tolerates a translator without `has`, as a mocked one may be', () => {
    const t = ((key: string) => key) as unknown as Parameters<typeof refusalText>[0];
    expect(refusalText(t, refused('refusals.x.y', undefined, 'Spoken.'))).toBe('Spoken.');
  });
});
