// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `email.ingestReceipts` handler.
 *
 * What is worth pinning here is everything that decides WHOSE claim this becomes and WHAT
 * gets filed against it — the parts a passing deploy would not reveal:
 *
 *   · an unknown sender creates nothing;
 *   · a signature logo is not a receipt;
 *   · a token belonging to somebody else, or to a COMMENT thread, does not reach the report;
 *   · a submitted report is refused rather than quietly appended to;
 *   · a receipt whose upload failed is never registered as filed.
 *
 * Prisma, storage, the queue and the mailer are mocked; mailparser is not — the attachment
 * filtering is most of the logic and it should run against real parsed MIME.
 *
 * VeloExpense: ExpenseOS's `ingest-receipt-email.test.ts` (550b2945), Wave 3 (w3-06). The mocks
 * are VeloExpense's modules (`@/lib/db/prisma`, `@/lib/storage`, `@/lib/notifications/email`,
 * the catalogue loader, the plan cap); a person has one display name and no role relation;
 * every job names its tenant. The NetSuite coding case and the threaded-reply cases are
 * skipped, marked: there is no NetSuite here, and replying to add receipts arrives with reply
 * threads (w5-01, d48). VeloExpense's own cases close the file: the plan cap, a deactivated
 * person, the stored row and the tenant on each extraction job.
 */

const h = vi.hoisted(() => ({
  db: {
    user: { findFirst: vi.fn(), findUnique: vi.fn() },
    expenseReport: { findUnique: vi.fn() },
    receipt: { create: vi.fn() },
  },
  withAudit: vi.fn(),
  storage: {
    inboundMail: { head: vi.fn(), read: vi.fn() },
    receipts: { put: vi.fn() },
  },
  enqueue: vi.fn(),
  sendEmail: vi.fn(),
  findThreadByEmailToken: vi.fn(),
  ensureReplyThread: vi.fn(),
  issueEmailReplyToken: vi.fn(),
  createReportFromReceipts: vi.fn(),
  createBlankExpensesForReceipts: vi.fn(),
  resolveIntakeCurrencyId: vi.fn(),
  codingDefaultsFor: vi.fn(),
  loadNetSuiteConfig: vi.fn(),
  businessUnitSourceOf: vi.fn(),
  // VeloExpense: the tenant's sequence and the plan's yearly cap.
  nextReportNumber: vi.fn(),
  assertExpenseAllowance: vi.fn(),
}));

// VeloExpense: the job runs as its tenant, so the tenant is in scope.
vi.mock('@/lib/db/prisma', () => ({ db: h.db, currentTenantId: () => 'org-1' }));
vi.mock('@/lib/db/prisma-pg-bridge', () => ({ queryRunnerOf: (tx: unknown) => tx }));
vi.mock('@/lib/billing/caps', () => ({
  assertExpenseAllowance: h.assertExpenseAllowance,
  CapReachedError: class CapReachedError extends Error {},
}));
vi.mock('@expenseos/db', () => ({
  nextReportNumber: h.nextReportNumber,
  ExpenseReportStatus: {
    DRAFT: 'DRAFT',
    RETURNED: 'RETURNED',
    SUBMITTED: 'SUBMITTED',
    APPROVED: 'APPROVED',
  },
  createReportFromReceipts: h.createReportFromReceipts,
  createBlankExpensesForReceipts: h.createBlankExpensesForReceipts,
  resolveIntakeCurrencyId: h.resolveIntakeCurrencyId,
  codingDefaultsFor: h.codingDefaultsFor,
}));
// VeloExpense: no `@expenseos/integrations-netsuite` — the source is always EXPENSEOS.
vi.mock('@expenseos/audit', () => ({
  withAudit: h.withAudit,
  auditActions: {
    report: { create: 'report.create', update: 'report.update', receiptAttach: 'r.attach' },
  },
}));
// Only the bucket clients are doubles; `guardedRead` and the caps come from their own, unmocked
// subpaths, so the real HEAD-then-bounded-read logic runs against `inboundMail.head` / `.read`.
// VeloExpense: the two buckets are `getStorage()` and `getInboundMailStorage()`.
vi.mock('@/lib/storage', () => ({
  getStorage: () => h.storage.receipts,
  getInboundMailStorage: () => h.storage.inboundMail,
}));
vi.mock('@/lib/storage/keys', () => ({
  receiptKey: (orgId: string, reportId: string, ext: string) => `org/${orgId}/${reportId}/obj.${ext}`,
}));
vi.mock('@expenseos/jobs', () => ({ enqueue: h.enqueue }));
vi.mock('@/lib/notifications/email', () => ({ sendEmail: h.sendEmail }));
// VeloExpense: the catalogue loader, empty, so the handler's own English copy is what is sent.
vi.mock('@expenseos/i18n/load', () => ({ loadCatalog: async () => ({}) }));

import {
  handleIngestReceiptEmail,
  isAutoSubmitted,
  RECEIPTS_SUBJECT_TYPE,
  stripSignature,
  usableAttachments,
} from './ingest-receipt-email';

// VeloExpense: one display name, no role relation, no language preference.
const USER = {
  id: 'u1',
  email: 'claimant@e.inc',
  name: 'Alex Doe',
};

/** A raw MIME message with the parts a test needs, built by hand so mailparser does the work. */
function mime(input: {
  from?: string;
  subject?: string;
  text?: string;
  extraHeaders?: string[];
  parts?: {
    filename: string;
    contentType: string;
    bytes: number;
    inline?: boolean;
    cid?: string;
  }[];
}): string {
  const boundary = 'bnd1';
  const head = [
    ...(input.extraHeaders ?? []),
    `From: ${input.from ?? 'Alex <claimant@e.inc>'}`,
    'To: receipts@expenseos.dev.internal.e.inc',
    `Subject: ${input.subject ?? 'Toronto client dinner'}`,
    'Message-ID: <orig-1@mail.test>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.text ?? 'Dinner with Acme after the Q3 review.',
    '',
  ];
  for (const part of input.parts ?? []) {
    head.push(
      `--${boundary}`,
      `Content-Type: ${part.contentType}; name="${part.filename}"`,
      'Content-Transfer-Encoding: base64',
      part.inline
        ? `Content-Disposition: inline; filename="${part.filename}"`
        : `Content-Disposition: attachment; filename="${part.filename}"`,
      ...(part.cid ? [`Content-ID: <${part.cid}>`] : []),
      '',
      Buffer.alloc(part.bytes, 7).toString('base64'),
      '',
    );
  }
  head.push(`--${boundary}--`, '');
  return head.join('\r\n');
}

const JOB = {
  bucket: 'inbound-bucket',
  objectKey: 'inbound/msg-1',
  sesMessageId: 'ses-1',
  mailbox: 'receipts' as const,
  /** The From the route authenticated — the same address `mime()` writes by default. */
  claimant: 'claimant@e.inc',
  // VeloExpense: the tenant the address named (d47).
  organizationId: 'org-1',
};

/** A real receipt: an attachment, an accepted type, comfortably over the logo floor. */
const RECEIPT_PART = { filename: 'dinner.heic', contentType: 'image/heic', bytes: 40_000 };

/**
 * Serve `raw` as the stored message: HEAD reports its BYTE length (not `raw.length`, which
 * differs for a non-ASCII message) and the bounded read hands back its bytes.
 */
function serveMessage(raw: string) {
  // VeloExpense: `head` answers `sizeBytes`.
  h.storage.inboundMail.head.mockResolvedValue({
    sizeBytes: Buffer.byteLength(raw),
    contentType: 'message/rfc822',
  });
  h.storage.inboundMail.read.mockResolvedValue({ ok: true, data: Buffer.from(raw) });
}

beforeEach(() => {
  vi.clearAllMocks();
  // A tripwire: the raw message is read through the storage client, never a presigned fetch.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('fetch must not be called: the worker reads through the storage client');
    }),
  );
  process.env.S3_INBOUND_MAIL_BUCKET = 'inbound-bucket';
  process.env.INBOUND_PUBLIC_EMAIL_DOMAIN = 'e.inc';
  process.env.PUBLIC_RECEIPTS_MAILBOX = 'receipts-dev';
  h.db.user.findFirst.mockResolvedValue(USER);
  // The filer's own coding, copied onto every expense created from the email.
  // VeloExpense: a business unit and a department; no class.
  h.db.user.findUnique.mockResolvedValue({
    businessUnitId: 'bu-1',
    departmentId: 'dept-1',
  });
  h.nextReportNumber.mockResolvedValue('EXP-000123');
  h.assertExpenseAllowance.mockResolvedValue(undefined);
  h.resolveIntakeCurrencyId.mockResolvedValue('cur-1');
  // No NetSuite config → EXPENSEOS, and the coding passes through untouched.
  h.loadNetSuiteConfig.mockResolvedValue(null);
  h.businessUnitSourceOf.mockReturnValue('EXPENSEOS');
  h.codingDefaultsFor.mockImplementation(async (_db: unknown, user: unknown) => user);
  h.createReportFromReceipts.mockResolvedValue({
    id: 'r1',
    number: 'EXP-000123',
    expenseIds: ['e1', 'e2'],
  });
  h.createBlankExpensesForReceipts.mockResolvedValue(['e9']);
  // withAudit runs the callback and hands back its value, like the real one.
  h.withAudit.mockImplementation(async (_db, _meta, fn: (tx: unknown) => unknown) => fn(h.db));
  h.db.receipt.create.mockResolvedValue({ id: 'receipt-1' });
  h.storage.receipts.put.mockResolvedValue(undefined);
  h.ensureReplyThread.mockResolvedValue({ id: 'thread-1' });
  h.issueEmailReplyToken.mockResolvedValue('tok123');
});

describe('usableAttachments', () => {
  const att = (over: Record<string, unknown> = {}) =>
    ({
      contentType: 'image/heic',
      content: Buffer.alloc(40_000),
      size: 40_000,
      related: false,
      contentDisposition: 'attachment',
      ...over,
    }) as never;

  it('keeps a real receipt', () => {
    expect(usableAttachments([att()])).toHaveLength(1);
  });

  it('drops a signature logo referenced by cid', () => {
    // Every corporate footer would otherwise become an expense with a merchant extracted
    // from a company logo.
    expect(usableAttachments([att({ related: true })])).toEqual([]);
  });

  it('drops an inline image even when it is not marked related', () => {
    expect(usableAttachments([att({ contentDisposition: 'inline' })])).toEqual([]);
  });

  it('drops an image under the logo floor but keeps a small PDF', () => {
    expect(usableAttachments([att({ size: 4_000, content: Buffer.alloc(4_000) })])).toEqual([]);
    expect(
      usableAttachments([
        att({ contentType: 'application/pdf', size: 4_000, content: Buffer.alloc(4_000) }),
      ]),
    ).toHaveLength(1);
  });

  it('drops a type the extraction pipeline cannot read', () => {
    expect(usableAttachments([att({ contentType: 'text/csv' })])).toEqual([]);
    expect(usableAttachments([att({ contentType: 'application/zip' })])).toEqual([]);
  });

  it('drops anything over the size ceiling', () => {
    expect(usableAttachments([att({ size: 11 * 1024 * 1024 })])).toEqual([]);
  });

  it('caps how many one email can carry', () => {
    expect(usableAttachments(Array.from({ length: 30 }, () => att()))).toHaveLength(20);
  });
});

describe('stripSignature', () => {
  it('keeps what was typed and drops the quoted history', () => {
    const body = 'Dinner with Acme.\n\nOn Tue, someone wrote:\n> the old thread';
    expect(stripSignature(body)).toBe('Dinner with Acme.');
  });

  it('cuts at the signature delimiter', () => {
    expect(stripSignature('Taxi from YYZ.\n-- \nAlex Doe\nCFO')).toBe('Taxi from YYZ.');
  });

  it('cuts a mobile footer, which the web helper does not know about', () => {
    expect(stripSignature('Receipt attached.\n\nSent from my iPhone')).toBe('Receipt attached.');
  });
});

describe('a new report from an email', () => {
  it('codes the expenses to the filer, the same as a browser upload', async () => {
    /**
     * An emailed receipt is the same claim by the same person: arriving through a
     * different door must not leave it uncoded. This asserts the PASS-THROUGH — the rule
     * itself is `defaultAllocationFrom`, unit-tested in `@expenseos/db` — because a
     * default nobody plumbed into this handler is exactly the gap being closed.
     */
    serveMessage(mime({ subject: 'Taxi', parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail(JOB);
    expect(h.createReportFromReceipts.mock.calls[0]?.[1]).toMatchObject({
      coding: { businessUnitId: 'bu-1', departmentId: 'dept-1' },
      businessUnitSource: 'EXPENSEOS',
    });
  });

  // VeloExpense: skipped — there is no NetSuite config, so the source is always EXPENSEOS
  // (the case above).
  it.skip('resolves the coding for the business unit source on the stored config', async () => {
    /**
     * Under NETSUITE the default business unit is picked by `codingDefaultsFor`, and the
     * worker has no tRPC context to borrow a source from — it reads the config itself.
     * What reaches the intake function is the RESOLVED coding and the same source.
     */
    const config = { accountId: 'TEST' };
    h.loadNetSuiteConfig.mockResolvedValue(config);
    h.businessUnitSourceOf.mockReturnValue('NETSUITE');
    const resolved = {
      businessUnitId: 'bu-alias',
      nsBusinessUnitId: 'nsbu-1',
      departmentId: 'dept-1',
      nsClassId: 'cls-1',
    };
    h.codingDefaultsFor.mockResolvedValue(resolved);
    serveMessage(mime({ subject: 'Taxi', parts: [RECEIPT_PART] }));

    await handleIngestReceiptEmail(JOB);

    expect(h.businessUnitSourceOf).toHaveBeenCalledWith(config);
    expect(h.codingDefaultsFor).toHaveBeenCalledWith(
      h.db,
      { businessUnitId: 'bu-1', departmentId: 'dept-1', nsClassId: 'cls-1' },
      'NETSUITE',
    );
    expect(h.createReportFromReceipts.mock.calls[0]?.[1]).toMatchObject({
      coding: resolved,
      businessUnitSource: 'NETSUITE',
    });
  });

  it('files one expense per receipt, titled from the subject', async () => {
    serveMessage(
      mime({
        subject: 'Toronto client dinner',
        parts: [
          RECEIPT_PART,
          { ...RECEIPT_PART, filename: 'taxi.pdf', contentType: 'application/pdf' },
        ],
      }),
    );

    await handleIngestReceiptEmail(JOB);

    expect(h.createReportFromReceipts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        submitterId: 'u1',
        title: 'Toronto client dinner',
        count: 2,
        // The body, signature stripped, is the business reason on every expense it created.
        purpose: 'Dinner with Acme after the Q3 review.',
      }),
    );
    expect(h.storage.receipts.put).toHaveBeenCalledTimes(2);
    expect(h.db.receipt.create).toHaveBeenCalledTimes(2);
  });

  it('records that it came from email, inside the audited details', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail(JOB);
    expect(h.withAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'report.create',
        details: { via: 'email', receipts: 1 },
        // VeloExpense: no role label — the audit row reads the member's role itself.
        actor: expect.objectContaining({ kind: 'user', id: 'u1', name: 'Alex Doe' }),
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('extracts the batch in one call, so a big email takes the cheaper path', async () => {
    const parts = Array.from({ length: 6 }, (_, i) => ({
      ...RECEIPT_PART,
      filename: `r${i}.heic`,
    }));
    h.createReportFromReceipts.mockResolvedValue({
      id: 'r1',
      number: 'EXP-1',
      expenseIds: parts.map((_, i) => `e${i}`),
    });
    h.db.receipt.create.mockImplementation(async () => ({ id: `rec-${Math.random()}` }));
    serveMessage(mime({ parts }));

    await handleIngestReceiptEmail(JOB);

    expect(h.enqueue).toHaveBeenCalledWith(
      'expense.extractReceipt.batch',
      expect.objectContaining({ receiptIds: expect.any(Array) }),
    );
  });

  // VeloExpense: skipped — the threaded address needs reply threads (w5-01, d48). The
  // acknowledgement is sent from the ordinary address; see the VeloExpense cases below.
  it.skip('acknowledges from the threaded address, so a reply adds to the same report', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail(JOB);
    expect(h.ensureReplyThread).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subjectType: RECEIPTS_SUBJECT_TYPE, subjectId: 'r1' }),
    );
    expect(h.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'claimant@e.inc',
        from: 'receipts-dev+tok123@e.inc',
        // Threaded onto the original so it lands in the same conversation.
        inReplyTo: '<orig-1@mail.test>',
      }),
    );
  });

  it('never registers a receipt whose upload failed', async () => {
    // A Receipt row pointing at an object that is not there is an expense showing a receipt
    // nobody can open, and an extraction that fails for a reason no one can see.
    h.storage.receipts.put.mockRejectedValue(new Error('s3 down'));
    serveMessage(mime({ parts: [RECEIPT_PART] }));

    await handleIngestReceiptEmail(JOB);

    expect(h.db.receipt.create).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    // The report still exists — a draft with an empty expense is visible and fixable.
    expect(h.createReportFromReceipts).toHaveBeenCalled();
  });
});

describe('what it refuses', () => {
  it('creates nothing for a sender with no account, and says so once', async () => {
    h.db.user.findFirst.mockResolvedValue(null);
    serveMessage(mime({ from: 'stranger@example.test', parts: [RECEIPT_PART] }));

    await handleIngestReceiptEmail({ ...JOB, claimant: 'stranger@example.test' });

    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('files, writes and SENDS nothing when the From is not the sender the route authenticated', async () => {
    /**
     * The route ties the From to the domain that passed SPF/DKIM and hands it over as
     * `claimant`; this parse of the same header must agree. Where it does not, the message
     * is refused outright — including the "no account" reply, which would otherwise email
     * whoever a forger named.
     */
    serveMessage(mime({ from: 'CFO <cfo@e.inc>', parts: [RECEIPT_PART] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleIngestReceiptEmail({ ...JOB, claimant: 'claimant@e.inc' });

    expect(h.db.user.findFirst).not.toHaveBeenCalled();
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(h.storage.receipts.put).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /refusing ses-1: From cfo@e\.inc is not the authenticated sender claimant@e\.inc/,
      ),
    );
    warn.mockRestore();
  });

  it('matches the claimant case-insensitively, since the route lowercases it', async () => {
    serveMessage(mime({ from: 'Alex <Claimant@E.inc>', parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail({ ...JOB, claimant: 'claimant@e.inc' });
    expect(h.createReportFromReceipts).toHaveBeenCalledTimes(1);
  });

  it('refuses a job that carries no authenticated sender at all', async () => {
    // A payload from before the gate existed, or from something other than the route.
    // Fail closed: nothing about the MIME alone says who this is from.
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleIngestReceiptEmail({ ...JOB, claimant: undefined } as never);
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a message with two From addresses, even when one is the claimant', async () => {
    // "From nobody in particular" — and "the first one" is exactly the choice two parsers
    // make differently.
    serveMessage(mime({ from: 'claimant@e.inc, cfo@e.inc', parts: [RECEIPT_PART] }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleIngestReceiptEmail(JOB);
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('creates nothing when the email carried no receipt', async () => {
    // Otherwise every out-of-office auto-reply becomes an empty draft.
    serveMessage(mime({ parts: [] }));
    await handleIngestReceiptEmail(JOB);
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses a message from a bucket we did not configure', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail({ ...JOB, bucket: 'someone-elses-bucket' });
    // Refused before the size check, never mind the download.
    expect(h.storage.inboundMail.head).not.toHaveBeenCalled();
    expect(h.storage.inboundMail.read).not.toHaveBeenCalled();
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
  });

  it('refuses an object key that tries to climb out of its prefix', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail({ ...JOB, objectKey: 'inbound/../secrets' });
    expect(h.storage.inboundMail.head).not.toHaveBeenCalled();
    expect(h.storage.inboundMail.read).not.toHaveBeenCalled();
  });
});

describe('reading the raw message within the inbound-mail cap', () => {
  /**
   * 40 MiB, pinned as a literal: the operator's inbound-mail cap (2026-09-28). It is NOT the
   * 25 MiB upload ceiling — SES writes this object, nobody uploads it — so a message between
   * the two must still be filed.
   */
  const CAP = 41_943_040;
  const RAW = mime({ parts: [RECEIPT_PART] });
  // VeloExpense: `head` answers `sizeBytes`.
  const headReports = (size: number) =>
    h.storage.inboundMail.head.mockResolvedValue({
      sizeBytes: size,
      contentType: 'message/rfc822',
    });
  const readReturns = (result: unknown) => h.storage.inboundMail.read.mockResolvedValue(result);
  const warnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.map((c) => String(c[0])).join('\n');

  it('reads and files a 30 MB message, which is over the 25 MiB upload ceiling', async () => {
    // Would fail if anyone clamped the read to the upload ceiling: HEAD's 30 MB would then
    // refuse the message before `read` was ever called.
    headReports(31_457_280);
    readReturns({ ok: true, data: Buffer.from(RAW) });
    await handleIngestReceiptEmail(JOB);
    expect(h.storage.inboundMail.read).toHaveBeenCalledTimes(1);
    expect(h.storage.inboundMail.read).toHaveBeenCalledWith('inbound/msg-1', CAP);
    expect(h.createReportFromReceipts).toHaveBeenCalledTimes(1);
  });

  it('reads a message at exactly the cap, as today', async () => {
    headReports(CAP);
    readReturns({ ok: true, data: Buffer.from(RAW) });
    await handleIngestReceiptEmail(JOB);
    expect(h.storage.inboundMail.read).toHaveBeenCalledWith('inbound/msg-1', CAP);
    expect(h.createReportFromReceipts).toHaveBeenCalledTimes(1);
  });

  it('drops a message HEAD reports at cap + 1 with a warning: no download, no report, no throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    headReports(CAP + 1);
    await expect(handleIngestReceiptEmail(JOB)).resolves.toBeUndefined();
    expect(h.storage.inboundMail.read).not.toHaveBeenCalled();
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
    const text = warnings(warn);
    expect(text).toContain('message too large: 41943041 bytes, over the 41943040-byte limit');
    expect(text).not.toContain('inbound-bucket');
    expect(text).not.toMatch(/http|X-Amz-/i);
  });

  it('drops a message whose read overflowed while streaming, naming the limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    headReports(0);
    readReturns({ ok: false, reason: 'too-large' });
    await expect(handleIngestReceiptEmail(JOB)).resolves.toBeUndefined();
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(warnings(warn)).toContain('message too large: more than the 41943040-byte limit');
  });

  it.each([
    ['HEAD finds no object', () => h.storage.inboundMail.head.mockResolvedValue(null), false],
    [
      'the object is deleted between HEAD and the read',
      () => {
        headReports(100);
        readReturns({ ok: false, reason: 'missing' });
      },
      true,
    ],
  ])('returns quietly, never saying "too large", when %s', async (_label, arrange, readCalled) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    arrange();
    await expect(handleIngestReceiptEmail(JOB)).resolves.toBeUndefined();
    expect(h.storage.inboundMail.read).toHaveBeenCalledTimes(readCalled ? 1 : 0);
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    const text = warnings(warn);
    expect(text).toContain('object not found');
    expect(text).not.toMatch(/too large/i);
  });

  it('rethrows a HEAD that throws, so BullMQ retries, and never downloads unchecked', async () => {
    h.storage.inboundMail.head.mockRejectedValue(new Error('socket hang up'));
    await expect(handleIngestReceiptEmail(JOB)).rejects.toThrow('socket hang up');
    expect(h.storage.inboundMail.read).not.toHaveBeenCalled();
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
  });

  it('rethrows a read that throws, so BullMQ retries', async () => {
    headReports(100);
    h.storage.inboundMail.read.mockRejectedValue(new Error('AccessDenied'));
    await expect(handleIngestReceiptEmail(JOB)).rejects.toThrow('AccessDenied');
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
  });
});

// VeloExpense: skipped — adding to a report by replying arrives with reply threads (w5-01,
// d48). Until then a token is carried and not read; see the VeloExpense cases below.
describe.skip('a threaded reply', () => {
  const threaded = { ...JOB, token: 'tok-existing' };

  it('adds to the report the token names', async () => {
    h.findThreadByEmailToken.mockResolvedValue({
      id: 't1',
      subjectType: RECEIPTS_SUBJECT_TYPE,
      subjectId: 'r-old',
      recipientId: 'u1',
    });
    h.db.expenseReport.findUnique.mockResolvedValue({
      id: 'r-old',
      submitterId: 'u1',
      status: 'DRAFT',
      currencyId: 'cur-1',
      number: 'EXP-000009',
    });
    serveMessage(mime({ parts: [RECEIPT_PART] }));

    await handleIngestReceiptEmail(threaded);

    expect(h.createBlankExpensesForReceipts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reportId: 'r-old',
        count: 1,
        coding: { businessUnitId: 'bu-1', departmentId: 'dept-1', nsClassId: 'cls-1' },
        businessUnitSource: 'EXPENSEOS',
      }),
    );
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
  });

  it('starts a new report when the token belongs to a COMMENT thread', async () => {
    // A `reply+` token must not be spendable on filing expenses. Falling back to a new report
    // is the safe reading: nothing of somebody else's is touched.
    h.findThreadByEmailToken.mockResolvedValue({
      id: 't1',
      subjectType: 'EXPENSE_REPORT',
      subjectId: 'r-old',
      recipientId: 'u1',
    });
    serveMessage(mime({ parts: [RECEIPT_PART] }));

    await handleIngestReceiptEmail(threaded);

    expect(h.createBlankExpensesForReceipts).not.toHaveBeenCalled();
    expect(h.createReportFromReceipts).toHaveBeenCalled();
  });

  it('starts a new report when the token belongs to somebody else', async () => {
    h.findThreadByEmailToken.mockResolvedValue({
      id: 't1',
      subjectType: RECEIPTS_SUBJECT_TYPE,
      subjectId: 'r-old',
      recipientId: 'someone-else',
    });
    serveMessage(mime({ parts: [RECEIPT_PART] }));

    await handleIngestReceiptEmail(threaded);

    expect(h.createBlankExpensesForReceipts).not.toHaveBeenCalled();
    expect(h.createReportFromReceipts).toHaveBeenCalled();
  });

  it('refuses a submitted report instead of appending to it', async () => {
    // Recalling it is the submitter's decision, not something an email does for them.
    h.findThreadByEmailToken.mockResolvedValue({
      id: 't1',
      subjectType: RECEIPTS_SUBJECT_TYPE,
      subjectId: 'r-old',
      recipientId: 'u1',
    });
    h.db.expenseReport.findUnique.mockResolvedValue({
      id: 'r-old',
      submitterId: 'u1',
      status: 'SUBMITTED',
      currencyId: 'cur-1',
    });
    serveMessage(mime({ parts: [RECEIPT_PART] }));

    await handleIngestReceiptEmail(threaded);

    expect(h.createBlankExpensesForReceipts).not.toHaveBeenCalled();
    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('mail loops', () => {
  const headers = (entries: [string, string][]) =>
    ({ headers: new Map(entries.map(([k, v]) => [k, v])) }) as never;

  it('recognises the header a modern responder sets', () => {
    expect(isAutoSubmitted(headers([['auto-submitted', 'auto-replied']]))).toBe(true);
    expect(isAutoSubmitted(headers([['auto-submitted', 'auto-generated']]))).toBe(true);
    // "no" is the one value that means a human sent it.
    expect(isAutoSubmitted(headers([['auto-submitted', 'no']]))).toBe(false);
  });

  it('recognises the older responders that only set Precedence', () => {
    for (const value of ['bulk', 'list', 'junk', 'auto_reply']) {
      expect(isAutoSubmitted(headers([['precedence', value]])), value).toBe(true);
    }
  });

  it('recognises a bounce by its sender or its empty return path', () => {
    expect(
      isAutoSubmitted({
        from: { value: [{ address: 'MAILER-DAEMON@mail.test' }] } as never,
      }),
    ).toBe(true);
    expect(isAutoSubmitted(headers([['return-path', '<>']]))).toBe(true);
  });

  it('treats an ordinary message as human', () => {
    expect(
      isAutoSubmitted({
        headers: new Map(),
        from: { value: [{ address: 'claimant@e.inc' }] } as never,
      }),
    ).toBe(false);
  });

  it('neither files nor answers an out-of-office reply', async () => {
    // Both halves matter: a bounce quotes the original attachments, so filing would duplicate
    // a report — and answering would have our acknowledgement and their responder emailing
    // each other indefinitely.
    serveMessage(
      mime({
        extraHeaders: ['Auto-Submitted: auto-replied'],
        parts: [RECEIPT_PART],
      }),
    );

    await handleIngestReceiptEmail(JOB);

    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('marks its own acknowledgement as machine-generated', async () => {
    // The other half of the guard: a well-behaved responder must not answer us either.
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail(JOB);
    expect(h.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'Auto-Submitted': 'auto-replied' } }),
    );
  });
});

describe('VeloExpense', () => {
  it('numbers the report from the tenant’s sequence and checks the plan’s cap first', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART, { ...RECEIPT_PART, filename: 'b.heic' }] }));
    await handleIngestReceiptEmail(JOB);
    expect(h.assertExpenseAllowance).toHaveBeenCalledWith(h.db, 2);
    expect(h.createReportFromReceipts.mock.calls[0]?.[1]).toMatchObject({ number: 'EXP-000123' });
    expect(h.assertExpenseAllowance.mock.invocationCallOrder[0]).toBeLessThan(
      h.createReportFromReceipts.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('files nothing past the plan’s cap, says so once, and does not ask to be retried', async () => {
    const { CapReachedError } = await import('@/lib/billing/caps');
    h.assertExpenseAllowance.mockRejectedValue(new (CapReachedError as unknown as new () => Error)());
    serveMessage(mime({ parts: [RECEIPT_PART] }));

    await expect(handleIngestReceiptEmail(JOB)).resolves.toBeUndefined();

    expect(h.createReportFromReceipts).not.toHaveBeenCalled();
    expect(h.storage.receipts.put).not.toHaveBeenCalled();
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.sendEmail.mock.calls[0]?.[0]).toMatchObject({
      subject: 'Your plan’s expense limit has been reached',
    });
  });

  it('looks the sender up among active people only — the tenant is the job’s scope', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail(JOB);
    expect(h.db.user.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        email: { equals: 'claimant@e.inc', mode: 'insensitive' },
        deletedAt: null,
        employeeStatus: { not: 'DEACTIVATED' },
      },
    });
  });

  it('writes each receipt under the tenant’s prefix and records it STORED, with its size', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail(JOB);
    expect(h.storage.receipts.put).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'org/org-1/r1/obj.heic', contentType: 'image/heic' }),
    );
    expect(h.db.receipt.create.mock.calls[0]?.[0]).toMatchObject({
      data: { s3Key: 'org/org-1/r1/obj.heic', status: 'STORED', sizeBytes: 40_000, uploadedById: 'u1' },
    });
  });

  it('names the tenant on every extraction job', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail(JOB);
    expect(h.enqueue).toHaveBeenCalledWith('expense.extractReceipt', {
      organizationId: 'org-1',
      receiptId: 'receipt-1',
    });
  });

  it('acknowledges from the ordinary address and does not offer a reply it cannot take (d48)', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail(JOB);
    const sent = h.sendEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ to: 'claimant@e.inc', inReplyTo: '<orig-1@mail.test>' });
    expect(sent.from).toBeUndefined();
    expect(sent.replyTo).toBeUndefined();
    expect(String(sent.text)).not.toMatch(/reply/i);
  });

  it('starts a new report even when the address carried a token, until w5-01', async () => {
    serveMessage(mime({ parts: [RECEIPT_PART] }));
    await handleIngestReceiptEmail({ ...JOB, token: 'tok-existing' });
    expect(h.findThreadByEmailToken).not.toHaveBeenCalled();
    expect(h.createBlankExpensesForReceipts).not.toHaveBeenCalled();
    expect(h.createReportFromReceipts).toHaveBeenCalledTimes(1);
  });
});
