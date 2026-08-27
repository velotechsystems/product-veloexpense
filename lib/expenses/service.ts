/**
 * VX1-4 + VX1-6 — expense-report service (Velotech style: pure functions over a
 * tenant QueryRunner; the server-action layer supplies auth + withCurrentOrg).
 * Every query runs inside a tenant transaction, so RLS scopes all rows to the
 * org; app.current_org is already set by the caller.
 *
 * Hierarchy: expense_report -> expense -> expense_line_item; receipts attach to
 * an expense. Report.total_minor is the sum of its line items (single-currency
 * MVP; FX/tax engine come later).
 *
 * VX1-6 added what the workbench UI needs on top of VX1-4's draft CRUD:
 *   - listReports takes a filter (mine / status / text) and returns counts.
 *   - getReportWorkbench composes the whole editor payload in one transaction.
 *   - expenses and line items can be edited and deleted, not just appended.
 *   - every mutation goes through assertDraft(), so a report that has left
 *     DRAFT is read-only here rather than in the UI only. VX1-8 owns the
 *     transitions; this is the floor it builds on.
 *   - listCategories / listCurrencies back the tenant-scoped pickers.
 *
 * Amounts are bigint minor units end to end. pg returns them as strings; they
 * stay strings until lib/money.ts formats them.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { Actor } from '@/lib/auth/actor';

const ORG = "current_setting('app.current_org', true)::uuid";

export const REPORT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'REIMBURSED',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type ExpenseErrorCode =
  | 'NO_TENANT'
  | 'NOT_FOUND'
  | 'NOT_DRAFT'
  | 'INVALID_TITLE'
  | 'INVALID_AMOUNT'
  | 'SUBMITTER_NOT_FOUND'
  | 'CATEGORY_NOT_FOUND'
  | 'CURRENCY_NOT_FOUND';

export class ExpenseError extends Error {
  constructor(
    message: string,
    readonly code: ExpenseErrorCode,
  ) {
    super(message);
    this.name = 'ExpenseError';
  }
}

/* ── types ─────────────────────────────────────────────────────────────────── */

export interface NewReport {
  title: string;
  purpose?: string | null;
  currencyCode: string;
  businessUnitId?: string | null;
}

/**
 * Patch semantics (same as lib/employees): an ABSENT key leaves the column
 * alone, an explicit null CLEARS it. VX1-4 used COALESCE, which made "clear the
 * purpose" impossible from a form — an empty input silently kept the old value.
 */
export interface ReportPatch {
  title?: string;
  purpose?: string | null;
  businessUnitId?: string | null;
  currencyCode?: string;
}

export interface NewExpense {
  merchant?: string | null;
  txnDate?: string | null; // ISO date
  currencyCode: string;
  notes?: string | null;
}
export type ExpensePatch = {
  merchant?: string | null;
  txnDate?: string | null;
  notes?: string | null;
};

export interface NewLineItem {
  categoryId: string;
  amountMinor: number | bigint | string;
  description?: string | null;
  taxMinor?: number | bigint | string;
}
export type LineItemPatch = {
  categoryId?: string;
  amountMinor?: number | bigint | string;
  description?: string | null;
  taxMinor?: number | bigint | string;
};

export interface ReportListFilter {
  /** Scope to one person's reports — the workbench default. */
  submitterEmail?: string | null;
  status?: ReportStatus | null;
  /** Matches number or title. */
  search?: string | null;
  limit?: number;
  offset?: number;
}

export interface ReportListRow {
  id: string;
  number: string | null;
  title: string;
  status: ReportStatus;
  total_minor: string;
  currency_code: string;
  minor_unit: number;
  submitter_id: string;
  submitter_name: string | null;
  submitter_email: string;
  business_unit_name: string | null;
  expense_count: string;
  receipt_count: string;
  submitted_at: Date | null;
  created_at: Date;
}

export interface WorkbenchReport {
  id: string;
  number: string | null;
  title: string;
  purpose: string | null;
  status: ReportStatus;
  total_minor: string;
  currency_code: string;
  minor_unit: number;
  submitter_id: string;
  submitter_name: string | null;
  submitter_email: string;
  business_unit_id: string | null;
  business_unit_name: string | null;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkbenchLineItem {
  id: string;
  expense_id: string;
  category_id: string;
  category_code: string | null;
  category_label: string | null;
  category_active: boolean | null;
  amount_minor: string;
  tax_minor: string;
  description: string | null;
  created_at: Date;
}

export interface WorkbenchReceipt {
  id: string;
  expense_id: string;
  filename: string;
  content_type: string;
  size_bytes: number | null;
  status: 'STORED';
  uploaded_at: Date;
}

export interface WorkbenchExpense {
  id: string;
  report_id: string;
  merchant: string | null;
  txn_date: string | Date | null;
  currency_code: string;
  notes: string | null;
  created_at: Date;
  lineItems: WorkbenchLineItem[];
  receipts: WorkbenchReceipt[];
  /** Sum of this expense's line items, in minor units. */
  subtotal_minor: string;
}

export interface Workbench {
  report: WorkbenchReport;
  expenses: WorkbenchExpense[];
  uncodedExpenseCount: number;
}

/* ── guards & helpers ──────────────────────────────────────────────────────── */

/** Minor units are whole numbers. A float here means a bug upstream, not a rounding job. */
function toMinorString(value: number | bigint | string, field: string): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ExpenseError(`${field} must be a whole number of minor units`, 'INVALID_AMOUNT');
    }
    return BigInt(value).toString();
  }
  try {
    return BigInt(value.trim()).toString();
  } catch {
    throw new ExpenseError(`${field} must be a whole number of minor units`, 'INVALID_AMOUNT');
  }
}

async function requireReport(tx: QueryRunner, reportId: string) {
  const r = await tx.query('SELECT * FROM expense_report WHERE id = $1', [reportId]);
  if (r.rows.length === 0) throw new ExpenseError('report not found', 'NOT_FOUND');
  return r.rows[0];
}

/**
 * The single write gate. Anything that changes a report, its expenses or its
 * lines calls this first, so "editable" has exactly one definition.
 */
export async function assertDraft(tx: QueryRunner, reportId: string) {
  const report = await requireReport(tx, reportId);
  if (report.status !== 'DRAFT') {
    throw new ExpenseError(
      `report ${report.number ?? reportId} is ${report.status}; only DRAFT reports can be edited`,
      'NOT_DRAFT',
    );
  }
  return report;
}

export async function reportIdForExpense(tx: QueryRunner, expenseId: string): Promise<string> {
  const r = await tx.query('SELECT report_id FROM expense WHERE id = $1', [expenseId]);
  if (r.rows.length === 0) throw new ExpenseError('expense not found', 'NOT_FOUND');
  return r.rows[0].report_id as string;
}

export async function reportIdForLineItem(tx: QueryRunner, lineItemId: string): Promise<string> {
  const r = await tx.query(
    `SELECT e.report_id FROM expense_line_item li
       JOIN expense e ON e.id = li.expense_id
      WHERE li.id = $1`,
    [lineItemId],
  );
  if (r.rows.length === 0) throw new ExpenseError('line item not found', 'NOT_FOUND');
  return r.rows[0].report_id as string;
}

async function assertCurrency(tx: QueryRunner, currencyCode: string) {
  const r = await tx.query('SELECT code FROM currency WHERE code = $1', [currencyCode]);
  if (r.rows.length === 0) {
    throw new ExpenseError(`unknown currency ${currencyCode}`, 'CURRENCY_NOT_FOUND');
  }
}

/** RLS already scopes categories to the tenant; this turns a 23503 into a message. */
async function assertCategory(tx: QueryRunner, categoryId: string) {
  const r = await tx.query('SELECT id FROM expense_category WHERE id = $1', [categoryId]);
  if (r.rows.length === 0) {
    throw new ExpenseError('category not found in this organization', 'CATEGORY_NOT_FOUND');
  }
}

/* ── access ────────────────────────────────────────────────────────────────── */

/** The three facts every access decision about a report needs. */
export interface ReportAccess {
  id: string;
  number: string | null;
  submitter_id: string;
  status: ReportStatus;
}

export async function getReportAccess(
  tx: QueryRunner,
  reportId: string,
): Promise<ReportAccess | null> {
  const r = await tx.query(
    'SELECT id, number, submitter_id, status FROM expense_report WHERE id = $1',
    [reportId],
  );
  return (r.rows[0] as ReportAccess) ?? null;
}

/**
 * RLS scopes rows to the ORG; these scope them to a PERSON. Without the second
 * check any colleague who guessed an id could read or edit someone's report.
 *
 * MANAGER deliberately gets nothing extra yet — a manager's reach over their
 * reports' expenses arrives with the Phase-2 approval engine, and inventing it
 * early would mean guessing at rules that ticket will actually specify.
 */
export function canViewReport(actor: Actor, access: ReportAccess): boolean {
  return actor.role === 'ADMIN' || actor.id === access.submitter_id;
}

/** Editing additionally requires the report to still be a draft. */
export function canEditReport(actor: Actor, access: ReportAccess): boolean {
  return canViewReport(actor, access) && access.status === 'DRAFT';
}

/* ── reports ───────────────────────────────────────────────────────────────── */

/** Create a DRAFT report; assigns a per-tenant sequential EXP-###### number. */
export async function createReport(tx: QueryRunner, submitterEmail: string, input: NewReport) {
  const title = input.title?.trim();
  if (!title) throw new ExpenseError('title is required', 'INVALID_TITLE');
  await assertCurrency(tx, input.currencyCode);

  const org = await tx.query(
    `SELECT id, expense_report_seq FROM organization WHERE id = ${ORG} FOR UPDATE`,
  );
  if (org.rows.length === 0) throw new ExpenseError('no tenant context', 'NO_TENANT');
  const next = BigInt(org.rows[0].expense_report_seq) + 1n;
  await tx.query('UPDATE organization SET expense_report_seq = $1 WHERE id = $2', [
    next.toString(),
    org.rows[0].id,
  ]);
  const number = `EXP-${next.toString().padStart(6, '0')}`;

  const sub = await tx.query('SELECT id FROM app_user WHERE lower(email) = lower($1) LIMIT 1', [
    submitterEmail,
  ]);
  if (sub.rows.length === 0) {
    throw new ExpenseError('submitter not found in organization', 'SUBMITTER_NOT_FOUND');
  }

  const r = await tx.query(
    `INSERT INTO expense_report
       (organization_id, number, title, purpose, currency_code, submitter_id, business_unit_id)
     VALUES (${ORG}, $1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      number,
      title,
      input.purpose ?? null,
      input.currencyCode,
      sub.rows[0].id,
      input.businessUnitId ?? null,
    ],
  );
  return r.rows[0];
}

export async function listReports(
  tx: QueryRunner,
  filter: ReportListFilter = {},
): Promise<{ reports: ReportListRow[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filter.submitterEmail) {
    where.push(`lower(u.email) = lower(${bind(filter.submitterEmail)})`);
  }
  if (filter.status) where.push(`r.status = ${bind(filter.status)}::expense_report_status`);
  if (filter.search?.trim()) {
    const like = `%${filter.search.trim()}%`;
    where.push(`(r.title ILIKE ${bind(like)} OR r.number ILIKE ${bind(like)})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const count = await tx.query(
    `SELECT COUNT(*)::int AS total
       FROM expense_report r JOIN app_user u ON u.id = r.submitter_id ${whereSql}`,
    values,
  );

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  const rows = await tx.query(
    `SELECT r.id, r.number, r.title, r.status, r.total_minor, r.currency_code,
            c.minor_unit,
            r.submitter_id, u.display_name AS submitter_name, u.email AS submitter_email,
            bu.name AS business_unit_name,
            (SELECT COUNT(*) FROM expense e WHERE e.report_id = r.id) AS expense_count,
            (SELECT COUNT(*) FROM receipt rc JOIN expense e2 ON e2.id = rc.expense_id
              WHERE e2.report_id = r.id AND rc.status = 'STORED') AS receipt_count,
            r.submitted_at, r.created_at
       FROM expense_report r
       JOIN app_user u ON u.id = r.submitter_id
       JOIN currency c ON c.code = r.currency_code
       LEFT JOIN business_unit bu ON bu.id = r.business_unit_id
       ${whereSql}
      ORDER BY r.created_at DESC
      LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
    values,
  );

  return { reports: rows.rows as ReportListRow[], total: count.rows[0].total as number };
}

export async function getReport(tx: QueryRunner, reportId: string) {
  const report = await tx.query('SELECT * FROM expense_report WHERE id = $1', [reportId]);
  if (report.rows.length === 0) return null;
  const expenses = await tx.query('SELECT * FROM expense WHERE report_id = $1 ORDER BY created_at', [
    reportId,
  ]);
  const lines = await tx.query(
    `SELECT li.* FROM expense_line_item li
       JOIN expense e ON e.id = li.expense_id
      WHERE e.report_id = $1 ORDER BY li.created_at`,
    [reportId],
  );
  return { report: report.rows[0], expenses: expenses.rows, lineItems: lines.rows };
}

/**
 * Everything the editor renders, in one tenant transaction: the report with its
 * submitter/BU/currency labels, each expense with its line items (category
 * labels resolved) and its STORED receipts, and a per-expense subtotal.
 */
export async function getReportWorkbench(
  tx: QueryRunner,
  reportId: string,
): Promise<Workbench | null> {
  const reportRes = await tx.query(
    `SELECT r.*, c.minor_unit,
            u.display_name AS submitter_name, u.email AS submitter_email,
            bu.name AS business_unit_name
       FROM expense_report r
       JOIN app_user u ON u.id = r.submitter_id
       JOIN currency c ON c.code = r.currency_code
       LEFT JOIN business_unit bu ON bu.id = r.business_unit_id
      WHERE r.id = $1`,
    [reportId],
  );
  if (reportRes.rows.length === 0) return null;

  const expensesRes = await tx.query(
    'SELECT * FROM expense WHERE report_id = $1 ORDER BY txn_date NULLS LAST, created_at',
    [reportId],
  );
  const linesRes = await tx.query(
    `SELECT li.*, cat.code AS category_code, cat.label AS category_label, cat.active AS category_active
       FROM expense_line_item li
       JOIN expense e ON e.id = li.expense_id
       LEFT JOIN expense_category cat ON cat.id = li.category_id
      WHERE e.report_id = $1
      ORDER BY li.created_at`,
    [reportId],
  );
  const receiptsRes = await tx.query(
    `SELECT rc.id, rc.expense_id, rc.filename, rc.content_type, rc.size_bytes, rc.status,
            rc.uploaded_at
       FROM receipt rc
       JOIN expense e ON e.id = rc.expense_id
      WHERE e.report_id = $1 AND rc.status = 'STORED'
      ORDER BY rc.uploaded_at`,
    [reportId],
  );

  const allLines = linesRes.rows as WorkbenchLineItem[];
  const allReceipts = receiptsRes.rows as WorkbenchReceipt[];

  const expenses: WorkbenchExpense[] = expensesRes.rows.map((expense) => {
    const lineItems = allLines.filter((li) => li.expense_id === expense.id);
    const subtotalMinor = lineItems.reduce((sum, li) => sum + BigInt(li.amount_minor), 0n);
    return {
      ...expense,
      lineItems,
      receipts: allReceipts.filter((rc) => rc.expense_id === expense.id),
      subtotal_minor: subtotalMinor.toString(),
    };
  });

  return {
    report: reportRes.rows[0] as WorkbenchReport,
    expenses,
    /** Uncoded expenses are the usual reason a receipt-first report reads as $0. */
    uncodedExpenseCount: expenses.filter((e) => e.lineItems.length === 0).length,
  };
}

export async function updateReport(tx: QueryRunner, reportId: string, patch: ReportPatch) {
  await assertDraft(tx, reportId);

  const sets: string[] = [];
  const values: unknown[] = [reportId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new ExpenseError('title is required', 'INVALID_TITLE');
    set('title', title);
  }
  if ('purpose' in patch) set('purpose', patch.purpose ?? null);
  if ('businessUnitId' in patch) set('business_unit_id', patch.businessUnitId ?? null);
  if (patch.currencyCode !== undefined) {
    await assertCurrency(tx, patch.currencyCode);
    set('currency_code', patch.currencyCode);
  }
  if (sets.length === 0) return requireReport(tx, reportId);

  const r = await tx.query(
    `UPDATE expense_report SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`,
    values,
  );

  // Single-currency MVP: the report's currency is the report's currency, so a
  // change carries down rather than leaving mixed-currency children behind.
  if (patch.currencyCode !== undefined) {
    await tx.query('UPDATE expense SET currency_code = $2, updated_at = now() WHERE report_id = $1', [
      reportId,
      patch.currencyCode,
    ]);
  }
  return r.rows[0] ?? null;
}

export async function deleteReport(tx: QueryRunner, reportId: string) {
  await assertDraft(tx, reportId);
  await tx.query("DELETE FROM expense_report WHERE id = $1 AND status = 'DRAFT'", [reportId]);
}

/* ── expenses ──────────────────────────────────────────────────────────────── */

export async function addExpense(tx: QueryRunner, reportId: string, input: NewExpense) {
  await assertDraft(tx, reportId);
  await assertCurrency(tx, input.currencyCode);
  const r = await tx.query(
    `INSERT INTO expense (organization_id, report_id, merchant, txn_date, currency_code, notes)
     VALUES (${ORG}, $1, $2, $3, $4, $5) RETURNING *`,
    [
      reportId,
      input.merchant ?? null,
      input.txnDate ?? null,
      input.currencyCode,
      input.notes ?? null,
    ],
  );
  return r.rows[0];
}

export async function updateExpense(tx: QueryRunner, expenseId: string, patch: ExpensePatch) {
  const reportId = await reportIdForExpense(tx, expenseId);
  await assertDraft(tx, reportId);

  const sets: string[] = [];
  const values: unknown[] = [expenseId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if ('merchant' in patch) set('merchant', patch.merchant ?? null);
  if ('txnDate' in patch) set('txn_date', patch.txnDate ?? null);
  if ('notes' in patch) set('notes', patch.notes ?? null);
  if (sets.length === 0) {
    const current = await tx.query('SELECT * FROM expense WHERE id = $1', [expenseId]);
    return current.rows[0] ?? null;
  }

  const r = await tx.query(
    `UPDATE expense SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    values,
  );
  return r.rows[0] ?? null;
}

/**
 * Deleting an expense cascades its line items (FK ON DELETE CASCADE) but only
 * detaches its receipts (ON DELETE SET NULL) — they return to the uploader's
 * inbox rather than being destroyed with the row that referenced them.
 */
export async function removeExpense(tx: QueryRunner, expenseId: string) {
  const reportId = await reportIdForExpense(tx, expenseId);
  await assertDraft(tx, reportId);
  await tx.query('DELETE FROM expense WHERE id = $1', [expenseId]);
  await recomputeReportTotal(tx, reportId);
  return reportId;
}

/* ── line items ────────────────────────────────────────────────────────────── */

export async function addLineItem(tx: QueryRunner, expenseId: string, input: NewLineItem) {
  const reportId = await reportIdForExpense(tx, expenseId);
  await assertDraft(tx, reportId);
  await assertCategory(tx, input.categoryId);

  const r = await tx.query(
    `INSERT INTO expense_line_item
       (organization_id, expense_id, category_id, amount_minor, description, tax_minor)
     VALUES (${ORG}, $1, $2, $3, $4, $5) RETURNING *`,
    [
      expenseId,
      input.categoryId,
      toMinorString(input.amountMinor, 'amount'),
      input.description ?? null,
      toMinorString(input.taxMinor ?? 0, 'tax'),
    ],
  );
  await recomputeReportTotal(tx, reportId);
  return r.rows[0];
}

export async function updateLineItem(tx: QueryRunner, lineItemId: string, patch: LineItemPatch) {
  const reportId = await reportIdForLineItem(tx, lineItemId);
  await assertDraft(tx, reportId);

  const sets: string[] = [];
  const values: unknown[] = [lineItemId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.categoryId !== undefined) {
    await assertCategory(tx, patch.categoryId);
    set('category_id', patch.categoryId);
  }
  if (patch.amountMinor !== undefined) set('amount_minor', toMinorString(patch.amountMinor, 'amount'));
  if (patch.taxMinor !== undefined) set('tax_minor', toMinorString(patch.taxMinor, 'tax'));
  if ('description' in patch) set('description', patch.description ?? null);
  if (sets.length === 0) {
    const current = await tx.query('SELECT * FROM expense_line_item WHERE id = $1', [lineItemId]);
    return current.rows[0] ?? null;
  }

  const r = await tx.query(
    `UPDATE expense_line_item SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`,
    values,
  );
  await recomputeReportTotal(tx, reportId);
  return r.rows[0] ?? null;
}

export async function removeLineItem(tx: QueryRunner, lineItemId: string) {
  const reportId = await reportIdForLineItem(tx, lineItemId);
  await assertDraft(tx, reportId);
  await tx.query('DELETE FROM expense_line_item WHERE id = $1', [lineItemId]);
  await recomputeReportTotal(tx, reportId);
  return reportId;
}

/** Report total = sum of its line-item amounts (single currency, MVP). */
export async function recomputeReportTotal(tx: QueryRunner, reportId: string) {
  const s = await tx.query(
    `SELECT COALESCE(SUM(li.amount_minor), 0) AS total
       FROM expense_line_item li JOIN expense e ON e.id = li.expense_id
      WHERE e.report_id = $1`,
    [reportId],
  );
  await tx.query('UPDATE expense_report SET total_minor = $1, updated_at = now() WHERE id = $2', [
    s.rows[0].total,
    reportId,
  ]);
  return BigInt(s.rows[0].total);
}

/* ── pickers (tenant-scoped reference reads) ───────────────────────────────── */

export interface CategoryOption {
  id: string;
  code: string;
  label: string;
  gl_account: string | null;
  active: boolean;
}

export async function listCategories(
  tx: QueryRunner,
  opts: { includeInactive?: boolean } = {},
): Promise<CategoryOption[]> {
  const r = await tx.query(
    `SELECT id, code, label, gl_account, active
       FROM expense_category
      ${opts.includeInactive ? '' : 'WHERE active'}
      ORDER BY sort_order, label`,
  );
  return r.rows as CategoryOption[];
}

/** currency is the one GLOBAL reference table — no organization_id, no RLS. */
export async function listCurrencies(
  tx: QueryRunner,
): Promise<Array<{ code: string; name: string; minor_unit: number }>> {
  const r = await tx.query('SELECT code, name, minor_unit FROM currency ORDER BY code');
  return r.rows;
}

/** The report's currency decimals — what a typed "12.34" must be parsed against. */
export async function minorUnitForReport(tx: QueryRunner, reportId: string): Promise<number> {
  const r = await tx.query(
    `SELECT c.minor_unit FROM expense_report r
       JOIN currency c ON c.code = r.currency_code
      WHERE r.id = $1`,
    [reportId],
  );
  if (r.rows.length === 0) throw new ExpenseError('report not found', 'NOT_FOUND');
  return r.rows[0].minor_unit as number;
}
