/**
 * VX4-3 part 3 — the branded email shell. GAP-AUDIT BR-6.
 *
 * ── The gap, and it is TWO gaps pointing opposite ways ──────────────────────
 *
 * ExpenseOS gets this wrong twice, in opposite directions, and the pair is the
 * whole design brief.
 *
 *   `lib/email.ts:33-58` (password reset) IS branded — and hardcoded. The product
 *   name is baked into both locales ("Réinitialisation de votre mot de passe
 *   ExpenseOS"), and `#0c2340` / `#f76b15` are inlined in the markup. Per-tenant
 *   branding there is not a change, it is a rewrite.
 *
 *   `notification-dispatch.ts:181` has the opposite problem: `html:
 *   \`<p>…</p>${actionsHtml}${ctaHtml}\`` — no wrapper, no doctype, no logo, no
 *   colour at all. **This is the one we inherited**: our `htmlBody()` builds bare
 *   `<p>` tags, which is the same shape.
 *
 * So the port is "take the branded one's intent and the unbranded one's
 * placement", and make the values come from the tenant instead of from source.
 *
 * ── WHY THERE IS NO LOGO IN THIS EMAIL, which is not an oversight ───────────
 *
 * `/api/branding/logo` is SESSION-GATED. An email client has no session cookie, so
 * an `<img src="…/api/branding/logo">` in a message 404s — not "is blocked until
 * the reader clicks show images", but genuinely broken for every recipient. And
 * the recipient who most needs these emails is the approver deciding from a link
 * *without ever signing in* (VX2-8), who by construction has no session at all.
 *
 * Three ways out, and only one of them is honest today:
 *
 *   A public, unguessable logo URL — a new unauthenticated surface, and still
 *   subject to image blocking in Outlook.
 *
 *   CID embedding (multipart/related) — the correct answer. It needs no session,
 *   no network, and survives image blocking. It also needs an `attachments` field
 *   on `EmailMessage`, which does not exist, and a transport that assembles
 *   multipart bodies. That is a real slice, not a line.
 *
 *   A TEXT WORDMARK in the tenant's colour — what this does. It renders
 *   everywhere, cannot be blocked, needs no new surface, and degrades to plain
 *   text gracefully. CID is filed as the follow-up rather than half-built.
 *
 * ── The CTA colour, and a decision that looks inconsistent on purpose ───────
 *
 * A branded tenant's own colour is used directly: it already passed the 4.5:1
 * floor against the chosen foreground when it was saved, so the button is
 * readable by construction.
 *
 * A tenant with NO brand colour does NOT get `--vl-brand` (#0284c7), because that
 * colour is **4.10:1 against white and 4.36:1 against ink** — below AA either way
 * (the defect recorded under BR-3). Every other surface in the product already
 * renders it and changing that is not a porting ticket's call, but this surface is
 * NEW, and deliberately choosing a colour we have measured as inaccessible for
 * brand-new code is indefensible. So the default here is the ramp's own 600 step,
 * #0079bb at 4.72:1, derived rather than pasted so it cannot drift from the ramp.
 * The email's blue is therefore a shade deeper than the app's. That is the visible
 * edge of a real defect, and it should stay visible until the sheet is fixed.
 *
 * ── Email HTML is not HTML ──────────────────────────────────────────────────
 *
 * Tables for layout, inline styles only, pixels not rems, no `<style>` block (Gmail
 * strips much of it), no external anything. `role="presentation"` so a screen
 * reader does not announce the layout scaffolding as a data table.
 */
import { brandRamp, normaliseHex, readableForeground } from '@/lib/branding/color';
import { escapeHtml } from '@/lib/notifications/html';

/**
 * The accent for a tenant that has chosen nothing. Derived from the default brand
 * rather than written down, so it tracks the ramp. See the header for why it is
 * not `--vl-brand` itself.
 */
export const DEFAULT_EMAIL_ACCENT = brandRamp('#0284c7')[600];

/** Ink and paper. Fixed: an email is not theme-aware and must not pretend to be. */
const INK = '#0f172a';
const MUTED = '#5b6b7b';
const RULE = '#e2e8f0';
const PAPER = '#ffffff';
const GROUND = '#f1f5f9';

export interface EmailShellInput {
  /** The tenant's name. Escaped here — callers pass it raw. */
  organizationName: string;
  /** Normalised `#rrggbb`, or null for a tenant that has chosen nothing. */
  brandColor: string | null;
  /** Already-escaped HTML for the message body. */
  bodyHtml: string;
  /** The primary action, if this message has one. */
  cta?: { label: string; url: string } | null;
  /** Secondary links, rendered as plain anchors under the button. */
  links?: { label: string; url: string }[];
  /** Small print under the rule. Plain text; escaped here. */
  footnote?: string | null;
}

export interface EmailShellColors {
  accent: string;
  onAccent: string;
}

/**
 * The accent and the text that sits on it.
 *
 * A tenant colour is used as-is because `setBrandColor` refused it otherwise; the
 * foreground is recomputed rather than stored, so this cannot disagree with what
 * the app renders. `readableForeground` returning null here would mean a row got
 * past the service, so it falls back to the default accent rather than putting
 * unreadable text in an email nobody can fix from the receiving end.
 */
export function shellColors(brandColor: string | null): EmailShellColors {
  const hex = brandColor === null ? null : normaliseHex(brandColor);
  const fg = hex === null ? null : readableForeground(hex);
  if (hex === null || fg === null) {
    return { accent: DEFAULT_EMAIL_ACCENT, onAccent: PAPER };
  }
  return { accent: hex, onAccent: fg.hex };
}

function button(url: string, label: string, colors: EmailShellColors): string {
  // An <a> with padding, not a <button> and not a table-wrapped VML shape: square
  // corners render identically everywhere, and the rounded-corner workaround costs
  // an Outlook-only VML block that then has to be kept in step with this one.
  return (
    `<a href="${escapeHtml(url)}" ` +
    `style="display:inline-block;background:${colors.accent};color:${colors.onAccent};` +
    `text-decoration:none;padding:11px 20px;border-radius:4px;font-weight:600;` +
    `font-size:15px;line-height:1.2">${escapeHtml(label)}</a>`
  );
}

/**
 * The whole message. Returns a complete document — the transport sends this as
 * `html` verbatim.
 */
export function emailShell(input: EmailShellInput): string {
  const colors = shellColors(input.brandColor);
  const name = escapeHtml(input.organizationName);
  const font =
    "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";

  const cta = input.cta ? `<tr><td style="padding:4px 0 18px">${button(input.cta.url, input.cta.label, colors)}</td></tr>` : '';

  const links = (input.links ?? []).length
    ? `<tr><td style="padding:0 0 18px;font-size:14px;line-height:1.6">` +
      (input.links ?? [])
        .map(
          (l) =>
            `<a href="${escapeHtml(l.url)}" style="color:${colors.accent};text-decoration:underline">${escapeHtml(l.label)}</a>`,
        )
        .join('&nbsp;&nbsp;·&nbsp;&nbsp;') +
      `</td></tr>`
    : '';

  const footnote = input.footnote
    ? `<tr><td style="padding:0 0 6px;color:${MUTED};font-size:12px;line-height:1.5">${escapeHtml(input.footnote)}</td></tr>`
    : '';

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    // Tells a client that flips to dark mode that this document has only a light
    // design, so it inverts predictably instead of guessing per element.
    `<meta name="color-scheme" content="light only">` +
    `<title>${name}</title></head>` +
    `<body style="margin:0;padding:0;background:${GROUND};color:${INK};font-family:${font}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="background:${GROUND};padding:24px 12px"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="max-width:560px;background:${PAPER};border-radius:6px;padding:28px 28px 22px">` +
    // The wordmark: the tenant's name, in the tenant's colour. No image — see the
    // header on why a remote logo is broken here rather than merely blocked.
    `<tr><td style="padding:0 0 18px;font-size:17px;font-weight:700;` +
    `letter-spacing:-0.01em;color:${colors.accent}">${name}</td></tr>` +
    `<tr><td style="padding:0 0 16px;font-size:15px;line-height:1.6;color:${INK}">` +
    `${input.bodyHtml}</td></tr>` +
    cta +
    links +
    `<tr><td style="border-top:1px solid ${RULE};padding:14px 0 0"></td></tr>` +
    footnote +
    // Says who sent it and that a machine did. The tenant's name first: the
    // recipient's relationship is with them, not with us.
    `<tr><td style="color:${MUTED};font-size:12px;line-height:1.5">` +
    `Sent by ${name} through VeloExpense. This message was generated automatically.` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}
