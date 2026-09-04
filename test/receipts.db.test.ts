/**
 * VX1-5 — receipts service DB test. Runs the service over a tenant transaction
 * (withOrg) against MemoryStorage, so no S3, MinIO or credentials are needed in
 * CI. Covers the two-phase upload, the attach/detach loop, download signing,
 * removal, the receipt-first flow, and tenant isolation of both the rows and
 * the storage keys.
 *
 * No new tenant table lands in this ticket — 0005 only adds state to `receipt`,
 * whose RLS is already proven by test/rls-isolation.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { MemoryStorage } from '@/lib/storage';
import * as expenses from '@/lib/expenses/service';
import * as svc from '@/lib/receipts/service';
import { TEST_ACTOR } from './support/audit-actor';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
const storage = new MemoryStorage();

const UPLOADER = 'u@acme.test';

let orgA: string;
let orgB: string;
let reportId: string;
let expenseId: string;

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const a = await admin.query("INSERT INTO organization (slug, name) VALUES ('vx15-acme','Acme') RETURNING id");
  const b = await admin.query("INSERT INTO organization (slug, name) VALUES ('vx15-globex','Globex') RETURNING id");
  orgA = a.rows[0].id;
  orgB = b.rows[0].id;

  await withOrg(orgA, async (tx) => {
    await tx.query("INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,$2,'U')", [
      orgA,
      UPLOADER,
    ]);
    const report = await expenses.createReport(tx, UPLOADER, { title: 'Trip', currencyCode: 'CAD' });
    reportId = report.id;
    const expense = await expenses.addExpense(tx, TEST_ACTOR, reportId, { currencyCode: 'CAD', merchant: 'Cafe' });
    expenseId = expense.id;
  });

  await withOrg(orgB, (tx) =>
    tx.query("INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'other@globex.test','O')", [
      orgB,
    ]),
  );
});

afterAll(async () => {
  await admin.end();
});

/** Stand in for the browser: intent → PUT → confirm. */
async function upload(
  tx: Parameters<typeof svc.createUploadIntent>[0],
  filename: string,
  contentType = 'application/pdf',
  expenseIdToAttach: string | null = null,
) {
  const { receipt, upload: presigned } = await svc.createUploadIntent(
    tx,
    UPLOADER,
    { filename, contentType, expenseId: expenseIdToAttach },
    storage,
  );
  storage.put(receipt.s3_key, `pretend bytes for ${filename}`, contentType);
  return { confirmed: await svc.confirmUpload(tx, receipt.id, storage), presigned };
}

describe('receipt upload', () => {
  it('reserves a PENDING row and a tenant-prefixed key, then confirms with the real size', async () => {
    const result = await withOrg(orgA, async (tx) => {
      const { receipt, upload: presigned } = await svc.createUploadIntent(
        tx,
        UPLOADER,
        { filename: 'lunch.pdf', contentType: 'application/pdf', expenseId },
        storage,
      );
      const before = receipt;
      storage.put(receipt.s3_key, 'twelve bytes', 'application/pdf');
      const after = await svc.confirmUpload(tx, receipt.id, storage);
      return { before, after, presigned };
    });

    expect(result.before.status).toBe('PENDING');
    expect(result.before.size_bytes).toBeNull();
    expect(result.before.s3_key.startsWith(`org/${orgA}/receipts/`)).toBe(true);
    expect(result.before.s3_key.endsWith('/lunch.pdf')).toBe(true);
    expect(result.presigned.headers['Content-Type']).toBe('application/pdf');
    expect(result.after.status).toBe('STORED');
    expect(result.after.size_bytes).toBe('twelve bytes'.length);
    expect(result.after.expense_id).toBe(expenseId);
  });

  it('rejects an unsupported content type before anything is written', async () => {
    await expect(
      withOrg(orgA, (tx) =>
        svc.createUploadIntent(tx, UPLOADER, { filename: 'evil.exe', contentType: 'application/x-msdownload' }, storage),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
  });

  it('refuses to confirm an upload that never happened', async () => {
    await expect(
      withOrg(orgA, async (tx) => {
        const { receipt } = await svc.createUploadIntent(
          tx,
          UPLOADER,
          { filename: 'ghost.pdf', contentType: 'application/pdf' },
          storage,
        );
        return svc.confirmUpload(tx, receipt.id, storage);
      }),
    ).rejects.toMatchObject({ code: 'NOT_UPLOADED' });
  });

  it('sanitises a hostile filename', async () => {
    expect(svc.sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(svc.sanitizeFilename('my receipt (1).pdf')).toBe('my_receipt__1_.pdf');
  });
});

describe('attach, download and remove', () => {
  it('lists a stored receipt against its expense and its report', async () => {
    const result = await withOrg(orgA, async (tx) => {
      await upload(tx, 'hotel.pdf', 'application/pdf', expenseId);
      return {
        byExpense: await svc.listReceiptsForExpense(tx, expenseId),
        byReport: await svc.listReceiptsForReport(tx, reportId),
      };
    });
    expect(result.byExpense.map((r) => r.filename)).toContain('hotel.pdf');
    expect(result.byReport.map((r) => r.filename)).toContain('hotel.pdf');
  });

  it('moves a receipt between the inbox and an expense', async () => {
    const result = await withOrg(orgA, async (tx) => {
      const { confirmed } = await upload(tx, 'taxi.jpg', 'image/jpeg');
      const inboxBefore = await svc.listUnattachedReceipts(tx, UPLOADER);
      const attached = await svc.attachReceipt(tx, confirmed.id, expenseId);
      const inboxAfter = await svc.listUnattachedReceipts(tx, UPLOADER);
      const detached = await svc.detachReceipt(tx, confirmed.id);
      return {
        inboxBefore: inboxBefore.map((r) => r.filename),
        attachedTo: attached.expense_id,
        inboxAfter: inboxAfter.map((r) => r.filename),
        detachedTo: detached.expense_id,
      };
    });
    expect(result.inboxBefore).toContain('taxi.jpg');
    expect(result.attachedTo).toBe(expenseId);
    expect(result.inboxAfter).not.toContain('taxi.jpg');
    expect(result.detachedTo).toBeNull();
  });

  it('signs a download only for a stored receipt', async () => {
    const result = await withOrg(orgA, async (tx) => {
      const { confirmed } = await upload(tx, 'dinner.png', 'image/png');
      const url = await svc.getDownloadUrl(tx, confirmed.id, storage);
      const { receipt: pending } = await svc.createUploadIntent(
        tx,
        UPLOADER,
        { filename: 'later.pdf', contentType: 'application/pdf' },
        storage,
      );
      return { url, pendingId: pending.id };
    });
    expect(result.url).toContain('memory://download/');

    await expect(
      withOrg(orgA, (tx) => svc.getDownloadUrl(tx, result.pendingId, storage)),
    ).rejects.toMatchObject({ code: 'NOT_STORED' });
  });

  it('removes the row and the object together', async () => {
    const key = await withOrg(orgA, async (tx) => {
      const { confirmed } = await upload(tx, 'delete-me.pdf');
      expect(storage.has(confirmed.s3_key)).toBe(true);
      await svc.removeReceipt(tx, confirmed.id, storage);
      const gone = await svc.getReceipt(tx, confirmed.id);
      expect(gone).toBeNull();
      return confirmed.s3_key;
    });
    expect(storage.has(key)).toBe(false);
  });
});

describe('receipt-first', () => {
  it('turns inbox receipts into a report with one expense each', async () => {
    const result = await withOrg(orgA, async (tx) => {
      const a = await upload(tx, 'flight.pdf');
      const b = await upload(tx, 'cab.jpg', 'image/jpeg');
      const started = await svc.startFromReceipts(
        tx,
        TEST_ACTOR,
        UPLOADER,
        { title: 'Toronto trip', currencyCode: 'CAD' },
        [a.confirmed.id, b.confirmed.id],
      );
      const full = await expenses.getReport(tx, started.report.id);
      const inbox = await svc.listUnattachedReceipts(tx, UPLOADER);
      return {
        title: started.report.title,
        expenseCount: full!.expenses.length,
        attachedExpenseIds: started.receipts.map((r) => r.expense_id),
        inbox: inbox.map((r) => r.filename),
      };
    });

    expect(result.title).toBe('Toronto trip');
    expect(result.expenseCount).toBe(2);
    expect(new Set(result.attachedExpenseIds).size).toBe(2);
    expect(result.attachedExpenseIds).not.toContain(null);
    expect(result.inbox).not.toContain('flight.pdf');
    expect(result.inbox).not.toContain('cab.jpg');
  });

  it('refuses an empty selection', async () => {
    await expect(
      withOrg(orgA, (tx) =>
        svc.startFromReceipts(tx, TEST_ACTOR, UPLOADER, { title: 'Empty', currencyCode: 'CAD' }, []),
      ),
    ).rejects.toMatchObject({ code: 'NO_RECEIPTS' });
  });
});

describe('tenant isolation', () => {
  it('another tenant cannot see, download or remove a receipt', async () => {
    const receiptId = await withOrg(orgA, async (tx) => (await upload(tx, 'private.pdf')).confirmed.id);

    const seen = await withOrg(orgB, (tx) => svc.getReceipt(tx, receiptId));
    expect(seen).toBeNull();

    await expect(withOrg(orgB, (tx) => svc.getDownloadUrl(tx, receiptId, storage))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(withOrg(orgB, (tx) => svc.removeReceipt(tx, receiptId, storage))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // still there for its own tenant
    const mine = await withOrg(orgA, (tx) => svc.getReceipt(tx, receiptId));
    expect(mine?.filename).toBe('private.pdf');
  });

  it('refuses to attach a receipt to another tenant’s expense', async () => {
    const foreignExpenseId = await withOrg(orgB, async (tx) => {
      await tx.query(
        `INSERT INTO expense_report (organization_id, title, currency_code, submitter_id)
           SELECT $1, 'Theirs', 'CAD', id FROM app_user WHERE organization_id = $1 LIMIT 1`,
        [orgB],
      );
      const report = await tx.query('SELECT id FROM expense_report LIMIT 1');
      const expense = await tx.query(
        `INSERT INTO expense (organization_id, report_id, currency_code) VALUES ($1,$2,'CAD') RETURNING id`,
        [orgB, report.rows[0].id],
      );
      return expense.rows[0].id as string;
    });

    const receiptId = await withOrg(orgA, async (tx) => (await upload(tx, 'mine.pdf')).confirmed.id);

    await expect(
      withOrg(orgA, (tx) => svc.attachReceipt(tx, receiptId, foreignExpenseId)),
    ).rejects.toMatchObject({ code: 'EXPENSE_NOT_FOUND' });
  });
});
