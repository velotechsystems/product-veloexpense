import { type EmailShellInput, emailShell } from '@/lib/notifications/email-shell';
import { escapeHtml } from '@/lib/notifications/html';

/**
 * ExpenseOS's `@expenseos/notifications` `emailLayout.ts` (1e682dd6), ported with #567's
 * receipts summary, its first caller here.
 *
 * VeloExpense: the FRAME is VeloExpense's own branded shell (`email-shell.ts`, GAP-AUDIT
 * BR-6) — the tenant's name as the wordmark, its colour on the button, the "sent by … through
 * VeloExpense" line — so a mail laid out here looks like every other VeloExpense mail. What
 * this module carries is what the shell has no place for: the heading, the body paragraphs,
 * the label/value detail table, the closing lines and the plain-text part. ExpenseOS's own
 * frame (header bar, outlined secondary buttons, footer row) is not ported; see
 * `renderEmailHtml`.
 *
 * The shell every notification email is rendered into.
 *
 * Notification mail used to be `<p>{body}</p>` followed by two bare `<a>`s. In an inbox
 * beside real correspondence that reads as a system that has not been finished: no sender
 * identity, no visual separation between the sentence and the thing to click, and an
 * "Approve" link indistinguishable from the word approve. An approval request is the most
 * consequential message this product sends and it looked the least like one.
 *
 * ── Why tables and inline styles ────────────────────────────────────────────
 *
 * Not a stylistic choice. Outlook renders HTML through Word, which supports neither flex
 * nor grid and drops most of a `<style>` block; Gmail strips `<head>` entirely. A table
 * with inline styles is the one layout every client has agreed on for twenty years, and
 * the alternative is a message that is correct in the developer's client and broken in the
 * recipient's.
 *
 * A button is a table cell with a background and a padded `<a>` inside it, for the same
 * reason: a styled `<a>` alone loses its background in Outlook and becomes blue text.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 *
 * No images, no web fonts, no tracking pixel, no external stylesheet. Every one of those
 * is a request the recipient's client blocks by default, so a layout that depends on one
 * is a layout that is broken for most readers on first open — and a remote asset in a mail
 * about somebody's expenses is a disclosure of when they read it.
 *
 * Colours are literals rather than design tokens: the tokens are CSS variables, and a CSS
 * variable in an email resolves to nothing.
 */

/** One thing the reader can do, rendered as a button. */
export interface EmailAction {
  label: string;
  url: string;
  /** The primary action gets the filled treatment; everything else is outlined. At most
   *  one action should be primary — two equally-weighted buttons is a coin toss. A
   *  notification carries a single action, the deep link, and it is the primary. */
  primary?: boolean;
}

export interface EmailLayoutInput {
  /** The product's name, in the header bar. */
  brand: string;
  /** The one-line statement of what happened. Becomes the visual heading. */
  heading: string;
  /** The message body, as plain text. Escaped and split into paragraphs on blank lines. */
  body: string;
  /**
   * Pre-built HTML for the body, when a caller has structure a paragraph cannot carry —
   * the digest's list of what happened, for instance.
   *
   * The CALLER escapes it, which is why it is separate from `body` rather than a mode
   * flag: an escape hatch that looks like the safe path is one somebody reaches for by
   * accident. `body` is still required, because it is the plain-text part every client
   * that cannot render HTML actually shows.
   */
  bodyHtml?: string;
  actions?: EmailAction[];
  /**
   * The subject's facts, as label/value rows — what is being approved, not just that
   * something is.
   *
   * Sits between the body and the buttons, which is the order the decision is made in:
   * what happened, what it says, what you can do about it. Escaped here, like `body` and
   * unlike `bodyHtml` — these come from a database record, and a vendor named
   * `<script>` is a row in a table somebody imported, not an attack anybody had to
   * mount.
   */
  details?: Array<{ label: string; value: string }>;
  /**
   * Lines after the buttons — the reply invitation and the sign-off.
   *
   * Separate from `footer`, which is the small print BELOW the rule and is about why the
   * message arrived. These are still the message: a human closing, in the body, above the
   * line. Rendered as one paragraph per entry.
   */
  closing?: string[];
  /** Small print under the rule — why this arrived, and where to change that. */
  footer?: string;
}

const INK = '#111827';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

// VeloExpense: one `escapeHtml` for every mail (`html.ts`), where ExpenseOS defines its own here.
export { escapeHtml };

/**
 * Only `http(s)` reaches an `href`.
 *
 * A template's link comes from configuration rather than from a stranger, but `javascript:`
 * and `data:` in an anchor are the two schemes that turn a message into a payload, and the
 * cost of refusing them is nothing. A refused URL renders the button as plain text: the
 * label still says what was on offer, which is better than a button that does nothing.
 */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

/** Blank-line-separated paragraphs, escaped. A body is text — a template that wants
 *  markup would be a template that can inject it. */
function paragraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 12px;color:${INK};font-size:15px;line-height:1.55;">${escapeHtml(
          p,
        ).replace(/\n/g, '<br />')}</p>`,
    )
    .join('');
}

/**
 * The subject's facts as a two-column table.
 *
 * A table rather than "Label: value" paragraphs because the values are scanned, not read:
 * an approver is looking for the limit, and a left column of aligned labels is what lets
 * them find it without reading the other nine rows. `white-space:nowrap` on the label keeps
 * "Business unit" from wrapping into two lines and pulling its value out of alignment;
 * `width:1%` collapses that column to its content so the value column takes the rest.
 *
 * No zebra striping and no borders between rows — Outlook renders partial borders
 * inconsistently, and the alignment already does the work.
 */
function detailTable(details: NonNullable<EmailLayoutInput['details']>): string {
  const rows = details
    .filter((d) => d.label.trim() && d.value.trim())
    .map(
      (d) =>
        `<tr>` +
        `<td style="padding:4px 12px 4px 0;color:${MUTED};font-size:13px;line-height:1.5;` +
        `white-space:nowrap;vertical-align:top;">${escapeHtml(d.label)}</td>` +
        `<td style="padding:4px 0;color:${INK};font-size:13px;line-height:1.5;` +
        `vertical-align:top;">${escapeHtml(d.value)}</td>` +
        '</tr>',
    )
    .join('');
  if (!rows) return '';
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="margin:0 0 16px;border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER};` +
    `padding:8px 0;"><tbody>${rows}</tbody></table>`
  );
}

/**
 * The full HTML document for one email.
 *
 * VeloExpense: inside VeloExpense's branded shell rather than ExpenseOS's frame. The shell
 * takes the tenant (`shell`), draws the wordmark, ONE filled button and plain links under it,
 * and the small print; this supplies the heading, body, detail table and closing between
 * them. So the primary action is the shell's button and any other action one of its links
 * (ExpenseOS: an outlined button), `footer` is the shell's footnote, and `brand` is not drawn
 * — the tenant's name is the wordmark, as on every VeloExpense mail. An action whose URL is
 * not http(s) keeps ExpenseOS's rule: no link, its label as text.
 * The shell has no slot under its button, so `closing` sits at the end of the body, above
 * the button (ExpenseOS: below the buttons).
 */
export function renderEmailHtml(
  input: EmailLayoutInput,
  shell: Pick<EmailShellInput, 'organizationName' | 'brandColor'>,
): string {
  const actions = (input.actions ?? []).filter((a) => a.label.trim());
  const linked = actions.filter((a) => safeHref(a.url));
  const unlinked = actions.filter((a) => !safeHref(a.url));
  const primary = linked.find((a) => a.primary) ?? null;
  const others = linked.filter((a) => a !== primary);
  const bodyHtml =
    `<h1 style="margin:0 0 12px;font-size:18px;line-height:1.35;color:${INK};font-weight:600;">` +
    `${escapeHtml(input.heading)}</h1>` +
    (input.bodyHtml ?? paragraphs(input.body)) +
    (input.details?.length ? detailTable(input.details) : '') +
    unlinked
      .map(
        (a) =>
          `<p style="margin:0 0 12px;color:${MUTED};font-size:14px;">${escapeHtml(a.label)}</p>`,
      )
      .join('') +
    (input.closing?.length
      ? `<div style="margin-top:20px;">${paragraphs(input.closing.join('\n\n'))}</div>`
      : '');
  return emailShell({
    organizationName: shell.organizationName,
    brandColor: shell.brandColor,
    bodyHtml,
    cta: primary ? { label: primary.label, url: safeHref(primary.url) as string } : null,
    links: others.map((a) => ({ label: a.label, url: safeHref(a.url) as string })),
    footnote: input.footer ?? null,
  });
}

/**
 * The plain-text alternative.
 *
 * Not a fallback nobody reads: it is what a screen reader in text mode, a terminal client,
 * and every spam filter judging the message actually see. A message whose text part is
 * empty or is the HTML stripped of tags scores badly and reads worse, so the actions are
 * spelled out as labelled URLs rather than dropped.
 */
export function renderEmailText(input: EmailLayoutInput): string {
  const actions = (input.actions ?? [])
    .filter((a) => a.label.trim() && safeHref(a.url))
    .map((a) => `${a.label}: ${a.url}`);
  // The same rows the HTML table carries, as `Label: value` lines. Not decoration: this
  // part is what a terminal client, a screen reader in text mode and every spam filter
  // judging the message actually read, so a text part that says less than the HTML one is
  // both a worse message and a worse-scoring one.
  const details = (input.details ?? [])
    .filter((d) => d.label.trim() && d.value.trim())
    .map((d) => `${d.label}: ${d.value}`);
  return [
    input.heading,
    '',
    input.body,
    ...(details.length ? ['', ...details] : []),
    ...(actions.length ? ['', ...actions] : []),
    ...(input.closing?.length ? ['', ...input.closing] : []),
    '',
  ]
    .concat(input.footer ? [input.footer] : [])
    .join('\n')
    .trim();
}
