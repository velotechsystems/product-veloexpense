/**
 * VX2-8 — outbound email. One function, `sendEmail`, behind which the transport
 * is swappable.
 *
 * Ported from ExpenseOS `packages/notifications/src/email.ts` (GAP-AUDIT NT-18),
 * which settled the question this file would otherwise have to ask: email is
 * PLATFORM configuration, not per-tenant. Their `integration` table supplies
 * exactly two things — an active/inactive gate and a from-address override — and
 * the transport itself is process environment. VeloExpense has no integration
 * system, so the gate becomes "is SMTP configured" and per-tenant customisation
 * is deferred with nothing lost.
 *
 * ── Three transports, and which one is a trap ───────────────────────────────
 *
 *   SMTP     — `SMTP_HOST` set. The real thing (Mailpit locally, an SES relay
 *              above that, which is the arrangement ExpenseOS documents).
 *   CONSOLE  — `SMTP_HOST` unset, or `EMAIL_TRANSPORT=console`. Logs the message.
 *              Ported deliberately: it is what lets the whole flow be exercised
 *              on a laptop with no mail server, the same argument VX1-9 made for
 *              choosing `s3rver` over MinIO ("one Node process — no Docker for CI
 *              or a laptop").
 *   MEMORY   — installed by a test with `setEmailTransport`. Captures messages so
 *              a suite can assert on the rendered body and the approve links.
 *
 * THE TRAP IS THE MEMORY ONE, and VX1-5/VX1-9 already paid for this lesson once:
 * "MemoryStorage signs `memory://` URLs no browser can fetch, which is exactly
 * how every vitest suite stays green while a real upload is broken." The same is
 * true here — a memory transport proves the message was composed, never that
 * SMTP works. So the e2e must NOT use it; VX2-10 needs a real sink (an in-process
 * SMTP server is the `s3rver`-shaped answer). Recorded in HANDOFF §7.
 *
 * ── The asymmetry to keep ───────────────────────────────────────────────────
 *
 * The console path NEVER throws; SMTP errors PROPAGATE. Ported verbatim, and
 * deliberate on both sides: a developer without a mail server must not see
 * failures, and a real send that failed must not be swallowed — the outbox is
 * what turns a thrown error into a retry and an admin-visible reason.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  from?: string;
  /**
   * RFC 5322 threading. Every message about one report lands in one conversation
   * instead of as N unrelated emails. `messageId` must be UNIQUE per message — a
   * repeated one makes clients treat later messages as duplicates and hide them —
   * while `references` carries the shared root that actually groups them.
   */
  messageId?: string;
  references?: string;
  inReplyTo?: string;
  /**
   * Extra headers. We always send one, and it is not optional in practice:
   * `Auto-Submitted: auto-replied` (RFC 3834). ExpenseOS's comment is the whole
   * justification and it is not something anyone derives from first principles —
   * "a machine-generated reply has to say so, or a well-behaved out-of-office
   * responder answers it and the two of them keep going."
   */
  headers?: Record<string, string>;
}

export interface EmailTransport {
  readonly kind: 'SMTP' | 'CONSOLE' | 'MEMORY';
  send(msg: EmailMessage): Promise<void>;
  /** For an admin "is email working" check. Never throws; returns the reason. */
  verify(): Promise<{ ok: boolean; message: string }>;
}

/* ── the console transport ─────────────────────────────────────────────────── */

const consoleTransport: EmailTransport = {
  kind: 'CONSOLE',
  async send(msg) {
    const body = msg.text
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
    console.info(`\n[email:console] to=${msg.to}\n  subject: ${msg.subject}\n  text:\n${body}\n`);
  },
  async verify() {
    return {
      ok: true,
      message:
        'Console transport — messages are written to the server log and nothing is sent. ' +
        'Set SMTP_HOST to deliver mail.',
    };
  },
};

/* ── the memory transport, for tests ──────────────────────────────────────── */

export interface CapturedEmail extends EmailMessage {
  sentAt: Date;
}

export class MemoryEmailTransport implements EmailTransport {
  readonly kind = 'MEMORY' as const;
  readonly sent: CapturedEmail[] = [];
  /** Set to make the next `send` throw, so a suite can exercise the retry path. */
  failNext: Error | null = null;

  async send(msg: EmailMessage): Promise<void> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.sent.push({ ...msg, sentAt: new Date() });
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'In-memory transport (tests only).' };
  }

  reset(): void {
    this.sent.length = 0;
    this.failNext = null;
  }
}

/* ── the SMTP transport ───────────────────────────────────────────────────── */

/**
 * `nodemailer` is imported DYNAMICALLY, and not for tidiness.
 *
 * `lib/notifications/dispatch.ts` is reachable from a server component, and a
 * static import would put a mail client in the bundle graph of a page that will
 * never send anything. It also means the package is only required at the moment
 * somebody has actually configured SMTP, so a deployment that logs to the console
 * does not fail at import time if the dependency is missing.
 */
async function smtpTransport(): Promise<EmailTransport> {
  const nodemailer = (await import('nodemailer')).default;
  const port = Number(process.env.SMTP_PORT ?? '587');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // STARTTLS on 587, implicit TLS on 465; SMTP_SECURE forces the latter.
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  });
  return {
    kind: 'SMTP',
    async send(msg) {
      await transporter.sendMail({
        from: msg.from?.trim() || fromAddress(),
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        // Omitted when absent so nodemailer keeps minting its own Message-ID.
        ...(msg.messageId?.trim() ? { messageId: msg.messageId.trim() } : {}),
        ...(msg.references?.trim() ? { references: msg.references.trim() } : {}),
        ...(msg.inReplyTo?.trim() ? { inReplyTo: msg.inReplyTo.trim() } : {}),
        ...(msg.headers && Object.keys(msg.headers).length > 0 ? { headers: msg.headers } : {}),
      });
    },
    async verify() {
      try {
        await transporter.verify();
        return { ok: true, message: `SMTP reachable at ${process.env.SMTP_HOST}.` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export function fromAddress(): string {
  return (
    process.env.SMTP_FROM?.trim() ||
    process.env.EMAIL_FROM?.trim() ||
    'noreply@veloexpense.local'
  );
}

/* ── selection ────────────────────────────────────────────────────────────── */

let override: EmailTransport | null = null;
let cached: EmailTransport | null = null;

/**
 * Install a transport, for tests. Returns a restore function.
 *
 * A module-level cache under test is the thing `resetCatalogCache` exists for in
 * ExpenseOS, and its comment records what it cost: the FIRST test to populate one
 * fixes it for every later test, so "a suite written without this has one real
 * assertion and a row of companions that pass because nothing was logged AND
 * because nothing could have been." Hence the restore function rather than a
 * setter, and hence `resetEmailTransport` below.
 */
export function setEmailTransport(t: EmailTransport): () => void {
  override = t;
  return () => {
    override = null;
  };
}

export function resetEmailTransport(): void {
  override = null;
  cached = null;
}

function consoleOnly(): boolean {
  if (process.env.EMAIL_TRANSPORT?.trim().toLowerCase() === 'console') return true;
  return !process.env.SMTP_HOST?.trim();
}

export async function emailTransport(): Promise<EmailTransport> {
  if (override) return override;
  if (cached) return cached;
  cached = consoleOnly() ? consoleTransport : await smtpTransport();
  return cached;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const t = await emailTransport();
  await t.send(msg);
}

export async function verifyEmailTransport(): Promise<{
  ok: boolean;
  message: string;
  kind: EmailTransport['kind'];
}> {
  const t = await emailTransport();
  const r = await t.verify();
  return { ...r, kind: t.kind };
}

/**
 * The origin every outbound link is built on, or null when nothing names one.
 *
 * READ AT CALL TIME, and from more than one variable. Both halves of that are
 * ported from an ExpenseOS incident (GAP-AUDIT NT-14) whose cost is worth
 * repeating here because the failure is invisible:
 *
 *   "the deployed task definition sets `AUTH_URL`, not `APP_URL` … so `APP_URL`
 *    was empty in dev and prod — and an empty origin makes `deepLink()` AND
 *    `issueActions()` return null. Every notification email in a deployed
 *    environment therefore went out with no link and no approve/reject buttons,
 *    which is indistinguishable from 'this notification was never meant to be
 *    actionable'."
 *
 * VeloExpense reads `AUTH_URL` in `auth.ts` and has no `APP_URL`, so it would
 * have walked into precisely this. And a module-load constant would be one
 * import re-sort away from emptying every link, which is the second half of their
 * comment.
 */
export function appOrigin(): string | null {
  const raw = (
    process.env.APP_URL ||
    process.env.AUTH_URL ||
    process.env.NEXTAUTH_URL ||
    ''
  ).trim();
  if (!raw) {
    warnNoOriginOnce();
    return null;
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Say so, once per process, when there is nothing to link to.
 *
 * Ported with its reason: without it "the recipient gets a correct sentence about
 * a card request with nothing to click, and no log line anywhere says why."
 * NT-11's rule — every deliberate non-delivery must be observable — applies to a
 * partial delivery too.
 */
let originWarned = false;
function warnNoOriginOnce(): void {
  if (originWarned) return;
  originWarned = true;
  console.warn(
    '[notifications] no APP_URL / AUTH_URL / NEXTAUTH_URL is set — notification emails will ' +
      'carry NO approve/reject links and NO link to the report. Set APP_URL to the app origin.',
  );
}

/** Exported for tests, for the reason `setEmailTransport` explains. */
export function resetOriginWarning(): void {
  originWarned = false;
}
