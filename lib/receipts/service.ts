/**
 * VX1-5 — receipts service (Module 5).
 *
 * Same shape as lib/expenses and lib/employees: pure functions over a tenant
 * QueryRunner, with the storage driver passed in. The caller (a server action)
 * has already opened the transaction via withCurrentOrg(), so RLS scopes every
 * row — which is also the whole tenant check on downloads: if the receipt row
 * is not visible, no URL is ever signed for its key.
 *
 * Upload is two-phase, because the browser PUTs straight to S3/MinIO:
 *   1. createUploadIntent — reserve a tenant-prefixed key, write a PENDING row,
 *      hand back a presigned PUT.
 *   2. confirmUpload      — HEAD the object, record the REAL size, flip to
 *      STORED. A client-reported size is never trusted, and an upload that
 *      never happened cannot be confirmed.
 *
 * Receipt-first (startFromReceipts): receipts can exist unattached
 * (expense_id IS NULL) in the uploader's inbox, then be turned into a report
 * with one expense per receipt.
 */
import { randomUUID } from 'node:crypto';
import type { UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { DomainError } from '@/lib/errors/domain';
import type { QueryRunner } from '@/lib/db/client';
import type { Storage } from '@/lib/storage';
import { getStorage } from '@/lib/storage';
import * as expenses from '@/lib/expenses/service';
import type { Actor } from '@/lib/auth/actor';
// Shared with the browser via lib/receipts/constants (this module imports pg).
import { ALLOWED_CONTENT_TYPES, MAX_RECEIPT_BYTES } from './constants';
import type { AuditActor } from '@/lib/audit/service';

export { ALLOWED_CONTENT_TYPES, MAX_RECEIPT_BYTES };

const ORG = "current_setting('app.current_org', true)::uuid";

export type ReceiptStatus = 'PENDING' | 'STORED';

export interface ReceiptRow {
  id: string;
  expense_id: string | null;
  s3_key: string;
  filename: string;
  content_type: string;
  size_bytes: number | null;
  status: ReceiptStatus;
  uploaded_by_id: string;
  uploaded_at: Date;
}

export class ReceiptError extends DomainError {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'UNSUPPORTED_TYPE'
      | 'TOO_LARGE'
      | 'NOT_UPLOADED'
      | 'ALREADY_STORED'
      | 'NOT_STORED'
      | 'EXPENSE_NOT_FOUND'
      | 'UPLOADER_NOT_FOUND'
      | 'NO_RECEIPTS'
      | 'FORBIDDEN'
      | 'REPORT_NOT_EDITABLE',
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
    this.name = 'ReceiptError';
  }
}

const SELECT_RECEIPT = `
  SELECT id, expense_id, s3_key, filename, content_type, size_bytes, status,
         uploaded_by_id, uploaded_at
    FROM receipt`;

/**
 * Storage keys are tenant-prefixed, so a bucket listing is segmented by org and
 * a stray key can never be mistaken for another tenant's. The receipt id makes
 * the key unique even when two people upload "receipt.pdf" in the same second.
 */
export function receiptKey(organizationId: string, receiptId: string, filename: string) {
  return `org/${organizationId}/receipts/${receiptId}/${sanitizeFilename(filename)}`;
}

/** Defensive: filenames arrive from a browser file picker. */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'receipt';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return (cleaned || 'receipt').slice(0, 120);
}

async function currentOrgId(tx: QueryRunner): Promise<string> {
  const r = await tx.query(`SELECT ${ORG} AS org`);
  const org = r.rows[0]?.org as string | null;
  if (!org) throw new Error('no tenant context');
  return org;
}

async function resolveUploader(tx: QueryRunner, uploaderEmail: string): Promise<string> {
  const r = await tx.query('SELECT id FROM app_user WHERE lower(email) = lower($1) LIMIT 1', [uploaderEmail]);
  if (r.rows.length === 0) {
    // No user copy: the actor is resolved from the session before any action
    // runs, so this cannot fire for a real request. Tagging it with
    // MANAGER_NOT_IN_ORG (as a first pass did) rendered "That manager is not in
    // this organization" at somebody uploading a receipt.
    throw new ReceiptError('uploader not found in this organization', 'UPLOADER_NOT_FOUND');
  }
  return r.rows[0].id as string;
}

/* ── access ────────────────────────────────────────────────────────────────── */

/**
 * Everything an access decision about a receipt depends on, in one row.
 *
 * A receipt has TWO possible owners: the person who uploaded it, and — once it
 * is attached — the submitter of the report it now belongs to. Both need
 * access, because the receipt-first flow lets one person upload into their
 * inbox and the report is what someone else may later be reviewing.
 */
export interface ReceiptOwnership {
  receiptId: string;
  uploaderId: string;
  expenseId: string | null;
  reportId: string | null;
  reportSubmitterId: string | null;
  reportStatus: expenses.ReportStatus | null;
}

export async function getReceiptOwnership(
  tx: QueryRunner,
  receiptId: string,
): Promise<ReceiptOwnership | null> {
  const r = await tx.query(
    `SELECT rc.id            AS "receiptId",
            rc.uploaded_by_id AS "uploaderId",
            rc.expense_id     AS "expenseId",
            e.report_id       AS "reportId",
            rep.submitter_id  AS "reportSubmitterId",
            rep.status        AS "reportStatus"
       FROM receipt rc
       LEFT JOIN expense e ON e.id = rc.expense_id
       LEFT JOIN expense_report rep ON rep.id = e.report_id
      WHERE rc.id = $1`,
    [receiptId],
  );
  return (r.rows[0] as ReceiptOwnership) ?? null;
}

/**
 * RLS scopes receipts to the ORG, which is NOT the same as scoping them to a
 * person: before this check, any signed-in colleague holding a receipt id could
 * download, detach or delete it. This is the receipt-side equivalent of
 * canViewReport / canEditReport.
 */
export function canViewReceipt(actor: Actor, ownership: ReceiptOwnership): boolean {
  if (actor.role === 'ADMIN') return true;
  if (actor.id === ownership.uploaderId) return true;
  return ownership.reportSubmitterId !== null && actor.id === ownership.reportSubmitterId;
}

/**
 * Changing a receipt additionally requires that its report — if it has one —
 * still be a draft. A submitted report is frozen, and a frozen report whose
 * receipts can still be deleted is not actually frozen.
 */
export function canModifyReceipt(actor: Actor, ownership: ReceiptOwnership): boolean {
  if (!canViewReceipt(actor, ownership)) return false;
  return ownership.reportStatus === null || ownership.reportStatus === 'DRAFT';
}

/* ── upload ────────────────────────────────────────────────────────────────── */

export interface UploadIntentInput {
  filename: string;
  contentType: string;
  /** Attach on confirm; omit for a receipt-first upload into the inbox. */
  expenseId?: string | null;
}

export async function createUploadIntent(
  tx: QueryRunner,
  uploaderEmail: string,
  input: UploadIntentInput,
  storage: Storage = getStorage(),
) {
  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    throw new ReceiptError(`unsupported receipt type: ${input.contentType}`, 'UNSUPPORTED_TYPE',
      { code: 'RECEIPT_TYPE_UNSUPPORTED', params: { mime: String(input.contentType) } },
    );
  }

  const organizationId = await currentOrgId(tx);
  const uploaderId = await resolveUploader(tx, uploaderEmail);

  if (input.expenseId) await assertExpenseVisible(tx, input.expenseId);

  const receiptId = randomUUID();
  const key = receiptKey(organizationId, receiptId, input.filename);

  const inserted = await tx.query(
    `INSERT INTO receipt
       (id, organization_id, expense_id, s3_key, filename, content_type, status, uploaded_by_id)
     VALUES ($1, ${ORG}, $2, $3, $4, $5, 'PENDING', $6)
     RETURNING id`,
    [receiptId, input.expenseId ?? null, key, sanitizeFilename(input.filename), input.contentType, uploaderId],
  );

  const upload = await storage.presignUpload(key, input.contentType);
  return {
    receipt: (await getReceipt(tx, inserted.rows[0].id))!,
    upload,
  };
}

/**
 * Called after the browser's PUT succeeds. Reads the object back so the row
 * records what storage actually holds; refuses anything oversized and deletes
 * it rather than leaving a row pointing at a too-large object.
 */
export async function confirmUpload(
  tx: QueryRunner,
  receiptId: string,
  storage: Storage = getStorage(),
): Promise<ReceiptRow> {
  const receipt = await getReceipt(tx, receiptId);
  if (!receipt) throw new ReceiptError('receipt not found', 'NOT_FOUND');
  if (receipt.status === 'STORED') throw new ReceiptError('receipt already confirmed', 'ALREADY_STORED',
      'RECEIPT_ALREADY_CONFIRMED',
    );

  const head = await storage.head(receipt.s3_key);
  if (!head) throw new ReceiptError('no object was uploaded for this receipt', 'NOT_UPLOADED',
      'RECEIPT_NOTHING_UPLOADED',
    );

  if (head.sizeBytes > MAX_RECEIPT_BYTES) {
    await storage.delete(receipt.s3_key);
    await tx.query('DELETE FROM receipt WHERE id = $1', [receiptId]);
    throw new ReceiptError(
      `receipt is ${head.sizeBytes} bytes; the limit is ${MAX_RECEIPT_BYTES}`,
      'TOO_LARGE',
      {
        code: 'RECEIPT_TOO_LARGE',
        params: { size: head.sizeBytes ?? 0, limit: MAX_RECEIPT_BYTES },
      },
    );
  }

  await tx.query("UPDATE receipt SET size_bytes = $2, status = 'STORED' WHERE id = $1", [
    receiptId,
    head.sizeBytes,
  ]);
  return (await getReceipt(tx, receiptId))!;
}

/* ── reads ─────────────────────────────────────────────────────────────────── */

export async function getReceipt(tx: QueryRunner, receiptId: string): Promise<ReceiptRow | null> {
  const r = await tx.query(`${SELECT_RECEIPT} WHERE id = $1`, [receiptId]);
  return (r.rows[0] as ReceiptRow) ?? null;
}

export async function listReceiptsForExpense(tx: QueryRunner, expenseId: string): Promise<ReceiptRow[]> {
  const r = await tx.query(
    `${SELECT_RECEIPT} WHERE expense_id = $1 AND status = 'STORED' ORDER BY uploaded_at`,
    [expenseId],
  );
  return r.rows as ReceiptRow[];
}

export async function listReceiptsForReport(tx: QueryRunner, reportId: string): Promise<ReceiptRow[]> {
  const r = await tx.query(
    `SELECT rc.id, rc.expense_id, rc.s3_key, rc.filename, rc.content_type, rc.size_bytes,
            rc.status, rc.uploaded_by_id, rc.uploaded_at
       FROM receipt rc
       JOIN expense e ON e.id = rc.expense_id
      WHERE e.report_id = $1 AND rc.status = 'STORED'
      ORDER BY rc.uploaded_at`,
    [reportId],
  );
  return r.rows as ReceiptRow[];
}

/** The receipt-first inbox: my confirmed uploads that aren't on an expense yet. */
export async function listUnattachedReceipts(tx: QueryRunner, uploaderEmail: string): Promise<ReceiptRow[]> {
  const uploaderId = await resolveUploader(tx, uploaderEmail);
  const r = await tx.query(
    `${SELECT_RECEIPT}
      WHERE expense_id IS NULL AND uploaded_by_id = $1 AND status = 'STORED'
      ORDER BY uploaded_at DESC`,
    [uploaderId],
  );
  return r.rows as ReceiptRow[];
}

/**
 * A short-lived presigned GET. The RLS-scoped SELECT above it is the tenant
 * check — an invisible receipt yields no row, so no URL is signed.
 */
export async function getDownloadUrl(
  tx: QueryRunner,
  receiptId: string,
  storage: Storage = getStorage(),
): Promise<string> {
  const receipt = await getReceipt(tx, receiptId);
  if (!receipt) throw new ReceiptError('receipt not found', 'NOT_FOUND');
  if (receipt.status !== 'STORED') throw new ReceiptError('receipt upload is not complete', 'NOT_STORED',
      'RECEIPT_UPLOAD_INCOMPLETE',
    );
  return storage.presignDownload(receipt.s3_key, receipt.filename);
}

/* ── attach / detach / remove ──────────────────────────────────────────────── */

async function assertExpenseVisible(tx: QueryRunner, expenseId: string) {
  const r = await tx.query('SELECT id FROM expense WHERE id = $1', [expenseId]);
  if (r.rows.length === 0) {
    throw new ReceiptError('expense not found in this organization', 'EXPENSE_NOT_FOUND');
  }
}

export async function attachReceipt(
  tx: QueryRunner,
  receiptId: string,
  expenseId: string,
): Promise<ReceiptRow> {
  const receipt = await getReceipt(tx, receiptId);
  if (!receipt) throw new ReceiptError('receipt not found', 'NOT_FOUND');
  await assertExpenseVisible(tx, expenseId);
  await tx.query('UPDATE receipt SET expense_id = $2 WHERE id = $1', [receiptId, expenseId]);
  return (await getReceipt(tx, receiptId))!;
}

/** Back to the inbox, not deleted. */
export async function detachReceipt(tx: QueryRunner, receiptId: string): Promise<ReceiptRow> {
  const receipt = await getReceipt(tx, receiptId);
  if (!receipt) throw new ReceiptError('receipt not found', 'NOT_FOUND');
  await tx.query('UPDATE receipt SET expense_id = NULL WHERE id = $1', [receiptId]);
  return (await getReceipt(tx, receiptId))!;
}

/**
 * Delete the row and the object. The object is deleted first: a failure there
 * aborts the transaction and leaves both in place, whereas the reverse order
 * could orphan bytes no row points at.
 */
export async function removeReceipt(
  tx: QueryRunner,
  receiptId: string,
  storage: Storage = getStorage(),
): Promise<void> {
  const receipt = await getReceipt(tx, receiptId);
  if (!receipt) throw new ReceiptError('receipt not found', 'NOT_FOUND');
  await storage.delete(receipt.s3_key);
  await tx.query('DELETE FROM receipt WHERE id = $1', [receiptId]);
}

/* ── receipt-first ─────────────────────────────────────────────────────────── */

/**
 * Module 5's "start from receipts": turn a pile of inbox receipts into a draft
 * report with one expense per receipt, each with its receipt attached. Line
 * items stay empty — the employee codes the amounts in the workbench (VX1-6),
 * and OCR/extraction is a later phase.
 */
/**
 * UD-11: the actor is separate from `submitterEmail` even though every caller
 * today passes the same person. They are different facts — who performed this,
 * and whose report it is — and this is the one path in the product that creates
 * expenses on a report from OUTSIDE `app/expenses/actions.ts`. It is also the
 * measured argument against auditing at the edge: had the audit gone in the
 * actions file, the receipt-first flow would have created expenses with no audit
 * row from the day it shipped.
 */
export async function startFromReceipts(
  tx: QueryRunner,
  actor: AuditActor,
  submitterEmail: string,
  report: expenses.NewReport,
  receiptIds: string[],
) {
  if (receiptIds.length === 0) throw new ReceiptError('no receipts selected', 'NO_RECEIPTS',
      'RECEIPT_NONE_SELECTED',
    );

  const created = await expenses.createReport(tx, submitterEmail, report);

  const attached: ReceiptRow[] = [];
  for (const receiptId of receiptIds) {
    const receipt = await getReceipt(tx, receiptId);
    if (!receipt) throw new ReceiptError(`receipt ${receiptId} not found`, 'NOT_FOUND');
    if (receipt.status !== 'STORED') {
      throw new ReceiptError(`receipt ${receipt.filename} is not uploaded yet`, 'NOT_STORED',
      { code: 'RECEIPT_NOT_UPLOADED_YET', params: { filename: receipt.filename } },
    );
    }
    const expense = await expenses.addExpense(tx, actor, created.id, {
      currencyCode: report.currencyCode,
      notes: `From receipt ${receipt.filename}`,
    });
    attached.push(await attachReceipt(tx, receiptId, expense.id));
  }

  return { report: created, receipts: attached };
}
