'use server';
/**
 * VX2-8 — the form wrapper over `lib/notifications/approve.ts`.
 *
 * Deliberately thin. The rules — the token authenticates but does not authorize,
 * nothing happens on a GET, the tenant comes from the token and nothing else —
 * are all in the lib module, where `test/delivery.db.test.ts` exercises them
 * directly. This file exists so the page can post a plain
 * `<form action={serverAction}>` like every other surface here.
 */
import { redirect } from 'next/navigation';
import { decideFromToken, inspectToken } from '@/lib/notifications/approve';

export { inspectToken };

/**
 * Redirects back to `/approve` with the outcome in the query string, so the
 * question and the answer are one page and the browser's back button cannot
 * re-submit a used token.
 */
export async function decideFromTokenForm(form: FormData) {
  const raw = typeof form.get('token') === 'string' ? (form.get('token') as string) : '';
  const ack = form.get('receiptViewAcknowledged') !== null;
  const result = await decideFromToken(raw, { receiptViewAcknowledged: ack });
  if (result.kind === 'DONE') redirect(`/approve?done=${result.action}`);
  if (result.kind === 'REFUSED') redirect(`/approve?error=${encodeURIComponent(result.reason)}`);
  // INVALID here means the token was used between rendering the question and
  // answering it — a double-click, or the other half of the pair. Falling through
  // to the bare page renders the "no longer works" card, which is the truth.
  redirect('/approve');
}
