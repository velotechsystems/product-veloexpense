/**
 * ExpenseOS's expenses router (`apps/web/src/server/routers/expenses.ts` at 550b2945),
 * ported in slices (Wave 2). This file holds the slices ported so far:
 *
 *   · w2-07 — the report-level procedures: `list`, `summaryOwn`, `create`,
 *     `updateReport`, `deleteReport`, and the `currencies` / `categories` pickers.
 *
 * The rest of ExpenseOS's router (the expense, line, tax, FX, allocation, attendee and
 * receipt procedures, `report`, `submit`, `recall`) arrives with w2-08 onwards, in
 * ExpenseOS's order and words.
 *
 * VeloExpense adaptations are marked `VeloExpense:` where they are made. The shared ones:
 *   · a currency is keyed by its ISO code (`currencyId` holds the code, as `homeCurrencyId`
 *     does since 0048), and its symbol comes from the platform (`currencySymbol`);
 *   · who a submitted report is "sitting with" is read from VeloExpense's own approval
 *     tables until Wave 4 ports ExpenseOS's engine (`pendingApproverByReport`);
 *   · a report's number is minted from the organization's sequence, as VeloExpense's own
 *     writer has always done (`mintReportNumber`);
 *   · receipt objects are deleted through VeloExpense's storage (`getStorage`).
 *   · a RETURNED report is editable, as in ExpenseOS (d26).
 */
import { auditActions, auditDiff, withAudit } from '@expenseos/audit';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { TenantDb } from '@/lib/db/prisma';
import { ExpenseReportStatus } from '@/lib/generated/prisma/enums';
import { getStorage } from '@/lib/storage';
import { currencySymbol } from '@/server/lib/currencySymbol';
import {
  buildHomeRollup,
  type CurrencyGroup,
  homeConverterFor,
  readerCurrencyCode,
  readerTotalsFor,
} from '@/server/lib/readerCurrency';
import { REFUSAL_KEYS, refusal } from '@/server/refusal';
import { router, withPermission } from '@/server/trpc';

/** A report is editable (and (re)submittable) by its submitter while DRAFT or
 *  RETURNED — an approver can return a submitted report for fixes (Phase 3),
 *  after which it behaves like a draft again until resubmitted. */
const EDITABLE_REPORT_STATUSES: ExpenseReportStatus[] = [
  ExpenseReportStatus.DRAFT,
  ExpenseReportStatus.RETURNED,
];

function actorOf(ctx: {
  rbac: { id: string; roleLabel: string };
  session: { user: { name?: string | null; email?: string | null } };
}) {
  return {
    kind: 'user' as const,
    id: ctx.rbac.id,
    name: ctx.session.user.name || ctx.session.user.email || ctx.rbac.id,
    roleLabel: ctx.rbac.roleLabel,
  };
}

/** The one refusal for a write to a report the submitter no longer owns the figures of. */
const NOT_EDITABLE = {
  key: REFUSAL_KEYS.reportNotEditable,
  message: 'Report is not editable.',
} as const;

/**
 * VeloExpense: "who is this report sitting with", from VeloExpense's approval tables.
 *
 * ExpenseOS reads its own engine (`ExpenseReport.approvalInstanceId` → the first PENDING
 * `ApprovalTask`'s assignee). VeloExpense's engine is still its own until Wave 4: a report
 * out for approval has one RUNNING `approval_request`, whose tasks carry the assignee. The
 * rule is ExpenseOS's — the first pending task wins, and a pool task nobody has claimed
 * names nobody — and the shape is the one ExpenseOS's list returns, with VeloExpense's one
 * display name in `firstName` (VeloExpense has no first/last split).
 */
async function pendingApproverByReport(
  db: TenantDb,
  reportIds: readonly string[],
): Promise<Map<string, { firstName: string | null; lastName: string | null; email: string } | null>> {
  const out = new Map<string, { firstName: string | null; lastName: string | null; email: string } | null>();
  if (reportIds.length === 0) return out;
  const rows = await db.$queryRaw<
    { report_id: string; display_name: string | null; email: string | null }[]
  >`
    SELECT DISTINCT ON (r.report_id)
           r.report_id::text AS report_id,
           u.display_name,
           COALESCE(u.email, t.assignee_email) AS email
      FROM approval_request r
      JOIN approval_task t ON t.request_id = r.id AND t.status = 'PENDING'
      LEFT JOIN app_user u ON u.id = t.assignee_id
     WHERE r.status = 'RUNNING'
       AND r.report_id = ANY(${[...reportIds]}::uuid[])
     ORDER BY r.report_id, t.created_at ASC, t.step ASC`;
  for (const row of rows) {
    out.set(
      row.report_id,
      row.email ? { firstName: row.display_name, lastName: null, email: row.email } : null,
    );
  }
  return out;
}

/**
 * VeloExpense: the next report number (`EXP-000042`), from the organization's sequence.
 *
 * ExpenseOS mints it from a global Postgres sequence in the column default. VeloExpense's
 * numbers are per tenant and have always come from `organization.expense_report_seq`,
 * taken under the organization row's lock so two concurrent creates cannot draw the same
 * one (lib/expenses/service.ts `createReport`, which this mirrors).
 */
async function mintReportNumber(db: TenantDb): Promise<string> {
  const [org] = await db.$queryRaw<{ id: string; seq: bigint }[]>`
    SELECT id::text AS id, expense_report_seq AS seq
      FROM organization
     WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid
       FOR UPDATE`;
  if (!org) throw new TRPCError({ code: 'FORBIDDEN', message: 'No tenant context' });
  const next = BigInt(org.seq) + 1n;
  await db.$executeRaw`UPDATE organization SET expense_report_seq = ${next} WHERE id = ${org.id}::uuid`;
  return `EXP-${next.toString().padStart(6, '0')}`;
}

export const expensesRouter = router({
  /** List expense reports visible to the current user. */
  list: withPermission(P.expense.report.readOwn)
    .input(
      z
        .object({
          status: z.enum(ExpenseReportStatus).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        submitterId: ctx.session.user.id,
        ...(input?.status ? { status: input.status } : {}),
      };
      const rows = await ctx.db.expenseReport.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: input?.limit ?? 50,
        include: {
          currency: { select: { code: true } },
          _count: { select: { expenses: true } },
        },
      });

      // "Who is my report sitting with?" — a submitted report shows only
      // "Submitted", which tells the submitter nothing about whether it's
      // stuck or with whom. Resolve the current pending approver per report in
      // one query rather than N.
      // VeloExpense: from VeloExpense's approval tables (`pendingApproverByReport`); first
      // pending task wins, as below in ExpenseOS.
      const pendingByReport = await pendingApproverByReport(
        ctx.db,
        rows.filter((r) => r.status === 'SUBMITTED').map((r) => r.id),
      );

      /**
       * Each report's total, also expressed in the READER's own currency.
       *
       * The list used to add these up raw: "Total open" summed `totalMinor` across every
       * submitted and approved report and printed one `$` in front of it. Adding USD cents
       * to CAD cents is the same error `reportTotal.ts` warns about ("¥1,000 is not
       * $10.00") — and because CAD and USD share the `$` glyph, nothing on screen gave the
       * reader a hint that two different currencies had been added together (GA readiness
       * report F54, and the list half of F52).
       *
       * `null` when no rate connects the pair in either direction. The client leaves those
       * reports OUT of the summed balance and says how many it left out, rather than
       * quietly understating it — the same rule `buildReportRollup` follows for a report.
       */
      const homeCurrency = await readerCurrencyCode(ctx.db, ctx.session.user.id);
      /**
       * Built from each report's OWN expenses, not from its stored total converted once.
       * The row and the report it links to have to be the same number, and the report now
       * rolls up at the reader's currency so that each expense keeps the rate it was filed
       * at (GA-3). Converting the stored total here would put the old disagreement back,
       * one screen over.
       */
      const readerTotals = await readerTotalsFor(
        ctx.db,
        homeCurrency,
        rows.map((r) => ({ id: r.id, totalMinor: r.totalMinor, currencyCode: r.currency.code })),
      );

      return rows.map((r) => ({
        ...r,
        // VeloExpense: ExpenseOS's `currency` row carries its symbol; this one is the
        // platform's (`currencySymbol`).
        currency: { code: r.currency.code, symbol: currencySymbol(r.currency.code) },
        totalMinor: r.totalMinor.toString(),
        /** The reader's own currency, so the client can label what it is summing. */
        homeCurrency,
        /** `totalMinor` converted into `homeCurrency`, or null when no rate connects them. */
        homeTotalMinor: readerTotals.get(r.id)?.totalMinor ?? null,
        /** Expenses this currency cannot value, disclosed rather than dropped. */
        homeExcluded: readerTotals.get(r.id)?.excluded ?? 0,
        expenseCount: r._count.expenses,
        /** Current approver while the report is out for approval. Null when it
         *  isn't pending, or when the task is an unclaimed filter-pool one. */
        pendingWith: pendingByReport.get(r.id) ?? null,
      }));
    }),

  /**
   * "My reports" as an AGGREGATE — the count and the money for the whole set, not rows.
   *
   * `list` is capped (50 by default, 100 at most), so a count derived from what it
   * returned is a count of what fit, not a count of what exists: a header reading "50"
   * over a person with 63 reports is wrong by construction and no client-side arithmetic
   * recovers the missing 13. That is the whole reason this procedure exists. It is
   * deliberately NOT a paginated `list` variant — it reads three numbers out of Postgres
   * and never materialises a row.
   *
   * Same gate as `list` — `withPermission(P.expense.report.readOwn)` — and the same
   * `submitterId` filter. The wrapper is the capability check ("may this role read
   * expense reports at all"); scoping to MINE belongs in the `where` clause, and the two
   * are not interchangeable.
   *
   * `status` mirrors `list`'s filter so a caller that renders a filtered list can ask for
   * the matching header without a second contract to keep in step.
   */
  summaryOwn: withPermission(P.expense.report.readOwn)
    .input(z.object({ status: z.enum(ExpenseReportStatus).optional() }).optional())
    .query(async ({ ctx, input }) => {
      /**
       * `groupBy` takes SCALARS, so it groups on `currencyId` and the ISO code is looked
       * up after — `currency.code` is a relation field and would not compile.
       */
      const groups = await ctx.db.expenseReport.groupBy({
        by: ['currencyId'],
        where: {
          submitterId: ctx.session.user.id,
          ...(input?.status ? { status: input.status } : {}),
        },
        _count: { _all: true },
        _sum: { totalMinor: true },
      });
      // VeloExpense: `currencyId` IS the ISO code, and the symbol is the platform's.
      const currencies = groups.length
        ? (
            await ctx.db.currency.findMany({
              where: { code: { in: groups.map((g) => g.currencyId) } },
              select: { code: true },
            })
          ).map((c) => ({ id: c.code, code: c.code, symbol: currencySymbol(c.code) }))
        : [];
      const currencyById = new Map(currencies.map((c) => [c.id, c]));

      const homeCurrency = await readerCurrencyCode(ctx.db, ctx.session.user.id);
      const inHomeCurrency = await homeConverterFor(
        ctx.db,
        homeCurrency,
        currencies.map((c) => c.code),
      );
      const rollup = buildHomeRollup(
        groups.flatMap<CurrencyGroup>((g) => {
          const currency = currencyById.get(g.currencyId);
          // `currencyId` is a Restrict FK, so the lookup cannot miss. Dropping the group
          // rather than inventing a code keeps `count` and `byCurrency` agreeing if it
          // ever does.
          return currency
            ? [
                {
                  code: currency.code,
                  symbol: currency.symbol,
                  count: g._count._all,
                  // `?? 0n` is SUM over an empty set, not the forbidden "an amount we
                  // could not convert is zero" — a group exists only because it has rows.
                  totalMinor: g._sum.totalMinor ?? 0n,
                },
              ]
            : [];
        }),
        inHomeCurrency,
      );

      return {
        homeCurrency,
        /** Every report matching the filter. Derived from the same groups the money is,
         *  so the header count and the currency breakdown can never disagree. */
        count: rollup.byCurrency.reduce((n, c) => n + c.count, 0),
        ...rollup,
      };
    }),

  /** Create a new draft expense report. */
  create: withPermission(P.expense.report.createOwn)
    .input(
      z.object({
        title: z.string().min(1).max(200),
        /** Either a Currency UUID or an ISO-4217 code. The router
         *  resolves to the FK so the client can keep using "USD"
         *  while we move callers off the legacy String column. */
        currency: z.string().min(3).default('USD'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Accept both the new FK shape (UUID) and the legacy code.
      // VeloExpense: a currency's key IS its code, so there is no uuid to accept — a uuid
      // names nothing and is refused as an unknown currency, as ExpenseOS refuses one that
      // does not exist.
      const currencyRow = await ctx.db.currency.findUnique({
        where: { code: input.currency.toUpperCase() },
        select: { code: true },
      });
      if (!currencyRow) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown currency' });
      }
      const row = await ctx.db.expenseReport.create({
        data: {
          // VeloExpense: the number is minted here (`mintReportNumber`), not by a column default.
          number: await mintReportNumber(ctx.db),
          title: input.title,
          currencyId: currencyRow.code,
          submitterId: ctx.session.user.id,
        },
      });
      return { ...row, totalMinor: row.totalMinor.toString() };
    }),

  /** Delete a DRAFT report (cascades expenses → line items → receipts).
   *  Best-effort deletes the receipts' S3 objects. Owner-guarded, DRAFT-only. */
  deleteReport: withPermission(P.expense.report.deleteDraft)
    .input(z.object({ reportId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: { submitterId: true, status: true },
      });
      if (!report || report.submitterId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (report.status !== 'DRAFT') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only DRAFT reports can be deleted.' });
      }
      // Collect the S3 keys before the cascade removes the Receipt rows.
      const receipts = await ctx.db.receipt.findMany({
        where: { expense: { reportId: input.reportId } },
        select: { s3Key: true },
      });
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.delete,
          entityType: 'ExpenseReport',
          entityId: input.reportId,
          actor: actorOf(ctx),
          details: {},
        },
        async (tx) => tx.expenseReport.delete({ where: { id: input.reportId } }),
      );
      // VeloExpense: VeloExpense's storage (`getStorage`), ExpenseOS's best-effort rule.
      const storage = getStorage();
      await Promise.all(receipts.map((r) => storage.delete(r.s3Key).catch(() => undefined)));
      return { ok: true as const };
    }),

  categories: withPermission(P.expense.report.readOwn).query(async ({ ctx }) => {
    return ctx.db.expenseCategory.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      // `acceptsTip` rides along with `isMileage`: together they are what selects a
      // line row's kind STRATEGY (see _workbench/lineKinds.tsx).
      select: {
        id: true,
        label: true,
        icon: true,
        color: true,
        isMileage: true,
        acceptsTip: true,
      },
    });
  }),

  /** Active currencies for the report-create picker. */
  currencies: withPermission(P.expense.report.readOwn).query(async ({ ctx }) => {
    // VeloExpense: the shared `currency` table has no `active` flag, symbol or localized
    // label — every row is offered, the id is the code, the symbol is the platform's and
    // the label is the English name in ExpenseOS's `{ en }` shape.
    const rows = await ctx.db.currency.findMany({
      orderBy: { code: 'asc' },
      select: { code: true, name: true },
    });
    return rows.map((c) => ({
      id: c.code,
      code: c.code,
      symbol: currencySymbol(c.code),
      label: { en: c.name },
    }));
  }),

  /** Patch a DRAFT report's header fields (title / purpose). */
  updateReport: withPermission(P.expense.report.updateOwn)
    .input(
      z.object({
        reportId: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        purpose: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        // `title` and `purpose` are read for the audit diff as well as the guard: the
        // row as it stood is the only place the "from" side of an edit exists, and it
        // is gone the instant the update lands.
        select: { submitterId: true, status: true, title: true, purpose: true },
      });
      if (!report || report.submitterId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (!EDITABLE_REPORT_STATUSES.includes(report.status)) {
        throw refusal('BAD_REQUEST', NOT_EDITABLE.key, NOT_EDITABLE.message);
      }
      const { reportId: _reportId, ...reportPatch } = input;
      await withAudit(
        ctx.db,
        {
          action: auditActions.report.update,
          entityType: 'ExpenseReport',
          entityId: input.reportId,
          actor: actorOf(ctx),
          details: auditDiff(report, reportPatch),
        },
        async (tx) =>
          tx.expenseReport.update({
            where: { id: input.reportId },
            data: {
              title: input.title,
              purpose: input.purpose,
            },
            select: { id: true },
          }),
      );
      return { ok: true as const };
    }),

});
