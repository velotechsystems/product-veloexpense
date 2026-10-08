/**
 * VX2-2 — the tiered resolver and the decision-time guard, against a real
 * Postgres.
 *
 * Own org slug ('routing-co') because the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * TWO rules shape this file, both learned from ExpenseOS's post-mortems rather
 * than invented:
 *
 *  1. EVERY guard is exercised twice — once as an ordinary user and once with
 *     the caller's ADMIN role set. ExpenseOS's self-approval rule was tested
 *     only with `isAdmin: false` while `canDecide` opened with
 *     `if (isAdmin) return true`, so the rule was never reachable for the people
 *     best able to break it, and a System Administrator approving their own
 *     expenses shipped to production (their F15 / F20, blocker B3).
 *  2. Every positive is paired with a NEGATIVE. "The assignee can decide it"
 *     passes just as happily on a build where EVERYONE can decide it, so on its
 *     own it asserts nothing; what gives it meaning is an unrelated user being
 *     refused alongside it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as expenses from '@/lib/expenses/service';
import { tieredRouter } from '@/lib/approvals/resolver';
import { RoutingError, type RoutingSubject } from '@/lib/approvals/routing';
import { canDecide, assertCanDecide, DecisionForbiddenError } from '@/lib/approvals/eligibility';
import { IMPLICIT_STEP, type StepPlan } from '@/lib/approvals/tiers';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

/**
 * Fail with a sentence, not with pg's default-connection error.
 *
 * With neither variable set, `pg` falls back to your OS username for both the
 * user AND the database, so the suite dies with `database "<your-username>" does
 * not exist` on the default socket — which reads as a broken or missing Postgres
 * rather than a missing export, and sends you looking in the wrong place. Every
 * `*.db.test.ts` here has the same footgun; this is the one that says so.
 *
 * The two export lines are in HANDOFF.md's local-setup block. They are not in
 * .env.local on purpose: ADMIN_DATABASE_URL is a superuser, and the app must
 * never be able to read it.
 */
const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error(
    'routing.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL) in the environment. ' +
      'See the local-setup block in HANDOFF.md for the two export lines.',
  );
}

const admin = new Pool({ connectionString: ADMIN_URL });

let orgId: string;
let categoryId: string;
let seq = 0;

/* ── fixtures ──────────────────────────────────────────────────────────────── */

interface UserOpts {
  role?: 'EMPLOYEE' | 'MANAGER' | 'ADMIN';
  managerId?: string | null;
  status?: 'ACTIVE' | 'ON_LEAVE' | 'DEACTIVATED';
  deleted?: boolean;
}

/** A fresh employee with a unique email — the suite TRUNCATEs once, not per test. */
async function mkUser(tag: string, opts: UserOpts = {}): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `${tag}-${seq}@routing.test`;
  return withOrg(orgId, async (tx) => {
    const r = await tx.query(
      `INSERT INTO app_user
         (organization_id, email, display_name, role, employee_status, manager_id, deleted_at)
       VALUES (current_setting('app.current_org', true)::uuid, $1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        email,
        tag,
        opts.role ?? 'EMPLOYEE',
        opts.status ?? 'ACTIVE',
        opts.managerId ?? null,
        opts.deleted ? new Date() : null,
      ],
    );
    return { id: r.rows[0].id as string, email };
  });
}

/** The break-glass flag, per tenant (0009). */
async function setBreakGlass(allowed: boolean) {
  await admin.query('UPDATE organization SET allow_sole_approver_self_approval = $2 WHERE id = $1', [
    orgId,
    allowed,
  ]);
}

function subjectFor(submitterId: string, onDate = new Date('2026-06-15')): RoutingSubject {
  return {
    reportId: '00000000-0000-4000-8000-000000000001',
    submitterId,
    totalMinor: '1000',
    currencyCode: 'CAD',
    onDate,
  };
}

/** A complete StepPlan — IMPLICIT_STEP is the direct-manager shape, so overrides
 *  only have to say what differs. */
function step(over: Partial<StepPlan> = {}): StepPlan {
  return { ...IMPLICIT_STEP, step: 1, ...over };
}

async function mkDelegation(
  fromUserId: string,
  toUserId: string,
  over: { startsOn?: string; endsOn?: string | null; revoked?: boolean } = {},
) {
  return withOrg(orgId, async (tx) => {
    const r = await tx.query(
      `INSERT INTO delegation
         (organization_id, from_user_id, to_user_id, starts_on, ends_on, created_by_id,
          revoked_at, revoked_by_id)
       VALUES (current_setting('app.current_org', true)::uuid, $1, $2, $3::date, $4::date, $1, $5, $6)
       RETURNING id`,
      [
        fromUserId,
        toUserId,
        over.startsOn ?? '2026-01-01',
        over.endsOn === undefined ? null : over.endsOn,
        over.revoked ? new Date() : null,
        over.revoked ? fromUserId : null,
      ],
    );
    return r.rows[0].id as string;
  });
}

/** A report + a RUNNING request + one task, so the decision guard has something
 *  real to authorize. VX2-3 owns the real transition code. */
async function mkTask(
  submitterEmail: string,
  submitterId: string,
  owner: { assigneeId?: string; claimRole?: string },
  over: { resolvedVia?: string; status?: string } = {},
): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const report = await expenses.createReport(tx, submitterEmail, {
      title: 'Decidable',
      currencyCode: 'CAD',
    });
    const expense = await expenses.addExpense(tx, TEST_ACTOR, report.id, { txnDate: TODAY,
      currencyCode: 'CAD',
      merchant: 'M',
    });
    await expenses.addLineItem(tx, TEST_ACTOR, expense.id, { categoryId, amountMinor: 1000 });
    const req = await tx.query(
      `INSERT INTO approval_request
         (organization_id, report_id, policy_snapshot, status, current_step, total_steps,
          subject_total_minor, subject_currency_code, opened_by_id)
       VALUES (current_setting('app.current_org', true)::uuid, $1, '[]'::jsonb, 'RUNNING', 1, 1,
               1000, 'CAD', $2)
       RETURNING id`,
      [report.id, submitterId],
    );
    const status = over.status ?? 'PENDING';
    // approval_task_decision_complete: anything but PENDING needs decided_at.
    const decidedAt = status === 'PENDING' ? null : new Date();
    const decidedBy = status === 'PENDING' || status === 'CANCELLED' ? null : submitterId;
    const t = await tx.query(
      `INSERT INTO approval_task
         (organization_id, request_id, step, assignee_id, claim_role, resolved_via, status,
          decided_at, decided_by_id)
       VALUES (current_setting('app.current_org', true)::uuid, $1, 1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        req.rows[0].id,
        owner.assigneeId ?? null,
        owner.claimRole ?? null,
        over.resolvedVia ?? (owner.claimRole ? 'ROLE' : 'MANAGER_CHAIN'),
        status,
        decidedAt,
        decidedBy,
      ],
    );
    return t.rows[0].id as string;
  });
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('routing-co','Routing Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  await withOrg(orgId, async (tx) => {
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id, code, label) VALUES ($1,'meals','{"en":"Meals"}') RETURNING id`,
      [orgId],
    );
    categoryId = c.rows[0].id;
  });
});

/**
 * The suite TRUNCATEs once, so fixtures ACCUMULATE across tests — and that is
 * silently dangerous for this file specifically, because `ADMIN_QUERY` picks
 * deterministically by `created_at`. An ADMIN left behind by an earlier test
 * would win a later test's ADMIN_FALLBACK and the assertion would pass for the
 * wrong reason, or fail for a reason that has nothing to do with the code.
 *
 * So park everything before each test: every employee DEACTIVATED and every
 * delegation revoked. Each test then creates its own ACTIVE cast, and the only
 * people the resolver can see are the ones that test put there.
 */
beforeEach(async () => {
  await admin.query("UPDATE app_user SET employee_status = 'DEACTIVATED'");
  await admin.query(
    `UPDATE delegation SET revoked_at = now(), revoked_by_id = from_user_id
      WHERE revoked_at IS NULL`,
  );
});

afterAll(async () => {
  await admin.end();
});

/* ── the resolver: MANAGER ─────────────────────────────────────────────────── */

describe('resolver — MANAGER', () => {
  it('routes to the direct manager, with no deviation recorded', async () => {
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: mgr.id });
    expect(a.resolvedVia).toBe('MANAGER_CHAIN');
    expect(a.escalationLevel).toBe(0);
    expect(a.delegatedFromId).toBeNull();
  });

  it('climbs past an ON_LEAVE manager and records the extra link', async () => {
    const top = await mkUser('top', { role: 'MANAGER' });
    const away = await mkUser('away', { role: 'MANAGER', managerId: top.id, status: 'ON_LEAVE' });
    const sub = await mkUser('sub', { managerId: away.id });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: top.id });
    expect(a.escalationLevel).toBe(1);
  });

  it('climbs past a soft-deleted manager too, not only an absent one', async () => {
    // deleted_at is how employees leave in normal operation, so a resolver that
    // only checked employee_status would park tasks on people who have gone.
    const top = await mkUser('top', { role: 'MANAGER' });
    const gone = await mkUser('gone', { role: 'MANAGER', managerId: top.id, deleted: true });
    const sub = await mkUser('sub', { managerId: gone.id });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: top.id });
  });

  it('DEGRADES to the most senior person found when the chain is shorter than the rung', async () => {
    // GAP-AUDIT AP-10. A rung naming level 3 in a two-deep org must not refuse
    // the submit: failing because the company is flat is an outage, not a
    // control. The shortfall is recorded rather than hidden.
    const top = await mkUser('top', { role: 'MANAGER' });
    const mid = await mkUser('mid', { role: 'MANAGER', managerId: top.id });
    const sub = await mkUser('sub', { managerId: mid.id });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step({ managerLevel: 3 })]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: top.id });
    expect(a.resolvedVia).toBe('MANAGER_CHAIN');
    // Landed at depth 2 against an intended level of 3.
    expect(a.escalationLevel).toBe(1);
  });

  it('reaches the requested level exactly when the chain is deep enough', async () => {
    // The control for the degrade test above: without it, a build that ALWAYS
    // returned the top of the chain would pass that one.
    const top = await mkUser('top', { role: 'MANAGER' });
    const mid = await mkUser('mid', { role: 'MANAGER', managerId: top.id });
    const sub = await mkUser('sub', { managerId: mid.id });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step({ managerLevel: 2 })]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: top.id });
    expect(a.escalationLevel).toBe(0);
  });

  it('falls back to an ADMIN when the submitter has no manager at all', async () => {
    // On ExpenseOS's dev data this was 80 of 703 active users — 11%. Refusing
    // the submit here would strand a ninth of a tenant (GAP-AUDIT AP-5).
    await setBreakGlass(false);
    const boss = await mkUser('admin', { role: 'ADMIN' });
    const sub = await mkUser('orphan');
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: boss.id });
    expect(a.resolvedVia).toBe('ADMIN_FALLBACK');
  });

  it('falls back to an ADMIN when the whole chain is absent', async () => {
    // GAP-AUDIT AP-18: the row the three decisions did not cover. ExpenseOS
    // parks the task on the absent person and lets the TTL escalate; we have no
    // TTL, so that is a report stuck in SUBMITTED forever.
    await setBreakGlass(false);
    const boss = await mkUser('admin', { role: 'ADMIN' });
    const away1 = await mkUser('away1', { role: 'MANAGER', status: 'ON_LEAVE' });
    const away2 = await mkUser('away2', { role: 'MANAGER', managerId: away1.id, status: 'DEACTIVATED' });
    const sub = await mkUser('sub', { managerId: away2.id });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: boss.id });
    expect(a.resolvedVia).toBe('ADMIN_FALLBACK');
  });

  it('terminates on a directory cycle instead of returning the submitter', async () => {
    /**
     * sub manages mgr and mgr manages sub — a two-hop cycle that
     * `app_user_manager_id_not_self_check` does not forbid (it only rules out the
     * one-hop self-loop).
     *
     * The assertion is about WHERE the walk stops. `CHAIN_QUERY` seeds its
     * visited path with the submitter, so climbing from sub yields [mgr] and
     * then stops rather than coming back round to sub. A level-2 rung therefore
     * degrades onto mgr — it does not hang, and it does not hand the submitter
     * their own report. This is also why `resolveManager` needs no self-skip.
     */
    await setBreakGlass(false);
    await mkUser('admin', { role: 'ADMIN' });
    const sub = await mkUser('sub', { role: 'MANAGER' });
    const mgr = await mkUser('mgr', { role: 'MANAGER', managerId: sub.id });
    await withOrg(orgId, (tx) =>
      tx.query('UPDATE app_user SET manager_id = $2 WHERE id = $1', [sub.id, mgr.id]),
    );
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step({ managerLevel: 2 })]),
    );
    expect(a.owner).not.toEqual({ kind: 'USER', assigneeId: sub.id });
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: mgr.id });
    // Degraded: landed at depth 1 against an intended level of 2.
    expect(a.escalationLevel).toBe(1);
  });

  it('refuses to route a USER rung that names the submitter', async () => {
    // The self-skip that IS reachable: a named approver, or a delegatee, can be
    // the submitter, and `skipAbsent` climbs past them.
    await setBreakGlass(false);
    const boss = await mkUser('admin', { role: 'ADMIN' });
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [
        step({ approverKind: 'USER', approverUserId: sub.id, managerLevel: null }),
      ]),
    );
    // Climbs the named person's own chain rather than assigning them their own
    // report; mgr is above them, so mgr gets it.
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: mgr.id });
    expect(a.owner).not.toEqual({ kind: 'USER', assigneeId: boss.id });
  });

  it("excludes the submitter's own subordinates from the ADMIN fallback", async () => {
    // GAP-AUDIT AP-6 rule 2, and the one place in VX2-2 where it bites: an
    // ADMIN picked automatically could be somebody who reports to the submitter,
    // which is the self-approval failure one hop removed. Two levels down is the
    // same problem with an extra hop in it.
    await setBreakGlass(false);
    const sub = await mkUser('ceo', { role: 'ADMIN' });
    const vp = await mkUser('vp', { role: 'ADMIN', managerId: sub.id });
    await mkUser('dir', { role: 'ADMIN', managerId: vp.id });
    await expect(
      withOrg(orgId, (tx) => tieredRouter.resolve(tx, subjectFor(sub.id), [step()])),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
  });

  it('fails closed when the submitter is the only possible approver', async () => {
    await setBreakGlass(false);
    const sub = await mkUser('solo', { role: 'ADMIN' });
    await expect(
      withOrg(orgId, (tx) => tieredRouter.resolve(tx, subjectFor(sub.id), [step()])),
    ).rejects.toBeInstanceOf(RoutingError);
  });

  it('honours the break-glass flag when the submitter is the only approver', async () => {
    // GAP-AUDIT AP-14: the SMB dead end. ExpenseOS accepts that such a report
    // parks forever; a two-person tenant cannot.
    await setBreakGlass(true);
    const sub = await mkUser('solo', { role: 'ADMIN' });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: sub.id });
    expect(a.resolvedVia).toBe('ADMIN_FALLBACK');
    await setBreakGlass(false);
  });
});

/* ── the resolver: other approver kinds ───────────────────────────────────── */

describe('resolver — ROLE, USER, EMAIL', () => {
  it('leaves a ROLE rung unassigned as a claim pool', async () => {
    // Deliberately not resolved to a person: picking one would make the same
    // authored ladder behave differently the day somebody else is given the
    // role, which is invisible to whoever wrote it (GAP-AUDIT AP-7).
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [
        step({ approverKind: 'ROLE', approverRole: 'ADMIN', managerLevel: null }),
      ]),
    );
    expect(a.owner).toEqual({ kind: 'ROLE', claimRole: 'ADMIN' });
    expect(a.resolvedVia).toBe('ROLE');
    expect(a.delegatedFromId).toBeNull();
  });

  it('routes a USER rung to the named person', async () => {
    const named = await mkUser('named', { role: 'MANAGER' });
    const sub = await mkUser('sub');
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [
        step({ approverKind: 'USER', approverUserId: named.id, managerLevel: null }),
      ]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: named.id });
    expect(a.resolvedVia).toBe('USER');
    expect(a.escalationLevel).toBe(0);
  });

  it('refuses an EMAIL rung until VX2-8 makes one actionable', async () => {
    const sub = await mkUser('sub');
    await expect(
      withOrg(orgId, (tx) =>
        tieredRouter.resolve(tx, subjectFor(sub.id), [
          step({ approverKind: 'EMAIL', externalEmail: 'x@vendor.test', managerLevel: null }),
        ]),
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_APPROVER_UNSUPPORTED' });
  });

  it('resolves a multi-step plan step by step', async () => {
    const top = await mkUser('top', { role: 'MANAGER' });
    const mid = await mkUser('mid', { role: 'MANAGER', managerId: top.id });
    const sub = await mkUser('sub', { managerId: mid.id });
    const out = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [
        step({ step: 1, managerLevel: 1 }),
        step({ step: 2, managerLevel: 2 }),
      ]),
    );
    expect(out.map((a) => [a.step, a.owner])).toEqual([
      [1, { kind: 'USER', assigneeId: mid.id }],
      [2, { kind: 'USER', assigneeId: top.id }],
    ]);
  });
});

/* ── the resolver: delegation ─────────────────────────────────────────────── */

describe('resolver — delegation', () => {
  it('hands the task to an active delegatee and records the delegator', async () => {
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const cover = await mkUser('cover', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    await mkDelegation(mgr.id, cover.id, { startsOn: '2026-06-01', endsOn: '2026-06-30' });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: cover.id });
    expect(a.resolvedVia).toBe('DELEGATION');
    expect(a.delegatedFromId).toBe(mgr.id);
  });

  it('takes ONE hop, never a chain of delegations', async () => {
    // A→B, B→C means a task of A's goes to B. The recursive reading is the
    // intuitive one and it is also an infinite loop waiting to happen.
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const first = await mkUser('first', { role: 'MANAGER' });
    const second = await mkUser('second', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    await mkDelegation(mgr.id, first.id);
    await mkDelegation(first.id, second.id);
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: first.id });
  });

  it('breaks an overlap by taking the most recently created delegation', async () => {
    // Ported, not invented: 0008 leaves this tie-break to VX2-2 and ExpenseOS
    // had already decided it (ORDER BY created_at DESC). The newest instruction
    // is the one the delegator meant.
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const older = await mkUser('older', { role: 'MANAGER' });
    const newer = await mkUser('newer', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    await mkDelegation(mgr.id, older.id);
    await mkDelegation(mgr.id, newer.id);
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: newer.id });
  });

  it('ignores a delegation outside its date range, and a revoked one', async () => {
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const past = await mkUser('past', { role: 'MANAGER' });
    const revoked = await mkUser('revoked', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    await mkDelegation(mgr.id, past.id, { startsOn: '2026-01-01', endsOn: '2026-01-31' });
    await mkDelegation(mgr.id, revoked.id, { revoked: true });
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: mgr.id });
    expect(a.resolvedVia).toBe('MANAGER_CHAIN');
    expect(a.delegatedFromId).toBeNull();
  });

  it('skips absence on BOTH sides — delegating to somebody also away', async () => {
    const top = await mkUser('top', { role: 'MANAGER' });
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const awayCover = await mkUser('awaycover', {
      role: 'MANAGER',
      managerId: top.id,
      status: 'ON_LEAVE',
    });
    const sub = await mkUser('sub', { managerId: mgr.id });
    await mkDelegation(mgr.id, awayCover.id);
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: top.id });
    expect(a.resolvedVia).toBe('DELEGATION');
    expect(a.delegatedFromId).toBe(mgr.id);
  });

  it('does not claim DELEGATION when skipping the delegatee lands on the admin fallback', async () => {
    // approval_task_delegation_source requires delegated_from_id whenever
    // resolved_via is DELEGATION. A resolution that ended up somewhere else must
    // not describe itself as a delegation, or the row is a lie the CHECK accepts.
    await setBreakGlass(false);
    const boss = await mkUser('admin', { role: 'ADMIN' });
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const awayCover = await mkUser('awaycover', { role: 'MANAGER', status: 'DEACTIVATED' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    await mkDelegation(mgr.id, awayCover.id);
    const [a] = await withOrg(orgId, (tx) =>
      tieredRouter.resolve(tx, subjectFor(sub.id), [step()]),
    );
    expect(a.owner).toEqual({ kind: 'USER', assigneeId: boss.id });
    expect(a.resolvedVia).toBe('ADMIN_FALLBACK');
    expect(a.delegatedFromId).toBeNull();
  });
});

/* ── the decision guard ───────────────────────────────────────────────────── */

describe('canDecide', () => {
  it('lets the assignee decide, and refuses an unrelated user', async () => {
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const bystander = await mkUser('bystander', { role: 'MANAGER' });
    const taskId = await mkTask(sub.email, sub.id, { assigneeId: mgr.id });
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, taskId, mgr.id)).toBe(true);
      // The control. Without it the assertion above passes on a build where
      // everyone can decide everything.
      expect(await canDecide(tx, taskId, bystander.id)).toBe(false);
    });
  });

  it('REFUSES the submitter — including when they are an admin', async () => {
    // The case ExpenseOS shipped. Their self-approval rule sat thirty lines
    // below `if (isAdmin) return true`, so it was unreachable for exactly the
    // people best able to break it: a System Administrator submitted a report,
    // was offered Approve, and it succeeded and was recorded as a real approval
    // (their F15 / F20, blocker B3).
    await setBreakGlass(false);
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { role: 'ADMIN', managerId: mgr.id });
    const taskId = await mkTask(sub.email, sub.id, { assigneeId: mgr.id });
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, taskId, sub.id)).toBe(false);
      expect(await canDecide(tx, taskId, sub.id, { isAdmin: true })).toBe(false);
    });
  });

  it('refuses the submitter even when the task is assigned to them', async () => {
    // "The ladder named me" is not a reason. The check runs ahead of the
    // ASSIGNEE path, not only ahead of the pool.
    await setBreakGlass(false);
    const sub = await mkUser('sub', { role: 'ADMIN' });
    const taskId = await mkTask(sub.email, sub.id, { assigneeId: sub.id });
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, taskId, sub.id)).toBe(false);
      expect(await canDecide(tx, taskId, sub.id, { isAdmin: true })).toBe(false);
    });
  });

  it('permits self-approval ONLY with the break-glass and an ADMIN_FALLBACK task', async () => {
    // Both conditions, or neither. The flag alone must not open self-approval on
    // a task the ladder routed normally.
    await setBreakGlass(true);
    const sub = await mkUser('solo', { role: 'ADMIN' });
    const viaFallback = await mkTask(
      sub.email,
      sub.id,
      { assigneeId: sub.id },
      { resolvedVia: 'ADMIN_FALLBACK' },
    );
    const viaLadder = await mkTask(
      sub.email,
      sub.id,
      { assigneeId: sub.id },
      { resolvedVia: 'MANAGER_CHAIN' },
    );
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, viaFallback, sub.id)).toBe(true);
      expect(await canDecide(tx, viaLadder, sub.id)).toBe(false);
    });
    // …and turning the flag off closes it again.
    await setBreakGlass(false);
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, viaFallback, sub.id)).toBe(false);
    });
  });

  it("lets an admin decide somebody else's task", async () => {
    // The override is load-bearing: it is how a stuck queue gets unwedged. Only
    // the admin's OWN report is out of reach.
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const other = await mkUser('otheradmin', { role: 'ADMIN' });
    const taskId = await mkTask(sub.email, sub.id, { assigneeId: mgr.id });
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, taskId, other.id, { isAdmin: true })).toBe(true);
      // Same person without the role: refused. So the grant above is the ROLE
      // doing the work, not an accident of the fixture.
      expect(await canDecide(tx, taskId, other.id)).toBe(false);
    });
  });

  it('lets a delegatee decide a task still assigned to the delegator', async () => {
    // Covers tasks parked BEFORE the delegation existed — without this, "cover
    // for me" would only work for reports submitted afterwards.
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const cover = await mkUser('cover', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const taskId = await mkTask(sub.email, sub.id, { assigneeId: mgr.id });
    await mkDelegation(mgr.id, cover.id, { startsOn: '2026-06-01', endsOn: '2026-06-30' });
    const onDate = new Date('2026-06-15');
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, taskId, cover.id, { onDate })).toBe(true);
      // Outside the range the same delegation grants nothing.
      expect(await canDecide(tx, taskId, cover.id, { onDate: new Date('2026-07-15') })).toBe(false);
    });
  });

  it('refuses a delegatee who is the submitter of the report', async () => {
    // The hole VX2-5 opens, closed here.
    //
    // The RESOLVER already routes around a delegation whose delegatee is the
    // submitter — `skipAbsent` refuses to land on them and walks on, so no task
    // is ever CREATED with `resolved_via: 'DELEGATION'` pointing at the person
    // who filed the claim. That made this case unreachable in practice, which is
    // why it had no test.
    //
    // It stops being unreachable the moment a delegation can be created AFTER
    // the task exists, which is exactly what /approvals/delegations is for: the
    // task is parked on the manager, the manager then hands their approvals to
    // somebody, and that somebody happens to be the person whose report is
    // sitting in the queue. The resolver never sees it.
    //
    // So the guarantee this asserts is the ORDERING inside `evaluate`: the
    // self-approval refusal runs ahead of the delegatee grant, not only ahead of
    // the assignee path and the pool. That ordering is the security property
    // (AP-13) and it was previously asserted on every path except this one.
    await setBreakGlass(false);
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const taskId = await mkTask(sub.email, sub.id, { assigneeId: mgr.id });
    await mkDelegation(mgr.id, sub.id, { startsOn: '2026-06-01', endsOn: '2026-06-30' });
    const onDate = new Date('2026-06-15');
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, taskId, sub.id, { onDate })).toBe(false);
      // And not rescued by the admin override either — same reason as the
      // submitter-as-admin case above.
      expect(await canDecide(tx, taskId, sub.id, { onDate, isAdmin: true })).toBe(false);
    });
    // The control: the same delegation DOES grant somebody who is not the
    // submitter, so the refusal above is the self-check and not a broken fixture.
    const cover = await mkUser('cover2', { role: 'MANAGER' });
    await mkDelegation(mgr.id, cover.id, { startsOn: '2026-06-01', endsOn: '2026-06-30' });
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, taskId, cover.id, { onDate })).toBe(true);
    });
  });

  it('lets an active holder of the claim role decide, and nobody else', async () => {
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const holder = await mkUser('holder', { role: 'ADMIN' });
    const outsider = await mkUser('outsider', { role: 'MANAGER' });
    const goneHolder = await mkUser('goneholder', { role: 'ADMIN', status: 'DEACTIVATED' });
    const taskId = await mkTask(sub.email, sub.id, { claimRole: 'ADMIN' });
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, taskId, holder.id)).toBe(true);
      expect(await canDecide(tx, taskId, outsider.id)).toBe(false);
      // Membership has to mean ACTIVE membership.
      expect(await canDecide(tx, taskId, goneHolder.id)).toBe(false);
    });
  });

  it('refuses a task that is not PENDING, and one that does not exist', async () => {
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const decided = await mkTask(
      sub.email,
      sub.id,
      { assigneeId: mgr.id },
      { status: 'APPROVED' },
    );
    await withOrg(orgId, async (tx) => {
      expect(await canDecide(tx, decided, mgr.id)).toBe(false);
      expect(await canDecide(tx, decided, mgr.id, { isAdmin: true })).toBe(false);
      expect(
        await canDecide(tx, '00000000-0000-4000-8000-0000000000ff', mgr.id, { isAdmin: true }),
      ).toBe(false);
    });
  });
});

describe('assertCanDecide', () => {
  it('distinguishes a self-approval refusal from a plain 403', async () => {
    // The codes are what let a caller say something useful: a self-approval
    // refusal is actionable by an admin, NOT_AN_APPROVER is not.
    await setBreakGlass(false);
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { role: 'ADMIN', managerId: mgr.id });
    const bystander = await mkUser('bystander', { role: 'MANAGER' });
    const taskId = await mkTask(sub.email, sub.id, { assigneeId: mgr.id });
    await withOrg(orgId, async (tx) => {
      await expect(assertCanDecide(tx, taskId, sub.id, { isAdmin: true })).rejects.toMatchObject({
        code: 'SELF_APPROVAL',
      });
      await expect(assertCanDecide(tx, taskId, bystander.id)).rejects.toMatchObject({
        code: 'NOT_AN_APPROVER',
      });
      await expect(assertCanDecide(tx, taskId, mgr.id)).resolves.toBeUndefined();
    });
  });

  it('reports a missing task and a decided one differently', async () => {
    const mgr = await mkUser('mgr', { role: 'MANAGER' });
    const sub = await mkUser('sub', { managerId: mgr.id });
    const decided = await mkTask(
      sub.email,
      sub.id,
      { assigneeId: mgr.id },
      { status: 'REJECTED' },
    );
    await withOrg(orgId, async (tx) => {
      await expect(
        assertCanDecide(tx, '00000000-0000-4000-8000-0000000000fe', mgr.id),
      ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
      await expect(assertCanDecide(tx, decided, mgr.id)).rejects.toMatchObject({
        code: 'NOT_PENDING',
      });
      // The error type callers catch on.
      await expect(assertCanDecide(tx, decided, mgr.id)).rejects.toBeInstanceOf(
        DecisionForbiddenError,
      );
    });
  });
});
