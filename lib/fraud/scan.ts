/**
 * VX4-8 part 2 — the scan: run every detector and reconcile against `fraud_flag`.
 *
 * Reconciliation is the whole job and it has exactly three cases, ported from
 * `packages/fraud/src/scan.ts` along with the reasoning for each:
 *
 *   · NEW finding → insert an ACTIVE flag.
 *   · ALREADY ACTIVE → refresh the numbers. σ shifts, another entry lands, and a
 *     reviewer should see current arithmetic rather than whatever was true the
 *     night it first fired.
 *   · ALREADY REVIEWED (RESOLVED / DISMISSED / ESCALATED) → leave it alone.
 *     "I already looked at this" has to stick, or the queue becomes noise nobody
 *     reads.
 *
 * A finding is never DELETED when its rule stops firing. `last_seen_at` going
 * stale is the signal that the cause went away; deleting would erase the fact
 * that a concern was ever raised, which is the wrong instinct in a compliance
 * module.
 *
 * ── ONE STATEMENT PER RULE, NOT THREE PER FINDING ───────────────────────────
 *
 * Upstream does `findUnique` → `create` or `update` for every finding, which is
 * two round trips each and a read-then-write besides. The third case is the one
 * that matters: between their read of `status` and their update, a reviewer
 * pressing Dismiss loses. It is a narrow race and a real one — the scan is a
 * nightly job over a queue people work during the day.
 *
 * Here the three cases are ONE statement, and the third is a DATABASE rule:
 *
 *     ON CONFLICT (organization_id, finding_key) DO UPDATE SET …
 *       WHERE fraud_flag.status = 'ACTIVE'
 *
 * A conflicting row that a person has already ruled on matches no `WHERE`, so it
 * is not written and not returned — suppression with no read, no race and no
 * branch that a future edit could forget. Sixth or seventh appearance of this
 * project's conditional-write idiom, and the first time it has been used to
 * protect a human decision from a machine rather than one worker from another.
 *
 * `RETURNING (xmax = 0)` is what separates the first two cases: Postgres leaves
 * `xmax` at 0 on a fresh insert and sets it on a row the statement updated. The
 * findings that come back with nothing at all are the suppressed ones.
 */
import type { QueryRunner } from '@/lib/db/client';
import { withOrg } from '@/lib/tenant/context';
import { organizationsWithModule } from '@/lib/modules/service';
import { loadFraudConfig } from '@/lib/fraud/rules';

import {
  DETECTORS,
  type Finding,
  type FraudConfig,
  type FraudRuleCode,
} from '@/lib/fraud/rules';
import { requireModule } from '@/lib/modules/service';
import { ORG } from '@/lib/tenant/sql';


export interface ScanResult {
  created: number;
  refreshed: number;
  /** Findings that matched a flag a person had already ruled on. */
  suppressed: number;
  perRule: Record<string, number>;
  /** Rules that threw. Empty is the normal case; see the note in `runFraudScan`. */
  failed: Array<{ code: FraudRuleCode; error: string }>;
}

/**
 * Reconcile one rule's findings. Returns how many were inserted and updated;
 * anything unaccounted for was suppressed by the `WHERE` above.
 */
async function reconcile(
  tx: QueryRunner,
  findings: readonly Finding[],
): Promise<{ created: number; refreshed: number }> {
  if (findings.length === 0) return { created: 0, refreshed: 0 };
  const r = await tx.query(
    `INSERT INTO fraud_flag (organization_id, rule_code, severity, message_code, data,
                             evidence, report_id, expense_id, subject_user_id, finding_key)
     SELECT ${ORG}, t.rule_code, t.severity::fraud_severity, t.message_code,
            t.data, t.evidence, t.report_id, t.expense_id, t.subject_user_id, t.finding_key
       FROM unnest($1::text[], $2::text[], $3::text[], $4::jsonb[], $5::jsonb[],
                   $6::uuid[], $7::uuid[], $8::uuid[], $9::text[])
         AS t(rule_code, severity, message_code, data, evidence,
              report_id, expense_id, subject_user_id, finding_key)
     ON CONFLICT (organization_id, finding_key) DO UPDATE
        SET severity     = EXCLUDED.severity,
            message_code = EXCLUDED.message_code,
            data         = EXCLUDED.data,
            evidence     = EXCLUDED.evidence,
            last_seen_at = clock_timestamp(),
            updated_at   = clock_timestamp()
      -- The suppression rule, as a database rule. See the header.
      WHERE fraud_flag.status = 'ACTIVE'
     RETURNING (xmax = 0) AS inserted`,
    [
      findings.map((f) => f.ruleCode),
      findings.map((f) => f.severity),
      findings.map((f) => f.messageCode),
      findings.map((f) => JSON.stringify(f.data)),
      findings.map((f) => JSON.stringify(f.evidence)),
      findings.map((f) => f.reportId),
      findings.map((f) => f.expenseId),
      findings.map((f) => f.subjectUserId),
      findings.map((f) => f.findingKey),
    ],
  );
  let created = 0;
  let refreshed = 0;
  for (const row of r.rows) {
    if (row.inserted === true) created += 1;
    else refreshed += 1;
  }
  return { created, refreshed };
}

/**
 * Run the detectors and reconcile. `onlyRules` narrows to a subset — the admin's
 * "re-run this rule" action in part 3 — and omitted means all of them.
 *
 * GATED ON THE `compliance` MODULE, in the SERVICE layer beside the write rather
 * than at whichever caller happens to invoke it. MT-3, and the reason
 * `lib/modules/service.ts` opens by stating it: a gate at the edge is a gate the
 * next caller forgets, and this function will eventually have three callers — a
 * screen, a scheduled job and a test.
 *
 * ONE FAILING RULE MUST NOT ABANDON THE REST, and the failures are RETURNED
 * rather than logged. Upstream logs to `console.warn` and carries on, which means
 * a rule that has been throwing for a month looks exactly like a rule finding
 * nothing — the same shape as VX3-4's "do NOT re-post" instruction sitting in a
 * column where only a human would read it. A caller that gets `failed: [...]`
 * can put it on the screen.
 */
export async function runFraudScan(
  tx: QueryRunner,
  cfg: FraudConfig,
  onlyRules?: readonly string[],
): Promise<ScanResult> {
  await requireModule(tx, 'compliance');

  const result: ScanResult = {
    created: 0,
    refreshed: 0,
    suppressed: 0,
    perRule: {},
    failed: [],
  };

  for (const detector of DETECTORS) {
    if (onlyRules && !onlyRules.includes(detector.code)) continue;
    let findings: Finding[];
    try {
      findings = await detector.run(tx, cfg);
    } catch (err) {
      result.failed.push({
        code: detector.code,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    result.perRule[detector.code] = findings.length;
    const { created, refreshed } = await reconcile(tx, findings);
    result.created += created;
    result.refreshed += refreshed;
    result.suppressed += findings.length - created - refreshed;
  }

  return result;
}

/**
 * Every entitled tenant, one after another — what the scheduled route calls.
 *
 * ── PER TENANT, WITH THAT TENANT'S OWN THRESHOLDS ───────────────────────────
 *
 * The point of the whole arrangement, and MT-5's finding against upstream in one
 * function: theirs is an unconditional global cron reading a global config, so
 * every tenant gets everybody's schedule and everybody's idea of an outlier.
 * `organizationsWithModule` supplies the entitled list and `loadFraudConfig` is
 * read inside each tenant's own transaction.
 *
 * ONE TENANT'S FAILURE DOES NOT STOP THE REST, and it is REPORTED. A scan that
 * dies on tenant three leaves tenants four onward silently unscanned, which is
 * the same "looks like nothing was found" shape this module keeps guarding
 * against — one level up from `runFraudScan`'s per-rule handling.
 *
 * SEQUENTIAL, deliberately. These are heavy read-mostly queries and the pool is
 * shared with everybody's requests; a fan-out that ran fifty tenants at once
 * would turn a nightly job into an outage. There is no ordering requirement, so
 * this is purely about not being the loudest thing on the database.
 */
export interface ScanSweepResult {
  organizations: number;
  created: number;
  refreshed: number;
  suppressed: number;
  failed: Array<{ organizationId: string; error: string }>;
}

export async function scanAllTenants(): Promise<ScanSweepResult> {
  const orgs = await organizationsWithModule('compliance');
  const out: ScanSweepResult = {
    organizations: 0,
    created: 0,
    refreshed: 0,
    suppressed: 0,
    failed: [],
  };
  for (const orgId of orgs) {
    try {
      const result = await withOrg(orgId, async (tx) => {
        const cfg = await loadFraudConfig(tx);
        return runFraudScan(tx, cfg);
      });
      out.organizations += 1;
      out.created += result.created;
      out.refreshed += result.refreshed;
      out.suppressed += result.suppressed;
      // A RULE that failed is already in `result.failed`; a tenant whose whole
      // scan failed is the entry below. Both are surfaced, at their own level.
      for (const f of result.failed) {
        out.failed.push({ organizationId: orgId, error: `${f.code}: ${f.error}` });
      }
    } catch (err) {
      out.failed.push({
        organizationId: orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
