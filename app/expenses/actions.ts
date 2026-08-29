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
 * VX1-7: every write re-runs the policy engine INSIDE the same transaction
 * (`policy.validateReport`), so a report's violations can never be stale
 * relative to its line items — a report that saves is a report that has just
 * been validated. Reads do not re-run it; they read the stored findings.
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
import * as policy from '@/lib/policy/service';
import * as lifecycle from '@/lib/expenses/lifecycle';
import { listBusinessUnits, type EmployeeRow } from '@/lib/employees/service';
import { requireActor, ForbiddenError } from '@/lib/auth/actor';
import { canReadReport, decidableTaskForReport } from '@/lib/approvals/inbox';
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
  return withCurrentOrg(async (tx) => fn(tx, await requireActor(tx, email)));
}

/** VX1-10: the rule lives in lib/expenses/service so receipts share it. */
async function reachableReport(tx: QueryRunner, actor: EmployeeRow, reportId: string) {
  const access = await svc.getReportAccess(tx, reportId);
  if (!access) throw new svc.ExpenseError('report not found', 'NOT_FOUND');
  if (!svc.canViewReport(actor, access)) {
    throw new ForbiddenError('forbidden: this report belongs to someone else');
  }
  return access;
}

/**
 * VX2-4: READABLE is wider than reachable — ownership OR an approval interest.
 *
 * Kept as a SEPARATE gate rather than widening `reachableReport`, and the reason
 * is a hole I nearly shipped. A recalled report goes back to DRAFT while its
 * cancelled tasks remain, so a former approver still has an approval interest in
 * it — and if the write actions used this gate, that approver could EDIT someone
 * else's draft. Every write stays on `reachableReport` (ownership); only reads
 * use this one.
 */
async function readableReport(tx: QueryRunner, actor: EmployeeRow, reportId: string) {
  const access = await svc.getReportAccess(tx, reportId);
  if (!access) throw new svc.ExpenseError('report not found', 'NOT_FOUND');
  if (!(await canReadReport(tx, actor, access))) {
    throw new ForbiddenError('forbidden: this report belongs to someone else');
  }
  return access;
}

/** Runs fn against a report the actor may READ — as its owner, an admin, or an
 *  approver of it. Reads only. */
async function onReportRead<T>(
  reportId: string,
  fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>,
): Promise<T> {
  return asActor(async (tx, actor) => {
    await readableReport(tx, actor, reportId);
    return fn(tx, actor);
  });
}

/** Runs fn against a report the actor is allowed to see/edit, or throws. */
async function onReport<T>(
  reportId: string,
  fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>,
): Promise<T> {
  return asActor(async (tx, actor) => {
    await reachableReport(tx, actor, reportId);
    return fn(tx, actor);
  });
}

async function onExpense<T>(
  expenseId: string,
  fn: (tx: QueryRunner, actor: EmployeeRow, reportId: string) => Promise<T>,
): Promise<T> {
  return asActor(async (tx, actor) => {
    const reportId = await svc.reportIdForExpense(tx, expenseId);
    await reachableReport(tx, actor, reportId);
    return fn(tx, actor, reportId);
  });
}

async function onLineItem<T>(
  lineItemId: string,
  fn: (tx: QueryRunner, actor: EmployeeRow, reportId: string) => Promise<T>,
): Promise<T> {
  return asActor(async (tx, actor) => {
    const reportId = await svc.reportIdForLineItem(tx, lineItemId);
    await reachableReport(tx, actor, reportId);
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
  return onReportRead(reportId, (tx) => svc.getReport(tx, reportId));
}

export async function getReportWorkbench(reportId: string) {
  return onReportRead(reportId, (tx) => svc.getReportWorkbench(tx, reportId));
}

/** The stored findings for a report — no re-run; saves do that. */
export async function getValidation(reportId: string) {
  return onReportRead(reportId, (tx) => policy.getValidation(tx, reportId));
}

/** Force a re-run, for the workbench's "re-check" affordance. */
export async function revalidateReport(reportId: string) {
  return onReport(reportId, (tx) => policy.validateReport(tx, reportId));
}

/** The transition trail (VX1-8). */
export async function getReportHistory(reportId: string) {
  return onReportRead(reportId, (tx) => lifecycle.listEvents(tx, reportId));
}

/** Whether the submit button should be live, and why not if it should not. */
/**
 * The task on this report the signed-in person may decide, or null.
 *
 * The page renders its decision panel from this and the action re-resolves it —
 * one question, one answer (GAP-AUDIT AP-15). ExpenseOS rendered an Approve
 * button from a role check while the mutation asked the engine, and shipped a
 * button that failed when pressed.
 */
export async function getDecidableTask(reportId: string) {
  return asActor(async (tx, actor) => {
    await readableReport(tx, actor, reportId);
    return decidableTaskForReport(tx, reportId, actor.id, { isAdmin: actor.role === 'ADMIN' });
  });
}

export async function getSubmitReadiness(reportId: string) {
  return onReport(reportId, (tx) => lifecycle.getSubmitReadiness(tx, reportId));
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
  return onReport(reportId, async (tx) => {
    const updated = await svc.updateReport(tx, reportId, patch);
    await policy.validateReport(tx, reportId);
    return updated;
  });
}

export async function deleteReport(reportId: string) {
  return onReport(reportId, (tx) => svc.deleteReport(tx, reportId));
}

export async function addExpense(reportId: string, input: svc.NewExpense) {
  return onReport(reportId, async (tx) => {
    const created = await svc.addExpense(tx, reportId, input);
    await policy.validateReport(tx, reportId);
    return created;
  });
}

export async function updateExpense(expenseId: string, patch: svc.ExpensePatch) {
  return onExpense(expenseId, async (tx, _actor, reportId) => {
    const updated = await svc.updateExpense(tx, expenseId, patch);
    await policy.validateReport(tx, reportId);
    return updated;
  });
}

export async function removeExpense(expenseId: string) {
  return onExpense(expenseId, async (tx, _actor, reportId) => {
    await svc.removeExpense(tx, expenseId);
    await policy.validateReport(tx, reportId);
    return reportId;
  });
}

export async function addLineItem(expenseId: string, input: svc.NewLineItem) {
  return onExpense(expenseId, async (tx, _actor, reportId) => {
    const created = await svc.addLineItem(tx, expenseId, input);
    await policy.validateReport(tx, reportId);
    return created;
  });
}

export async function updateLineItem(lineItemId: string, patch: svc.LineItemPatch) {
  return onLineItem(lineItemId, async (tx, _actor, reportId) => {
    const updated = await svc.updateLineItem(tx, lineItemId, patch);
    await policy.validateReport(tx, reportId);
    return updated;
  });
}

export async function removeLineItem(lineItemId: string) {
  return onLineItem(lineItemId, async (tx, _actor, reportId) => {
    await svc.removeLineItem(tx, lineItemId);
    await policy.validateReport(tx, reportId);
    return reportId;
  });
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

/* ── policy violations (VX1-7) ─────────────────────────────────────────────── */

export async function acknowledgeViolationFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const violationId = required(form, 'violationId');
  const failure = await guard(`/expenses/${reportId}`, () =>
    onReport(reportId, (tx, actor) =>
      policy
        .acknowledgeViolation(tx, violationId, actor.id, form.get('note')?.toString() ?? '')
        .then(() => {}),
    ),
  );
  if (failure) redirect(failure);
  refreshReport(reportId);
}

export async function clearAcknowledgementFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const violationId = required(form, 'violationId');
  const failure = await guard(`/expenses/${reportId}`, () =>
    onReport(reportId, (tx) => policy.clearAcknowledgement(tx, violationId)),
  );
  if (failure) redirect(failure);
  refreshReport(reportId);
}

export async function revalidateFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const failure = await guard(`/expenses/${reportId}`, () => revalidateReport(reportId).then(() => {}));
  if (failure) redirect(failure);
  refreshReport(reportId);
}

/* ── lifecycle (VX1-8) ─────────────────────────────────────────────────────── */

export async function submitReport(reportId: string) {
  return onReport(reportId, (tx, actor) => lifecycle.submitReport(tx, reportId, actor.id));
}

export async function recallReport(reportId: string, note?: string | null) {
  return onReport(reportId, (tx, actor) => lifecycle.recallReport(tx, reportId, actor.id, note));
}

export async function submitReportFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const failure = await guard(`/expenses/${reportId}`, () => submitReport(reportId).then(() => {}));
  if (failure) redirect(failure);
  refreshReport(reportId);
}

export async function recallReportFromForm(form: FormData) {
  const reportId = required(form, 'reportId');
  const failure = await guard(`/expenses/${reportId}`, () =>
    recallReport(reportId, text(form, 'note')).then(() => {}),
  );
  if (failure) redirect(failure);
  refreshReport(reportId);
}
