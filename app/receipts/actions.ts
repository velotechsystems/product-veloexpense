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
 */
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { NewReport } from '@/lib/expenses/service';
import * as svc from '@/lib/receipts/service';

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

export async function confirmUpload(receiptId: string) {
  const receipt = await withCurrentOrg((tx) => svc.confirmUpload(tx, receiptId));
  revalidatePath('/expenses');
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
  const receipt = await withCurrentOrg((tx) => svc.attachReceipt(tx, receiptId, expenseId));
  revalidatePath('/expenses');
  return receipt;
}

export async function detachReceipt(receiptId: string) {
  const receipt = await withCurrentOrg((tx) => svc.detachReceipt(tx, receiptId));
  revalidatePath('/expenses');
  return receipt;
}

export async function removeReceipt(receiptId: string) {
  await withCurrentOrg((tx) => svc.removeReceipt(tx, receiptId));
  revalidatePath('/expenses');
}

export async function startFromReceipts(report: NewReport, receiptIds: string[]) {
  const email = await sessionEmail();
  const result = await withCurrentOrg((tx) => svc.startFromReceipts(tx, email, report, receiptIds));
  revalidatePath('/expenses');
  return result;
}
