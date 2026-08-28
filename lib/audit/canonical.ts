/**
 * VX2-6 — canonical JSON for hashing.
 *
 * PORTED VERBATIM from ExpenseOS `packages/audit/src/canonical.ts`, including the
 * BigInt throw, because every one of these conventions is load-bearing for a
 * hash chain and none of them is obvious:
 *
 *  - object keys are sorted, so the same logical payload always produces the
 *    same byte sequence regardless of property insertion order. Without this, a
 *    refactor that reorders a struct literal silently invalidates every hash
 *    written before it;
 *  - `undefined` is dropped (matching JSON.stringify), `null` is PRESERVED — the
 *    difference matters: an absent field and an explicitly-null one must not
 *    hash alike;
 *  - `Date` serializes as ISO-8601, which is why the writer inserts the exact
 *    timestamp it hashed rather than letting the column default fill it in;
 *  - BigInt THROWS.
 *
 * That last one matters more here than it did for ExpenseOS. VeloExpense money is
 * minor units in `bigint` columns and `lib/money.ts` is deliberately
 * string/bigint with no float anywhere, so `details: { totalMinor: BigInt(x) }`
 * is a natural thing to write — and it would throw at audit-write time, i.e.
 * INSIDE the transaction that was recording a state change, failing the business
 * operation rather than just the log line.
 *
 * The rule for callers: AMOUNTS GO IN AS STRINGS. `pg` already returns bigint
 * columns as strings, so the natural path is correct and only an explicit
 * `BigInt()` breaks it. See GAP-AUDIT AU-5.
 *
 * This module is PURE — no pg, no I/O — so it can be unit-tested and so the
 * verifier can recompute a hash without a database.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') {
    throw new TypeError(
      'canonical(): BigInt values are not supported in audit payloads — pass minor amounts as strings',
    );
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    sorted[key] = normalize(v);
  }
  return sorted;
}
