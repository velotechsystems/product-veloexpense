// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../../server/__test-helpers__/tenantHarness';

/**
 * The joint determination's writes, against a real Postgres, while a submit races them.
 *
 * The unit suite pins the matrix — what is written for which locked status, and on which
 * client. This suite pins the one thing a stub cannot show: that `FOR UPDATE` on the
 * report row actually SERIALISES the apply against a concurrent `submit`, in BOTH orders.
 *
 * The window it closes: `determineAndRebuild` reads the report's status once, with a
 * plain read, BEFORE the model call — and that call polls for as long as an hour on the
 * Batch API. A report submitted in between used to have its merchant, its line set, its
 * tax, its FX snapshot, its determination and its report total rewritten anyway. A guard
 * that re-read the status without the lock would pass every unit test and still let the
 * submit land between the check and the write.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/lib/determine.db.test.ts` (550b2945),
 * Wave 3 (w3-02b). VeloExpense: the suite's own tenant (`createTenantHarness`) with its own
 * category and a report made through the ported procedure; `determineAndRebuild` runs as
 * the worker runs it — statement at a time in the tenant's scope (`withTenantStatements`),
 * so the `FOR UPDATE` and the audit row go through RLS as `veloapp`; a currency is its
 * code; the receipt is STORED (only a stored receipt is a document); table names are
 * VeloExpense's; and the audit row is `audit_entry`, the action its registry name.
 */

const h = vi.hoisted(() => ({
  determineExpense: vi.fn(),
  fetchCleanDocument: vi.fn(),
  prepareExtraction: vi.fn(),
  recordExtractionUsage: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

// Only the parts that leave the machine: the model call and the S3 fetch. Everything
// else — the FX resolver, the tax split, the GL snapshot, `supersedeDetermination`,
// `recomputeReportTotal` — runs for real, because the lock is what is on trial.
vi.mock('@expenseos/receipt-extraction', async (orig) => ({
  ...((await orig()) as object),
  determineExpense: h.determineExpense,
}));
vi.mock('./extract-core', () => ({
  fetchCleanDocument: h.fetchCleanDocument,
  prepareExtraction: h.prepareExtraction,
  message: (e: unknown) => String(e),
  // VeloExpense (d43): usage recording has its own tests (extract-core, determine-expense).
  recordExtractionUsage: h.recordExtractionUsage,
}));

const RW = [P.expense.report.readOwn, P.expense.report.createOwn, P.expense.report.updateOwn] as const;
vi.mock('./anthropic', () => ({ anthropicForExtraction: async () => null }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 'pending' if `p` has not settled within `ms`, else its outcome. */
async function settledWithin(p: Promise<unknown>, ms: number) {
  return Promise.race([
    p.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    sleep(ms).then(() => 'pending' as const),
  ]);
}

describe.skipIf(!process.env.DATABASE_URL)('determination writes under the report lock', () => {
  let th: TenantHarness;
  let db: any;
  let determineAndRebuild: typeof import('./determine').determineAndRebuild;
  let ownerId: string;
  let currencyId: string;
  let categoryId: string;
  let categories: any[];

  /** A DRAFT report with one blank expense and one already-CLEAN document on it. */
  async function fixture(): Promise<{ reportId: string; expenseId: string; receiptId: string }> {
    // VeloExpense: made through the ported procedure, as the other worker suites do.
    const report = await th.makeCaller(RW, ownerId).create({
      title: `determine lock ${Date.now()}-${Math.random()}`,
      currency: 'CAD',
    });
    const expense = await db.expense.create({
      data: { reportId: report.id, ownerId, currencyId, date: new Date(), amountMinor: 0n },
      select: { id: true },
    });
    const receipt = await db.receipt.create({
      data: {
        expenseId: expense.id,
        s3Key: `receipts/determine-lock/${report.id}.jpg`,
        filename: 'bill.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        uploadedById: ownerId,
        kind: 'OTHER',
        // VeloExpense: only a receipt whose object is verified in storage is a document.
        status: 'STORED',
      },
      select: { id: true },
    });
    await db.documentExtraction.create({
      data: { receiptId: receipt.id, scanStatus: 'CLEAN', status: 'EXTRACTED' },
      select: { id: true },
    });
    return { reportId: report.id, expenseId: expense.id, receiptId: receipt.id };
  }

  /** Everything the apply would write, read back in one go. */
  const stateOf = async (expenseId: string, reportId: string) => ({
    expense: await db.expense.findUniqueOrThrow({
      where: { id: expenseId },
      select: {
        merchant: true,
        amountMinor: true,
        taxGstHstMinor: true,
        taxSource: true,
        lineItems: { select: { amountMinor: true } },
      },
    }),
    report: await db.expenseReport.findUniqueOrThrow({
      where: { id: reportId },
      select: { status: true, totalMinor: true },
    }),
    receiptKind: (
      await db.receipt.findFirstOrThrow({
        where: { expenseId },
        select: { kind: true },
      })
    ).kind,
    determinations: await db.expenseDetermination.count({ where: { expenseId } }),
  });

  beforeAll(async () => {
    th = await createTenantHarness({ slug: 'determine', name: 'Determine' });
    db = th.db;
    const { determineAndRebuild: raw } = await import('./determine');
    const { withTenantStatements } = await import('@/lib/db/prisma');
    // VeloExpense: as the worker runs it — the job's tenant, statement at a time.
    determineAndRebuild = ((...args: Parameters<typeof raw>) =>
      withTenantStatements(th.orgId, () => raw(...args))) as typeof raw;

    ownerId = th.people[0].id;
    // VeloExpense: a currency's key is its code.
    currencyId = 'CAD';
    // VeloExpense: this suite's own category (ExpenseOS reads seeded ones).
    await db.expenseCategory.create({
      data: { label: { en: 'Determine meals' }, itcGstHstRate: 50, itcQstRate: 50, acceptsTip: true },
      select: { id: true },
    });
    categories = await db.expenseCategory.findMany({
      where: { active: true, isMileage: false },
      select: {
        id: true,
        label: true,
        itcGstHstRate: true,
        itcQstRate: true,
        pstRecoverable: true,
        acceptsTip: true,
        isMileage: true,
      },
    });
    categoryId = categories[0].id;

    h.fetchCleanDocument.mockResolvedValue({ data: new Uint8Array([1]), mimeType: 'image/jpeg' });
    h.prepareExtraction.mockResolvedValue({ data: new Uint8Array([1]), mimeType: 'image/jpeg' });
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await th?.end();
  });

  /** The model's answer: one $130.00 dinner with $13.00 GST on it. */
  function determination(receiptId: string) {
    return {
      model: 'db-test',
      confidence: 0.9,
      data: {
        documents: [
          { documentId: receiptId, kind: 'ITEMIZED_BILL', contributed: 'line detail + tax' },
        ],
        vendor: 'Acme Cafe',
        address: null,
        date: '2026-08-03',
        currencyCode: 'CAD',
        total: 130,
        subtotal: 117,
        taxGstHst: 13,
        taxQst: null,
        taxPst: null,
        lineItems: [
          { description: 'Dinner', amount: 130, quantity: 1, categoryCode: categoryId, tip: null },
        ],
        derivedCategoryCode: categoryId,
        fxRate: null,
        fxToCurrency: null,
        unresolved: null,
        confidence: 0.9,
      },
    };
  }

  it('makes a submit wait for an apply already in flight, and commits it whole', async () => {
    /**
     * Order 1: the apply holds the report row when the submit arrives.
     *
     * The apply is parked mid-transaction by holding the lock on the RECEIPT row it is
     * about to stamp — so it has taken the report lock and written the header, and has
     * not committed. The submit's plain UPDATE then queues behind the report lock. What
     * this proves is the shape of the outcome: the submit cannot interleave, so the
     * report it closes is the one with the rebuilt figures, and the expense is never
     * half-applied.
     */
    const { reportId, expenseId, receiptId } = await fixture();
    h.determineExpense.mockResolvedValue(determination(receiptId));

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const parkTheApply = db.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT id FROM receipt WHERE id = ${receiptId}::uuid FOR UPDATE`;
      await held;
    });

    await sleep(100);
    const apply = determineAndRebuild(expenseId, categories as never);
    // Parked on the receipt row — with the report row already locked.
    expect(await settledWithin(apply, 400)).toBe('pending');

    const submit = db.expenseReport.update({
      where: { id: reportId },
      data: { status: 'SUBMITTED' },
    });
    // The submit is behind the apply's report lock. Without it, it would commit here
    // and the rest of the apply would land on a filed report.
    expect(await settledWithin(submit, 400)).toBe('pending');

    release();
    await parkTheApply;
    expect(await apply).toEqual({ status: 'rebuilt' });
    await submit;

    const after = await stateOf(expenseId, reportId);
    // Applied WHOLE — header, receipt kind, lines, tax and the roll-up together.
    expect(after.expense).toMatchObject({
      merchant: 'Acme Cafe',
      amountMinor: 13_000n,
      taxGstHstMinor: 1300n,
      taxSource: 'EXTRACTED',
    });
    expect(after.expense.lineItems.map((l: { amountMinor: bigint }) => l.amountMinor)).toEqual([
      13_000n,
    ]);
    expect(after.receiptKind).toBe('ITEMIZED_BILL');
    expect(after.determinations).toBe(1);
    expect(after.report).toEqual({ status: 'SUBMITTED', totalMinor: 13_000n });
  });

  it('writes nothing when a submit lands first, and says so', async () => {
    /**
     * Order 2: the submit holds the report row when the apply arrives.
     *
     * The plain status read at the top of `determineAndRebuild` still sees DRAFT — READ
     * COMMITTED never shows the uncommitted UPDATE — which is exactly the window the old
     * code wrote through. The apply blocks on `lockReportStatus`, sees SUBMITTED once the
     * submit commits, and leaves the filed figures alone.
     */
    const { reportId, expenseId, receiptId } = await fixture();
    h.determineExpense.mockResolvedValue(determination(receiptId));
    const before = await stateOf(expenseId, reportId);

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const submit = db.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT id FROM expense_report WHERE id = ${reportId}::uuid FOR UPDATE`;
      await held;
      await tx.expenseReport.update({ where: { id: reportId }, data: { status: 'SUBMITTED' } });
    });

    await sleep(100);
    const apply = determineAndRebuild(expenseId, categories as never);
    expect(await settledWithin(apply, 400)).toBe('pending');

    release();
    await submit;
    expect(await apply).toEqual({
      status: 'skipped',
      reason: 'report became SUBMITTED while the determination ran',
    });

    const after = await stateOf(expenseId, reportId);
    expect(after.expense).toEqual(before.expense);
    expect(after.receiptKind).toBe('OTHER');
    expect(after.determinations).toBe(0);
    expect(after.report).toEqual({ status: 'SUBMITTED', totalMinor: 0n });

    // The refusal is on the record, so the receipt/expense disagreement has a reason.
    // VeloExpense: `audit_entry`, under the registry's name for ExpenseOS's
    // `report.extraction.skipped`.
    const audit = (
      await th.admin.query(
        `SELECT actor_name, details FROM audit_entry
          WHERE action = 'REPORT_EXTRACTION_SKIPPED' AND entity_id = $1`,
        [expenseId],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      actor_name: 'system:expense.determineExpense',
      details: { reportId, reportStatus: 'SUBMITTED' },
    });
  });
});
