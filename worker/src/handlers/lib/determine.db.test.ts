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
  /** D5: make `writeAudit` throw AFTER it has written its row, to prove the rollback. */
  auditFails: false,
}));

// The real audit writer, except that D5 can make it throw once it has written. Only the
// exported `writeAudit` is replaced: `withAudit` calls the module-local function, so the
// `extractionSkipped` row is untouched. (ExpenseOS 67db2e33, #588.)
vi.mock('@expenseos/audit', async (orig) => {
  const actual = (await orig()) as typeof import('@expenseos/audit');
  return {
    ...actual,
    writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
      await actual.writeAudit(...args);
      if (h.auditFails) throw new Error('audit write failed (test)');
    },
  };
});

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

  // ── The claimant as the first attendee (ExpenseOS 67db2e33, #588) ─────────────────
  // Own fixtures: never `categories[0]`.
  const tag = 'determine-claimant';
  let claimOwnerId: string;
  let requiringId: string;

  /** A DRAFT report with one blank expense and one already-CLEAN document on it. */
  async function fixture(
    owner: string = ownerId,
  ): Promise<{ reportId: string; expenseId: string; receiptId: string }> {
    // VeloExpense: made through the ported procedure, as the other worker suites do.
    const report = await th.makeCaller(RW, owner).create({
      title: `determine lock ${Date.now()}-${Math.random()}`,
      currency: 'CAD',
    });
    const expense = await db.expense.create({
      data: { reportId: report.id, ownerId: owner, currencyId, date: new Date(), amountMinor: 0n },
      select: { id: true },
    });
    const receipt = await db.receipt.create({
      data: {
        expenseId: expense.id,
        s3Key: `receipts/determine-lock/${report.id}.jpg`,
        filename: 'bill.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        uploadedById: owner,
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

  const attendeesOf = (expenseId: string) =>
    db.expenseAttendee.findMany({
      where: { expenseId },
      select: { id: true, name: true, company: true, isExternal: true },
    });

  /** The system `REPORT_EDITED` rows on one expense — the claimant's audit trail.
   *  VeloExpense: `audit_entry`, under the registry's name for `report.update`. */
  const claimantAuditRows = async (expenseId: string) =>
    (
      await th.admin.query(
        `SELECT actor_id, actor_name, entity_type, entity_id, details FROM audit_entry
          WHERE action = 'REPORT_EDITED' AND entity_id = $1 ORDER BY sequence`,
        [expenseId],
      )
    ).rows.map((r: any) => ({
      actorId: r.actor_id,
      actorName: r.actor_name,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: r.details,
    }));

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

    claimOwnerId = (
      await th.admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, first_name, last_name, role_id)
         VALUES ($1, $2, 'Determine Claimant', 'Determine', 'Claimant', '019e3000-0000-7000-8000-000000000004')
         RETURNING id`,
        [th.orgId, `${tag}-owner@test.invalid`],
      )
    ).rows[0].id as string;
    const requiring = await db.expenseCategory.create({
      data: { label: { en: `${tag} requiring` }, requiresAttendees: true },
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
    requiringId = requiring.id;
    // Appended, so `categories[0]` — what the existing cases code to — is unchanged.
    categories.push(requiring);

    h.fetchCleanDocument.mockResolvedValue({ data: new Uint8Array([1]), mimeType: 'image/jpeg' });
    h.prepareExtraction.mockResolvedValue({ data: new Uint8Array([1]), mimeType: 'image/jpeg' });
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await th?.end();
  });

  /** The model's answer: one $130.00 dinner with $13.00 GST on it. */
  function determination(receiptId: string, cat: string = categoryId) {
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
          { description: 'Dinner', amount: 130, quantity: 1, categoryCode: cat, tip: null },
        ],
        derivedCategoryCode: cat,
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
    // Coded to a category that requires attendees, so the claimant rule is also on trial:
    // a determination thrown away adds no attendee either (D4).
    h.determineExpense.mockResolvedValue(determination(receiptId, requiringId));
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
    // D4: no attendee on the filed report, and the skip is the only audit line.
    expect(await attendeesOf(expenseId)).toEqual([]);
    expect(await claimantAuditRows(expenseId)).toEqual([]);
  });

  describe('the claimant as the first attendee (ExpenseOS 67db2e33, #588)', () => {
    it('D1: an applied rebuild into a requiring category adds the owner and one system row', async () => {
      const { expenseId, receiptId } = await fixture(claimOwnerId);
      h.determineExpense.mockResolvedValue(determination(receiptId, requiringId));

      expect(await determineAndRebuild(expenseId, categories as never)).toEqual({
        status: 'rebuilt',
      });

      const attendees = await attendeesOf(expenseId);
      expect(attendees).toEqual([
        { id: expect.any(String), name: 'Determine Claimant', company: null, isExternal: false },
      ]);
      // No `receiptId`/`receiptIds` key: the joint pass reads a document SET.
      expect(await claimantAuditRows(expenseId)).toEqual([
        {
          actorId: null,
          actorName: 'system:expense.determineExpense',
          entityType: 'Expense',
          entityId: expenseId,
          details: {
            claimantAttendeeAdded: true,
            claimantAttendeeId: attendees[0].id,
            expenseId,
            source: 'expense.determineExpense',
          },
        },
      ]);
    });

    it('D2: a line set the person owns (keepLineItems) is not rebuilt, so nobody is added', async () => {
      const { expenseId, receiptId } = await fixture(claimOwnerId);
      await db.expenseLineItem.create({
        data: { expenseId, categoryId: requiringId, amountMinor: 4200n, kind: 'STANDARD' },
      });
      // The human edited the lines after an earlier pass: the rebuild must leave them.
      await db.expenseDetermination.create({
        data: {
          expenseId,
          receiptIds: [receiptId],
          proposed: {},
          overrides: { lineItems: 'edited by hand' },
        },
      });
      h.determineExpense.mockResolvedValue(determination(receiptId, requiringId));

      expect(await determineAndRebuild(expenseId, categories as never)).toEqual({
        status: 'rebuilt',
      });

      const lines = await db.expenseLineItem.findMany({
        where: { expenseId },
        select: { categoryId: true, amountMinor: true },
      });
      expect(lines).toEqual([{ categoryId: requiringId, amountMinor: 4200n }]);
      expect(await attendeesOf(expenseId)).toEqual([]);
      expect(await claimantAuditRows(expenseId)).toEqual([]);
    });

    it('D3: a rebuild of lines that were already requiring adds nobody after the claimant was removed', async () => {
      const { expenseId, receiptId } = await fixture(claimOwnerId);
      // Already requiring, list empty — the owner removed themselves earlier.
      await db.expenseLineItem.create({
        data: { expenseId, categoryId: requiringId, amountMinor: 5000n, kind: 'STANDARD' },
      });
      h.determineExpense.mockResolvedValue(determination(receiptId, requiringId));

      expect(await determineAndRebuild(expenseId, categories as never)).toEqual({
        status: 'rebuilt',
      });

      // Rebuilt (the wipe ran) — and the "before" read was taken ahead of it.
      const lines = await db.expenseLineItem.findMany({
        where: { expenseId },
        select: { amountMinor: true },
      });
      expect(lines.map((l: { amountMinor: bigint }) => l.amountMinor)).toEqual([13_000n]);
      expect(await attendeesOf(expenseId)).toEqual([]);
      expect(await claimantAuditRows(expenseId)).toEqual([]);
    });

    it('D5: an audit failure rolls back the attendee and the determination; a retry succeeds once', async () => {
      const { reportId, expenseId, receiptId } = await fixture(claimOwnerId);
      h.determineExpense.mockResolvedValue(determination(receiptId, requiringId));
      const before = await stateOf(expenseId, reportId);

      h.auditFails = true;
      try {
        await expect(determineAndRebuild(expenseId, categories as never)).rejects.toThrow(
          'audit write failed (test)',
        );
      } finally {
        h.auditFails = false;
      }
      expect(await attendeesOf(expenseId)).toEqual([]);
      // Nothing of the pass survived: no lines, no money, no `supersedeDetermination` row.
      expect(await stateOf(expenseId, reportId)).toEqual(before);
      expect(before.determinations).toBe(0);
      expect(await claimantAuditRows(expenseId)).toEqual([]);

      expect(await determineAndRebuild(expenseId, categories as never)).toEqual({
        status: 'rebuilt',
      });
      expect(await attendeesOf(expenseId)).toHaveLength(1);
      expect(await claimantAuditRows(expenseId)).toHaveLength(1);
    });
  });
});
