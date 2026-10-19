/**
 * Every subject the approval engine can route — one list, for the server and the UI.
 *
 * It lives here rather than in the router because there used to be TWO copies of it:
 * `SUBJECT_TYPES` in `server/routers/approvalWorkflows.ts` and `SUBJECT_TYPE_OPTIONS`
 * in `ApprovalWorkflowsAdmin.tsx`, the latter carrying the comment "(mirrors the
 * router's SUBJECT_TYPES)". Both had fallen two members behind
 * `ApprovalSubjectType` in `schema.prisma`, and the consequence cost the GA v2 audit a
 * P1:
 *
 *   · **Simulate did nothing on a travel workflow.** The dialog sends the workflow's
 *     own subject; the router's zod enum did not list `TRAVEL_REQUEST`, so the query
 *     failed validation and nothing rendered. Clicking Run and seeing no output reads
 *     exactly like a graph that cannot run — which is how it was reported.
 *   · **No admin could author one.** `create` is gated on the same enum, and the New
 *     workflow picker offered the same two options. For a product whose differentiator
 *     is customer-authored approval routing, two of four subjects were unroutable.
 *
 * A literal rather than something derived from Prisma at runtime: `@expenseos/db`
 * re-exports enums as TYPES only, so there is no runtime object to read. Parity with
 * the model is asserted against `schema.prisma` itself in
 * `server/routers/approvalWorkflows.subjects.test.ts`, so a fifth subject added to the
 * model fails a test here instead of shipping half-wired.
 *
 * Every member has a `workflows.subject.<VALUE>` label in both catalogues.
 */
/*
 * VeloExpense (w4-01, w6-02): the subjects VeloExpense's engine routes — ExpenseOS's list
 * minus the two virtual-card subjects, which are out of scope (d50). TRAVEL_REQUEST joined
 * with the travel screens (w6-02), when the module became available: before that an admin
 * could have authored a travel workflow nothing ever ran, the very half-wiring this list
 * exists to prevent. The parity test is VeloExpense's (approvalWorkflows.subjects.test.ts).
 */
export const APPROVAL_SUBJECT_TYPES = ['EXPENSE_REPORT', 'TRAVEL_REQUEST'] as const;

export type ApprovalSubjectTypeValue = (typeof APPROVAL_SUBJECT_TYPES)[number];
