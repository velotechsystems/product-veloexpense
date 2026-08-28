/**
 * VX2-2 — the tiered approval resolver: the implementation behind
 * `ApprovalRouter`.
 *
 * PORTED, not designed. Every rule below traces to ExpenseOS source read at the
 * spec baseline (`packages/approvals/src/engine.ts` — `resolveApprover`,
 * `resolveManagerChain`, `skipOnLeave`, `activeDelegateeFor`,
 * `resolveAssignment`) plus the decisions in `docs/porting/GAP-AUDIT.md`
 * AP-1, AP-5, AP-10, AP-13, AP-14, AP-16, AP-17 and AP-18. Read those before
 * changing behaviour here: several of these rules exist because ExpenseOS
 * shipped the alternative and measured the damage.
 *
 * ── The four ways a MANAGER approver fails, and what each does ──────────────
 *
 *   chain absent entirely            → ADMIN_FALLBACK   (AP-5)
 *   chain shorter than manager_level → degrade to the most senior found (AP-10)
 *   every person in the chain absent → ADMIN_FALLBACK   (AP-18)
 *   the only candidate is the submitter → ADMIN_FALLBACK, then the AP-14
 *                                        break-glass, then fail closed
 *
 * None of them auto-approve and none of them silently skip a step. The one
 * outcome that is NOT available is ExpenseOS's own — assign it to an absent
 * person and let the TTL escalate — because VeloExpense has no TTL, so that
 * produces a report stuck in SUBMITTED forever (AP-2, AP-8).
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * ExpenseOS walks the manager chain with one `findUnique` per hop, twice over
 * (`resolveManagerChain` then `skipOnLeave`), so a deep chain is a dozen round
 * trips per step. We fetch the whole chain once per submitter with a recursive
 * CTE — cycle-safe via the visited-path array, the same query shape
 * `getManagerChain` already uses — and memoize it for the whole plan, because
 * every MANAGER rung of one report walks the same chain.
 */
import type { QueryRunner } from '@/lib/db/client';
import {
  RoutingError,
  type ApprovalRouter,
  type ResolvedAssignment,
  type ResolvedOwner,
  type RoutingSubject,
} from '@/lib/approvals/routing';
import { isApproverRole, type StepPlan } from '@/lib/approvals/tiers';
import { MAX_CHAIN_DEPTH, type EmployeeRole } from '@/lib/employees/service';

/* ── the chain ─────────────────────────────────────────────────────────────── */

interface ChainLink {
  /** 1 = the submitter's direct manager. */
  depth: number;
  id: string;
  role: EmployeeRole;
  available: boolean;
}

/**
 * Every ancestor of one employee, nearest first, with the two facts routing
 * needs about each.
 *
 * `available` is written in the POSITIVE form — `employee_status = 'ACTIVE'` —
 * on purpose. ExpenseOS tests the negative (`=== 'ON_LEAVE' || === 'TERMINATED'`),
 * which is an allow-list by omission: a status added to the enum later is
 * treated as available by default, and nobody will be looking at this function
 * on the day that happens. Ours fails closed instead (GAP-AUDIT AP-16).
 *
 * Cycle-safe and depth-capped: `NOT (m.id = ANY(c.path))` stops a directory
 * cycle that `app_user_manager_id_not_self_check` does not catch (it only
 * forbids the one-hop self-loop).
 */
const CHAIN_QUERY = `
  WITH RECURSIVE chain AS (
      SELECT u.id, u.manager_id, 0 AS depth, ARRAY[u.id] AS path
        FROM app_user u
       WHERE u.id = $1
      UNION ALL
      SELECT m.id, m.manager_id, c.depth + 1, c.path || m.id
        FROM chain c
        JOIN app_user m ON m.id = c.manager_id
       WHERE c.depth < $2 AND NOT (m.id = ANY(c.path))
  )
  SELECT c.depth,
         u.id,
         u.role,
         (u.deleted_at IS NULL AND u.employee_status = 'ACTIVE') AS available
    FROM chain c
    JOIN app_user u ON u.id = c.id
   WHERE c.depth > 0
   ORDER BY c.depth`;

/** Memoizes chain lookups for one `resolve()` call — every MANAGER rung of a
 *  report walks the same chain, and a delegatee needs their own. */
class ChainCache {
  private readonly cache = new Map<string, ChainLink[]>();

  constructor(private readonly tx: QueryRunner) {}

  async of(employeeId: string): Promise<ChainLink[]> {
    const hit = this.cache.get(employeeId);
    if (hit) return hit;
    const r = await this.tx.query(CHAIN_QUERY, [employeeId, MAX_CHAIN_DEPTH]);
    const chain = r.rows as ChainLink[];
    this.cache.set(employeeId, chain);
    return chain;
  }
}

/* ── delegation ────────────────────────────────────────────────────────────── */

/**
 * The active in-scope delegatee for one person on one date, or null.
 *
 * `ORDER BY created_at DESC` is the overlapping-delegation tie-break, and it is
 * ported rather than invented: `0008`'s comments leave the tie-break to VX2-2,
 * and ExpenseOS's `activeDelegateeFor` had already decided it — "picks the most
 * recently created when several overlap". The newest instruction is the one the
 * delegator meant (GAP-AUDIT AP-16).
 *
 * Scope: ALL always applies; REPORTS is the expense-report scope. They are the
 * same thing today and the distinction exists so that adding travel or card
 * approvals later does not silently widen every delegation written before them.
 *
 * `revoked_at IS NULL` rather than an `active` flag — `delegation` has no such
 * column, and the date range is inclusive on both ends by design (see 0008).
 */
const DELEGATION_QUERY = `
  SELECT to_user_id
    FROM delegation
   WHERE from_user_id = $1
     AND revoked_at IS NULL
     AND scope = ANY($2::text[])
     AND starts_on <= $3::date
     AND (ends_on IS NULL OR ends_on >= $3::date)
   ORDER BY created_at DESC
   LIMIT 1`;

async function delegateeOf(
  tx: QueryRunner,
  fromUserId: string,
  onDate: Date,
): Promise<string | null> {
  const r = await tx.query(DELEGATION_QUERY, [fromUserId, ['ALL', 'REPORTS'], onDate]);
  return (r.rows[0]?.to_user_id as string | undefined) ?? null;
}

/* ── admin fallback ────────────────────────────────────────────────────────── */

/**
 * Active ADMINs of the tenant, excluding one person (the submitter).
 *
 * RLS has already narrowed `app_user` to the caller's tenant, so there is no
 * organization_id predicate here — the same reason none of the other queries in
 * this file carry one.
 *
 * Ordered for determinism only. Which admin gets it is arbitrary and that is
 * acceptable *here* in a way it is not for a ROLE approver: ADMIN_FALLBACK is
 * the resolver admitting it could not honour the ladder, so an admin picking it
 * up and reassigning (VX2-4) is the intended flow. A ROLE approver, by
 * contrast, is a ladder the admin authored, which is why that one becomes a
 * claim pool instead (GAP-AUDIT AP-7).
 *
 * The submitter's own SUBORDINATES are excluded, transitively. This is
 * GAP-AUDIT AP-6 rule 2, and it is the one place in VX2-2 where the rule has
 * teeth: a MANAGER step resolves to an ancestor and can never be a descendant,
 * and a USER step is a person the admin named on purpose — but an ADMIN picked
 * automatically could easily be somebody who reports to the submitter, and
 * "someone whose job the submitter controls signing off on the submitter's
 * spend" is the self-approval failure one hop removed. ExpenseOS closed exactly
 * this after shipping the open version.
 *
 * `UNION` rather than `UNION ALL` in the descendants CTE: deduplication is what
 * makes it terminate if the directory contains a cycle, which
 * `app_user_manager_id_not_self_check` does not prevent (it forbids only the
 * one-hop self-loop). No depth cap is needed for termination, and capping here
 * would mean a deep org silently stops excluding people.
 *
 * If this returns nothing, `fallbackToAdmin` goes on to the AP-14 break-glass
 * and then fails closed — so a tenant whose only other administrator reports to
 * the submitter gets a refused submit with a sentence explaining it, rather
 * than a quiet segregation-of-duties breach.
 */
const ADMIN_QUERY = `
  WITH RECURSIVE reports AS (
      SELECT u.id
        FROM app_user u
       WHERE u.manager_id = $1
      UNION
      SELECT u.id
        FROM app_user u
        JOIN reports r ON u.manager_id = r.id
  )
  SELECT u.id
    FROM app_user u
   WHERE u.role = 'ADMIN'
     AND u.deleted_at IS NULL
     AND u.employee_status = 'ACTIVE'
     AND u.id <> $1
     AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.id = u.id)
   ORDER BY u.created_at, u.id
   LIMIT 1`;

async function adminFallback(tx: QueryRunner, excludeId: string): Promise<string | null> {
  const r = await tx.query(ADMIN_QUERY, [excludeId]);
  return (r.rows[0]?.id as string | undefined) ?? null;
}

const BREAK_GLASS_QUERY = `
  SELECT o.allow_sole_approver_self_approval AS allowed
    FROM organization o
   WHERE o.id = NULLIF(current_setting('app.current_org', true), '')::uuid`;

async function breakGlassAllowed(tx: QueryRunner): Promise<boolean> {
  const r = await tx.query(BREAK_GLASS_QUERY, []);
  return (r.rows[0]?.allowed as boolean | undefined) ?? false;
}

/* ── the resolver ──────────────────────────────────────────────────────────── */

/** What one step resolved to before delegation is applied. */
interface BaseResolution {
  owner: ResolvedOwner;
  resolvedVia: ResolvedAssignment['resolvedVia'];
  escalationLevel: number;
}

export class TieredRouter implements ApprovalRouter {
  async resolve(
    tx: QueryRunner,
    subject: RoutingSubject,
    plan: StepPlan[],
  ): Promise<ResolvedAssignment[]> {
    const chains = new ChainCache(tx);
    const out: ResolvedAssignment[] = [];
    for (const step of plan) {
      const base = await this.resolveStep(tx, chains, subject, step);
      out.push(await this.applyDelegation(tx, chains, subject, step, base));
    }
    return out;
  }

  /* ── one step, before delegation ───────────────────────────────────────── */

  private async resolveStep(
    tx: QueryRunner,
    chains: ChainCache,
    subject: RoutingSubject,
    step: StepPlan,
  ): Promise<BaseResolution> {
    switch (step.approverKind) {
      case 'EMAIL':
        // Storable but not routable until VX2-8 ships the approve-link token.
        // Refusing here is the point: the alternative is a task nobody can ever
        // decide and a report stuck in SUBMITTED forever.
        throw new RoutingError(
          `step ${step.step} names an external approver, which cannot be routed until VX2-8`,
          'EMAIL_APPROVER_UNSUPPORTED',
          step.step,
        );

      case 'ROLE': {
        const role = step.approverRole;
        if (!role || !isApproverRole(role)) {
          throw new RoutingError(
            `step ${step.step} names an unknown approver role: ${String(role)}`,
            'UNRESOLVABLE_RUNG',
            step.step,
          );
        }
        // A claim pool, not a person. No on-leave skipping and no delegation —
        // both need an assignee, and giving them up is the price a pool pays
        // (ExpenseOS makes the same trade and says so). An empty pool is a
        // stranded task, which is loud and traceable to an authoring decision;
        // that is the correct outcome when the named approver set is empty, and
        // strictly better than silently widening it to everyone.
        return { owner: { kind: 'ROLE', claimRole: role }, resolvedVia: 'ROLE', escalationLevel: 0 };
      }

      case 'USER': {
        const named = step.approverUserId;
        if (!named) {
          throw new RoutingError(
            `step ${step.step} names no approver user`,
            'UNRESOLVABLE_RUNG',
            step.step,
          );
        }
        // A named approver is still status-skipped, exactly as ExpenseOS does:
        // `resolveApprover` does not status-check the person it returns, and
        // `resolveAssignment` applies `skipOnLeave` on top of whatever came
        // back. So an admin who names someone on leave gets that person's
        // manager rather than a parked task.
        //
        // Walking up a NAMED approver's own chain can land on somebody with no
        // relation to the ladder the admin wrote, so this was raised as a
        // divergence candidate. REVIEWED AND KEPT (2026-08-28, John): a named
        // approver being away is rare enough that special-casing it would add a
        // branch nobody exercises, and a task nobody can decide is the worse
        // failure. The port stands.
        return this.skipAbsent(tx, chains, subject, step, named, 'USER');
      }

      case 'MANAGER':
        return this.resolveManager(tx, chains, subject, step);

      default: {
        // Exhaustive by construction: adding an approver kind breaks the build
        // here rather than silently falling through to a throw at runtime.
        // GAP-AUDIT AP-12 asks for this on every predicate over approver_kind.
        const unreachable: never = step.approverKind;
        throw new RoutingError(
          `step ${step.step} has an unhandled approver kind: ${String(unreachable)}`,
          'UNRESOLVABLE_RUNG',
          step.step,
        );
      }
    }
  }

  /* ── MANAGER: the four outcomes ────────────────────────────────────────── */

  private async resolveManager(
    tx: QueryRunner,
    chains: ChainCache,
    subject: RoutingSubject,
    step: StepPlan,
  ): Promise<BaseResolution> {
    const chain = await chains.of(subject.submitterId);
    // No manager at all. On ExpenseOS's dev data this was 80 of 703 active
    // users — 11% — so it is an HR-data fact, not an edge case, and refusing
    // the submit here would strand a ninth of a tenant.
    if (chain.length === 0) return this.fallbackToAdmin(tx, subject, step, 0);

    const intended = step.managerLevel ?? 1;
    // AP-10's degrade: land on the most senior ancestor found rather than
    // failing because the company is flatter than the ladder assumes. Failing a
    // submit because of the shape of the org chart is an outage, not a control.
    const startIdx = Math.min(intended, chain.length) - 1;

    for (let i = startIdx; i < chain.length; i += 1) {
      const link = chain[i];
      if (!link.available) continue;
      // NOTE: no self-skip here, and deliberately not as defence-in-depth
      // either. `CHAIN_QUERY` seeds its visited path with the submitter's own
      // id and excludes anyone already in it, so the submitter can never appear
      // at depth > 0 — a directory cycle terminates at them rather than
      // returning them. A guard here would be dead code that reads as
      // load-bearing, which is worse than none. `skipAbsent` DOES need one,
      // because it walks from a named approver or a delegatee, and those chains
      // can legitimately contain the submitter.
      return {
        owner: { kind: 'USER', assigneeId: link.id },
        resolvedVia: 'MANAGER_CHAIN',
        escalationLevel: Math.abs(link.depth - intended),
      };
    }

    // Chain present and long enough, and nobody in it can act. ExpenseOS parks
    // the task on the absent person and lets the TTL escalate; we have no TTL,
    // so that is a report stuck in SUBMITTED forever (GAP-AUDIT AP-18).
    return this.fallbackToAdmin(tx, subject, step, chain.length);
  }

  /**
   * Walk up from `startId` to the first person who can act. Used for a named
   * USER approver and for a delegatee.
   */
  private async skipAbsent(
    tx: QueryRunner,
    chains: ChainCache,
    subject: RoutingSubject,
    step: StepPlan,
    startId: string,
    via: 'USER' | 'DELEGATION',
  ): Promise<BaseResolution> {
    const self = await this.availability(tx, startId);
    if (self.available && startId !== subject.submitterId) {
      return { owner: { kind: 'USER', assigneeId: startId }, resolvedVia: via, escalationLevel: 0 };
    }
    const chain = await chains.of(startId);
    for (const link of chain) {
      if (!link.available) continue;
      if (link.id === subject.submitterId) continue;
      return {
        owner: { kind: 'USER', assigneeId: link.id },
        resolvedVia: via,
        escalationLevel: link.depth,
      };
    }
    return this.fallbackToAdmin(tx, subject, step, chain.length);
  }

  private async availability(tx: QueryRunner, id: string): Promise<{ available: boolean }> {
    const r = await tx.query(
      `SELECT (u.deleted_at IS NULL AND u.employee_status = 'ACTIVE') AS available
         FROM app_user u WHERE u.id = $1`,
      [id],
    );
    return { available: (r.rows[0]?.available as boolean | undefined) ?? false };
  }

  /**
   * The last resort before failing closed: a tenant ADMIN who is not the
   * submitter. If there is none, the AP-14 break-glass decides whether the
   * submitter may decide their own report.
   */
  private async fallbackToAdmin(
    tx: QueryRunner,
    subject: RoutingSubject,
    step: StepPlan,
    escalationLevel: number,
  ): Promise<BaseResolution> {
    const admin = await adminFallback(tx, subject.submitterId);
    if (admin) {
      return {
        owner: { kind: 'USER', assigneeId: admin },
        resolvedVia: 'ADMIN_FALLBACK',
        escalationLevel,
      };
    }
    // Nobody but the submitter is left. This is the SMB dead end AP-14 exists
    // for: ExpenseOS's hard self-approval block plus an admin fallback compose
    // into a report no living user may decide, in exactly the tenants where the
    // sole admin is also the submitter.
    if (await breakGlassAllowed(tx)) {
      return {
        owner: { kind: 'USER', assigneeId: subject.submitterId },
        resolvedVia: 'ADMIN_FALLBACK',
        escalationLevel,
      };
    }
    throw new RoutingError(
      `step ${step.step} has no eligible approver: the submitter is the tenant's only active ` +
        `administrator, and self-approval is not enabled for this organization`,
      'SELF_APPROVAL',
      step.step,
    );
  }

  /* ── delegation, applied on top ────────────────────────────────────────── */

  /**
   * ONE hop, never a chain. ExpenseOS is explicit: "One delegation hop — no
   * chains-of-delegations." A delegates to B and B delegates to C, and a task
   * of A's goes to B, not C. The recursive reading is the intuitive one and it
   * is also an infinite loop waiting to happen (A→B, B→A).
   *
   * On-leave skipping runs on BOTH sides — once on the base assignee before we
   * look for a delegation, and again on the delegatee — so handing over to
   * somebody who is themselves away still lands on a present person.
   *
   * A role pool has no delegator to look up, so it passes through untouched.
   */
  private async applyDelegation(
    tx: QueryRunner,
    chains: ChainCache,
    subject: RoutingSubject,
    step: StepPlan,
    base: BaseResolution,
  ): Promise<ResolvedAssignment> {
    const flat = (r: BaseResolution, delegatedFromId: string | null): ResolvedAssignment => ({
      step: step.step,
      owner: r.owner,
      resolvedVia: r.resolvedVia,
      delegatedFromId,
      escalationLevel: r.escalationLevel,
    });

    if (base.owner.kind !== 'USER') return flat(base, null);
    // A break-glass self-assignment is not handed to a delegatee: the point of
    // the exception is that this one person may decide, and routing it onward
    // would quietly turn a narrow audited exception into a general redirect.
    if (base.owner.assigneeId === subject.submitterId) return flat(base, null);

    const delegator = base.owner.assigneeId;
    const delegatee = await delegateeOf(tx, delegator, subject.onDate);
    if (!delegatee || delegatee === delegator) return flat(base, null);

    const after = await this.skipAbsent(tx, chains, subject, step, delegatee, 'DELEGATION');
    // If skipping the delegatee ran out of people and landed on ADMIN_FALLBACK,
    // the delegation is not what produced the assignee — so it must not claim
    // to be, or `approval_task_delegation_source` would record a delegation
    // that did not happen.
    if (after.resolvedVia !== 'DELEGATION') return flat(after, null);
    return flat(after, delegator);
  }
}

/** The default router. A workflow-graph engine would arrive as a second
 *  implementation of `ApprovalRouter`, not as a change to this one. */
export const tieredRouter = new TieredRouter();
