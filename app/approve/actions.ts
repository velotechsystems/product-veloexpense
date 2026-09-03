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
import { encodeUserMessage } from '@/lib/errors/domain';
import { decideFromToken } from '@/lib/notifications/approve';

/*
 * `inspectToken` IS NOT RE-EXPORTED FROM HERE, and that is load-bearing.
 *
 * It used to be — `export { inspectToken };`, so the page could import both
 * halves from one place — and the cost was that `app/approve/page` ended up with
 * NO server actions registered at all. Not the re-export missing: the whole
 * module's registration silently absent from `.next/server/server-reference-
 * manifest.json`, while every other page's actions were there. The form then
 * posted an action id the server had never heard of:
 *
 *     Failed to find Server Action "4066e8…". This request might be from an
 *     older or newer deployment.
 *
 * A misleading message — nothing was stale, the build had simply never
 * registered the action — which is why this cost a wrong diagnosis before the
 * manifest was actually read. Next treats every export of a `'use server'`
 * module as an action to wrap, and a plain re-export of a binding declared in
 * another module is not something it can wrap; it does not fail the build.
 *
 * So: a `'use server'` file exports its OWN async functions and nothing else.
 * `inspectToken` is an ordinary server-side read and the page imports it
 * straight from `@/lib/notifications/approve`, which is where it lives.
 */

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
  // `result.reason` is a MESSAGE CODE since part 2c-2, not a sentence — the page
  // renders it through `ErrorBanner` like every other refusal. `errorCodeParam`
  // rather than `errorParam` because there is no exception here to inspect.
  if (result.kind === 'REFUSED')
    redirect(`/approve?error=${encodeURIComponent(encodeUserMessage(result.reason))}`);
  // INVALID here means the token was used between rendering the question and
  // answering it — a double-click, or the other half of the pair. Falling through
  // to the bare page renders the "no longer works" card, which is the truth.
  redirect('/approve');
}
