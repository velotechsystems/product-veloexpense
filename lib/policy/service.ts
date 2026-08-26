/**
 * VX1-7 — policy service (ExpenseOS Module 9).
 *
 * Same shape as the other domains: pure functions over a tenant QueryRunner,
 * with the server-action layer supplying auth + withCurrentOrg, so RLS scopes
 * every row. Rule TYPES come from lib/policy/rules.ts; this module owns the
 * rule INSTANCE rows, the validation run, and acknowledgement.
 *
 * `validateReport` is deliberately re-runnable and is called inside the same
 * transaction as every save, so a report's violations can never be stale
 * relative to its line items.
 *
 * Re-validation semantics (the part worth reading twice):
 *   - a finding that still fires  → its row is refreshed (message/severity/data)
 *   - a finding that no longer fires → its row is DELETED, acknowledged or not
 *   - an acknowledged finding that still fires → stays acknowledged
 *   - …unless its severity is now BLOCK, in which case the acknowledgement is
 *     cleared, because BLOCK findings must be fixed rather than waved through.
 */
import type { QueryRunner } from '@/lib/db/client';
import { getReportWorkbench } from '@/lib/expenses/service';
import {
  DEFAULT_POLICIES,
  evaluatePolicies,
  findingIdentity,
  isRuleKind,
  isSeverity,
  ruleDefinition,
  type PolicyRow,
  type RuleKind,
  type Severity,
} from '@/lib/policy/rules';

// Convenience re-exports so callers need only one import.
export { RULE_DEFINITIONS, RULE_KINDS, SEVERITIES, ruleDefinition } from '@/lib/policy/rules';
export type { PolicyRow, RuleKind, Severity } from '@/lib/policy/rules';

const ORG = "current_setting('app.current_org', true)::uuid";

export type PolicyErrorCode =
  | 'NOT_FOUND'
  | 'UNKNOWN_RULE_KIND'
  | 'UNKNOWN_SEVERITY'
  | 'INVALID_PARAM'
  | 'MISSING_PARAM'
  | 'CATEGORY_NOT_SCOPEABLE'
  | 'CATEGORY_NOT_FOUND'
  | 'DUPLICATE_RULE'
  | 'CANNOT_ACKNOWLEDGE_BLOCK'
  | 'NOTE_REQUIRED';

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly code: PolicyErrorCode,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface ViolationRow {
  id: string;
  report_id: string;
  line_item_id: string | null;
  policy_id: string | null;
  rule_code: RuleKind;
  severity: Severity;
  message: string;
  finding_key: string;
  data: Record<string, unknown>;
  resolved_at: Date | null;
  resolved_by_id: string | null;
  resolved_by_name: string | null;
  resolve_note: string | null;
  created_at: Date;
}

export interface ValidationSummary {
  violations: ViolationRow[];
  counts: Record<Severity, number>;
  /** True when an unresolved BLOCK finding exists. VX1-8's submit gate reads this. */
  blocking: boolean;
}

export interface NewPolicy {
  kind: string;
  severity?: string;
  enabled?: boolean;
  categoryId?: string | null;
  params?: Record<string, unknown>;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}
export type PolicyPatch = Partial<NewPolicy>;

/* ── param validation ──────────────────────────────────────────────────────── */

/**
 * Keeps only the params the rule kind declares, and coerces amounts to whole
 * minor units. An unknown key is dropped rather than stored — otherwise a typo
 * in the admin form becomes a rule that silently never fires.
 */
function normalizeParams(kind: RuleKind, params: Record<string, unknown> = {}) {
  const definition = ruleDefinition(kind);
  const clean: Record<string, unknown> = {};
  for (const spec of definition.params) {
    const raw = params[spec.name];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (spec.required) {
        throw new PolicyError(`${definition.label} needs ${spec.label}`, 'MISSING_PARAM');
      }
      continue;
    }
    if (spec.type === 'amount') {
      let value: bigint;
      try {
        value = typeof raw === 'bigint' ? raw : BigInt(String(raw).trim());
      } catch {
        throw new PolicyError(`${spec.label} must be a whole number of minor units`, 'INVALID_PARAM');
      }
      if (value < 0n) throw new PolicyError(`${spec.label} cannot be negative`, 'INVALID_PARAM');
      clean[spec.name] = Number(value);
    } else {
      clean[spec.name] = raw === true || raw === 'true' || raw === 'on';
    }
  }
  return clean;
}

function assertKind(kind: string): RuleKind {
  if (!isRuleKind(kind)) throw new PolicyError(`unknown rule kind: ${kind}`, 'UNKNOWN_RULE_KIND');
  return kind;
}

function assertSeverity(severity: string): Severity {
  if (!isSeverity(severity)) throw new PolicyError(`unknown severity: ${severity}`, 'UNKNOWN_SEVERITY');
  return severity;
}

async function assertCategory(tx: QueryRunner, kind: RuleKind, categoryId: string | null) {
  if (!categoryId) return;
  if (!ruleDefinition(kind).supportsCategoryScope) {
    throw new PolicyError(
      `${ruleDefinition(kind).label} applies to the whole report and cannot be scoped to a category`,
      'CATEGORY_NOT_SCOPEABLE',
    );
  }
  const r = await tx.query('SELECT id FROM expense_category WHERE id = $1', [categoryId]);
  if (r.rows.length === 0) {
    throw new PolicyError('category not found in this organization', 'CATEGORY_NOT_FOUND');
  }
}

/* ── policy CRUD ───────────────────────────────────────────────────────────── */

const SELECT_POLICY = `
  SELECT p.id, p.kind, p.severity, p.enabled, p.category_id, c.label AS category_label,
         p.params, p.effective_from, p.effective_to, p.created_at, p.updated_at
    FROM expense_policy p
    LEFT JOIN expense_category c ON c.id = p.category_id`;

export async function listPolicies(tx: QueryRunner): Promise<PolicyRow[]> {
  const r = await tx.query(`${SELECT_POLICY} ORDER BY p.kind, c.label NULLS FIRST`);
  return r.rows as PolicyRow[];
}

export async function getPolicy(tx: QueryRunner, policyId: string): Promise<PolicyRow | null> {
  const r = await tx.query(`${SELECT_POLICY} WHERE p.id = $1`, [policyId]);
  return (r.rows[0] as PolicyRow) ?? null;
}

/** Only enabled rules that are in their effective window today. */
async function activePolicies(tx: QueryRunner): Promise<PolicyRow[]> {
  const r = await tx.query(
    `${SELECT_POLICY}
      WHERE p.enabled
        AND (p.effective_from IS NULL OR p.effective_from <= CURRENT_DATE)
        AND (p.effective_to   IS NULL OR p.effective_to   >= CURRENT_DATE)
      ORDER BY p.kind`,
  );
  return r.rows as PolicyRow[];
}

export async function createPolicy(tx: QueryRunner, input: NewPolicy): Promise<PolicyRow> {
  const kind = assertKind(input.kind);
  const severity = assertSeverity(input.severity ?? ruleDefinition(kind).defaultSeverity);
  const categoryId = input.categoryId ?? null;
  await assertCategory(tx, kind, categoryId);
  const params = normalizeParams(kind, input.params);

  let inserted;
  try {
    inserted = await tx.query(
      `INSERT INTO expense_policy
         (organization_id, kind, severity, enabled, category_id, params, effective_from, effective_to)
       VALUES (${ORG}, $1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING id`,
      [
        kind,
        severity,
        input.enabled ?? true,
        categoryId,
        JSON.stringify(params),
        input.effectiveFrom ?? null,
        input.effectiveTo ?? null,
      ],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new PolicyError(
        `a ${ruleDefinition(kind).label} rule already exists for that scope — edit it instead`,
        'DUPLICATE_RULE',
      );
    }
    throw err;
  }
  return (await getPolicy(tx, inserted.rows[0].id))!;
}

export async function updatePolicy(
  tx: QueryRunner,
  policyId: string,
  patch: PolicyPatch,
): Promise<PolicyRow> {
  const current = await getPolicy(tx, policyId);
  if (!current) throw new PolicyError('policy not found', 'NOT_FOUND');

  const sets: string[] = [];
  const values: unknown[] = [policyId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (patch.severity !== undefined) set('severity', assertSeverity(patch.severity));
  if (patch.enabled !== undefined) set('enabled', patch.enabled);
  if ('categoryId' in patch) {
    await assertCategory(tx, current.kind, patch.categoryId ?? null);
    set('category_id', patch.categoryId ?? null);
  }
  if (patch.params !== undefined) {
    set('params', JSON.stringify(normalizeParams(current.kind, patch.params)));
    sets[sets.length - 1] += '::jsonb';
  }
  if ('effectiveFrom' in patch) set('effective_from', patch.effectiveFrom ?? null);
  if ('effectiveTo' in patch) set('effective_to', patch.effectiveTo ?? null);
  if (sets.length === 0) return current;

  await tx.query(
    `UPDATE expense_policy SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
    values,
  );
  return (await getPolicy(tx, policyId))!;
}

export async function deletePolicy(tx: QueryRunner, policyId: string) {
  // Violations cascade with the rule: a finding raised by a rule that no longer
  // exists is noise nobody can act on.
  await tx.query('DELETE FROM expense_policy WHERE id = $1', [policyId]);
}

/**
 * Idempotent: inserts any starter rule the tenant does not already have (the
 * unique index on kind+scope is what makes re-running safe) and leaves edited
 * ones untouched. This is the only writer of the defaults — `scripts/seed.mjs`
 * deliberately seeds none, so there is nothing to drift.
 */
export async function ensureDefaultPolicies(tx: QueryRunner): Promise<number> {
  let created = 0;
  for (const preset of DEFAULT_POLICIES) {
    const r = await tx.query(
      `INSERT INTO expense_policy (organization_id, kind, severity, params)
       VALUES (${ORG}, $1, $2, $3::jsonb)
       ON CONFLICT (organization_id, kind,
                    COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO NOTHING
       RETURNING id`,
      [preset.kind, preset.severity, JSON.stringify(preset.params)],
    );
    created += r.rows.length;
  }
  return created;
}

/* ── validation ────────────────────────────────────────────────────────────── */

const SELECT_VIOLATION = `
  SELECT v.id, v.report_id, v.line_item_id, v.policy_id, v.rule_code, v.severity, v.message,
         v.finding_key, v.data, v.resolved_at, v.resolved_by_id, u.display_name AS resolved_by_name,
         v.resolve_note, v.created_at
    FROM policy_violation v
    LEFT JOIN app_user u ON u.id = v.resolved_by_id`;

export async function listViolations(tx: QueryRunner, reportId: string): Promise<ViolationRow[]> {
  const r = await tx.query(
    `${SELECT_VIOLATION}
      WHERE v.report_id = $1
      ORDER BY CASE v.severity WHEN 'BLOCK' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
               v.created_at`,
    [reportId],
  );
  return r.rows as ViolationRow[];
}

function summarize(violations: ViolationRow[]): ValidationSummary {
  const counts: Record<Severity, number> = { INFO: 0, WARNING: 0, BLOCK: 0 };
  for (const v of violations) counts[v.severity] += 1;
  return {
    violations,
    counts,
    blocking: violations.some((v) => v.severity === 'BLOCK' && v.resolved_at === null),
  };
}

/** Re-run every rule against one report and reconcile the stored findings. */
export async function validateReport(
  tx: QueryRunner,
  reportId: string,
): Promise<ValidationSummary> {
  const context = await getReportWorkbench(tx, reportId);
  if (!context) throw new PolicyError('report not found', 'NOT_FOUND');

  const policies = await activePolicies(tx);
  const evaluated = evaluatePolicies({ report: context.report, expenses: context.expenses }, policies);

  const desired = new Map<string, { policy: PolicyRow; message: string; lineItemId: string | null; findingKey: string; data: Record<string, unknown> }>();
  for (const { policy, finding } of evaluated) {
    const key = findingIdentity(finding.ruleCode, finding.lineItemId, finding.findingKey);
    // First writer wins for a given identity; a rule that wants several
    // findings at one scope distinguishes them with findingKey.
    if (!desired.has(key)) {
      desired.set(key, {
        policy,
        message: finding.message,
        lineItemId: finding.lineItemId,
        findingKey: finding.findingKey,
        data: finding.data,
      });
    }
  }

  const existing = await tx.query(
    `SELECT id, rule_code, line_item_id, finding_key, resolved_at
       FROM policy_violation WHERE report_id = $1`,
    [reportId],
  );

  const seen = new Set<string>();
  for (const row of existing.rows) {
    const key = findingIdentity(row.rule_code, row.line_item_id, row.finding_key);
    const want = desired.get(key);
    if (!want) {
      // No longer fires — the acknowledgement, if any, goes with it.
      await tx.query('DELETE FROM policy_violation WHERE id = $1', [row.id]);
      continue;
    }
    seen.add(key);
    // BLOCK is never acknowledgeable, so a severity change to BLOCK clears one.
    const clearResolution = want.policy.severity === 'BLOCK' && row.resolved_at !== null;
    await tx.query(
      `UPDATE policy_violation
          SET severity = $2, message = $3, data = $4::jsonb, policy_id = $5
              ${clearResolution ? ', resolved_at = NULL, resolved_by_id = NULL, resolve_note = NULL' : ''}
        WHERE id = $1`,
      [row.id, want.policy.severity, want.message, JSON.stringify(want.data), want.policy.id],
    );
  }

  for (const [key, want] of desired) {
    if (seen.has(key)) continue;
    await tx.query(
      `INSERT INTO policy_violation
         (organization_id, report_id, line_item_id, policy_id, rule_code, severity, message,
          finding_key, data)
       VALUES (${ORG}, $1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        reportId,
        want.lineItemId,
        want.policy.id,
        want.policy.kind,
        want.policy.severity,
        want.message,
        want.findingKey,
        JSON.stringify(want.data),
      ],
    );
  }

  return summarize(await listViolations(tx, reportId));
}

/** Read the stored findings without re-running the rules. */
export async function getValidation(tx: QueryRunner, reportId: string): Promise<ValidationSummary> {
  return summarize(await listViolations(tx, reportId));
}

/* ── acknowledgement ───────────────────────────────────────────────────────── */

/**
 * Module 9's "override a warning with a recorded justification". The note is
 * REQUIRED — an acknowledgement with no reason tells an auditor nothing — and
 * BLOCK findings are refused outright.
 */
export async function acknowledgeViolation(
  tx: QueryRunner,
  violationId: string,
  actorId: string,
  note: string,
): Promise<ViolationRow> {
  const current = await tx.query('SELECT id, severity FROM policy_violation WHERE id = $1', [
    violationId,
  ]);
  if (current.rows.length === 0) throw new PolicyError('violation not found', 'NOT_FOUND');
  if (current.rows[0].severity === 'BLOCK') {
    throw new PolicyError(
      'a blocking violation cannot be acknowledged — it has to be fixed',
      'CANNOT_ACKNOWLEDGE_BLOCK',
    );
  }
  if (!note?.trim()) {
    throw new PolicyError('an acknowledgement needs a note explaining the exception', 'NOTE_REQUIRED');
  }
  await tx.query(
    `UPDATE policy_violation
        SET resolved_at = now(), resolved_by_id = $2, resolve_note = $3
      WHERE id = $1`,
    [violationId, actorId, note.trim()],
  );
  const r = await tx.query(`${SELECT_VIOLATION} WHERE v.id = $1`, [violationId]);
  return r.rows[0] as ViolationRow;
}

export async function clearAcknowledgement(tx: QueryRunner, violationId: string) {
  await tx.query(
    `UPDATE policy_violation
        SET resolved_at = NULL, resolved_by_id = NULL, resolve_note = NULL
      WHERE id = $1`,
    [violationId],
  );
}
