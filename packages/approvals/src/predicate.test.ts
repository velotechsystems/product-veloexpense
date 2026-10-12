import { describe, expect, it } from 'vitest';
import { evaluatePredicate, type SubjectFacts } from './predicate';

describe('evaluatePredicate — scalar facts', () => {
  const facts: SubjectFacts = { amount: 5000, departmentId: 'd1' };

  it('numeric comparisons', () => {
    expect(evaluatePredicate({ field: 'amount', op: 'gte', value: 5000 }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'amount', op: 'gt', value: 5000 }, facts)).toBe(false);
    expect(evaluatePredicate({ field: 'amount', op: 'lt', value: 6000 }, facts)).toBe(true);
  });

  it('equality + membership', () => {
    expect(evaluatePredicate({ field: 'departmentId', op: 'eq', value: 'd1' }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'departmentId', op: 'in', value: ['d1', 'd2'] }, facts)).toBe(
      true,
    );
    expect(evaluatePredicate({ field: 'departmentId', op: 'nin', value: ['d2'] }, facts)).toBe(
      true,
    );
  });

  it('missing fact is null (fails membership, passes nin)', () => {
    expect(evaluatePredicate({ field: 'jobLevelId', op: 'in', value: ['j1'] }, facts)).toBe(false);
    expect(evaluatePredicate({ field: 'jobLevelId', op: 'nin', value: ['j1'] }, facts)).toBe(true);
  });
});

describe('evaluatePredicate — set-valued facts (categoryIds)', () => {
  const facts: SubjectFacts = { categoryIds: ['meals', 'travel'] };

  it('in = the report set overlaps the selected values', () => {
    expect(evaluatePredicate({ field: 'categoryIds', op: 'in', value: ['travel'] }, facts)).toBe(
      true,
    );
    expect(
      evaluatePredicate({ field: 'categoryIds', op: 'in', value: ['lodging', 'meals'] }, facts),
    ).toBe(true);
    expect(evaluatePredicate({ field: 'categoryIds', op: 'in', value: ['lodging'] }, facts)).toBe(
      false,
    );
  });

  it('nin = no overlap', () => {
    expect(evaluatePredicate({ field: 'categoryIds', op: 'nin', value: ['lodging'] }, facts)).toBe(
      true,
    );
    expect(evaluatePredicate({ field: 'categoryIds', op: 'nin', value: ['meals'] }, facts)).toBe(
      false,
    );
  });

  it('an empty report set never overlaps', () => {
    const empty: SubjectFacts = { categoryIds: [] };
    expect(evaluatePredicate({ field: 'categoryIds', op: 'in', value: ['meals'] }, empty)).toBe(
      false,
    );
    expect(evaluatePredicate({ field: 'categoryIds', op: 'nin', value: ['meals'] }, empty)).toBe(
      true,
    );
  });
});

describe('evaluatePredicate — boolean facts as strings', () => {
  const facts: SubjectFacts = { requiresApproval: 'true', hasPolicyViolation: 'false' };
  it('eq true/false', () => {
    expect(evaluatePredicate({ field: 'requiresApproval', op: 'eq', value: 'true' }, facts)).toBe(
      true,
    );
    expect(evaluatePredicate({ field: 'hasPolicyViolation', op: 'eq', value: 'true' }, facts)).toBe(
      false,
    );
  });
});

describe('evaluatePredicate — composites', () => {
  const facts: SubjectFacts = { amount: 8000, categoryIds: ['travel'] };
  it('all / any', () => {
    expect(
      evaluatePredicate(
        {
          all: [
            { field: 'amount', op: 'gte', value: 5000 },
            { field: 'categoryIds', op: 'in', value: ['travel'] },
          ],
        },
        facts,
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        {
          any: [
            { field: 'amount', op: 'gte', value: 100000 },
            { field: 'categoryIds', op: 'in', value: ['travel'] },
          ],
        },
        facts,
      ),
    ).toBe(true);
  });
});
