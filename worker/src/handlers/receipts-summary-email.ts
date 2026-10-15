import { previewStart } from '@expenseos/approvals/engine';
import {
  classifyExtraction,
  type DocExtractStatus,
  type DocScanStatus,
  summarizeExtractionProgress,
} from '@expenseos/db';
import type { Catalog, Locale } from '@expenseos/i18n';
import { loadCatalog } from '@expenseos/i18n/load';
import { enqueue, type JobMap } from '@expenseos/jobs';
import { formatMoney } from '@expenseos/money';
import { getBranding } from '@/lib/branding/service';
import { db } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { displayName as displayNameOf } from '@/lib/format';
import { originForTenant, sendEmail } from '@/lib/notifications/email';
import { renderEmailHtml, renderEmailText } from '@/lib/notifications/emailLayout';
import { escapeHtml } from '@/lib/notifications/html';
import { ORG } from '@/lib/tenant/sql';

/*
 * VeloExpense: ExpenseOS's `email.receiptsSummary` handler (#567, 142178894). What changed is
 * the plumbing, each marked "VeloExpense:" below:
 *   · `db` is the tenant's client (the job runs `inTenant`, worker/src/main.ts);
 *   · the layout renders inside VeloExpense's branded shell (`lib/notifications/emailLayout.ts`),
 *     so the tenant's name and colour are read for it;
 *   · the catalogue comes straight from `@expenseos/i18n` (`catalogFor` wraps the same loader);
 *   · `EMAIL_BRAND`, `emailChrome`, `BODY_P` and `displayName` are ExpenseOS's, from its
 *     `notification-dispatch.ts`, which VeloExpense does not port — carried here;
 *   · the link is the tenant's own origin, as VeloExpense's notification mail builds it;
 *   · one display name per person, and no language preference (`localePref`) to read.
 */

/**
 * The product's name in the sign-off. ExpenseOS's `EMAIL_BRAND` (notification-dispatch.ts).
 * VeloExpense: VeloExpense's name by default.
 */
export const EMAIL_BRAND = process.env.EMAIL_BRAND?.trim() || 'VeloExpense';

/** ExpenseOS's `emailChrome` (notification-dispatch.ts): `notifications.email.<key>`, with
 *  the English literal behind it. */
function emailChrome(cat: Catalog, key: string, fallback: string): string {
  const email = (cat.notifications as { email?: Record<string, string> } | undefined)?.email;
  const value = email?.[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** ExpenseOS's `BODY_P` (notification-dispatch.ts): body-paragraph style. */
const BODY_P = 'style="margin:0 0 12px;color:#111827;font-size:15px;line-height:1.55;"';

/** VeloExpense: one display name, read by `displayName` as the first. */
function displayName(u: { name: string | null; email: string }): string {
  return displayNameOf({ firstName: u.name, lastName: null, email: u.email });
}

/**
 * Handler for `email.receiptsSummary` — the acknowledgement for one receipts email, sent once
 * its receipts have been read.
 *
 * It replaced an immediate "4 receipt(s) filed on report EXP-…" line, which was sent at the
 * one moment nothing about the report was known: every amount 0.00, so the total 0.00, and so
 * no approver either — the approval route turns on the total. This waits for the reading
 * instead, then sends the report the way a card request is sent to its approver: a greeting,
 * a lead, the facts as a table, one button into the app.
 *
 * ## Waiting without a hook in extraction
 *
 * The job re-enqueues itself every {@link SUMMARY_RECHECK_MS} while any of the email's
 * receipts is still being read, and sends regardless once `waitUntil` passes, saying which
 * were not read in time. Polling a handful of rows is cheaper than teaching four extraction
 * paths (single, batch, scan re-poll, failure) to count down a shared latch, and it cannot
 * miss a path that does not exist yet.
 *
 * "Still being read" is `classifyExtraction`, the rule that holds the Submit button — so the
 * summary never states a total the submit gate would still call provisional. A receipt with
 * no extraction row yet counts as being read: the row appears when its job starts.
 *
 * ## Best-effort, like the reply it replaced
 *
 * The receipts are filed whatever happens here. A business failure (the report or the person
 * is gone) returns; the send is caught and logged. Only a failure to re-enqueue propagates,
 * so BullMQ retries rather than the summary silently never arriving.
 */

/** First look, from the ingest handler: most receipts read inside this. */
export const SUMMARY_FIRST_DELAY_MS = 20_000;
/** Between re-checks while a receipt is still being read. */
export const SUMMARY_RECHECK_MS = 20_000;
/**
 * The longest a summary waits before it goes out anyway.
 *
 * Ten minutes: a healthy single extraction takes well under one, and the malware scan's own
 * budget is about five. The Batch API path can take far longer, and its reader should not
 * hear nothing for an hour — they get the summary with those receipts marked as not read yet.
 */
export const SUMMARY_MAX_WAIT_MS = 10 * 60_000;

/** One job id per email per check. BullMQ refuses a custom id containing `:`. */
export function summaryJobId(sesMessageId: string, attempt: number): string {
  return `receipts-summary-${sesMessageId}-${attempt}`;
}

type Data = JobMap['email.receiptsSummary'];

export async function handleReceiptsSummaryEmail(data: Data, now = new Date()): Promise<void> {
  const rows = await db.documentExtraction.findMany({
    where: { receiptId: { in: data.receiptIds } },
    select: { receiptId: true, scanStatus: true, status: true, error: true, updatedAt: true },
  });
  const unstarted = data.receiptIds.length - rows.length;
  // VeloExpense: the statuses are text under a CHECK (0056), read as ExpenseOS's enum types.
  const { inFlight } = summarizeExtractionProgress(rows.map(asProgressRow), now);
  if (inFlight + unstarted > 0 && now.getTime() < data.waitUntil) {
    const attempt = data.attempt + 1;
    await enqueue(
      'email.receiptsSummary',
      { ...data, attempt },
      { jobId: summaryJobId(data.sesMessageId, attempt), delayMs: SUMMARY_RECHECK_MS },
    );
    return;
  }
  await sendSummary(data, now);
}

/** How one filed receipt stands when the summary goes out. */
type ReceiptOutcome = 'read' | 'reading' | 'unread';

/** VeloExpense: a `document_extraction` row's text statuses, as ExpenseOS's enum types. */
function asProgressRow<R extends { scanStatus: string; status: string }>(
  r: R,
): R & { scanStatus: DocScanStatus; status: DocExtractStatus } {
  return { ...r, scanStatus: r.scanStatus as DocScanStatus, status: r.status as DocExtractStatus };
}

function outcomeOf(
  extraction: {
    // VeloExpense: text columns (0056), cast in `asProgressRow`.
    scanStatus: string;
    status: string;
    error: string | null;
    updatedAt: Date;
  } | null,
  now: Date,
): ReceiptOutcome {
  if (!extraction) return 'reading';
  if (classifyExtraction(asProgressRow(extraction), now) === 'inFlight') return 'reading';
  return extraction.status === 'EXTRACTED' ? 'read' : 'unread';
}

async function sendSummary(data: Data, now: Date): Promise<void> {
  const [user, report, receipts] = await Promise.all([
    db.user.findUnique({
      where: { id: data.userId },
      // VeloExpense: one display name, and no language preference.
      select: { name: true, email: true },
    }),
    db.expenseReport.findUnique({
      where: { id: data.reportId },
      select: {
        number: true,
        title: true,
        status: true,
        totalMinor: true,
        currency: { select: { code: true } },
      },
    }),
    db.receipt.findMany({
      where: { id: { in: data.receiptIds } },
      orderBy: { id: 'asc' },
      select: {
        filename: true,
        extraction: {
          select: { scanStatus: true, status: true, error: true, updatedAt: true },
        },
        expense: {
          select: {
            merchant: true,
            amountMinor: true,
            explanation: true,
            currency: { select: { code: true } },
          },
        },
      },
    }),
  ]);
  // Deleted between the email and now: there is nothing left to describe.
  if (!user || !report) return;

  // VeloExpense: no `localePref` to read — the language the ingest acknowledgement uses.
  const locale: Locale = 'en';
  const cat = await loadCatalog(locale);
  // VeloExpense: the tenant's name and colour for the branded shell, and its own origin for
  // the link — read in one tenant transaction, as `prepareEmail` reads them.
  const { branding, slug } = await db.$transaction(async (tx) => {
    const q = queryRunnerOf(tx);
    const org = await q.query(`SELECT slug FROM organization WHERE id = ${ORG}`);
    return { branding: await getBranding(q), slug: (org.rows[0]?.slug as string | undefined) ?? '' };
  });
  const s = summaryStrings(cat);
  const money = (amountMinor: bigint, currencyCode: string) =>
    formatMoney({ amountMinor, currencyCode }, { locale });

  const lines = receipts.map((r) => ({
    label: r.expense?.merchant?.trim() || r.filename,
    outcome: outcomeOf(r.extraction, now),
    amount: r.expense ? money(r.expense.amountMinor, r.expense.currency.code) : null,
  }));
  const read = lines.filter((l) => l.outcome === 'read').length;
  const reading = lines.filter((l) => l.outcome === 'reading').length;
  const unread = lines.filter((l) => l.outcome === 'unread').length;
  // Every expense this email created carries the same note; the first one is representative.
  const note = receipts.find((r) => r.expense?.explanation)?.expense?.explanation ?? null;

  const approver = await approverLine(data.reportId, s);
  // VeloExpense: the tenant's origin, as `prepareEmail` links a report (ExpenseOS `deepLink`).
  const origin = originForTenant(slug);
  const link = origin ? `${origin}/expenses/${data.reportId}` : null;
  // VeloExpense: a report number may be unset (`expense_report.number` is nullable); a dash.
  const reportNumber = report.number ?? '—';

  const statusLabel = statusText(cat, report.status);
  const details = [
    { label: s('report', 'Report'), value: `${reportNumber} — ${report.title}` },
    { label: s('status', 'Status'), value: statusLabel },
    { label: s('total', 'Total'), value: money(report.totalMinor, report.currency.code) },
    {
      label: s('receipts', 'Receipts'),
      value: fill(s('receiptsValue', '{filed} filed · {read} read'), {
        filed: String(lines.length),
        read: String(read),
      }),
    },
    ...(approver ? [{ label: s('approver', 'Approver'), value: approver }] : []),
    ...(note ? [{ label: s('note', 'Note'), value: note }] : []),
  ];

  const greeting = emailChrome(cat, 'greeting', 'Hello {name}!').replace(
    '{name}',
    // VeloExpense: one display name (ExpenseOS: the first name).
    displayName(user),
  );
  const lead = fill(s('lead', '{count} receipt(s) from your email are filed on report {number}.'), {
    count: String(lines.length),
    number: reportNumber,
  });
  const status = [
    reading === 0 && unread === 0
      ? s(
          'allRead',
          'VeloExpense has read them. Check the details, then submit the report when you are ready.',
        )
      : '',
    reading > 0
      ? fill(
          s(
            'stillReading',
            '{count} still being read; their details will fill in on the report shortly.',
          ),
          {
            count: String(reading),
          },
        )
      : '',
    unread > 0
      ? fill(
          s(
            'couldNotRead',
            '{count} could not be read; open the report and enter their details by hand.',
          ),
          {
            count: String(unread),
          },
        )
      : '',
  ].filter(Boolean);
  const lineText = (l: (typeof lines)[number]) =>
    l.outcome === 'read'
      ? `${l.label} — ${l.amount}`
      : `${l.label} — ${l.outcome === 'reading' ? s('lineReading', 'still being read') : s('lineUnread', 'could not be read')}`;
  const expensesHeading = s('expenses', 'Expenses:');
  const infoIntro = emailChrome(cat, 'hereIsTheInformation', 'Here is the information:');

  const body = [
    greeting,
    lead,
    ...status,
    [expensesHeading, ...lines.map((l) => `• ${lineText(l)}`)].join('\n'),
    infoIntro,
  ].join('\n\n');
  const bodyHtml = [
    `<p ${BODY_P}>${escapeHtml(greeting)}</p>`,
    `<p ${BODY_P}>${escapeHtml(lead)}${status.length ? ` ${escapeHtml(status.join(' '))}` : ''}</p>`,
    `<p ${BODY_P}>${escapeHtml(expensesHeading)}</p>`,
    `<ul style="margin:0 0 12px;padding-left:20px;color:#111827;font-size:15px;line-height:1.55;">${lines
      .map((l) => `<li>${escapeHtml(lineText(l))}</li>`)
      .join('')}</ul>`,
    `<p ${BODY_P}>${escapeHtml(infoIntro)}</p>`,
  ].join('');

  const layout = {
    brand: EMAIL_BRAND,
    heading: fill(s('heading', 'Your receipts are on {number}'), { number: reportNumber }),
    body,
    bodyHtml,
    details,
    actions: link ? [{ label: s('openReport', 'Open report'), url: link, primary: true }] : [],
    closing: [
      ...(data.replyAddress
        ? [s('replyToAdd', 'Reply to this email to add more receipts to the same report.')]
        : []),
      emailChrome(cat, 'signOff', 'Thanks,'),
      emailChrome(cat, 'signature', 'The {brand} team').replace('{brand}', EMAIL_BRAND),
    ],
    footer: s(
      'footer',
      'You received this because you emailed receipts to VeloExpense from this address.',
    ),
  };

  try {
    await sendEmail({
      to: data.to,
      subject: fill(receiptsText(cat, 'filedSubject', '{number}: {title}'), {
        number: reportNumber,
        // The report's own title, not this email's subject: a reply's subject is
        // "Re: EXP-…: …", and the thread already carries it.
        title: report.title,
      }),
      text: renderEmailText(layout),
      // VeloExpense: inside the tenant's branded shell.
      html: renderEmailHtml(layout, {
        organizationName: branding.name,
        brandColor: branding.brandColor,
      }),
      ...(data.replyAddress ? { from: data.replyAddress, replyTo: data.replyAddress } : {}),
      ...(data.inReplyTo ? { inReplyTo: data.inReplyTo } : {}),
      ...(data.references ? { references: data.references } : {}),
      // RFC 3834, as the immediate reply did: a machine reply, so responders do not answer it.
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  } catch (err) {
    console.warn('[email.receiptsSummary] summary failed:', err);
  }
}

/**
 * Who would approve the report if it were submitted now, as one line — or null when the
 * preview cannot say (it threw), in which case the row is left out rather than guessed.
 */
async function approverLine(
  reportId: string,
  s: (key: string, fallback: string) => string,
): Promise<string | null> {
  try {
    const preview = await previewStart(db, 'EXPENSE_REPORT', reportId);
    if (preview.status === 'NO_WORKFLOW' || preview.status === 'APPROVED') {
      return s('approverAuto', 'None needed — approved automatically when you submit');
    }
    if (preview.status !== 'RUNNING' || preview.assigneeIds.length === 0) return null;
    const ids = [...new Set(preview.assigneeIds.filter((id): id is string => id !== null))];
    const people = ids.length
      ? await db.user.findMany({
          where: { id: { in: ids } },
          // VeloExpense: one display name.
          select: { id: true, name: true, email: true },
        })
      : [];
    const names = ids
      .map((id) => people.find((p) => p.id === id))
      .filter((p) => p !== undefined)
      .map((p) => displayName(p));
    if (preview.assigneeIds.some((id) => id === null)) {
      names.push(s('approverPool', 'an eligible approver, assigned when you submit'));
    }
    if (names.length === 0) return null;
    return fill(s('approverValue', '{names} (confirmed when you submit)'), {
      names: names.join(', '),
    });
  } catch (err) {
    console.warn('[email.receiptsSummary] approver preview failed:', err);
    return null;
  }
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

function receiptsText(cat: Catalog, key: string, fallback: string): string {
  const block = (cat.notifications as { receiptsEmail?: Record<string, unknown> } | undefined)
    ?.receiptsEmail;
  const value = block?.[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** `notifications.receiptsEmail.summary.<key>`, with the English literal behind it. */
function summaryStrings(cat: Catalog): (key: string, fallback: string) => string {
  const block = (
    cat.notifications as { receiptsEmail?: { summary?: Record<string, unknown> } } | undefined
  )?.receiptsEmail?.summary;
  return (key, fallback) => {
    const value = block?.[key];
    return typeof value === 'string' && value.trim() ? value : fallback;
  };
}

/** The report status as the reports list words it (`expenses.status.*`). */
function statusText(cat: Catalog, status: string): string {
  const block = (cat.expenses as { status?: Record<string, unknown> } | undefined)?.status;
  const value = block?.[status.toLowerCase()];
  return typeof value === 'string' && value.trim() ? value : status;
}
