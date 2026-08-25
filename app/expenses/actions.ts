'use server';
/**
 * VX1-4 + VX1-6 — expense-report server actions. Each resolves the
 * authenticated user, then runs the service inside withCurrentOrg() so
 * app.current_org / RLS are set. (Velotech pattern: thin 'use server' wrappers
 * over lib/<domain> logic.)
 *
 * Authorization (VX1-6). RLS scopes rows to the ORG, which is not the same as
 * scoping them to a PERSON: without a second check any colleague who guessed a
 * report id could edit it. So every report-scoped action loads the acting
 * user's app_user row INSIDE the tenant transaction (never from the session
 * token — house rule) and requires that they either submitted the report or
 * hold ADMIN. Approvals, and a manager's view of their reports, arrive with the
 * approval engine in Phase 2; MANAGER gets no extra reach here yet.
 *
 * The *FromForm entry points exist because the workbench pages are server
 * components posting plain <form action={serverAction}>. They take FormData,
 * parse typed values out of it, and on a validation failure redirect back with
 * ?error=… rather than throwing into the error boundary — an employee who typed
 * "12,34" should get a sentence, not a stack trace.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import * as svc from '@/lib/expenses/service';
import { getEmployeeByEmail, listBusinessUnits, type EmployeeRow } from '@/lib/employees/service';
import { parseAmountToMinor } from '@/lib/money';

async function sessionEmail(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return email;
}

/** Runs fn as the signed-in employee of this tenant. */
async function asActor<T>(fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>): Promise<T> {
  const email = await sessionEmail();
  return withCurrentOrg(async (tx) => {
    const actor = await getEmployeeByEmail(tx, email);
    if (!actor) throw new Error('forbidden: no employee record in this organization');
    if (actor.deleted_at !== null) throw new Error('forbidden: this account is deactivated');
    return fn(tx, actor);
  });
}

function canReach(actor: EmployeeRow, submitterId: string) {
  return actor.role === 'ADMIN' || actor.id === submitterId;
}

/** Runs fn against a report the actor is allowed to see/edit, or throws. */
async function onReport<T>(
  reportId: string,
  fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>,
): Promise<T> {
  return asActor(async (tx, actor) => {
    const r = await tx.query('SELECT submitter_id FROM expense_report WHERE id = $1', [reportId]);
    if (r.rows.length === 0) throw new svc.ExpenseError('report not found', 'NOT_FOUND');
    if (!canReach(actor, r.rows[0].submitter_id)) {
      throw new Error('forbidden: this report belongs to someone else');
    }
    return fn(tx, actor);
  });
}

async function onExpense<T>(
  expenseId: string,
  fn: (tx: QueryRunner, actor: EmployeeRow, reportId: string) => Promise<T>,
): Promise<T> {
  return asActor(async (tx, actor) => {
    const reportId = await svc.reportIdForExpense(tx, expenseId);
    const r = await tx.query('SELECT submitter_id FROM expense_report WHERE id = $1', [reportId]);
    if (!canReach(actor, r.rows[0].submitter_id)) {
      throw new Error('forbidden: this report belongs to someone else');
    }
    return fn(tx, actor, reportId);
  });
}

async function onLineItem<T>(
  lineItemId: string,
  fn: (tx: QueryRunner, actor: EmployeeRow, reportId: string) => Promise<T>,
): Promise<T> {
  return asActor(async (tx, actor) => {
    const reportId = await svc.reportIdForLineItem(tx, lineItemId);
    const r = await tx.query('SELECT submitter_id FROM expense_report WHERE id = $1', [reportId]);
    if (!canReach(actor, r.rows[0].submitter_id)) {
      throw new Error('forbidden: this report belongs to someone else');
    }
    return fn(tx, actor, reportId);
  });
}

/* ── reads ─────────────────────────────────────────────────────────────────── */

/** The workbench list. Defaults to the signed-in employee's own reports. */
export async function listReports(filter: svc.ReportListFilter = {}) {
  return asActor((tx, actor) =>
    svc.listReports(tx, {
      ...filter,
      // Only an admin may drop the submitter scope (pass submitterEmail: null).
      submitterEmail:
        filter.submitterEmail === null && actor.role === 'ADMIN'
          ? null
          : (filter.submitterEmail ?? actor.email),
    }),
  );
}

export async function getReport(reportId: string) {
  return onReport(reportId, (tx) => svc.getReport(tx, reportId));
}

export async function getReportWorkbench(reportId: string) {
  return onReport(reportId, (tx) => svc.getReportWorkbench(tx, reportId));
}

/** Everything the workbench pickers need, in one round trip. */
export async function getWorkbenchOptions() {
  return asActor(async (tx, actor) => ({
    categories: await svc.listCategories(tx),
    currencies: await svc.listCurrencies(tx),
    businessUnits: await listBusinessUnits(tx),
    actor: { id: actor.id, email: actor.email, role: actor.role, name: actor.display_name },
  }));
}

/* ── writes (typed) ────────────────────────────────────────────────────────── */

export async function createReport(input: svc.NewReport) {
  return asActor((tx, actor) => svc.createReport(tx, actor.email, input));
}

export async function updateReport(reportId: string, patch: svc.ReportPatch) {
  return onReport(reportId, (tx) => svc.updateReport(tx, reportId, patch));
}

export async function deleteReport(reportId: string) {
  return onReport(reportId, (tx) => svc.deleteReport(tx, reportId));
}

export async function addExpense(reportId: string, input: svc.NewExpense) {
  return onReport(reportId, (tx) => svc.addExpense(tx, reportId, input));
}

export async function updateExpense(expenseId: string, patch: svc.ExpensePatch) {
  return onExpense(expenseId, (tx) => svc.updateExpense(tx, expenseId, patch));
}

export async function removeExpense(expenseId: string) {
  return onExpense(expenseId, (tx) => svc.removeExpense(tx, expenseId));
}

export async function addLineItem(expenseId: string, input: svc.NewLineItem) {
  return onExpense(expenseId, (tx) => svc.addLineItem(tx, expenseId, input));
}

export async function updateLineItem(lineItemId: string, patch: svc.LineItemPatch) {
  return onLineItem(lineItemId, (tx) => svc.updateLineItem(tx, lineItemId, patch));
}

export async function removeLineItem(lineItemId: string) {
  return onLineItem(lineItemId, (tx) => svc.removeLineItem(tx, lineItemId));
}

/* ── form entry points ─────────────────────────────────────────────────────── */

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function required(form: FormData, key: string): string {
  const value = text(form, key);
  if (!value) throw new svc.ExpenseError(`${key} is required`, 'NOT_FOUND');
  return value;
}

function refreshReport(reportId: string) {
  revalidatePath('/expenses');
  revalidatePath(`/expenses/${reportId}`);
}

/**
 * Runs a form mutation and turns a failure into a message on the page the user
 * is already looking at. redirect() throws by design, so it stays outside.
 */
async function guard(backTo: string, run: () => Promise<void>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong';
    return `${backTo}${backTo.includes('?') ? '&' : '?'}error=${encodeURIComponent(message)}`;
  }
}

export async function createReportFromForm(form: FormData) {
  let reportId: string | null = null;
  const failure = await guard('/expenses/new', async () => {
    const created = await createReport({
      title: required(form, 'title'),
      purpose: text(form, 'purpose'),
      currencyCode: required(form, 'currencyCode'),
      businessUnitId: text(form, 'businessUnitId'),
    });
    reportId = created.id as string;
  });
  if (failure) redirect(failure);
  revalidatePath('/expenses');
  redirect(`/expenses/${reportId}`);
}

export async function updateReportFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const failure = await guard(`/expenses/${reportId}`, async () => {
    await updateReport(reportId, {
      title: required(form, 'title'),
      purpose: text(form, 'purpose'),
      businessUnitId: text(form, 'businessUnitId'),
      currencyCode: required(form, 'currencyCode'),
    });
  });
  if (failure) redirect(failure);
  refreshReport(reportId);
}

export async function deleteReportFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const failure = await guard(`/expenses/${reportId}`, () => deleteReport(reportId).then(() => {}));
  if (failure) redirect(failure);
  revalidatePath('/expenses');
  redirect('/expenses');
}

export async function addExpenseFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const failure = await guard(`/expenses/${reportId}`, async () => {
    await addExpense(reportId, {
      merchant: text(form, 'merchant'),
      txnDate: text(form, 'txnDate'),
      notes: text(form, 'notes'),
      currencyCode: required(form, 'currencyCode'),
    });
  });
  if (failure) redirect(failure);
  refreshReport(reportId);
}

export async function updateExpenseFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const expenseId = required(form, 'expenseId');
  const failure = await guard(`/expenses/${reportId}`, async () => {
    await updateExpense(expenseId, {
      merchant: text(form, 'merchant'),
      txnDate: text(form, 'txnDate'),
      notes: text(form, 'notes'),
    });
  });
  if (failure) redirect(failure);
  refreshReport(reportId);
}

export async function removeExpenseFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const expenseId = required(form, 'expenseId');
  const failure = await guard(`/expenses/${reportId}`, () =>
    removeExpense(expenseId).then(() => {}),
  );
  if (failure) redirect(failure);
  refreshReport(reportId);
}

export async function addLineItemFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const expenseId = required(form, 'expenseId');
  const failure = await guard(`/expenses/${reportId}`, async () => {
    const minorUnit = await onReport(reportId, (tx) => svc.minorUnitForReport(tx, reportId));
    await addLineItem(expenseId, {
      categoryId: required(form, 'categoryId'),
      amountMinor: parseAmountToMinor(required(form, 'amount'), minorUnit),
      taxMinor: parseAmountToMinor(text(form, 'tax') ?? '0', minorUnit),
      description: text(form, 'description'),
    });
  });
  if (failure) redirect(failure);
  refreshReport(reportId);
}

export async function updateLineItemFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const lineItemId = required(form, 'lineItemId');
  const failure = await guard(`/expenses/${reportId}`, async () => {
    const minorUnit = await onReport(reportId, (tx) => svc.minorUnitForReport(tx, reportId));
    await updateLineItem(lineItemId, {
      categoryId: required(form, 'categoryId'),
      amountMinor: parseAmountToMinor(required(form, 'amount'), minorUnit),
      taxMinor: parseAmountToMinor(text(form, 'tax') ?? '0', minorUnit),
      description: text(form, 'description'),
    });
  });
  if (failure) redirect(failure);
  refreshReport(reportId);
}

export async function removeLineItemFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const lineItemId = required(form, 'lineItemId');
  const failure = await guard(`/expenses/${reportId}`, () =>
    removeLineItem(lineItemId).then(() => {}),
  );
  if (failure) redirect(failure);
  refreshReport(reportId);
}
