import { protectedProcedure, router } from '@/server/trpc';
import { listInbox } from '@/lib/approvals/inbox';
import { withOrg } from '@/lib/tenant/context';

/**
 * NOT ExpenseOS's router — a VeloExpense stand-in for one procedure, until Wave 4 ports the
 * real one.
 *
 * ExpenseOS's sidebar (ported verbatim, `app/(app)/Sidebar.tsx`) puts a count on Approvals from
 * `expenseApprovals.myTasks`. ExpenseOS's router answers from its graph approval engine, which
 * VeloExpense gets in Wave 4. Until then the same question — what is waiting for me to decide —
 * is answered by VeloExpense's own approvals inbox (`lib/approvals/inbox.ts`), the source its
 * previous sidebar used. The shape is ExpenseOS's (`{ items }`); the sidebar reads only the
 * count.
 *
 * Read on its own tenant connection, scoped to the caller's organization: `listInbox` is
 * written against VeloExpense's `pg` path, not Prisma.
 */
export const expenseApprovalsRouter = router({
  myTasks: protectedProcedure.query(async ({ ctx }) => {
    const items = await withOrg(ctx.session.user.organizationId, (tx) =>
      listInbox(tx, ctx.session.user.id, { limit: 100 }),
    );
    return { items };
  }),
});
