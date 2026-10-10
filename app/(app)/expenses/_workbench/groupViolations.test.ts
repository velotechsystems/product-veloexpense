import { describe, expect, it } from 'vitest';
import { groupViolations } from './parts';

/**
 * One line per KIND of violation.
 *
 * Three line items over the same per-transaction limit produced three identical
 * sentences in the expense's warning box, which reads as three problems instead of one.
 *
 * The grouping key is (severity, message) because `message` is the label key — exactly
 * what the reader sees — so no two rendered lines can be duplicates. Grouping on
 * `ruleCode` would NOT do it: that holds the firing rule INSTANCE's id, so two limits of
 * the same kind (say one for meals and one for travel) stay separate and still render
 * the same sentence twice.
 */

/**
 * The row shape plus the fields grouping must IGNORE.
 *
 * `groupViolations` is generic over the shared `ViolationView` now, so its parameter type
 * no longer carries `lineItemId` / `ruleCode` on its own — and those two are exactly what
 * these cases exist to prove are not part of the key. Named here rather than dropped.
 */
type V = Parameters<typeof groupViolations>[0][number] & {
  lineItemId?: string | null;
  ruleCode?: string;
};

const v = (over: Partial<V>): V =>
  ({
    id: Math.random().toString(36).slice(2),
    ruleCode: 'rule-instance-1',
    severity: 'WARNING',
    message: 'perTransactionLimit',
    expenseId: 'exp-1',
    lineItemId: null,
    data: null,
    resolvedAt: null,
    resolveNote: null,
    createdAt: new Date().toISOString(),
    ...over,
  }) as V;

describe('groupViolations', () => {
  it('collapses repeats of one kind into a single line, and counts them', () => {
    const out = groupViolations([
      v({ lineItemId: 'a' }),
      v({ lineItemId: 'b' }),
      v({ lineItemId: 'c' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].violation.message).toBe('perTransactionLimit');
  });

  it('keeps different kinds apart', () => {
    const out = groupViolations([
      v({ message: 'perTransactionLimit' }),
      v({ message: 'receiptMissing' }),
      v({ message: 'perTransactionLimit' }),
    ]);
    expect(out.map((g) => [g.violation.message, g.count])).toEqual([
      ['perTransactionLimit', 2],
      ['receiptMissing', 1],
    ]);
  });

  it('keeps the same message apart when the severity differs', () => {
    // A BLOCK and a WARNING are not one issue: one stops submission, the other asks for
    // an explanation. Collapsing them would hide the blocking one behind a count.
    const out = groupViolations([
      v({ severity: 'BLOCK', message: 'receiptMissing' }),
      v({ severity: 'WARNING', message: 'receiptMissing' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((g) => g.violation.severity)).toEqual(['BLOCK', 'WARNING']);
  });

  it('groups two DIFFERENT rule instances of the same kind — the point of the key', () => {
    // Two per-transaction limits (one per category) firing on one expense render the
    // same sentence. Keying on ruleCode would leave both on screen.
    const out = groupViolations([
      v({ ruleCode: 'instance-meals', message: 'perTransactionLimit' }),
      v({ ruleCode: 'instance-travel', message: 'perTransactionLimit' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
  });

  it('preserves first-seen order, so the list does not reshuffle as counts change', () => {
    const out = groupViolations([
      v({ message: 'receiptMissing' }),
      v({ message: 'perTransactionLimit' }),
      v({ message: 'receiptMissing' }),
    ]);
    expect(out.map((g) => g.violation.message)).toEqual(['receiptMissing', 'perTransactionLimit']);
  });

  it('returns nothing for nothing', () => {
    expect(groupViolations([])).toEqual([]);
  });
});
