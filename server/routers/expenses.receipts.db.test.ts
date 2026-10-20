// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * Integration test for the expense receipt/invoice upload endpoints, using the
 * tRPC caller harness against a real database (real Prisma + real `withAudit`
 * chain). Storage is mocked so no S3/MinIO is required. Auth + the Redis-backed
 * RBAC resolver are mocked away because we inject `ctx` directly.
 *
 * Gated on DATABASE_URL: the hermetic unit-only CI run has no database, so this
 * whole block is skipped there (same pattern as every `*.db.test.ts`). Run
 * locally with `DATABASE_URL=... npx vitest run <this file>`.
 *
 * VeloExpense: ExpenseOS's `expenses.receipts.db.test.ts` (w2-09). The cases are ExpenseOS's;
 * the harness is VeloExpense's (`createTenantHarness`: the suite's own tenant and people, every
 * call under RLS, storage in memory). Adaptations, each marked:
 *   · a receipt key sits under the tenant's prefix (`receiptPrefix`), and `receiptCreate`
 *     reads the object back (d29), so each case puts the object in storage first
 *     (`uploaded`), as the browser's PUT would;
 *   · the audit row is VeloExpense's (`RECEIPT_ATTACHED`), and a signed view URL is the
 *     memory driver's;
 *   · a report changes status through `setStatus`, which stamps a REIMBURSED one as
 *     VeloExpense's CHECK requires;
 *   · `startExtraction` arrived with the workbench (w2-02b), so the last case's re-read
 *     refusal is ExpenseOS's again.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.createOwn,
] as const;

describe.skipIf(!process.env.DATABASE_URL)('expenses receipt endpoints (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let storage: any;
  let makeCaller: (perms: readonly string[], userId: string) => any;
  let ownerId: string;
  let strangerId: string;
  let currencyId: string;
  let reportId: string;
  let expenseId: string;

  /** VeloExpense: where this report's receipts live (`receiptPrefix`). */
  const prefix = () => `org/${h.orgId}/receipts/${reportId}`;
  /**
   * VeloExpense: move the report to `status`. VeloExpense's CHECK requires a REIMBURSED report
   * to carry who reimbursed it and when (and no other status to), so the stamp moves with
   * the status — written as the superuser, as a fixture rather than through the lifecycle.
   */
  const setStatus = (status: string) =>
    h.admin.query(
      `UPDATE expense_report
          SET status = $2::expense_report_status,
              reimbursed_at = CASE WHEN $2 = 'REIMBURSED' THEN now() END,
              reimbursed_by_id = CASE WHEN $2 = 'REIMBURSED' THEN $3::uuid END
        WHERE id = $1`,
      [reportId, status, ownerId],
    );
  /** VeloExpense: the browser's PUT — an object of `bytes` at `key`, for `receiptCreate` to read. */
  const uploaded = (key: string, bytes: number) => {
    h.storage.memory.put(key, new Uint8Array(bytes), 'application/pdf');
    return key;
  };

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'expenses-receipts',
      name: 'Expenses Receipts',
      people: [{ email: 'stranger@expenses-receipts.test', name: 'Stranger' }],
    });
    ({ db, makeCaller } = h);
    storage = h.storage;
    ownerId = h.people[0].id;
    strangerId = h.people[1].id;
    // VeloExpense: a currency is keyed by its code.
    currencyId = 'CAD';
    reportId = (
      await db.expenseReport.create({
        data: { title: 'harness test report', currencyId, submitterId: ownerId },
        select: { id: true },
      })
    ).id;
    expenseId = (
      await db.expense.create({
        // `ownerId` mirrors the report's submitter. It is a required column and was
        // missing here, so every test in this file failed in beforeAll — invisibly,
        // because CI has no DATABASE_URL and skips the whole block.
        data: {
          reportId,
          ownerId,
          merchant: 'Test Co',
          date: new Date(),
          amountMinor: 1000n,
          currencyId,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  it('uploadUrl returns a presigned PUT + report-prefixed key for the owner', async () => {
    const res = await makeCaller(RW, ownerId).receiptUploadUrl({
      expenseId,
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: 88_120,
    });
    // VeloExpense: the memory driver's URL, and the tenant's prefix (`receiptPrefix`).
    expect(res.url).toMatch(/^memory:\/\/upload\//);
    expect(res.key.startsWith(`${prefix()}/`)).toBe(true);
    // Bound to the declared size, so storage refuses a body of any other length.
    expect(storage.presignUpload).toHaveBeenLastCalledWith(
      res.key,
      'application/pdf',
      expect.objectContaining({ contentLength: 88_120 }),
    );
  });

  it('uploadUrl rejects an unsupported content type', async () => {
    await expect(
      makeCaller(RW, ownerId).receiptUploadUrl({
        expenseId,
        filename: 'x.zip',
        contentType: 'application/zip',
        sizeBytes: 100,
      }),
    ).rejects.toThrow(/Unsupported file type/);
  });

  it('uploadUrl 404s for a non-owner', async () => {
    await expect(
      makeCaller(RW, strangerId).receiptUploadUrl({
        expenseId,
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
      }),
    ).rejects.toThrow();
  });

  it('uploadUrl 403s without the updateOwn permission', async () => {
    await expect(
      makeCaller([P.expense.report.readOwn], ownerId).receiptUploadUrl({
        expenseId,
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // VeloExpense: asserted by code — VeloExpense's permission refusal is a translated
    // message rather than ExpenseOS's English one.
  });

  it('create rejects a key outside the report prefix (IDOR guard)', async () => {
    const caller = makeCaller(RW, ownerId);
    await expect(
      caller.receiptCreate({
        expenseId,
        key: `org/${h.orgId}/receipts/${strangerId}/evil.pdf`,
        filename: 'e.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
      }),
    ).rejects.toThrow(/Invalid receipt key/);
    await expect(
      caller.receiptCreate({
        expenseId,
        key: `${prefix()}/../escape.pdf`,
        filename: 'e.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
      }),
    ).rejects.toThrow(/Invalid receipt key/);
  });

  it('create persists a receipt (+ audit row); list & remove round-trip', async () => {
    const caller = makeCaller(RW, ownerId);
    const key = uploaded(`${prefix()}/00000000-0000-7000-8000-0000000000ab.pdf`, 2048);
    const created = await caller.receiptCreate({
      expenseId,
      key,
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    });
    expect(created.id).toBeTruthy();

    const row = await db.receipt.findUnique({
      where: { id: created.id },
      select: { expenseId: true, uploadedById: true, s3Key: true },
    });
    expect(row).toMatchObject({ expenseId, uploadedById: ownerId, s3Key: key });

    // VeloExpense: VeloExpense's audit chain and name for ExpenseOS's `report.receipt.attach`.
    const audit = await h.lastAudit('Expense', expenseId);
    expect(audit?.action).toBe('RECEIPT_ATTACHED');

    // f19: no view link until the malware scan says CLEAN (the worker writes the verdict).
    const unscanned = await caller.receiptList({ expenseId });
    expect(unscanned.items.find((i: { id: string }) => i.id === created.id)?.url).toBeNull();
    await h.admin.query(
      `INSERT INTO document_extraction (organization_id, receipt_id, scan_status) VALUES ($1, $2, 'CLEAN')`,
      [h.orgId, created.id],
    );

    const listed = await caller.receiptList({ expenseId });
    expect(
      listed.items.some(
        (i: { id: string; url: string }) =>
          i.id === created.id && i.url.startsWith('memory://download/'),
      ),
    ).toBe(true);

    const removed = await caller.receiptRemove({ id: created.id });
    expect(removed.ok).toBe(true);
    expect(storage.delete).toHaveBeenCalled();
    expect(await db.receipt.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it('list & remove 404 for a non-owner', async () => {
    const owner = makeCaller(RW, ownerId);
    const created = await owner.receiptCreate({
      expenseId,
      key: uploaded(`${prefix()}/00000000-0000-7000-8000-0000000000cd.pdf`, 512),
      filename: 'r.pdf',
      contentType: 'application/pdf',
      sizeBytes: 512,
    });
    const stranger = makeCaller(RW, strangerId);
    await expect(stranger.receiptList({ expenseId })).rejects.toThrow();
    await expect(stranger.receiptRemove({ id: created.id })).rejects.toThrow();
    await owner.receiptRemove({ id: created.id }); // cleanup
  });

  it('keeps evidence on a filed report: remove is refused, the row and object stay', async () => {
    /**
     * `receiptRemove` deletes the row AND the S3 object, and it used to check
     * ownership only — so the submitter could strip the receipt off a SUBMITTED,
     * APPROVED or REIMBURSED claim after the approver had looked at it. The DRAFT gate
     * every amount mutation already used now applies to the documents too.
     */
    const owner = makeCaller(RW, ownerId);
    const created = await owner.receiptCreate({
      expenseId,
      key: uploaded(`${prefix()}/00000000-0000-7000-8000-0000000000de.pdf`, 512),
      filename: 'kept.pdf',
      contentType: 'application/pdf',
      sizeBytes: 512,
    });
    storage.delete.mockClear();
    try {
      for (const status of ['SUBMITTED', 'APPROVED', 'REIMBURSED']) {
        await setStatus(status);
        await expect(owner.receiptRemove({ id: created.id })).rejects.toThrow(/not editable/i);
        await expect(
          owner.receiptMove({ id: created.id, toExpenseId: expenseId }),
        ).resolves.toEqual({ ok: true, removed: false }); // same expense: a no-op, not a write
        expect(await db.receipt.findUnique({ where: { id: created.id } })).not.toBeNull();
        expect(storage.delete).not.toHaveBeenCalled();
      }
      // Sent back for fixes, the submitter may take it off again.
      await setStatus('RETURNED');
      await owner.receiptRemove({ id: created.id });
      expect(await db.receipt.findUnique({ where: { id: created.id } })).toBeNull();
    } finally {
      await setStatus('DRAFT');
    }
  });

  it('accepts a new document while SUBMITTED and refuses one once decided', async () => {
    /**
     * An approver asking for a missing receipt mid-review is a real flow, so attaching
     * stays open through SUBMITTED. It closes with the decision: NetSuite's File
     * Cabinet push sends whatever is on the report at post time, and a document added
     * after approval is evidence the approver never saw.
     */
    const owner = makeCaller(RW, ownerId);
    const file = { filename: 'late.pdf', contentType: 'application/pdf', sizeBytes: 100 };
    try {
      await setStatus('SUBMITTED');
      const presigned = await owner.receiptUploadUrl({ expenseId, ...file });
      const created = await owner.receiptCreate({
        expenseId,
        key: uploaded(presigned.key, file.sizeBytes),
        ...file,
      });
      expect(created.id).toBeTruthy();

      for (const status of ['APPROVED', 'REJECTED', 'REIMBURSED']) {
        await setStatus(status);
        await expect(owner.receiptUploadUrl({ expenseId, ...file })).rejects.toThrow(/decided/);
        await expect(
          owner.receiptCreate({
            expenseId,
            key: uploaded(`${prefix()}/00000000-0000-7000-8000-0000000000ef.pdf`, 100),
            ...file,
          }),
        ).rejects.toThrow(/decided/);
        await expect(owner.startExtraction({ receiptIds: [created.id] })).rejects.toThrow(
          /decided/,
        );
      }
      expect(await db.receipt.count({ where: { expenseId } })).toBe(1);
    } finally {
      await setStatus('DRAFT');
      await db.receipt.deleteMany({ where: { expenseId } });
    }
  });
});
