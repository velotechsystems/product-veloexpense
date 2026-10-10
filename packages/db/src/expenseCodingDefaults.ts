/**
 * The coding a new expense starts with: whatever the person filing it is coded as.
 *
 * ## Why this exists
 *
 * `allocationSet` was the only thing that ever created an `ExpenseAllocation`, and it runs
 * only when somebody opens the allocation editor. So every expense began life uncoded, and
 * NetSuite requires a department and a class on every line. Reports reached APPROVED
 * uncoded and were refused weeks later at the posting gate — three are still stuck on dev
 * (EXP-004982, EXP-004961, EXP-004962), unfixable by retry because the coding was never
 * captured.
 *
 * A person already carries the three dimensions an allocation needs: `businessUnitId`,
 * `departmentId` and `nsClassId`. Asking them to retype their own department onto every
 * expense was never the intent — it was an omission.
 *
 * ## Copied, not looked up
 *
 * The values are written onto the expense at creation and never re-read. A claim is coded
 * where the cost was actually incurred, so somebody who transfers department in March must
 * not have February's filed expenses silently re-coded to their new one. The same reason
 * `Audit.actorName` is a snapshot column rather than a join.
 *
 * ## It defaults; it does not decide
 *
 * `allocationSet` replaces allocations wholesale, so anything the submitter sets — a
 * different department, a 60/40 split across two — simply wins. This only fills the blank.
 *
 * VeloExpense: ExpenseOS's module, in its `EXPENSEOS` business unit position (the one it
 * takes where NetSuite is not configured), which is the only position VeloExpense has. A
 * VeloExpense person and allocation carry TWO dimensions — business unit and department —
 * so the class dimension, ExpenseOS's "No Class" record and its new-person default
 * (`noClassIdFor`, `newUserClassDefault`) and the NetSuite business unit are not ported;
 * `expense_allocation` has no column for either (migration 0054). The rule is otherwise
 * ExpenseOS's: one whole-expense row, written in the same statement as the expense, and
 * nothing at all for a filer who carries no coding.
 */

import type { BusinessUnitSource } from './businessUnitSource';

/**
 * The dimensions a person carries, as `User` stores them.
 *
 * VeloExpense: business unit and department (ExpenseOS: plus `nsClassId` and, under its
 * NetSuite source, `nsBusinessUnitId`).
 */
export interface CodingDefaults {
  businessUnitId: string | null;
  departmentId: string | null;
}

/**
 * What an allocation row needs. `percentBp` is basis points; 10000 is the whole expense.
 */
export interface DefaultAllocation {
  percentBp: number;
  businessUnitId: string | null;
  departmentId: string | null;
}

/**
 * The single 100% allocation a new expense should carry, or null when the person has no
 * coding to give.
 *
 * Pure, and separate from the write, because "what should a blank expense be coded as" is
 * the part worth pinning in a test — the creation paths that call it are plumbing.
 *
 * `source` is required so every creation path is found by the compiler when the rule
 * changes.
 */
export function defaultAllocationFrom(
  user: CodingDefaults | null,
  _source: BusinessUnitSource,
): DefaultAllocation | null {
  if (!user) return null;
  const { businessUnitId, departmentId } = user;
  if (!businessUnitId && !departmentId) return null;
  return {
    percentBp: 10_000,
    businessUnitId: businessUnitId ?? null,
    departmentId: departmentId ?? null,
  };
}

/**
 * Shaped for Prisma's nested create, so the allocation lands in the SAME statement as the
 * expense.
 *
 * Atomicity is the point: an expense that exists without its default allocation is exactly
 * the uncoded row this module was written to stop producing, and a second `create` after
 * the first could fail on its own.
 */
export function allocationCreateFor(
  user: CodingDefaults | null,
  source: BusinessUnitSource,
): { allocations: { create: DefaultAllocation } } | Record<string, never> {
  const alloc = defaultAllocationFrom(user, source);
  return alloc ? { allocations: { create: alloc } } : {};
}
