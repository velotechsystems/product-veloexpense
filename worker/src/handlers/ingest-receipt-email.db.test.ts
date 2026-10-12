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
        `SELECT id, organization_id, owner_id, purpose FROM expense WHERE report_id = $1`,
        [report.id],
      )
    ).rows as any[];
    expect(expenses).toHaveLength(2);
    for (const e of expenses) {
      expect(e).toMatchObject({
        organization_id: h.orgId,
        owner_id: filer.id,
        purpose: 'Team lunch after the planning session.',
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
    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const call of enqueue.mock.calls) {
      expect(call[0]).toBe('expense.extractReceipt');
      expect(call[1]).toMatchObject({ organizationId: h.orgId });
    }

    // And one acknowledgement, to the sender, naming the report.
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: filer.email, subject: `${report.number}: Planning lunch` });
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
