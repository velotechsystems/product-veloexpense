/**
 * ExpenseOS's expense-report approver surface (`apps/web/src/server/routers/
 * expenseApprovals.ts` at 550b2945), ported in slices — as the expenses router is.
 *
 *   · w2-06 — AP's cross-report expense view and its receipt chase: `expenses` and
 *     `chaseReceipts`, in ExpenseOS's words;
 *   · w2-02a — the approver's actions the workbench calls: `decide`, `reassign`,
 *     `returnForEdit` and `setFxOverride` (d36);
 *   · w4-00c — on ExpenseOS's approval engine: `myTasks` (`loadMyExpenseApprovalTasks`), and
 *     the three actions' bodies, which run in `server/lib/reportLifecycle.ts` so that the
 *     /approvals form and the emailed /approve link decide exactly as these do. ExpenseOS's
 *     fast refusals stay here, in its words. `decideBulk`, `myDecided`, `myTeam`, `report` and
 *     `markReimbursed` are not ported: VeloExpense keeps its own /approvals inbox and
 *     reimbursement screen (d57).
 *
 * VeloExpense adaptations are marked `VeloExpense:` where they are made. The shared ones, as in
 * the expenses router:
 *   · a currency is keyed by its ISO code, and its symbol comes from the platform
 *     (`currencySymbol`);
 *   · VeloExpense has one display name, so a submitter's is carried in `firstName`;
 *   · only a STORED receipt is a receipt (w2-09): a PENDING row is an upload that never
 *     arrived;
 *   · the activity is recorded through VeloExpense's notification service on the
 *     procedure's own transaction (`queryRunnerOf`).
 */
import { graphSchema, type WorkflowNode } from '@expenseos/approvals';
import {
  buildActorEligibilityContext,
  canClaimUnresolvedApproval,
  claimNeedsRequester,
  isEligible,
  primeRequesterIds,
} from '@expenseos/approvals/engine';
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
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { notifyRecipients, recordActivity, reportPayload } from '@/lib/notifications/service';
import { APPROVAL_POOL_CAP, capApprovalPool } from '@/server/lib/approvalPoolCap';
import { currencySymbol } from '@/server/lib/currencySymbol';
import { homeConverterFor, readerCurrencyCode } from '@/server/lib/readerCurrency';
import { getStorage } from '@/lib/storage';
import { receiptViewUrl } from '@/lib/receipts/viewUrl';
import { resolveDecideAccess } from '@/server/lib/decideAccess';
import { deriveRouteView } from '@/server/lib/mileageRouteView';
import { callerCanDecideReport, canViewReport } from '@/server/lib/reportApproval';
import {
  decideThroughEngine,
  reassignThroughEngine,
  returnThroughEngine,
  toTrpcError,
} from '@/server/lib/reportLifecycle';
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

/** The shared Prisma client, as the extracted loaders below take it.
 *  VeloExpense: the request's tenant transaction. */
type WebDb = TenantDb;

/** Report summary for the inbox list.
 *  VeloExpense: a currency is keyed by its code (the symbol comes from `currencySymbol`), and
 *  a submitter has one display name. */
const REPORT_SUMMARY_SELECT = {
  id: true,
  number: true,
  title: true,
  status: true,
  totalMinor: true,
  submittedAt: true,
  currency: { select: { code: true } },
  submitter: { select: { id: true, name: true, email: true } },
} as const;

/** VeloExpense: ExpenseOS's report-summary shape from a `REPORT_SUMMARY_SELECT` row — the
 *  currency's symbol from the platform, the submitter's one display name in `firstName`. */
function summaryShape<
  R extends {
    totalMinor: bigint;
    currency: { code: string };
    submitter: { id: string; name: string | null; email: string };
  },
>(r: R) {
  return {
    ...r,
    totalMinor: r.totalMinor.toString(),
    currency: { code: r.currency.code, symbol: currencySymbol(r.currency.code) },
    submitter: {
      id: r.submitter.id,
      firstName: r.submitter.name,
      lastName: null as string | null,
      email: r.submitter.email,
    },
  };
}

/** VeloExpense: a person as ExpenseOS's inbox reads one (`firstName`/`lastName`/`email`). */
function personShape(u: { id: string; name: string | null; email: string } | null) {
  return u ? { id: u.id, firstName: u.name, lastName: null as string | null, email: u.email } : null;
}

/** Report detail for the approver review view: expenses with their line items,
 *  attendees, cost allocations and receipts.
 *
 *  NOT the submitter's `expenses.report` shape: that one is `expenses.ts`'
 *  EXPENSE_DETAIL_INCLUDE and serves the editor. This one is read by a wider
 *  audience — every caller `canViewReport` admits, which includes, while a task is
 *  pending, anyone eligible to decide it, including every member of a filter-approver
 *  or fallback pool — so a field is added here only when the approver drawer renders
 *  it, and the mapping in `report` names each one.
 *
 *  VeloExpense: a currency is keyed by its code; the submitter's entity carries its home
 *  currency's CODE; only STORED receipts (w2-09); violations are read on their own
 *  (`PolicyViolation` is no relation of this model here). */
const REPORT_DETAIL_INCLUDE = {
  currency: { select: { code: true } },
  submitter: {
    select: {
      id: true,
      name: true,
      email: true,
      // Home currency + ITC eligibility, both of which the review view renders
      // against (rules 3 and 6).
      entity: { select: { homeCurrencyId: true, itcRecoverable: true } },
    },
  },
  expenses: {
    orderBy: { createdAt: 'asc' },
    include: {
      currency: { select: { code: true } },
      lineItems: {
        orderBy: { createdAt: 'asc' },
        include: { category: { select: { id: true, label: true, icon: true } } },
        // The traveller's year-to-date distance is not rendered on the drawer.
        omit: { mileageYtdBefore: true },
      },
      attendees: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, company: true, isExternal: true },
      },
      // The coding the approver signs off on. Same include as `expenses.ts`'
      // EXPENSE_DETAIL_INCLUDE, so both screens name a line's business unit alike.
      // VeloExpense: an allocation has a business unit and a department only — no class and
      // no NetSuite business unit (VeloExpense posts to no NetSuite), as in `expenses.ts`.
      allocations: {
        orderBy: { createdAt: 'asc' },
        include: {
          businessUnit: { select: { id: true, label: true } },
          department: { select: { id: true, label: true } },
        },
      },
      receipts: {
        where: STORED,
        orderBy: { uploadedAt: 'desc' },
        include: {
          extraction: {
            select: {
              scanStatus: true,
              status: true,
              confidence: true,
              data: true,
              error: true,
              reviewedAt: true,
            },
          },
        },
      },
    },
  },
} as const;

/** One band of a mileage line's stored breakdown, as the approver drawer reads it. */
interface MileageBreakdownEntry {
  fromDistance: string | number;
  rateMinor: string | number;
  distance: string | number;
  amountMinor: string | number;
}

/** A stored primitive the drawer's `mileageTiers` accepts: a string or a finite number. */
function breakdownField(v: unknown): string | number | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/**
 * `ExpenseLineItem.mileageBreakdown` rebuilt by name: the four fields of each band,
 * in their stored primitive form, and nothing else. All-or-nothing — not an array,
 * or any entry that is not an object carrying all four as a string or finite number,
 * yields null for the whole field (never a throw), so the drawer shows no rate rather
 * than a partial split. The drawer validates the values themselves (`mileageTiers`).
 */
function breakdownView(stored: unknown): MileageBreakdownEntry[] | null {
  if (!Array.isArray(stored)) return null;
  const out: MileageBreakdownEntry[] = [];
  for (const entry of stored) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const fromDistance = breakdownField(e.fromDistance);
    const rateMinor = breakdownField(e.rateMinor);
    const distance = breakdownField(e.distance);
    const amountMinor = breakdownField(e.amountMinor);
    if (fromDistance == null || rateMinor == null || distance == null || amountMinor == null) {
      return null;
    }
    out.push({ fromDistance, rateMinor, distance, amountMinor });
  }
  return out;
}

// VeloExpense (eos-573): `canViewReport` moved to server/lib/reportApproval.ts, as in
// ExpenseOS (#573). ExpenseOS's private `canDecideReport` is VeloExpense's
// `callerCanDecideReport` there (w4-00c).

/**
 * The approver's pending expense-report inbox, as a plain function.
 *
 * It is a function rather than only a procedure body so that a caller which has
 * ALREADY decided this queue is not being shown can simply not call it — the
 * whole load, pool scan and eligibility walk included, then costs nothing. That
 * is the short-circuit seam; who decides, and on what, is the caller's business
 * and is deliberately not decided here.
 */
export async function loadMyExpenseApprovalTasks(db: WebDb, actorId: string) {
  const base = {
    status: 'PENDING' as const,
    instance: { status: 'RUNNING' as const, subjectType: 'EXPENSE_REPORT' as const },
  };
  const [assignedRaw, unassignedRaw] = await Promise.all([
    db.approvalTask.findMany({
      where: { ...base, assigneeUserId: actorId },
      orderBy: { createdAt: 'asc' },
      take: APPROVAL_POOL_CAP + 1,
      select: { id: true, label: true, instance: { select: { subjectId: true } } },
    }),
    db.approvalTask.findMany({
      where: { ...base, assigneeUserId: null },
      orderBy: { createdAt: 'asc' },
      // The unassigned pool is not scoped to the caller at all — it is every
      // unassigned PENDING task in the workspace, and eligibility is decided
      // afterwards, in application code. Nothing bounded it, so one approver's
      // login materialized the whole queue. See `approvalPoolCap`: the bound is
      // on MATERIALIZATION and it is signalled, not on visibility and silent.
      take: APPROVAL_POOL_CAP + 1,
      select: {
        id: true,
        label: true,
        nodeId: true,
        instanceId: true,
        instance: {
          select: {
            subjectId: true,
            effectiveGraph: true,
            workflowVersionId: true,
            workflowVersion: { select: { graph: true } },
          },
        },
      },
    }),
  ]);
  const assigned = capApprovalPool('assigned', 'EXPENSE_REPORT', actorId, assignedRaw);
  const unassigned = capApprovalPool('unassigned', 'EXPENSE_REPORT', actorId, unassignedRaw);

  /**
   * One memo, allocated here and dropped when this call returns.
   *
   * Everything the eligibility walk used to re-read per task — the actor's own
   * row, the actor's authorization row, the actor's manager chain, each node's
   * minimum job level, each subject's requester — is read once through this and
   * answered from memory afterwards, so the per-task query count is zero. It is
   * a local because it must be: `@expenseos/approvals` is imported by the
   * long-lived worker, and a module-scoped authorization cache there would have
   * no invalidation path.
   */
  const cx = buildActorEligibilityContext(actorId);

  /**
   * Resolve every unassigned task's node, parsing each distinct graph once.
   *
   * Instances overwhelmingly share their workflow version's graph, so the parse
   * is keyed by version — and by instance for the rows that carry their own
   * inlined `effectiveGraph`, which is per-instance by definition. A failed
   * parse memoizes as null and is skipped, exactly as the per-task parse did.
   */
  const resolved: { task: (typeof unassigned.rows)[number]; node: WorkflowNode }[] = [];
  for (const t of unassigned.rows) {
    /**
     * `!= null`, NOT truthiness, and the value below must agree with it. `effectiveGraph`
     * is `Json?`, so it can hold a falsy scalar (`false`, `0`, `""`). Under `?` such a row
     * keyed by VERSION while `?? ` still parsed the instance's own bogus value — memoizing
     * that failure under the version key and silently dropping every other unassigned task
     * on that version from the claimable set. The per-task parse this replaced lost only
     * the one row.
     */
    const key =
      t.instance.effectiveGraph != null ? `i:${t.instanceId}` : `v:${t.instance.workflowVersionId}`;
    let graph = cx.graphs.get(key);
    if (graph === undefined) {
      const parsed = graphSchema.safeParse(
        t.instance.effectiveGraph ?? t.instance.workflowVersion.graph,
      );
      graph = parsed.success ? parsed.data : null;
      cx.graphs.set(key, graph);
    }
    const node = graph?.nodes.find((n) => n.id === t.nodeId);
    if (node) resolved.push({ task: t, node });
  }

  /**
   * The requester ids the claim check will ask for, in one query.
   *
   * Narrower than "every unassigned subject" on purpose: a requester is consulted
   * only by the no-fallback case of the claim rule, so `claimNeedsRequester`
   * names exactly the subjects that will be asked about. A node with a `user` or
   * `role` fallback never reads one and is not fetched.
   */
  await primeRequesterIds(
    db,
    cx,
    'EXPENSE_REPORT',
    resolved.filter((r) => claimNeedsRequester(r.node)).map((r) => r.task.instance.subjectId),
  );

  const claimable: { id: string; label: string | null; subjectId: string }[] = [];
  for (const { task, node } of resolved) {
    // Either a filter-pool match, or a relative-approver task that resolved to
    // nobody — the no-manager case. Without the second check the task is
    // decidable but invisible, which is the same dead end wearing a different
    // hat: it would still lapse and auto-reject with nobody having seen it.
    const eligible =
      (await isEligible(db, node, actorId, cx)) ||
      (await canClaimUnresolvedApproval(
        db,
        node,
        'EXPENSE_REPORT',
        task.instance.subjectId,
        actorId,
        cx,
      ));
    if (eligible) {
      claimable.push({ id: task.id, label: task.label, subjectId: task.instance.subjectId });
    }
  }

  const all = [
    ...assigned.rows.map((t) => ({ id: t.id, label: t.label, subjectId: t.instance.subjectId })),
    ...claimable,
  ];
  const ids = [...new Set(all.map((t) => t.subjectId))];
  const reports = ids.length
    ? await db.expenseReport.findMany({
        where: { id: { in: ids } },
        select: REPORT_SUMMARY_SELECT,
      })
    : [];
  const byId = new Map(reports.map((r) => [r.id, r]));
  /** The rows this inbox will render: a task whose subject report has gone is dropped,
   *  and is dropped from the count and the money too — it cannot be actioned. */
  const rows = all.flatMap((t) => {
    const report = byId.get(t.subjectId);
    return report ? [{ taskId: t.id, label: t.label, report }] : [];
  });

  /**
   * NO HOME-CURRENCY ROLLUP HERE, DELIBERATELY — and it is not an oversight to be
   * "restored".
   *
   * This procedure used to return `homeCurrency` / `byCurrency` / `homeTotalMinor` /
   * `excludedCount` for the "At a glance" header badges. Those badges were deleted earlier
   * in this same branch, and nothing read the four fields afterwards: the inbox reads
   * `items` / `capped` / `cappedAt`, and `ReportsToApproveCard` reads `count` / `capped`.
   *
   * The cost was not theoretical. `readerCurrencyCode` is one `User` read, but
   * `homeConverterFor` falls through to `fxRate.findMany()` — the whole table, no `take` —
   * as soon as any queued report is in a foreign currency. `Sidebar.tsx` mounts `myTasks`
   * for every holder of `expense.report.approve` on EVERY page, so an approver with one
   * USD and one CAD report in their queue paid for a full `FxRate` scan on each page load
   * past the stale window, and the result was discarded.
   *
   * If a consumer ever needs the rollup again, add it back WITH that consumer, in the same
   * commit. The reasoning for computing it here rather than in a fourth procedure still
   * holds — the eligibility loop above has already resolved the exact claimable set, so a
   * separate `summary` would run the most expensive query on the login path twice — which
   * is precisely why this comment survives the code it describes.
   */

  return {
    // VeloExpense: ExpenseOS's report shape — the currency's symbol from the platform, and
    // the submitter's one display name in `firstName`.
    items: rows.map((r) => ({
      ...r,
      report: {
        ...r.report,
        totalMinor: r.report.totalMinor.toString(),
        currency: { code: r.report.currency.code, symbol: currencySymbol(r.report.currency.code) },
        submitter: {
          id: r.report.submitter.id,
          firstName: r.report.submitter.name,
          lastName: null as string | null,
          email: r.report.submitter.email,
        },
      },
    })),
    /**
     * Everything awaiting the caller — of what was materialized. Kept beside `items`
     * because `items` drops rows whose report has gone, so a header counting the array
     * it renders would disagree with the queue. When `capped` is true this is a FLOOR,
     * not a total, and the UI says so rather than presenting a truncated number as if
     * it were the answer.
     */
    count: rows.length,
    /**
     * A pool hit the materialization bound and this response is a PREFIX of what is
     * really pending. The receipt, not the control: the control is the alarmed metric
     * `capApprovalPool` emits, because a reader being told their list is short does not
     * get the queue unstuck — an operator does.
     */
    capped: assigned.capped || unassigned.capped,
    /** The bound that was applied, so the notice quotes the number the server
     *  actually used rather than a copy of it hardcoded in the client. */
    cappedAt: APPROVAL_POOL_CAP,
  };
}

export const expenseApprovalsRouter = router({
  /** Pending expense-report approval tasks for the caller — assigned to them,
   *  plus unassigned filter-approver tasks they're eligible to claim. Mirrors
   *  virtualCardRequests.myTasks. */
  myTasks: protectedProcedure.query(({ ctx }) => loadMyExpenseApprovalTasks(ctx.db, ctx.rbac.id)),

  /** Reports the caller has already DECIDED — the "decided by me" history that
   *  the pending inbox drops once a task leaves PENDING (A2/A3). Any expense-
   *  report task the caller decided (APPROVED / REJECTED), newest decision
   *  first, with the outcome + when. Read-only in the UI.
   *
   *  VeloExpense (w4-05/w4-07, d71): ported with the inbox; the report rows in ExpenseOS's
   *  summary shape (`summaryShape`). */
  myDecided: protectedProcedure.query(async ({ ctx }) => {
    const tasks = await ctx.db.approvalTask.findMany({
      where: {
        decidedById: ctx.rbac.id,
        status: { in: ['APPROVED', 'REJECTED'] },
        instance: { subjectType: 'EXPENSE_REPORT' as const },
      },
      orderBy: { decidedAt: 'desc' },
      select: {
        id: true,
        status: true,
        decidedAt: true,
        instance: { select: { subjectId: true } },
      },
    });
    // One report may have several decided tasks (multi-step); keep the most
    // recent decision per report (tasks are already newest-first).
    const seen = new Set<string>();
    const ordered: { taskId: string; status: string; decidedAt: Date | null; reportId: string }[] =
      [];
    for (const t of tasks) {
      if (seen.has(t.instance.subjectId)) continue;
      seen.add(t.instance.subjectId);
      ordered.push({
        taskId: t.id,
        status: t.status,
        decidedAt: t.decidedAt,
        reportId: t.instance.subjectId,
      });
    }
    const reports = ordered.length
      ? await ctx.db.expenseReport.findMany({
          where: { id: { in: [...seen] } },
          select: REPORT_SUMMARY_SELECT,
        })
      : [];
    const byId = new Map(reports.map((r) => [r.id, r]));
    /**
     * Also in the READER's currency, because this list is summed on screen.
     *
     * An approver's history spans whatever currencies their team submitted in, and adding
     * USD cents to CAD cents under a single `$` is the error `expenses.list` already
     * learned not to make (F54). A report with no rate path comes back null and is
     * EXCLUDED from the sum by the caller, never folded in at face value.
     */
    const homeCurrency = await readerCurrencyCode(ctx.db, ctx.rbac.id);
    const inHomeCurrency = await homeConverterFor(
      ctx.db,
      homeCurrency,
      reports.map((r) => r.currency.code),
    );
    return {
      homeCurrency,
      items: ordered.flatMap((o) => {
        const report = byId.get(o.reportId);
        return report
          ? [
              {
                taskId: o.taskId,
                decision: o.status,
                decidedAt: o.decidedAt,
                report: {
                  ...summaryShape(report),
                  homeTotalMinor: inHomeCurrency(report.totalMinor, report.currency.code),
                },
              },
            ]
          : [];
      }),
    };
  }),

  /** Every submitted report from one of the caller's DIRECT REPORTS, whatever
   *  its status and whoever ended up deciding it.
   *
   *  The pending inbox is keyed on task assignment, so a manager loses sight of
   *  a report the moment tier routing, escalation or delegation sends it
   *  elsewhere — and `myDecided` only covers what the caller decided
   *  themselves. Neither answers "what is my team spending, and what happened
   *  to it", which is the question a manager actually has. Drafts are excluded:
   *  an unsubmitted report isn't the manager's business yet.
   *
   *  Each row carries where the report currently sits (`pendingWith`) and the
   *  most recent decision on it (`lastDecision`), so the manager can see both
   *  that it exists and who has it.
   *
   *  VeloExpense (w4-05/w4-07, d71): ported with the inbox; people in ExpenseOS's shape
   *  (`personShape`). */
  myTeam: protectedProcedure.query(async ({ ctx }) => {
    const reports = await ctx.db.user.findMany({
      where: { managerId: ctx.rbac.id, deletedAt: null },
      select: { id: true },
    });
    if (reports.length === 0) return { items: [] };

    const rows = await ctx.db.expenseReport.findMany({
      where: {
        submitterId: { in: reports.map((r) => r.id) },
        status: { not: ExpenseReportStatus.DRAFT },
      },
      orderBy: { submittedAt: 'desc' },
      select: { ...REPORT_SUMMARY_SELECT, approvalInstanceId: true },
    });
    if (rows.length === 0) return { items: [] };

    // One pass over every task on those instances — who holds each report now,
    // and what the last decision on it was.
    const instanceIds = rows.flatMap((r) => (r.approvalInstanceId ? [r.approvalInstanceId] : []));
    const tasks = instanceIds.length
      ? await ctx.db.approvalTask.findMany({
          where: { instanceId: { in: instanceIds } },
          orderBy: { createdAt: 'asc' },
          select: {
            instanceId: true,
            status: true,
            decidedAt: true,
            assignee: { select: { id: true, name: true, email: true } },
            decidedBy: { select: { id: true, name: true, email: true } },
          },
        })
      : [];

    type Person = ReturnType<typeof personShape>;
    const pendingWith = new Map<string, Person>();
    const lastDecision = new Map<string, { by: Person; decision: string; at: Date | null }>();
    for (const t of tasks) {
      if (t.status === 'PENDING') {
        if (!pendingWith.has(t.instanceId)) pendingWith.set(t.instanceId, personShape(t.assignee));
      } else if (t.status === 'APPROVED' || t.status === 'REJECTED') {
        // Ascending createdAt — the last write is the newest decision.
        lastDecision.set(t.instanceId, {
          by: personShape(t.decidedBy),
          decision: t.status,
          at: t.decidedAt,
        });
      }
    }

    return {
      items: rows.map(({ approvalInstanceId, ...report }) => ({
        report: summaryShape(report),
        pendingWith: approvalInstanceId ? (pendingWith.get(approvalInstanceId) ?? null) : null,
        lastDecision: approvalInstanceId ? (lastDecision.get(approvalInstanceId) ?? null) : null,
      })),
    };
  }),

  /** Approver-visible report detail. Readable by an eligible approver, an
   *  AP reimburser, a chain/all reader, the submitter's direct manager, or the
   *  submitter themselves (see `canViewReport`). Its own, narrower shape than the
   *  submitter's `expenses.report` (see `REPORT_DETAIL_INCLUDE`), because its audience
   *  is wider: each field named, bigints stringified, receipts presigned.
   *
   *  VeloExpense (w4-05/w4-07, d71): ported with the inbox. No Platform Settings, so the
   *  extraction review threshold is ExpenseOS's default as a constant (as `expenses.report`
   *  has it); receipts are presigned through VeloExpense's storage; violations are read on
   *  their own; currencies carry the platform's symbol; the submitter's one display name is
   *  in `firstName`. */
  report: protectedProcedure
    .input(z.object({ reportId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        include: REPORT_DETAIL_INCLUDE,
      });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      const perms = ctx.rbac.permissions;
      if (!(await canViewReport(ctx.db, report, ctx.rbac.id, perms))) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }

      // Confidence threshold below which an extraction is flagged for the
      // approver to verify (Platform Settings; default 0.7).
      const extractionReviewThreshold = 0.7;
      const violations = await ctx.db.policyViolation.findMany({
        where: { reportId: report.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const storage = getStorage();
      const withSymbol = (code: string) => ({ code, symbol: currencySymbol(code) });

      // VeloExpense: no business-unit source to read — the admin business unit is the only
      // one (see `nsBusinessUnitLabel` below).

      const expenses = await Promise.all(
        report.expenses.map(async (e) => ({
          id: e.id,
          merchant: e.merchant,
          placeText: e.placeText,
          date: e.date,
          explanation: e.explanation,
          attendees: e.attendees,
          amountMinor: e.amountMinor.toString(),
          // Tax is on the expense now (a receipt = one tax total).
          taxGstHstMinor: e.taxGstHstMinor?.toString() ?? null,
          taxQstMinor: e.taxQstMinor?.toString() ?? null,
          currency: withSymbol(e.currency.code),
          // The conversion as filed — an approver has to approve the same
          // home-currency figure the employee will be paid (rule 3).
          fxRate: e.fxRate?.toString() ?? null,
          fxRateSource: e.fxRateSource,
          homeCurrency: e.homeCurrency,
          homeAmountMinor: e.homeAmountMinor?.toString() ?? null,
          // Each field named (never the Prisma row spread): `mileageRateId` and
          // `mileageDistanceOverride` stay off, and the stored route leaves only as
          // stop names plus a server-derived route distance (see `deriveRouteView`).
          // Mileage fields are read on MILEAGE lines only; every other kind sends null.
          lineItems: e.lineItems.map((li) => {
            const mileage = li.kind === 'MILEAGE';
            const mileageDistance = mileage ? (li.mileageDistance?.toString() ?? null) : null;
            // VeloExpense: `mileage_unit` is text under a CHECK (KM, MI); ExpenseOS's is an enum.
            const mileageUnit = mileage ? (li.mileageUnit as 'KM' | 'MI' | null) : null;
            const route = mileage
              ? deriveRouteView(li.mileageRoute, mileageUnit, mileageDistance)
              : null;
            return {
              id: li.id,
              category: li.category,
              kind: li.kind,
              amountMinor: li.amountMinor.toString(),
              mileageDistance,
              mileageUnit,
              // Written by the pricing engine: what each band billed, rebuilt by name.
              mileageBreakdown: mileage ? breakdownView(li.mileageBreakdown) : null,
              mileageRoute: route?.mileageRoute ?? null,
              routeDistance: route?.routeDistance ?? null,
              mileageRouteUnavailable: route?.mileageRouteUnavailable ?? false,
            };
          }),
          // Cost allocation across BU / Department / Class (0 = uncoded, 1 = single,
          // N = split), each field named — never the Prisma row spread onto the wire.
          // `pickerNsBusinessUnitId` is the submitter's editing state and stays off.
          allocations: e.allocations.map((a) => ({
            id: a.id,
            percentBp: a.percentBp,
            businessUnitId: a.businessUnitId,
            businessUnit: a.businessUnit,
            // VeloExpense: always null, as `expenses.report` sends it — ExpenseOS's answer
            // under its EXPENSEOS source; the client names the admin `businessUnit`.
            nsBusinessUnitLabel: null,
            departmentId: a.departmentId,
            department: a.department,
            // VeloExpense: no class (typed as ExpenseOS's `{ id, name }`, which the lines read).
            classId: null,
            class: null as { id: string; name: string } | null,
          })),
          receipts: await Promise.all(
            e.receipts.map(async (r) => ({
              id: r.id,
              filename: r.filename,
              contentType: r.contentType,
              uploadedAt: r.uploadedAt,
              // f19: null until the malware scan is CLEAN (ExpenseOS signs it regardless).
              url: await receiptViewUrl(r.s3Key, r.extraction?.scanStatus, { storage }),
              extraction: r.extraction
                ? {
                    scanStatus: r.extraction.scanStatus,
                    status: r.extraction.status,
                    confidence: r.extraction.confidence ? Number(r.extraction.confidence) : null,
                    reviewedAt: r.extraction.reviewedAt,
                  }
                : null,
            })),
          ),
        })),
      );

      const homeCode = report.submitter.entity?.homeCurrencyId ?? null;
      return {
        id: report.id,
        number: report.number,
        title: report.title,
        purpose: report.purpose,
        status: report.status,
        totalMinor: report.totalMinor.toString(),
        currency: withSymbol(report.currency.code),
        submittedAt: report.submittedAt,
        submitter: {
          id: report.submitter.id,
          firstName: report.submitter.name,
          lastName: null as string | null,
          email: report.submitter.email,
        },
        entity: {
          homeCurrency: homeCode ? { code: homeCode } : null,
          itcRecoverable: report.submitter.entity?.itcRecoverable ?? true,
        },
        violations,
        extractionReviewThreshold,
        expenses,
      };
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
   * VeloExpense: the daily job sends its own event, RECEIPT_CHASE (w3-05, d46), and counts an
   * ask sent from here as a reminder, as ExpenseOS's does.
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
   *  VeloExpense: after ExpenseOS's fast refusals, the body — `resolveDecideAccess`, the
   *  audited `decideTask`, `notifyReportDecision`, `executeWorkflowEffects` and the post on
   *  approval — runs in `decideThroughEngine` (server/lib/reportLifecycle.ts), with the
   *  billing gate, the report lock and VeloExpense's outcome (budgets, history, ledger post)
   *  around it. The receipt-view acknowledgement VeloExpense's ladder asked for is gone
   *  (d57). */
  decide: protectedProcedure
    .input(
      z.object({
        taskId: z.string().uuid(),
        approve: z.boolean(),
        note: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.db.approvalTask.findUnique({
        where: { id: input.taskId },
        select: { id: true, status: true, instance: { select: { subjectId: true } } },
      });
      if (!task) throw new TRPCError({ code: 'NOT_FOUND' });
      if (task.status !== 'PENDING') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task already decided.' });
      }
      const access = await resolveDecideAccess(
        ctx.db,
        input.taskId,
        ctx.rbac.id,
        ctx.rbac.permissions.includes(P.expense.report.decideAny),
      );
      if (!access.allowed) throw new TRPCError({ code: 'FORBIDDEN' });
      const res = await decideThroughEngine(ctx.db, {
        taskId: input.taskId,
        actorId: ctx.rbac.id,
        approve: input.approve,
        note: input.note ?? null,
        mayOverride: ctx.rbac.permissions.includes(P.expense.report.decideAny),
      }).catch((err: unknown) => {
        throw toTrpcError(err);
      });
      // VeloExpense: ExpenseOS's `DecideResult`, with whether it was decided on the override.
      return res;
    }),

  /** Approve several pending tasks at once (the inbox group action). Each task
   *  is decided independently — re-checked for PENDING + eligibility, audited,
   *  and its notifications + workflow effects fired — so one ineligible/stale
   *  task never fails the batch. Returns which ids were approved vs skipped so
   *  the UI can report a partial result. Approve-only by design: a bulk reject
   *  would need a per-report reason, which belongs in the single-report flow.
   *
   *  VeloExpense (w4-05/w4-07, d71): each approval runs through `decideThroughEngine`, as
   *  `decide` does — the billing gate, the report lock, the audit, VeloExpense's outcome
   *  (budgets, history, ledger post), the notifications and the workflow effects — with
   *  `bulk: true` in the audit's details, as ExpenseOS writes it. The request is ONE tenant
   *  transaction here, so a refusal raised inside the engine (after the checks above, which
   *  skip what ExpenseOS skips) fails the whole batch rather than being skipped: swallowing
   *  it could keep the half of that task's writes made before the throw. */
  decideBulk: protectedProcedure
    .input(
      z.object({
        taskIds: z.array(z.string().uuid()).min(1).max(100),
        note: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const mayOverride = ctx.rbac.permissions.includes(P.expense.report.decideAny);
      const approved: string[] = [];
      const skipped: { taskId: string; reason: 'not_found' | 'not_pending' | 'forbidden' }[] = [];
      for (const taskId of input.taskIds) {
        const task = await ctx.db.approvalTask.findUnique({
          where: { id: taskId },
          select: { id: true, status: true, instance: { select: { subjectId: true } } },
        });
        if (!task) {
          skipped.push({ taskId, reason: 'not_found' });
          continue;
        }
        if (task.status !== 'PENDING') {
          skipped.push({ taskId, reason: 'not_pending' });
          continue;
        }
        const access = await resolveDecideAccess(ctx.db, taskId, ctx.rbac.id, mayOverride);
        if (!access.allowed) {
          skipped.push({ taskId, reason: 'forbidden' });
          continue;
        }
        await decideThroughEngine(ctx.db, {
          taskId,
          actorId: ctx.rbac.id,
          approve: true,
          note: input.note ?? null,
          mayOverride,
          context: { bulk: true },
        }).catch((err: unknown) => {
          throw toTrpcError(err);
        });
        approved.push(taskId);
      }
      return { approved, skipped };
    }),

  /** Manually reassign a pending approval task to another user. Authorized like
   *  a decision (`canDecide` — the current assignee, an eligible claimant, or the
   *  `decide.any` override): whoever could decide it can instead hand it to someone else.
   *  The target must be an active employee. Audited (`report.reassign`) and the
   *  new assignee is notified.
   *
   *  VeloExpense: the body runs in `reassignThroughEngine` (server/lib/reportLifecycle.ts). A
   *  REASON is required and shown on the report's discussion and to the submitter (d37); the
   *  submitter, and the person who already holds it, are refused as targets. */
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
      const task = await ctx.db.approvalTask.findUnique({
        where: { id: input.taskId },
        select: { id: true, status: true, instance: { select: { subjectId: true } } },
      });
      if (!task) throw new TRPCError({ code: 'NOT_FOUND' });
      if (task.status !== 'PENDING') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task already decided.' });
      }
      const access = await resolveDecideAccess(
        ctx.db,
        input.taskId,
        ctx.rbac.id,
        ctx.rbac.permissions.includes(P.expense.report.decideAny),
      );
      if (!access.allowed) throw new TRPCError({ code: 'FORBIDDEN' });
      const target = await ctx.db.user.findFirst({
        where: { id: input.toUserId, deletedAt: null, employeeStatus: 'ACTIVE' },
        select: { id: true },
      });
      if (!target) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown or inactive assignee.' });
      }
      await reassignThroughEngine(ctx.db, {
        taskId: input.taskId,
        actorId: ctx.rbac.id,
        toUserId: input.toUserId,
        note: input.note,
        mayOverride: ctx.rbac.permissions.includes(P.expense.report.decideAny),
      }).catch((err: unknown) => {
        throw toTrpcError(err);
      });
      return { ok: true as const };
    }),

  /** Return a submitted report to its submitter for edits: cancel the running
   *  instance, skip its pending tasks, and flip the report to RETURNED (which
   *  the submitter can edit + resubmit). Eligibility-gated like decide.
   *
   *  VeloExpense: the body runs in `returnThroughEngine` (server/lib/reportLifecycle.ts), which
   *  also writes the report's outcome (budgets, history, REPORT_RETURNED) and tells the
   *  submitter with the approver's note. */
  returnForEdit: protectedProcedure
    .input(z.object({ reportId: z.string().uuid(), note: z.string().trim().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.db.expenseReport.findUnique({
        where: { id: input.reportId },
        select: { id: true, status: true, approvalInstanceId: true },
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
      const eligible = await callerCanDecideReport(ctx.db, input.reportId, ctx.rbac.id, false);
      const override = !eligible && ctx.rbac.permissions.includes(P.expense.report.decideAny);
      if (!eligible && !override) throw new TRPCError({ code: 'FORBIDDEN' });
      return returnThroughEngine(ctx.db, {
        reportId: report.id,
        actorId: ctx.rbac.id,
        note: input.note ?? null,
        mayOverride: ctx.rbac.permissions.includes(P.expense.report.decideAny),
      }).catch((err: unknown) => {
        throw toTrpcError(err);
      });
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
