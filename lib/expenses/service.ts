/**
 * VX1-4 — expense-report service (Velotech style: pure functions over a tenant
 * QueryRunner; the server-action layer supplies auth + withCurrentOrg). Every
 * query runs inside a tenant transaction, so RLS scopes all rows to the org;
 * app.current_org is already set by the caller.
 *
 * Hierarchy: expense_report -> expense -> expense_line_item; receipts attach to
 * an expense. Report.total_minor is the sum of its line items (single-currency
 * MVP; FX/tax engine come later).
 */
import type { QueryRunner } from '@/lib/db/client';

const ORG = "current_setting('app.current_org', true)::uuid";

export interface NewReport {
  title: string;
  purpose?: string | null;
  currencyCode: string;
  businessUnitId?: string | null;
}
export interface NewExpense {
  merchant?: string | null;
  txnDate?: string | null; // ISO date
  currencyCode: string;
  notes?: string | null;
}
export interface NewLineItem {
  categoryId: string;
  amountMinor: number | bigint;
  description?: string | null;
  taxMinor?: number | bigint;
}

/** Create a DRAFT report; assigns a per-tenant sequential EXP-###### number. */
export async function createReport(tx: QueryRunner, submitterEmail: string, input: NewReport) {
  const org = await tx.query(
    `SELECT id, expense_report_seq FROM organization WHERE id = ${ORG} FOR UPDATE`,
  );
  if (org.rows.length === 0) throw new Error('no tenant context');
  const next = BigInt(org.rows[0].expense_report_seq) + 1n;
  await tx.query('UPDATE organization SET expense_report_seq = $1 WHERE id = $2', [
    next.toString(),
    org.rows[0].id,
  ]);
  const number = `EXP-${next.toString().padStart(6, '0')}`;

  const sub = await tx.query('SELECT id FROM app_user WHERE lower(email) = lower($1) LIMIT 1', [
    submitterEmail,
  ]);
  if (sub.rows.length === 0) throw new Error('submitter not found in organization');

  const r = await tx.query(
    `INSERT INTO expense_report
       (organization_id, number, title, purpose, currency_code, submitter_id, business_unit_id)
     VALUES (${ORG}, $1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [number, input.title, input.purpose ?? null, input.currencyCode, sub.rows[0].id, input.businessUnitId ?? null],
  );
  return r.rows[0];
}

export async function listReports(tx: QueryRunner) {
  const r = await tx.query(
    `SELECT id, number, title, status, total_minor, currency_code, submitted_at, created_at
       FROM expense_report ORDER BY created_at DESC`,
  );
  return r.rows;
}

export async function getReport(tx: QueryRunner, reportId: string) {
  const report = await tx.query('SELECT * FROM expense_report WHERE id = $1', [reportId]);
  if (report.rows.length === 0) return null;
  const expenses = await tx.query(
    'SELECT * FROM expense WHERE report_id = $1 ORDER BY created_at',
    [reportId],
  );
  const lines = await tx.query(
    `SELECT li.* FROM expense_line_item li
       JOIN expense e ON e.id = li.expense_id
      WHERE e.report_id = $1 ORDER BY li.created_at`,
    [reportId],
  );
  return { report: report.rows[0], expenses: expenses.rows, lineItems: lines.rows };
}

export async function updateReport(
  tx: QueryRunner,
  reportId: string,
  patch: { title?: string; purpose?: string | null; businessUnitId?: string | null },
) {
  const r = await tx.query(
    `UPDATE expense_report SET
       title = COALESCE($2, title),
       purpose = COALESCE($3, purpose),
       business_unit_id = COALESCE($4, business_unit_id),
       updated_at = now()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING *`,
    [reportId, patch.title ?? null, patch.purpose ?? null, patch.businessUnitId ?? null],
  );
  return r.rows[0] ?? null;
}

export async function deleteReport(tx: QueryRunner, reportId: string) {
  await tx.query("DELETE FROM expense_report WHERE id = $1 AND status = 'DRAFT'", [reportId]);
}

export async function addExpense(tx: QueryRunner, reportId: string, input: NewExpense) {
  const r = await tx.query(
    `INSERT INTO expense (organization_id, report_id, merchant, txn_date, currency_code, notes)
     VALUES (${ORG}, $1, $2, $3, $4, $5) RETURNING *`,
    [reportId, input.merchant ?? null, input.txnDate ?? null, input.currencyCode, input.notes ?? null],
  );
  return r.rows[0];
}

export async function addLineItem(tx: QueryRunner, expenseId: string, input: NewLineItem) {
  const r = await tx.query(
    `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor, description, tax_minor)
     VALUES (${ORG}, $1, $2, $3, $4, $5) RETURNING *`,
    [expenseId, input.categoryId, input.amountMinor.toString(), input.description ?? null, (input.taxMinor ?? 0).toString()],
  );
  const rep = await tx.query('SELECT report_id FROM expense WHERE id = $1', [expenseId]);
  if (rep.rows[0]) await recomputeReportTotal(tx, rep.rows[0].report_id);
  return r.rows[0];
}

export async function removeLineItem(tx: QueryRunner, lineItemId: string) {
  const rep = await tx.query(
    `SELECT e.report_id FROM expense_line_item li JOIN expense e ON e.id = li.expense_id WHERE li.id = $1`,
    [lineItemId],
  );
  await tx.query('DELETE FROM expense_line_item WHERE id = $1', [lineItemId]);
  if (rep.rows[0]) await recomputeReportTotal(tx, rep.rows[0].report_id);
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
