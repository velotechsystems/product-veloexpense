// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { evaluatePredicate, makePredicateSchema, type Predicate } from './predicate';

/**
 * The condition primitive behind BOTH the approvals routing engine and the policy
 * engine. It had no tests, and it was invisible to the coverage floor because its
 * implementation lived in `index.ts` — which coverage excludes as a barrel.
 *
 * The module's own header states five invariants and says "do not change without
 * updating both consumers". Those are what this file pins, because they are the
 * contract two engines were written against: change one silently and a routing rule
 * starts matching different reports, or a policy stops firing, with nothing failing.
 */

type Field = 'amount' | 'category' | 'categoryIds' | 'flag' | 'name';
const ev = (pred: Predicate<Field>, facts: Partial<Record<Field, unknown>>) =>
  evaluatePredicate(pred, facts as never);

describe('numeric ops require BOTH operands to be numbers', () => {
  /**
   * The invariant that stops a string sneaking through a threshold. `'150' > 100` is
   * true in JavaScript, so without this a fact that arrived as a string would compare
   * as a number and a $150 limit would pass a $150.00 charge silently.
   */
  it('compares two numbers', () => {
    expect(ev({ field: 'amount', op: 'gt', value: 100 }, { amount: 150 })).toBe(true);
    expect(ev({ field: 'amount', op: 'gt', value: 100 }, { amount: 50 })).toBe(false);
    expect(ev({ field: 'amount', op: 'gte', value: 100 }, { amount: 100 })).toBe(true);
    expect(ev({ field: 'amount', op: 'lt', value: 100 }, { amount: 99 })).toBe(true);
    expect(ev({ field: 'amount', op: 'lte', value: 100 }, { amount: 100 })).toBe(true);
  });

  it('refuses a numeric comparison when either side is a string', () => {
    // NOT true, even though JS would coerce '150' > 100.
    expect(ev({ field: 'amount', op: 'gt', value: 100 }, { amount: '150' })).toBe(false);
    expect(ev({ field: 'amount', op: 'gt', value: '100' }, { amount: 150 })).toBe(false);
  });

  it('refuses a numeric comparison against a missing fact', () => {
    // A missing fact is null; `null > 100` would be false anyway, but `null >= 0`
    // would be TRUE under coercion, which is the case that bites.
    expect(ev({ field: 'amount', op: 'gte', value: 0 }, {})).toBe(false);
  });
});

describe('eq / neq are strict', () => {
  it('does not coerce across types', () => {
    expect(ev({ field: 'amount', op: 'eq', value: 100 }, { amount: 100 })).toBe(true);
    expect(ev({ field: 'amount', op: 'eq', value: 100 }, { amount: '100' })).toBe(false);
    expect(ev({ field: 'amount', op: 'neq', value: 100 }, { amount: '100' })).toBe(true);
  });

  it('treats a missing fact as null', () => {
    expect(ev({ field: 'name', op: 'eq', value: null }, {})).toBe(true);
    expect(ev({ field: 'name', op: 'neq', value: null }, { name: 'x' })).toBe(true);
  });
});

describe('booleans travel as the strings true/false', () => {
  it('matches the encoded form', () => {
    // Documented encoding — a rule editor emits 'true', not true.
    expect(ev({ field: 'flag', op: 'eq', value: 'true' }, { flag: 'true' })).toBe(true);
    expect(ev({ field: 'flag', op: 'eq', value: 'false' }, { flag: 'true' })).toBe(false);
  });
});

describe('a set-valued fact tests OVERLAP', () => {
  /**
   * `categoryIds` is a set: `in` asks "does this report touch any of these
   * categories", not "is the whole set equal to". Getting this backwards makes a
   * category-scoped rule fire on reports it should ignore.
   */
  it('in is true when the sets intersect', () => {
    expect(
      ev({ field: 'categoryIds', op: 'in', value: ['a', 'z'] }, { categoryIds: ['a', 'b'] }),
    ).toBe(true);
    expect(ev({ field: 'categoryIds', op: 'in', value: ['z'] }, { categoryIds: ['a', 'b'] })).toBe(
      false,
    );
  });

  it('nin is the negation of overlap', () => {
    expect(ev({ field: 'categoryIds', op: 'nin', value: ['z'] }, { categoryIds: ['a'] })).toBe(
      true,
    );
    expect(ev({ field: 'categoryIds', op: 'nin', value: ['a'] }, { categoryIds: ['a'] })).toBe(
      false,
    );
  });

  it('accepts a scalar on the value side', () => {
    expect(ev({ field: 'categoryIds', op: 'in', value: 'a' }, { categoryIds: ['a'] })).toBe(true);
    expect(ev({ field: 'categoryIds', op: 'in', value: 7 }, { categoryIds: ['7'] })).toBe(true);
  });

  it('answers false for every op that is not in/nin', () => {
    // A set has no ordering, so a threshold against one is meaningless rather than
    // accidentally true.
    for (const op of ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] as const) {
      expect(ev({ field: 'categoryIds', op, value: 'a' }, { categoryIds: ['a'] })).toBe(false);
    }
  });

  it('an empty fact set overlaps nothing', () => {
    expect(ev({ field: 'categoryIds', op: 'in', value: ['a'] }, { categoryIds: [] })).toBe(false);
    expect(ev({ field: 'categoryIds', op: 'nin', value: ['a'] }, { categoryIds: [] })).toBe(true);
  });

  it('a null value on the in side selects nothing', () => {
    expect(ev({ field: 'categoryIds', op: 'in', value: null }, { categoryIds: ['a'] })).toBe(false);
  });
});

describe('scalar in / nin', () => {
  it('compares the fact as a string against the list', () => {
    expect(
      ev({ field: 'category', op: 'in', value: ['meals', 'travel'] }, { category: 'meals' }),
    ).toBe(true);
    expect(ev({ field: 'amount', op: 'in', value: ['100'] }, { amount: 100 })).toBe(true);
    expect(ev({ field: 'category', op: 'nin', value: ['meals'] }, { category: 'travel' })).toBe(
      true,
    );
  });

  it('never matches a missing fact, and nin therefore admits it', () => {
    expect(ev({ field: 'category', op: 'in', value: ['meals'] }, {})).toBe(false);
    expect(ev({ field: 'category', op: 'nin', value: ['meals'] }, {})).toBe(true);
  });

  it('in against a non-array value is false', () => {
    expect(ev({ field: 'category', op: 'in', value: 'meals' }, { category: 'meals' })).toBe(false);
  });
});

describe('composites', () => {
  const over100: Predicate<Field> = { field: 'amount', op: 'gt', value: 100 };
  const isMeals: Predicate<Field> = { field: 'category', op: 'eq', value: 'meals' };

  it('all requires every branch', () => {
    expect(ev({ all: [over100, isMeals] }, { amount: 150, category: 'meals' })).toBe(true);
    expect(ev({ all: [over100, isMeals] }, { amount: 150, category: 'travel' })).toBe(false);
  });

  it('any requires one', () => {
    expect(ev({ any: [over100, isMeals] }, { amount: 10, category: 'meals' })).toBe(true);
    expect(ev({ any: [over100, isMeals] }, { amount: 10, category: 'travel' })).toBe(false);
  });

  it('nests to any depth', () => {
    const pred: Predicate<Field> = { all: [{ any: [over100, isMeals] }, { all: [isMeals] }] };
    expect(ev(pred, { amount: 10, category: 'meals' })).toBe(true);
    expect(ev(pred, { amount: 500, category: 'travel' })).toBe(false);
  });

  it('empty all is true and empty any is false', () => {
    // JS reduce semantics, stated deliberately: an unconditional rule should be
    // written `{ always: true }`, and an empty `any` must not match everything.
    expect(ev({ all: [] }, {})).toBe(true);
    expect(ev({ any: [] }, {})).toBe(false);
  });

  it('always is unconditional', () => {
    expect(ev({ always: true }, {})).toBe(true);
  });
});

describe('makePredicateSchema', () => {
  const schema = makePredicateSchema(['amount', 'category']);

  it('accepts a leaf on a declared field', () => {
    expect(schema.safeParse({ field: 'amount', op: 'gt', value: 100 }).success).toBe(true);
  });

  it('rejects a field outside the consumer enum', () => {
    // The point of the factory: each engine constrains the fields its facts supply, so
    // a rule cannot reference something that will always evaluate to null.
    expect(schema.safeParse({ field: 'nope', op: 'gt', value: 1 }).success).toBe(false);
  });

  it('rejects an unknown operator', () => {
    expect(schema.safeParse({ field: 'amount', op: 'matches', value: 1 }).success).toBe(false);
  });

  it('accepts nested composites and always', () => {
    expect(
      schema.safeParse({
        all: [{ any: [{ field: 'amount', op: 'lte', value: 5 }] }, { always: true }],
      }).success,
    ).toBe(true);
  });

  it('rejects always: false', () => {
    expect(schema.safeParse({ always: false }).success).toBe(false);
  });

  it('accepts every value shape the evaluator handles', () => {
    for (const value of [1, 'x', ['a', 'b'], null]) {
      expect(schema.safeParse({ field: 'category', op: 'eq', value }).success).toBe(true);
    }
  });
});
