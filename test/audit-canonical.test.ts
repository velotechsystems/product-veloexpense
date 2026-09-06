/**
 * VX2-6 — canonical(), the pure half of the hash chain.
 *
 * No database. These conventions are the reason a hash written today still
 * verifies after a refactor, so each one gets an assertion rather than a comment.
 */
import { describe, it, expect } from 'vitest';
import { canonical } from '@/lib/audit/canonical';
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/audit/actions';
import { VERDICTS } from '@/lib/fraud/review';

describe('canonical', () => {
  it('sorts object keys, so insertion order cannot change a hash', () => {
    // THE property. Without it, a refactor that reorders a struct literal
    // silently invalidates every hash written before it.
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys at every depth, not just the top', () => {
    expect(canonical({ z: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] })).toBe(
      '{"a":[{"x":2,"y":1}],"z":{"c":2,"d":1}}',
    );
  });

  it('drops undefined but PRESERVES null', () => {
    // An absent field and an explicitly-null one must not hash alike: "no IP was
    // recorded" and "the IP was recorded as nothing" are different claims.
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonical({ b: null })).not.toBe(canonical({}));
  });

  it('serializes Date as ISO-8601', () => {
    expect(canonical({ t: new Date('2026-08-28T17:15:17.944Z') })).toBe(
      '{"t":"2026-08-28T17:15:17.944Z"}',
    );
  });

  it('THROWS on BigInt', () => {
    /**
     * The one that matters most here. VeloExpense money is minor units in bigint
     * columns, so `details: { totalMinor: BigInt(x) }` is a natural thing to
     * write — and it would throw inside the transaction recording a state
     * change, failing the business operation rather than just the log line.
     * Amounts go in as strings; `pg` already returns bigint columns that way.
     */
    expect(() => canonical({ totalMinor: 100000n })).toThrow(/BigInt/);
    expect(() => canonical({ nested: { deep: [1n] } })).toThrow(/BigInt/);
    // …and the correct form is accepted.
    expect(canonical({ totalMinor: '100000' })).toBe('{"totalMinor":"100000"}');
  });

  it('handles primitives and arrays without wrapping them', () => {
    expect(canonical(null)).toBe('null');
    expect(canonical('x')).toBe('"x"');
    expect(canonical([3, 1, 2])).toBe('[3,1,2]');
    // Array ORDER is meaningful and must not be sorted.
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});

/* ── PE-cleanup: the action vocabulary has ONE shape ───────────────────────────
 *
 * Six branding actions were lower-case-dotted where the other thirty-six are
 * SCREAMING_SNAKE. They were renamed while it was still possible to — the action
 * string is inside the hash payload, so a row's spelling is immutable once
 * written, and after the first real customer the mixed history would be
 * permanent.
 *
 * This is what stops a thirty-seventh arriving in the old shape and starting the
 * problem over. It asserts the SHAPE rather than listing the members, so it does
 * not have to be edited every time an action is added — IL-7's rule about a
 * guard that restates the list it polices.
 */
describe('the audit action vocabulary', () => {
  it('is SCREAMING_SNAKE throughout, with no dotted survivors', () => {
    const wrong = AUDIT_ACTIONS.filter((a) => !/^[A-Z][A-Z0-9_]*$/.test(a));
    expect(wrong, `these are not SCREAMING_SNAKE: ${wrong.join(', ')}`).toEqual([]);
  });

  /* The fraud verdicts are NOT in the array — they are a template literal TYPE,
   * `FRAUD_FLAG_${Verdict}`, unioned into `AuditAction`. The first version of
   * this test asserted they were members and failed, which was the test being
   * wrong rather than the code: putting them in the array would be the hand-typed
   * duplicate the template type exists to avoid.
   *
   * So the assertion is a COMPILE-TIME one. A verdict that stopped producing a
   * valid `AuditAction` would fail `tsc`, which is the same gate the throw sites
   * already pass through — and a runtime loop here would only be re-checking
   * what the compiler already refused to build. */
  it('accepts a derived fraud verdict action, by type', () => {
    const derived: AuditAction = `FRAUD_FLAG_${VERDICTS[0]}`;
    expect(derived.startsWith('FRAUD_FLAG_')).toBe(true);
    // And the shape rule above holds for the derived family too.
    expect(/^[A-Z][A-Z0-9_]*$/.test(derived)).toBe(true);
  });
});
