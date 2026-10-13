/**
 * VeloExpense's own rule kinds, alongside ExpenseOS's registry (w4-02d, d70).
 *
 * Not a port: ExpenseOS has no kind for these. Each one carries a rule VeloExpense's own
 * engine (lib/policy, deleted at this cutover) enforced, which the tenants who had it
 * configured keep — the cutover converts their rows into instances of these kinds.
 */
import { z } from 'zod';
import type { RuleKind } from './kinds';

/**
 * A line on a category an admin has since deactivated (BLOCK by default).
 *
 * ExpenseOS's pickers only offer active categories, so it never needed this — but a line
 * entered BEFORE the category was retired keeps it, and would otherwise submit and post
 * under a category the organization stopped using. VeloExpense's v1 `CATEGORY_ACTIVE`
 * refused that; the claimant recodes the line. Mileage lines are not exempt: a retired
 * mileage category is as retired as any other.
 */
export const categoryActiveKind: RuleKind = {
  code: 'CATEGORY_ACTIVE',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: z.object({}).strict(),
  defaultSeverity: 'BLOCK',
  messageKey: 'categoryInactive',
  evaluateAggregate: (_inst, ctx) =>
    ctx.report.lineItems
      .filter((item) => item.category.active === false)
      .map((item) => ({
        lineItemId: item.id,
        data: { categoryId: item.category.id, categoryCode: item.category.code },
      })),
};

export const VELOEXPENSE_KINDS: readonly RuleKind[] = [categoryActiveKind];
