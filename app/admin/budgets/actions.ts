'use server';
/**
 * VX4-5 part 3b — /admin/budgets.
 *
 * ADMIN only, with the acting user's role read from `app_user` INSIDE the tenant
 * transaction rather than from the session token — the same gate every other
 * /admin surface uses.
 *
 * EVERY EXPORT HERE IS AN `export async function`, and that is a rule rather than
 * a style: a `'use server'` module registers every export as a server action, and
 * one it cannot wrap makes it register NONE of them — a clean build with a dead
 * form, failing in the browser with "Failed to find Server Action". That shipped
 * once on `/approve` (VX2-8) and `npm run check:actions` now fails the build on
 * it. So the page reads its data through `getBudgetsPage()` below rather than
 * importing anything else from this file.
 */
import { redirect } from 'next/navigation';
import { errorParam } from '@/lib/errors/domain';
import { revalidatePath } from 'next/cache';
import { activeChoices, listBusinessUnits, listDepartments } from '@/lib/employees/service';
import { listCurrencies } from '@/lib/expenses/service';
import { listPostableAccounts } from '@/lib/accounts/service';
import { isModuleEnabled } from '@/lib/modules/service';
import * as budgets from '@/lib/budgets/admin';
import { parseAmountToMinor } from '@/lib/money';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';

const PAGE = '/admin/budgets';

/* ── reads ─────────────────────────────────────────────────────────────────── */

export async function getBudgetsPage() {
  return asAdminPage(async (tx) => ({
    // UNGATED on purpose (VX4-1 / MT-3): the page has to be able to say WHY it is
    // empty, and a gated read would make an off module indistinguishable from a
    // tenant that has not made a budget yet.
    budgets: await budgets.listBudgets(tx),
    moduleEnabled: await isModuleEnabled(tx, 'budgets'),
    // A budget names a GL ACCOUNT, which lives behind the ACCOUNTING module — so
    // this list is empty when accounting is off, and the page says so rather than
    // offering an empty picker with no explanation.
    accountingEnabled: await isModuleEnabled(tx, 'accounting'),
    accounts: await listPostableAccounts(tx),
    departments: await listDepartments(tx),
    // A new budget may be scoped to an ACTIVE business unit only; deactivated ones are
    // retired (the Wave 1 port's soft delete). Existing budgets keep theirs, by name.
    businessUnits: activeChoices(await listBusinessUnits(tx)),
    currencies: await listCurrencies(tx),
    people: await tx.query(
      `SELECT id, COALESCE(display_name, email) AS name, email
         FROM app_user WHERE deleted_at IS NULL ORDER BY name`,
    ).then((r) => r.rows as Array<{ id: string; name: string; email: string }>),
  }));
}

/* ── form plumbing ─────────────────────────────────────────────────────────── */

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function required(form: FormData, key: string, what: string): string {
  const value = text(form, key);
  if (!value) throw new Error(`${what} is required`);
  return value;
}

async function guard(run: () => Promise<void>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const message = errorParam(err, 'admin/budgets');
    return `${PAGE}?error=${encodeURIComponent(message)}`;
  }
}

/* ── writes ────────────────────────────────────────────────────────────────── */

export async function createBudgetFromForm(form: FormData) {
  const failure = await guard(async () => {
    const year = Number(required(form, 'fiscalYear', 'a fiscal year'));
    await asAdmin((tx) =>
      budgets.createBudget(tx, {
        name: required(form, 'name', 'a name'),
        glAccountId: required(form, 'glAccountId', 'a GL account'),
        businessUnitId: text(form, 'businessUnitId'),
        departmentId: text(form, 'departmentId'),
        currencyCode: required(form, 'currencyCode', 'a currency'),
        fiscalYear: year,
        ownerId: text(form, 'ownerId'),
        notes: text(form, 'notes'),
      }),
    );
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function updateBudgetFromForm(form: FormData) {
  const failure = await guard(async () => {
    const budgetId = required(form, 'budgetId', 'a budget');
    await asAdmin((tx) =>
      budgets.updateBudget(tx, budgetId, {
        name: text(form, 'name') ?? undefined,
        // Explicit null, not absent: the select carries a blank option, and
        // choosing it has to be able to CLEAR the owner. Patch-with-nulls is what
        // makes that expressible.
        ownerId: text(form, 'ownerId'),
        notes: text(form, 'notes'),
      }),
    );
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function deleteBudgetFromForm(form: FormData) {
  const failure = await guard(async () => {
    const budgetId = required(form, 'budgetId', 'a budget');
    await asAdmin((tx) => budgets.deleteBudget(tx, budgetId));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function seedPeriodsFromForm(form: FormData) {
  const failure = await guard(async () => {
    const budgetId = required(form, 'budgetId', 'a budget');
    const startsOn = required(form, 'startsOn', 'a start date');
    const months = Number(text(form, 'months') ?? '12');
    // Typed in major units by a person, stored in minor units. Two decimals is
    // the right assumption for every currency this product ships.
    const amountMinor = parseAmountToMinor(required(form, 'amount', 'an amount per period'), 2);
    await asAdmin((tx) =>
      budgets.seedMonthlyPeriods(tx, budgetId, {
        startsOn,
        months,
        amountMinor: amountMinor.toString(),
      }),
    );
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function addThresholdFromForm(form: FormData) {
  const failure = await guard(async () => {
    const budgetId = required(form, 'budgetId', 'a budget');
    const percent = required(form, 'percent', 'a percentage');
    await asAdmin((tx) => budgets.addThreshold(tx, budgetId, percent));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function removeThresholdFromForm(form: FormData) {
  const failure = await guard(async () => {
    const thresholdId = required(form, 'thresholdId', 'a threshold');
    await asAdmin((tx) => budgets.removeThreshold(tx, thresholdId));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function addRecipientFromForm(form: FormData) {
  const failure = await guard(async () => {
    const thresholdId = required(form, 'thresholdId', 'a threshold');
    const userId = required(form, 'userId', 'somebody to tell');
    await asAdmin((tx) => budgets.addRecipient(tx, thresholdId, userId));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function removeRecipientFromForm(form: FormData) {
  const failure = await guard(async () => {
    const recipientId = required(form, 'recipientId', 'a recipient');
    await asAdmin((tx) => budgets.removeRecipient(tx, recipientId));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}
