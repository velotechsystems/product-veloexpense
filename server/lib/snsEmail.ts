/**
 * Pure helpers for the inbound email endpoint (SNS + reply-token parsing),
 * split out so they're unit-testable without AWS / a DB.
 *
 * VeloExpense: ExpenseOS's `apps/web/src/server/lib/snsEmail.ts` (550b2945), Wave 3 (w3-06),
 * unchanged. The tenant is read from the address in the route (d47), around these.
 */

interface SnsLike {
  Type?: string;
  Message?: string;
  MessageId?: string;
  Subject?: string;
  Timestamp?: string;
  TopicArn?: string;
  Token?: string;
  SubscribeURL?: string;
}

/**
 * The canonical string AWS SNS signs, built from a type-specific, ordered field
 * list as `${key}\n${value}\n`. Returns null for an unknown message type.
 * See "Verifying the signatures of Amazon SNS messages".
 */
export function snsCanonicalString(msg: SnsLike): string | null {
  const keys =
    msg.Type === 'Notification'
      ? (['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const)
      : msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation'
        ? ([
            'Message',
            'MessageId',
            'SubscribeURL',
            'Timestamp',
            'Token',
            'TopicArn',
            'Type',
          ] as const)
        : null;
  if (!keys) return null;
  let out = '';
  for (const key of keys) {
    const value = (msg as Record<string, string | undefined>)[key];
    if (value === undefined) continue; // Subject is omitted when absent
    out += `${key}\n${value}\n`;
  }
  return out;
}

/**
 * Find the reply token in a list of recipient addresses, matching
 * `reply+<token>@<domain>` (case-insensitive on the domain). Returns the raw
 * token or null.
 */
export function extractReplyToken(recipients: string[], domain: string): string | null {
  const re = new RegExp(`^reply\\+([^@]+)@${escapeRegExp(domain)}$`, 'i');
  for (const r of recipients) {
    const m = r.trim().match(re);
    if (m) return m[1];
  }
  return null;
}

/** What an inbound address is FOR. The mailbox decides the action, not the content. */
export type InboundPurpose = 'receipts' | 'reply';

export interface InboundMailbox {
  purpose: InboundPurpose;
  /**
   * Every local part that means this purpose.
   *
   * More than one because the address people use and the address SES receives on are not the
   * same: `receipts-dev@e.inc` is forwarded to `receipts@expenseos.dev.internal.e.inc`, and
   * which of the two survives depends on how the forward was configured. Both are listed and
   * either matches.
   */
  localParts: readonly string[];
}

export interface InboundMatch {
  purpose: InboundPurpose;
  /** The `+<token>` part, when the address carried one. */
  token: string | null;
}

/**
 * Which mailbox a message was addressed to, and its token if it had one.
 *
 * **Why this looks at more than the envelope.** Workspace rewrites the envelope recipient when
 * it forwards `receipts+1234@e.inc` to the address SES receives on, and the `+1234` does not
 * survive that rewrite — so an envelope-only reading would turn every threaded reply into a
 * brand-new report. The `To` and `Cc` headers are part of the MESSAGE and are not rewritten,
 * and the token is always in one of them by construction: we send the acknowledgement FROM
 * `receipts+1234@e.inc`, so a reply is addressed straight back to it.
 *
 * The envelope is still checked first and still wins, because a routing rule that rewrites
 * only the domain leaves the token in place — and an envelope recipient is one hop closer to
 * what SES actually accepted.
 *
 * A match WITH a token beats a match without one: a reply commonly carries both the token
 * address (in `To`) and the plain mailbox (in the envelope), and reading the plain one would
 * silently start a new report instead of continuing the thread.
 */
export function matchInboundMailbox(
  addresses: readonly (string | null | undefined)[],
  mailboxes: readonly InboundMailbox[],
  domains: readonly string[],
): InboundMatch | null {
  const wanted = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return null;
  let fallback: InboundMatch | null = null;

  for (const raw of addresses) {
    // Header values arrive as display forms ("ExpenseOS <receipts+1@e.inc>") and as bare
    // addresses; take what is inside the angle brackets when there are any.
    const addr = bareAddress(raw);
    if (!addr) continue;
    const at = addr.lastIndexOf('@');
    if (at <= 0) continue;
    // Domain and mailbox are compared case-insensitively; the TOKEN keeps the case it was
    // sent with. `issueEmailReplyToken` emits base64url, so lowercasing it would hash to
    // something else and every threaded reply would look like an unknown thread.
    if (!wanted.includes(addr.slice(at + 1).toLowerCase())) continue;

    const localPart = addr.slice(0, at);
    const plus = localPart.indexOf('+');
    const mailbox = (plus >= 0 ? localPart.slice(0, plus) : localPart).toLowerCase();
    const token = plus >= 0 ? localPart.slice(plus + 1) : '';

    const hit = mailboxes.find((m) =>
      m.localParts.some((lp) => lp.trim().toLowerCase() === mailbox),
    );
    if (!hit) continue;
    if (token) return { purpose: hit.purpose, token };
    fallback ??= { purpose: hit.purpose, token: null };
  }
  return fallback;
}

/**
 * The bare `local@domain` from a header value or an envelope address.
 *
 * Case is PRESERVED — see the token note in `matchInboundMailbox`.
 */
function bareAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angled = raw.match(/<([^>]+)>/);
  const addr = (angled ? angled[1] : raw).trim();
  // A header can hold several addresses; this helper takes one, so anything with a comma is
  // handed back unparsed rather than guessed at (callers split first).
  return addr.includes(',') || !addr.includes('@') ? null : addr;
}

/** Split a header value that may hold several addresses ("a@x, B <b@y>"). */
export function splitAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip quoted history + signatures from a plain-text reply, keeping the
 * author's new content (usually at the top). Heuristic: cut at the first
 * attribution line ("On … wrote:" / "Le … a écrit :"), the first quoted (`>`)
 * block, or a `-- ` / Outlook divider.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const attribution = /^\s*(On .+wrote:|Le .+a écrit\s*:|.*<[^>]+@[^>]+>.*:)\s*$/;
  for (const line of lines) {
    if (attribution.test(line)) break;
    if (/^\s*>/.test(line)) break;
    if (/^--\s*$/.test(line)) break; // signature delimiter
    if (/^_{5,}$/.test(line)) break; // Outlook "____" divider
    out.push(line);
  }
  return out.join('\n').trim();
}

interface SesVerdict {
  status?: string;
}
export interface SesReceipt {
  recipients?: string[];
  spamVerdict?: SesVerdict;
  virusVerdict?: SesVerdict;
  spfVerdict?: SesVerdict;
  dkimVerdict?: SesVerdict;
  dmarcVerdict?: SesVerdict;
  /** Where the rule put the message. `S3` for the receipts rule. */
  action?: { type?: string; bucketName?: string; objectKey?: string; topicArn?: string };
}

/**
 * Did this message authenticate well enough to act on?
 *
 * `dkim` OR `spf`, not both: forwarding through Workspace breaks SPF (Google sends on behalf
 * of the original domain) while leaving DKIM intact, so demanding both would reject every
 * legitimate email. Virus and spam must pass outright.
 *
 * THIS IS HALF THE QUESTION. A passing verdict says the message was authorised by SOME
 * domain — the envelope sender's for SPF, the signer's `d=` for DKIM. It says nothing about
 * the `From:` header, which is what decides whose expense report the mail becomes. The other
 * half, tying the authenticated domain to the From, is `authenticatedSender`.
 *
 * A verdict that is absent is treated as a failure, not as a pass: a notification shape we do
 * not recognise must not be the thing that lets mail through.
 */
export function verdictsPass(receipt: SesReceipt | undefined): boolean {
  if (verdict(receipt?.virusVerdict) !== 'PASS') return false;
  if (verdict(receipt?.spamVerdict) !== 'PASS') return false;
  return verdict(receipt?.dkimVerdict) === 'PASS' || verdict(receipt?.spfVerdict) === 'PASS';
}

function verdict(v: SesVerdict | undefined): string | undefined {
  return v?.status?.toUpperCase();
}

/** The slice of the SES `mail` object the sender check reads. */
export interface SesMail {
  /** The envelope sender (SMTP MAIL FROM) — what SPF authenticated. */
  source?: string;
  destination?: string[];
  messageId?: string;
  /** Every header of the message as received, when SES was able to include them all. */
  headers?: { name?: string; value?: string }[];
  headersTruncated?: boolean;
  /** SES parses these for us. `from` holds one entry per address in the From header. */
  commonHeaders?: { to?: string[]; cc?: string[]; from?: string[]; subject?: string };
}

export type SenderCheck = { ok: true; address: string } | { ok: false; reason: string };

/**
 * Who this message is FROM, once that claim has been tied to the domain that authenticated.
 *
 * SES's `spfVerdict` is about the envelope sender and its `dkimVerdict` about whichever
 * domain signed; neither is required to be the domain in the `From:` header, and that header
 * is what the receipts handler resolves to an employee. Without alignment, an outsider who
 * controls any domain with working SPF or DKIM can write `From: cfo@e.inc` and file expense
 * reports — with hash-chained audit rows — as the CFO. This is the alignment check DMARC
 * would perform, done here because the rule we accept is looser than DMARC (either factor
 * alone), and the From must still be tied to whichever factor passed.
 *
 * Accepted, in order:
 *   1. SES's own `dmarcVerdict` is PASS — alignment already evaluated by the receiver.
 *   2. SPF passed and the envelope sender's domain aligns with the From domain.
 *   3. DKIM passed and EVERY `DKIM-Signature` on the message names an aligned `d=`. Every,
 *      not any: SES reports one verdict for the whole message, so a signature that verified
 *      for `attacker.example` beside a forged one claiming `e.inc` would otherwise pass. This
 *      route is unavailable when SES truncated the header list.
 *
 * Alignment is relaxed (subdomains match), the way DMARC's default is. A message with no
 * From, or with more than one From address, is refused: there is no one person it can be
 * from. The address returned is the From, lowercased — the identity the job carries onward.
 */
export function authenticatedSender(
  mail: SesMail | undefined,
  receipt: SesReceipt | undefined,
): SenderCheck {
  const fromHeaders = mail?.commonHeaders?.from ?? [];
  if (fromHeaders.length !== 1) {
    return {
      ok: false,
      reason: fromHeaders.length === 0 ? 'no From header' : `${fromHeaders.length} From addresses`,
    };
  }
  const from = bareAddress(fromHeaders[0])?.toLowerCase() ?? null;
  const fromDomain = from ? domainOf(from) : null;
  if (!from || !fromDomain) return { ok: false, reason: 'unparseable From header' };

  if (verdict(receipt?.dmarcVerdict) === 'PASS') return { ok: true, address: from };

  const envelope = bareAddress(mail?.source)?.toLowerCase() ?? null;
  const envelopeDomain = envelope ? domainOf(envelope) : null;
  if (
    verdict(receipt?.spfVerdict) === 'PASS' &&
    envelopeDomain &&
    aligned(envelopeDomain, fromDomain)
  ) {
    return { ok: true, address: from };
  }

  const signers = mail?.headersTruncated ? [] : dkimSigningDomains(mail?.headers ?? []);
  if (
    verdict(receipt?.dkimVerdict) === 'PASS' &&
    signers.length > 0 &&
    signers.every((d) => aligned(d, fromDomain))
  ) {
    return { ok: true, address: from };
  }

  return {
    ok: false,
    reason:
      `From ${from} is not aligned with the authenticated domain ` +
      `(spf=${envelopeDomain ?? '-'}, dkim=${signers.join(',') || '-'}` +
      `${mail?.headersTruncated ? ', headers truncated' : ''})`,
  };
}

/** The `d=` of every DKIM-Signature header, lowercased. */
function dkimSigningDomains(headers: readonly { name?: string; value?: string }[]): string[] {
  const out: string[] = [];
  for (const h of headers) {
    if (h.name?.toLowerCase() !== 'dkim-signature' || !h.value) continue;
    const m = h.value.match(/(?:^|;)\s*d=([^;\s]+)/i);
    // A signature header without a d= tag is malformed; it cannot vouch for anything, and
    // an entry that fails alignment is the safe way to say so.
    out.push(m ? m[1].toLowerCase() : '');
  }
  return out;
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  const domain = at > 0 ? address.slice(at + 1).trim() : '';
  return domain || null;
}

/**
 * DMARC-style relaxed alignment: equal, or one is a subdomain of the other. An
 * approximation without a public-suffix list, which is fine here because the From must
 * also resolve to an employee of ours before anything is written.
 */
function aligned(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
