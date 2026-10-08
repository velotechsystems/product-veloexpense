import { permissions as P, type RbacUser } from '@expenseos/rbac';
import { cache } from 'react';
// VeloExpense: ExpenseOS's `db` is `@/lib/db/prisma`'s, which resolves against the caller's
// tenant transaction — so this runs inside `withTenantDb`, and RLS keeps the count to the
// reader's organization.
import { db } from '@/lib/db/prisma';

/**
 * Whether this reader may see OTHER people — the gate on the HOME `people` nav item
 * (`/users`), and the one nav gate that is a computed fact rather than a static permission.
 *
 * It is `P.user.readAll` (an admin) OR "manages at least one non-deleted user" (an ordinary
 * employee who happens to have reports). Only the second half costs a query, and only for
 * readers who fail the first.
 *
 * ─── WHY THIS IS A MODULE AND NOT TWO LINES IN A LAYOUT ──────────────────────────────────
 *
 * It was two lines in `(app)/layout.tsx` and had exactly one reader. `/dashboard`'s
 * small-screen notice is the second: that notice is conditional on the reader actually having
 * phone-hidden destinations, derived from the same `SECTIONS` ∩ RBAC ∩ module ∩ registry
 * pipeline the sidebar uses — and `/users` is `desktop`-ruled while carrying NO `requires`, so
 * for any reader without an admin, audit, config or NetSuite permission this predicate is the
 * single fact that decides whether the notice renders at all. Copying the derivation would put
 * two answers to that question in the tree at once; passing `false` instead would silently
 * under-render the notice for every manager whose only hidden destination is `/users`, while
 * their sidebar — which has the real value — showed them the disclosure control and the
 * footnote saying something WAS hidden. Two surfaces of one feature, disagreeing.
 *
 * ─── WHY `cache()` ───────────────────────────────────────────────────────────────────────
 *
 * React's request-scoped memo (the same primitive `lib/trpc/server.ts:18` already uses for the
 * tRPC context). The layout and the page render in ONE request, so without it a cold load of
 * `/dashboard` — the post-login landing path, whose page file is pointed about what it is
 * allowed to query — would run this indexed count TWICE. With it the count is run at most once
 * per request, which is exactly what `/dashboard` cost before this notice existed.
 *
 * THE ARGUMENTS ARE PRIMITIVES ON PURPOSE. `cache` memoizes on argument IDENTITY, and the
 * layout and the page each resolve their own `RbacUser` object, so a `(rbac: RbacUser)`
 * signature would miss on every call and quietly buy nothing. A string and a boolean hit.
 *
 * Outside a request — a unit test — `react`'s client build exports `cache` as a plain
 * passthrough, so this is just the function.
 */
export const resolveCanSeeOthers = cache(
  async (userId: string, hasUserReadAll: boolean): Promise<boolean> => {
    if (hasUserReadAll) return true;
    const reportCount = await db.user.count({ where: { managerId: userId, deletedAt: null } });
    return reportCount > 0;
  },
);

/** `resolveCanSeeOthers` for a caller that holds the resolved `RbacUser` and nothing else. */
export function canSeeOthersFor(rbac: RbacUser): Promise<boolean> {
  return resolveCanSeeOthers(rbac.id, rbac.permissions.includes(P.user.readAll));
}
