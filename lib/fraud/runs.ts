/**
 * VX4-8 part 4 — reading control evaluation runs and their findings.
 *
 * Separate from `evaluate.ts`, which WRITES them. The split is the same one
 * `rules.ts`/`scan.ts` has and it earns its keep the same way: a screen that only
 * reads should not be able to reach the thing that runs a sweep across every
 * tenant.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { ControlSeverity } from '@/lib/fraud/controls';
import type { ControlRunStatus } from '@/lib/fraud/evaluate';

export interface RunRow {
  id: string;
  status: ControlRunStatus;
  started_at: Date;
  completed_at: Date | null;
  period_start: Date;
  period_end: Date;
  requested_by_name: string | null;
  summary: {
    perControl?: Record<string, number>;
    failedControls?: Record<string, string>;
    total?: number;
  } | null;
  error: string | null;
  /** Counted rather than trusted from the summary — see the note below. */
  finding_count: number;
}

/**
 * The last runs, newest first.
 *
 * `finding_count` is COUNTED from `control_finding` rather than read out of
 * `summary.total`, and the difference matters exactly once: a run that FAILED
 * part-way has a summary describing what it managed and rows for only some of it.
 * Two numbers that can disagree, one of which is the rows a person can actually
 * open — so the screen shows that one, and the summary stays what it is, a record
 * of what the run believed.
 */
export async function listRuns(tx: QueryRunner, limit = 20): Promise<RunRow[]> {
  const r = await tx.query(
    `SELECT run.id, run.status, run.started_at, run.completed_at, run.period_start,
            run.period_end, run.requested_by_name, run.summary, run.error,
            (SELECT count(*) FROM control_finding f WHERE f.run_id = run.id)::int
              AS finding_count
       FROM control_evaluation_run run
      ORDER BY run.started_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return r.rows as RunRow[];
}

export interface FindingRow {
  id: string;
  control_code: string;
  severity: ControlSeverity;
  subject_type: string;
  subject_id: string | null;
  subject_label: string | null;
  message_code: string;
  data: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

/**
 * One run's findings, worst first.
 *
 * The subject is NOT joined to its report or category, and that is the schema's
 * argument showing through: `subject_id` has no foreign key because a run is a
 * snapshot that must survive its subject, so a join here would quietly drop
 * exactly the findings whose subject has since been deleted — the ones an
 * auditor is most likely to be asking about. `subject_label` is what the run
 * recorded, and it is what the screen shows.
 */
export async function runFindings(tx: QueryRunner, runId: string): Promise<FindingRow[]> {
  const r = await tx.query(
    `SELECT id, control_code, severity, subject_type, subject_id, subject_label,
            message_code, data, evidence
       FROM control_finding
      WHERE run_id = $1
      ORDER BY severity DESC, control_code, subject_label NULLS LAST`,
    [runId],
  );
  return r.rows as FindingRow[];
}
