import { router } from '@/server/trpc';
import { appSettingsRouter } from './appSettings';
import { approvalWorkflowsRouter } from './approvalWorkflows';
import { businessUnitsRouter } from './businessUnits';
import { commentsRouter } from './comments';
import { departmentsRouter } from './departments';
import { expenseApprovalsRouter } from './expenseApprovals';
import { expenseCategoriesRouter } from './expenseCategories';
import { expensesRouter } from './expenses';
import { legalEntitiesRouter } from './legalEntities';
import { mileageRouteRouter } from './mileageRoute';
import { pickersRouter } from './pickers';
import { policiesRouter } from './policies';

/**
 * Root tRPC router — composes per-domain sub-routers. Add a new module's
 * router here when it lands.
 *
 * VeloExpense: ExpenseOS's root composes 33 routers. Each arrives here with the wave that
 * ports it (see the parity doc), starting with `expenseCategories` in Wave 0. The list is
 * kept in ExpenseOS's order so the two files stay comparable.
 */
export const appRouter = router({
  appSettings: appSettingsRouter,
  // w4-01: ExpenseOS's workflow builder (d55: lands before the cutover).
  approvalWorkflows: approvalWorkflowsRouter,
  businessUnits: businessUnitsRouter,
  // w2-02a: the discussion on a report (d37).
  comments: commentsRouter,
  departments: departmentsRouter,
  expenseCategories: expenseCategoriesRouter,
  // Wave 2: ExpenseOS's expenses router, in slices (w2-07 onwards).
  expenses: expensesRouter,
  // VeloExpense stand-in until Wave 4: `myTasks` only, for the sidebar's Approvals count.
  expenseApprovals: expenseApprovalsRouter,
  legalEntities: legalEntitiesRouter,
  // w2-10: address search and route distance for a mileage line.
  mileageRoute: mileageRouteRouter,
  pickers: pickersRouter,
  policies: policiesRouter,
});

/** Exported type used by the client to derive typed hooks. */
export type AppRouter = typeof appRouter;
