import { auditActions, withAudit } from '@expenseos/audit';
import {
  type BusinessUnitSource,
  codingDefaultsFor,
  createBlankExpensesForReceipts,
  createReportFromReceipts,
  nextReportNumber,
  resolveIntakeCurrencyId,
} from '@expenseos/db';
import { loadCatalog } from '@expenseos/i18n/load';
import { enqueue, type JobMap } from '@expenseos/jobs';
import { isReceiptContentType, receiptExtension } from '@expenseos/receipt-extraction';
import { type AddressObject, type Attachment, simpleParser } from 'mailparser';
import { assertExpenseAllowance, CapReachedError } from '@/lib/billing/caps';
import { currentTenantId, db } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { displayName } from '@/lib/format';
import { sendEmail } from '@/lib/notifications/email';
import { escapeHtml } from '@/lib/notifications/html';
import { type BoundedRead, getInboundMailStorage, getStorage } from '@/lib/storage';
// Its own module, not the barrel: a test that mocks `@/lib/storage` wholesale still runs the
// real HEAD-then-bounded-read logic and gets the real cap (ExpenseOS's subpath reason).
import { guardedRead } from '@/lib/storage/guardedRead';
import { receiptKey } from '@/lib/storage/keys';
import { INBOUND_MAIL_CAP_BYTES } from '@/lib/storage/limits';
// VeloExpense: ExpenseOS's summary job, ported (#567).
import {
  SUMMARY_FIRST_DELAY_MS,
  SUMMARY_MAX_WAIT_MS,
  summaryJobId,
} from './receipts-summary-email';

/**
 * Handler for `email.ingestReceipts` — an emailed receipt becomes an expense report.
 *
 * Subject → the report title. Body, signature and quoted history stripped → the business
 * purpose AND the "Explain this charge" explanation on every expense it creates (the
 * workbench shows the explanation; `purpose` alone was invisible there). Each attachment →
 * one expense with that receipt filed against it, read by the same GuardDuty-gated
 * extraction pipeline as a browser upload. The acknowledgement waits for that reading — see
 * `email.receiptsSummary`.
 *
 * **The model never sees the receipt, and neither does this handler.** It stores the bytes and
 * enqueues extraction; the merchant, date, amount and tax come from the pipeline that already
 * knows about categories and ITC rates.
 *
 * BEST-EFFORT BY DESIGN, like the extraction handlers: business failures return rather than
 * throw. BullMQ would retry a throw, and a retry here means a second expense report for one
 * email — the failure mode this whole path is arranged to avoid. Only an infrastructure fault
 * worth retrying is allowed to propagate.
 *
 * The route has already verified the SNS signature, pinned the topic, checked the SES
 * authentication verdicts, tied the From to the domain that authenticated, and claimed the
 * message id. It hands the authenticated From over as `claimant`; the one thing this handler
 * re-checks is that the MIME it parses is from that same address, so the identity decision
 * is made once at the gate and cannot be re-derived here from headers an outsider wrote.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/ingest-receipt-email.ts` (550b2945), Wave 3
 * (w3-06). VeloExpense, each marked below:
 *   · it runs as the tenant the email was addressed to (d47; `inTenant`, worker/src/main.ts),
 *     so the sender is found among that tenant's people only, and everything it writes is
 *     that tenant's, through RLS;
 *   · every email starts a new report: adding to one by replying (`receipts+<token>@`) needs
 *     reply threads (w5-01, d48), so the acknowledgement is sent from the ordinary address;
 *   · a report's number comes from the tenant's sequence (`nextReportNumber`), and the plan's
 *     yearly expense cap is checked on the same transaction, as the browser's paths do;
 *   · a receipt is written STORED with its size, under the tenant's key prefix, and its
 *     extraction jobs name the tenant;
 *   · a person has one display name, no role relation (the audit row reads the role itself)
 *     and no language preference, so the acknowledgement is in English;
 *   · no NetSuite: the business unit source is ExpenseOS's EXPENSEOS position.
 */

/** The ReplyThread `subjectType` for a receipts thread.
 *
 *  A distinct value from the comment thread's `EXPENSE_REPORT`, which is what keeps the two
 *  tokens apart: the table is unique on (recipientId, subjectType, subjectId) and the token is
 *  an HMAC over the ROW id, so a receipts thread gets its own address and a `reply+` token can
 *  never be spent here. */
export const RECEIPTS_SUBJECT_TYPE = 'EXPENSE_REPORT_RECEIPTS';
// VeloExpense: kept for w5-01, which brings the thread table it names (d48).

/** Attachments accepted from one email. Beyond this somebody is forwarding a mailbox, not
 *  filing an expense claim. */
const MAX_ATTACHMENTS = 20;

/** Larger than this and the file was not going to extract anyway (the browser path caps the
 *  same way). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Images below this are signature logos, tracking pixels and social icons.
 *
 * Without this floor every corporate footer becomes an expense: a 4KB PNG of a company logo,
 * filed as a receipt, extracted as a merchant, sitting on a claim someone has to delete. PDFs
 * are exempt — a small PDF is a real receipt.
 */
const MIN_IMAGE_BYTES = 10 * 1024;

/** More than this many files at once takes the cheaper async Batch API, mirroring
 *  `expenses.startExtraction`. */
const BATCH_THRESHOLD_FILES = 5;

// VeloExpense: ExpenseOS's `EDITABLE` (DRAFT, RETURNED — a report accepts new expenses only
// while its submitter can still edit it) is read only by the threaded path, so it returns
// with it (w5-01).

const MAX_TITLE = 200;
const MAX_PURPOSE = 2000;

/** The audit actor for everything this handler writes: the person who sent the email. */
type AuditUser = { kind: 'user'; id: string; name: string; roleLabel: string };

export async function handleIngestReceiptEmail(
  data: JobMap['email.ingestReceipts'],
): Promise<void> {
  const raw = await readMessage(data.bucket, data.objectKey);
  if (!raw) return;

  const parsed = await simpleParser(raw);

  // A machine sent this: an out-of-office responder, a bounce, a mailing list. Stop dead.
  //
  // Both halves of that matter. Processing it is wrong because a bounce quotes the ORIGINAL
  // message, attachments included, so filing from one would duplicate a report that already
  // exists. Replying to it is worse: our acknowledgement goes to the sender, whose responder
  // answers `receipts+<token>@`, which we ingest and acknowledge again — two robots emailing
  // each other until somebody notices.
  if (isAutoSubmitted(parsed)) {
    console.info(
      `[email.ingestReceipts] ignoring an auto-submitted message (${data.sesMessageId})`,
    );
    return;
  }

  // The sender IS the claimant — and "the sender" is the address the route authenticated,
  // not whatever this parse of the headers says. The two are the same header of the same
  // message, so they agree for every genuine email; they disagree when the message carries
  // more than one From, when SES and mailparser read a malformed header differently, or when
  // a job was enqueued by something other than the route. All of those are refused, and
  // nothing is written or sent: replying would mean emailing whoever a forger named.
  const fromAddr = soleAddress(parsed.from);
  const claimant = data.claimant?.trim().toLowerCase() || null;
  if (!fromAddr || !claimant || fromAddr !== claimant) {
    console.warn(
      `[email.ingestReceipts] refusing ${data.sesMessageId}: From ${fromAddr ?? '(none)'} ` +
        `is not the authenticated sender ${claimant ?? '(none)'}`,
    );
    return;
  }

  // An address we do not know gets one reply telling it so, which is safe because the route
  // only reaches here for mail whose From is tied to the domain that authenticated.
  // VeloExpense: among the tenant's people only — the job runs as the tenant the address
  // named (d47) — and not a deactivated one, who could not file in the browser either.
  const user = await db.user.findFirst({
    where: {
      email: { equals: fromAddr, mode: 'insensitive' },
      deletedAt: null,
      employeeStatus: { not: 'DEACTIVATED' },
    },
    // VeloExpense: one display name; no role relation and no language preference.
    select: { id: true, email: true, name: true },
  });
  const locale = localeOf(null);
  const strings = await receiptStrings(locale);
  const threadHeaders = {
    ...(parsed.messageId ? { inReplyTo: parsed.messageId, references: parsed.messageId } : {}),
  };

  if (!user) {
    await reply(
      fromAddr,
      strings.noAccountSubject,
      strings.noAccountBody,
      undefined,
      threadHeaders,
    );
    return;
  }

  const actor = {
    kind: 'user' as const,
    id: user.id,
    // VeloExpense: one display name, which `displayName` reads as the first.
    name: displayName({ firstName: user.name, lastName: null, email: user.email }),
    // VeloExpense: the audit row reads the member's role from their row (packages/audit).
    roleLabel: '',
  };

  const attachments = usableAttachments(parsed.attachments ?? []);
  if (attachments.length === 0) {
    await reply(
      fromAddr,
      strings.noReceiptsSubject,
      strings.noReceiptsBody,
      undefined,
      threadHeaders,
    );
    return;
  }

  const title = (parsed.subject?.trim() || strings.untitled).slice(0, MAX_TITLE);
  // `stripQuotedReply` cuts the signature delimiter, quoted history and "On … wrote:"
  // attributions; what is left is what the person actually typed this time.
  const purpose = stripSignature(parsed.text ?? '').slice(0, MAX_PURPOSE) || null;

  // VeloExpense: every email starts a new report until reply threads arrive (w5-01, d48);
  // `data.token` is carried but not read.
  const target = { kind: 'new' } as Target;

  if (target.kind === 'refused') {
    await reply(
      fromAddr,
      strings.notEditableSubject,
      strings.notEditableBody,
      undefined,
      threadHeaders,
    );
    return;
  }

  let filed: Filed | null;
  try {
    filed =
      target.kind === 'existing'
        ? await addToReport(target, actor, attachments, purpose)
        : await createReport(actor, title, purpose, attachments);
  } catch (err) {
    // VeloExpense: the plan's yearly expense cap, checked as the browser's paths check it.
    // Business, not infrastructure: say so once, and do not let BullMQ retry it.
    if (err instanceof CapReachedError) {
      await reply(fromAddr, strings.capReachedSubject, strings.capReachedBody, undefined, threadHeaders);
      return;
    }
    throw err;
  }
  if (!filed) return;

  const stored = await storeAttachments(filed.reportId, filed.expenseIds, attachments, actor);
  if (stored.length > 0) await startExtraction(stored);

  // VeloExpense: sent from the ordinary address — no threaded reply address until w5-01.
  const replyAddress = undefined as string | undefined;
  // The acknowledgement waits for the reading: until then the total is 0.00 and there is no
  // approver to name. If the summary cannot even be queued, the plain line goes out now —
  // a person who emailed receipts must hear back either way.
  try {
    await enqueue(
      'email.receiptsSummary',
      {
        reportId: filed.reportId,
        receiptIds: stored,
        userId: user.id,
        to: fromAddr,
        ...(replyAddress ? { replyAddress } : {}),
        ...threadHeaders,
        sesMessageId: data.sesMessageId,
        attempt: 0,
        waitUntil: Date.now() + SUMMARY_MAX_WAIT_MS,
        // VeloExpense: the summary runs as the tenant the receipts were filed in.
        organizationId: data.organizationId,
      },
      { jobId: summaryJobId(data.sesMessageId, 0), delayMs: SUMMARY_FIRST_DELAY_MS },
    );
  } catch (err) {
    console.warn('[email.ingestReceipts] summary enqueue failed; acknowledging now:', err);
    await reply(
      fromAddr,
      strings.filedSubject(filed.number, title),
      strings.filedBody(stored.length, filed.number),
      replyAddress,
      threadHeaders,
    );
  }
}

/**
 * Read the raw MIME SES stored, never more than {@link INBOUND_MAIL_CAP_BYTES} (40 MiB).
 *
 * Through the storage client's bounded server-side read (`guardedRead`): HEAD first, then a
 * read that stops at the cap + 1 whatever HEAD said. The cap is the whole raw message, not
 * one attachment (`MAX_ATTACHMENT_BYTES` filters the parsed parts later), and it is the
 * inbound-mail cap, not the 25 MiB upload ceiling: SES writes this object, nobody uploads it.
 *
 * Two kinds of failure, kept apart:
 *   - business (a foreign bucket, a `..` key, a missing object, a message over the cap):
 *     warn and return null. Permanent for this object, so a retry would be futile.
 *   - infrastructure (HEAD or the read THROWS): rethrow, so BullMQ retries.
 */
async function readMessage(bucket: string, objectKey: string): Promise<Buffer | null> {
  const configured = process.env.S3_INBOUND_MAIL_BUCKET?.trim();
  // The notification is signature-verified, but the bucket it names still has to be the one
  // we configured — a rule pointed somewhere else is a misconfiguration, not an input.
  if (configured && bucket && bucket !== configured) {
    console.warn(`[email.ingestReceipts] refusing a message from an unexpected bucket: ${bucket}`);
    return null;
  }
  if (objectKey.includes('..')) return null;
  try {
    const got = await guardedRead(getInboundMailStorage(), objectKey, INBOUND_MAIL_CAP_BYTES);
    if (!got.ok) {
      console.warn(
        `[email.ingestReceipts] could not read ${objectKey}: ${refusedMessageReason(got)}`,
      );
      return null;
    }
    // A view over the bytes already read, not a second copy of up to 40 MiB.
    return Buffer.from(got.data.buffer, got.data.byteOffset, got.data.byteLength);
  } catch (err) {
    // Infrastructure, not business: let BullMQ retry this one.
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Why the raw message was not read, for the worker log. Built only from the numbers: never a
 * URL, a bucket name or a response body. A missing object never says "too large".
 */
function refusedMessageReason(got: Exclude<BoundedRead, { ok: true }>): string {
  if (got.reason === 'missing') return 'object not found';
  return got.size === undefined
    ? `message too large: more than the ${INBOUND_MAIL_CAP_BYTES}-byte limit`
    : `message too large: ${got.size} bytes, over the ${INBOUND_MAIL_CAP_BYTES}-byte limit`;
}

/**
 * Which attachments are receipts.
 *
 * The filters exist because an email is not an upload dialog. `related` parts are the images a
 * signature references by cid; `inline` disposition is the same story told differently; and a
 * tiny image is a logo. Everything surviving is a file somebody deliberately attached in a
 * format the pipeline can read.
 */
export function usableAttachments(attachments: readonly Attachment[]): Attachment[] {
  const out: Attachment[] = [];
  for (const a of attachments) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const contentType = (a.contentType ?? '').toLowerCase();
    if (!isReceiptContentType(contentType)) continue;
    if (a.related) continue;
    if ((a.contentDisposition ?? '').toLowerCase() === 'inline') continue;
    const size = a.size ?? a.content?.length ?? 0;
    if (size <= 0 || size > MAX_ATTACHMENT_BYTES) continue;
    if (contentType !== 'application/pdf' && size < MIN_IMAGE_BYTES) continue;
    out.push(a);
  }
  return out;
}

type Target =
  | { kind: 'new' }
  | { kind: 'existing'; reportId: string; currencyId: string }
  | { kind: 'refused' };

// VeloExpense: ExpenseOS's `resolveThreadedReport` (the report a `receipts+<token>@` reply
// belongs to: a RECEIPTS thread, the sender's own report, still editable) returns with reply
// threads (w5-01, d48). `addToReport` below is what it hands to, kept for it.

interface Filed {
  reportId: string;
  number: string;
  expenseIds: string[];
}

async function createReport(
  actor: AuditUser,
  title: string,
  purpose: string | null,
  attachments: readonly Attachment[],
): Promise<Filed | null> {
  const userId = actor.id;
  const currencyId = await resolveIntakeCurrencyId(db as never, { userId });
  if (!currencyId) {
    console.warn('[email.ingestReceipts] no currency could be resolved; nothing created');
    return null;
  }
  // Coded to the filer, exactly as a browser upload is — an emailed receipt is the same
  // claim by the same person, and arriving by a different door must not code it differently.
  const { coding, businessUnitSource } = await codingOf(userId);
  const report = await withAudit(
    db,
    {
      action: auditActions.report.create,
      entityType: 'ExpenseReport',
      actor,
      // `via: email` is what distinguishes this from a browser upload in the audit log, and
      // it is inside the hash payload's details — it cannot be stripped later.
      details: { via: 'email', receipts: attachments.length },
    },
    async (tx) => {
      // VeloExpense: the plan's yearly cap, on this transaction, before anything is written.
      await assertExpenseAllowance(queryRunnerOf(tx), attachments.length);
      // VeloExpense: numbered from the tenant's own sequence.
      const number = await nextReportNumber(tx);
      if (!number) throw new Error('email.ingestReceipts: no tenant scope');
      return createReportFromReceipts(tx, {
        number,
        submitterId: userId,
        title,
        currencyId,
        count: attachments.length,
        purpose,
        explanation: purpose,
        coding,
        businessUnitSource,
      });
    },
    (created) => created.id,
  );
  return { reportId: report.id, number: report.number, expenseIds: report.expenseIds };
}

/**
 * The filer's own department / BU / class for the expenses about to be created, resolved
 * for the business unit source on the stored NetSuite config (no config → `EXPENSEOS`),
 * the same way the browser paths resolve it. `codingDefaultsFor` owns the rule.
 */
async function codingOf(userId: string) {
  // VeloExpense: no NetSuite config to read — always ExpenseOS's EXPENSEOS position, as the
  // browser's paths (`filerCodingOf`, server/routers/expenses.ts).
  const businessUnitSource: BusinessUnitSource = 'EXPENSEOS';
  // VeloExpense: a person carries a business unit and a department (no class, no NetSuite
  // business unit).
  const filer = await db.user.findUnique({
    where: { id: userId },
    select: { businessUnitId: true, departmentId: true },
  });
  return {
    coding: await codingDefaultsFor(db as never, filer, businessUnitSource),
    businessUnitSource,
  };
}

async function addToReport(
  target: { reportId: string; currencyId: string },
  actor: AuditUser,
  attachments: readonly Attachment[],
  purpose: string | null,
): Promise<Filed | null> {
  const userId = actor.id;
  const { coding, businessUnitSource } = await codingOf(userId);
  const expenseIds = await withAudit(
    db,
    {
      action: auditActions.report.update,
      entityType: 'ExpenseReport',
      entityId: target.reportId,
      actor,
      details: { via: 'email', receipts: attachments.length },
    },
    async (tx) => {
      // VeloExpense: the plan's yearly cap, as for a new report.
      await assertExpenseAllowance(queryRunnerOf(tx), attachments.length);
      return createBlankExpensesForReceipts(tx, {
        reportId: target.reportId,
        ownerId: userId,
        currencyId: target.currencyId,
        count: attachments.length,
        purpose,
        explanation: purpose,
        coding,
        businessUnitSource,
      });
    },
  );
  const report = await db.expenseReport.findUnique({
    where: { id: target.reportId },
    select: { number: true },
  });
  return { reportId: target.reportId, number: report?.number ?? '', expenseIds };
}

/**
 * Write each attachment and file a Receipt row against its expense.
 *
 * Into the RECEIPTS bucket, under the report's prefix, exactly where a browser upload lands —
 * so GuardDuty scans it and `extract-core` reads the scan tag before showing it to a model.
 * Email is the least trustworthy input the product has and it goes through the same gate
 * rather than around it.
 *
 * One failure does not abandon the rest: the expenses exist either way, and an expense whose
 * receipt did not land is visible and re-uploadable in the workbench.
 */
async function storeAttachments(
  reportId: string,
  expenseIds: readonly string[],
  attachments: readonly Attachment[],
  actor: AuditUser,
): Promise<string[]> {
  const uploadedById = actor.id;
  const receiptIds: string[] = [];
  // VeloExpense: keys sit under the tenant's prefix (`receiptKey`).
  const organizationId = currentTenantId();
  if (!organizationId) throw new Error('email.ingestReceipts: no tenant scope');
  for (const [i, attachment] of attachments.entries()) {
    const expenseId = expenseIds[i];
    if (!expenseId) break;
    const filename = attachment.filename?.trim() || `receipt-${i + 1}`;
    const contentType = (attachment.contentType ?? '').toLowerCase();
    try {
      const key = receiptKey(organizationId, reportId, receiptExtension(filename));
      await getStorage().put({ key, body: attachment.content, contentType });
      const created = await withAudit(
        db,
        {
          action: auditActions.report.receiptAttach,
          entityType: 'Expense',
          entityId: expenseId,
          actor,
          details: { filename, via: 'email' },
        },
        (tx) =>
          tx.receipt.create({
            data: {
              expenseId,
              s3Key: key,
              filename: filename.slice(0, 255),
              contentType,
              sizeBytes: attachment.content.length,
              // VeloExpense: written after the object is, so it is stored (d29).
              status: 'STORED',
              uploadedById,
            },
            select: { id: true },
          }),
      );
      receiptIds.push(created.id);
    } catch (err) {
      console.warn(`[email.ingestReceipts] could not file ${filename}:`, err);
    }
  }
  return receiptIds;
}

/** Kick off extraction for the batch, best-effort — the files stand either way. */
async function startExtraction(receiptIds: readonly string[]): Promise<void> {
  try {
    // VeloExpense: every receipt job names its tenant.
    const organizationId = currentTenantId();
    if (!organizationId) throw new Error('no tenant scope');
    if (receiptIds.length > BATCH_THRESHOLD_FILES) {
      await enqueue('expense.extractReceipt.batch', {
        organizationId,
        receiptIds: [...receiptIds],
      });
    } else {
      await Promise.all(
        receiptIds.map((receiptId) =>
          enqueue('expense.extractReceipt', { organizationId, receiptId }),
        ),
      );
    }
  } catch (err) {
    console.warn('[email.ingestReceipts] extraction enqueue failed:', err);
  }
}

// VeloExpense: ExpenseOS's `receiptsReplyAddress` (the `receipts+<token>@` address an
// acknowledgement is sent from, so a reply lands back on its report) returns with reply
// threads (w5-01, d48).

/** Send one acknowledgement. Never throws: the report is already filed, and a bounced
 *  acknowledgement must not look like a failed submission. */
async function reply(
  to: string,
  subject: string,
  body: string,
  from: string | undefined,
  headers: { inReplyTo?: string; references?: string },
): Promise<void> {
  try {
    await sendEmail({
      to,
      subject,
      text: body,
      html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
      ...(from ? { from, replyTo: from } : {}),
      ...headers,
      // RFC 3834: tell other responders this is a machine reply, so they do not answer it.
      // The other half of the loop guard — `isAutoSubmitted` is what stops us answering them.
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  } catch (err) {
    console.warn('[email.ingestReceipts] acknowledgement failed:', err);
  }
}

/**
 * Was this message generated by a machine?
 *
 * `Auto-Submitted` (RFC 3834) is the header that is supposed to answer this, and modern
 * responders set it — but plenty of older ones only set `Precedence`, and a bounce identifies
 * itself by its sender or an empty return path instead. All four are checked because missing
 * one costs a mail loop, and the cost of a false positive is one email that has to be resent
 * by hand.
 */
export function isAutoSubmitted(parsed: {
  headers?: Map<string, unknown>;
  from?: AddressObject | AddressObject[];
}): boolean {
  const header = (name: string): string => {
    const raw = parsed.headers?.get(name);
    if (typeof raw === 'string') return raw.toLowerCase();
    // mailparser hands structured headers back as objects; `value` carries the text.
    if (raw && typeof raw === 'object' && 'value' in raw) {
      const value = (raw as { value?: unknown }).value;
      if (typeof value === 'string') return value.toLowerCase();
    }
    return '';
  };

  const autoSubmitted = header('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;

  const precedence = header('precedence');
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return true;

  if (header('x-autoreply') || header('x-autorespond') || header('x-auto-response-suppress')) {
    return true;
  }

  // A bounce: `MAILER-DAEMON`/`postmaster`, or the empty return path they are sent with.
  const from = soleAddress(parsed.from);
  if (from && /^(mailer-daemon|postmaster|no-?reply|bounce)[@+]/.test(from)) return true;
  const returnPath = header('return-path');
  if (returnPath === '<>') return true;

  return false;
}

/**
 * The one address in the From header, lowercased — or null when there is not exactly one.
 *
 * Exactly one, not the first: a message from two people is from nobody in particular, and
 * "first" is the kind of choice two parsers make differently, which is the gap an attacker
 * would put a second From into.
 */
function soleAddress(from: AddressObject | AddressObject[] | undefined): string | null {
  const list = Array.isArray(from) ? from : from ? [from] : [];
  const addresses: string[] = [];
  for (const obj of list) {
    for (const a of obj.value ?? []) {
      const addr = a.address?.trim().toLowerCase();
      if (addr) addresses.push(addr);
    }
  }
  return addresses.length === 1 ? addresses[0] : null;
}

// VeloExpense: no `roleLabelOf` — the audit row reads the member's role from their row.

function localeOf(pref: string | null | undefined): 'en' | 'fr-CA' {
  return pref === 'fr-CA' ? 'fr-CA' : 'en';
}

/**
 * Cut the signature and any quoted history.
 *
 * Mirrors `stripQuotedReply` in the web app (the same heuristics: `-- `, a quoted block, an
 * attribution line, the Outlook divider) and adds the mobile footers it does not know about.
 * Duplicated rather than shared because that helper lives in apps/web, which the worker
 * cannot import.
 */
export function stripSignature(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const attribution = /^\s*(On .+wrote:|Le .+a écrit\s*:|.*<[^>]+@[^>]+>.*:)\s*$/;
  const mobile = /^\s*(Sent from my |Envoyé de mon |Get Outlook for )/i;
  for (const line of lines) {
    if (attribution.test(line)) break;
    if (/^\s*>/.test(line)) break;
    if (/^--\s*$/.test(line)) break;
    if (/^_{5,}$/.test(line)) break;
    if (mobile.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

interface ReceiptStrings {
  untitled: string;
  filedSubject: (number: string, title: string) => string;
  filedBody: (count: number, number: string) => string;
  noAccountSubject: string;
  noAccountBody: string;
  noReceiptsSubject: string;
  noReceiptsBody: string;
  notEditableSubject: string;
  notEditableBody: string;
  /** VeloExpense: the plan's yearly expense cap was reached. */
  capReachedSubject: string;
  capReachedBody: string;
}

/** Copy for the acknowledgements, in the claimant's language. */
async function receiptStrings(locale: 'en' | 'fr-CA'): Promise<ReceiptStrings> {
  // VeloExpense: the catalogue straight from @expenseos/i18n (ExpenseOS's `catalogFor` wraps
  // the same loader with a cache).
  const cat = await loadCatalog(locale);
  const s = (cat.notifications as { receiptsEmail?: Record<string, string> } | undefined)
    ?.receiptsEmail;
  const fill = (template: string | undefined, vars: Record<string, string>, fallback: string) => {
    let out = template ?? fallback;
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
    return out;
  };
  return {
    untitled: s?.untitled ?? 'Emailed receipts',
    filedSubject: (number, title) =>
      fill(s?.filedSubject, { number, title }, `${number}: ${title}`),
    filedBody: (count, number) =>
      fill(
        s?.filedBody,
        { count: String(count), number },
        // VeloExpense: no "reply to add more" until reply threads (w5-01, d48).
        `${count} receipt(s) filed on ${number}. VeloExpense is reading them now — the merchant, date, amount and tax will fill in shortly.`,
      ),
    noAccountSubject: s?.noAccountSubject ?? 'No VeloExpense account for this address',
    noAccountBody:
      s?.noAccountBody ??
      'This address does not have a VeloExpense account, so the receipts could not be filed. Send from the address you sign in with.',
    noReceiptsSubject: s?.noReceiptsSubject ?? 'No receipts found',
    noReceiptsBody:
      s?.noReceiptsBody ??
      'No receipt was attached, so nothing was created. Attach a photo or a PDF and send it again.',
    notEditableSubject: s?.notEditableSubject ?? 'That report can no longer be changed',
    notEditableBody:
      s?.notEditableBody ??
      'That expense report has been submitted, so receipts cannot be added to it. Recall it in VeloExpense first, or send a new email to start another report.',
    capReachedSubject: s?.capReachedSubject ?? 'Your plan’s expense limit has been reached',
    capReachedBody:
      s?.capReachedBody ??
      'Your organization has added as many expenses this year as its plan allows, so these receipts could not be filed. Ask an administrator about the plan.',
  };
}
