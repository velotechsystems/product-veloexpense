/**
 * VX4-8 part 3 — running a control evaluation and persisting it as a snapshot.
 *
 * ── THE RUN ROW IS WRITTEN FIRST ────────────────────────────────────────────
 *
 * `RUNNING` before any check executes, then `COMPLETED` or `FAILED`. Ported with
 * upstream's reasoning, which is this project's own standing lesson in somebody
 * else's words: "writing the row only on success would make a run that died
 * halfway simply not exist, and 'no findings' and 'never ran' would look
 * identical — the exact failure mode this module exists to catch elsewhere."
 *
 * ── AND THAT FORCED A DECISION THIS PORT HAD TO MAKE ────────────────────────
 *
 * A row written first and updated at the end cannot share ONE transaction with
 * the work, or a crash rolls the row back too and there is nothing to find. So
 * `runControlEvaluation` takes an ORG ID rather than a `QueryRunner`, and opens
 * three transactions of its own: one to open the run, one per control to write
 * its findings, one to close it.
 *
 * That is a deliberate break from this codebase's usual shape — VX3-4's
 * `enqueuePost` is a row in the approving transaction precisely SO THAT it cannot
 * be half-done. The difference is what the row means. An outbox row is a promise
 * that must be kept or not made; a run row is a RECORD OF AN ATTEMPT, and an
 * attempt that failed is the most important thing it can say. The two arguments
 * point opposite ways because they are about different things, and this comment
 * exists so the next reader does not "fix" one into the other.
 *
 * A single control that throws is recorded in the summary and the run continues.
 * The RUN is FAILED only when it cannot be completed at all.
 */
import { withOrg } from '@/lib/tenant/context';
import { organizationsWithModule, requireModule } from '@/lib/modules/service';
import {
  CONTROL_CHECKS,
  DEFAULT_CONTROL_CONFIG,
  defaultPeriod,
  loadControlConfig,
  type ControlConfig,
  type ControlFinding,
  type Period,
} from '@/lib/fraud/controls';
import { ORG } from '@/lib/tenant/sql';

/** Every value `control_evaluation_run.status` can hold. See FLAG_STATUSES. */
export const CONTROL_RUN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED'] as const;
export type ControlRunStatus = (typeof CONTROL_RUN_STATUSES)[number];

export interface EvaluateResult {
  runId: string;
  status: Extract<ControlRunStatus, 'COMPLETED' | 'FAILED'>;
  findings: number;
  perControl: Record<string, number>;
  /**
   * Controls that threw, by code. Present in the RESULT and in the run's summary
   * so a skipped check cannot read as a passing one — the same reason
   * `runFraudScan` returns its failures rather than logging them.
   */
  failedControls: Record<string, string>;
  period: Period;
  config: ControlConfig;
}

export interface EvaluateOptions {
  period?: Period;
  cfg?: ControlConfig;
  /**
   * Who asked. NULL for a scheduled run — and the NAME is snapshotted beside the
   * id rather than joined later, because the run outlives the people it describes
   * (migration 0032).
   */
  requestedById?: string | null;
  requestedByName?: string | null;
}

/**
 * Run every control for one organization and record the result.
 *
 * Takes an ORG ID, not a transaction — see the header. Gated on the `compliance`
 * module in the service layer, like `runFraudScan`.
 */
export async function runControlEvaluation(
  orgId: string,
  opts: EvaluateOptions = {},
): Promise<EvaluateResult> {
  const period = opts.period ?? defaultPeriod();
  const cfg =
    opts.cfg ?? (await withOrg(orgId, (tx) => loadControlConfig(tx))) ?? DEFAULT_CONTROL_CONFIG;

  // The gate goes with the FIRST write, so a tenant without the module never gets
  // a run row at all — a RUNNING row nobody will ever close is worse than a
  // refusal, and it is what gating later would leave behind.
  const runId = await withOrg(orgId, async (tx) => {
    await requireModule(tx, 'compliance');
    const r = await tx.query(
      `INSERT INTO control_evaluation_run
         (organization_id, period_start, period_end, requested_by_id, requested_by_name)
       VALUES (${ORG}, $1, $2, $3, $4)
       RETURNING id`,
      [period.start, period.end, opts.requestedById ?? null, opts.requestedByName ?? null],
    );
    return r.rows[0].id as string;
  });

  const perControl: Record<string, number> = {};
  const failedControls: Record<string, string> = {};
  let total = 0;

  try {
    for (const check of CONTROL_CHECKS) {
      let findings: ControlFinding[];
      try {
        findings = await withOrg(orgId, (tx) => check.run(tx, period, cfg));
      } catch (err) {
        // Recorded, not swallowed: an absent count reads as "ran, passed".
        failedControls[check.code] = err instanceof Error ? err.message : String(err);
        continue;
      }
      perControl[check.code] = findings.length;
      total += findings.length;
      if (findings.length === 0) continue;

      // One statement per control, whatever the number of findings. No ON
      // CONFLICT and no dedupe key: a run is a snapshot, so every row is new by
      // construction — which is the whole difference from `fraud_flag`.
      await withOrg(orgId, (tx) =>
        tx.query(
          `INSERT INTO control_finding
             (organization_id, run_id, control_code, severity, subject_type, subject_id,
              subject_label, message_code, data, evidence)
           SELECT ${ORG}, $1,
                  t.control_code, t.severity::control_severity, t.subject_type, t.subject_id,
                  t.subject_label, t.message_code, t.data, t.evidence
             FROM unnest($2::text[], $3::text[], $4::text[], $5::uuid[], $6::text[],
                         $7::text[], $8::jsonb[], $9::jsonb[])
               AS t(control_code, severity, subject_type, subject_id, subject_label,
                    message_code, data, evidence)`,
          [
            runId,
            findings.map((f) => f.controlCode),
            findings.map((f) => f.severity),
            findings.map((f) => f.subjectType),
            findings.map((f) => f.subjectId),
            findings.map((f) => f.subjectLabel),
            findings.map((f) => f.messageCode),
            findings.map((f) => JSON.stringify(f.data)),
            findings.map((f) => JSON.stringify(f.evidence)),
          ],
        ),
      );
    }

    await withOrg(orgId, (tx) =>
      tx.query(
        `UPDATE control_evaluation_run
            SET status = 'COMPLETED', completed_at = clock_timestamp(), summary = $2
          WHERE id = $1`,
        [runId, JSON.stringify({ perControl, failedControls, total, config: cfg })],
      ),
    );
    return {
      runId,
      status: 'COMPLETED',
      findings: total,
      perControl,
      failedControls,
      period,
      config: cfg,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The close-out is best-effort. If THIS fails too the row stays RUNNING,
    // which is still a truthful thing for it to say — an attempt that never
    // reported back — and is exactly what the RUNNING state is for.
    await withOrg(orgId, (tx) =>
      tx.query(
        `UPDATE control_evaluation_run
            SET status = 'FAILED', completed_at = clock_timestamp(), error = $2, summary = $3
          WHERE id = $1`,
        [runId, message, JSON.stringify({ perControl, failedControls, total, config: cfg })],
      ),
    ).catch(() => {});
    return {
      runId,
      status: 'FAILED',
      findings: total,
      perControl,
      failedControls,
      period,
      config: cfg,
    };
  }
}

/**
 * Every entitled tenant, one after another — what the scheduled route calls.
 *
 * Same shape and the same three arguments as `scanAllTenants`: per-tenant
 * config, one tenant's failure does not stop the rest, and sequential because
 * these are heavy queries on a shared pool.
 *
 * A tenant whose RUN failed is not an entry in `failed` here — it has a FAILED
 * run row of its own, which is the durable record and the one a screen shows.
 * `failed` is for tenants that could not get that far at all.
 */
export interface EvaluateSweepResult {
  organizations: number;
  runs: number;
  findings: number;
  failedRuns: number;
  failed: Array<{ organizationId: string; error: string }>;
}

export async function evaluateAllTenants(
  opts: EvaluateOptions = {},
): Promise<EvaluateSweepResult> {
  const orgs = await organizationsWithModule('compliance');
  const out: EvaluateSweepResult = {
    organizations: 0,
    runs: 0,
    findings: 0,
    failedRuns: 0,
    failed: [],
  };
  for (const orgId of orgs) {
    try {
      const result = await runControlEvaluation(orgId, opts);
      out.organizations += 1;
      out.runs += 1;
      out.findings += result.findings;
      if (result.status === 'FAILED') out.failedRuns += 1;
    } catch (err) {
      out.failed.push({
        organizationId: orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
