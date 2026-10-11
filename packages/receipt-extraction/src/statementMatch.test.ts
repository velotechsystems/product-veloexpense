import { describe, expect, it } from 'vitest';
import {
  type MatchableExpense,
  matchStatementToExpenses,
  statementCharges,
} from './statementMatch';

/**
 * Recommending which expenses a statement evidences.
 *
 * The two things that would quietly go wrong: offering a REFUND as evidence for a
 * same-sized expense, and letting one statement line be evidence for two claims.
 */

const line = (description: string, amount: number | null) => ({ description, amount });

function expense(over: Partial<MatchableExpense> = {}): MatchableExpense {
  return {
    expenseId: 'e-1',
    merchant: 'Joe’s Pizza',
    total: 130,
    currencyCode: 'CAD',
    ...over,
  };
}

describe('statementCharges', () => {
  it('keeps charges and drops credits', () => {
    // A refund of 42 is the opposite of a 42 expense, not evidence for it.
    const out = statementCharges([line('DINNER', 130), line('REFUND', -42), line('FEE REV', 0)]);
    expect(out.map((l) => l.description)).toEqual(['DINNER']);
  });

  it('drops lines with no amount', () => {
    expect(statementCharges([line('BALANCE FORWARD', null)])).toEqual([]);
  });
});

describe('matchStatementToExpenses', () => {
  it('matches on the amount', () => {
    const out = matchStatementToExpenses([line('SQ *SOMETHING 4471', 130)], [expense()]);
    expect(out).toEqual([{ expenseId: 'e-1', line: 'SQ *SOMETHING 4471', strength: 'amount' }]);
  });

  it('prefers a line that also agrees on the merchant', () => {
    // Three taxis at the same price on one trip is the case this exists for.
    const out = matchStatementToExpenses(
      [line('UBER TRIP HELP.UBER.COM', 24.5), line('SQ *JOES PIZZA 4471 MONTREAL QC', 24.5)],
      [expense({ expenseId: 'e-pizza', merchant: 'Joe’s Pizza', total: 24.5 })],
    );
    expect(out[0]).toMatchObject({
      expenseId: 'e-pizza',
      strength: 'amount+merchant',
      line: 'SQ *JOES PIZZA 4471 MONTREAL QC',
    });
  });

  it('spends each statement line at most once', () => {
    // One settlement cannot be evidence for two claims.
    const out = matchStatementToExpenses(
      [line('DINNER', 130)],
      [expense({ expenseId: 'e-a' }), expense({ expenseId: 'e-b' })],
    );
    expect(out).toHaveLength(1);
  });

  it('matches two identical expenses when the statement shows two identical charges', () => {
    const out = matchStatementToExpenses(
      [line('KIOSK', 4.5), line('KIOSK', 4.5)],
      [
        expense({ expenseId: 'e-a', merchant: 'Kiosk', total: 4.5 }),
        expense({ expenseId: 'e-b', merchant: 'Kiosk', total: 4.5 }),
      ],
    );
    expect(out.map((m) => m.expenseId).sort()).toEqual(['e-a', 'e-b']);
  });

  it('does not match a merchant whose words only partly appear', () => {
    // "Joe's Pizza" must not match a line for "Joe's Garage".
    const out = matchStatementToExpenses(
      [line('JOES GARAGE 4471', 130)],
      [expense({ merchant: 'Joe’s Pizza' })],
    );
    // Still an amount match — the merchant test only upgrades the strength.
    expect(out[0].strength).toBe('amount');
  });

  it('ignores short tokens, which would otherwise match everything', () => {
    const out = matchStatementToExpenses([line('QC MONTREAL', 130)], [expense({ merchant: 'QC' })]);
    expect(out[0].strength).toBe('amount');
  });

  it('recommends nothing when no amount lines up', () => {
    expect(matchStatementToExpenses([line('DINNER', 99)], [expense({ total: 130 })])).toEqual([]);
  });

  it('skips an expense with no total yet', () => {
    expect(matchStatementToExpenses([line('DINNER', 130)], [expense({ total: 0 })])).toEqual([]);
  });

  it('compares in cents, so float noise is not a mismatch', () => {
    const out = matchStatementToExpenses([line('DINNER', 130.0)], [expense({ total: 129.999999 })]);
    expect(out).toHaveLength(1);
  });
});
