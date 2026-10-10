/**
 * ExpenseOS's expense-report approver surface (`apps/web/src/server/routers/
 * expenseApprovals.ts` at 550b2945), ported in slices — as the expenses router is.
 *
 *   · w2-06 — AP's cross-report expense view and its receipt chase: `expenses` and
 *     `chaseReceipts`, in ExpenseOS's words;
 *   · w2-02a — the approver's actions the workbench calls: `decide`, `reassign`,
 *     `returnForEdit` and `setFxOverride` (d36). The transitions go to VeloExpense's
 *     approval engine through `server/lib/reportLifecycle.ts`, as submit and recall do
 *     (d23); `decideBulk` (the inbox) and `markReimbursed` arrive with the inbox in Wave 4.
 *
 * `myTasks` is NOT ExpenseOS's procedure yet: a VeloExpense stand-in until Wave 4 ports
 * ExpenseOS's graph approval engine, and with it the inbox, the approver-visible report and the
 * decide / return / reimburse actions this file holds in ExpenseOS.
 *
 * VeloExpense adaptations are marked `VeloExpense:` where they are made. The shared ones, as in
 * the expenses router:
 *   · a currency is keyed by its ISO code, and its symbol comes from the platform
 *     (`currencySymbol`);
 *   · VeloExpense has one display name, so a submitter's is carried in `firstName`;
 *   · only a STORED receipt is a receipt (w2-09): a PENDING row is an upload that never
 *     arrived;
 *   · may-this-caller-decide is asked of VeloExpense's own approvals until Wave 4
 *     (`callerCanDecideReport`), and the activity is recorded through VeloExpense's
 *     notification service on the procedure's own transaction (`queryRunnerOf`).
 */
import { auditActions, withAudit } from '@expenseos/audit';
import {
  ExpenseReportStatus,
  recomputeReportTotal,
  resolveExpenseFx,
  snapshotExpensesFx,
} from '@expenseos/db';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { listInbox } from '@/lib/approvals/inbox';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { notifyRecipients, recordActivity, reportPayload } from '@/lib/notifications/service';
import { withOrg } from '@/lib/tenant/context';
import { currencySymbol } from '@/server/lib/currencySymbol';
import { callerCanDecideReport, resolveDecidableTask } from '@/server/lib/reportApproval';
import { decideThroughEngine, reassignThroughEngine } from '@/server/lib/reportLifecycle';
import { REFUSAL_KEYS, refusal } from '@/server/refusal';
import { protectedProcedure, router, withPermission } from '@/server/trpc';

/** VeloExpense: a receipt that is in storage (w2-09). */
const STORED = { status: 'STORED' } as const;

/** Upper bound on a hand-entered FX rate — an obvious typo guard, not a market limit. */
const MAX_FX_RATE = 1_000_000;
/** How far an override may sit from the daily rate before it is refused as a typo. */
const FX_OVERRIDE_BAND = 2;

type Ctx = {
  rbac: { id: string; roleLabel: string; permissions: readonly string[] };
  session: { user: { name?: string | null; email?: string | null } };
};

function actorOf(ctx: Ctx) {
  return {
    kind: 'user' as const,
    id: ctx.rbac.id,
    name: ctx.session.user.name || ctx.session.user.email || ctx.rbac.id,
    roleLabel: ctx.rbac.roleLabel,
  };
}

/**
 * VeloExpense: a task's status, off VeloExpense's `approval_task` (no Prisma model), for the
 * two checks ExpenseOS makes before its engine is asked — that the task exists and is still
 * PENDING. The engine makes both again under its lock; these are the fast refusals, in
 * ExpenseOS's words.
 */
async function taskStatusOf(db: import('@/lib/db/prisma').TenantDb, taskId: string) {
  const rows = await db.$queryRaw<Array<{ status: string }>>`
    SELECT status::text AS status FROM approval_task WHERE id = ${taskId}::uuid`;
  return rows[0]?.status ?? null;
}

/**
 * Can this user see this report? ExpenseOS's `canViewReport`, which the discussion thread
 * (`comments.ts`) delegates to so a thread is visible exactly when the report is: read-all
 * or reimburse, the submitter, their direct manager, anyone an approval task touched, or
 * anyone eligible to decide it.
 *
 * VeloExpense: read off VeloExpense's tables — the manager is `app_user.manager_id`, and the
 * tasks are those of EVERY run of the report rather than only the current instance's
 * (VeloExpense keeps a run per submission, where ExpenseOS repoints one field), so an
 * approver who returned it can still follow the conversation after it is resubmitted.
 */
export async function canViewReport(
  db: import('@/lib/db/prisma').TenantDb,
  report: { id: string; submitterId: string },
  userId: string,
  perms: readonly string[],
): Promise<boolean> {
  if (perms.includes(P.expense.report.readAll) || perms.includes(P.expense.report.reimburse)) {
    return true;
  }
  if (report.submitterId === userId) return true;
  const related = await db.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok
      FROM app_user s
     WHERE s.id = ${report.submitterId}::uuid AND s.manager_id = ${userId}::uuid
    UNION ALL
    SELECT 1 AS ok
      FROM approval_task t
      JOIN approval_request q ON q.id = t.request_id
     WHERE q.report_id = ${report.id}::uuid
       AND (t.assignee_id = ${userId}::uuid OR t.decided_by_id = ${userId}::uuid)
     LIMIT 1`;
  if (related.length > 0) return true;
  return callerCanDecideReport(db, report.id, userId, false);
}

export const expenseApprovalsRouter = router({
  /**
   * VeloExpense stand-in, until Wave 4 ports the real one.
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
  myTasks: protectedProcedure.query(async ({ ctx }) => {
    const items = await withOrg(ctx.session.user.organizationId, (tx) =>
      listInbox(tx, ctx.session.user.id, { limit: 100 }),
    );
    return { items };
  }),

  /**
   * AP's cross-report expense view: every expense the caller may see, flat,
   * without opening one report at a time.
   *
   * The motivating case is chasing receipts — "which expenses are missing one"
   * is a question about expenses, not reports, and answering it by opening
   * thirty reports is the workflow this replaces. `missingReceipt` is therefore
   * a first-class filter rather than something to eyeball.
   *
   * AP / admin only: it deliberately crosses submitters, which is the whole
   * point and also why it can't be scoped like the submitter's own list.
   */
  expenses: protectedProcedure
    .input(
      z
        .object({
          /**
           * TRUE = only expenses with no receipt, FALSE = only expenses that have one,
           * absent = both.
           *
           * The `false` arm is new. It used to be read as a truthy check, so `false` and
           * "unset" were the same request — which was fine while the only caller had a
           * two-state toggle, and is not once the filter bar can express the other side of
           * an enum. A filter offering "has a receipt" that silently returned everything
           * would be worse than not offering it.
           */
          missingReceipt: z.boolean().optional(),
          status: z.enum(ExpenseReportStatus).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          limit: z.number().int().min(1).max(500).default(200),
          /**
           * Cursor for the next page — the id of the last row already seen.
           *
           * This query used to take 200 rows and stop, with no way to ask for more and nothing
           * on screen saying it had truncated (GA readiness report F19). For a large team that
           * silently hides expenses, which is worse on a list AP works from than on any other.
           */
          cursor: z.string().uuid().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const perms = ctx.rbac.permissions;
      if (
        !perms.includes(P.expense.report.readAll) &&
        !perms.includes(P.expense.report.reimburse)
      ) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      const rows = await ctx.db.expense.findMany({
        where: {
          // Drafts are still being written; they're the submitter's business,
          // not AP's, and would swamp the list with half-entered rows.
          report: {
            status: input?.status ? input.status : { not: ExpenseReportStatus.DRAFT },
          },
          // VeloExpense: a receipt is a STORED one (w2-09).
          ...(input?.missingReceipt === true ? { receipts: { none: STORED } } : {}),
          ...(input?.missingReceipt === false ? { receipts: { some: STORED } } : {}),
          ...(input?.from || input?.to
            ? {
                date: {
                  ...(input?.from ? { gte: input.from } : {}),
                  ...(input?.to ? { lte: input.to } : {}),
                },
              }
            : {}),
        },
        /**
         * `id` is the tiebreaker, and it is not optional: two expenses on the same DATE are
         * ordinary, and a cursor over a non-unique sort skips or repeats rows at every page
         * boundary. UUIDv7 is time-sortable, so this keeps the intended order.
         *
         * VeloExpense: ids are random (`gen_random_uuid()`), not UUIDv7, so the tiebreak is
         * deterministic but not chronological. And a VeloExpense expense may have no date;
         * those sort LAST, after every dated one, rather than at the top of the list
         * (Postgres puts a NULL first in a descending sort).
         */
        orderBy: [{ date: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        // One more than asked for, to learn whether another page exists without a count query.
        take: (input?.limit ?? 200) + 1,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          date: true,
          merchant: true,
          amountMinor: true,
          // VeloExpense: the code; the symbol comes from `currencySymbol`.
          currency: { select: { code: true } },
          // VeloExpense: STORED receipts only (w2-09).
          _count: { select: { receipts: { where: STORED } } },
          lineItems: {
            select: { category: { select: { label: true } } },
            orderBy: { amountMinor: 'desc' },
            take: 1,
          },
          report: {
            select: {
              id: true,
              number: true,
              status: true,
              // VeloExpense: one display name, no first/last split.
              submitter: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });
      // Drop the over-fetched row and hand back a cursor, so the caller can ask for the rest
      // instead of being silently shown a truncated list.
      const limit = input?.limit ?? 200;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: page.map((e) => ({
          id: e.id,
          date: e.date,
          merchant: e.merchant,
          amountMinor: e.amountMinor.toString(),
          // VeloExpense: ExpenseOS's `{ code, symbol }`, the symbol from the platform.
          currency: {
            code: e.currency.code,
            symbol: currencySymbol(e.currency.code),
          },
          receiptCount: e._count.receipts,
          categoryLabel: e.lineItems[0]?.category.label ?? null,
          report: {
            id: e.report.id,
            number: e.report.number,
            status: e.report.status,
            // VeloExpense: ExpenseOS's submitter shape, the display name in `firstName` (as
            // `pendingApproverByReport` does in the expenses router).
            submitter: {
              id: e.report.submitter.id,
              firstName: e.report.submitter.name,
              lastName: null as string | null,
              email: e.report.submitter.email,
            },
          },
        })),
        /** Null on the last page — the shape `useInfiniteQuery` expects. */
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      };
    }),

  /**
   * Nudge submitters about specific expenses that have no receipt.
   *
   * The daily `expense.receiptChase` job covers drafts the submitter still owns;
   * this is the on-demand counterpart for an approver or AP who is looking at a
   * report right now and wants the receipts before deciding.
   *
   * Differences from the cron, both deliberate:
   *   - it IGNORES the cooldown. A person asked explicitly; silently swallowing
   *     that because a robot mailed them on Tuesday would look broken.
   *   - it works on any status, not just DRAFT/RETURNED. The whole point is
   *     chasing a SUBMITTED report you're about to decide.
   *
   * Still one notification per REPORT, however many expenses were selected —
   * five receiptless lines on one report is one piece of news.
   *
   * VeloExpense: the daily job arrives with the worker jobs; until then this is the only way
   * a reminder is sent.
   */
  chaseReceipts: protectedProcedure
    .input(z.object({ expenseIds: z.array(z.string().uuid()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const expenses = await ctx.db.expense.findMany({
        // VeloExpense: a receipt is a STORED one (w2-09).
        where: { id: { in: input.expenseIds }, receipts: { none: STORED } },
        select: {
          id: true,
          report: {
            // VeloExpense: the report's title, total and currency as well, for the
            // notification's `{report}` / `{total}` (`reportPayload`).
            select: {
              id: true,
              number: true,
              title: true,
              totalMinor: true,
              currencyId: true,
              submitterId: true,
            },
          },
        },
      });
      // Everything selected already has a receipt (or vanished) — nothing to ask
      // for. Not an error; the UI just reports zero.
      if (expenses.length === 0) return { reports: 0, expenses: 0, skipped: [] as string[] };

      const perms = ctx.rbac.permissions;
      const isPrivileged =
        perms.includes(P.expense.report.readAll) || perms.includes(P.expense.report.reimburse);

      // Group by report: one ask per report, and one authorization check per
      // report rather than per expense.
      const byReport = new Map<
        string,
        {
          report: (typeof expenses)[number]['report'];
          submitterId: string;
          count: number;
        }
      >();
      for (const e of expenses) {
        const hit = byReport.get(e.report.id) ?? {
          report: e.report,
          submitterId: e.report.submitterId,
          count: 0,
        };
        hit.count += 1;
        byReport.set(e.report.id, hit);
      }

      // VeloExpense: the notification service runs on the procedure's own transaction.
      const tx = queryRunnerOf(ctx.db);
      let sent = 0;
      let chased = 0;
      const skipped: string[] = [];
      for (const [reportId, info] of byReport) {
        const allowed =
          isPrivileged || (await callerCanDecideReport(ctx.db, reportId, ctx.rbac.id, false));
        if (!allowed) {
          skipped.push(reportId);
          continue;
        }
        const activityId = await recordActivity(tx, {
          subjectType: 'EXPENSE_REPORT',
          subjectId: reportId,
          eventType: 'RECEIPT_REMINDER',
          // Actor-attributed, unlike the cron's system reminder — the submitter
          // should see who is waiting on them.
          actorId: ctx.rbac.id,
          // VeloExpense: the report placeholders every EXPENSE_REPORT event carries
          // (`reportPayload`), then ExpenseOS's own three.
          payload: {
            ...reportPayload({
              title: info.report.title,
              number: info.report.number,
              totalMinor: info.report.totalMinor,
              currencyCode: info.report.currencyId,
            }),
            missing: info.count,
            onDemand: true,
          },
        });
        await notifyRecipients(tx, activityId, [info.submitterId]);
        sent += 1;
        chased += info.count;
      }
      return { reports: sent, expenses: chased, skipped };
    }),

  /** Approve or reject a task. Eligibility-gated (canDecide); the engine
   *  advances the instance and drives ExpenseReport.status on a terminal
   *  outcome (applyTerminal).
   *
   *  The OVERRIDE — deciding a task that was never yours — is
   *  `expense.report.decide.any`, and nothing else. It used to be `read.all`, which
   *  let an AP clerk approve any report and then reimburse it. A decision made on
   *  the override is audited as one (`details.override: true`), so the log can tell
   *  the assigned manager's approval from somebody stepping around them.
   *
   *  VeloExpense: decided on VeloExpense's engine (`decideThroughEngine`, d36), which
   *  re-checks eligibility under a lock, audits (with the override), hands an approved
   *  report to the ledger and notifies the submitter with the note — the jobs ExpenseOS's
   *  `withAudit`, `notifyReportDecision`, `executeWorkflowEffects` and `postApprovedReport`
   *  do. One input more than ExpenseOS's: `receiptViewAcknowledged`, which a VeloExpense
   *  approval step can require (VX2-1) before an approval. */
  decide: protectedProcedure
    .input(
      z.object({
        taskId: z.string().uuid(),
        approve: z.boolean(),
        note: z.string().trim().max(2000).optional(),
        /** VeloExpense: the approver confirms they reviewed the receipts, where the step
         *  asks for it. Ignored on a rejection, as the engine ignores it. */
        receiptViewAcknowledged: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const status = await taskStatusOf(ctx.db, input.taskId);
      if (!status) throw new TRPCError({ code: 'NOT_FOUND' });
      if (status !== 'PENDING') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task already decided.' });
      }
      return decideThroughEngine(
        ctx.db,
        input.taskId,
        ctx.rbac.id,
        input.approve ? 'APPROVED' : 'REJECTED',
        { note: input.note ?? null, receiptViewAcknowledged: input.receiptViewAcknowledged },
        ctx.rbac.permissions.includes(P.expense.report.decideAny),
      );
    }),

  // VeloExpense: ExpenseOS's `decideBulk` (the inbox's group approve) arrives with the inbox,
  // in Wave 4.

  /** Manually reassign a pending approval task to another user. Authorized like
   *  a decision (`canDecide` — the current assignee, an eligible claimant, or the
   *  `decide.any` override): whoever could decide it can instead hand it to someone else.
   *  The target must be an active employee. Audited (`report.reassign`) and the
   *  new assignee is notified.
   *
   *  VeloExpense: on VeloExpense's engine (`reassignTask`, d36). A REASON is required and
   *  shown on the report's discussion and to the submitter (d37); the submitter, and the
   *  person who already holds it, are refused as targets. */
  reassign: protectedProcedure
    .input(
      z.object({
        taskId: z.string().uuid(),
        toUserId: z.string().uuid(),
        /** VeloExpense (d37): why it is being passed on. */
        note: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const status = await taskStatusOf(ctx.db, input.taskId);
      if (!status) throw new TRPCError({ code: 'NOT_FOUND' });
      if (status !== 'PENDING') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task already decided.' });
      }
      await reassignThroughEngine(
        ctx.db,
        input.taskId,
        ctx.rbac.id,
        input.toUserId,
        input.note,
        ctx.rbac.permissions.includes(P.expense.report.decideAny),
      );
      return { ok: true as const };
    }),

  /** Return a submitted report to its submitter for edits: cancel the running
   *  instance, skip its pending tasks, and flip the report to RETURNED (which
   *  the submitter can edit + resubmit). Eligibility-gated like decide.
   *
   *  VeloExpense: a RETURNED decision on the caller's own pending task, on VeloExpense's
   *  engine — which closes the run, cancels its other tasks, moves the report to RETURNED,
   *  audits (with the override) and notifies the submitter with the note. */
  returnForEdit: protectedProcedure
    .input(z.object({ reportId: z.string().uuid(), note: z.string().trim().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: { id: true, status: true },
      });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      if (report.status !== ExpenseReportStatus.SUBMITTED) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only submitted reports can be returned.',
        });
      }
      // Eligible on one of the report's pending tasks, or holding the override — and the
      // audit row says which. Asked without the override first so an eligible approver
      // who also happens to hold it is recorded as the approver they are.
      const mayOverride = ctx.rbac.permissions.includes(P.expense.report.decideAny);
      const own = await resolveDecidableTask(ctx.db, input.reportId, ctx.rbac.id, false);
      const taskId =
        own ??
        (mayOverride
          ? await resolveDecidableTask(ctx.db, input.reportId, ctx.rbac.id, true)
          : null);
      if (!taskId) throw new TRPCError({ code: 'FORBIDDEN' });
      await decideThroughEngine(
        ctx.db,
        taskId,
        ctx.rbac.id,
        'RETURNED',
        { note: input.note ?? null },
        own === null && mayOverride,
      );
      return { id: report.id, status: ExpenseReportStatus.RETURNED };
    }),

  // VeloExpense: ExpenseOS's `markReimbursed` stays VeloExpense's reimbursement screen
  // (/admin/reimbursements) until Wave 4.

  /** Set or clear a per-report FX override (A4) — the statement rate, applied to every
   *  expense in the overridden foreign currency. A submitted report only: the override is
   *  part of what an approver signs, and a decided report's amounts are what was approved.
   *
   *  Stamped as a MANUAL rate on those expenses (`snapshotExpensesFx`) and the report total
   *  recomputed, because an override that only lived on the report header and that nothing
   *  read about would have produced a report total its own line items contradict.
   *  Clearing drops those snapshots back to the derived daily rate.
   *
   *  Gated on `expense.report.fxOverride`, NOT `reimburse`: the AP Clerk holds
   *  `reimburse` next to `netsuite.sync.push`, so on the old gate one role could
   *  decide what a report's total was and then send it to the ledger. Restating
   *  the amounts is a finance-admin act; paying and posting them is AP's. Whoever
   *  sets the override is recorded on the report (`fxRateOverrideById`), and
   *  `netsuiteSync.approveExpenseReportPosting` refuses that person the post.
   *
   *  VeloExpense: ExpenseOS's procedure, on VeloExpense's tables (currencies by code) and
   *  audit name (`REPORT_FX_OVERRIDE_SET`). VeloExpense has no manual post approval yet, so
   *  the overrider is not refused anything at posting time — see the PR's flags. */
  setFxOverride: withPermission(P.expense.report.fxOverride)
    .input(
      z.object({
        reportId: z.string().uuid(),
        // A positive decimal rate, or null to clear the override.
        rate: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .refine((s) => Number(s) > 0, 'rate must be positive')
          .nullable(),
        fromCurrency: z.string().length(3).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: {
          id: true,
          status: true,
          currency: { select: { code: true } },
          // Which currency the override being replaced/cleared applied to, so the
          // right expenses get reset.
          fxRateOverrideCurrency: true,
          expenses: { select: { id: true, currency: { select: { code: true } } } },
        },
      });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      if (report.status !== ExpenseReportStatus.SUBMITTED) {
        throw refusal(
          'PRECONDITION_FAILED',
          REFUSAL_KEYS.fxOverrideNotSubmitted,
          'The FX override can only be set or cleared while the report is submitted and ' +
            'awaiting a decision. Once decided, its amounts are what was approved.',
        );
      }

      /** The expenses an override in `code` applies to. */
      const expensesIn = (code: string | null) =>
        report.expenses.filter((e) => e.currency.code === code).map((e) => e.id);

      // Clearing the override.
      if (input.rate === null) {
        await withAudit(
          ctx.db,
          {
            action: auditActions.report.fxOverride,
            entityType: 'ExpenseReport',
            entityId: report.id,
            actor: actorOf(ctx),
            details: { cleared: true },
          },
          (tx) =>
            tx.expenseReport.update({
              where: { id: report.id },
              data: {
                fxRateOverride: null,
                fxRateOverrideCurrency: null,
                fxRateOverrideAt: null,
                fxRateOverrideById: null,
              },
              select: { id: true },
            }),
        );
        // `force: null` drops the MANUAL snapshot and lets the daily rate apply
        // again — the expenses have to be un-stamped, or clearing the override
        // would change nothing at all.
        await snapshotExpensesFx(ctx.db, {
          expenseIds: expensesIn(report.fxRateOverrideCurrency),
          force: null,
        });
        await recomputeReportTotal(ctx.db, report.id);
        return { ok: true as const };
      }

      // Setting the override — the currency must be a FOREIGN currency actually
      // present on the report (converting the report's own currency is a no-op).
      const foreign = new Set(
        report.expenses.map((e) => e.currency.code).filter((c) => c !== report.currency.code),
      );
      if (!input.fromCurrency || !foreign.has(input.fromCurrency)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'fromCurrency must be a foreign currency present on the report.',
        });
      }
      const rate = Number(input.rate);
      if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_FX_RATE) {
        throw refusal(
          'BAD_REQUEST',
          REFUSAL_KEYS.fxRateOutOfBounds,
          `Rate must be a positive number no greater than ${MAX_FX_RATE}.`,
          { max: MAX_FX_RATE },
        );
      }
      // The daily rate for the same direction (home per 1 foreign), when one exists.
      const daily = await resolveExpenseFx(ctx.db, {
        amountMinor: 1n,
        currencyCode: input.fromCurrency,
        homeCurrency: report.currency.code,
      });
      const reference = daily.fxRate === null ? null : Number(daily.fxRate);
      if (reference !== null && reference > 0) {
        if (rate > reference * FX_OVERRIDE_BAND || rate < reference / FX_OVERRIDE_BAND) {
          throw refusal(
            'BAD_REQUEST',
            REFUSAL_KEYS.fxRateFarFromDaily,
            `Rate ${input.rate} is more than ${FX_OVERRIDE_BAND}× away from the daily rate ` +
              `${reference} for ${input.fromCurrency}→${report.currency.code}. A statement rate ` +
              'differs from the daily rate by a few percent, not by multiples.',
            {
              rate: input.rate,
              band: FX_OVERRIDE_BAND,
              reference: String(reference),
              from: input.fromCurrency,
              home: report.currency.code,
            },
          );
        }
      }
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.fxOverride,
          entityType: 'ExpenseReport',
          entityId: report.id,
          actor: actorOf(ctx),
          details: { rate: input.rate, fromCurrency: input.fromCurrency },
        },
        (tx) =>
          tx.expenseReport.update({
            where: { id: report.id },
            data: {
              fxRateOverride: input.rate,
              fxRateOverrideCurrency: input.fromCurrency,
              fxRateOverrideAt: new Date(),
              fxRateOverrideById: ctx.rbac.id,
            },
            select: { id: true },
          }),
      );
      // Replacing an override that pointed at a DIFFERENT currency leaves that
      // currency's expenses stamped with a rate no override backs any more.
      if (report.fxRateOverrideCurrency && report.fxRateOverrideCurrency !== input.fromCurrency) {
        await snapshotExpensesFx(ctx.db, {
          expenseIds: expensesIn(report.fxRateOverrideCurrency),
          force: null,
        });
      }
      await snapshotExpensesFx(ctx.db, {
        expenseIds: expensesIn(input.fromCurrency),
        force: { rate: input.rate, source: 'MANUAL' },
      });
      await recomputeReportTotal(ctx.db, report.id);
      return { ok: true as const };
    }),
});
