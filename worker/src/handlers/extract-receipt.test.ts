// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the `expense.extractReceipt` handler's prefill logic. The
 * shared pipeline (`runDocumentExtraction`) and the Prisma client are mocked so
 * we exercise ONLY the handler's decisions: when it prefills, what it writes,
 * and where it respects manual input. The money helper is stubbed to keep
 * assertions deterministic.
 *
 * Model: one receipt = one expense (1:1). The extraction defines the whole line
 * set (category + amount only — no per-line tax), and tax lives on the EXPENSE:
 * the receipt's paid amounts (EXTRACTED) with recoverable ITC derived across the
 * line categories.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/extract-receipt.test.ts` (550b2945).
 * VeloExpense:
 *   · `db` is mocked where VeloExpense's comes from (`@/lib/db/prisma`), and the job names
 *     its tenant (`organizationId`);
 *   · the credential is `anthropicForExtraction` (the environment's key, d40), mocked in
 *     place of ExpenseOS's `resolveAnthropicConfig` — the threading assertions are the same;
 *   · a currency's key is its code, so an adopted currency is written as `CAD`, not an id;
 *   · the joint pass the second document hands off to names the tenant too.
 */

const h = vi.hoisted(() => ({
  db: {
    receipt: { findUnique: vi.fn(), count: vi.fn() },
    expenseCategory: { findMany: vi.fn() },
    expense: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    expenseLineItem: {
      create: vi.fn(),
      update: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
    expenseReport: { update: vi.fn() },
    platformConfig: { findFirst: vi.fn() },
    currency: { findUnique: vi.fn() },
    fxRate: { findFirst: vi.fn() },
    // The money lands inside one transaction that first locks the report row and
    // re-reads its status; both run against this same mock surface.
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
  withAudit: vi.fn(),
  runDocumentExtraction: vi.fn(),
  // Typed, so `mockResolvedValue` can hand it a config: an untyped `vi.fn` infers
  // `Promise<null>` from the default and rejects every real value.
  anthropicForExtraction: vi.fn<() => Promise<{ apiKey: string; model?: string } | null>>(
    async () => null,
  ),
  recomputeReportTotal: vi.fn(),
  supersedeDetermination: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock('@/lib/db/prisma', () => ({ db: h.db }));
// The Claude credential resolver — VeloExpense: the environment's key (d40). Controllable
// per test so the threading can be asserted.
vi.mock('./lib/anthropic', () => ({ anthropicForExtraction: h.anthropicForExtraction }));
vi.mock('@expenseos/db', () => ({
  ExpenseTaxSource: { CALCULATED: 'CALCULATED', EXTRACTED: 'EXTRACTED', MANUAL: 'MANUAL' },
  // The report total is the shared roll-up's job now, and the FX snapshot has its
  // own unit tests (packages/db/src/expenseFx.test.ts) — here they only need to
  // not be undefined. `fxColumns` returning {} keeps the assertions on the
  // expense update focused on what this handler decides.
  EXPENSE_FX_SELECT: {},
  fxColumns: () => ({}),
  // The GL snapshot is looked up per write; its own tests live in packages/db.
  glAccountIdsForCategories: async () => new Map(),
  fxParamsFrom: (row: { amountMinor: bigint }, over?: bigint) => ({
    amountMinor: over ?? row.amountMinor,
    currencyCode: 'USD',
    homeCurrency: 'USD',
  }),
  recomputeReportTotal: h.recomputeReportTotal,
  supersedeDetermination: h.supersedeDetermination,
  resolveExpenseFx: async () => ({
    fxRate: null,
    fxRateSource: null,
    homeCurrency: 'USD',
    homeAmountMinor: null,
  }),
  // The claimant-as-first-attendee helpers (packages/db/src/ownerAttendee.ts). Nobody is
  // added here; the rule and its audit row are pinned by prefill.db.test.ts.
  lockClaimantSnapshot: async (_tx: unknown, expenseId: string) => ({
    expenseId,
    hadRequiringLine: false,
  }),
  ensureClaimantAttendee: async () => null,
}));
vi.mock('./lib/extract-core', () => ({
  runDocumentExtraction: h.runDocumentExtraction,
  message: (e: unknown) => String(e),
}));
// The skip line the prefill writes when it refuses to touch a filed report. Mocked so
// the assertion is on the DECISION (was the row written, with which action), not on
// the hash chain, which has its own tests.
vi.mock('@expenseos/audit', () => ({
  withAudit: h.withAudit,
  writeAudit: async () => {},
  auditActions: {
    report: { extractionSkipped: 'report.extraction.skipped', update: 'report.update' },
  },
}));
vi.mock('@expenseos/jobs', () => ({ enqueue: h.enqueue }));
vi.mock('@expenseos/money', () => ({
  getCurrency: (code: string) => ({ exponent: code === 'JPY' ? 0 : 2 }),
  isKnownCurrency: (code: string) => ['USD', 'CAD', 'EUR', 'JPY'].includes(code.toUpperCase()),
}));

import { handleExtractReceipt } from './extract-receipt';

const ORG = '00000000-0000-4000-8000-000000000001';

const CATS = [
  {
    id: 'cat-meals',
    label: { en: 'Meals' },
    itcGstHstRate: 50,
    itcQstRate: 50,
    pstRecoverable: false,
    acceptsTip: true,
    isMileage: false,
  },
  {
    id: 'cat-travel',
    label: { en: 'Travel' },
    itcGstHstRate: 100,
    itcQstRate: 100,
    pstRecoverable: false,
  },
];

function extraction(over: Record<string, unknown> = {}) {
  return {
    vendor: 'Acme Cafe',
    address: '1 Main St',
    date: '2026-07-01',
    total: 11.3,
    subtotal: 10,
    mandatoryGratuity: null,
    voluntaryTip: null,
    taxGstHst: 1.3,
    taxQst: null,
    taxPst: null,
    derivedCategoryCode: 'cat-meals',
    ...over,
  } as never;
}

const RECEIPT = { id: 'r1', s3Key: 'k', contentType: 'image/jpeg', expenseId: 'e1' };
const BLANK_EXPENSE = {
  id: 'e1',
  reportId: 'rep1',
  merchant: null,
  currency: { code: 'USD' },
  report: { status: 'DRAFT' },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.db.expenseCategory.findMany.mockResolvedValue(CATS);
  h.db.platformConfig.findFirst.mockResolvedValue({ extractionReviewThreshold: 0.7 });
  // Sibling totals recompute reads (report-level sum). Empty by default.
  h.db.expense.findMany.mockResolvedValue([]);
  // One document on the expense by default — the single-receipt path, which
  // prefills from its own extraction rather than running a joint determination.
  h.db.receipt.count.mockResolvedValue(1);
  // A DRAFT report under the lock, and a transaction body run against the same mocks.
  h.db.$queryRaw.mockResolvedValue([{ status: 'DRAFT' }]);
  h.db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(h.db));
  h.withAudit.mockImplementation(async (_db: unknown, _env: unknown, fn: () => unknown) => fn());
});

/** The single `expense.update` call that carries the tax fields (taxSource). */
function taxUpdate() {
  return h.db.expense.update.mock.calls.map((c) => c[0].data).find((d) => 'taxSource' in d);
}

describe('handleExtractReceipt', () => {
  it('returns early when the receipt is not attached to an expense', async () => {
    h.db.receipt.findUnique.mockResolvedValue({ ...RECEIPT, expenseId: null });
    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });
    expect(h.runDocumentExtraction).not.toHaveBeenCalled();
  });

  it('does not prefill when extraction bails (returns null)', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(null);
    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });
    expect(h.db.expense.update).not.toHaveBeenCalled();
    expect(h.db.expenseLineItem.createMany).not.toHaveBeenCalled();
  });

  it('writes nothing once the report has left DRAFT, and records why', async () => {
    /**
     * Extraction is asynchronous by design and can land an hour after the upload —
     * after the person submitted and after an approver signed. The joint pass has
     * always refused to move a filed report's numbers; the single-document path did
     * not, so a receipt attached to an APPROVED report rewrote its amount, lines and
     * tax, and the report total followed, with nobody re-asked.
     */
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction());
    h.db.expense.findUnique.mockResolvedValue({ ...BLANK_EXPENSE, report: { status: 'APPROVED' } });

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    expect(h.db.expense.update).not.toHaveBeenCalled();
    expect(h.db.expenseLineItem.deleteMany).not.toHaveBeenCalled();
    expect(h.db.expenseLineItem.createMany).not.toHaveBeenCalled();
    expect(h.recomputeReportTotal).not.toHaveBeenCalled();
    // The refusal leaves a line — otherwise a receipt whose printed total disagrees
    // with its expense reads as a failed extraction.
    expect(h.withAudit).toHaveBeenCalledOnce();
    expect(h.withAudit.mock.calls[0][1]).toMatchObject({
      action: 'report.extraction.skipped',
      entityId: 'e1',
      actor: { kind: 'system' },
      details: { reportId: 'rep1', reportStatus: 'APPROVED', receiptId: 'r1' },
    });
  });

  it('does not let a failed audit write turn the refusal into a job failure', async () => {
    // The decision not to write stands on its own; the hash chain being busy must not
    // requeue the job, which would only try to write the same nothing again.
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction());
    h.db.expense.findUnique.mockResolvedValue({ ...BLANK_EXPENSE, report: { status: 'APPROVED' } });
    h.withAudit.mockRejectedValueOnce(new Error('chain lock timeout'));

    await expect(handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' })).resolves.toBeUndefined();
    expect(h.db.expense.update).not.toHaveBeenCalled();
    expect(h.db.expenseLineItem.createMany).not.toHaveBeenCalled();
  });

  it('writes nothing when a submit lands between the read and the write', async () => {
    /**
     * The first status read passes (DRAFT); by the time the money is written, the
     * row lock hands back SUBMITTED — the person submitted in the gap. The check under
     * the lock is the one that holds, which is why it exists.
     */
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction());
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);
    h.db.$queryRaw.mockResolvedValue([{ status: 'SUBMITTED' }]);

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    expect(taxUpdate()).toBeUndefined();
    expect(h.db.expenseLineItem.deleteMany).not.toHaveBeenCalled();
    expect(h.db.expenseLineItem.createMany).not.toHaveBeenCalled();
    expect(h.recomputeReportTotal).not.toHaveBeenCalled();
    expect(h.withAudit.mock.calls[0]?.[1]).toMatchObject({
      action: 'report.extraction.skipped',
      details: { reportStatus: 'SUBMITTED' },
    });
  });

  it('prefills a blank expense: header fields + a category-only line item', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction());
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    // Header fill + tax/total update.
    const updates = h.db.expense.update.mock.calls.map((c) => c[0].data);
    expect(updates.find((d) => 'merchant' in d)?.merchant).toBe('Acme Cafe');

    // Whole line set is (re)built for this expense (1:1 receipt).
    expect(h.db.expenseLineItem.deleteMany).toHaveBeenCalledWith({ where: { expenseId: 'e1' } });
    expect(h.db.expenseLineItem.createMany).toHaveBeenCalledOnce();
    const lines = h.db.expenseLineItem.createMany.mock.calls[0][0].data as Array<{
      categoryId: string;
      amountMinor: bigint;
    }>;
    expect(lines).toEqual([
      {
        expenseId: 'e1',
        categoryId: 'cat-meals',
        amountMinor: 1130n,
        kind: 'STANDARD',
        // Stamped on every write path. Null here because the stub category has no
        // GL account — a real answer, not an omission.
        glAccountId: null,
      },
    ]);
    // Line items carry no tax fields anymore.
    expect(lines[0]).not.toHaveProperty('taxGstHstMinor');
    expect(lines[0]).not.toHaveProperty('sourceReceiptId');
    // No tip on this receipt → no payload, and the line stays STANDARD.
    expect(lines[0]).not.toHaveProperty('payload');
  });

  it('puts an extracted tip on the line that earned it', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction({ voluntaryTip: 2 }));
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    const lines = h.db.expenseLineItem.createMany.mock.calls[0][0].data as Array<{
      kind: string;
      payload?: { tipMinor: string };
    }>;
    expect(lines[0].kind).toBe('STANDARD_WITH_TIP');
    expect(lines[0].payload).toEqual({ tipMinor: '200' });
  });

  it('leaves the tip off a category that does not accept one', async () => {
    // A tip on a software subscription is a data-entry mistake, not a fact.
    h.db.expenseCategory.findMany.mockResolvedValue([
      { ...CATS[0], id: 'cat-sw', label: { en: 'Software' }, acceptsTip: false },
    ]);
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(
      extraction({ voluntaryTip: 2, derivedCategoryCode: 'cat-sw' }),
    );
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    const lines = h.db.expenseLineItem.createMany.mock.calls[0][0].data as Array<{
      kind: string;
      payload?: unknown;
    }>;
    expect(lines[0].kind).toBe('STANDARD');
    expect(lines[0].payload).toBeUndefined();
  });

  it('adopts the receipt currency on a fresh expense (different from the default)', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    // Receipt is in CAD; the expense defaulted to USD (report currency).
    h.runDocumentExtraction.mockResolvedValue(extraction({ currencyCode: 'CAD' }));
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);
    h.db.currency.findUnique.mockResolvedValue({ code: 'CAD' });

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    // VeloExpense: a currency's key is its code, so the code is what is written.
    expect(h.db.currency.findUnique).toHaveBeenCalledWith({
      where: { code: 'CAD' },
      select: { code: true },
    });
    const header = h.db.expense.update.mock.calls
      .map((c) => c[0].data)
      .find((d) => 'merchant' in d);
    expect(header?.currencyId).toBe('CAD');
  });

  it('parses amounts at the adopted currency exponent (JPY has 0 decimals)', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    // ¥1130 total on a fresh USD expense → 1130 minor (yen). At exponent 0 this
    // stays 1130; a wrong exp=2 would balloon it to 113000.
    h.runDocumentExtraction.mockResolvedValue(
      extraction({ currencyCode: 'JPY', total: 1130, subtotal: 1130, taxGstHst: null }),
    );
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);
    h.db.currency.findUnique.mockResolvedValue({ code: 'JPY' });

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    const header = h.db.expense.update.mock.calls
      .map((c) => c[0].data)
      .find((d) => 'merchant' in d);
    expect(header?.currencyId).toBe('JPY');
    expect(taxUpdate()?.amountMinor).toBe(1130n);
  });

  it('does not change currency when the expense already has a manual header', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction({ currencyCode: 'CAD' }));
    h.db.expense.findUnique.mockResolvedValue({ ...BLANK_EXPENSE, merchant: 'User Entered' });

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    expect(h.db.currency.findUnique).not.toHaveBeenCalled();
    const header = h.db.expense.update.mock.calls
      .map((c) => c[0].data)
      .find((d) => 'merchant' in d);
    expect(header).toBeUndefined(); // manual header → no header update at all
  });

  it('writes expense-level tax (EXTRACTED) with engine-derived recoverable', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction());
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    const tax = taxUpdate();
    expect(tax?.taxSource).toBe('EXTRACTED');
    expect(tax?.amountMinor).toBe(1130n);
    expect(tax?.taxGstHstMinor).toBe(130n); // $1.30 paid HST
    expect(tax?.taxQstMinor).toBeNull(); // 0 collapses to null
    expect(tax?.taxPstMinor).toBeNull();
    // Meals ITC is 50% → recoverable is half the paid HST.
    expect(tax?.recoverableGstHstMinor).toBe(65n);
    expect(tax?.recoverableQstMinor).toBeNull();
  });

  it('grants no ITC when the owner legal entity cannot reclaim one', async () => {
    // The defect this fixes: prefill applied only the CATEGORY rate, so a
    // US-entity expense showed a credit here that silently vanished the next time
    // a line edit ran the tRPC path. The entity gate beats the category rate.
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction());
    h.db.expense.findUnique.mockResolvedValue({
      ...BLANK_EXPENSE,
      owner: { entity: { itcRecoverable: false } },
    });

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    const tax = taxUpdate();
    // The tax is still expensed…
    expect(tax?.taxGstHstMinor).toBe(130n);
    // …but nothing is reclaimable (0 collapses to null).
    expect(tax?.recoverableGstHstMinor).toBeNull();
    expect(tax?.recoverableQstMinor).toBeNull();
  });

  it('grants the category ITC when the entity CAN reclaim', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction());
    h.db.expense.findUnique.mockResolvedValue({
      ...BLANK_EXPENSE,
      owner: { entity: { itcRecoverable: true } },
    });

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    expect(taxUpdate()?.recoverableGstHstMinor).toBe(65n);
  });

  it('keeps a manual header but still (re)builds the receipt line items', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction());
    h.db.expense.findUnique.mockResolvedValue({ ...BLANK_EXPENSE, merchant: 'User Entered' });

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    // Manual header wins — no update carries the extracted merchant…
    const updates = h.db.expense.update.mock.calls.map((c) => c[0].data);
    expect(updates.some((d) => 'merchant' in d)).toBe(false);
    // …but line items are still (re)generated from the receipt.
    expect(h.db.expenseLineItem.deleteMany).toHaveBeenCalledWith({ where: { expenseId: 'e1' } });
    expect(h.db.expenseLineItem.createMany).toHaveBeenCalledOnce();
  });

  const multi = (over: Record<string, unknown> = {}) =>
    extraction({
      total: 30,
      subtotal: 30,
      taxGstHst: null,
      lineItems: [
        { description: 'Lunch', amount: 10, quantity: 1, categoryCode: 'cat-meals' },
        { description: 'Taxi', amount: 10, quantity: 1, categoryCode: 'cat-travel' },
        { description: 'Dinner', amount: 10, quantity: 1, categoryCode: 'cat-meals' },
      ],
      confidence: 0.9,
      derivedCategoryCode: 'cat-meals',
      ...over,
    });

  it('itemizes multiple lines, collapsing same-category, allocating the total by amount', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(multi());
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    expect(h.db.expenseLineItem.create).not.toHaveBeenCalled();
    expect(h.db.expenseLineItem.createMany).toHaveBeenCalledOnce();
    const lines = h.db.expenseLineItem.createMany.mock.calls[0][0].data as Array<{
      categoryId: string;
      amountMinor: bigint;
    }>;
    // meals (10+10) collapsed + travel (10) → 2 lines; total 3000 split 2000/1000.
    expect(lines).toHaveLength(2);
    const byCat = Object.fromEntries(lines.map((l) => [l.categoryId, l.amountMinor]));
    expect(byCat['cat-meals']).toBe(2000n);
    expect(byCat['cat-travel']).toBe(1000n);
    expect(lines.reduce((a, l) => a + l.amountMinor, 0n)).toBe(3000n);
  });

  it('falls back to the main receipt category for every line when confidence is low', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(multi({ confidence: 0.4 })); // < 0.7 threshold
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    const lines = h.db.expenseLineItem.createMany.mock.calls[0][0].data as Array<{
      categoryId: string;
      amountMinor: bigint;
    }>;
    // Per-line categories ignored → all collapse into the main category.
    expect(lines).toHaveLength(1);
    expect(lines[0].categoryId).toBe('cat-meals');
    expect(lines[0].amountMinor).toBe(3000n);
  });

  it('falls back to the main category for a line whose code is not a real category', async () => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(
      multi({
        lineItems: [
          { description: 'A', amount: 10, quantity: 1, categoryCode: 'cat-bogus' },
          { description: 'B', amount: 10, quantity: 1, categoryCode: 'cat-travel' },
        ],
        total: 20,
        subtotal: 20,
      }),
    );
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);

    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });

    const lines = h.db.expenseLineItem.createMany.mock.calls[0][0].data as Array<{
      categoryId: string;
    }>;
    const cats = lines.map((l) => l.categoryId).sort();
    // 'cat-bogus' is dropped to the main category (cat-meals); 'cat-travel' kept.
    expect(cats).toEqual(['cat-meals', 'cat-travel']);
  });
});

/**
 * The hand-off to the joint determination (rule 2).
 *
 * One document is already one answer, so it prefills as it always has and records
 * that conclusion as the determination. A second document changes the question —
 * a bill and its cardholder copy describe one charge, and only a reader that sees
 * both knows the difference between them is a tip — so the joint pass takes over
 * and this handler stops prefilling.
 */
describe('handleExtractReceipt · determination hand-off', () => {
  beforeEach(() => {
    h.db.receipt.findUnique.mockResolvedValue(RECEIPT);
    h.runDocumentExtraction.mockResolvedValue(extraction({ total: 20, subtotal: 20 }));
    h.db.expense.findUnique.mockResolvedValue(BLANK_EXPENSE);
  });

  it('single document: prefills, and records the determination', async () => {
    h.db.receipt.count.mockResolvedValue(1);
    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });
    // Prefilled (line items written) and no joint pass enqueued.
    expect(h.db.expenseLineItem.createMany).toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    // The determination exists so a later correction has somewhere to live.
    expect(h.supersedeDetermination).toHaveBeenCalledOnce();
    expect(h.supersedeDetermination.mock.calls[0][1]).toMatchObject({
      expenseId: 'e1',
      receiptIds: ['r1'],
    });
  });

  it("extracts with the integration's credential, not the ambient environment", async () => {
    /**
     * The point of the whole change: receipt extraction and the assistant read ONE
     * credential, and it is the integration's.
     *
     * Threaded from the handler rather than read inside the extraction package, because
     * a key read at the bottom of the stack is a key nobody can see is missing — which
     * is precisely how it ended up granted to the worker task and not the web task.
     */
    h.anthropicForExtraction.mockResolvedValue({ apiKey: 'installed-key', model: 'claude-sonnet-5' });
    h.db.receipt.count.mockResolvedValue(1);
    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });
    expect(h.runDocumentExtraction.mock.calls[0][0]).toMatchObject({
      anthropic: { apiKey: 'installed-key', model: 'claude-sonnet-5' },
    });
    // And the model RECORDED is the one that was actually used. Reading the env var
    // separately here is how the two drifted: an integration-pinned model would have
    // extracted correctly and then been logged as whatever the task definition said.
    expect(h.supersedeDetermination.mock.calls[0][1]).toMatchObject({
      model: 'claude-sonnet-5',
    });
  });

  it('leaves the model unpinned when the installation names none', async () => {
    // An empty override must not become an empty model — the package default stands.
    h.anthropicForExtraction.mockResolvedValue({ apiKey: 'k', model: undefined });
    h.db.receipt.count.mockResolvedValue(1);
    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });
    expect(h.runDocumentExtraction.mock.calls[0][0]).toMatchObject({
      anthropic: { apiKey: 'k', model: undefined },
    });
  });

  it('second document: hands off to the joint pass and does NOT prefill', async () => {
    h.db.receipt.count.mockResolvedValue(2);
    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });
    // VeloExpense: the joint pass is its own job, so it names the tenant.
    expect(h.enqueue).toHaveBeenCalledWith('expense.determineExpense', {
      organizationId: ORG,
      expenseId: 'e1',
    });
    // Prefilling here would fight the rebuild that is about to run.
    expect(h.db.expenseLineItem.createMany).not.toHaveBeenCalled();
    expect(h.supersedeDetermination).not.toHaveBeenCalled();
  });

  it('a failed enqueue never loses the upload', async () => {
    h.db.receipt.count.mockResolvedValue(2);
    h.enqueue.mockRejectedValueOnce(new Error('redis down'));
    // The per-document extraction already landed; the joint pass can be re-driven.
    await expect(handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' })).resolves.toBeUndefined();
  });

  it('VeloExpense: a scan re-poll carries the tenant, so the next attempt runs as it', async () => {
    h.db.receipt.count.mockResolvedValue(1);
    await handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' });
    const { rescheduleScan } = h.runDocumentExtraction.mock.calls[0][0] as {
      rescheduleScan: (delayMs: number, next: number) => Promise<void>;
    };
    await rescheduleScan(2000, 1);
    expect(h.enqueue).toHaveBeenCalledWith(
      'expense.extractReceipt',
      { organizationId: ORG, receiptId: 'r1', scanAttempt: 1 },
      { delayMs: 2000 },
    );
  });

  it('a failed determination write never fails the job', async () => {
    h.db.receipt.count.mockResolvedValue(1);
    h.supersedeDetermination.mockRejectedValueOnce(new Error('db down'));
    await expect(handleExtractReceipt({ organizationId: ORG, receiptId: 'r1' })).resolves.toBeUndefined();
    // The prefill still stands.
    expect(h.db.expenseLineItem.createMany).toHaveBeenCalled();
  });
});
