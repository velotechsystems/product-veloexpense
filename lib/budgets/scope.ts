/**
 * VX4-5 part 2 — budget SCOPE resolution and the snapshot the policy rule reads.
 *
 * PURE. No `pg` import, by the same house rule that governs `lib/policy/rules.ts`
 * and `lib/policy/rates.ts`: `evaluate(context, policy)` is synchronous and gets
 * no transaction, so anything a rule needs has to arrive ON the context. The
 * database half lives in `lib/budgets/service.ts`.
 *
 * ── resolveBudget, ported rather than reinvented ────────────────────────────
 *
 * ExpenseOS's `resolveBudget` (`packages/approvals/src/budgets.ts:117-146` at
 * 5a11a647) is one of the parts of their budget module that is simply right, and
 * its reasoning is worth keeping verbatim: attribution is MOST-SPECIFIC-FIRST and
 * deliberately NOT a sum of all matches. An amount counted against both a
 * department budget and the company-wide budget for the same account is
 * double-counted, and the company total then drifts by however many department
 * budgets happen to exist — a drift nobody can see, because both numbers look
 * plausible on their own.
 *
 * Their tie-break is kept too: (account, businessUnit, null) beats
 * (account, null, department), because business unit is the coarser and more
 * reliably populated dimension, so preferring it keeps attribution stable.
 *
 * `0024`'s own comment already committed us to the semantics this encodes — NULL
 * in a budget's narrowing columns means "the whole organization" and not
 * "unknown" — which is why that migration needed `NULLS NOT DISTINCT`.
 */

/** A budget's scope, as much of it as attribution needs. */
export interface BudgetScope {
  id: string;
  glAccountId: string;
  businessUnitId: string | null;
  departmentId: string | null;
  currencyCode: string;
}

/**
 * The budget a piece of spend belongs to, most-specific-first:
 * (gl, bu, dept) → (gl, bu, null) → (gl, null, dept) → (gl, null, null).
 *
 * Returns null when no budget claims the account at all, which is the normal
 * case: most spend is on accounts nobody has budgeted.
 */
export function resolveBudget(
  scopes: readonly BudgetScope[],
  glAccountId: string | null,
  businessUnitId: string | null,
  departmentId: string | null,
): BudgetScope | null {
  if (!glAccountId) return null;
  const forAccount = scopes.filter((s) => s.glAccountId === glAccountId);
  if (forAccount.length === 0) return null;
  const pick = (bu: string | null, dept: string | null) =>
    forAccount.find((s) => s.businessUnitId === bu && s.departmentId === dept) ?? null;
  return (
    (businessUnitId && departmentId ? pick(businessUnitId, departmentId) : null) ??
    (businessUnitId ? pick(businessUnitId, null) : null) ??
    (departmentId ? pick(null, departmentId) : null) ??
    pick(null, null)
  );
}

/**
 * One budget period this report's spend lands in, as the rule sees it.
 *
 * Every amount is already IN `currencyCode` — the loader converts, the rule does
 * arithmetic. That split is not tidiness: conversion needs the rate rows bounded
 * by each expense's own date (see `lib/budgets/service.ts`), and a pure
 * synchronous rule cannot fetch them.
 *
 * There is deliberately NO `rolledUpAt` here. `budget_period.rolled_up_at IS
 * NULL` means "never calculated", which is not the same as zero spend — so the
 * loader RECOMPUTES any never-calculated period before building these, and a
 * snapshot therefore always rests on a real baseline. A rule branch for
 * "not yet calculated" would be a branch that can never be taken, which is this
 * project's most expensive recurring defect shape.
 */
export interface BudgetSnapshot {
  budgetId: string;
  budgetName: string;
  periodId: string;
  /** ISO dates, inclusive at both ends, as `budget_period` stores them. */
  startsOn: string;
  endsOn: string;
  currencyCode: string;
  minorUnit: number;
  /** The period's budget. */
  amountMinor: bigint;
  /** APPROVED and beyond, from the stored rollup. */
  actualMinor: bigint;
  /** SUBMITTED but not yet decided, from the stored rollup. */
  pendingMinor: bigint;
  /**
   * Stored spend that could not be converted into this budget's currency, so it
   * is counted NOWHERE else. AN-7 inverted: their analytics sums an unconverted
   * amount as if it were already in base currency, which turns "I cannot answer"
   * into "you are fine".
   */
  unconvertibleMinor: bigint;
  /** THIS report's contribution, converted. Not yet in the stored rollup. */
  reportMinor: bigint;
  /**
   * Currency codes in THIS report whose spend on this budget could not be
   * converted. Empty is the normal case; non-empty is a diagnostic an admin can
   * act on, which is why the codes and not just a flag.
   */
  reportMissingRateFrom: string[];
}

/** What the period will stand at if this report is approved as filed. */
export function projectedMinor(s: BudgetSnapshot): bigint {
  return s.actualMinor + s.pendingMinor + s.reportMinor;
}

/**
 * True when some spend bearing on this period could not be converted, so the
 * projection above is a FLOOR rather than an answer.
 */
export function hasUnconvertible(s: BudgetSnapshot): boolean {
  return s.unconvertibleMinor > 0n || s.reportMissingRateFrom.length > 0;
}
