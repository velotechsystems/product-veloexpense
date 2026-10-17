/**
 * Inbound email endpoint — SES receipt rule → SNS → here. Two mailboxes, one path.
 *
 *   `reply+<token>@`    a reply to a notification becomes a COMMENT on the subject.
 *   `receipts+<token>@` an emailed receipt becomes an expense report, or joins one.
 *
 * The token in the address maps back to the subject + recipient via ReplyThread and
 * authenticates the actor (a secret only that recipient received); we additionally require
 * the From to match the recipient's address.
 *
 * SNS messages are signature-verified against a cert fetched from `sns.<region>.amazonaws.com`
 * — that host exactly, because any S3 bucket answers under `*.amazonaws.com` too — so only
 * AWS can drive this endpoint; the SubscriptionConfirmation handshake is auto-confirmed for
 * our topic. Then the sender: the SES verdicts must pass AND the From must be aligned with
 * whichever domain authenticated (see `authenticatedSender`), because the From is who the
 * receipts become an expense report FOR.
 *
 * **The receipts mailbox does none of its work here.** SES stores the raw message in S3
 * (its SNS action caps out around 150KB, which one phone photo exceeds) and this handler
 * enqueues a Redis job with the pointer. SNS redelivers a non-2xx, so a slow handler would
 * be redelivered — as a duplicate expense report.
 *
 * Ported from ExpenseOS's `apps/web/src/app/api/email/inbound/route.ts` (550b2945), Wave 3
 * (w3-06). VeloExpense, each marked below:
 *   · the address names the tenant (d47): `receipts@<tenant>.<INBOUND_EMAIL_DOMAIN>`. An
 *     email address is unique only inside a tenant here, so the From alone cannot say whose
 *     claim this is; the tenant comes from the address, must be active, and travels to the
 *     worker as the job's `organizationId`, where the sender is looked up inside it only;
 *   · the `reply+` comment path (w5-01) does none of its work here either: like the receipts
 *     mailbox, it hands the stored message to the worker (`email.ingestReply`), so only the
 *     worker reads the inbound-mail bucket (decided 17 Oct 2026). ExpenseOS reads the
 *     message and posts the comment in this route;
 *   · no public forwarding domain: mail is received directly on the tenant's address, where
 *     ExpenseOS's Workspace MX forced a forward;
 *   · the hourly ceiling is per tenant and sender.
 */
import { createVerify } from 'node:crypto';
import { enqueue } from '@expenseos/jobs';
import { withoutOrg } from '@/lib/tenant/context';
import { candidateSlugFromHost } from '@/lib/tenant/host';
import { claimOnce, releaseClaim } from '@/server/lib/inboundDedup';
import { throttle } from '@/server/lib/rateLimit';
import {
  authenticatedSender,
  type InboundMailbox,
  type InboundMatch,
  matchInboundMailbox,
  type SesMail,
  type SesReceipt,
  snsCanonicalString,
  splitAddressList,
  verdictsPass,
} from '@/server/lib/snsEmail';

/**
 * VeloExpense: the domain every tenant's mailbox sits ONE label under —
 * `receipts@<tenant>.<this>` (d47). Its wildcard MX points at SES.
 */
const INBOUND_EMAIL_DOMAIN = process.env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();

// VeloExpense: no INBOUND_PUBLIC_EMAIL_DOMAIN. ExpenseOS's people type an address on a
// domain whose MX belongs to Workspace, which forwards to the one SES receives on; here SES
// receives on the tenant's address itself, so the two are the same.

/**
 * Local parts per purpose, comma-separated, covering the public and internal forms.
 *
 * Both are listed because which one arrives depends on how the Workspace rule was configured:
 * a domain-only rewrite keeps `receipts-dev+<token>`, a full rewrite replaces it with plain
 * `receipts`. Configurable because dev and prod share the public domain and must not share a
 * mailbox — `receipts-dev@e.inc` against `receipts@e.inc`.
 */
const RECEIPTS_MAILBOXES = process.env.INBOUND_RECEIPTS_MAILBOXES?.trim() || 'receipts';
/** Local parts of the reply mailbox (w5-01): `reply+<token>@<tenant>.<inbound domain>`. */
const REPLY_MAILBOXES = process.env.INBOUND_REPLY_MAILBOXES?.trim() || 'reply';

/**
 * Receipt emails accepted per sender per hour.
 *
 * Not abuse control — the sender has already passed DKIM or SPF and resolved to an employee.
 * It is a ceiling on a cost nothing else in the product carries: each message means a stored
 * object, N receipt writes and N model calls for extraction. Fails OPEN, like every other use
 * of `throttle`: a Redis hiccup must not swallow somebody's expense claim.
 */
const RECEIPT_EMAILS_PER_HOUR = 60;

function mailboxes(): InboundMailbox[] {
  const parts = (raw: string) =>
    raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  return [
    { purpose: 'receipts', localParts: parts(RECEIPTS_MAILBOXES) },
    { purpose: 'reply', localParts: parts(REPLY_MAILBOXES) },
  ];
}
// Pin the SNS topic. An SNS signing cert is a public AWS cert shared across
// every topic/account in a region, so a valid signature alone lets ANY
// AWS-signed message drive this endpoint. TopicArn is part of the signed
// canonical string, so it cannot be forged for our topic — only the real
// topic owner can produce a message that both verifies and matches.
const INBOUND_SNS_TOPIC_ARN = process.env.INBOUND_SNS_TOPIC_ARN?.trim();

/**
 * The only hosts an SNS-issued URL may name: `sns.<region>.amazonaws.com` (`.cn` for the
 * China partition), the same pin the AWS SDK's own message validator uses.
 *
 * Not `*.amazonaws.com`. Every S3 bucket is served under `<bucket>.s3.amazonaws.com`, so a
 * suffix match let an attacker host a self-signed PEM in their own bucket, sign the canonical
 * string with the matching private key, and pass verification — the topic-ARN pin is inside
 * the signed string and offered no protection. The same suffix match let a forged
 * SubscriptionConfirmation make this server GET any HTTPS URL on any AWS-hosted service.
 */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** Parsed when HTTPS on an SNS host; null otherwise. */
function snsUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && SNS_HOST.test(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** A SubscribeURL we are willing to GET. */
function isSnsUrl(raw: string | undefined): boolean {
  return snsUrl(raw) !== null;
}

/** A SigningCertURL we are willing to trust: an SNS host, and a `.pem` path. */
function isSnsSigningCertUrl(raw: string | undefined): boolean {
  const u = snsUrl(raw);
  return u?.pathname.toLowerCase().endsWith('.pem') === true;
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  let msg: SnsMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return new Response('bad payload', { status: 400 });
  }

  if (!(await verifySnsSignature(msg))) return new Response('unauthorized', { status: 401 });

  // Only ever act on our own topic. Fail closed when the expected ARN is
  // unconfigured so a misconfigured deploy cannot process foreign messages.
  if (!INBOUND_SNS_TOPIC_ARN || msg.TopicArn !== INBOUND_SNS_TOPIC_ARN) {
    return new Response('unauthorized', { status: 401 });
  }

  // Confirm the HTTPS subscription on first connect.
  if (msg.Type === 'SubscriptionConfirmation' && msg.SubscribeURL) {
    if (!isSnsUrl(msg.SubscribeURL)) return new Response('unauthorized', { status: 401 });
    await fetch(msg.SubscribeURL).catch((e) => console.warn('[email:inbound] confirm failed', e));
    return new Response(null, { status: 200 });
  }

  if (msg.Type === 'Notification') {
    try {
      await handleNotification(msg.Message ?? '', msg.MessageId);
    } catch (e) {
      console.warn('[email:inbound] failed', e);
      // Release the idempotency claim and REFUSE the delivery, the same way the Slack
      // events endpoint does. Swallowing this into a 200 lost the message twice over:
      // SNS was told we accepted it so no redelivery was ever sent, and the claim was
      // still held so the redelivery would have been dropped as a duplicate if it had
      // been. A queue hiccup silently discarded somebody's expense receipt.
      if (e instanceof InboundFailure) await releaseClaim(e.claimId);
      return new Response(null, { status: 500 });
    }
  }
  return new Response(null, { status: 200 });
}

/**
 * A failure AFTER the idempotency claim was taken.
 *
 * It carries the claim so the caller can release it — without that, refusing the delivery
 * is worse than accepting it: SNS redelivers into a claim that is still held, and the
 * message is dropped as a duplicate of a delivery that never completed.
 */
class InboundFailure extends Error {
  constructor(
    readonly claimId: string | undefined,
    cause: unknown,
  ) {
    super('inbound processing failed', { cause });
    this.name = 'InboundFailure';
  }
}

async function handleNotification(message: string, snsMessageId?: string): Promise<void> {
  if (!INBOUND_EMAIL_DOMAIN) return;
  let ses: SesNotification;
  try {
    ses = JSON.parse(message);
  } catch {
    return;
  }
  if (ses.notificationType !== 'Received') return;

  // SNS is at-least-once; dedup on the SES message id (fall back to the SNS
  // envelope id) so a redelivery doesn't post a duplicate comment + fan-out.
  const sesMessageId = ses.mail?.messageId ?? snsMessageId;
  if (!(await claimOnce(sesMessageId))) return;

  try {
    await processClaimed(ses, INBOUND_EMAIL_DOMAIN, sesMessageId);
  } catch (e) {
    throw new InboundFailure(sesMessageId, e);
  }
}

/** Everything that happens once the message is ours to process, exactly once. The domain
 *  is passed rather than read again: the caller has already established it is configured. */
async function processClaimed(
  ses: SesNotification,
  inboundDomain: string,
  sesMessageId?: string,
): Promise<void> {
  // Authentication first, and identically for both mailboxes: everything downstream writes
  // something on behalf of whoever the From claims to be.
  if (!verdictsPass(ses.receipt)) {
    console.warn(`[email.inbound] rejected ${sesMessageId}: authentication verdicts`);
    return;
  }
  // …and the From has to be tied to whichever domain those verdicts were about. A passing
  // SPF or DKIM on the attacker's own domain used to be enough to file receipts as anyone.
  const sender = authenticatedSender(ses.mail, ses.receipt);
  if (!sender.ok) {
    console.warn(`[email.inbound] rejected ${sesMessageId}: ${sender.reason}`);
    return;
  }

  // The envelope first (a domain-only forward leaves the token in it), then the message's own
  // To/Cc — which a forward does not rewrite. See matchInboundMailbox.
  const addresses = [
    ...(ses.receipt?.recipients ?? []),
    ...(ses.mail?.destination ?? []),
    ...splitAddressList(ses.mail?.commonHeaders?.to?.join(', ')),
    ...splitAddressList(ses.mail?.commonHeaders?.cc?.join(', ')),
  ];
  // VeloExpense: which tenant's mailbox (d47). Exactly one: a message addressed to two
  // tenants' mailboxes is somebody's mistake, and filing it in both — or in whichever came
  // first — would be a guess about whose claim it is.
  const tenants = addressedTenants(addresses, mailboxes(), inboundDomain);
  if (tenants.length === 0) return;
  if (tenants.length > 1) {
    console.warn(`[email.inbound] ignoring ${sesMessageId}: addressed to ${tenants.length} tenants`);
    return;
  }
  const [{ slug, match: addressed }] = tenants;

  if (addressed.purpose === 'receipts') {
    // VeloExpense: the tenant must exist and be active. An unknown one is a typo or a probe,
    // and either way there is nobody to file for or to tell.
    const organizationId = await activeTenantId(slug);
    if (!organizationId) {
      console.warn(`[email.inbound] ignoring ${sesMessageId}: no active tenant at that address`);
      return;
    }
    // Keyed on the authenticated From — the person the cost is incurred for — not on the
    // envelope sender, which is free-form for anyone who controls a domain.
    // VeloExpense: and on the tenant, since an address is only unique inside one.
    const limit = await throttle(`inbound:receipts:${organizationId}:${sender.address}`, {
      max: RECEIPT_EMAILS_PER_HOUR,
      windowSec: 3600,
    });
    if (!limit.allowed) {
      console.warn(`[email.inbound] hourly ceiling reached for ${sender.address}`);
      return;
    }
    await handleReceipts(ses, addressed.token, sender.address, organizationId, sesMessageId);
    return;
  }

  // w5-01: a reply to a notification. The token names the thread and proves who was
  // addressed; the worker checks that the sender IS that person before posting anything.
  const token = addressed.token;
  if (!token) return;
  const organizationId = await activeTenantId(slug);
  if (!organizationId) {
    console.warn(`[email.inbound] ignoring ${sesMessageId}: no active tenant at that address`);
    return;
  }
  await handleReply(ses, token, sender.address, organizationId, sesMessageId);
}

/**
 * Hand a reply to the worker (w5-01). VeloExpense: ExpenseOS reads the stored message and
 * posts the comment here; this enqueues `email.ingestReply` instead, as `handleReceipts`
 * does, so the web app never reads the inbound-mail bucket.
 */
async function handleReply(
  ses: SesNotification,
  token: string,
  sender: string,
  organizationId: string,
  sesMessageId?: string,
): Promise<void> {
  const action = ses.receipt?.action;
  if (action?.type !== 'S3' || !action.bucketName || !action.objectKey) {
    console.warn(
      `[email.inbound] reply message ${sesMessageId} has no S3 action; the SES rule needs one`,
    );
    return;
  }
  try {
    await enqueue('email.ingestReply', {
      bucket: action.bucketName,
      objectKey: action.objectKey,
      sesMessageId: sesMessageId ?? '',
      token,
      sender,
      organizationId,
    });
  } catch (err) {
    // As for receipts: no 200, so SNS redelivers, and the dedup claim is released below.
    console.error(`[email.inbound] enqueue failed for ${sesMessageId}:`, err);
    throw err;
  }
}

/**
 * VeloExpense (d47): every tenant mailbox these addresses name, with what the address asked
 * for. A tenant's domain is exactly one label under the inbound domain — read with the same
 * rule a tenant's web address is (`candidateSlugFromHost`) — and each is matched with
 * ExpenseOS's `matchInboundMailbox`, so its token and case rules hold unchanged.
 */
function addressedTenants(
  addresses: readonly (string | null | undefined)[],
  boxes: readonly InboundMailbox[],
  inboundDomain: string,
): { slug: string; match: InboundMatch }[] {
  const slugs = new Set<string>();
  for (const raw of addresses) {
    const at = raw?.lastIndexOf('@') ?? -1;
    if (!raw || at < 0) continue;
    const domain = raw.slice(at + 1).replace(/>.*$/, '').trim();
    const slug = candidateSlugFromHost(domain, inboundDomain);
    if (slug) slugs.add(slug);
  }
  const out: { slug: string; match: InboundMatch }[] = [];
  for (const slug of slugs) {
    const match = matchInboundMailbox(addresses, boxes, [`${slug}.${inboundDomain}`]);
    if (match) out.push({ slug, match });
  }
  return out;
}

/**
 * VeloExpense: the tenant at `slug`, if it is active. `organization` has no tenant column, so
 * it is read without a tenant scope (`withoutOrg`); nothing else is.
 */
async function activeTenantId(slug: string): Promise<string | null> {
  const res = await withoutOrg((tx) =>
    tx.query(`SELECT id FROM organization WHERE slug = $1 AND status <> 'suspended'`, [slug]),
  );
  const id = res.rows[0]?.id;
  return id ? String(id) : null;
}

/**
 * Hand an emailed receipt to the worker.
 *
 * Nothing is parsed here. The object may be tens of megabytes, and the only things this needs
 * are already in the notification: where SES put it, which thread it belongs to, and who it
 * has been authenticated as being from — the handler files the claim as that person and
 * refuses the message if the MIME names anyone else.
 */
async function handleReceipts(
  ses: SesNotification,
  token: string | null,
  claimant: string,
  organizationId: string,
  sesMessageId?: string,
): Promise<void> {
  const action = ses.receipt?.action;
  if (action?.type !== 'S3' || !action.bucketName || !action.objectKey) {
    // The rule was configured without the S3 action, so the message is either inline (and
    // therefore under ~150KB, i.e. not a receipt email) or nowhere. Say so once rather than
    // failing silently in a way that looks like the email never arrived.
    console.warn(
      `[email.inbound] receipts message ${sesMessageId} has no S3 action; the SES rule needs one`,
    );
    return;
  }
  try {
    await enqueue('email.ingestReceipts', {
      bucket: action.bucketName,
      objectKey: action.objectKey,
      sesMessageId: sesMessageId ?? '',
      mailbox: 'receipts',
      claimant,
      ...(token ? { token } : {}),
      // VeloExpense: the tenant the address named; the worker runs the job as it.
      organizationId,
    });
  } catch (err) {
    // A queue hiccup must not make SNS think we accepted the message: returning without a
    // 200 lets it redeliver, and the dedup claim is what stops that becoming a duplicate.
    console.error(`[email.inbound] enqueue failed for ${sesMessageId}:`, err);
    throw err;
  }
}

// VeloExpense: ExpenseOS's `loadRawMessage` (the reply path's read of the stored message) is
// in the worker's `email.ingestReply` (w5-01). Neither mailbox reads here.

/** Verify an SNS message signature against its signing cert, which must come from an SNS
 *  host (see SNS_HOST) — the cert URL is attacker-supplied until the signature checks out. */
async function verifySnsSignature(msg: SnsMessage): Promise<boolean> {
  if (!msg.SigningCertURL || !msg.Signature) return false;
  if (!isSnsSigningCertUrl(msg.SigningCertURL)) return false;
  const canonical = snsCanonicalString(msg);
  if (!canonical) return false;
  try {
    const cert = await fetch(msg.SigningCertURL).then((r) => r.text());
    const algo = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    const verifier = createVerify(algo);
    verifier.update(canonical, 'utf8');
    return verifier.verify(cert, msg.Signature, 'base64');
  } catch (e) {
    console.warn('[email:inbound] sns verify error', e);
    return false;
  }
}

interface SnsMessage {
  Type?: string;
  Message?: string;
  MessageId?: string;
  Subject?: string;
  Timestamp?: string;
  TopicArn?: string;
  Token?: string;
  SubscribeURL?: string;
  Signature?: string;
  SignatureVersion?: string;
  SigningCertURL?: string;
}
interface SesNotification {
  notificationType?: string;
  /** Present only for the SNS action, which caps out around 150KB. */
  content?: string;
  mail?: SesMail;
  receipt?: SesReceipt;
}
