import { TRAVEL_LINE_KINDS } from '@expenseos/travel-lines';
import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, fieldsToClear, strategyFor, TRAVEL_LINE_STRATEGIES } from './lineKinds';

/**
 * The registry, and the drift it exists to catch.
 *
 * A kind added to the enum with no strategy falls back to `standard` SILENTLY: the block
 * renders a bare amount box, the days and the daily cap are never sent, and the line
 * quietly prices as whatever somebody typed. Nothing throws and nothing looks wrong,
 * which is precisely the failure mode the expense-side registry was built to stop —
 * `STANDARD_WITH_TIP` existed as a kind, was written by extraction, and had no UI at all.
 */

describe('coverage of the kind enum', () => {
  it('has a strategy for every kind', () => {
    for (const kind of TRAVEL_LINE_KINDS) {
      expect(TRAVEL_LINE_STRATEGIES[kind], `no strategy for ${kind}`).toBeDefined();
    }
  });

  it('has no strategy for a kind the enum does not have', () => {
    // The other direction: a strategy left behind after a kind was removed would render
    // fields the server has no column to store.
    expect(Object.keys(TRAVEL_LINE_STRATEGIES).sort()).toEqual([...TRAVEL_LINE_KINDS].sort());
  });

  it('agrees with itself about which kind each strategy is for', () => {
    // A copy-paste that leaves `kind: 'CAR_RENTAL'` on the GROUND entry would send a
    // car's payload shape for a taxi, and the server would refuse it at the registry.
    for (const kind of TRAVEL_LINE_KINDS) {
      expect(TRAVEL_LINE_STRATEGIES[kind].kind).toBe(kind);
    }
  });
});

describe('strategyFor', () => {
  it('falls back to the amount box for an unrecognised kind', () => {
    // The safe direction: a traveller can always type a figure. Rendering nothing would
    // leave a line that cannot be edited at all.
    expect(strategyFor('SOMETHING_NEW').kind).toBe('STANDARD');
    expect(strategyFor(null).kind).toBe('STANDARD');
    expect(strategyFor(undefined).kind).toBe('STANDARD');
  });

  it('offers extra fields only to the kinds priced from a cap', () => {
    // Airfare and lodging are amount-only until their pickers land — which is also the
    // documented path for an org with no provider configured.
    const withFields = TRAVEL_LINE_KINDS.filter((k) => TRAVEL_LINE_STRATEGIES[k].Fields);
    expect(withFields).toEqual(['CAR_RENTAL', 'GROUND']);
  });
});

describe('buildPayload', () => {
  const draft = { ...EMPTY_DRAFT, days: '3', dailyCap: '75.00' };

  it('sends days and a daily cap in MINOR units as a digit string', () => {
    // BigInt does not survive JSON, so the payload registry takes digit strings — and a
    // float that got past here would be a float in an approved estimate.
    expect(TRAVEL_LINE_STRATEGIES.CAR_RENTAL.buildPayload?.(draft)).toEqual({
      days: 3,
      dailyCapMinor: '7500',
    });
  });

  it('sends nothing when neither field has been touched', () => {
    // An untouched block must not post `{ days: 0, dailyCapMinor: '0' }` and overwrite a
    // figure that was derived properly.
    expect(TRAVEL_LINE_STRATEGIES.CAR_RENTAL.buildPayload?.(EMPTY_DRAFT)).toBeNull();
  });

  it('carries the note on a ground leg but not on a car', () => {
    // Nobody plans the calendar of their airport taxis, so GROUND takes a note where a
    // car takes dates.
    const withNote = { ...draft, note: '  Airport transfers  ' };
    expect(TRAVEL_LINE_STRATEGIES.GROUND.buildPayload?.(withNote)).toEqual({
      days: 3,
      dailyCapMinor: '7500',
      note: 'Airport transfers',
    });
    expect(TRAVEL_LINE_STRATEGIES.CAR_RENTAL.buildPayload?.(withNote)).not.toHaveProperty('note');
  });

  it('refuses a negative or unparseable figure rather than sending it', () => {
    for (const dailyCap of ['-50', 'abc', '']) {
      const out = TRAVEL_LINE_STRATEGIES.CAR_RENTAL.buildPayload?.({
        ...EMPTY_DRAFT,
        days: '3',
        dailyCap,
      });
      expect(out).toEqual({ days: 3, dailyCapMinor: null });
    }
  });

  it('treats a nonsense day count as zero rather than NaN', () => {
    // NaN would reach the server as a payload the registry refuses, turning a typo into
    // an error instead of a zero the traveller can see and fix.
    expect(TRAVEL_LINE_STRATEGIES.CAR_RENTAL.buildPayload?.({ ...draft, days: 'x' })).toEqual({
      days: 0,
      dailyCapMinor: '7500',
    });
  });

  it('gives the amount-only kinds no payload builder at all', () => {
    expect(TRAVEL_LINE_STRATEGIES.STANDARD.buildPayload).toBeUndefined();
    expect(TRAVEL_LINE_STRATEGIES.AIRFARE.buildPayload).toBeUndefined();
  });
});

describe('fieldsToClear', () => {
  it('clears nothing when the kind does not change', () => {
    // Otherwise editing a car's day count would wipe the cap beside it.
    expect(fieldsToClear('CAR_RENTAL', 'CAR_RENTAL')).toEqual([]);
  });

  it('clears both sides plus the amount when crossing kinds', () => {
    /**
     * Both directions. A typed amount is not a day count and a daily cap is not a fare,
     * so leaving a car has to drop the days and arriving at one has to drop an amount
     * that was priced some other way. A stale figure the server disagrees with is worse
     * than an empty field.
     */
    const cleared = fieldsToClear('CAR_RENTAL', 'STANDARD');
    expect(cleared).toContain('days');
    expect(cleared).toContain('dailyCap');
    expect(cleared).toContain('amount');
  });

  it('clears the amount even between two kinds that share their fields', () => {
    // CAR_RENTAL and GROUND both price from a cap × days, but a car's daily rate is not
    // a taxi's.
    expect(fieldsToClear('CAR_RENTAL', 'GROUND')).toContain('amount');
  });
});
