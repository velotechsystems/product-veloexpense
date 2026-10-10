/**
 * ExpenseOS's expense-report approver surface (`apps/web/src/server/routers/
 * expenseApprovals.ts` at 550b2945), ported in slices — as the expenses router is.
 *
 *   · w2-06 — AP's cross-report expense view and its receipt chase: `expenses` and
 *     `chaseReceipts`, in ExpenseOS's words.
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
import { ExpenseReportStatus } from '@expenseos/db';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { listInbox } from '@/lib/approvals/inbox';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { notifyRecipients, recordActivity, reportPayload } from '@/lib/notifications/service';
import { withOrg } from '@/lib/tenant/context';
import { currencySymbol } from '@/server/lib/currencySymbol';
import { callerCanDecideReport } from '@/server/lib/reportApproval';
import { protectedProcedure, router } from '@/server/trpc';

/** VeloExpense: a receipt that is in storage (w2-09). */
const STORED = { status: 'STORED' } as const;

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
});
