'use server';
/**
 * VX2-4a — approval-ladder admin actions.
 *
 * Same gating as the expense-policy surface and the employee directory: ADMIN
 * only, with the acting user's role read from `app_user` INSIDE the tenant
 * transaction, never from the session token. RLS scopes the rows; the role check
 * is what stops an ordinary employee rewriting who approves their own spending.
 *
 * ── The one design decision worth reading ───────────────────────────────────
 *
 * An approver is chosen from ONE select, whose value encodes the kind and its
 * companion in a single token: `MANAGER:1`, `ROLE:ADMIN`, `USER:<uuid>`.
 *
 * The alternative — a kind select plus a field for each possible companion —
 * needs client JS to hide the irrelevant three, and lets an admin submit
 * "specific person" with no person, which is exactly the half-configured state
 * `approval_policy_approver_complete` refuses and that ExpenseOS needed a zod
 * schema to police (GAP-AUDIT AP-11). Encoding the pair in the option value
 * makes that state unrepresentable in the form, not merely rejected by it.
 *
 * EMAIL approvers are deliberately ABSENT from the choices. The schema stores
 * them, but the resolver refuses to route onto one until VX2-8 ships the
 * approve-link token — so offering it here would let an admin save a ladder that
 * breaks every submit in the tenant with `EMAIL_APPROVER_UNSUPPORTED`. Add it to
 * `approverChoices` on the day VX2-8 lands, and not before.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import type { QueryRunner } from '@/lib/db/client';
import { getEmployeeByEmail, type EmployeeRow } from '@/lib/employees/service';
import * as approvals from '@/lib/approvals/service';
import { approverChoices, decodeApproverList } from '@/lib/approvals/approver-token';
import { parseAmountToMinor } from '@/lib/money';

const PAGE = '/admin/approval-ladder';

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

export async function getLadderPage() {
  return asAdmin(async (tx) => {
    const rungs = await approvals.listPolicies(tx);
    const people = await tx.query(
      `SELECT id, email, display_name FROM app_user
        WHERE deleted_at IS NULL AND employee_status = 'ACTIVE'
        ORDER BY COALESCE(display_name, email)`,
    );
    return {
      rungs,
      choices: approverChoices(people.rows),
    };
  });
}

/* ── form entry points ─────────────────────────────────────────────────────── */

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Admins type "5,000.00"; the ladder bands on minor units. Two decimals, the
 * same assumption `/admin/expense-policies` makes and for the same reason: a
 * threshold is written in the tenant's reporting currency and every currency
 * VeloExpense ships has minor_unit 2.
 */
function thresholdMinor(form: FormData): string {
  const raw = text(form, 'threshold');
  if (raw === null) return '0';
  return String(parseAmountToMinor(raw.replace(/,/g, ''), 2));
}

/**
 * The approvers of one rung, in the order the selects appear.
 *
 * `getAll` because a rung may have several, and blank rows are skipped — which
 * is what makes "one empty select at the end" work as an add-another affordance
 * with no client JS.
 */
function approversFrom(form: FormData) {
  return decodeApproverList(
    form.getAll('approver').filter((v): v is string => typeof v === 'string'),
  );
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

export async function createRungFromForm(form: FormData) {
  const failure = await guard(async () => {
    const name = text(form, 'name');
    if (!name) throw new Error('give the rung a name — approvers see it on the report');
    const sequence = Number(text(form, 'sequence') ?? '0');
    await asAdmin((tx) =>
      approvals.createPolicy(tx, {
        name,
        sequence,
        thresholdMinor: thresholdMinor(form),
        requireReceiptViewAck: form.get('requireReceiptViewAck') !== null,
        enabled: form.get('enabled') !== null,
        approvers: approversFrom(form),
      }),
    );
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

/**
 * Update replaces the rung's approver set WHOLESALE — that is `updatePolicy`'s
 * documented behaviour when the patch names `approvers`, and it is why every
 * approver of the rung is a select inside this one form. Submitting the form
 * submits the whole set, so removing an approver is "set that select to blank
 * and save", with no separate delete action to get out of step with the rest.
 */
export async function updateRungFromForm(form: FormData) {
  const failure = await guard(async () => {
    const policyId = text(form, 'policyId');
    if (!policyId) throw new Error('policyId is required');
    const name = text(form, 'name');
    if (!name) throw new Error('give the rung a name — approvers see it on the report');
    await asAdmin((tx) =>
      approvals.updatePolicy(tx, policyId, {
        name,
        sequence: Number(text(form, 'sequence') ?? '0'),
        thresholdMinor: thresholdMinor(form),
        requireReceiptViewAck: form.get('requireReceiptViewAck') !== null,
        enabled: form.get('enabled') !== null,
        approvers: approversFrom(form),
      }),
    );
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function deleteRungFromForm(form: FormData) {
  const failure = await guard(async () => {
    const policyId = text(form, 'policyId');
    if (!policyId) throw new Error('policyId is required');
    await asAdmin((tx) => approvals.deletePolicy(tx, policyId));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}

export async function restoreStarterLadderFromForm() {
  const failure = await guard(async () => {
    await asAdmin((tx) => approvals.ensureDefaultLadder(tx));
  });
  if (failure) redirect(failure);
  revalidatePath(PAGE);
}
