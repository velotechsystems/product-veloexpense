// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the harness reads rows untyped, as ExpenseOS's suites do. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../server/__test-helpers__/tenantHarness';

/**
 * VeloExpense (w3-06): `email.ingestReceipts` against a real database, as the worker runs it —
 * as the tenant the email was addressed to (d47), statement at a time
 * (`withTenantStatements`), through RLS as `veloapp`.
 *
 * ExpenseOS has no database suite for this handler; its unit suite mocks Prisma. This one
 * exists for what only the database can say here: that the report, its expenses, the stored
 * receipts and the audit rows land in the job's tenant, numbered from its sequence, and that a
 * sender who belongs to another tenant creates nothing anywhere.
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 */

const enqueue = vi.hoisted(() => vi.fn());
vi.mock('@expenseos/jobs', () => ({ enqueue }));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

/** A raw message with one PNG-typed attachment over the logo floor. */
function mime(from: string, subject: string, files: string[]): string {
  const b = 'bnd1';
  const out = [
    `From: ${from}`,
    'To: receipts@receipt-mail.mail.dev.example',
    `Subject: ${subject}`,
    'Message-ID: <db-1@mail.test>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Team lunch after the planning session.',
    '',
  ];
  for (const name of files) {
    out.push(
      `--${b}`,
      `Content-Type: image/png; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      Buffer.alloc(20_000, 7).toString('base64'),
      '',
    );
  }
  out.push(`--${b}--`, '');
  return out.join('\r\n');
}

describe.skipIf(!process.env.DATABASE_URL)('email.ingestReceipts (integration)', () => {
  let h: TenantHarness;
  let other: TenantHarness;
  let inbound: import('@/lib/storage').MemoryStorage;
  let mail: import('@/lib/notifications/email').MemoryEmailTransport;
  let handle: (orgId: string, data: Record<string, unknown>) => Promise<void>;
  let n = 0;

  /** Store `raw` where SES would have, and return the job the route would enqueue. */
  const job = (orgId: string, claimant: string, raw: string) => {
    const objectKey = `inbound/msg-${++n}`;
    inbound.put(objectKey, raw, 'message/rfc822');
    return {
      bucket: 'inbound-bucket',
      objectKey,
      sesMessageId: `ses-${n}`,
      mailbox: 'receipts',
      claimant,
      organizationId: orgId,
    };
  };

  beforeAll(async () => {
    other = await createTenantHarness({
      slug: 'receipt-mail-other',
      name: 'Receipt Mail Other',
      people: [{ email: 'outsider@other.example', name: 'Outsider' }],
    });
    // Created second, so the storage the suite's tenant installs is the one in force.
    h = await createTenantHarness({
      slug: 'receipt-mail',
      name: 'Receipt Mail',
      people: [{ email: 'filer@receipt-mail.example', name: 'Fiona Filer' }],
    });
    process.env.S3_INBOUND_MAIL_BUCKET = 'inbound-bucket';
    const storage = await import('@/lib/storage');
    inbound = new storage.MemoryStorage();
    storage.setInboundMailStorage(inbound);
    const email = await import('@/lib/notifications/email');
    mail = new email.MemoryEmailTransport();
    email.setEmailTransport(mail);
    const { handleIngestReceiptEmail } = await import('./ingest-receipt-email');
    const { withTenantStatements } = await import('@/lib/db/prisma');
    handle = (orgId, data) =>
      withTenantStatements(orgId, () => handleIngestReceiptEmail(data as never));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  beforeEach(() => {
    enqueue.mockReset();
    mail.sent.length = 0;
  });

  afterAll(async () => {
    const storage = await import('@/lib/storage');
    storage.setInboundMailStorage(null);
    (await import('@/lib/notifications/email')).resetEmailTransport();
    await h?.end();
    await other?.end();
  });

  it('files a report in the job’s tenant: numbered, one STORED receipt per file, audited', async () => {
    const filer = h.people[1];
    await handle(
      h.orgId,
      job(h.orgId, filer.email, mime(`Fiona <${filer.email}>`, 'Planning lunch', ['a.png', 'b.png'])),
    );

    const report = (
      await h.admin.query(
        `SELECT id, organization_id, number, title, submitter_id, status
           FROM expense_report WHERE title = 'Planning lunch'`,
      )
    ).rows[0] as any;
    expect(report).toMatchObject({
      organization_id: h.orgId,
      submitter_id: filer.id,
      status: 'DRAFT',
    });
    expect(report.number).toMatch(/^EXP-\d{6}$/);

    const expenses = (
      await h.admin.query(
        `SELECT id, organization_id, owner_id, purpose, explanation FROM expense WHERE report_id = $1`,
        [report.id],
      )
    ).rows as any[];
    expect(expenses).toHaveLength(2);
    for (const e of expenses) {
      expect(e).toMatchObject({
        organization_id: h.orgId,
        owner_id: filer.id,
        purpose: 'Team lunch after the planning session.',
        // #567: and the "Explain this charge" field the workbench shows.
        explanation: 'Team lunch after the planning session.',
      });
    }

    const receipts = (
      await h.admin.query(
        `SELECT r.s3_key, r.status, r.size_bytes, r.organization_id, r.uploaded_by_id
           FROM receipt r JOIN expense e ON e.id = r.expense_id WHERE e.report_id = $1`,
        [report.id],
      )
    ).rows as any[];
    expect(receipts).toHaveLength(2);
    for (const r of receipts) {
      expect(r).toMatchObject({
        status: 'STORED',
        size_bytes: 20_000,
        organization_id: h.orgId,
        uploaded_by_id: filer.id,
      });
      expect(r.s3_key.startsWith(`org/${h.orgId}/receipts/${report.id}/`)).toBe(true);
      expect(h.storage.memory.has(r.s3_key)).toBe(true);
    }

    const audits = (
      await h.admin.query(
        `SELECT action, details FROM audit_entry
          WHERE organization_id = $1 AND actor_id = $2 ORDER BY sequence`,
        [h.orgId, filer.id],
      )
    ).rows as any[];
    expect(audits.map((a) => a.action)).toEqual([
      'REPORT_CREATED',
      'RECEIPT_ATTACHED',
      'RECEIPT_ATTACHED',
    ]);
    expect(audits[0].details).toMatchObject({ via: 'email', receipts: 2 });

    // One extraction job per receipt, each naming the tenant.
    const extraction = enqueue.mock.calls.filter((c) => c[0] === 'expense.extractReceipt');
    expect(extraction).toHaveLength(2);
    for (const call of extraction) {
      expect(call[1]).toMatchObject({ organizationId: h.orgId });
    }

    // #567: and the acknowledgement is the summary job — queued for later, as the tenant,
    // naming this email's two receipts — rather than a mail sent before anything is read.
    const summaries = enqueue.mock.calls.filter((c) => c[0] === 'email.receiptsSummary');
    expect(summaries).toHaveLength(1);
    const receiptIds = (
      await h.admin.query(
        `SELECT r.id FROM receipt r JOIN expense e ON e.id = r.expense_id WHERE e.report_id = $1`,
        [report.id],
      )
    ).rows.map((r: any) => r.id as string);
    expect(summaries[0][1]).toMatchObject({
      organizationId: h.orgId,
      reportId: report.id,
      userId: filer.id,
      to: filer.email,
      attempt: 0,
    });
    expect([...summaries[0][1].receiptIds].sort()).toEqual([...receiptIds].sort());
    expect(mail.sent).toHaveLength(0);

    // Run that job once its wait is over (nothing reads the receipts here, so they are still
    // unread): it sends ONE summary, to the sender, naming the report — through RLS, on
    // VeloExpense's schema, with the approval preview run against the tenant's workflow.
    const { handleReceiptsSummaryEmail } = await import('./receipts-summary-email');
    const { withTenantStatements } = await import('@/lib/db/prisma');
    await withTenantStatements(h.orgId, () =>
      handleReceiptsSummaryEmail({ ...summaries[0][1], waitUntil: Date.now() - 1 }),
    );
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      to: filer.email,
      subject: `${report.number}: Planning lunch`,
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    expect(mail.sent[0].text).toContain(`${report.number} — Planning lunch`);
    expect(mail.sent[0].text).toContain('2 filed · 0 read');
    expect(mail.sent[0].text).toContain('Team lunch after the planning session.');
    expect(mail.sent[0].html).toContain('Receipt Mail');
  });

  it('adds a reply to the report its acknowledgement threaded, on the tenant domain (w5-01b, d48)', async () => {
    // ExpenseOS's threaded reply, end to end: the first email's summary is queued carrying a
    // `receipts+<token>@` address — VeloExpense: the tenant's — and a reply to it, addressed
    // there, adds its receipts to that same report instead of starting another.
    process.env.INBOUND_EMAIL_DOMAIN = 'mail.dev.example';
    process.env.INBOUND_RECEIPTS_MAILBOXES = 'receipts';
    try {
      const filer = h.people[1];
      await handle(h.orgId, job(h.orgId, filer.email, mime(filer.email, 'Offsite', ['a.png'])));
      const summary = enqueue.mock.calls.find((c) => c[0] === 'email.receiptsSummary')?.[1] as
        | { reportId: string; replyAddress?: string }
        | undefined;
      expect(summary?.replyAddress).toMatch(/^receipts\+[\w-]+@receipt-mail\.mail\.dev\.example$/);
      const token = summary!.replyAddress!.match(/^receipts\+([^@]+)@/)![1];

      enqueue.mockReset();
      await handle(h.orgId, {
        ...job(h.orgId, filer.email, mime(filer.email, 'Re: Offsite', ['b.png', 'c.png'])),
        token,
      });

      const reports = (
        await h.admin.query(`SELECT id FROM expense_report WHERE title LIKE '%Offsite%'`)
      ).rows as any[];
      expect(reports.map((r) => r.id)).toEqual([summary!.reportId]);
      const files = await h.admin.query(
        `SELECT count(*)::int AS n FROM receipt r JOIN expense e ON e.id = r.expense_id
          WHERE e.report_id = $1`,
        [summary!.reportId],
      );
      expect(files.rows[0].n).toBe(3);
    } finally {
      delete process.env.INBOUND_EMAIL_DOMAIN;
      delete process.env.INBOUND_RECEIPTS_MAILBOXES;
    }
  });

  it('files nothing for a sender who belongs to another tenant, and says so to them once', async () => {
    const outsider = other.people[1];
    const before = Number(
      (await h.admin.query(`SELECT count(*)::int AS n FROM expense_report`)).rows[0].n,
    );

    await handle(
      h.orgId,
      job(h.orgId, outsider.email, mime(outsider.email, 'Not ours', ['c.png'])),
    );

    const after = Number(
      (await h.admin.query(`SELECT count(*)::int AS n FROM expense_report`)).rows[0].n,
    );
    expect(after).toBe(before);
    expect(enqueue).not.toHaveBeenCalled();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      to: outsider.email,
      subject: 'No VeloExpense account for this address',
    });
  });
});
