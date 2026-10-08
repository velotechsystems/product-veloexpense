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
import { DomainError } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import type { Actor } from '@/lib/auth/actor';
import { accountForCategory } from '@/lib/accounts/service';
import { append as auditAppend, type AuditActor } from '@/lib/audit/service';
import { auditDiff, auditSnapshot } from '@/lib/audit/diff';
import type { AuditAction } from '@/lib/audit/actions';
import { ORG } from '@/lib/tenant/sql';
import { assertExpenseAllowance } from '@/lib/billing/caps';


/**
 * UD-11 — every edit in this file is audited, and the actor is a REQUIRED
 * parameter of every one of them.
 *
 * ── WHY THE ACTOR IS A PARAMETER AND NOT AMBIENT ────────────────────────────
 *
 * The alternative considered (and rejected with John, 4 Sep) was an
 * `app.current_actor` GUC alongside `app.current_org`, which would have cost no
 * call-site churn at all. Two reasons against, and the second is the real one:
 *
 *  1. Enforcement moves from the compiler to run time. With a required
 *     parameter, an edit path that does not audit does not COMPILE — the
 *     property this file needs, since the whole finding was that eight write
 *     paths silently recorded nothing for four phases.
 *  2. The failure mode of the ambient version is the bad one. An edit running
 *     outside the guard would throw INSIDE the user's transaction, rolling back
 *     their edit over a logging detail. That is AU-5, and upstream's own commit
 *     message warns about exactly it.
 *
 * The cost is real and was paid: ~68 test call sites gained one argument.
 *
 * ── WHAT AN AUDITED WRITE LOOKS LIKE ────────────────────────────────────────
 *
 * Read the row, write it, diff the two rows (NOT the patch — see
 * `lib/audit/diff.ts`), append inside the same transaction. A save that changed
 * nothing still appends, with `unchanged: true`: "opened it and pressed Save" is
 * a different event from "corrected the amount", and telling them apart is most
 * of what makes an edit log readable.
 */
const AUDIT = {
  reportEdited: 'REPORT_EDITED',
  reportDeleted: 'REPORT_DELETED',
  expenseAdded: 'EXPENSE_ADDED',
  expenseEdited: 'EXPENSE_EDITED',
  expenseRemoved: 'EXPENSE_REMOVED',
  lineItemAdded: 'LINE_ITEM_ADDED',
  lineItemEdited: 'LINE_ITEM_EDITED',
  lineItemRemoved: 'LINE_ITEM_REMOVED',
} as const;

/**
 * The audit row for an edit to something that hangs off a report.
 *
 * `report_id` rides in `details` rather than being inferred from `entity_id`
 * later: an auditor's first question is "what happened to report EXP-000123",
 * and answering it should not require joining to a row that may since have been
 * deleted.
 */
async function auditEdit(
  tx: QueryRunner,
  actor: AuditActor,
  action: AuditAction,
  entityType: 'Expense' | 'ExpenseLineItem',
  entityId: string,
  reportId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  await auditAppend(tx, actor, {
    action,
    entityType,
    entityId,
    details: { report_id: reportId, ...auditDiff(before, after) },
  });
}

/** The row as it stands, or `{}` for a row that does not exist yet. */
async function rowById(
  tx: QueryRunner,
  table: 'expense_report' | 'expense' | 'expense_line_item',
  id: string,
): Promise<Record<string, unknown>> {
  const r = await tx.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  return (r.rows[0] as Record<string, unknown> | undefined) ?? {};
}

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

export class ExpenseError extends DomainError {
  constructor(
    message: string,
    readonly code: ExpenseErrorCode,
    userMessage: UserMessageCode | null = null,
  ) {
    super(message, userMessage);
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
  txn_date: string | null;
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
      throw new ExpenseError(
      `${field} must be a whole number of minor units`,
      'INVALID_AMOUNT',
      'AMOUNT_NOT_WHOLE_MINOR',
    );
    }
    return BigInt(value).toString();
  }
  try {
    return BigInt(value.trim()).toString();
  } catch {
    throw new ExpenseError(
      `${field} must be a whole number of minor units`,
      'INVALID_AMOUNT',
      'AMOUNT_NOT_WHOLE_MINOR',
    );
  }
}

/**
 * The report row, LOCKED for the rest of the transaction.
 *
 * `FOR UPDATE`, because this is the read every write path checks the status
 * against, and under READ COMMITTED a plain read takes no lock: a check could
 * pass against a DRAFT that another transaction was in the middle of submitting,
 * and the line, the expense or the total written next would land on a report
 * that was SUBMITTED by the time it committed. `test/report-lock.db.test.ts`
 * reproduced exactly that before this clause existed. With it, a write waits for
 * a submit already in flight and then sees the status it actually has.
 *
 * Every path that changes a report takes this lock FIRST, and the submit, the
 * recall and the approval decision take the same row first too — so they agree
 * on one order (report row, then tasks, then the audit chain) and cannot
 * deadlock against each other. Before, `addLineItem` queued for the audit chain
 * and only then touched the report row, while `submitReport` did the reverse.
 */
async function requireReport(tx: QueryRunner, reportId: string) {
  const r = await tx.query('SELECT * FROM expense_report WHERE id = $1 FOR UPDATE', [reportId]);
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
      'REPORT_NOT_DRAFT',
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
    throw new ExpenseError(
      `unknown currency ${currencyCode}`,
      'CURRENCY_NOT_FOUND',
      'CURRENCY_UNKNOWN',
    );
  }
}

/** RLS already scopes categories to the tenant; this turns a 23503 into a message. */
async function assertCategory(tx: QueryRunner, categoryId: string) {
  const r = await tx.query('SELECT id FROM expense_category WHERE id = $1', [categoryId]);
  if (r.rows.length === 0) {
    throw new ExpenseError(
      'category not found in this organization',
      'CATEGORY_NOT_FOUND',
      'CATEGORY_UNKNOWN',
    );
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
  if (!title) throw new ExpenseError('title is required', 'INVALID_TITLE', 'TITLE_REQUIRED');
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
    `SELECT li.*, cat.code AS category_code, cat.label ->> 'en' AS category_label, cat.active AS category_active
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

export async function updateReport(
  tx: QueryRunner,
  actor: AuditActor,
  reportId: string,
  patch: ReportPatch,
) {
  await assertDraft(tx, reportId);
  const before = await rowById(tx, 'expense_report', reportId);

  const sets: string[] = [];
  const values: unknown[] = [reportId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new ExpenseError('title is required', 'INVALID_TITLE', 'TITLE_REQUIRED');
    set('title', title);
  }
  if ('purpose' in patch) set('purpose', patch.purpose ?? null);
  if ('businessUnitId' in patch) set('business_unit_id', patch.businessUnitId ?? null);
  if (patch.currencyCode !== undefined) {
    await assertCurrency(tx, patch.currencyCode);
    set('currency_code', patch.currencyCode);
  }
  // A patch that names no column is still a save somebody performed, and it is
  // audited as one — `unchanged: true`. Returning early WITHOUT an entry is what
  // makes an edit log unable to tell an edit from a visit.
  if (sets.length === 0) {
    const unchangedRow = await requireReport(tx, reportId);
    await auditAppend(tx, actor, {
      action: AUDIT.reportEdited,
      entityType: 'ExpenseReport',
      entityId: reportId,
      details: auditDiff(before, before),
    });
    return unchangedRow;
  }

  const r = await tx.query(
    `UPDATE expense_report SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`,
    values,
  );

  // Single-currency MVP: the report's currency is the report's currency, so a
  // change carries down rather than leaving mixed-currency children behind.
  //
  // THIS IS THE WRITE NO ROW DIFF CAN SEE, so it is counted and recorded by hand.
  // One click here rewrites N rows in another table; an auditor reading
  // "currency_code: CAD -> USD" on the report should not have to infer that
  // twelve expenses moved with it. `RETURNING id` rather than a count query
  // because the statement already knows.
  let cascaded: number | null = null;
  if (patch.currencyCode !== undefined) {
    const kids = await tx.query(
      'UPDATE expense SET currency_code = $2, updated_at = now() WHERE report_id = $1 RETURNING id',
      [reportId, patch.currencyCode],
    );
    cascaded = kids.rowCount ?? kids.rows.length;
  }

  const after = (r.rows[0] as Record<string, unknown> | undefined) ?? {};
  await auditAppend(tx, actor, {
    action: AUDIT.reportEdited,
    entityType: 'ExpenseReport',
    entityId: reportId,
    details: {
      ...auditDiff(before, after),
      ...(cascaded === null ? {} : { cascaded_expense_currency: cascaded }),
    },
  });
  return r.rows[0] ?? null;
}

/**
 * A deletion is the edit an auditor asks about most — "who deleted the $4,000
 * line" — and it is the one upstream's port does not cover, because their commit
 * was about edit mutations. The row is right there before the DELETE, so the
 * snapshot is free; afterwards it is gone for good.
 */
export async function deleteReport(tx: QueryRunner, actor: AuditActor, reportId: string) {
  await assertDraft(tx, reportId);
  const before = await rowById(tx, 'expense_report', reportId);
  const r = await tx.query(
    "DELETE FROM expense_report WHERE id = $1 AND status = 'DRAFT' RETURNING id",
    [reportId],
  );
  // Conditional-write idiom: `assertDraft` ran, but a concurrent submit between
  // the two statements would leave this deleting nothing — and an audit row for a
  // deletion that did not happen is worse than none.
  if ((r.rowCount ?? 0) !== 1) {
    throw new ExpenseError('report is no longer a draft', 'NOT_DRAFT', 'REPORT_NOT_DRAFT');
  }
  await auditAppend(tx, actor, {
    action: AUDIT.reportDeleted,
    entityType: 'ExpenseReport',
    entityId: reportId,
    details: { deleted: auditSnapshot(before) },
  });
}

/* ── expenses ──────────────────────────────────────────────────────────────── */

export async function addExpense(
  tx: QueryRunner,
  actor: AuditActor,
  reportId: string,
  input: NewExpense,
) {
  await assertDraft(tx, reportId);
  await assertCurrency(tx, input.currencyCode);
  // The plan's yearly expense cap, if one is in force — `lib/billing/caps.ts`.
  // This is the only INSERT INTO expense, so every path that creates one,
  // including starting a report from uploaded receipts, is counted here.
  await assertExpenseAllowance(tx);
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
  await auditAppend(tx, actor, {
    action: AUDIT.expenseAdded,
    entityType: 'Expense',
    entityId: r.rows[0].id as string,
    details: { report_id: reportId, added: auditSnapshot(r.rows[0] as Record<string, unknown>) },
  });
  return r.rows[0];
}

export async function updateExpense(
  tx: QueryRunner,
  actor: AuditActor,
  expenseId: string,
  patch: ExpensePatch,
) {
  const reportId = await reportIdForExpense(tx, expenseId);
  await assertDraft(tx, reportId);
  const before = await rowById(tx, 'expense', expenseId);

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
    await auditEdit(tx, actor, AUDIT.expenseEdited, 'Expense', expenseId, reportId, before, before);
    return Object.keys(before).length === 0 ? null : before;
  }

  const r = await tx.query(
    `UPDATE expense SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    values,
  );
  const after = (r.rows[0] as Record<string, unknown> | undefined) ?? {};
  await auditEdit(tx, actor, AUDIT.expenseEdited, 'Expense', expenseId, reportId, before, after);
  return r.rows[0] ?? null;
}

/**
 * Deleting an expense cascades its line items (FK ON DELETE CASCADE) but only
 * detaches its receipts (ON DELETE SET NULL) — they return to the uploader's
 * inbox rather than being destroyed with the row that referenced them.
 */
export async function removeExpense(tx: QueryRunner, actor: AuditActor, expenseId: string) {
  const reportId = await reportIdForExpense(tx, expenseId);
  await assertDraft(tx, reportId);
  // The line items go with it (FK ON DELETE CASCADE), so they are snapshotted
  // too: deleting one expense can remove a dozen amounts, and "the expense was
  // deleted" does not tell an auditor what was on it.
  const before = await rowById(tx, 'expense', expenseId);
  const lines = await tx.query('SELECT * FROM expense_line_item WHERE expense_id = $1', [expenseId]);
  await tx.query('DELETE FROM expense WHERE id = $1', [expenseId]);
  await auditAppend(tx, actor, {
    action: AUDIT.expenseRemoved,
    entityType: 'Expense',
    entityId: expenseId,
    details: {
      report_id: reportId,
      deleted: auditSnapshot(before),
      deleted_line_items: (lines.rows as Record<string, unknown>[]).map((row) =>
        auditSnapshot(row),
      ),
    },
  });
  await recomputeReportTotal(tx, reportId);
  return reportId;
}

/* ── line items ────────────────────────────────────────────────────────────── */

export async function addLineItem(
  tx: QueryRunner,
  actor: AuditActor,
  expenseId: string,
  input: NewLineItem,
) {
  const reportId = await reportIdForExpense(tx, expenseId);
  await assertDraft(tx, reportId);
  await assertCategory(tx, input.categoryId);
  // VX3-1 / GAP-AUDIT AC-10: the GL account is SNAPSHOTTED here, at write time,
  // not read through the category when the report posts. So a report posts to the
  // account the line was coded to when it was filed, rather than to wherever its
  // category points months later. Null is fine and blocks nothing — an unmapped
  // category is a configuration gap, and the person filing the expense is not who
  // fixes it.
  const glAccountId = await accountForCategory(tx, input.categoryId);

  const r = await tx.query(
    `INSERT INTO expense_line_item
       (organization_id, expense_id, category_id, amount_minor, description, tax_minor,
        gl_account_id)
     VALUES (${ORG}, $1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      expenseId,
      input.categoryId,
      toMinorString(input.amountMinor, 'amount'),
      input.description ?? null,
      toMinorString(input.taxMinor ?? 0, 'tax'),
      glAccountId,
    ],
  );
  await auditAppend(tx, actor, {
    action: AUDIT.lineItemAdded,
    entityType: 'ExpenseLineItem',
    entityId: r.rows[0].id as string,
    details: {
      report_id: reportId,
      expense_id: expenseId,
      added: auditSnapshot(r.rows[0] as Record<string, unknown>),
    },
  });
  await recomputeReportTotal(tx, reportId);
  return r.rows[0];
}

export async function updateLineItem(
  tx: QueryRunner,
  actor: AuditActor,
  lineItemId: string,
  patch: LineItemPatch,
) {
  const reportId = await reportIdForLineItem(tx, lineItemId);
  await assertDraft(tx, reportId);
  const before = await rowById(tx, 'expense_line_item', lineItemId);

  const sets: string[] = [];
  const values: unknown[] = [lineItemId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.categoryId !== undefined) {
    await assertCategory(tx, patch.categoryId);
    set('category_id', patch.categoryId);
    // Re-stamped ONLY because the category changed — that is a re-coding, and a
    // re-coding gets the account the new category points at now. Every other patch
    // (amount, tax, description) leaves the snapshot alone, which is the whole
    // point of it being a snapshot: "stamp on write, and never refresh" (AC-10).
    set('gl_account_id', await accountForCategory(tx, patch.categoryId));
  }
  if (patch.amountMinor !== undefined) set('amount_minor', toMinorString(patch.amountMinor, 'amount'));
  if (patch.taxMinor !== undefined) set('tax_minor', toMinorString(patch.taxMinor, 'tax'));
  if ('description' in patch) set('description', patch.description ?? null);
  if (sets.length === 0) {
    await auditEdit(
      tx,
      actor,
      AUDIT.lineItemEdited,
      'ExpenseLineItem',
      lineItemId,
      reportId,
      before,
      before,
    );
    return Object.keys(before).length === 0 ? null : before;
  }

  const r = await tx.query(
    `UPDATE expense_line_item SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`,
    values,
  );
  // The row diff is what makes `gl_account_id` visible here. It is re-stamped
  // when the category changes (AC-10) and named by no caller, so a patch-shaped
  // diff would record a re-coding without recording the account the money moved
  // to — which is the one column an accountant would actually check.
  const after = (r.rows[0] as Record<string, unknown> | undefined) ?? {};
  await auditEdit(
    tx,
    actor,
    AUDIT.lineItemEdited,
    'ExpenseLineItem',
    lineItemId,
    reportId,
    before,
    after,
  );
  await recomputeReportTotal(tx, reportId);
  return r.rows[0] ?? null;
}

export async function removeLineItem(tx: QueryRunner, actor: AuditActor, lineItemId: string) {
  const reportId = await reportIdForLineItem(tx, lineItemId);
  await assertDraft(tx, reportId);
  const before = await rowById(tx, 'expense_line_item', lineItemId);
  await tx.query('DELETE FROM expense_line_item WHERE id = $1', [lineItemId]);
  await auditAppend(tx, actor, {
    action: AUDIT.lineItemRemoved,
    entityType: 'ExpenseLineItem',
    entityId: lineItemId,
    details: { report_id: reportId, deleted: auditSnapshot(before) },
  });
  await recomputeReportTotal(tx, reportId);
  return reportId;
}

/**
 * Report total = sum of its line-item amounts (single currency, MVP).
 *
 * The write REFUSES on its own unless the report is DRAFT. Every caller has
 * already passed `assertDraft` — which locks the row — so in today's code this
 * cannot fire; it is here so that a caller written tomorrow without the gate
 * cannot restate a total somebody has already submitted, approved or been paid
 * against. Same argument as ExpenseOS #511 ("refuse to rewrite a decided report's
 * total"): the total is the figure the approver signs and the ledger books, and
 * the last write on every path is the one place a single guard covers them all.
 */
export async function recomputeReportTotal(tx: QueryRunner, reportId: string) {
  const s = await tx.query(
    `SELECT COALESCE(SUM(li.amount_minor), 0) AS total
       FROM expense_line_item li JOIN expense e ON e.id = li.expense_id
      WHERE e.report_id = $1`,
    [reportId],
  );
  const written = await tx.query(
    `UPDATE expense_report SET total_minor = $1, updated_at = now()
      WHERE id = $2 AND status = 'DRAFT'`,
    [s.rows[0].total, reportId],
  );
  if (written.rowCount !== 1) {
    throw new ExpenseError(
      `report ${reportId} is not a DRAFT; its total is what was submitted and is not recomputed`,
      'NOT_DRAFT',
      'REPORT_NOT_DRAFT',
    );
  }
  return BigInt(s.rows[0].total);
}

/* ── pickers (tenant-scoped reference reads) ───────────────────────────────── */

export interface CategoryOption {
  id: string;
  code: string;
  label: string;
  /**
   * The mapped account as `number — name`, or null when the category is unmapped.
   *
   * VX3-1 replaced `expense_category.gl_account`, a bare `text` column that had
   * held invented numbers matching no chart anywhere, with a real FK. This reads
   * through it so a picker can show what a category will post to.
   */
  gl_account: string | null;
  active: boolean;
}

export async function listCategories(
  tx: QueryRunner,
  opts: { includeInactive?: boolean } = {},
): Promise<CategoryOption[]> {
  const r = await tx.query(
    `SELECT c.id, c.code, c.label ->> 'en' AS label, c.active,
            CASE WHEN g.id IS NULL THEN NULL ELSE g.number || ' — ' || g.name END AS gl_account
       FROM expense_category c
       LEFT JOIN gl_account g ON g.id = c.gl_account_id AND g.active
      ${opts.includeInactive ? '' : 'WHERE c.active'}
      ORDER BY c.sort_order, c.label ->> 'en'`,
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
