import { describe, expect, it } from 'vitest';
import {
  type CategoryCapabilities,
  fieldsToClear,
  LINE_KIND_STRATEGIES,
  strategyFor,
} from './lineKinds';

/**
 * The line-kind strategy table, and the one thing that can silently rot: agreement with
 * the SERVER.
 *
 * `resolveLineKind` (`routers/expenses.ts`) decides the stored kind:
 *
 *   isMileage                → MILEAGE
 *   !acceptsTip OR tip <= 0  → STANDARD
 *   otherwise                → STANDARD_WITH_TIP
 *
 * The UI picks which FIELDS to offer from the category alone. If the two disagree, the row
 * offers a field the server will discard, or hides one it expects — and neither throws.
 * The table below is that rule restated, so a change to one side fails here.
 */

const MILEAGE: CategoryCapabilities = { isMileage: true };
const MEAL: CategoryCapabilities = { acceptsTip: true };
const PLAIN: CategoryCapabilities = {};
/** A category flagged both ways. Mileage has to win, as it does on the server. */
const BOTH: CategoryCapabilities = { isMileage: true, acceptsTip: true };

describe('strategyFor', () => {
  it('selects mileage for a distance-based category', () => {
    expect(strategyFor(MILEAGE).kind).toBe('MILEAGE');
  });

  it('selects the tip strategy for a category that accepts one', () => {
    expect(strategyFor(MEAL).kind).toBe('STANDARD_WITH_TIP');
  });

  it('falls back to standard for an ordinary category', () => {
    // The plain branch that did not exist before: an ordinary purchase now has a strategy
    // of its own rather than being the `else` of a mileage test.
    expect(strategyFor(PLAIN).kind).toBe('STANDARD');
  });

  it('lets mileage win over acceptsTip, exactly as the server does', () => {
    // `resolveLineKind` returns MILEAGE before it ever looks at the tip. Order in the
    // strategy list is what encodes that, so it is asserted rather than assumed.
    expect(strategyFor(BOTH).kind).toBe('MILEAGE');
  });

  it('falls back for an unknown or missing category', () => {
    // The row renders before a category is chosen, so `undefined` must resolve.
    expect(strategyFor(undefined).kind).toBe('STANDARD');
  });

  it('always resolves — the fallback is unconditional', () => {
    const last = LINE_KIND_STRATEGIES.at(-1);
    expect(last?.appliesTo(undefined)).toBe(true);
    expect(last?.kind).toBe('STANDARD');
  });
});

describe('agreement with the server rule', () => {
  /** `resolveLineKind`, restated. */
  const serverKind = (c: CategoryCapabilities, tipMinor: bigint) => {
    if (c.isMileage) return 'MILEAGE';
    if (!c.acceptsTip || tipMinor <= 0n) return 'STANDARD';
    return 'STANDARD_WITH_TIP';
  };

  it('offers tip fields exactly where the server would accept a tip', () => {
    /**
     * The load-bearing assertion. The UI cannot know the kind — a tip-accepting category
     * is only `STANDARD_WITH_TIP` once a tip is entered — so what has to hold is weaker
     * and more useful: the tip FIELD appears if and only if a non-zero tip would be
     * accepted.
     */
    for (const c of [MILEAGE, MEAL, PLAIN, BOTH]) {
      const offersTip = strategyFor(c).kind === 'STANDARD_WITH_TIP';
      const serverAcceptsTip = serverKind(c, 100n) === 'STANDARD_WITH_TIP';
      expect(offersTip, JSON.stringify(c)).toBe(serverAcceptsTip);
    }
  });

  it('agrees on the kind wherever the category alone determines it', () => {
    // Mileage and plain categories are decided by the category, so the UI's answer must
    // match the server's for ANY tip value — including a stray one.
    for (const c of [MILEAGE, PLAIN, BOTH]) {
      for (const tip of [0n, 100n, -5n]) {
        expect(strategyFor(c).kind, `${JSON.stringify(c)} tip=${tip}`).toBe(serverKind(c, tip));
      }
    }
  });

  it('names only kinds the server can store', () => {
    // A typo'd kind here would never match a stored row.
    const serverKinds = new Set(['STANDARD', 'STANDARD_WITH_TIP', 'MILEAGE']);
    for (const s of LINE_KIND_STRATEGIES) expect(serverKinds.has(s.kind)).toBe(true);
  });
});

describe('fieldsToClear', () => {
  it('clears nothing when the strategy does not change', () => {
    // Switching between two meal categories must not wipe the amount somebody typed.
    expect(fieldsToClear(MEAL, { acceptsTip: true })).toEqual([]);
    expect(fieldsToClear(PLAIN, {})).toEqual([]);
  });

  it('clears the amount AND the distance when crossing into mileage', () => {
    // A typed amount is not a distance. Carrying it across leaves a figure the server
    // will disagree with the moment it prices the line.
    const cleared = fieldsToClear(PLAIN, MILEAGE);
    expect(cleared).toContain('amount');
    expect(cleared).toContain('km');
  });

  it('clears the amount AND the distance when crossing OUT of mileage', () => {
    // Symmetric, and the direction that used to be easy to forget: a measured route is
    // not a typed amount.
    const cleared = fieldsToClear(MILEAGE, PLAIN);
    expect(cleared).toContain('amount');
    expect(cleared).toContain('km');
  });

  it('strips the tip when leaving a tip-accepting category', () => {
    // The server does the same — a tip on a category that does not accept one is how bad
    // data gets in — so the row must not keep showing one.
    expect(fieldsToClear(MEAL, PLAIN)).toContain('tip');
  });

  it('strips the tip when moving from a meal to mileage', () => {
    const cleared = fieldsToClear(MEAL, MILEAGE);
    expect(cleared).toContain('tip');
    expect(cleared).toContain('amount');
  });

  it('does not repeat a field named by both sides', () => {
    // `amount` is added unconditionally and may also appear in a strategy's own list.
    const cleared = fieldsToClear(MILEAGE, MEAL);
    expect(new Set(cleared).size).toBe(cleared.length);
  });

  it('treats an unset category as standard on either side', () => {
    expect(fieldsToClear(undefined, PLAIN)).toEqual([]);
    expect(fieldsToClear(undefined, MILEAGE)).toContain('km');
  });
});

describe('adding a kind', () => {
  it('needs only a strategy entry — the table is the extension point', () => {
    /**
     * The reason this file exists. Every strategy is self-describing: what it matches,
     * what it renders, what it clears. A fourth kind (per-diem, a foreign-tax line) is an
     * entry in `LINE_KIND_STRATEGIES` rather than another arm of a conditional, and this
     * test states the contract each entry must satisfy.
     */
    for (const s of LINE_KIND_STRATEGIES) {
      expect(typeof s.kind, 'kind').toBe('string');
      expect(typeof s.appliesTo, 'appliesTo').toBe('function');
      expect(Array.isArray(s.clearsOnExit), 'clearsOnExit').toBe(true);
      // `Fields` is optional — mileage renders its own component from the row, and
      // standard needs none.
      if (s.Fields !== undefined) expect(typeof s.Fields).toBe('function');
    }
  });
});
