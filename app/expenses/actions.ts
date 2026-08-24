'use server';
/**
 * VX1-4 — expense-report server actions. Each resolves the authenticated user,
 * then runs the service inside withCurrentOrg() so app.current_org / RLS are set.
 * (Velotech pattern: thin 'use server' wrappers over lib/<domain> logic.)
 */
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import * as svc from '@/lib/expenses/service';

async function sessionEmail(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return email;
}

export async function createReport(input: svc.NewReport) {
  const email = await sessionEmail();
  return withCurrentOrg((tx) => svc.createReport(tx, email, input));
}

export async function listReports() {
  return withCurrentOrg((tx) => svc.listReports(tx));
}

export async function getReport(reportId: string) {
  return withCurrentOrg((tx) => svc.getReport(tx, reportId));
}

export async function updateReport(
  reportId: string,
  patch: { title?: string; purpose?: string | null; businessUnitId?: string | null },
) {
  return withCurrentOrg((tx) => svc.updateReport(tx, reportId, patch));
}

export async function deleteReport(reportId: string) {
  return withCurrentOrg((tx) => svc.deleteReport(tx, reportId));
}

export async function addExpense(reportId: string, input: svc.NewExpense) {
  return withCurrentOrg((tx) => svc.addExpense(tx, reportId, input));
}

export async function addLineItem(expenseId: string, input: svc.NewLineItem) {
  return withCurrentOrg((tx) => svc.addLineItem(tx, expenseId, input));
}

export async function removeLineItem(lineItemId: string) {
  return withCurrentOrg((tx) => svc.removeLineItem(tx, lineItemId));
}
