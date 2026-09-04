'use server';
/**
 * VX2-9 — the AP surface: approved reports waiting to be paid.
 *
 * ADMIN only, role read from `app_user` inside the tenant transaction, same gate
 * as every other /admin surface.
 *
 * ── Why ADMIN, and what that is standing in for ─────────────────────────────
 *
 * ExpenseOS gates this on a static `expense.report.reimburse` permission held by
 * an AP role. VeloExpense has three roles — EMPLOYEE, MANAGER, ADMIN — so this is
 * ADMIN until per-tenant RBAC lands, which is on the unticketed list.
 *
 * Worth knowing before that ticket is designed (GAP-AUDIT RB-4): in ExpenseOS,
 * holding the reimburse permission ALSO grants blanket read of every report, as
 * one grant. Defensible — you cannot pay what you cannot read — but "let this
 * person release payments" and "let this person read every expense in the
 * company" should probably be two decisions, and an AP role that can pay without
 * browsing is the thing to design deliberately rather than inherit.
 *
 * ── The one rule this file does NOT own ─────────────────────────────────────
 *
 * The refusal to pay your own report lives in `lifecycle.reimburseReport`, not
 * here. Same arrangement as `assertCanDecide`: the page that renders the button
 * and the mutation behind it ask the same function, so they cannot disagree
 * (AP-15). This file's `getPayablePage` marks a row as self-payable purely so the
 * button can be absent rather than present-and-refusing.
 */
import { redirect } from 'next/navigation';
import { errorParam } from '@/lib/errors/domain';
import { revalidatePath } from 'next/cache';
import { listPayableReports, reimburseReport } from '@/lib/expenses/lifecycle';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';

const PAGE = '/admin/reimbursements';

export async function getPayablePage() {
  return asAdminPage(async (tx, actor) => {
    const rows = await listPayableReports(tx);
    // The tenant we are already inside — `organization` has no organization_id
    // column, so it is not RLS-scoped and the session variable is the right way
    // to name the row rather than a second lookup through app_user.
    const org = await tx.query(
      `SELECT allow_sole_approver_self_approval AS break_glass
         FROM organization
        WHERE id = current_setting('app.current_org', true)::uuid`,
    );
    const breakGlass = org.rows[0]?.break_glass === true;
    return {
      rows: rows.map((r) => ({
        ...r,
        // Rendered as a reason rather than a missing button: an AP clerk who
        // cannot pay one row out of twenty needs to know which and why.
        blockedAsOwn: r.submitter_id === actor.id && !breakGlass,
      })),
      actor: { id: actor.id, name: actor.display_name ?? actor.email },
      breakGlass,
    };
  });
}

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export async function reimburseFromForm(form: FormData) {
  try {
    const reportId = text(form, 'reportId');
    if (!reportId) throw new Error('reportId is required');
    await asAdmin((tx, actor) =>
      reimburseReport(tx, reportId, actor.id, {
        reference: text(form, 'reference'),
        note: text(form, 'note'),
      }),
    );
  } catch (err) {
    const message = errorParam(err, 'admin/reimbursements');
    redirect(`${PAGE}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(PAGE);
  revalidatePath('/expenses');
  redirect(PAGE);
}
