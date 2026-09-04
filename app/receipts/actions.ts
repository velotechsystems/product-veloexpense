'use server';
/**
 * VX1-5 + VX1-10 — receipt server actions (Module 5).
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
 * engine for that receipt's report, in the same transaction. RECEIPT_REQUIRED is
 * satisfied by attaching a receipt, and a violation panel that still showed the
 * block until the next unrelated save would just teach people to distrust it.
 *
 * VX1-10 — AUTHORIZATION. RLS scopes receipts to the ORG, not to a PERSON. Until
 * this ticket every action here trusted that: any signed-in colleague who had a
 * receipt id could download, detach or delete it, and a receipt could be added
 * to or removed from a SUBMITTED report that was supposed to be frozen. Every
 * action now resolves the acting employee inside the transaction and checks
 * `canViewReceipt` / `canModifyReceipt` (lib/receipts/service). Reports got this
 * treatment in VX1-6; receipts were the gap it left behind.
 */
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import { requireActor, ForbiddenError } from '@/lib/auth/actor';
import { auditActorOf } from '@/lib/audit/service';
import type { EmployeeRow } from '@/lib/employees/service';
import {
  canEditReport,
  canViewReport as canViewReportFor,
  getReportAccess,
  reportIdForExpense,
  type NewReport,
} from '@/lib/expenses/service';
import * as svc from '@/lib/receipts/service';
import * as policy from '@/lib/policy/service';

async function sessionEmail(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return email;
}

/** Runs fn as the signed-in employee of this tenant. */
async function asActor<T>(fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>): Promise<T> {
  const email = await sessionEmail();
  return withCurrentOrg(async (tx) => fn(tx, await requireActor(tx, email)));
}

/** Loads the receipt's ownership and refuses unless the actor may see it. */
async function withViewableReceipt<T>(
  receiptId: string,
  fn: (tx: QueryRunner, actor: EmployeeRow, ownership: svc.ReceiptOwnership) => Promise<T>,
): Promise<T> {
  return asActor(async (tx, actor) => {
    const ownership = await svc.getReceiptOwnership(tx, receiptId);
    if (!ownership) throw new svc.ReceiptError('receipt not found', 'NOT_FOUND');
    if (!svc.canViewReceipt(actor, ownership)) {
      throw new ForbiddenError('forbidden: this receipt belongs to someone else');
    }
    return fn(tx, actor, ownership);
  });
}

/** As above, and refuses when the receipt's report is no longer a draft. */
async function withModifiableReceipt<T>(
  receiptId: string,
  fn: (tx: QueryRunner, actor: EmployeeRow, ownership: svc.ReceiptOwnership) => Promise<T>,
): Promise<T> {
  return withViewableReceipt(receiptId, async (tx, actor, ownership) => {
    if (!svc.canModifyReceipt(actor, ownership)) {
      throw new svc.ReceiptError(
        `this receipt belongs to a ${ownership.reportStatus} report and can no longer be changed`,
        'REPORT_NOT_EDITABLE',
      );
    }
    return fn(tx, actor, ownership);
  });
}

/** Refuses unless the actor may edit the report this expense belongs to. */
async function assertCanEditExpense(tx: QueryRunner, actor: EmployeeRow, expenseId: string) {
  const reportId = await reportIdForExpense(tx, expenseId);
  const access = await getReportAccess(tx, reportId);
  if (!access) throw new svc.ReceiptError('expense not found in this organization', 'EXPENSE_NOT_FOUND');
  if (!canEditReport(actor, access)) {
    throw new ForbiddenError(
      access.status === 'DRAFT'
        ? 'forbidden: that report belongs to someone else'
        : `forbidden: report ${access.number ?? reportId} is ${access.status} and can no longer be changed`,
    );
  }
  return reportId;
}

/** Re-validates the report this receipt hangs off, if it is attached to one. */
async function revalidateReceiptReport(tx: QueryRunner, receiptId: string) {
  const ownership = await svc.getReceiptOwnership(tx, receiptId);
  const reportId = ownership?.reportId ?? null;
  if (reportId) await policy.validateReport(tx, reportId);
  return reportId;
}

function refresh(reportId: string | null) {
  revalidatePath('/expenses');
  if (reportId) revalidatePath(`/expenses/${reportId}`);
}

/* ── upload ────────────────────────────────────────────────────────────────── */

export async function createUploadIntent(input: svc.UploadIntentInput) {
  return asActor(async (tx, actor) => {
    // Uploading straight onto an expense means editing that report.
    if (input.expenseId) await assertCanEditExpense(tx, actor, input.expenseId);
    return svc.createUploadIntent(tx, actor.email, input);
  });
}

export async function confirmUpload(receiptId: string) {
  const { receipt, reportId } = await withModifiableReceipt(receiptId, async (tx) => ({
    receipt: await svc.confirmUpload(tx, receiptId),
    reportId: await revalidateReceiptReport(tx, receiptId),
  }));
  refresh(reportId);
  return receipt;
}

/* ── reads ─────────────────────────────────────────────────────────────────── */

export async function listReceiptsForExpense(expenseId: string) {
  return asActor(async (tx, actor) => {
    const reportId = await reportIdForExpense(tx, expenseId);
    const access = await getReportAccess(tx, reportId);
    if (!access || !canViewReportFor(actor, access)) {
      throw new ForbiddenError('forbidden: that report belongs to someone else');
    }
    return svc.listReceiptsForExpense(tx, expenseId);
  });
}

export async function listReceiptsForReport(reportId: string) {
  return asActor(async (tx, actor) => {
    const access = await getReportAccess(tx, reportId);
    if (!access || !canViewReportFor(actor, access)) {
      throw new ForbiddenError('forbidden: that report belongs to someone else');
    }
    return svc.listReceiptsForReport(tx, reportId);
  });
}

/** The signed-in user's receipt-first inbox — scoped to them by definition. */
export async function listUnattachedReceipts() {
  return asActor((tx, actor) => svc.listUnattachedReceipts(tx, actor.email));
}

export async function getReceiptDownloadUrl(receiptId: string) {
  // A signed URL is the whole permission: once handed out it works for anyone
  // holding it, so the check has to happen before it is minted.
  return withViewableReceipt(receiptId, (tx) => svc.getDownloadUrl(tx, receiptId));
}

/* ── attach / detach / remove ──────────────────────────────────────────────── */

export async function attachReceipt(receiptId: string, expenseId: string) {
  const { receipt, reportId } = await withModifiableReceipt(
    receiptId,
    async (tx, actor) => {
      // Two checks, not one: the actor must own the receipt AND be allowed to
      // edit the report it is being attached to. They can be different people's.
      await assertCanEditExpense(tx, actor, expenseId);
      const attached = await svc.attachReceipt(tx, receiptId, expenseId);
      return { receipt: attached, reportId: await revalidateReceiptReport(tx, receiptId) };
    },
  );
  refresh(reportId);
  return receipt;
}

export async function detachReceipt(receiptId: string) {
  const { receipt, reportId } = await withModifiableReceipt(receiptId, async (tx, _actor, ownership) => {
    // Read the report BEFORE detaching — afterwards the receipt no longer knows
    // which report it used to satisfy.
    const reportId = ownership.reportId;
    const detached = await svc.detachReceipt(tx, receiptId);
    if (reportId) await policy.validateReport(tx, reportId);
    return { receipt: detached, reportId };
  });
  refresh(reportId);
  return receipt;
}

export async function removeReceipt(receiptId: string) {
  const reportId = await withModifiableReceipt(receiptId, async (tx, _actor, ownership) => {
    const reportId = ownership.reportId;
    await svc.removeReceipt(tx, receiptId);
    if (reportId) await policy.validateReport(tx, reportId);
    return reportId;
  });
  refresh(reportId);
}

/* ── receipt-first ─────────────────────────────────────────────────────────── */

export async function startFromReceipts(report: NewReport, receiptIds: string[]) {
  const result = await asActor(async (tx, actor) => {
    // You may only build a report out of receipts you are allowed to touch.
    for (const receiptId of receiptIds) {
      const ownership = await svc.getReceiptOwnership(tx, receiptId);
      if (!ownership) throw new svc.ReceiptError(`receipt ${receiptId} not found`, 'NOT_FOUND');
      if (!svc.canModifyReceipt(actor, ownership)) {
        throw new ForbiddenError('forbidden: one of those receipts is not yours');
      }
    }
    const created = await svc.startFromReceipts(tx, auditActorOf(actor), actor.email, report, receiptIds);
    await policy.validateReport(tx, created.report.id);
    return created;
  });
  refresh(result.report.id as string);
  return result;
}
