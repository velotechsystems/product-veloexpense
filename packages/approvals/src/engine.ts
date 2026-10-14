/**
 * Approval engine — server layer. Wraps the pure interpreter (lib/approvals/
 * engine-core) with DB persistence, workflow selection, approver resolution,
 * and the subject callback. Generic over subjectType; the VCC adapter lives at
 * the bottom.
 *
 * Flow: startInstance() selects the matching published workflow, instantiates
 * it, walks until it parks on tasks (or completes), and persists. decideTask()
 * records a decision and resumes the walk; a reject fails the instance unless
 * it's a tolerated parallel-branch failure (per the join policy).
 *
 * VeloExpense: ExpenseOS's `packages/approvals/src/engine.ts` (550b2945), Wave 4 (w4-00b,
 * d50). Every function is ExpenseOS's; what changed is the plumbing, each marked below:
 *   · PER TENANT. Every query runs inside the caller's tenant transaction
 *     (`withTenantDb` / `inTenant`), so RLS confines each `findMany` to one organization.
 *     Nothing here names an organization; the sweep is called once per tenant (w4-00c).
 *   · Subjects: EXPENSE_REPORT, and TRAVEL_REQUEST reserved (no travel table yet, d50).
 *     The two virtual-card subjects and their adapters are out of scope and removed.
 *   · People: `app_user` has a text `role` where ExpenseOS has a `Role` row; it is read
 *     through `systemRoleFor`, as the tRPC context does, until the role builder (w4-10).
 *     Its offboarded status is DEACTIVATED (ExpenseOS: TERMINATED).
 *   · Delegation is VeloExpense's table (0008): inclusive dates, `revoked_at`, scope ALL |
 *     REPORTS.
 *   · Policy currency is `organization.policy_currency_code` (0015), where ExpenseOS has
 *     the `policyCurrency` system flag; policy violations are `policy_violation` (0006).
 *   · The budget facts (`overBudget`, `budgetOverageMinor`) come from `./budgets`, which is
 *     VeloExpense's (w4-04, d66): ExpenseOS's evaluation contract over VeloExpense's own
 *     budgets (0024), the same numbers the submit-time budget rule reads.
 */
import { Prisma, type PrismaClient } from '@expenseos/db';
import { convertMoney, fxRateMapFrom } from '@expenseos/money';
import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_PERMISSIONS } from '@expenseos/rbac';
import { systemRoleFor, type VeloExpenseRole } from '@expenseos/rbac/server';
import { addBusinessDays, DEFAULT_TTL_BUSINESS_DAYS } from './businessDays';
import {
  type AdvanceResult,
  advance,
  applyApproval,
  applyRejection,
  createInitialState,
  type EngineState,
} from './engine-core';
import { evaluateReportAgainstBudgets } from './budgets';
import { inlineCallWorkflows } from './inline';
import { computePerDiemOverageMinor } from './perdiem-overage';
import { evaluatePredicate, type SubjectFacts } from './predicate';
import {
  type ApproverFallback,
  graphSchema,
  matchConditionSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from './schema';

export { addBusinessDays, DEFAULT_TTL_BUSINESS_DAYS } from './businessDays';

type Db = PrismaClient | Prisma.TransactionClient;

/** VeloExpense: ExpenseOS's Prisma enum `ApprovalSubjectType`, minus the two virtual-card
 *  subjects. Text under a CHECK in the tables (0058). */
export type ApprovalSubjectType = 'EXPENSE_REPORT' | 'TRAVEL_REQUEST';

const MAX_CHAIN_DEPTH = 20;

// ── Subject facts + requester (VCC adapter) ─────────────────────────────────

interface SubjectContext {
  requesterId: string;
  subjectType: ApprovalSubjectType;
  facts: SubjectFacts;
}

/** Org base/policy currency + latest FxRate map (mirrors the policy engine). */
async function fxContext(db: Db): Promise<{ baseCode: string; rates: Map<string, string> }> {
  // VeloExpense: the tenant's `organization.policy_currency_code` (0015) is ExpenseOS's
  // `policyCurrency` flag. RLS-free table, so the row is named by the tenant scope.
  const [flag, fxRows] = await Promise.all([
    db.$queryRaw<{ code: string | null }[]>`
      SELECT policy_currency_code AS code FROM organization
       WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`,
    db.fxRate.findMany({ orderBy: { fetchedAt: 'desc' } }),
  ]);
  const value = flag[0]?.code;
  const baseCode = value && typeof value === 'string' && value ? value : 'CAD';
  return { baseCode, rates: fxRateMapFrom(fxRows) };
}

/** Build the predicate facts + requester for a subject. Extend the switch when
 *  a new subjectType adopts the engine. */
async function loadSubject(
  db: Db,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): Promise<SubjectContext> {
  // VeloExpense: ExpenseOS's VIRTUAL_CARD_REQUEST and VIRTUAL_CARD_LIMIT_INCREASE adapters
  // are out of scope (d50).
  if (subjectType === 'TRAVEL_REQUEST') {
    // VeloExpense: travel requests arrive with their own wave; ExpenseOS's adapter reads
    // `travelRequest` and its budget lines, which do not exist here yet.
    throw new Error('approval: travel requests are not available yet');
  }
  if (subjectType === 'EXPENSE_REPORT') {
    const r = await db.expenseReport.findUnique({
      where: { id: subjectId },
      select: {
        submitterId: true,
        totalMinor: true,
        currencyId: true,
        currency: { select: { code: true } },
        submitter: {
          select: {
            departmentId: true,
            jobLevelId: true,
            legalEntityId: true,
            businessUnitId: true,
            employeeStatus: true,
          },
        },
        // Line items drive the category / count / max-line facts; expense
        // date + place drive per-diem day grouping.
        expenses: {
          select: {
            date: true,
            placeText: true,
            lineItems: { select: { amountMinor: true, categoryId: true } },
          },
        },
      },
    });
    if (!r) throw new Error(`approval: ExpenseReport ${subjectId} not found`);
    // Any surviving policy violation (BLOCKs can't reach approval — they gate
    // submit — so at approval time this means a WARNING/INFO is present).
    // VeloExpense: `policy_violation` (0006) is not a Prisma model; the same question, as
    // ExpenseOS asks it (any row, acknowledged or not).
    const violations = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM policy_violation WHERE report_id = ${subjectId}::uuid LIMIT 1`;

    // Normalize the report total to the org base currency so `amount`
    // predicates compare consistently (mirrors the VCC branch).
    const { baseCode, rates } = await fxContext(db);
    const toBase = (amountMinor: bigint) =>
      Number(
        (
          convertMoney({ amountMinor, currencyCode: r.currency.code }, baseCode, rates) ?? {
            amountMinor,
          }
        ).amountMinor,
      );
    const amount = toBase(r.totalMinor);

    // Line-item-derived facts (Phase 5 category / compliance conditions).
    const lineItems = r.expenses.flatMap((e) => e.lineItems);
    const categoryIds = [...new Set(lineItems.map((li) => li.categoryId))];
    const lineCount = lineItems.length;
    const maxLineMinor = lineItems.reduce((m, li) => (li.amountMinor > m ? li.amountMinor : m), 0n);
    const maxLineAmount = toBase(maxLineMinor);
    // A category flagged `approvalRequired` forces the report into an approval
    // lane (a hook the ExpensePolicy schema reserves for exactly this).
    //
    // VeloExpense (w4-04): ExpenseOS's, now that its category policies exist here
    // (`expense_category_policy`, w4-02c); RLS keeps the count to the tenant's own.
    const requiresApproval =
      categoryIds.length > 0 &&
      (await db.expensePolicy.count({
        where: { categoryId: { in: categoryIds }, approvalRequired: true },
      })) > 0;

    // Per-diem overage (Phase 5c). Conservative: sum each (day + placeText)'s
    // spend and compare to the daily allowance of the most-specific per-diem
    // rate matching the submitter's tier + that placeText; days with no matching
    // rate aren't evaluated (no false positives). Skipped entirely when no rates
    // exist (the common case today).
    let perDiemOverageMinor = 0;
    const sub = r.submitter;
    if (lineItems.length > 0) {
      const perDiemRates = await db.perDiemRate.findMany({
        where: {
          AND: [
            { OR: [{ jobLevelId: null }, { jobLevelId: sub.jobLevelId }] },
            { OR: [{ legalEntityId: null }, { legalEntityId: sub.legalEntityId }] },
            { OR: [{ businessUnitId: null }, { businessUnitId: sub.businessUnitId }] },
          ],
        },
        select: {
          city: true,
          categoryId: true,
          amountMinor: true,
          firstLastDay: true,
          effectiveFrom: true,
          effectiveTo: true,
          jobLevelId: true,
          legalEntityId: true,
          businessUnitId: true,
          currencyId: true,
        },
      });
      if (perDiemRates.length > 0) {
        // VeloExpense: a currency's id IS its code, so the map is code → code.
        const currencies = (await db.currency.findMany({ select: { code: true } })).map((c) => ({
          id: c.code,
          code: c.code,
        }));
        // Shared with the submit-time policy rule — one copy of the FX + grouping
        // shell so approval-time and submit-time per-diem math can't drift.
        perDiemOverageMinor = computePerDiemOverageMinor({
          // VeloExpense: an expense's date may be blank (`txn_date` is nullable). An undated
          // expense belongs to no day, so — like a day with no matching rate — it is not
          // evaluated: no false positives.
          expenses: r.expenses.filter((e): e is typeof e & { date: Date } => e.date !== null),
          reportCurrencyCode: r.currency.code,
          baseCode,
          fxRates: rates,
          rates: perDiemRates,
          tier: {
            jobLevelId: sub.jobLevelId,
            legalEntityId: sub.legalEntityId,
            businessUnitId: sub.businessUnitId,
          },
          rateCurrencyCodeById: new Map(currencies.map((c) => [c.id, c.code])),
        });
      }
    }

    // Budget overage (Module 10). One cheap `count` short-circuits the whole
    // scan, which is the common case: no budgets configured, no work done.
    //
    // VeloExpense (w4-04): no `budget` model to count; the evaluation's own first step (the
    // budget periods this report's accounts and dates reach, `loadBudgetSnapshots`) is the
    // short-circuit, and it returns nothing when no budget is configured.
    const budgetOverage = (await evaluateReportAgainstBudgets(db, subjectId)).overageMinor;

    return {
      requesterId: r.submitterId,
      subjectType,
      facts: {
        amount,
        currency: r.currencyId,
        // Interval / vendor are VCC-only concepts — not part of an expense report.
        interval: null,
        vendorId: null,
        departmentId: r.submitter.departmentId,
        jobLevelId: r.submitter.jobLevelId,
        legalEntityId: r.submitter.legalEntityId,
        businessUnitId: r.submitter.businessUnitId,
        employeeStatus: r.submitter.employeeStatus,
        userId: r.submitterId,
        categoryIds,
        requiresApproval: requiresApproval ? 'true' : 'false',
        hasPolicyViolation: violations.length > 0 ? 'true' : 'false',
        lineCount,
        maxLineAmount,
        overPerDiem: perDiemOverageMinor > 0 ? 'true' : 'false',
        perDiemOverageMinor,
        overBudget: budgetOverage > 0n ? 'true' : 'false',
        // Reported in the BUDGET's currency, which is what the budget was set
        // in — converting it into the report currency would answer a question
        // nobody asked.
        budgetOverageMinor: Number(budgetOverage),
      },
    };
  }
  throw new Error(`approval: unsupported subjectType ${subjectType}`);
}

/** Resolve just the requester (subject owner) id without the full fact build.
 *  Used by canDecide to block self-approval, and by the notification fan-out
 *  (expiry sweep) to reach the subject owner. Extend the switch alongside
 *  loadSubject when a new subjectType adopts the engine. */
export async function loadRequesterId(
  db: Db,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): Promise<string | null> {
  // VeloExpense: no virtual-card subjects (d50).
  if (subjectType === 'EXPENSE_REPORT') {
    const r = await db.expenseReport.findUnique({
      where: { id: subjectId },
      select: { submitterId: true },
    });
    return r?.submitterId ?? null;
  }
  if (subjectType === 'TRAVEL_REQUEST') {
    // VeloExpense: no travel table yet. This is what blocks self-approval, so it refuses
    // rather than answering "nobody".
    throw new Error('approval: travel requests are not available yet');
  }
  throw new Error(`approval: unsupported subjectType ${subjectType}`);
}

/** Apply the instance's terminal outcome to its subject. */
async function applyTerminal(
  db: Db,
  subjectType: ApprovalSubjectType,
  subjectId: string,
  status: 'APPROVED' | 'REJECTED',
  // VeloExpense: only ExpenseOS's virtual-card request recorded who decided; the callers
  // still pass it, unchanged.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  actorId: string | null,
): Promise<void> {
  // VeloExpense: no virtual-card subjects (d50).
  if (subjectType === 'EXPENSE_REPORT') {
    await db.expenseReport.update({
      where: { id: subjectId },
      data: {
        status,
        // approvedAt stamps only on a positive outcome; REJECTED leaves it null.
        approvedAt: status === 'APPROVED' ? new Date() : null,
      },
    });
    return;
  }
  if (subjectType === 'TRAVEL_REQUEST') {
    // VeloExpense: no travel table yet.
    throw new Error('approval: travel requests are not available yet');
  }
  throw new Error(`approval: unsupported subjectType ${subjectType}`);
}

// ── Workflow selection ──────────────────────────────────────────────────────

interface SelectedVersion {
  versionId: string;
  graph: WorkflowGraph;
}

/** Highest-priority active workflow whose matchCondition matches; else the
 *  isDefault catch-all. Only PUBLISHED current versions are eligible. */
export async function selectWorkflowVersion(
  db: Db,
  subjectType: ApprovalSubjectType,
  facts: SubjectFacts,
): Promise<SelectedVersion | null> {
  const workflows = await db.approvalWorkflow.findMany({
    where: { subjectType, active: true, callable: false, currentVersionId: { not: null } },
    orderBy: [{ isDefault: 'asc' }, { priority: 'desc' }],
    select: { currentVersionId: true, isDefault: true },
  });
  const versionIds = workflows
    .map((w) => w.currentVersionId)
    .filter((v): v is string => v !== null);
  if (versionIds.length === 0) return null;
  const versions = await db.approvalWorkflowVersion.findMany({
    where: { id: { in: versionIds }, status: 'PUBLISHED' },
    select: { id: true, matchCondition: true, graph: true },
  });
  const byId = new Map(versions.map((v) => [v.id, v]));

  let fallback: SelectedVersion | null = null;
  for (const w of workflows) {
    const v = w.currentVersionId ? byId.get(w.currentVersionId) : undefined;
    if (!v) continue;
    const graph = graphSchema.parse(v.graph);
    if (w.isDefault) {
      fallback ??= { versionId: v.id, graph };
      continue;
    }
    const cond = matchConditionSchema.parse(v.matchCondition);
    if (evaluatePredicate(cond, facts)) return { versionId: v.id, graph };
  }
  return fallback;
}

/** Every published workflow keyed by its `key`, for resolving CallWorkflow
 *  nodes at instantiation. Includes callable sub-flows and ordinary ones. */
async function publishedGraphsByKey(
  db: Db,
  subjectType: ApprovalSubjectType,
): Promise<Map<string, WorkflowGraph>> {
  const workflows = await db.approvalWorkflow.findMany({
    where: { subjectType, active: true, currentVersionId: { not: null } },
    select: { key: true, currentVersionId: true },
  });
  const versionIds = workflows
    .map((w) => w.currentVersionId)
    .filter((v): v is string => v !== null);
  if (versionIds.length === 0) return new Map();
  const versions = await db.approvalWorkflowVersion.findMany({
    where: { id: { in: versionIds }, status: 'PUBLISHED' },
    select: { id: true, graph: true },
  });
  const graphById = new Map(versions.map((v) => [v.id, v.graph]));
  const out = new Map<string, WorkflowGraph>();
  for (const w of workflows) {
    const g = w.currentVersionId ? graphById.get(w.currentVersionId) : undefined;
    if (!g) continue;
    const parsed = graphSchema.safeParse(g);
    if (parsed.success) out.set(w.key, parsed.data);
  }
  return out;
}

// ── Approver resolution ─────────────────────────────────────────────────────

/** Nearest ancestor manager at/above `minJobLevelId` (or the direct manager
 *  when no level is set).
 *
 *  When NO ancestor carries a qualifying job level, this falls back to the
 *  most senior ancestor reached (top of chain) rather than returning null.
 *  Null here is a silent dead end, not a safe default: a relative-approver node
 *  that resolves to nobody still materializes a task, and an unassigned task
 *  with a non-`filter` approver can't be claimed (`isEligible` is filter-only),
 *  can't be decided (`canDecide` has no assignee to match), and can't even
 *  expire upward (`ESCALATE` is guarded on `task.assigneeUserId`). It parks
 *  forever with no UI anywhere showing it. Because job levels are optional on
 *  User, one unclassified employee anywhere in a chain was enough to strand
 *  every tiered approval above the direct-manager tier.
 *
 *  Returns null only when the requester has no manager at all — nobody to
 *  approve, which the caller surfaces as an unassigned task. */
async function resolveManagerChain(
  db: Db,
  requesterId: string,
  minJobLevelId: string | null | undefined,
): Promise<string | null> {
  if (!minJobLevelId) {
    const u = await db.user.findUnique({
      where: { id: requesterId },
      select: { managerId: true },
    });
    return u?.managerId ?? null;
  }
  const min = await db.jobLevel.findUnique({
    where: { id: minJobLevelId },
    select: { sortOrder: true },
  });
  const minSort = min?.sortOrder ?? 0;
  let cursor: string | null = requesterId;
  let mostSenior: string | null = null;
  for (let i = 0; i < MAX_CHAIN_DEPTH && cursor; i += 1) {
    const u: { managerId: string | null } | null = await db.user.findUnique({
      where: { id: cursor },
      select: { managerId: true },
    });
    const mgrId: string | null = u?.managerId ?? null;
    if (!mgrId) break; // top of chain
    mostSenior = mgrId;
    const mgr = await db.user.findUnique({
      where: { id: mgrId },
      select: { id: true, jobLevel: { select: { sortOrder: true } } },
    });
    if (mgr?.jobLevel && mgr.jobLevel.sortOrder >= minSort) return mgr.id;
    cursor = mgrId;
  }
  return mostSenior;
}

// ── On-leave skipping + delegation ──────────────────────────────────────────

/** The delegation scope that covers a subject (null = no specific scope, so
 *  only ALL-scoped delegations apply). */
function scopeForSubject(subjectType: ApprovalSubjectType): 'REPORTS' | null {
  // VeloExpense: no VCC scope — `delegation.scope` is ALL | REPORTS (0008).
  // Travel shares the REPORTS delegation scope: somebody covering a manager's
  // expense approvals is covering their trip approvals too. A separate TRAVEL scope
  // would silently leave travel uncovered by every delegation already in place.
  if (subjectType === 'EXPENSE_REPORT' || subjectType === 'TRAVEL_REQUEST') return 'REPORTS';
  return null;
}

/** Walk up the manager chain past anyone who can't act — ON_LEAVE, TERMINATED,
 *  or soft-deleted — so absence/offboarding doesn't park a task on a dead or
 *  absent approver. Returns the first actionable ancestor, or the original id
 *  if none is found within the chain depth. */
async function skipOnLeave(db: Db, userId: string): Promise<string> {
  let cursor = userId;
  for (let i = 0; i < MAX_CHAIN_DEPTH; i += 1) {
    const u = await db.user.findUnique({
      where: { id: cursor },
      select: { employeeStatus: true, managerId: true, deletedAt: true },
    });
    if (!u) return cursor;
    // VeloExpense: DEACTIVATED is VeloExpense's offboarded status (0004's CHECK has
    // ACTIVE | ON_LEAVE | DEACTIVATED); ExpenseOS's is TERMINATED.
    const unavailable =
      u.deletedAt != null || u.employeeStatus === 'ON_LEAVE' || u.employeeStatus === 'DEACTIVATED';
    if (!unavailable) return cursor;
    if (!u.managerId) return cursor; // top of chain — leave it (TTL escalation covers)
    cursor = u.managerId;
  }
  return cursor;
}

/**
 * VeloExpense: today in the tenant's working timezone, as the UTC midnight Prisma sends for a
 * `date` column — so a comparison against `delegation.starts_on` / `ends_on` is a comparison
 * of calendar days. Read inside the caller's tenant transaction (`app.current_org`).
 */
async function tenantToday(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ d: string }[]>`
    SELECT (now() AT TIME ZONE COALESCE(
             (SELECT o.default_timezone FROM organization o
               WHERE o.id = NULLIF(current_setting('app.current_org', true), '')::uuid),
             'UTC'))::date::text AS d`;
  return new Date(`${rows[0].d}T00:00:00Z`);
}

/** The active in-scope delegatee for a delegator right now, or null. Picks the
 *  most recently created when several overlap. */
async function activeDelegateeFor(
  db: Db,
  delegatorId: string,
  subjectType: ApprovalSubjectType,
): Promise<string | null> {
  const scopes: ('ALL' | 'REPORTS')[] = ['ALL'];
  const specific = scopeForSubject(subjectType);
  if (specific) scopes.push(specific);
  // VeloExpense: the table's names (0008). `revokedAt: null` is ExpenseOS's `active`, and
  // the range is inclusive calendar dates (a delegation is "away these days",
  // lib/approvals/delegations.ts), compared against TODAY IN THE TENANT'S WORKING TIMEZONE
  // (`organization.default_timezone`, 0027), as that file does. Not `new Date()`: Prisma
  // sends a Date for a `date` column as its UTC day, so for a Toronto tenant a delegation
  // ending today stopped covering at 20:00, and one starting tomorrow began then.
  const now = await tenantToday(db);
  const d = await db.delegation.findFirst({
    where: {
      fromUserId: delegatorId,
      revokedAt: null,
      scope: { in: scopes },
      startsOn: { lte: now },
      OR: [{ endsOn: null }, { endsOn: { gte: now } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { toUserId: true },
  });
  return d?.toUserId ?? null;
}

/** Rewrite a resolved assignee for absence + delegation: skip ON_LEAVE up the
 *  chain, then hand off to an active in-scope delegatee (also skipping leave on
 *  the delegatee). One delegation hop — no chains-of-delegations. */
export async function resolveAssignment(
  db: Db,
  baseAssigneeId: string | null,
  subjectType: ApprovalSubjectType,
): Promise<string | null> {
  if (!baseAssigneeId) return null;
  const afterLeave = await skipOnLeave(db, baseAssigneeId);
  const delegatee = await activeDelegateeFor(db, afterLeave, subjectType);
  return delegatee ? skipOnLeave(db, delegatee) : afterLeave;
}

/** The node-level fallback approver, if the node has a relative approver that
 *  can fail to resolve. `undefined` for every other node shape. */
function approverFallbackOf(node: WorkflowNode | undefined): ApproverFallback | undefined {
  if (!node || (node.type !== 'approval' && node.type !== 'acknowledge')) return undefined;
  const a = node.approver;
  return a.kind === 'manager' || a.kind === 'managerChain' ? a.fallback : undefined;
}

/**
 * Resolve the concrete approver for an approval node, or null to leave the task
 * unassigned. `manager` / `managerChain` resolve to one person; a `filter`
 * approver stays unassigned — any matching active user claims it at decide time
 * (see isEligible / canDecide).
 *
 * When a relative approver finds nobody, the node's `fallback` decides:
 *   - `user` — assign that person. Assignment is what wires the task into the
 *     assigned inbox, notifications, on-leave skipping, delegation and
 *     escalation, so a fallback naming a person gets all of it.
 *   - `role` — deliberately NULL, i.e. unassigned and claimable by holders of
 *     that role only (`canClaimUnresolvedApproval`). Resolving a role to a
 *     person here would mean picking one, and there is no non-arbitrary pick:
 *     assigning "the only holder" would make the same authored workflow behave
 *     differently the day somebody else is given the role, a flip that is
 *     invisible in the editor and that nobody would predict. The author wrote a
 *     ROLE precisely so routing would not name a person, and the two things
 *     assignment buys are supplied anyway — every active holder is notified
 *     (`recipientsForTask`) and sees the task in their claimable queue. What is
 *     genuinely given up is on-leave skipping and delegation for the holders,
 *     which is the same price a `filter` pool has always paid.
 *
 * The fallback user is NOT status-checked here, exactly as `managerId` isn't:
 * `resolveAssignment` immediately applies on-leave skipping and delegation on
 * top, and second-guessing the author's named approver at this layer would put
 * two different rules on the same column.
 */
async function resolveApprover(
  db: Db,
  node: WorkflowNode,
  ctx: SubjectContext,
): Promise<string | null> {
  if (node.type !== 'approval' && node.type !== 'acknowledge') return null;
  const a = node.approver;
  const fallbackAssignee = () => {
    const fb = approverFallbackOf(node);
    return fb?.kind === 'user' ? fb.userId : null;
  };
  if (a.kind === 'manager') {
    const u = await db.user.findUnique({
      where: { id: ctx.requesterId },
      select: { managerId: true },
    });
    return u?.managerId ?? fallbackAssignee();
  }
  if (a.kind === 'managerChain') {
    return (await resolveManagerChain(db, ctx.requesterId, a.minJobLevelId)) ?? fallbackAssignee();
  }
  return null; // filter → unassigned (claimed by any matching member)
}

/** Candidate-approver facts (keyed by predicate field) plus the bits eligibility
 *  needs that aren't predicate fields. */
type ApproverFacts = SubjectFacts & { deleted: boolean; sortOrder: number | null };

async function approverFacts(db: Db, userId: string): Promise<ApproverFacts | null> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: {
      departmentId: true,
      legalEntityId: true,
      businessUnitId: true,
      employeeStatus: true,
      jobLevelId: true,
      deletedAt: true,
      jobLevel: { select: { sortOrder: true } },
    },
  });
  if (!u) return null;
  return {
    departmentId: u.departmentId,
    legalEntityId: u.legalEntityId,
    businessUnitId: u.businessUnitId,
    employeeStatus: u.employeeStatus,
    jobLevelId: u.jobLevelId,
    userId,
    deleted: u.deletedAt !== null,
    sortOrder: u.jobLevel?.sortOrder ?? null,
  };
}

// ── Request-scoped eligibility context ──────────────────────────────────────

/** The actor facts an AUTHORIZATION question needs, which are not the facts a
 *  predicate needs. Flattened off one row so `holdsRole` and the no-fallback
 *  pool share it. */
type ActorAuthFacts = {
  deleted: boolean;
  active: boolean;
  roleId: string | null;
  roleActive: boolean;
  permissions: readonly string[];
  directReports: number;
};

/**
 * Per-request memo for the actor-keyed and node-keyed reads that `isEligible`
 * and `canClaimUnresolvedApproval` would otherwise repeat once — or twenty
 * times — for every task in an approver's pool.
 *
 * CONSTRUCTED PER REQUEST AND PASSED IN. Never module-scoped, and that is not a
 * style preference: `apps/worker` imports this module and runs for days. A
 * module-level Map here would be an authorization cache with no invalidation
 * path — a directory change, a role edit or a soft-delete would keep answering
 * with the pre-change verdict until the process restarted, across tenants and
 * across users. Every field below is reachable only through a value the caller
 * allocated, so its lifetime ends when the caller's does.
 *
 * `cx` is OPTIONAL at every function that accepts it. Absent, each function
 * issues exactly the queries it always issued; present, it issues them once.
 * Nothing about the ANSWER changes either way — that is what makes the hoist
 * behaviour-preserving by construction rather than by inspection.
 */
export interface ActorEligibilityContext {
  /** The one actor every actor-keyed memo below is keyed to. `scopedTo` refuses
   *  the context if it is handed to a call about somebody else. */
  readonly actorId: string;
  /** Predicate facts — `approverFacts`' select. */
  readonly facts: { promise?: Promise<ApproverFacts | null> };
  /**
   * Authorization facts. A DIFFERENT row from `facts`, deliberately: the
   * `approverFacts` select carries no `roleId`, no `role.active`, no
   * `role.permissions` and no direct-report count, so it cannot stand in for
   * this one however convenient that would be.
   */
  readonly auth: { promise?: Promise<ActorAuthFacts | null> };
  /** The actor's manager chain, walked once rather than once per task. */
  readonly ancestors: { promise?: Promise<ReadonlySet<string>> };
  /**
   * `minJobLevelId` → the sortOrder to compare a candidate against. NODE-keyed,
   * not actor-keyed, which is the point: a pool written against three tiers
   * costs three reads for the whole request instead of three per task. Job
   * levels are global reference data, so this one is not actor-scoped.
   */
  readonly minSortOrders: Map<string, Promise<number>>;
  /** `subjectType:subjectId` → requester (subject owner) id. Seeded in one
   *  batch by `primeRequesterIds`; a miss still falls back to the single read,
   *  so an unseeded caller is correct, merely slower. */
  readonly requesterIds: Map<string, string | null>;
  /**
   * Parsed workflow graphs, keyed however the caller chooses to key them. The
   * engine never reads this. It lives here so the graph memo inherits the actor
   * memo's request lifetime instead of acquiring a lifetime of its own — which
   * is the only kind of memo this package is allowed to have.
   */
  readonly graphs: Map<string, WorkflowGraph | null>;
}

/** Allocate an eligibility context for ONE actor and ONE request. Synchronous
 *  and query-free: it hands out empty memo slots, and each is filled by the
 *  first call that needs it. */
export function buildActorEligibilityContext(actorId: string): ActorEligibilityContext {
  return {
    actorId,
    facts: {},
    auth: {},
    ancestors: {},
    minSortOrders: new Map(),
    requesterIds: new Map(),
    graphs: new Map(),
  };
}

/** The context, but only when it is about this actor. A mismatch means somebody
 *  reused a context across users; answering an authorization question from
 *  another user's cached row is the exact failure this package refuses to have,
 *  so the context is dropped and the call pays for its own reads. */
function scopedTo(
  cx: ActorEligibilityContext | undefined,
  actorId: string,
): ActorEligibilityContext | undefined {
  return cx && cx.actorId === actorId ? cx : undefined;
}

async function loadApproverFacts(
  db: Db,
  actorId: string,
  cx?: ActorEligibilityContext,
): Promise<ApproverFacts | null> {
  const s = scopedTo(cx, actorId);
  if (!s) return approverFacts(db, actorId);
  s.facts.promise ??= approverFacts(db, actorId);
  return s.facts.promise;
}

async function loadActorAuth(
  db: Db,
  actorId: string,
  cx?: ActorEligibilityContext,
): Promise<ActorAuthFacts | null> {
  const read = async (): Promise<ActorAuthFacts | null> => {
    const u = await db.user.findUnique({
      where: { id: actorId },
      select: {
        deletedAt: true,
        employeeStatus: true,
        // VeloExpense: the text role (0004) where ExpenseOS has `roleId` and a `Role` row.
        role: true,
        // Bounds the no-fallback pool — see canClaimUnresolvedFor.
        _count: { select: { directReports: true } },
      },
    });
    if (!u) return null;
    // VeloExpense: a role is the ExpenseOS system role it stands in for (`systemRoleFor`,
    // as the tRPC context applies it), with that role's seeded permissions. System roles
    // are always active. Until the role builder (w4-10).
    const kind = systemRoleFor(u.role as VeloExpenseRole);
    return {
      deleted: u.deletedAt !== null,
      active: u.employeeStatus === 'ACTIVE',
      roleId: SYSTEM_ROLE_IDS[kind],
      roleActive: true,
      permissions: SYSTEM_ROLE_PERMISSIONS[kind],
      directReports: u._count.directReports,
    };
  };
  const s = scopedTo(cx, actorId);
  if (!s) return read();
  s.auth.promise ??= read();
  return s.auth.promise;
}

/** The sortOrder a candidate must reach for a node's `minJobLevelId`. A missing
 *  JobLevel row reads as 0, exactly as the inline lookup this replaces did. */
async function minJobLevelSortOrder(
  db: Db,
  jobLevelId: string,
  cx?: ActorEligibilityContext,
): Promise<number> {
  const read = async () => {
    const min = await db.jobLevel.findUnique({
      where: { id: jobLevelId },
      select: { sortOrder: true },
    });
    return min?.sortOrder ?? 0;
  };
  if (!cx) return read();
  const hit = cx.minSortOrders.get(jobLevelId);
  if (hit) return hit;
  const p = read();
  cx.minSortOrders.set(jobLevelId, p);
  return p;
}

/** Every manager above `actorId`, to `MAX_CHAIN_DEPTH`. Walked once per request
 *  and then answered from memory; a directory cycle terminates on the depth
 *  bound exactly as the step-by-step walk does. */
async function actorAncestors(
  db: Db,
  actorId: string,
  cx: ActorEligibilityContext,
): Promise<ReadonlySet<string>> {
  const read = async () => {
    const out = new Set<string>();
    let cursor: string | null = actorId;
    for (let i = 0; i < MAX_CHAIN_DEPTH && cursor; i += 1) {
      const u: { managerId: string | null } | null = await db.user.findUnique({
        where: { id: cursor },
        select: { managerId: true },
      });
      const mgrId: string | null = u?.managerId ?? null;
      if (!mgrId) break;
      out.add(mgrId);
      cursor = mgrId;
    }
    return out;
  };
  cx.ancestors.promise ??= read();
  return cx.ancestors.promise;
}

function requesterKey(subjectType: ApprovalSubjectType, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

/** `loadRequesterId` for many subjects at once. Extend alongside
 *  `loadRequesterId`; the two must agree on which column owns a subject. */
async function requesterRows(
  db: Db,
  subjectType: ApprovalSubjectType,
  ids: readonly string[],
): Promise<{ id: string; requesterId: string | null }[]> {
  // VeloExpense: no virtual-card subjects (d50).
  if (subjectType === 'EXPENSE_REPORT') {
    const rs = await db.expenseReport.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, submitterId: true },
    });
    return rs.map((r) => ({ id: r.id, requesterId: r.submitterId }));
  }
  if (subjectType === 'TRAVEL_REQUEST') {
    // VeloExpense: no travel table yet.
    throw new Error('approval: travel requests are not available yet');
  }
  throw new Error(`approval: unsupported subjectType ${subjectType}`);
}

/**
 * Fill the context's requester map for a whole pool in ONE query.
 *
 * Only `canClaimUnresolvedFor`'s third case — a relative approver with no
 * authored fallback — ever reads a requester id, so a caller should pass only
 * the subjects of tasks whose node satisfies `claimNeedsRequester`. That set is
 * strictly smaller than "every unassigned task" and exactly sufficient.
 *
 * A subject that no longer exists is recorded as null, which is precisely what
 * the single-row `loadRequesterId` returns for it — so a deleted subject gives
 * the same verdict batched or not.
 */
export async function primeRequesterIds(
  db: Db,
  cx: ActorEligibilityContext,
  subjectType: ApprovalSubjectType,
  subjectIds: readonly string[],
): Promise<void> {
  const wanted = [...new Set(subjectIds)].filter(
    (id) => !cx.requesterIds.has(requesterKey(subjectType, id)),
  );
  if (wanted.length === 0) return;
  for (const id of wanted) cx.requesterIds.set(requesterKey(subjectType, id), null);
  for (const r of await requesterRows(db, subjectType, wanted)) {
    cx.requesterIds.set(requesterKey(subjectType, r.id), r.requesterId);
  }
}

/**
 * A requester id, or a way to get one later.
 *
 * `canDecide` already holds the id and passes it; the inbox path passes a thunk
 * so the read is skipped entirely for the two fallback cases that never look at
 * it. Deferring rather than reordering keeps the three cases in the order they
 * are documented in.
 */
type RequesterRef = string | null | (() => Promise<string | null>);

/** `loadRequesterId`, answered from the context when the batch already has it. */
async function requesterIdFor(
  db: Db,
  subjectType: ApprovalSubjectType,
  subjectId: string,
  cx?: ActorEligibilityContext,
): Promise<string | null> {
  const key = requesterKey(subjectType, subjectId);
  if (cx?.requesterIds.has(key)) return cx.requesterIds.get(key) ?? null;
  const id = await loadRequesterId(db, subjectType, subjectId);
  cx?.requesterIds.set(key, id);
  return id;
}

/**
 * Permission that lets somebody decide an approval for each subject, used ONLY by
 * the unresolved-relative-approver fallback below.
 *
 * Duplicated from `@expenseos/rbac`'s registry as literal strings because this
 * package deliberately does not depend on rbac. A rename there would silently
 * disable the fallback here — so `systemRoles.test.ts` asserts these exact strings
 * still exist, and a rename breaks that test instead of quietly re-stranding
 * everyone with no manager.
 *
 * VeloExpense: this package does read rbac, for the role mapping only (`loadActorAuth`),
 * until roles are rows (w4-10). The literals are kept as ExpenseOS has them.
 */
const APPROVE_PERMISSION: Record<ApprovalSubjectType, string> = {
  EXPENSE_REPORT: 'expense.report.approve',
  TRAVEL_REQUEST: 'travel.request.approve',
};

/** Does this node route to a person RELATIVE to the requester (their manager, or
 *  up their chain) rather than to a pool? */
function isRelativeApprover(node: WorkflowNode | undefined): boolean {
  /**
   * `acknowledge` as well as `approval`, and the omission was not cosmetic.
   *
   * The other two functions that reason about a relative approver — `approverFallbackOf`
   * and `resolveApprover` — both accept either node type. This one gated the claim pool on
   * `approval` alone, so an `acknowledge` node routed to a manager-less person resolved to
   * NOBODY and then admitted nobody: `canClaimUnresolvedFor` returned false for every
   * caller, and the task sat until its TTL expired.
   *
   * That is precisely the silent lapse #224 was raised to remove, still alive in the one
   * node shape nobody checked. An acknowledgement that expires unacknowledged is worse
   * than an approval that does, because nothing about the subject looks wrong afterwards.
   *
   * Widening it here matches what an `approval` node has always done; the alternative —
   * a task no living user may act on — has no defensible reading.
   */
  if (!node || (node.type !== 'approval' && node.type !== 'acknowledge')) return false;
  return node.approver.kind === 'manager' || node.approver.kind === 'managerChain';
}

/** Is `actorId` an ACTIVE holder of `roleId`? The authorization for a `role`
 *  fallback: the author named the role, so membership of it is the right, and
 *  the subject's approve permission is deliberately not also required — an
 *  author who routes to a role that happens not to carry the permission means
 *  what they wrote, and demanding both would strand the task on a technicality
 *  they cannot see from the editor. */
async function holdsRole(
  db: Db,
  actorId: string,
  roleId: string,
  cx?: ActorEligibilityContext,
): Promise<boolean> {
  const u = await loadActorAuth(db, actorId, cx);
  if (!u || u.deleted || !u.active) return false;
  return u.roleId === roleId && u.roleActive;
}

/** Does `requesterId` appear anywhere above `actorId` in the org chart — i.e.
 *  is the candidate approver the requester's own subordinate? Walks the same
 *  bounded chain as `resolveManagerChain`, so a directory cycle terminates. */
async function reportsUpTo(
  db: Db,
  actorId: string,
  requesterId: string,
  cx?: ActorEligibilityContext,
): Promise<boolean> {
  /**
   * With a context the chain is walked ONCE for the request and every later task
   * is a set lookup — this is the read that made the pool loop cost up to 20
   * queries per task. Without one, the original short-circuiting walk is kept
   * verbatim, so `canDecide` and the worker's expiry sweep issue no more queries
   * than they did before. Both forms answer the same question: the walk stops at
   * the first match, the set contains exactly what the walk would have visited.
   */
  const s = scopedTo(cx, actorId);
  if (s) return (await actorAncestors(db, actorId, s)).has(requesterId);
  let cursor: string | null = actorId;
  for (let i = 0; i < MAX_CHAIN_DEPTH && cursor; i += 1) {
    const u: { managerId: string | null } | null = await db.user.findUnique({
      where: { id: cursor },
      select: { managerId: true },
    });
    const mgrId: string | null = u?.managerId ?? null;
    if (!mgrId) return false;
    if (mgrId === requesterId) return true;
    cursor = mgrId;
  }
  return false;
}

/**
 * May `actorId` claim a relative-approver task that resolved to NOBODY?
 *
 * There are now three answers, and which one applies is decided by the node the
 * author wrote — not by a blanket rule.
 *
 * **1. The node names a `user` fallback.** Nobody claims: `resolveApprover`
 * already assigned the task to that person, so the assignee path in `canDecide`
 * is the only way in. A task that is somehow still unassigned under a user
 * fallback is a bug, and widening it to a pool would hide the bug behind a
 * quorum of strangers.
 *
 * **2. The node names a `role` fallback.** Holders of THAT role, and nobody
 * else. This is the whole point of the feature: "the CEO's approvals go to
 * Finance" has to mean Finance, not "Finance, plus anyone who happens to hold
 * the approve permission". If the role has no active holders the task strands
 * and lapses on its TTL — loud, and traceable to an authoring decision — which
 * is the correct outcome when the named approver pool is empty. Silently
 * reopening the permission pool there would make the fallback advisory.
 *
 * **3. The node names no fallback.** The legacy pool, retained because the
 * alternative is worse, and NARROWED. The behaviour it replaced was measured: a
 * `manager` node whose requester has no manager produced a task with
 * `assigneeUserId = null`; `isEligible` returns false for non-filter kinds, so
 * NOBODY could act — not the submitter, not even a system administrator — the
 * task appeared in no queue, and five business days later the TTL sweep
 * auto-REJECTED the claim. The employee was told their expense was declined, by
 * nobody, for a gap in the HR feed. On dev that is 80 of 703 active users (11%),
 * so closing this path outright would re-strand a ninth of the company.
 *
 * The narrowing is the requester's own SUBORDINATES. `canDecide` already blocks
 * the requester from approving themselves; it did not block the people who
 * report to them. A manager-less requester is by definition senior, so the pool
 * of "anyone with the approve permission" included their own staff — someone
 * whose job the submitter controls signing off on the submitter's spend, which
 * is the self-approval failure one hop removed and no more acceptable for being
 * indirect. Excluding them cannot strand anyone who was not already stranded:
 * an approver who does not report to the requester is unaffected.
 *
 * What this does NOT do is narrow the pool to something org-relative (same
 * legal entity, at-or-above the requester's job level). Every such rule is
 * empty for exactly the person this exists for — nobody outranks the CEO — so
 * it would restore the auto-reject under a more respectable name. The real
 * close for a governed workflow is to author a fallback, which the seeded
 * expense workflow now does; case 3 is what an ungoverned node still gets.
 *
 * ONLY for an unassigned task. The caller must have established that; widening it
 * to assigned tasks would let any approver decide a task parked on a specific
 * manager, which is a privilege escalation rather than a fallback.
 */
async function canClaimUnresolvedFor(
  db: Db,
  node: WorkflowNode | undefined,
  subjectType: ApprovalSubjectType,
  requester: RequesterRef,
  actorId: string,
  cx?: ActorEligibilityContext,
): Promise<boolean> {
  if (!isRelativeApprover(node)) return false;
  const fallback = approverFallbackOf(node);
  if (fallback?.kind === 'user') return false;
  if (fallback?.kind === 'role') return holdsRole(db, actorId, fallback.roleId, cx);

  /**
   * EVERY GATE BELOW BELONGS TO CASE 3 AND ONLY TO CASE 3.
   *
   * The two returns above are decided before any of it, and hoisting these
   * checks to the top as a "the actor fails the gates, so nothing is claimable"
   * fast path would be wrong in a way that is invisible from here: a `role`
   * fallback authorizes on MEMBERSHIP of the named role and deliberately does
   * not require the approve permission or a direct report, so such a fast path
   * would strand every role-fallback task in the system while looking like a
   * pure optimization. The memoization below is per-READ, never per-branch.
   */
  const required = APPROVE_PERMISSION[subjectType];
  if (!required) return false;
  const u = await loadActorAuth(db, actorId, cx);
  if (!u || u.deleted || !u.active) return false;
  if (!u.roleActive) return false;
  if (!u.permissions.includes(required)) return false;
  /**
   * The claimant must actually BE somebody's manager.
   *
   * This pool is the fallback for a task whose relative approver could not be resolved —
   * the requester has no manager on file — and until the manager and employee roles were
   * folded together, the approve permission was itself the bound: only the handful of
   * people holding the Manager role could claim. Folding gave every employee the
   * permission (the engine, not the role, is what authorizes a decision), which would have
   * silently widened this pool from "any line manager" to "anybody at all". On the seeded
   * directory that is the difference between 135 people and 907.
   *
   * Having at least one direct report is the honest test of the thing the role was
   * standing in for, and it is the definition the fold was built on: a manager is an
   * employee with reports. Somebody who reports up to the requester is still excluded
   * below — a subordinate must not authorize their own chain.
   */
  if (u.directReports === 0) return false;
  const requesterId = typeof requester === 'function' ? await requester() : requester;
  if (requesterId && (await reportsUpTo(db, actorId, requesterId, cx))) return false;
  return true;
}

/** `canClaimUnresolvedFor`, resolving the requester from the subject. The form
 *  callers outside the engine use — the inbox needs the same verdict the decide
 *  path will give, or it lists rows that 403 when opened. */
export async function canClaimUnresolvedApproval(
  db: Db,
  node: WorkflowNode | undefined,
  subjectType: ApprovalSubjectType,
  subjectId: string,
  actorId: string,
  cx?: ActorEligibilityContext,
): Promise<boolean> {
  if (!isRelativeApprover(node)) return false; // skip the subject load entirely
  /**
   * The requester read is deferred behind a thunk rather than issued here. Only
   * case 3 consults it, so a `user`- or `role`-fallback node now resolves
   * without touching the subject at all — and a batch caller can prefetch the
   * strictly smaller set of subjects that `claimNeedsRequester` names, instead
   * of every unassigned subject in the pool. The case ORDER is untouched.
   */
  return canClaimUnresolvedFor(
    db,
    node,
    subjectType,
    () => requesterIdFor(db, subjectType, subjectId, cx),
    actorId,
    cx,
  );
}

/** Will deciding a claim on this node need the subject's requester id? True only
 *  for case 3 above — a relative approver with no authored fallback. The one
 *  place that rule is written down, so a batch prefetch cannot drift from what
 *  `canClaimUnresolvedFor` actually asks for. */
export function claimNeedsRequester(node: WorkflowNode | undefined): boolean {
  return isRelativeApprover(node) && approverFallbackOf(node) === undefined;
}

/** Is `actorId` eligible to claim/decide a `filter`-approver task — active,
 *  at/above the optional min level, and matching the filter? Relative-approver
 *  tasks are assignee-gated, so they return false here. */
export async function isEligible(
  db: Db,
  node: WorkflowNode,
  actorId: string,
  cx?: ActorEligibilityContext,
): Promise<boolean> {
  if (node.type !== 'approval' || node.approver.kind !== 'filter') return false;
  const a = node.approver;
  const f = await loadApproverFacts(db, actorId, cx);
  if (!f || f.deleted) return false;
  if (a.minJobLevelId) {
    // The job-level read is NODE-keyed, not actor-keyed. Memoizing only the
    // actor row would leave one query per task standing on any tiered pool,
    // which is not "zero".
    const min = await minJobLevelSortOrder(db, a.minJobLevelId, cx);
    if ((f.sortOrder ?? Number.NEGATIVE_INFINITY) < min) return false;
  }
  return evaluatePredicate(a.match, f);
}

/**
 * Authorize a decision: an admin, the resolved assignee, or — for an unassigned
 * filter-approver task — any matching active user. Never the requester.
 *
 * THE REQUESTER CHECK RUNS FIRST, and that ordering is the whole point. It used to sit
 * thirty lines below `if (isAdmin) return true`, which made it unreachable for exactly
 * the people it most needed to stop: a System Administrator submitted a report, opened
 * it, and was offered Approve — which succeeded and was recorded as a real approval —
 * while the workflow assigned the decision to their direct manager and their own
 * approvals inbox showed nothing to do (GA readiness report F15 / F20, blocker B3). A
 * privileged user approving their own expenses outside the assigned route is a standard
 * SOX audit exception.
 *
 * The admin override is kept for everyone ELSE's subjects, because it is load-bearing:
 * it is how a stuck queue gets unwedged. What is removed is the ability to use it on
 * your own.
 *
 * KNOWN CONSEQUENCE, recorded rather than discovered later: a subject whose only
 * possible approver is also its requester — the person at the top of the chain, or a
 * one-admin org — can no longer be decided by that person at all. It parks until
 * somebody else decides it. That is the accepted cost of the hard block; a break-glass
 * override with an audited reason was considered and deliberately not taken.
 */
export async function canDecide(
  db: Db,
  taskId: string,
  actorId: string,
  isAdmin: boolean,
): Promise<boolean> {
  const task = await db.approvalTask.findUnique({
    where: { id: taskId },
    select: {
      assigneeUserId: true,
      nodeId: true,
      instance: {
        select: {
          subjectType: true,
          subjectId: true,
          effectiveGraph: true,
          workflowVersion: { select: { graph: true } },
        },
      },
    },
  });
  if (!task) return false;
  // VeloExpense: `subject_type` is text under a CHECK (0058), not a Prisma enum.
  const subjectType = task.instance.subjectType as ApprovalSubjectType;
  /**
   * Self-approval block, ahead of EVERY grant below — admin, assignee, delegatee and
   * the filter-approver fallthrough alike.
   *
   * Ahead of the assignee path too, not only the pool: a workflow that resolves the
   * approver relative to the requester can legitimately land the task on the requester
   * themselves (their own manager, a same-job-level pool), and "the graph named me"
   * is not a reason to let somebody sign off their own money.
   */
  const requesterId = await loadRequesterId(db, subjectType, task.instance.subjectId);
  if (requesterId && requesterId === actorId) return false;
  if (isAdmin) return true;
  if (task.assigneeUserId === actorId) return true;
  // A delegatee may also decide tasks still assigned to a delegator with an
  // active in-scope delegation (covers tasks parked before the delegation, or
  // when the assignee went on leave after assignment).
  if (
    task.assigneeUserId &&
    (await activeDelegateeFor(db, task.assigneeUserId, subjectType)) === actorId
  ) {
    return true;
  }
  const graph = graphSchema.parse(
    task.instance.effectiveGraph ?? task.instance.workflowVersion.graph,
  );
  const node = graph.nodes.find((n) => n.id === task.nodeId);
  if (!node) return false;
  if (await isEligible(db, node, actorId)) return true;
  // A relative-approver task that resolved to nobody: claimable by whoever the
  // node's fallback names, or — with no fallback — by the subject's approver
  // pool minus the requester's own reports. Gated on `assigneeUserId === null`
  // — never widen this to an assigned task. `requesterId` is already loaded
  // above for the self-approval block, so the narrowing costs no extra query.
  if (task.assigneeUserId === null) {
    return canClaimUnresolvedFor(db, node, subjectType, requesterId, actorId);
  }
  return false;
}

function nodeLabel(node: WorkflowNode): string {
  return node.type;
}

// ── Task materialization ────────────────────────────────────────────────────

async function createTasksForNodes(
  db: Db,
  instanceId: string,
  graph: WorkflowGraph,
  nodeIds: string[],
  ctx: SubjectContext,
): Promise<string[]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const created: string[] = [];
  for (const nodeId of nodeIds) {
    const node = byId.get(nodeId);
    if (!node) continue;
    // Redirect for absence (ON_LEAVE) + active delegation at assignment time.
    const assigneeUserId = await resolveAssignment(
      db,
      await resolveApprover(db, node, ctx),
      ctx.subjectType,
    );
    // Stamp the deadline from the node's TTL (default applies when unset). Only
    // approval nodes park as human tasks, so all created tasks get one.
    //
    // VeloExpense (d56): a node with no TTL has NO deadline. ExpenseOS applies
    // DEFAULT_TTL_BUSINESS_DAYS, so every task expires and escalates; VeloExpense's default
    // flow is "the manager approves, and nothing happens on its own", and a deadline is
    // something an admin sets on a step in the builder. The escalation path below still
    // re-stamps an expired task from its node's TTL.
    const ttl = node.type === 'approval' ? (node.ttlBusinessDays ?? null) : null;
    const task = await db.approvalTask.create({
      data: {
        instanceId,
        nodeId,
        assigneeUserId,
        label: nodeLabel(node),
        status: 'PENDING',
        expiresAt: ttl != null ? addBusinessDays(new Date(), ttl) : null,
      },
      select: { id: true },
    });
    created.push(task.id);
  }
  return created;
}

/** Apply an advance() result's task effects: create newly-parked tasks; cancel
 *  tasks the engine skipped (a join fired and its siblings are moot). */
async function applyTaskEffects(
  db: Db,
  instanceId: string,
  graph: WorkflowGraph,
  result: AdvanceResult,
  ctx: SubjectContext,
): Promise<string[]> {
  const created = await createTasksForNodes(db, instanceId, graph, result.createTasks, ctx);
  if (result.skipTasks.length > 0) {
    await db.approvalTask.updateMany({
      where: { instanceId, nodeId: { in: result.skipTasks }, status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });
  }
  return created;
}

// ── Public API ──────────────────────────────────────────────────────────────

// Budget actuals. Re-exported from here rather than from index.ts because these
// take a Prisma client, and index.ts is the browser-safe surface.
//
// VeloExpense (w4-04): `./budgets` is VeloExpense's bridge (see its header), so only the
// evaluation and its impact type: ExpenseOS's `computeActuals`, `BudgetScope` and
// `PeriodActuals` belong to ExpenseOS's budget tables, which VeloExpense does not have.
export {
  type BudgetImpact,
  evaluateReportAgainstBudgets,
  type ReportBudgetEvaluation,
} from './budgets';

export interface StartResult {
  instanceId: string | null;
  status: 'RUNNING' | 'APPROVED' | 'REJECTED' | 'NO_WORKFLOW';
  createdTaskIds: string[];
  /** Pass-through effect nodes (notify / action) fired during the initial run;
   *  the caller executes them (see server/lib/workflowEffects). */
  firedEffects: string[];
}

/** Select + instantiate a workflow for a subject and run it to its first
 *  parked tasks (or completion). Returns NO_WORKFLOW when nothing matches. */
export async function startInstance(
  db: Db,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): Promise<StartResult> {
  const ctx = await loadSubject(db, subjectType, subjectId);
  const selected = await selectWorkflowVersion(db, subjectType, ctx.facts);
  if (!selected)
    return { instanceId: null, status: 'NO_WORKFLOW', createdTaskIds: [], firedEffects: [] };

  // Inline CallWorkflow sub-flows now, so the instance runs a frozen flat graph
  // that re-publishing a called workflow can't change mid-flight.
  const callables = await publishedGraphsByKey(db, subjectType);
  const graph = inlineCallWorkflows(selected.graph, callables);

  const initial = createInitialState(graph);
  const result = advance(graph, initial, ctx.facts, new Set());

  const instance = await db.approvalInstance.create({
    data: {
      workflowVersionId: selected.versionId,
      subjectType,
      subjectId,
      status: result.status === 'RUNNING' ? 'RUNNING' : result.status,
      cursor: result.state as unknown as Prisma.InputJsonValue,
      effectiveGraph: graph as unknown as Prisma.InputJsonValue,
      completedAt: result.status === 'RUNNING' ? null : new Date(),
    },
    select: { id: true },
  });

  const createdTaskIds = await applyTaskEffects(db, instance.id, graph, result, ctx);

  if (result.status !== 'RUNNING') {
    await applyTerminal(db, subjectType, subjectId, result.status, null);
  }
  return {
    instanceId: instance.id,
    status: result.status,
    createdTaskIds,
    firedEffects: result.firedEffects,
  };
}

export interface DecideResult {
  status: 'RUNNING' | 'APPROVED' | 'REJECTED';
  createdTaskIds: string[];
  subjectId: string;
  /** The instance's subject type — lets the caller (decideAndNotify) fan out
   *  activity/notifications for the right subject without a re-query. */
  subjectType: ApprovalSubjectType;
  /** Pass-through effect nodes fired while resuming after the decision. */
  firedEffects: string[];
}

/** Record a decision on a task and resume (or terminate) the instance. The
 *  caller must have already authorized `actorId` against the task. */
export async function decideTask(
  db: Db,
  taskId: string,
  approve: boolean,
  actorId: string,
  note: string | null,
): Promise<DecideResult> {
  const task = await db.approvalTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      nodeId: true,
      status: true,
      instance: {
        select: {
          id: true,
          status: true,
          cursor: true,
          subjectType: true,
          subjectId: true,
          effectiveGraph: true,
          workflowVersion: { select: { graph: true } },
        },
      },
    },
  });
  if (!task) throw new Error('approval: task not found');
  if (task.status !== 'PENDING') throw new Error('approval: task already decided');
  // VeloExpense: `subject_type` is text under a CHECK (0058), not a Prisma enum.
  const inst = { ...task.instance, subjectType: task.instance.subjectType as ApprovalSubjectType };
  if (inst.status !== 'RUNNING') throw new Error('approval: instance is not running');

  // An Acknowledge node has a single outcome — it can't be rejected (there's no
  // reject exit; a reject would wrongly fail the instance). Guard here so it
  // holds for every decision surface, not just the UI.
  if (!approve) {
    const preGraph = graphSchema.parse(inst.effectiveGraph ?? inst.workflowVersion.graph);
    if (preGraph.nodes.find((n) => n.id === task.nodeId)?.type === 'acknowledge') {
      throw new Error('approval: acknowledgment tasks cannot be rejected');
    }
  }

  // Atomic claim: the conditional write (status: PENDING in the WHERE) is the
  // real guard against a double-decide (double-click, or assignee + admin
  // racing the same task). The read-check above is only a fast-fail — without
  // this, two concurrent decisions could both pass it and both advance the
  // instance, duplicating downstream tasks and clobbering the final status.
  const claimed = await db.approvalTask.updateMany({
    where: { id: task.id, status: 'PENDING' },
    data: {
      status: approve ? 'APPROVED' : 'REJECTED',
      decidedById: actorId,
      decidedAt: new Date(),
      note,
    },
  });
  if (claimed.count !== 1) throw new Error('approval: task already decided');

  const graph = graphSchema.parse(inst.effectiveGraph ?? inst.workflowVersion.graph);
  const ctx = await loadSubject(db, inst.subjectType, inst.subjectId);

  // Move the token for the decision. Approve follows the `approve` exit; reject
  // either routes down a wired `reject` exit (→ RUNNING) or applies the default
  // rejection — which fails the whole instance unless it's a tolerated parallel
  // branch failure.
  let moved: EngineState;
  if (approve) {
    moved = applyApproval(graph, inst.cursor as unknown as EngineState, task.nodeId);
  } else {
    const rej = applyRejection(graph, inst.cursor as unknown as EngineState, task.nodeId);
    if (rej.status === 'REJECTED') {
      await db.approvalTask.updateMany({
        where: { instanceId: inst.id, status: 'PENDING' },
        data: { status: 'SKIPPED' },
      });
      await db.approvalInstance.update({
        where: { id: inst.id },
        data: {
          status: 'REJECTED',
          cursor: rej.state as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      await applyTerminal(db, inst.subjectType, inst.subjectId, 'REJECTED', actorId);
      return {
        status: 'REJECTED',
        createdTaskIds: [],
        subjectId: inst.subjectId,
        subjectType: inst.subjectType,
        firedEffects: [],
      };
    }
    moved = rej.state;
  }

  // Resume the walk (a routed reject or tolerated branch failure may have
  // parked a new task, fired a join, or completed the instance).
  const stillOpen = await db.approvalTask.findMany({
    where: { instanceId: inst.id, status: 'PENDING' },
    select: { nodeId: true },
  });
  const result = advance(graph, moved, ctx.facts, new Set(stillOpen.map((t) => t.nodeId)));

  await db.approvalInstance.update({
    where: { id: inst.id },
    data: {
      status: result.status === 'RUNNING' ? 'RUNNING' : result.status,
      cursor: result.state as unknown as Prisma.InputJsonValue,
      completedAt: result.status === 'RUNNING' ? null : new Date(),
    },
  });
  const createdTaskIds = await applyTaskEffects(db, inst.id, graph, result, ctx);

  if (result.status !== 'RUNNING') {
    await applyTerminal(db, inst.subjectType, inst.subjectId, result.status, actorId);
  }
  return {
    status: result.status,
    createdTaskIds,
    subjectId: inst.subjectId,
    subjectType: inst.subjectType,
    firedEffects: result.firedEffects,
  };
}

// ── Expiry & escalation ─────────────────────────────────────────────────────

export interface ExpireResult {
  outcome: 'ESCALATED' | 'APPROVED' | 'REJECTED' | 'SKIPPED';
  subjectType: ApprovalSubjectType;
  subjectId: string;
  /** Set on ESCALATED — the manager the task moved up to. */
  reassignedTo?: string | null;
}

/** The direct manager of `userId`, or null at the top of the chain. */
async function managerOf(db: Db, userId: string): Promise<string | null> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { managerId: true } });
  return u?.managerId ?? null;
}

/** A lapsed approval node's effective onExpire policy. Explicit wins; otherwise
 *  manager-based approvals ESCALATE up the chain (auto-rejecting at the top),
 *  and everything else (filter pools, non-approval) REJECTs — never a silent
 *  auto-approve. */
export function defaultOnExpire(node: WorkflowNode | undefined): 'REJECT' | 'APPROVE' | 'ESCALATE' {
  if (!node || node.type !== 'approval') return 'REJECT';
  if (node.onExpire) return node.onExpire;
  return node.approver.kind === 'manager' || node.approver.kind === 'managerChain'
    ? 'ESCALATE'
    : 'REJECT';
}

/** Apply a lapsed task's `onExpire` policy. ESCALATE reassigns one manager up
 *  the chain (fresh TTL), auto-rejecting at the top; REJECT/APPROVE route the
 *  instance exactly like a human decision (reusing the same interpreter), but
 *  mark the task EXPIRED and record no human decider. Mirrors decideTask. */
export async function expireTask(db: Db, taskId: string): Promise<ExpireResult> {
  const task = await db.approvalTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      nodeId: true,
      status: true,
      assigneeUserId: true,
      escalationLevel: true,
      instance: {
        select: {
          id: true,
          status: true,
          cursor: true,
          subjectType: true,
          subjectId: true,
          effectiveGraph: true,
          workflowVersion: { select: { graph: true } },
        },
      },
    },
  });
  // VeloExpense: `subject_type` is text under a CHECK (0058), not a Prisma enum.
  const inst = task?.instance
    ? { ...task.instance, subjectType: task.instance.subjectType as ApprovalSubjectType }
    : undefined;
  if (!task || !inst || task.status !== 'PENDING' || inst.status !== 'RUNNING') {
    return {
      outcome: 'SKIPPED',
      // VeloExpense: ExpenseOS's placeholder is VIRTUAL_CARD_REQUEST, which is not a subject here.
      subjectType: inst?.subjectType ?? 'EXPENSE_REPORT',
      subjectId: inst?.subjectId ?? '',
    };
  }
  const graph = graphSchema.parse(inst.effectiveGraph ?? inst.workflowVersion.graph);
  const node = graph.nodes.find((n) => n.id === task.nodeId);
  const onExpire = defaultOnExpire(node);

  /**
   * ESCALATE: hand the still-open task one level up.
   *
   * Normally that is the CURRENT assignee's manager — one above whoever let it
   * lapse, not the requester's, so the first lapse moves past the assignee rather
   * than re-targeting them. The token stays parked (no cursor change). At the top
   * of the chain, or past the depth cap, it falls through to reject.
   *
   * An UNASSIGNED task escalates from the REQUESTER instead. It used to require a
   * truthy assignee and so fell straight through to REJECT — which conflated "your
   * approver ignored this" with "we never found you an approver", and punished the
   * claimant for the second. That is the no-manager case and the filter-pool case:
   * both legitimately park a task with no assignee. Starting from the requester is
   * the only chain available, and it is the right one — it is whose approval was
   * being sought.
   */
  const escalateFrom =
    task.assigneeUserId ?? (await loadRequesterId(db, inst.subjectType, inst.subjectId));
  if (onExpire === 'ESCALATE' && escalateFrom && task.escalationLevel < MAX_CHAIN_DEPTH) {
    const nextMgr = await managerOf(db, escalateFrom);
    // Route the escalation target through resolveAssignment (skip ON_LEAVE/
    // terminated/deleted + honor active delegation), mirroring initial
    // assignment — otherwise escalation can park a fresh-TTL task on a manager
    // who is on leave, terminated, or deleted.
    const reassignTo = nextMgr ? await resolveAssignment(db, nextMgr, inst.subjectType) : null;
    if (reassignTo) {
      const ttl =
        node?.type === 'approval'
          ? (node.ttlBusinessDays ?? DEFAULT_TTL_BUSINESS_DAYS)
          : DEFAULT_TTL_BUSINESS_DAYS;
      const claimed = await db.approvalTask.updateMany({
        where: { id: task.id, status: 'PENDING' },
        data: {
          assigneeUserId: reassignTo,
          escalationLevel: task.escalationLevel + 1,
          expiresAt: addBusinessDays(new Date(), ttl),
        },
      });
      if (claimed.count !== 1) {
        return { outcome: 'SKIPPED', subjectType: inst.subjectType, subjectId: inst.subjectId };
      }
      return {
        outcome: 'ESCALATED',
        subjectType: inst.subjectType,
        subjectId: inst.subjectId,
        reassignedTo: reassignTo,
      };
    }
    // No manager above → auto-reject (handled below).
  }

  // Claim the task as EXPIRED (the conditional write guards against a race with
  // a real decision), then route the instance per APPROVE/REJECT.
  const claimed = await db.approvalTask.updateMany({
    where: { id: task.id, status: 'PENDING' },
    data: { status: 'EXPIRED', decidedAt: new Date(), note: 'expired' },
  });
  if (claimed.count !== 1) {
    return { outcome: 'SKIPPED', subjectType: inst.subjectType, subjectId: inst.subjectId };
  }

  const ctx = await loadSubject(db, inst.subjectType, inst.subjectId);
  const approve = onExpire === 'APPROVE';
  let moved: EngineState;
  if (approve) {
    moved = applyApproval(graph, inst.cursor as unknown as EngineState, task.nodeId);
  } else {
    const rej = applyRejection(graph, inst.cursor as unknown as EngineState, task.nodeId);
    if (rej.status === 'REJECTED') {
      await db.approvalTask.updateMany({
        where: { instanceId: inst.id, status: 'PENDING' },
        data: { status: 'SKIPPED' },
      });
      await db.approvalInstance.update({
        where: { id: inst.id },
        data: {
          status: 'REJECTED',
          cursor: rej.state as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      await applyTerminal(db, inst.subjectType, inst.subjectId, 'REJECTED', null);
      return { outcome: 'REJECTED', subjectType: inst.subjectType, subjectId: inst.subjectId };
    }
    moved = rej.state;
  }

  const stillOpen = await db.approvalTask.findMany({
    where: { instanceId: inst.id, status: 'PENDING' },
    select: { nodeId: true },
  });
  const result = advance(graph, moved, ctx.facts, new Set(stillOpen.map((t) => t.nodeId)));
  await db.approvalInstance.update({
    where: { id: inst.id },
    data: {
      status: result.status === 'RUNNING' ? 'RUNNING' : result.status,
      cursor: result.state as unknown as Prisma.InputJsonValue,
      completedAt: result.status === 'RUNNING' ? null : new Date(),
    },
  });
  await applyTaskEffects(db, inst.id, graph, result, ctx);
  if (result.status !== 'RUNNING') {
    await applyTerminal(db, inst.subjectType, inst.subjectId, result.status, null);
  }
  return {
    outcome: result.status === 'APPROVED' ? 'APPROVED' : 'REJECTED',
    subjectType: inst.subjectType,
    subjectId: inst.subjectId,
  };
}

/** Find PENDING tasks past their deadline (on RUNNING instances) and expire
 *  each per its node's policy. Returns the per-task outcomes so a caller can
 *  fan out notifications. Bounded per run.
 *
 *  VeloExpense: `onExpired` runs for each task's outcome INSIDE that task's savepoint, so
 *  what VeloExpense writes on an outcome (the report's budgets, history, ledger post and
 *  audit row, `recordReportOutcome`) commits or rolls back with the expiry itself. ExpenseOS
 *  posts afterwards and lets a half-hourly sweep catch a dropped post; VeloExpense has no
 *  such sweep. */
export async function sweepExpiredTasks(
  db: Db,
  now: Date = new Date(),
  onExpired?: (result: ExpireResult) => Promise<void>,
): Promise<ExpireResult[]> {
  const due = await db.approvalTask.findMany({
    where: {
      status: 'PENDING',
      expiresAt: { not: null, lte: now },
      instance: { status: 'RUNNING' },
    },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: 500,
  });
  const out: ExpireResult[] = [];
  for (const t of due) {
    try {
      // Each task expires atomically: the EXPIRED claim, instance advance, task
      // effects, and terminal subject write must commit or roll back together,
      // otherwise a mid-sequence failure leaves a stuck RUNNING instance with no
      // PENDING task. The try/catch stays OUTSIDE the transaction so one task's
      // failure doesn't abort the rest of the sweep. (`db` is the worker's raw
      // PrismaClient; the in-tx branch supports a caller that already wrapped.)
      //
      // VeloExpense: the sweep runs inside one tenant's transaction (RLS), where a nested
      // `$transaction` is the same transaction and one failed statement aborts it for every
      // later task. A savepoint per task gives back both halves of ExpenseOS's rule: each
      // task commits or rolls back whole, and one task's failure leaves the rest running.
      await db.$executeRaw`SAVEPOINT approval_expire_task`;
      try {
        const result = await expireTask(db, t.id);
        if (onExpired && result.outcome !== 'SKIPPED') await onExpired(result);
        await db.$executeRaw`RELEASE SAVEPOINT approval_expire_task`;
        out.push(result);
      } catch (err) {
        await db.$executeRaw`ROLLBACK TO SAVEPOINT approval_expire_task`;
        throw err;
      }
    } catch (err) {
      console.warn('[approval] expireTask failed', t.id, err);
    }
  }
  return out;
}

// ── Simulation (dry-run, no writes) ─────────────────────────────────────────

export interface SimStep {
  nodeId: string;
  type: string;
  /**
   * WHO this step routes to, for a node that has an approver.
   *
   * Without it the simulator answered "1. Approval" and stopped, which is why a
   * correctly tiered workflow was read as having no tiers at all: the seeded expense
   * graph routes by amount to ONE approver of the appropriate seniority — manager under
   * $5k, Director under $25k, VP under $100k, C-level above — so a single step is the
   * designed output, and the tier is the entire difference between them. An auditor
   * running it at 500,000 saw the same one-line answer they would have seen at 50, and
   * reasonably concluded the graph had no switch in it (GA readiness report F42).
   *
   * `minJobLevelCode` is the job level's short code (`E4`, `M5`) rather than its label,
   * because this package does not localize.
   */
  approver?: {
    kind: 'manager' | 'managerChain' | 'filter';
    minJobLevelCode?: string | null;
  };
}
export interface SimResult {
  workflowName: string | null;
  workflowKey: string | null;
  status: 'RUNNING' | 'APPROVED' | 'REJECTED';
  steps: SimStep[];
}

/** Dry-run the matching workflow against hypothetical facts, auto-approving
 *  every task, to show which workflow applies + the approval steps it would
 *  require. No DB writes. (Assumes everyone approves — for any/quorum it lists
 *  all candidate steps.) */
export async function simulateWorkflow(
  db: Db,
  subjectType: ApprovalSubjectType,
  facts: SubjectFacts,
): Promise<SimResult> {
  const selected = await selectWorkflowVersion(db, subjectType, facts);
  if (!selected) return { workflowName: null, workflowKey: null, status: 'RUNNING', steps: [] };
  const ver = await db.approvalWorkflowVersion.findUnique({
    where: { id: selected.versionId },
    select: { workflow: { select: { name: true, key: true } } },
  });
  const graph = selected.graph;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  let r = advance(graph, createInitialState(graph), facts, new Set());
  const steps: SimStep[] = [];
  const open = new Set<string>(r.createTasks);
  let guard = 0;
  while (r.status === 'RUNNING' && guard++ < 500) {
    const toApprove = [...open];
    if (toApprove.length === 0) break;
    for (const nodeId of toApprove) steps.push({ nodeId, type: byId.get(nodeId)?.type ?? '?' });
    let s = r.state;
    for (const nodeId of toApprove) {
      s = applyApproval(graph, s, nodeId);
      open.delete(nodeId);
    }
    r = advance(graph, s, facts, open);
    for (const c of r.createTasks) open.add(c);
    for (const sk of r.skipTasks) open.delete(sk);
  }
  // Decorate each step with WHO it routes to. One query for every job level the walked
  // steps reference, rather than one per step.
  const approverOf = (nodeId: string) => {
    const node = byId.get(nodeId);
    return node && 'approver' in node ? node.approver : undefined;
  };
  const levelIds = [
    ...new Set(
      steps
        .map((s) => approverOf(s.nodeId))
        .map((a) => (a && 'minJobLevelId' in a ? a.minJobLevelId : null))
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const levelCodes = new Map(
    levelIds.length
      ? (
          await db.jobLevel.findMany({
            where: { id: { in: levelIds } },
            select: { id: true, code: true },
          })
        ).map((l) => [l.id, l.code])
      : [],
  );

  return {
    workflowName: ver?.workflow.name ?? null,
    workflowKey: ver?.workflow.key ?? null,
    status: r.status,
    steps: steps.map((s) => {
      const a = approverOf(s.nodeId);
      if (!a) return s;
      const minJobLevelId = 'minJobLevelId' in a ? a.minJobLevelId : null;
      return {
        ...s,
        approver: {
          kind: a.kind,
          minJobLevelCode: minJobLevelId ? (levelCodes.get(minJobLevelId) ?? null) : null,
        },
      };
    }),
  };
}
