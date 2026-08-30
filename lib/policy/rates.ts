/**
 * VX3-2 — the FX rate lookup the policy engine compares through.
 *
 * PURE. No `pg` import, by the house rule for registry modules: `rules.ts` is
 * synchronous and pure, so rates have to arrive ON the context rather than be
 * fetched during evaluation. `lib/policy/service.ts` loads the rows and builds
 * this; `test/policy-rates.test.ts` exercises it without a database.
 *
 * ── Three properties, and the second is the one PE-7 is about ───────────────
 *
 * 1. LATEST ON OR BEFORE. A pair can have many rows; the lookup keeps the most
 *    recent whose `as_of` is not in the future relative to the date it was built
 *    for. A rate from tomorrow is not a rate for today's report.
 * 2. RECIPROCALS ARE DERIVED. ExpenseOS builds its map forward-only —
 *    `` const key = `${r.base}->${r.quote}` `` and nothing else — and its source is
 *    the Bank of Canada, which publishes CAD-quoted pairs. So `USD->CAD` exists,
 *    `CAD->USD` does not, and an admin who correctly sets a US entity's policy
 *    currency to USD finds EVERY CAD amount unconvertible. Their GA audit recorded
 *    that as "CAD excluded from totals" and treated it as a US-fit blocker. One
 *    division fixes it, and it cannot drift the way a second stored row can.
 * 3. A MISS IS A MISS, AND SAYS SO. `find` returns null rather than a guess. The
 *    caller's obligation is to emit a diagnostic, never to substitute the
 *    unconverted amount — which is exactly what ExpenseOS's v2 predicate path
 *    does, comparing 10,000 JPY minor units against a CAD threshold as though the
 *    number needed no conversion at all.
 *
 * NO TRIANGULATION, deliberately. If a tenant needs EUR→JPY and holds only
 * CAD-quoted pairs, this returns null rather than routing through CAD. Two
 * chained roundings on a threshold comparison, in service of a pair nobody has
 * configured, is a worse answer than "I could not check this".
 */
import { reciprocalRate, rateToScaled } from '@/lib/money';

export interface RateRow {
  base: string;
  quote: string;
  /** As it comes out of `numeric(18,8)`: a decimal string. */
  rate: string;
  as_of: string | Date;
}

export type RateBasis = 'IDENTITY' | 'DIRECT' | 'RECIPROCAL';

export interface RateHit {
  /** The multiplier, as an integer scaled by 10^8. */
  scaled: bigint;
  basis: RateBasis;
  /** The `as_of` of the row this came from — '' for IDENTITY. */
  asOf: string;
}

export interface RateLookup {
  find(from: string, to: string): RateHit | null;
  /** For a diagnostic: which pairs are actually known. */
  pairs(): string[];
}

function dateKey(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/**
 * Build a lookup from rate rows.
 *
 * `onOrBefore` bounds which rows count — pass the report's date to evaluate a
 * report against the rates that existed when it was filed, or today's date for a
 * live check. Omitted means "no bound", which is only right for a test.
 */
export function buildRateLookup(rows: RateRow[], onOrBefore?: string | Date): RateLookup {
  const bound = onOrBefore === undefined ? null : dateKey(onOrBefore);
  const latest = new Map<string, { rate: string; asOf: string }>();

  for (const row of rows) {
    const asOf = dateKey(row.as_of);
    if (bound !== null && asOf > bound) continue;
    const key = `${row.base}->${row.quote}`;
    const held = latest.get(key);
    // Strictly newer wins. Equal dates keep the first, which makes the result
    // depend on the query's ORDER BY rather than on Map iteration order — so
    // `service.ts` orders by as_of DESC and this stays deterministic either way.
    if (!held || asOf > held.asOf) latest.set(key, { rate: row.rate, asOf });
  }

  return {
    find(from, to) {
      if (from === to) return { scaled: 10n ** 8n, basis: 'IDENTITY', asOf: '' };
      const direct = latest.get(`${from}->${to}`);
      if (direct) {
        return { scaled: rateToScaled(direct.rate), basis: 'DIRECT', asOf: direct.asOf };
      }
      const inverse = latest.get(`${to}->${from}`);
      if (inverse) {
        return { scaled: reciprocalRate(inverse.rate), basis: 'RECIPROCAL', asOf: inverse.asOf };
      }
      return null;
    },
    pairs() {
      return [...latest.keys()].sort();
    },
  };
}

/** An empty lookup — every cross-currency query misses. Used when no rates exist. */
export function noRates(): RateLookup {
  return buildRateLookup([]);
}
