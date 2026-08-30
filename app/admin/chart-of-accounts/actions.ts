'use server';
/**
 * VX3-1 — the chart-of-accounts admin surface.
 *
 * ADMIN only, role read from `app_user` inside the tenant transaction, same gate
 * as every other /admin surface. Standing in for per-tenant RBAC, which is on the
 * unticketed list — see the note in `app/admin/reimbursements/actions.ts`.
 *
 * ── Every export here is an `export async function`, and that is a rule ──────
 *
 * A `'use server'` module registers every export as a server action, and an
 * export it cannot wrap makes it register NONE of them — a clean build with a
 * dead form, failing in the browser with "Failed to find Server Action". That is
 * not hypothetical: it shipped on `/approve` in VX2-8 and cost a wrong diagnosis
 * before anyone read the manifest. `npm run check:actions` fails the build on it
 * now. So the page reads `listTemplates` and friends through `getChartPage()`
 * below rather than importing anything else from this file.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import { getEmployeeByEmail, type EmployeeRow } from '@/lib/employees/service';
import {
  AccountError,
  createAccount,
  deactivateAccount,
  importFromCsv,
  instantiateTemplate,
  listAccounts,
  listCategoryMappings,
  listPostableAccounts,
  listTemplates,
  reactivateAccount,
  removeAccount,
  renameAccount,
  setCategoryAccount,
} from '@/lib/accounts/service';

const PAGE = '/admin/chart-of-accounts';

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

export async function getChartPage() {
  return asAdmin(async (tx) => {
    const accounts = await listAccounts(tx, { includeInactive: true });
    return {
      accounts,
      postable: await listPostableAccounts(tx),
      mappings: await listCategoryMappings(tx),
      // Only offered while the chart is empty — `instantiateTemplate` refuses a
      // populated tenant, and a button that always refuses is worse than no button.
      templates: accounts.length === 0 ? await listTemplates(tx) : [],
    };
  });
}

/** Turn an AccountError into a query string the page renders; rethrow anything else. */
function fail(err: unknown): never {
  if (err instanceof AccountError) {
    const detail = err.errors.length
      ? ` (${err.errors
          .slice(0, 5)
          .map((e) => `line ${e.lineNumber}: ${e.message}`)
          .join('; ')}${err.errors.length > 5 ? `; and ${err.errors.length - 5} more` : ''})`
      : '';
    redirect(`${PAGE}?error=${encodeURIComponent(err.message + detail)}`);
  }
  throw err;
}

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function required(form: FormData, key: string): string {
  const value = text(form, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export async function instantiateTemplateFromForm(form: FormData) {
  try {
    const key = required(form, 'templateKey');
    const { created } = await asAdmin((tx) => instantiateTemplate(tx, key));
    revalidatePath(PAGE);
    redirect(`${PAGE}?created=${created}`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
}

export async function importCsvFromForm(form: FormData) {
  try {
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      throw new AccountError('choose a CSV file to import', 'INVALID_CSV');
    }
    // Read on the server; nothing about the file reaches the client. 2 MB is far
    // more than a chart of accounts needs and small enough not to be a way to
    // spend the server's memory.
    if (file.size > 2_000_000) {
      throw new AccountError('that file is larger than 2 MB — is it a chart of accounts?', 'INVALID_CSV');
    }
    const content = await file.text();
    const { created } = await asAdmin((tx) => importFromCsv(tx, content));
    revalidatePath(PAGE);
    redirect(`${PAGE}?created=${created}`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
}

export async function createAccountFromForm(form: FormData) {
  try {
    await asAdmin((tx) =>
      createAccount(tx, {
        number: required(form, 'number'),
        name: required(form, 'name'),
        type: required(form, 'type'),
        subType: text(form, 'subType'),
        parentNumber: text(form, 'parentNumber'),
      }),
    );
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function renameAccountFromForm(form: FormData) {
  try {
    await asAdmin((tx) => renameAccount(tx, required(form, 'id'), required(form, 'name')));
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function setAccountActiveFromForm(form: FormData) {
  try {
    const id = required(form, 'id');
    const active = form.get('active') === 'true';
    await asAdmin((tx) => (active ? reactivateAccount(tx, id) : deactivateAccount(tx, id)));
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function removeAccountFromForm(form: FormData) {
  try {
    await asAdmin((tx) => removeAccount(tx, required(form, 'id')));
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function setCategoryAccountFromForm(form: FormData) {
  try {
    // An empty select clears the mapping — `setCategoryAccount` takes null for it.
    await asAdmin((tx) =>
      setCategoryAccount(tx, required(form, 'categoryId'), text(form, 'accountId')),
    );
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(err);
  }
  revalidatePath(PAGE);
  revalidatePath('/expenses');
  redirect(PAGE);
}

/**
 * `redirect()` works by throwing, so a try/catch around a redirecting call has to
 * let that one through or every successful action is reported as a failure. Same
 * shape as the other admin actions here; worth naming rather than repeating the
 * digest string inline.
 */
function isRedirect(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}
