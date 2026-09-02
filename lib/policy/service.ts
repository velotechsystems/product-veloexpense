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
import { getReportWorkbench, type WorkbenchReport } from '@/lib/expenses/service';
import { buildRateLookup, type RateLookup, type RateRow } from '@/lib/policy/rates';
import {
  clampSeverity,
  DEFAULT_POLICIES,
  evaluatePolicies,
  findingIdentity,
  isRuleKind,
  isSeverity,
  ruleDefinition,
  severityExceeds,
  type PolicyRow,
  type RuleKind,
  type Severity,
} from '@/lib/policy/rules';
import { loadBudgetSnapshots } from '@/lib/budgets/service';

// Convenience re-exports so callers need only one import.
export { RULE_DEFINITIONS, RULE_KINDS, SEVERITIES, ruleDefinition } from '@/lib/policy/rules';
export type { PolicyRow, RuleKind, Severity } from '@/lib/policy/rules';

const ORG = "current_setting('app.current_org', true)::uuid";

export type PolicyErrorCode =
  | 'NOT_FOUND'
  | 'UNKNOWN_RULE_KIND'
  | 'UNKNOWN_SEVERITY'
  /** The rule kind declares a maximum severity and the instance asked for more. */
  | 'SEVERITY_ABOVE_MAXIMUM'
  | 'INVALID_PARAM'
  | 'MISSING_PARAM'
  | 'CATEGORY_NOT_SCOPEABLE'
  | 'CATEGORY_NOT_FOUND'
  | 'DUPLICATE_RULE'
  | 'CANNOT_ACKNOWLEDGE_BLOCK'
  | 'NOTE_REQUIRED'
  /** No tenant context, so there is no policy currency to evaluate against. */
  | 'NO_TENANT';

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
  /** null = the organization's policy currency (VX3-2 / PE-1). */
  currencyCode?: string | null;
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

/**
 * A currency code that exists, or null for "the organization's".
 *
 * Checked here rather than left to the foreign key so the error is a sentence
 * about a currency instead of a constraint name, and because `null` and `'null'`
 * arriving off a form are different things.
 */
async function assertCurrency(tx: QueryRunner, code: string | null): Promise<string | null> {
  if (code === null || code === '') return null;
  const upper = code.trim().toUpperCase();
  const r = await tx.query('SELECT code FROM currency WHERE code = $1', [upper]);
  if (r.rows.length === 0) {
    throw new PolicyError(`unknown currency: ${code}`, 'INVALID_PARAM');
  }
  return upper;
}

function assertSeverity(severity: string): Severity {
  if (!isSeverity(severity)) throw new PolicyError(`unknown severity: ${severity}`, 'UNKNOWN_SEVERITY');
  return severity;
}

/**
 * A severity this rule kind will actually evaluate at — the WRITE half of the
 * clamp (`RuleDefinition.maxSeverity`).
 *
 * The read half in `validateReport` is what makes the maximum true; this is what
 * makes it honest. Without it an admin sets a budget rule to BLOCK, the form says
 * BLOCK, the list says BLOCK, and every report evaluates at WARNING — a stored
 * value that disagrees with behaviour, which is worse than the behaviour alone.
 * Being told no is the courtesy owed to somebody who asked for something the
 * product has decided against.
 */
function assertSeverityForKind(kind: RuleKind, severity: string): Severity {
  const checked = assertSeverity(severity);
  const definition = ruleDefinition(kind);
  const maximum = definition.maxSeverity;
  if (maximum !== undefined && severityExceeds(checked, maximum)) {
    throw new PolicyError(
      `${definition.label} cannot be set to ${checked}: this rule never goes above ${maximum}`,
      'SEVERITY_ABOVE_MAXIMUM',
    );
  }
  return checked;
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

/* ── the tenant's policy currency (VX3-2) ──────────────────────────────────── */

export interface PolicyCurrencyInfo {
  code: string;
  /** Every currency a report in this tenant is actually written in. */
  reportCurrencies: string[];
  /** Pairs a lookup could resolve, direct or by reciprocal. */
  convertible: string[];
  /**
   * Report currencies that CANNOT be converted into the policy currency, so every
   * amount threshold is unenforceable for them. This is the number that matters:
   * an admin who changes the policy currency and gets this wrong finds out through
   * INFO findings on individual reports, which is late.
   */
  unconvertible: string[];
}

/**
 * PE-8 — THE TENANT'S POLICY CURRENCY, and it refuses rather than assuming one.
 *
 * Two call sites used to read this with the same query and the same fallback:
 *
 *     const code = (org.rows[0]?.policy_currency_code as string | undefined) ?? 'CAD';
 *
 * `organization.policy_currency_code` is `NOT NULL DEFAULT 'CAD' REFERENCES
 * currency(code)`, so the column cannot be null and the fallback looked like dead
 * defence. It is not. With no tenant context the WHERE matches no row, and the
 * fallback answered **CAD** — policy evaluated against a currency nobody chose,
 * which is PE-1's family. A scheduled job is exactly the caller that arrives this
 * way (MT-5 / VX0-8), and `lib/expenses/service.ts` already had the right shape:
 * an explicit `NO_TENANT`. This is now the single reader both call sites share,
 * because two copies of a query are how they became two copies of a bad default.
 *
 * NOTE THE `NULLIF`, which the first version of this fix did not have and needed.
 * `set_config(k, v, is_local => true)` does not leave the GUC *undefined* once the
 * transaction ends — it leaves it defined as the EMPTY STRING. So on a pooled
 * connection that has served one `withOrg` call, `current_setting('app.current_org',
 * true)` returns `''` rather than NULL for the rest of that connection's life, and
 * a bare `::uuid` raises `22P02 invalid input syntax for type uuid: ""`. The
 * unguarded cast therefore had TWO no-context outcomes, not one — CAD on a fresh
 * connection, an unintelligible uuid syntax error on a recycled one — and only the
 * `NULLIF` form refuses the same way every time. Every RLS policy body in the
 * schema is written `NULLIF(current_setting('app.current_org', true), '')::uuid`
 * for this exact reason; the application-side copies of the expression were not.
 * See the note filed against `const ORG` in the gap audit (PE-9).
 *
 * EXPORTED as of VX4-6a. Analytics needs the tenant's base currency on a path
 * where `getPolicyCurrency`'s three extra queries — every report currency, every
 * rate, the convertibility diff — are diagnostics it does not want. Exporting the
 * slim reader is the alternative to a third copy of this query, which is exactly
 * what PE-8 was about.
 */
export async function policyCurrencyCode(tx: QueryRunner): Promise<string> {
  const org = await tx.query(
    `SELECT policy_currency_code FROM organization
      WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`,
  );
  if (org.rows.length === 0) {
    throw new PolicyError(
      'no tenant context, so there is no policy currency to evaluate against',
      'NO_TENANT',
    );
  }
  return org.rows[0].policy_currency_code as string;
}

export async function getPolicyCurrency(tx: QueryRunner): Promise<PolicyCurrencyInfo> {
  const code = await policyCurrencyCode(tx);

  const used = await tx.query(
    'SELECT DISTINCT currency_code FROM expense_report ORDER BY currency_code',
  );
  const reportCurrencies = used.rows.map((r) => r.currency_code as string);

  const rates = await tx.query('SELECT base, quote, rate, as_of FROM fx_rate ORDER BY as_of DESC');
  const lookup = buildRateLookup(rates.rows as RateRow[]);
  const unconvertible = reportCurrencies.filter((from) => lookup.find(from, code) === null);
  return { code, reportCurrencies, convertible: lookup.pairs(), unconvertible };
}

export async function setPolicyCurrency(tx: QueryRunner, code: string): Promise<void> {
  const checked = await assertCurrency(tx, code);
  if (checked === null) throw new PolicyError('a policy currency is required', 'MISSING_PARAM');
  // `organization` carries no organization_id and so is not RLS-scoped — the
  // session variable is what names the row, and the WHERE is what keeps this from
  // being an update across every tenant.
  const done = await tx.query(
    `UPDATE organization SET policy_currency_code = $1, updated_at = now()
      WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`,
    [checked],
  );
  // PE-8, the write half. `organization` always has the row when there IS a
  // tenant, so nought rows means the WHERE named nobody — and a write that
  // quietly changes nothing is the worse half of the same bug the reader had.
  if (done.rowCount === 0) {
    throw new PolicyError(
      'no tenant context, so there is no policy currency to set',
      'NO_TENANT',
    );
  }
}

/* ── policy CRUD ───────────────────────────────────────────────────────────── */

const SELECT_POLICY = `
  SELECT p.id, p.kind, p.severity, p.enabled, p.category_id, c.label AS category_label,
         p.currency_code, p.params, p.effective_from, p.effective_to,
         p.created_at, p.updated_at
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
  const severity = assertSeverityForKind(kind, input.severity ?? ruleDefinition(kind).defaultSeverity);
  const categoryId = input.categoryId ?? null;
  await assertCategory(tx, kind, categoryId);
  const params = normalizeParams(kind, input.params);

  let inserted;
  try {
    inserted = await tx.query(
      `INSERT INTO expense_policy
         (organization_id, kind, severity, enabled, category_id, currency_code, params,
          effective_from, effective_to)
       VALUES (${ORG}, $1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id`,
      [
        kind,
        severity,
        input.enabled ?? true,
        categoryId,
        await assertCurrency(tx, input.currencyCode ?? null),
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

  if (patch.severity !== undefined) {
    set('severity', assertSeverityForKind(current.kind, patch.severity));
  }
  if (patch.enabled !== undefined) set('enabled', patch.enabled);
  if ('categoryId' in patch) {
    await assertCategory(tx, current.kind, patch.categoryId ?? null);
    set('category_id', patch.categoryId ?? null);
  }
  if (patch.params !== undefined) {
    set('params', JSON.stringify(normalizeParams(current.kind, patch.params)));
    sets[sets.length - 1] += '::jsonb';
  }
  if ('currencyCode' in patch) {
    set('currency_code', await assertCurrency(tx, patch.currencyCode ?? null));
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
               v.rule_code, v.finding_key, v.created_at, v.id`,
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

/**
 * The currency half of a rule's context: the tenant's policy currency, the minor
 * units of every currency in play, and the rate lookup (VX3-2 / PE-1).
 *
 * Loaded HERE rather than inside a rule because `rules.ts` is a pure registry —
 * it may not touch `pg` — and because one load per validation is one load, where
 * a rule-level fetch would be one per rule per line.
 *
 * Rates are bounded by the report's own date where it has one. A report filed in
 * March should be judged against March's rate, not against whatever arrived this
 * morning; and re-validating an old report must not change its findings because
 * the market moved. `txn_date` is per expense and nullable, so the bound is the
 * latest date the report actually carries, falling back to today.
 */
async function currencyContext(
  tx: QueryRunner,
  report: WorkbenchReport,
): Promise<{ policyCurrency: string; minorUnits: Record<string, number>; rates: RateLookup }> {
  const policyCurrency = await policyCurrencyCode(tx);

  const units = await tx.query('SELECT code, minor_unit FROM currency');
  const minorUnits: Record<string, number> = {};
  for (const row of units.rows) minorUnits[row.code as string] = Number(row.minor_unit);

  const bound = await tx.query(
    `SELECT coalesce(max(e.txn_date), current_date) AS as_of
       FROM expense e WHERE e.report_id = $1`,
    [report.id],
  );
  const asOf = bound.rows[0]?.as_of ?? null;

  // ORDER BY as_of DESC so the lookup's "strictly newer wins" tie-break is
  // deterministic rather than dependent on Map insertion order.
  const rates = await tx.query(
    'SELECT base, quote, rate, as_of FROM fx_rate ORDER BY as_of DESC',
  );
  return {
    policyCurrency,
    minorUnits,
    rates: buildRateLookup(rates.rows as RateRow[], asOf ?? undefined),
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
  // Only when a BUDGET_OVERAGE instance is actually enabled. Ported from
  // ExpenseOS's own guard on the same loader (`policy/validate.ts:421-427`) and
  // for the same reason: the budget scan is the expensive part of a validation,
  // and a tenant with no budget rule should not pay for it on every save.
  const wantsBudgets = policies.some((p) => p.kind === 'BUDGET_OVERAGE');
  const evaluated = evaluatePolicies(
    {
      report: context.report,
      expenses: context.expenses,
      ...(await currencyContext(tx, context.report)),
      budgets: wantsBudgets ? await loadBudgetSnapshots(tx, reportId) : [],
    },
    policies,
  );

  const desired = new Map<
    string,
    {
      policy: PolicyRow;
      message: string;
      lineItemId: string | null;
      findingKey: string;
      data: Record<string, unknown>;
      /** PE-3: a finding may downgrade its own severity — see `Finding.severity`. */
      severity: Severity;
    }
  >();
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
        // The finding's own severity wins where it states one. Same resolution as
        // ExpenseOS's `f.severity ?? inst.severity`, and it is what lets a rule
        // that could not convert an amount report INFO instead of firing a BLOCK
        // on an unchecked comparison.
        //
        // THEN CLAMPED to the rule kind's maximum — the READ half, and the half
        // that makes the maximum an invariant rather than a form validation.
        // `createPolicy`/`updatePolicy` already refuse a severity above it, so
        // this looks redundant and is not: a row written by a seed, an import,
        // Phase 5's provisioning, or simply before the maximum existed reaches
        // here without ever passing through those. BG-4 is what happens when only
        // the comment exists — `severity: f.severity ?? inst.severity` with a rule
        // documented "deliberately never BLOCK", and an instance at BLOCK turning
        // it into a hard stop.
        severity: clampSeverity(
          finding.severity ?? policy.severity,
          ruleDefinition(policy.kind).maxSeverity,
        ),
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
    const clearResolution = want.severity === 'BLOCK' && row.resolved_at !== null;
    await tx.query(
      `UPDATE policy_violation
          SET severity = $2, message = $3, data = $4::jsonb, policy_id = $5
              ${clearResolution ? ', resolved_at = NULL, resolved_by_id = NULL, resolve_note = NULL' : ''}
        WHERE id = $1`,
      [row.id, want.severity, want.message, JSON.stringify(want.data), want.policy.id],
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
        // `want.severity`, NOT `want.policy.severity`. A finding may downgrade its
        // own (PE-3), and this is the FIRST-evaluation path — passing the policy's
        // here made the override work only on re-validation, which is precisely the
        // run nobody looks at. A test caught it.
        want.severity,
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
