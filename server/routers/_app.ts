import { router } from '@/server/trpc';
import { expenseApprovalsRouter } from './expenseApprovals';

/**
 * Root tRPC router — composes per-domain sub-routers. Add a new module's
 * router here when it lands.
 *
 * VeloExpense: ExpenseOS's root composes 33 routers. Each arrives here with the wave that
 * ports it (see the parity doc), starting with `expenseCategories` in Wave 0. The list is
 * kept in ExpenseOS's order so the two files stay comparable.
 */
export const appRouter = router({
  // VeloExpense stand-in until Wave 4: `myTasks` only, for the sidebar's Approvals count.
  expenseApprovals: expenseApprovalsRouter,
});

/** Exported type used by the client to derive typed hooks. */
export type AppRouter = typeof appRouter;
