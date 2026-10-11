/**
 * Which expenses does a bank statement evidence?
 *
 * A statement is not a receipt. A receipt is evidence of ONE charge; a statement page
 * is evidence of several, and it is the only document that proves what was actually
 * SETTLED — including the rate, when the charge was made in another currency. So it
 * belongs on every expense it covers rather than on whichever one it happened to be
 * uploaded against.
 *
 * This is the recommendation half: line up the statement's own lines against the
 * report's expenses so the person choosing gets sensible boxes already ticked. It
 * recommends, it never decides — a statement can list charges from the same trip that
 * belong to somebody else's report, or to no report at all.
 *
 * Pure: no DB, no clock, no model call.
 */

/** One line off the statement, as extraction returns them. */
export interface StatementLine {
  description: string;
  /** Major units. A charge, not a credit — see `statementCharges`. */
  amount: number | null;
}

/** One expense on the report, as far as matching cares. */
export interface MatchableExpense {
  expenseId: string;
  merchant: string | null;
  /** Major units, in the expense's own currency. */
  total: number | null;
  currencyCode: string | null;
}

export interface StatementMatch {
  expenseId: string;
  /** The statement line that matched, for showing WHY it was recommended. */
  line: string;
  /** Matched on the amount alone, or on the amount and the merchant. */
  strength: 'amount' | 'amount+merchant';
}

/** Cents, so a float comparison never invents a mismatch. */
function cents(v: number): number {
  return Math.round(v * 100);
}

/**
 * Statement lines that are CHARGES.
 *
 * A statement carries payments and credits too, and a refund of $42 must not be
 * offered as evidence for a $42 expense — it is the opposite of one. Negative amounts
 * are dropped, and so are zero lines (fee reversals, balance markers).
 */
export function statementCharges(lines: readonly StatementLine[]): StatementLine[] {
  return lines.filter((l) => l.amount != null && l.amount > 0);
}

/**
 * Normalised words from a description, for the merchant check.
 *
 * Statement descriptions are terse and noisy — `SQ *JOES PIZZA 4471 MONTREAL QC` — so
 * the test is whether the expense's merchant words appear in the line, not whether the
 * two strings resemble each other. Short tokens are dropped: matching on "the" or a
 * two-letter province code would make everything match everything.
 */
function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Apostrophes CLOSE UP rather than splitting: a bank prints "JOES PIZZA" where
      // the merchant is "Joe's Pizza", and splitting gives "joe" + "s", which matches
      // neither. Both the typographic and the ASCII form, since receipts use either.
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      // Short tokens dropped: matching on "the", or on a two-letter province code,
      // would make everything match everything.
      .filter((w) => w.length >= 3)
  );
}

function merchantAppears(merchant: string | null, description: string): boolean {
  if (!merchant) return false;
  const want = words(merchant);
  if (want.length === 0) return false;
  const have = new Set(words(description));
  // Every word, not any: "Joe's Pizza" should not match a line for "Joe's Garage".
  return want.every((w) => have.has(w));
}

/**
 * Recommend the expenses this statement evidences.
 *
 * Matched on the AMOUNT first, because that is the thing a statement and an expense
 * are guaranteed to share — the description is the bank's, not the merchant's, and the
 * dates differ by however long settlement took. The merchant is then a tie-breaker,
 * which matters on a trip where three taxis cost the same.
 *
 * Each statement line is spent at most once. Two identical charges on the statement can
 * evidence two identical expenses, but ONE line cannot be evidence for both — that
 * would recommend attaching a single settlement to two claims.
 */
export function matchStatementToExpenses(
  lines: readonly StatementLine[],
  expenses: readonly MatchableExpense[],
): StatementMatch[] {
  const charges = statementCharges(lines);
  const used = new Set<number>();
  const out: StatementMatch[] = [];

  // Two passes, so a line that agrees on the merchant is claimed before a line that
  // only agrees on the amount. Otherwise the first expense in the list takes the line
  // and the better match is left with nothing.
  for (const wantMerchant of [true, false]) {
    for (const expense of expenses) {
      if (out.some((m) => m.expenseId === expense.expenseId)) continue;
      if (expense.total == null || expense.total <= 0) continue;
      const target = cents(expense.total);
      const index = charges.findIndex((l, i) => {
        if (used.has(i)) return false;
        if (l.amount == null || cents(l.amount) !== target) return false;
        return wantMerchant ? merchantAppears(expense.merchant, l.description) : true;
      });
      if (index === -1) continue;
      used.add(index);
      out.push({
        expenseId: expense.expenseId,
        line: charges[index].description,
        strength: wantMerchant ? 'amount+merchant' : 'amount',
      });
    }
  }
  return out;
}
