'use server';
/**
 * VX3-4 — the ledger posting queue: what went, what failed, what needs a person.
 *
 * ADMIN only, same gate as every other /admin surface. Every export is an
 * `export async function` — see `npm run check:actions`.
 */
import { redirect } from 'next/navigation';
import { errorCodeParam, errorParam } from '@/lib/errors/domain';
import { revalidatePath } from 'next/cache';
import type { QueryRunner } from '@/lib/db/client';
import { type EmployeeRow } from '@/lib/employees/service';
import {
  cancelPost,
  dryRun,
  getPostingTrigger,
  isPostingTrigger,
  listQueue,
  queueSummary,
  releaseHold,
  retryNow,
  setPostingTrigger,
} from '@/lib/integrations/post-outbox';
import { append as auditAppend } from '@/lib/audit/service';
import { postOne } from '@/lib/integrations/dispatch';
import { capabilityAvailability } from '@/lib/integrations/service';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';

const PAGE = '/admin/ledger-queue';

export async function getQueuePage() {
  return asAdminPage(async (tx) => ({
    rows: await listQueue(tx),
    summary: await queueSummary(tx),
    // UD-8. The setting is surfaced on THIS screen rather than on
    // /admin/integrations, which is about which ledger is connected and with what
    // credentials. This is the one screen where the setting's effect is visible —
    // a queue full of HELD rows is either the product working as configured or a
    // backlog nobody is clearing, and the difference is exactly this value. The
    // same argument put `capabilityAvailability` here in AC-22.
    postingTrigger: await getPostingTrigger(tx),
    // Whether anything can post at all. A queue full of PENDING rows with no
    // connected ledger is a configuration problem, not a backlog, and the
    // difference should be on the screen rather than inferred.
    //
    // AC-22 added the second half: TWO connected ledgers is also a configuration
    // problem, and the one an operator is least likely to guess at, so it arrives
    // as a sentence rather than as a thrown error on a page.
    ...(await capabilityAvailability(tx, 'POST_EXPENSE_REPORT')),
  }));
}

/**
 * The audit row for an operator's decision about a queued post (VX3-6).
 *
 * VX3-4 shipped these three buttons with NO audit row at all — an omission against
 * VX3-6's own acceptance criterion, "a manual push is audited and attributed".
 * Every one of them overrides something the system decided on its own, which is
 * exactly the class of action an audit trail exists for.
 *
 * `entityType` is the REPORT rather than the queue row: `audit_entry` is read by
 * report, an auditor asking "what happened to EXP-000123" should see the ledger
 * hand-off in the same chain as its approval, and a queue row is an implementation
 * detail that may be retried away.
 */
async function auditPostAction(
  tx: QueryRunner,
  actor: EmployeeRow,
  action: string,
  postId: string,
  details: Record<string, unknown>,
): Promise<void> {
  const row = await tx.query('SELECT report_id FROM integration_post WHERE id = $1', [postId]);
  if (row.rows.length === 0) throw new Error('no such queued post');
  await auditAppend(
    tx,
    { id: actor.id, name: actor.display_name ?? actor.email, role: actor.role },
    {
      action,
      entityType: 'expense_report',
      entityId: row.rows[0].report_id as string,
      details: { postId, ...details },
    },
  );
}

function required(form: FormData, key: string): string {
  const value = form.get(key);
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`);
  return value.trim();
}

function isRedirect(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

async function guarded(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (isRedirect(err)) throw err;
    const message = errorParam(err, 'admin/ledger-queue');
    redirect(`${PAGE}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function retryFromForm(form: FormData) {
  await guarded(async () => {
    const id = required(form, 'id');
    await asAdmin(async (tx, actor) => {
      // Read the state BEFORE the retry: what an auditor needs is what this
      // operator overrode, and `retryNow` resets exactly that.
      const before = await tx.query(
        'SELECT status, attempts, external_id, last_error FROM integration_post WHERE id = $1',
        [id],
      );
      if (before.rows.length === 0) throw new Error('no such queued post');
      const prior = before.rows[0];
      await retryNow(tx, id);
      // Same transaction as the change — `auditAppend` requires it, and a retry
      // that happened without its audit row is worse than no audit row.
      await auditPostAction(tx, actor, 'LEDGER_POST_RETRIED', id, {
        fromStatus: prior.status,
        priorAttempts: prior.attempts,
        // The one that matters: retrying a NEEDS_REVIEW row means an operator has
        // decided the ledger does NOT already hold this bill. If they were wrong,
        // this row is the record of who decided.
        priorExternalId: prior.external_id,
        priorError: prior.last_error,
        overrodeNeedsReview: prior.status === 'NEEDS_REVIEW',
      });
    });
  });
}

export async function cancelFromForm(form: FormData) {
  await guarded(async () => {
    const id = required(form, 'id');
    const reason = (form.get('reason') as string | null)?.trim();
    await asAdmin(async (tx, actor) => {
      await cancelPost(tx, id, reason || 'withheld by an administrator');
      await auditPostAction(tx, actor, 'LEDGER_POST_WITHHELD', id, {
        reason: reason ?? null,
      });
    });
  });
}

/**
 * What would be sent, and what would stop it. Writes nothing.
 *
 * Not audited, deliberately: it changes nothing and reads only what the operator
 * can already see on the report. An audit trail full of "somebody looked" entries
 * is how the entries that matter get lost.
 */
export async function dryRunFromForm(form: FormData) {
  const id = required(form, 'id');
  const result = await asAdmin((tx) => dryRun(tx, id));
  if (!result) redirect(`${PAGE}?error=${errorCodeParam('QUEUED_POST_NOT_FOUND')}`);
  redirect(`${PAGE}?preview=${encodeURIComponent(JSON.stringify(result))}`);
}

/**
 * Post one row now, rather than waiting for the poller.
 *
 * Goes through `postOne`, the same function the drain route uses, so the path an
 * operator exercises is the path that ships — VX1-9's lesson about MemoryStorage
 * was that a test-only (or screen-only) path proves nothing about the real one.
 */
export async function sendNowFromForm(form: FormData) {
  await guarded(async () => {
    const id = required(form, 'id');
    const orgId = await asAdmin(async (tx) => {
      const r = await tx.query(
        `SELECT organization_id FROM integration_post WHERE id = $1`,
        [id],
      );
      if (r.rows.length === 0) throw new Error('no such queued post');
      return r.rows[0].organization_id as string;
    });
    const outcome = await postOne(orgId, id);
    // Audited AFTER, with the outcome — the operator's action is "sent this now",
    // and what happened is the part an auditor wants. It cannot share the
    // transaction with the send, because the send deliberately holds none open
    // while it talks to the ledger.
    await asAdmin((tx, actor) =>
      auditPostAction(tx, actor, 'LEDGER_POST_SENT_MANUALLY', id, { outcome }),
    );
  });
}

/**
 * UD-8 — an AP_QUEUE organization's "yes, send this one".
 *
 * ONE button for one intent. The alternative was release-only, leaving the row
 * PENDING for the poller (or for the "Send now" button that then appears), and it
 * was rejected as two clicks for a single decision — AP asked to be the one who
 * decides, not to be the one who presses twice.
 *
 * TWO AUDIT ROWS, deliberately, because they are two different facts. The release
 * is the DECISION and it is durable: if `postOne` then fails, this function
 * redirects with an error but the row stays PENDING and the poller carries on,
 * which is right — a transport failure is not a reason to un-decide. The second
 * row is the OUTCOME, which is what an auditor actually asks about, per the note
 * on `sendNowFromForm`.
 *
 * `postOne` rather than anything bespoke: it is the function the drain route uses,
 * and VX1-9's MemoryStorage lesson is that a screen-only path proves nothing about
 * the real one.
 */
export async function releaseFromForm(form: FormData) {
  await guarded(async () => {
    const id = required(form, 'id');
    const orgId = await asAdmin(async (tx, actor) => {
      const r = await tx.query('SELECT organization_id FROM integration_post WHERE id = $1', [id]);
      if (r.rows.length === 0) throw new Error('no such queued post');
      // Refuses unless the row is still HELD — somebody else releasing it a moment
      // earlier is a refusal here, not a silent second send.
      await releaseHold(tx, id);
      await auditPostAction(tx, actor, 'LEDGER_POST_RELEASED', id, {});
      return r.rows[0].organization_id as string;
    });
    const outcome = await postOne(orgId, id);
    await asAdmin((tx, actor) =>
      auditPostAction(tx, actor, 'LEDGER_POST_SENT_MANUALLY', id, { outcome, afterRelease: true }),
    );
  });
}

/**
 * UD-8 — change who sends approved reports.
 *
 * Audited against the ORGANIZATION rather than a report: it is a standing policy
 * decision, and an auditor asking "why did these forty reports sit for a week"
 * needs to find the day somebody changed this, not forty identical rows.
 *
 * Switching to AUTOMATIC deliberately does NOT release what is already held.
 * Those rows were approved under a rule that said a person decides, and quietly
 * posting a week of them because a setting changed is the "wrong posting in a
 * general ledger" the setting exists to prevent. The screen says so.
 */
export async function savePostingTriggerFromForm(form: FormData) {
  await guarded(async () => {
    const value = required(form, 'postingTrigger');
    if (!isPostingTrigger(value)) throw new Error('unknown posting trigger');
    await asAdmin(async (tx, actor) => {
      // The read-before, the write and the audit all live in the service — see
      // the note on `setPostingTrigger`. A no-op resubmit audits nothing.
      await setPostingTrigger(
        tx,
        { id: actor.id, name: actor.display_name ?? actor.email, role: actor.role },
        value,
      );
    });
  });
}
