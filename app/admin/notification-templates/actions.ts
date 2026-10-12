'use server';
/**
 * VX2-7 — per-tenant notification copy.
 *
 * ADMIN only, with the acting user's role read from `app_user` INSIDE the tenant
 * transaction, never from the session token — the same gate as
 * /admin/expense-policies.
 *
 * ── Why this surface exists at all ──────────────────────────────────────────
 *
 * Because the alternative to letting a tenant reword a sentence is a support
 * ticket that ends in a deploy. The whole of GAP-AUDIT NT-4 is ExpenseOS
 * discovering that template STORAGE is easy to get wrong and template IDENTITY
 * is easy to get wrong twice, and the reason they bothered is that admins want
 * different words.
 *
 * Two things this deliberately does NOT do (NT-7, decided 2026-08-29):
 *
 *   * no draft / publish / version history. A save is live. What is lost is the
 *     ability to reword something and preview it before anybody receives it, and
 *     the ability to see who changed the wording last month. `updated_by_id` and
 *     `updated_at` record the LAST change only.
 *   * no expression language. `{placeholder}` substitution and nothing else —
 *     ExpenseOS's reason, ported verbatim in `catalog.ts`: "A template editor
 *     that evaluates expressions against the notification context is an
 *     injection surface and a support burden, and the need it serves is
 *     rewording sentences."
 */
import { redirect } from 'next/navigation';
import { errorParam } from '@/lib/errors/domain';
import { revalidatePath } from 'next/cache';
import { append as auditAppend } from '@/lib/audit/service';
import { REPORT_PLACEHOLDERS, RESERVED_PLACEHOLDERS } from '@/lib/notifications/catalog';
import { listTemplates, setTemplate } from '@/lib/notifications/service';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';

const PAGE = '/admin/notification-templates';

/** The placeholders a template may use, for the screen to list. */
export async function getTemplatesPage() {
  return asAdminPage(async (tx) => ({
    templates: await listTemplates(tx, 'IN_APP'),
    placeholders: [...RESERVED_PLACEHOLDERS, ...REPORT_PLACEHOLDERS],
  }));
}

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Save one message, or reset it.
 *
 * An EMPTY body is a RESET, not a stored blank. `setTemplate` deletes the row,
 * so "reset to the shipped wording" and "the shipped wording" are one state
 * rather than two that render identically — and a stored empty body would be a
 * render MISS while occupying a row with a timestamp claiming somebody authored
 * it.
 */
export async function setTemplateFromForm(form: FormData) {
  try {
    const templateKey = text(form, 'templateKey');
    if (!templateKey) throw new Error('templateKey is required');
    const body = text(form, 'body');
    await asAdmin(async (tx, actor) => {
      await setTemplate(tx, actor.id, { templateKey, channel: 'IN_APP', body });
      // Copy a tenant's people read as a statement of what happened to their
      // money is worth a trail entry. Not because it is a security control, but
      // because "the notification said something different last week" is
      // otherwise unanswerable.
      await auditAppend(
        tx,
        { id: actor.id, name: actor.display_name ?? actor.email, role: actor.role },
        {
          action: body === null ? 'NOTIFICATION_TEMPLATE_RESET' : 'NOTIFICATION_TEMPLATE_SAVED',
          // NO entityType/entityId, and the reason is structural: `0010` types
          // `audit_entry.entity_id` as `uuid`, and the identity of a template is
          // its KEY (NT-4) — a text value. The row id would be the wrong answer
          // anyway, because a reset deletes the row and leaves nothing to point
          // at, while the key survives. `audit_entry_entity_complete` makes it
          // both columns or neither, so the reference goes in `details`.
          details: { entity: 'notification_template', channel: 'IN_APP', templateKey, body },
        },
      );
    });
  } catch (err) {
    const message = errorParam(err, 'admin/notification-templates');
    redirect(`${PAGE}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(PAGE);
  revalidatePath('/notifications');
  redirect(PAGE);
}
