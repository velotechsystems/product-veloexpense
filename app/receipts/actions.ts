'use server';
/**
 * VX1-5 — receipt server actions (Module 5).
 *
 * Thin 'use server' wrappers, same as app/expenses/actions.ts: resolve the
 * session, run inside withCurrentOrg() so app.current_org / RLS are set, and
 * delegate to lib/receipts/service. The storage driver is resolved by the
 * service from the environment.
 *
 * Client flow for an upload:
 *   const { receipt, upload } = await createUploadIntent({ filename, contentType });
 *   await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: file });
 *   await confirmUpload(receipt.id);
 *
 * VX1-9: anything that changes which receipts an expense has re-runs the policy
 * engine for that receipt's report, in the same transaction. RECEIPT_REQUIRED
 * is satisfied by attaching a receipt, and a violation panel that still showed
 * the block until the next unrelated save would just teach people to distrust
 * it. Found by writing the e2e, not by review.
 */
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import type { NewReport } from '@/lib/expenses/service';
import * as svc from '@/lib/receipts/service';
import * as policy from '@/lib/policy/service';

async function sessionEmail(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return email;
}

export async function createUploadIntent(input: svc.UploadIntentInput) {
  const email = await sessionEmail();
  return withCurrentOrg((tx) => svc.createUploadIntent(tx, email, input));
}

/** Re-validates the report this receipt hangs off, if it is attached to one. */
async function revalidateReceiptReport(tx: QueryRunner, receiptId: string) {
  const r = await tx.query(
    `SELECT e.report_id FROM receipt rc
       JOIN expense e ON e.id = rc.expense_id
      WHERE rc.id = $1`,
    [receiptId],
  );
  const reportId = r.rows[0]?.report_id as string | undefined;
  if (reportId) await policy.validateReport(tx, reportId);
  return reportId ?? null;
}

function refresh(reportId: string | null) {
  revalidatePath('/expenses');
  if (reportId) revalidatePath(`/expenses/${reportId}`);
}

export async function confirmUpload(receiptId: string) {
  const { receipt, reportId } = await withCurrentOrg(async (tx) => ({
    receipt: await svc.confirmUpload(tx, receiptId),
    reportId: await revalidateReceiptReport(tx, receiptId),
  }));
  refresh(reportId);
  return receipt;
}

export async function listReceiptsForExpense(expenseId: string) {
  return withCurrentOrg((tx) => svc.listReceiptsForExpense(tx, expenseId));
}

export async function listReceiptsForReport(reportId: string) {
  return withCurrentOrg((tx) => svc.listReceiptsForReport(tx, reportId));
}

/** The signed-in user's receipt-first inbox. */
export async function listUnattachedReceipts() {
  const email = await sessionEmail();
  return withCurrentOrg((tx) => svc.listUnattachedReceipts(tx, email));
}

export async function getReceiptDownloadUrl(receiptId: string) {
  return withCurrentOrg((tx) => svc.getDownloadUrl(tx, receiptId));
}

export async function attachReceipt(receiptId: string, expenseId: string) {
  const { receipt, reportId } = await withCurrentOrg(async (tx) => ({
    receipt: await svc.attachReceipt(tx, receiptId, expenseId),
    reportId: await revalidateReceiptReport(tx, receiptId),
  }));
  refresh(reportId);
  return receipt;
}

export async function detachReceipt(receiptId: string) {
  // Read the report BEFORE detaching — afterwards the receipt no longer knows
  // which report it used to satisfy.
  const { receipt, reportId } = await withCurrentOrg(async (tx) => {
    const before = await tx.query(
      `SELECT e.report_id FROM receipt rc JOIN expense e ON e.id = rc.expense_id WHERE rc.id = $1`,
      [receiptId],
    );
    const detached = await svc.detachReceipt(tx, receiptId);
    const reportId = (before.rows[0]?.report_id as string | undefined) ?? null;
    if (reportId) await policy.validateReport(tx, reportId);
    return { receipt: detached, reportId };
  });
  refresh(reportId);
  return receipt;
}

export async function removeReceipt(receiptId: string) {
  const reportId = await withCurrentOrg(async (tx) => {
    const before = await tx.query(
      `SELECT e.report_id FROM receipt rc JOIN expense e ON e.id = rc.expense_id WHERE rc.id = $1`,
      [receiptId],
    );
    await svc.removeReceipt(tx, receiptId);
    const reportId = (before.rows[0]?.report_id as string | undefined) ?? null;
    if (reportId) await policy.validateReport(tx, reportId);
    return reportId;
  });
  refresh(reportId);
}

export async function startFromReceipts(report: NewReport, receiptIds: string[]) {
  const email = await sessionEmail();
  const result = await withCurrentOrg((tx) => svc.startFromReceipts(tx, email, report, receiptIds));
  revalidatePath('/expenses');
  return result;
}
