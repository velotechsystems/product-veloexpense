/**
 * VX2-6 — canonical(), the pure half of the hash chain.
 *
 * No database. These conventions are the reason a hash written today still
 * verifies after a refactor, so each one gets an assertion rather than a comment.
 */
import { describe, it, expect } from 'vitest';
import { canonical } from '@/lib/audit/canonical';

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
