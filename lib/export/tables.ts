/**
 * VX5-12 — what a tenant's export contains, and what it deliberately does not.
 *
 * ── THE ENUMERATION IS THE TICKET ──────────────────────────────────────────
 *
 * A per-tenant export is a legal deliverable, so the interesting property is
 * COMPLETENESS, and the interesting failure is a table that exists and is not in
 * it. This product has learned that a hand-kept list of things-to-cover drifts
 * silently three separate times — `check:titles` globs the route tree rather
 * than keeping a map of pages (UD-16), `RULE_PARAM_COPY`'s coverage comes from
 * walking `RULE_DEFINITIONS` rather than from a union somebody types (#121), and
 * `check:i18n`'s dead-catalogue rule exists because a catalogue with full
 * coverage of its own union had no readers at all (#119).
 *
 * So this file does not enumerate the tenant's data. **The DATABASE enumerates
 * it** — every table carrying `organization_id` — and this file says, for each
 * one, either how it is exported or why it is not.
 * `test/export-coverage.db.test.ts` reads `information_schema` and refuses:
 *
 *   · a tenant table named in neither map,
 *   · an entry naming a table that no longer exists,
 *   · a COLUMN of an exported table that is neither exported nor redacted.
 *
 * That last one is what makes this safe over time rather than today. A migration
 * that adds a column gets a failing build and a decision to make, which is the
 * only mechanism that has ever worked here — and the column-level case is not
 * hypothetical: `integration_installation` gained six OAuth columns in VX3-8,
 * two of them bearer tokens.
 *
 * ── WHY `SELECT *` AND A REDACTION LIST, RATHER THAN A COLUMN LIST ─────────
 *
 * Both are enumerations; they differ in which direction they fail.
 *
 * A hand-typed column list fails CLOSED — a new column is silently absent, and
 * the export is quietly incomplete. Incompleteness is the thing this ticket
 * exists to prevent, and it is invisible: nobody notices a missing column in
 * somebody else's export.
 *
 * `SELECT *` minus a redaction list fails OPEN — a new column is silently
 * PRESENT, and a new secret column would leak. That failure is louder in
 * consequence and, crucially, it is the one a test can catch: the column exists
 * in the catalogue, so a coverage test can demand a decision about it. The
 * missing column cannot be caught, because there is nothing to compare against.
 *
 * So: `SELECT *`, a redaction list that carries a REASON per column, and a test
 * that turns a new column into a build failure. Fail open where a test can close
 * it, rather than fail closed where nothing can.
 */

export interface ExportedTable {
  /** The file's name inside the archive. */
  file: string;
  /**
   * Columns withheld, each with the reason. A reason rather than a bare list
   * because "why is this not in my export" is a question a customer, an auditor
   * or a regulator can ask, and the answer should not be archaeology.
   */
  redact?: Readonly<Record<string, string>>;
  /**
   * Deterministic ordering. Defaults to the table's primary key, read from the
   * catalogue at export time — one less list to hand-maintain. Override where
   * the primary key is not the meaningful order.
   */
  orderBy?: string;
}

/**
 * Every tenant-scoped table that IS exported.
 *
 * `organization` is here too even though it is not tenant-scoped (it has no
 * `organization_id` — it is the table the tenant id comes FROM), because the
 * tenant's own organization row is unambiguously the tenant's own data.
 */
export const EXPORTED: Readonly<Record<string, ExportedTable>> = {
  organization: {
    file: 'organization.csv',
    redact: {
      logo_bytes:
        'binary. A base64 blob in a CSV is unreadable and can dwarf the rest of the file; ' +
        'the logo is delivered in the files archive instead.',
    },
  },

  /* ── people and structure ─────────────────────────────────────────────── */
  app_user: { file: 'users.csv' },
  department: { file: 'departments.csv' },
  business_unit: { file: 'business-units.csv' },
  // External IDs (the Wave 1 port): the outside systems the tenant federates to, and each
  // business unit's id in them. The tenant's own mapping, so it leaves with the tenant.
  external_id_source: { file: 'external-id-sources.csv' },
  business_unit_external_id: { file: 'business-unit-external-ids.csv' },
  legal_entity_external_id: { file: 'legal-entity-external-ids.csv' },
  department_external_id: { file: 'department-external-ids.csv' },
  // Job levels and fiscal years (the Wave 1 port), with their External IDs.
  job_level: { file: 'job-levels.csv' },
  job_level_external_id: { file: 'job-level-external-ids.csv' },
  fiscal_year: { file: 'fiscal-years.csv' },
  fiscal_year_external_id: { file: 'fiscal-year-external-ids.csv' },
  // Exchange rates (the Wave 1 FX port, 0051): per tenant since then, so the rates the
  // tenant converted at leave with the tenant.
  fx_rate: { file: 'fx-rates.csv' },
  // Mileage rates (the Wave 1 port, 0052): the rules, their bands, and who each covers.
  mileage_rate: { file: 'mileage-rates.csv' },
  mileage_rate_tier: { file: 'mileage-rate-tiers.csv' },
  mileage_rate_subject: { file: 'mileage-rate-subjects.csv' },
  // Per-diem rates (the Wave 1 port, 0053).
  per_diem_rate: { file: 'per-diem-rates.csv' },
  legal_entity: { file: 'legal-entities.csv' },
  invite: {
    file: 'invites.csv',
    redact: {
      token_hash:
        'a live credential. It is a hash and cannot be reversed into a usable link, but ' +
        'exporting hashes of unexpired invitations is hygiene nobody is served by.',
    },
  },

  /* ── the expense record itself ────────────────────────────────────────── */
  expense: { file: 'expenses.csv' },
  expense_line_item: { file: 'expense-line-items.csv' },
  // The Wave 2 schema (0054): how each expense is coded, and who was at it.
  expense_allocation: { file: 'expense-allocations.csv' },
  expense_attendee: { file: 'expense-attendees.csv' },
  expense_category: { file: 'expense-categories.csv' },
  expense_report: { file: 'expense-reports.csv' },
  expense_report_event: { file: 'expense-report-events.csv' },
  receipt: {
    file: 'receipts.csv',
    // `s3_key` is NOT redacted: it is the join key between this CSV and the
    // files archive, and without it a receipt bundle is a folder of filenames
    // nobody can attach back to an expense.
  },
  // w3-01 (0056): what was read off each receipt, and who signed the reading off. Nothing
  // redacted: `data` and `raw_response` are the model's reading of the tenant's own
  // document, and the reading is what put amounts on their expenses — an export without
  // it could not explain where those amounts came from. No column holds a secret.
  document_extraction: { file: 'document-extractions.csv' },
  // w3-02a (0057): what each reading pass concluded for an expense and what a person changed
  // afterwards, and the transaction numbers merchants printed. All the tenant's own records.
  expense_determination: { file: 'expense-determinations.csv' },
  receipt_external_id: { file: 'receipt-external-ids.csv' },
  expense_external_id: { file: 'expense-external-ids.csv' },
  // w3-02a (0057, d43): the model calls made on the tenant's documents — what was read,
  // when, with which model, and how many tokens. The tenant's own usage record.
  ai_usage: {
    file: 'ai-usage.csv',
    redact: {
      cost_micro_usd:
        "Velotech's own provider cost for the call, an informational estimate from its rate " +
        'table. It is not what the tenant is charged — receipt reading is included in the ' +
        'plan, and credits are priced by the platform — so exporting it would state a price ' +
        'the tenant never paid.',
    },
  },

  /* ── policy, approvals, delegation ────────────────────────────────────── */
  // w4-02a: ExpenseOS's rule instances (0064) — the tenant's own policy configuration.
  policy_rule: { file: 'policy-rules.csv' },
  expense_category_policy: { file: 'expense-category-policies.csv' },
  policy_violation: { file: 'policy-violations.csv' },
  delegation: { file: 'delegations.csv' },
  // w4-10a (0068): ExpenseOS's roles — the tenant's system roles and any it builds, with
  // their permission lists. The tenant's own configuration; nothing secret.
  role: { file: 'roles.csv' },
  // w4-10c (0070): each role's id in an outside system, as the other External IDs.
  role_external_id: { file: 'role-external-ids.csv' },
  // w4-08 (0067): ExpenseOS's saved views — people's own filter and column choices on a list.
  // The tenant's own records; nothing secret.
  saved_view: { file: 'saved-views.csv' },
  // w4-00a (0058): ExpenseOS's workflow engine — the workflows a tenant authored, their
  // versions and the runs and tasks they produced. The tenant's own records; nothing secret.
  approval_workflow: { file: 'approval-workflows.csv' },
  approval_workflow_version: { file: 'approval-workflow-versions.csv' },
  approval_instance: { file: 'approval-instances.csv' },
  approval_instance_task: { file: 'approval-instance-tasks.csv' },

  /* ── accounting ───────────────────────────────────────────────────────── */
  gl_account: { file: 'gl-accounts.csv' },
  integration_installation: {
    file: 'integrations.csv',
    redact: {
      config:
        'encrypted credentials. The tenant supplied these, so a case could be made for ' +
        'returning them — but they are stored under the SERVER\'s key and are useless ' +
        'outside it, so the export would be ciphertext nobody can open plus an attack ' +
        'surface for anybody who obtains the file.',
      oauth_access_token: 'a live bearer token for the tenant\'s accounting system.',
      oauth_refresh_token:
        'a live refresh token — worse than the access token, because it does not expire ' +
        'on its own.',
    },
  },
  integration_post: { file: 'integration-posts.csv' },

  /* ── budgets and spend ────────────────────────────────────────────────── */
  budget: { file: 'budgets.csv' },
  budget_period: { file: 'budget-periods.csv' },
  budget_alert_threshold: { file: 'budget-alert-thresholds.csv' },
  budget_alert_recipient: { file: 'budget-alert-recipients.csv' },
  budget_alert_claim: { file: 'budget-alert-claims.csv' },

  /* ── controls, fraud, audit ───────────────────────────────────────────── */
  control_evaluation_run: { file: 'control-runs.csv' },
  control_finding: { file: 'control-findings.csv' },
  fraud_flag: { file: 'fraud-flags.csv' },
  audit_entry: {
    file: 'audit-log.csv',
    // BY SEQUENCE, not by the primary key. `audit_entry` is a hash chain: each
    // row's hash covers its predecessor's, so the order IS part of the data. A
    // uuid ordering would hand somebody a log they cannot verify and no way to
    // know why.
    orderBy: 'sequence ASC',
  },

  /* ── notifications and preferences ────────────────────────────────────── */
  notification: { file: 'notifications.csv' },
  notification_delivery: { file: 'notification-deliveries.csv' },
  notification_preference: { file: 'notification-preferences.csv' },
  notification_template: { file: 'notification-templates.csv' },
  activity: { file: 'activity.csv' },

  /* ── entitlement and billing MIRROR ───────────────────────────────────── */
  //
  // Exported, with a caveat that belongs in the manifest rather than here: these
  // are what the VeloTech platform told this product, mirrored. They are not
  // invoices and not a billing record — `mirrored_at` says when the platform
  // last answered. The authoritative version lives on the platform.
  module_entitlement: { file: 'module-entitlements.csv' },
  subscription: { file: 'subscription-mirror.csv' },
  subscription_meter_reading: { file: 'meter-readings.csv' },
};

/**
 * Every tenant-scoped table that is NOT exported, and why.
 *
 * A table is only allowed in here for a reason that survives being read out to
 * the customer whose data it is. "Internal" is not a reason; "this row is
 * protocol scaffolding with a two-minute lifetime and is not a record of
 * anything" is.
 */
export const EXCLUDED: Readonly<Record<string, string>> = {
  signup: [
    'A tenant cannot see its own signup row and that is deliberate: `0035` gives this',
    'table NO tenant_isolation policy at all, so `app.current_org` matches nothing here.',
    'Exporting it would be a hatch around that decision, taken by an export screen. The',
    'row also holds a token hash and describes a moment before the tenant existed.',
  ].join(' '),

  integration_oauth_state: [
    'CSRF scaffolding with a lifetime measured in minutes — a state hash, a redirect URI',
    'and an expiry. It is not a record of anything the tenant did; it is how one click',
    'was tied to the next. The credential it holds is the whole content.',
  ].join(' '),

  tenant_export: [
    'The export ledger itself. A row here says an export was requested and where the',
    'archive went; including it makes every export contain a partial history of the',
    'previous ones and a storage key for each. The request is visible on the screen that',
    'made it, which is where somebody asking "did my export run" is already looking.',
  ].join(' '),
};

/** Names of the files this export produces, for the manifest and the tests. */
export function exportedFiles(): string[] {
  return Object.values(EXPORTED)
    .map((t) => t.file)
    .sort();
}
