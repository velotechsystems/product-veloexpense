'use server';
/**
 * VX1-7 — expense-policy admin actions (ExpenseOS Module 9 config surface).
 *
 * Same gating as the employee directory: ADMIN only, with the acting user's
 * role read from app_user INSIDE the tenant transaction, never from the session
 * token. Rules are tenant data, so RLS scopes them; the role check is what
 * stops an ordinary employee rewriting their own spending limits.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import { getEmployeeByEmail, type EmployeeRow } from '@/lib/employees/service';
import { listCategories, listCurrencies } from '@/lib/expenses/service';
import * as policy from '@/lib/policy/service';
import { parseAmountToMinor } from '@/lib/money';

const PAGE = '/admin/expense-policies';

async function asAdmin<T>(fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>): Promise<T> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error('unauthenticated');
  return withCurrentOrg(async (tx) => {
    const actor = await getEmployeeByEmail(tx, email);
    if (!actor) throw new Error('forbidden: no employee record in this organization');
    if (actor.role !== 'ADMIN' || actor.deleted_at !== null) {
      throw new Error('forbidden: admin role required');
    }
    return fn(tx, actor);
  });
}

/* ── reads ─────────────────────────────────────────────────────────────────── */

export async function getPoliciesPage() {
  return asAdmin(async (tx) => ({
    policies: await policy.listPolicies(tx),
    categories: await listCategories(tx, { includeInactive: true }),
    // VX3-2 / PE-1. `currencies` backs the two selects; `policyCurrency` also
    // carries which report currencies cannot be converted into it, which is the
    // one thing an admin changing this setting needs to see BEFORE they change it.
    policyCurrency: await policy.getPolicyCurrency(tx),
    currencies: await listCurrencies(tx),
  }));
}

/* ── writes (typed) ────────────────────────────────────────────────────────── */

export async function createPolicy(input: policy.NewPolicy) {
  return asAdmin((tx) => policy.createPolicy(tx, input));
}

export async function updatePolicy(policyId: string, patch: policy.PolicyPatch) {
  return asAdmin((tx) => policy.updatePolicy(tx, policyId, patch));
}

export async function deletePolicy(policyId: string) {
  return asAdmin((tx) => policy.deletePolicy(tx, policyId));
}

export async function restoreStarterRules() {
  return asAdmin((tx) => policy.ensureDefaultPolicies(tx));
}

/* ── form entry points ─────────────────────────────────────────────────────── */

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Admins type "500.00", the engine compares minor units. Two decimals is the
 * right assumption for a rule threshold: a policy is written in the tenant's
 * reporting currency, and every currency VeloExpense ships has minor_unit 2.
 * When a 0- or 3-decimal currency lands, this reads it from the tenant default.
 */
function amountParam(form: FormData, key: string): number | undefined {
  const raw = text(form, key);
  if (raw === null) return undefined;
  return Number(parseAmountToMinor(raw, 2));
}

async function guard(run: () => Promise<void>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong';
    return `${PAGE}?error=${encodeURIComponent(message)}`;
  }
}

export async function createPolicyFromForm(form: FormData) {
  const failure = await guard(async () => {
    const kind = text(form, 'kind');
    if (!kind) throw new Error('pick a rule');
    await createPolicy({
      kind,
      severity: text(form, 'severity') ?? undefined,
      enabled: form.get('enabled') !== null,
      categoryId: text(form, 'categoryId'),
      currencyCode: text(form, 'currencyCode'),
      params: { thresholdMinor: amountParam(form, 'thresholdMinor') },
      effectiveFrom: text(form, 'effectiveFrom'),
      effectiveTo: text(form, 'effectiveTo'),
    });
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function updatePolicyFromForm(form: FormData) {
  const failure = await guard(async () => {
    const policyId = text(form, 'policyId');
    if (!policyId) throw new Error('policyId is required');
    await updatePolicy(policyId, {
      severity: text(form, 'severity') ?? undefined,
      enabled: form.get('enabled') !== null,
      categoryId: text(form, 'categoryId'),
      currencyCode: text(form, 'currencyCode'),
      params: { thresholdMinor: amountParam(form, 'thresholdMinor') },
      effectiveFrom: text(form, 'effectiveFrom'),
      effectiveTo: text(form, 'effectiveTo'),
    });
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

/**
 * The tenant-wide policy currency.
 *
 * Its own action rather than a field on a rule form: it changes what EVERY
 * threshold in the tenant means, so it should not be something you alter as a side
 * effect of editing one rule's severity.
 */
export async function setPolicyCurrencyFromForm(form: FormData) {
  const failure = await guard(async () => {
    const code = text(form, 'policyCurrency');
    if (!code) throw new Error('pick a currency');
    await asAdmin((tx) => policy.setPolicyCurrency(tx, code));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
  revalidatePath('/expenses');
}

export async function deletePolicyFromForm(form: FormData) {
  const failure = await guard(async () => {
    const policyId = text(form, 'policyId');
    if (!policyId) throw new Error('policyId is required');
    await deletePolicy(policyId);
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function restoreStarterRulesFromForm() {
  const failure = await guard(() => restoreStarterRules().then(() => {}));
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}
