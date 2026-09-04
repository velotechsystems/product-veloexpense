'use server';
/**
 * VX2-8 — the delivery queue admin surface.
 *
 * ADMIN only, role read from `app_user` inside the tenant transaction, same gate
 * as every other /admin surface.
 *
 * ── What this screen is for ─────────────────────────────────────────────────
 *
 * It exists because of two measured ExpenseOS incidents, both recorded in
 * GAP-AUDIT NT-11, and both the same failure: a notification that did not arrive
 * produced "no error, no log, no delivery" and was "un-diagnosable across several
 * UAT rounds". The queue's whole job is to make the answer to "did my approver
 * get the email?" a thing an admin can look up rather than a thing they have to
 * ask an engineer.
 *
 * So it shows the reason verbatim, and it distinguishes four states that are easy
 * to collapse into one:
 *
 *   PENDING    waiting for the poller. If this grows, nothing is draining.
 *   FAILED     tried, threw, will try again. The error says why.
 *   DEAD       out of attempts. Somebody has to do something.
 *   CANCELLED  there was never anything to send — no address, no transport.
 *
 * And "SENT" is labelled as ACCEPTED BY THE TRANSPORT, not delivered. A queue
 * that says "sent" gets read as "arrived", and then the next question — "so why
 * didn't they see it?" — has nowhere to go.
 */
import { redirect } from 'next/navigation';
import { errorParam } from '@/lib/errors/domain';
import { revalidatePath } from 'next/cache';
import { verifyEmailTransport } from '@/lib/notifications/email';
import { drainOutbox } from '@/lib/notifications/dispatch';
import {
  listQueue,
  queueSummary,
  retryNow,
  type DeliveryStatus,
} from '@/lib/notifications/outbox';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';

const PAGE = '/admin/notification-delivery';

export async function getQueuePage(status?: string) {
  const filter = (
    ['PENDING', 'FAILED', 'DEAD', 'SENT', 'CANCELLED'] as const
  ).includes(status as DeliveryStatus)
    ? (status as DeliveryStatus)
    : 'UNSETTLED';
  const [page, transport] = await Promise.all([
    asAdminPage(async (tx) => ({
      rows: await listQueue(tx, { status: filter }),
      summary: await queueSummary(tx),
    })),
    // Outside the tenant transaction on purpose: it can make a network call to
    // an SMTP server, and holding a pooled connection open across that is the
    // same mistake `drainOutbox` avoids by sending outside its transactions.
    verifyEmailTransport(),
  ]);
  return { ...page, transport, filter };
}

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export async function retryDeliveryFromForm(form: FormData) {
  try {
    const id = text(form, 'deliveryId');
    if (!id) throw new Error('deliveryId is required');
    await asAdmin(async (tx) => {
      if (!(await retryNow(tx, id))) {
        throw new Error('that delivery is not in a state that can be retried');
      }
    });
  } catch (err) {
    const message = errorParam(err, 'admin/notification-delivery');
    redirect(`${PAGE}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}

/**
 * Drain the queue by hand.
 *
 * Here because the scheduler is the one part of this ticket that lives outside the
 * codebase — a cron entry somebody has to create — and a queue that only moves
 * when an unconfigured external thing calls a route is a queue that looks broken
 * on the day it ships. This button is how an admin proves the transport works
 * before the schedule exists, and how they clear a backlog after an outage.
 *
 * It calls `drainOutbox` DIRECTLY rather than posting to the route, so it needs no
 * secret and cannot be defeated by the route being unreachable from inside the
 * container. The admin gate is the authorization.
 *
 * NOTE it drains ACROSS TENANTS, because the poller has no tenant (NT-19). An
 * admin pressing this is doing platform work, which is defensible while
 * VeloExpense is one deployment per customer set — and is the first thing to
 * revisit if that stops being true. Recorded in HANDOFF §7.
 */
export async function drainNowFromForm() {
  try {
    // The gate still runs, and its only job here is to prove the caller is an
    // admin of SOME tenant before doing cross-tenant work.
    await asAdmin(async () => undefined);
    await drainOutbox({ limit: 50, claimedBy: 'admin-button' });
  } catch (err) {
    const message = errorParam(err, 'admin/notification-delivery');
    redirect(`${PAGE}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(PAGE);
  redirect(PAGE);
}
