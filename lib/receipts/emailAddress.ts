/**
 * f26 — the address a person emails receipts to.
 *
 * Built for VeloExpense, not ported: ExpenseOS never shows anybody this address, so its people
 * learn it from a colleague or not at all.
 *
 * ## What the address is
 *
 * `<mailbox>@<tenant slug>.<INBOUND_EMAIL_DOMAIN>` (d47) — the address the inbound route
 * (`app/api/email/inbound/route.ts`) reads the tenant from. `<mailbox>` is the first local
 * part in `INBOUND_RECEIPTS_MAILBOXES`, defaulting to `receipts` exactly as the route does,
 * so the address shown here is one the route accepts.
 *
 * **It is the tenant's address, not the person's, and it holds no secret.** Everybody in a
 * company sends to the same one. What decides whose claim an email becomes is the SENDER:
 * the route requires the SES verdicts to pass and the From to align with the domain that
 * authenticated, and the worker then looks that From up among this tenant's active people
 * (`worker/src/handlers/ingest-receipt-email.ts`). So the screen shows the address AND the
 * sign-in email it must be sent from — the second half is what makes the first one work.
 *
 * There is consequently nothing to regenerate. The only tokened receipts address,
 * `receipts+<token>@`, is the per-report Reply-To on an acknowledgement (w5-01b); it is
 * issued per report by the worker and is not something to show on a settings screen.
 *
 * ## When there is none
 *
 * `INBOUND_EMAIL_DOMAIN` unset means this environment receives no mail at all (the CDK
 * config's `inboundEmail` block is absent — prod today), and the route ignores whatever
 * reaches it. Showing an address there would hand people one that silently drops their
 * receipts, so the answer is `null` and the screens say receipts by email is not set up.
 */

export const DEFAULT_RECEIPTS_MAILBOX = 'receipts';

/** The env this reads, injectable for tests. */
export type InboundEnv = Readonly<Record<string, string | undefined>> & {
  INBOUND_EMAIL_DOMAIN?: string;
  INBOUND_RECEIPTS_MAILBOXES?: string;
};

/**
 * The tenant's receipts address, or `null` when this environment does not receive mail or
 * the slug is not a usable DNS label.
 */
export function receiptsEmailAddress(
  slug: string | null | undefined,
  env: InboundEnv = process.env,
): string | null {
  const domain = env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!domain) return null;
  const label = slug?.trim().toLowerCase() ?? '';
  // The route reads the tenant from ONE label under the domain. A slug that is not a DNS label
  // cannot be that label, so an address built from it could never arrive.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  const mailbox =
    (env.INBOUND_RECEIPTS_MAILBOXES ?? '')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .find(Boolean) ?? DEFAULT_RECEIPTS_MAILBOX;
  return `${mailbox}@${label}.${domain}`;
}
