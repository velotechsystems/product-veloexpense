// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `email.receiptsSummary` handler — the acknowledgement for a receipts email, sent once
 * the receipts are read.
 *
 * What is pinned here is what made the old one-line reply useless and what this one must
 * therefore never do: speak before the reading is done (a 0.00 total, no approver), wait
 * forever on a receipt that will not finish, or name an approver it had to guess.
 *
 * The database, the queue, the mailer and the approval preview are doubles. The catalog,
 * the money formatter, the "still being read" rule and the email layout are real, so the
 * assertions read the words a person would actually receive.
 *
 * VeloExpense: ExpenseOS's test (#567). The doubles are VeloExpense's modules — the tenant's
 * `db`, the mailer and tenant origin (`@/lib/notifications/email`), the branding read and
 * the pg bridge — and the layout is VeloExpense's port, in its branded shell. One display
 * name per person, and no language preference: see the cases marked "VeloExpense:".
 */

const h = vi.hoisted(() => ({
  db: {
    documentExtraction: { findMany: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    expenseReport: { findUnique: vi.fn() },
    receipt: { findMany: vi.fn() },
  },
  enqueue: vi.fn(),
  sendEmail: vi.fn(),
  previewStart: vi.fn(),
}));

vi.mock('@expenseos/db', async () => {
  // The real rule, from its own module: importing the package root would build a client.
  const progress = await import('../../../packages/db/src/extractionProgress');
  return {
    classifyExtraction: progress.classifyExtraction,
    summarizeExtractionProgress: progress.summarizeExtractionProgress,
  };
});
vi.mock('@expenseos/jobs', () => ({ enqueue: h.enqueue }));
vi.mock('@expenseos/approvals/engine', () => ({ previewStart: h.previewStart }));
// VeloExpense: the tenant's client, whose transaction the branding read runs in.
vi.mock('@/lib/db/prisma', () => ({
  db: { ...h.db, $transaction: (fn: (tx: unknown) => unknown) => fn({}) },
}));
vi.mock('@/lib/db/prisma-pg-bridge', () => ({
  queryRunnerOf: () => ({ query: async () => ({ rows: [{ slug: 'northwind' }] }) }),
}));
vi.mock('@/lib/branding/service', () => ({
  getBranding: async () => ({ name: 'Northwind Example', brandColor: null }),
}));
// VeloExpense: the mailer, and the tenant's own origin (ExpenseOS: `deepLink`).
vi.mock('@/lib/notifications/email', () => ({
  sendEmail: h.sendEmail,
  originForTenant: (slug: string) => `https://${slug}.app.test`,
}));

import {
  handleReceiptsSummaryEmail,
  SUMMARY_RECHECK_MS,
  summaryJobId,
} from './receipts-summary-email';

const NOW = new Date('2026-10-08T18:00:00Z');

const JOB = {
  // VeloExpense: the tenant, which the job runs as.
  organizationId: 'org-1',
  reportId: 'r1',
  receiptIds: ['rc1', 'rc2'],
  userId: 'u1',
  to: 'alex@e.inc',
  replyAddress: 'receipts-dev+tok@e.inc',
  inReplyTo: '<orig@mail.test>',
  references: '<orig@mail.test>',
  sesMessageId: 'ses-1',
  attempt: 0,
  waitUntil: NOW.getTime() + 60_000,
};

type Row = {
  receiptId: string;
  scanStatus: string;
  status: string;
  error: string | null;
  updatedAt: Date;
};
const extracted = (receiptId: string): Row => ({
  receiptId,
  scanStatus: 'CLEAN',
  status: 'EXTRACTED',
  error: null,
  updatedAt: NOW,
});
const extracting = (receiptId: string): Row => ({ ...extracted(receiptId), status: 'EXTRACTING' });
const failed = (receiptId: string): Row => ({
  ...extracted(receiptId),
  status: 'FAILED',
  error: 'unreadable',
});

/** The receipts as the summary reads them, each with its expense. */
function receiptsFor(rows: Row[]) {
  return rows.map((r, i) => ({
    filename: `receipt-${i + 1}.jpg`,
    extraction: r,
    expense: {
      merchant: i === 0 ? 'Acme Bistro' : 'City Taxi',
      amountMinor: i === 0 ? 8_450n : 2_300n,
      explanation: 'Client dinner with Acme.',
      currency: { code: 'CAD' },
    },
  }));
}

function serve(rows: Row[], locale = 'en') {
  h.db.documentExtraction.findMany.mockResolvedValue(rows);
  h.db.receipt.findMany.mockResolvedValue(receiptsFor(rows));
  void locale;
  // VeloExpense: one display name, and no language preference.
  h.db.user.findUnique.mockResolvedValue({ name: 'Alex Doe', email: 'alex@e.inc' });
}

/** The plain-text part of the one email sent. */
const sentText = () => (h.sendEmail.mock.calls[0]?.[0] as { text: string }).text;

beforeEach(() => {
  vi.clearAllMocks();
  h.db.expenseReport.findUnique.mockResolvedValue({
    number: 'EXP-005814',
    title: 'Toronto client dinner',
    status: 'DRAFT',
    totalMinor: 10_750n,
    currency: { code: 'CAD' },
  });
  h.previewStart.mockResolvedValue({ status: 'RUNNING', assigneeIds: ['m1'] });
  h.db.user.findMany.mockResolvedValue([
    // VeloExpense: one display name.
    { id: 'm1', name: 'Jordan Lee', email: 'jordan@e.inc' },
  ]);
});

describe('waiting for the reading', () => {
  it('checks again later, sending nothing, while a receipt is still being read', async () => {
    serve([extracted('rc1'), extracting('rc2')]);

    await handleReceiptsSummaryEmail(JOB, NOW);

    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(
      'email.receiptsSummary',
      { ...JOB, attempt: 1 },
      { jobId: summaryJobId('ses-1', 1), delayMs: SUMMARY_RECHECK_MS },
    );
  });

  it('counts a receipt whose reading has not started as still being read', async () => {
    // The extraction row appears when its job starts; until then there is nothing to read.
    serve([extracted('rc1')]);

    await handleReceiptsSummaryEmail(JOB, NOW);

    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('sends anyway once the wait is over, saying what was not read in time', async () => {
    serve([extracted('rc1'), extracting('rc2')]);

    await handleReceiptsSummaryEmail({ ...JOB, waitUntil: NOW.getTime() - 1 }, NOW);

    expect(h.enqueue).not.toHaveBeenCalled();
    const text = sentText();
    expect(text).toContain('1 still being read');
    expect(text).toContain('City Taxi — still being read');
    expect(text).toContain('2 filed · 1 read');
  });

  it('builds job ids BullMQ accepts — no colon in a custom id', () => {
    expect(summaryJobId('0100018f-abc', 3)).toBe('receipts-summary-0100018f-abc-3');
    expect(summaryJobId('0100018f-abc', 3)).not.toContain(':');
  });
});

describe('the summary', () => {
  it('lays the report out like a card request: facts, total, approver, one button', async () => {
    serve([extracted('rc1'), extracted('rc2')]);

    await handleReceiptsSummaryEmail(JOB, NOW);

    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const mail = h.sendEmail.mock.calls[0]?.[0];
    expect(mail).toMatchObject({
      to: 'alex@e.inc',
      subject: 'EXP-005814: Toronto client dinner',
      // From and Reply-To the threaded address, so a reply adds to this report.
      from: 'receipts-dev+tok@e.inc',
      replyTo: 'receipts-dev+tok@e.inc',
      inReplyTo: '<orig@mail.test>',
      references: '<orig@mail.test>',
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    const text = sentText();
    // VeloExpense: the display name (ExpenseOS: the first name, "Hello Alex!").
    expect(text).toContain('Hello Alex Doe!');
    expect(text).toContain('2 receipt(s) from your email are filed on report EXP-005814.');
    expect(text).toContain('VeloExpense has read them.');
    expect(text).toContain('Acme Bistro — $84.50');
    expect(text).toContain('City Taxi — $23.00');
    expect(text).toContain('EXP-005814 — Toronto client dinner');
    expect(text).toContain('Draft');
    expect(text).toContain('$107.50');
    expect(text).toContain('Jordan Lee (confirmed when you submit)');
    expect(text).toContain('Client dinner with Acme.');
    // VeloExpense: the tenant's own origin and the report's page.
    expect(text).toContain('https://northwind.app.test/expenses/r1');
    expect(text).toContain('Reply to this email to add more receipts to the same report.');
    // The real layout rendered it, button and all.
    expect(mail.html).toContain('Open report');
    expect(mail.html).toContain('https://northwind.app.test/expenses/r1');
    // VeloExpense: inside the tenant's branded shell.
    expect(mail.html).toContain('Northwind Example');
  });

  it('tells the reader which receipts could not be read', async () => {
    serve([extracted('rc1'), failed('rc2')]);

    await handleReceiptsSummaryEmail(JOB, NOW);

    const text = sentText();
    expect(text).toContain('1 could not be read; open the report and enter their details by hand.');
    expect(text).toContain('City Taxi — could not be read');
    expect(text).not.toContain('VeloExpense has read them.');
  });

  it('says no approval is needed when nothing would govern the report', async () => {
    h.previewStart.mockResolvedValue({ status: 'NO_WORKFLOW', assigneeIds: [] });
    serve([extracted('rc1'), extracted('rc2')]);

    await handleReceiptsSummaryEmail(JOB, NOW);

    expect(sentText()).toContain('None needed — approved automatically when you submit');
  });

  it('describes an unassigned pool instead of naming somebody', async () => {
    h.previewStart.mockResolvedValue({ status: 'RUNNING', assigneeIds: [null] });
    serve([extracted('rc1'), extracted('rc2')]);

    await handleReceiptsSummaryEmail(JOB, NOW);

    expect(sentText()).toContain('an eligible approver, assigned when you submit');
  });

  it('leaves the approver out rather than guess when the preview fails', async () => {
    h.previewStart.mockRejectedValue(new Error('no subject'));
    serve([extracted('rc1'), extracted('rc2')]);

    await handleReceiptsSummaryEmail(JOB, NOW);

    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(sentText()).not.toContain('Approver');
  });

  // VeloExpense: skipped — VeloExpense keeps no language preference per person (French is
  // off), so the summary is English, as the ingest acknowledgement is.
  it.skip('writes in the reader’s language', async () => {
    serve([extracted('rc1'), extracted('rc2')], 'fr-CA');

    await handleReceiptsSummaryEmail(JOB, NOW);

    const text = sentText();
    expect(text).toContain('Bonjour Alex!');
    expect(text).toContain(
      '2 reçu(s) de votre courriel ont été classé(s) sur la note de frais EXP-005814.',
    );
    expect(text).toContain('Brouillon');
    expect(text).toContain('https://app.test/fr-CA/expenses?report=r1');
  });

  it('sends nothing when the report is gone', async () => {
    serve([extracted('rc1'), extracted('rc2')]);
    h.db.expenseReport.findUnique.mockResolvedValue(null);

    await handleReceiptsSummaryEmail(JOB, NOW);

    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('does not throw when the mailer does: the receipts are filed either way', async () => {
    serve([extracted('rc1'), extracted('rc2')]);
    h.sendEmail.mockRejectedValue(new Error('smtp down'));

    await expect(handleReceiptsSummaryEmail(JOB, NOW)).resolves.toBeUndefined();
  });
});
