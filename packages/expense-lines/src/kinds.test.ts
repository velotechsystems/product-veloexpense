// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  EXPENSE_LINE_KINDS,
  kindCarriesTip,
  parseLinePayload,
  payloadSchemaFor,
  tipMinorOf,
  tipPayload,
  totalTipMinor,
} from './kinds';

/**
 * The line-kind registry. Nine importers, no tests, and invisible to the coverage
 * floor because the implementation lived in `index.ts` — which coverage excludes as a
 * re-export barrel.
 *
 * What it guards is a money invariant: `tipMinor` is the untaxed part of the line's OWN
 * `amountMinor`, not an addition to it, so "expense = sum of lines" keeps holding and
 * the receipt still reconciles. The tip also leaves the taxable base, so a tip read
 * wrong is tax computed wrong.
 */

describe('the registry', () => {
  it('has a payload schema for every kind', () => {
    // A kind added without a schema throws at the first write rather than here.
    for (const kind of EXPENSE_LINE_KINDS) {
      expect(payloadSchemaFor(kind)).toBeDefined();
    }
  });

  it('only STANDARD_WITH_TIP carries a tip', () => {
    expect(kindCarriesTip('STANDARD_WITH_TIP')).toBe(true);
    expect(kindCarriesTip('STANDARD')).toBe(false);
    // MILEAGE is registered but keeps its dedicated columns; it has no tip either.
    expect(kindCarriesTip('MILEAGE')).toBe(false);
  });
});

describe('parseLinePayload — the WRITE path, which must reject', () => {
  it('accepts an empty payload for a kind that needs none', () => {
    expect(parseLinePayload('STANDARD', null)).toEqual({});
    expect(parseLinePayload('STANDARD', {})).toEqual({});
    expect(parseLinePayload('MILEAGE', undefined)).toEqual({});
  });

  it('accepts a well-formed tip', () => {
    expect(parseLinePayload('STANDARD_WITH_TIP', { tipMinor: '250' })).toEqual({
      tipMinor: '250',
    });
  });

  it('refuses a tip that is not digit-string minor units', () => {
    // Minor units travel as digit strings because BigInt does not survive JSON. A
    // float or a negative here would become a wrong taxable base.
    for (const bad of ['2.50', '-250', '', 'abc', '250 ']) {
      expect(() => parseLinePayload('STANDARD_WITH_TIP', { tipMinor: bad })).toThrow();
    }
    expect(() => parseLinePayload('STANDARD_WITH_TIP', { tipMinor: 250 })).toThrow();
  });

  it('refuses a missing tip on a tip line', () => {
    expect(() => parseLinePayload('STANDARD_WITH_TIP', {})).toThrow();
  });

  it('refuses extra keys, so a typo is not silently stored', () => {
    // `.strict()` — a payload is a contract, and `{ tipMinour: '250' }` would
    // otherwise persist as a tip of nothing.
    expect(() => parseLinePayload('STANDARD_WITH_TIP', { tipMinor: '1', extra: 1 })).toThrow();
    expect(() => parseLinePayload('STANDARD', { tipMinor: '250' })).toThrow();
  });
});

describe('tipMinorOf — the READ path, which must NOT throw', () => {
  it('returns the tip on a tip line', () => {
    expect(tipMinorOf({ kind: 'STANDARD_WITH_TIP', payload: { tipMinor: '250' } })).toBe(250n);
  });

  it('returns 0 for a kind that carries no tip, whatever the payload says', () => {
    // The kind is the authority, not the payload: a STANDARD line with a stray
    // tipMinor is a data error and must not remove anything from the taxable base.
    expect(tipMinorOf({ kind: 'STANDARD', payload: { tipMinor: '250' } })).toBe(0n);
    expect(tipMinorOf({ kind: 'MILEAGE', payload: { tipMinor: '250' } })).toBe(0n);
  });

  it('is tolerant of a malformed payload rather than throwing', () => {
    /**
     * Deliberately asymmetric with the write path. A display or totals path must not
     * break on one bad row — a report that cannot render is worse than a tip read as
     * zero, and the write path is where a payload is rejected.
     */
    for (const payload of [null, undefined, {}, { tipMinor: 'abc' }, { tipMinor: -1 }, 'nope', 7]) {
      expect(tipMinorOf({ kind: 'STANDARD_WITH_TIP', payload })).toBe(0n);
    }
  });

  it('handles a tip larger than Number.MAX_SAFE_INTEGER', () => {
    // BigInt end to end: the digit-string encoding exists precisely so a large
    // minor-unit value does not lose precision.
    const huge = '9007199254740993';
    expect(tipMinorOf({ kind: 'STANDARD_WITH_TIP', payload: { tipMinor: huge } })).toBe(
      BigInt(huge),
    );
  });
});

describe('totalTipMinor', () => {
  it('sums only the lines that carry one', () => {
    expect(
      totalTipMinor([
        { kind: 'STANDARD_WITH_TIP', payload: { tipMinor: '250' } },
        { kind: 'STANDARD', payload: null },
        { kind: 'STANDARD_WITH_TIP', payload: { tipMinor: '125' } },
        { kind: 'MILEAGE', payload: {} },
      ]),
    ).toBe(375n);
  });

  it('is 0n for no lines', () => {
    // 0n, not 0 — the caller subtracts this from a BigInt taxable base.
    expect(totalTipMinor([])).toBe(0n);
  });

  it('ignores a malformed row instead of failing the whole report', () => {
    expect(
      totalTipMinor([
        { kind: 'STANDARD_WITH_TIP', payload: { tipMinor: 'x' } },
        { kind: 'STANDARD_WITH_TIP', payload: { tipMinor: '100' } },
      ]),
    ).toBe(100n);
  });
});

describe('tipPayload', () => {
  it('builds a tip line for a positive tip', () => {
    expect(tipPayload(250n)).toEqual({
      kind: 'STANDARD_WITH_TIP',
      payload: { tipMinor: '250' },
    });
  });

  it('degrades to STANDARD at zero, so a cleared tip leaves no tip-kind line', () => {
    // A STANDARD_WITH_TIP line claiming no tip would show a tip field on a line that
    // has none, and would read as a tip of zero rather than no tip at all.
    expect(tipPayload(0n)).toEqual({ kind: 'STANDARD', payload: null });
  });

  it('degrades to STANDARD for a negative tip', () => {
    // Not representable — minor units are non-negative — so it is treated as cleared
    // rather than persisted and rejected later by the write path.
    expect(tipPayload(-1n)).toEqual({ kind: 'STANDARD', payload: null });
  });

  it('round-trips through the write path and back', () => {
    // The whole contract in one line: what `tipPayload` builds must validate, and must
    // read back as the same number.
    const built = tipPayload(1234n);
    expect(parseLinePayload(built.kind, built.payload)).toEqual({ tipMinor: '1234' });
    expect(tipMinorOf({ kind: built.kind, payload: built.payload })).toBe(1234n);
  });
});
