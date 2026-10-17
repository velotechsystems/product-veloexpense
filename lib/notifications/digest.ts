/**
 * w5-00 — the email digest's message, ported from ExpenseOS's `notification.emailDigest`
 * handler (`apps/worker/src/handlers/notification-email-digest.ts`, 1e682dd6): `buildDigest`
 * and the per-line call to action it uses (`ctaFor`, from its `channels.ts`).
 *
 * ExpenseOS coalesces pending digest-eligible notifications into ONE email per recipient,
 * "instead of one email per event. A burst that lands between two runs collapses into a
 * single message."
 *
 * VeloExpense (decided 17 Oct 2026): the digest goes THROUGH the delivery outbox rather than
 * around it. ExpenseOS's job queries `notification.emailedAt IS NULL`, sends with
 * `sendEmail` and stamps the rows; here each digest-type notification already has its own
 * delivery row, held until the next quarter hour (`enqueueDelivery`), and the drain gathers
 * one person's due digest rows into this message, sends it once and marks every row it
 * covers SENT (`lib/notifications/dispatch.ts`). So a digest retries, dead-letters and shows
 * on the Email delivery screen like every other notification email. What is ported here is
 * the message itself.
 */
import type { Catalog } from '@expenseos/i18n/load';
import { escapeHtml, renderEmailHtml } from '@/lib/notifications/emailLayout';

/** One thing that happened, as the digest lists it. */
export interface DigestLine {
  /** The rendered sentence ("Grace Hopper commented on Q3 travel: …"). */
  msg: string;
  /** Where it happened, or null when the subject has no page to land on. */
  link: string | null;
  /** The link's label, for THIS line's subject. */
  cta: string;
}

/**
 * The per-subject label for a link, falling back to the generic one.
 *
 * ExpenseOS's `ctaFor` (`channels.ts`): "Per LINE, not per digest: this list mixes subjects,
 * and a column of identical 'View in ExpenseOS' links makes the recipient open each one to
 * find out which is which."
 */
export function ctaFor(cat: Catalog, subjectType: string): string {
  const n = cat.notifications as
    | { cta?: string; ctaSubject?: Record<string, string> }
    | undefined;
  const own = n?.ctaSubject?.[subjectType];
  if (typeof own === 'string' && own.trim()) return own;
  // VeloExpense: VeloExpense's name in the fallback, where ExpenseOS's says its own.
  return typeof n?.cta === 'string' && n.cta.trim() ? n.cta : 'View in VeloExpense';
}

/**
 * Subject + text/html body summarizing the recipient's pending items.
 *
 * ExpenseOS's `buildDigest`. VeloExpense: the lines arrive already rendered — each through
 * the tenant's own template for its event, as the single email for that event would have
 * been (`renderMessage`), where ExpenseOS renders a fixed catalog sentence — and the HTML
 * goes into the tenant's branded shell (`renderEmailHtml`'s second argument).
 */
export function buildDigest(
  cat: Catalog,
  lines: readonly DigestLine[],
  shell: { organizationName: string; brandColor: string | null },
): { subject: string; text: string; html: string } {
  const digest =
    (cat.notifications as { digest?: Record<string, string> } | undefined)?.digest ?? {};
  const count = lines.length;
  // VeloExpense: VeloExpense's name in the fallbacks, where ExpenseOS's say its own.
  const subject =
    count === 1
      ? (digest.subjectOne ?? '1 new update in VeloExpense')
      : (digest.subjectMany ?? '{count} new updates in VeloExpense').replace(
          '{count}',
          String(count),
        );
  const intro = digest.intro ?? "Here's a summary of recent activity:";

  const text = `${intro}\n\n${lines
    .map((l) => (l.link ? `• ${l.msg}\n  ${l.link}` : `• ${l.msg}`))
    .join('\n\n')}`;
  /**
   * A LIST, not paragraphs — which is why this passes `bodyHtml` rather than letting the
   * layout build it. A digest is n unrelated things, and running them together as prose is
   * how a reader loses count of how many there are.
   *
   * The per-line link stays per line: this list mixes subjects, and a column of identical
   * "View in …" buttons makes the recipient open each one to find out which is which. So
   * the shell carries no action of its own here.
   */
  const bodyHtml =
    `<p style="margin:0 0 12px;color:#111827;font-size:15px;line-height:1.55;">${escapeHtml(intro)}</p>` +
    `<ul style="margin:0;padding-left:20px;color:#111827;font-size:15px;line-height:1.6;">${lines
      .map(
        (l) =>
          `<li style="margin-bottom:6px;">${escapeHtml(l.msg)}${
            l.link
              ? ` — <a href="${escapeHtml(l.link)}" style="color:#1d4ed8;">${escapeHtml(l.cta)}</a>`
              : ''
          }</li>`,
      )
      .join('')}</ul>`;

  const html = renderEmailHtml(
    {
      brand: process.env.EMAIL_BRAND?.trim() || 'VeloExpense',
      heading: subject,
      body: text,
      bodyHtml,
      footer:
        (cat.notifications as { emailFooter?: string } | undefined)?.emailFooter ??
        'You are receiving this because of your notification settings.',
    },
    shell,
  );

  return { subject, text, html };
}
