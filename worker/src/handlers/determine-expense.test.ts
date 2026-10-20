import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The joint determination's document loading (rule 2).
 *
 * The pass must SEE every document — that is the point of it — while re-scanning
 * only what has not been scanned. Getting that wrong is not a cost question: the
 * malware gate's last act is to drive `DocumentExtraction` to EXTRACTING, and both
 * the report page's poll and the workbench's editor lock read that column. Putting
 * a finished document back into EXTRACTING left the expense locked forever.
 */

const h = vi.hoisted(() => {
  /**
   * The transaction client the apply runs on, kept DISTINCT from the shared one.
   *
   * Every write the rebuild makes has to arrive here: a write issued on the shared
   * client escapes the report-row lock taken at the top of the transaction, which is
   * the whole point of the guard. Keeping the two objects separate is what lets the
   * suite assert that — `h.db.expense.update` never being called is a real assertion.
   */
  const tx = {
    expense: { update: vi.fn() },
    expenseLineItem: { deleteMany: vi.fn(), create: vi.fn() },
    receipt: { update: vi.fn() },
    // `lockReportStatus` is the real helper; this is the `SELECT … FOR UPDATE` it
    // issues, and its result is the status the guard actually reads.
    $queryRaw: vi.fn(),
  };
  return {
    tx,
    db: {
      expense: { findUnique: vi.fn(), update: vi.fn() },
      expenseCategory: { findMany: vi.fn() },
      expenseLineItem: { deleteMany: vi.fn(), create: vi.fn(), findMany: vi.fn() },
      receipt: { update: vi.fn() },
      currency: { findUnique: vi.fn() },
      $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    },
    prepareExtraction: vi.fn(),
    fetchCleanDocument: vi.fn(),
    determineExpense: vi.fn(),
    currentDetermination: vi.fn(),
    supersedeDetermination: vi.fn(),
    recomputeReportTotal: vi.fn(),
    resolveExpenseFx: vi.fn(),
    allocateRecoverable: vi.fn(),
    overridesForPrompt: vi.fn(),
    glAccountIds: vi.fn(),
    fxParamsFrom: vi.fn(),
    getCurrency: vi.fn(),
    isKnownCurrency: vi.fn(),
    tipPayload: vi.fn(),
    withAudit: vi.fn(),
    recordExtractionUsage: vi.fn(),
    // The claimant helpers (packages/db/src/ownerAttendee.ts) and the audit row they
    // lead to; the rule itself is pinned by determine.db.test.ts against a real Postgres.
    lockClaimantSnapshot: vi.fn(),
    ensureClaimantAttendee: vi.fn(),
    writeAudit: vi.fn(),
  };
});

// VeloExpense: the tenant-scoped client lives in `@/lib/db/prisma`, not `@expenseos/db`.
vi.mock('@/lib/db/prisma', () => ({ db: h.db }));
// VeloExpense: the Claude credential is the environment's (`./lib/anthropic`), not a
// database row. Null = "not configured", which these tests want: the extraction package is
// mocked anyway, so the only thing the real resolver would add is an env read.
vi.mock('./lib/anthropic', () => ({ anthropicForExtraction: async () => null }));
vi.mock('@expenseos/db', () => ({
  ExpenseTaxSource: { CALCULATED: 'CALCULATED', EXTRACTED: 'EXTRACTED', MANUAL: 'MANUAL' },
  EXPENSE_FX_SELECT: {},
  fxColumns: () => ({}),
  // The GL snapshot is looked up per write; its own tests live in packages/db.
  glAccountIdsForCategories: h.glAccountIds,
  fxParamsFrom: h.fxParamsFrom,
  currentDetermination: h.currentDetermination,
  overridesForPrompt: h.overridesForPrompt,
  recomputeReportTotal: h.recomputeReportTotal,
  resolveExpenseFx: h.resolveExpenseFx,
  supersedeDetermination: h.supersedeDetermination,
  lockClaimantSnapshot: h.lockClaimantSnapshot,
  ensureClaimantAttendee: h.ensureClaimantAttendee,
}));
vi.mock('@expenseos/audit', () => ({
  auditActions: {
    report: { extractionSkipped: 'report.extraction.skipped', update: 'report.update' },
  },
  withAudit: h.withAudit,
  writeAudit: h.writeAudit,
}));
vi.mock('./lib/extract-core', () => ({
  prepareExtraction: h.prepareExtraction,
  fetchCleanDocument: h.fetchCleanDocument,
  message: (e: unknown) => String(e),
  // VeloExpense (d43): the joint call is recorded in `ai_usage`.
  recordExtractionUsage: h.recordExtractionUsage,
}));
vi.mock('@expenseos/receipt-extraction', () => ({ determineExpense: h.determineExpense }));
vi.mock('@expenseos/tax', () => ({ allocateRecoverable: h.allocateRecoverable }));
vi.mock('@expenseos/expense-lines', () => ({ tipPayload: h.tipPayload }));
vi.mock('@expenseos/money', () => ({
  getCurrency: h.getCurrency,
  isKnownCurrency: h.isKnownCurrency,
}));

import { handleDetermineExpense } from './determine-expense';

/** VeloExpense: every tenant job carries its tenant (worker/src/lib/tenant.ts). */
const ORG = 'org-1';

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
];

/** Two documents: a bill scanned days ago, and a card copy scanned just now. */
const receipt = (id: string, scanStatus: string | null) => ({
  id,
  s3Key: `k/${id}`,
  contentType: 'image/jpeg',
  filename: `${id}.jpg`,
  extraction: scanStatus === null ? null : { scanStatus },
});

function expenseWith(receipts: ReturnType<typeof receipt>[], status = 'DRAFT') {
  return {
    id: 'e1',
    reportId: 'rep1',
    currencyId: 'CAD',
    amountMinor: 11300n,
    currency: { code: 'CAD' },
    fxRate: null,
    fxRateSource: null,
    owner: { entity: { itcRecoverable: true, homeCurrencyId: 'CAD' } },
    report: { status },
    receipts,
  };
}

const DETERMINATION = {
  model: 'claude-sonnet-5',
  confidence: 0.9,
  data: {
    documents: [
      { documentId: 'bill', kind: 'ITEMIZED_BILL', contributed: 'line detail + tax' },
      { documentId: 'copy', kind: 'CARD_COPY', contributed: 'the amount actually charged' },
    ],
    vendor: 'Acme Cafe',
    address: null,
    date: '2026-08-03',
    currencyCode: 'CAD',
    total: 130,
    subtotal: 100,
    taxGstHst: 13,
    taxQst: null,
    taxPst: null,
    lineItems: [
      { description: 'Dinner', amount: 130, quantity: 1, categoryCode: 'cat-meals', tip: 17 },
    ],
    derivedCategoryCode: 'cat-meals',
    fxRate: null,
    fxToCurrency: null,
    unresolved: null,
    confidence: 0.9,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.db.expenseCategory.findMany.mockResolvedValue(CATS);
  h.db.$transaction.mockImplementation(async (cb: (t: typeof h.tx) => unknown) => cb(h.tx));
  // The locked status, which is what the guard reads — DRAFT unless a test says otherwise.
  h.tx.$queryRaw.mockResolvedValue([{ status: 'DRAFT' }]);
  h.withAudit.mockImplementation(async (_db: unknown, _entry: unknown, body: () => unknown) =>
    body(),
  );
  h.tx.expense.update.mockResolvedValue({});
  h.db.currency.findUnique.mockResolvedValue({ code: 'CAD' });
  h.prepareExtraction.mockResolvedValue({ data: new Uint8Array([1]), mimeType: 'image/jpeg' });
  h.fetchCleanDocument.mockResolvedValue({ data: new Uint8Array([1]), mimeType: 'image/jpeg' });
  h.determineExpense.mockResolvedValue(DETERMINATION);
  h.currentDetermination.mockResolvedValue(null);
  h.resolveExpenseFx.mockResolvedValue({
    fxRate: null,
    fxRateSource: null,
    homeCurrency: 'CAD',
    homeAmountMinor: 13000n,
  });
  h.allocateRecoverable.mockReturnValue({
    recoverableGstHstMinor: 650n,
    recoverableQstMinor: 0n,
  });
  h.overridesForPrompt.mockReturnValue([]);
  h.glAccountIds.mockResolvedValue(new Map());
  h.fxParamsFrom.mockReturnValue({ amountMinor: 0n, currencyCode: 'CAD', homeCurrency: 'CAD' });
  h.getCurrency.mockReturnValue({ exponent: 2 });
  h.isKnownCurrency.mockReturnValue(true);
  h.tipPayload.mockReturnValue({ kind: 'STANDARD', payload: null });
  h.tx.expenseLineItem.create.mockResolvedValue({});
  h.tx.expenseLineItem.deleteMany.mockResolvedValue({ count: 0 });
  h.db.expenseLineItem.findMany.mockResolvedValue([]);
  h.tx.receipt.update.mockResolvedValue({});
  h.lockClaimantSnapshot.mockResolvedValue({ expenseId: 'e1', hadRequiringLine: false });
  // Nobody added unless a test says so.
  h.ensureClaimantAttendee.mockResolvedValue(null);
});

/** The `data` of the nth `expense.update` — the header write is 0, the totals write 1. */
const update = (n = 0) => h.tx.expense.update.mock.calls[n]?.[0]?.data;
/** The line rows the rebuild created, in order. */
const lines = () =>
  h.tx.expenseLineItem.create.mock.calls.map((c) => c[0].data as Record<string, unknown>);

describe('handleDetermineExpense · document loading', () => {
  it('re-reads an already-CLEAN document WITHOUT re-scanning it', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', 'CLEAN')]),
    );
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    // Nothing goes through the gate, so no DocumentExtraction status is touched —
    // this is what used to park finished files at EXTRACTING and lock the editor.
    expect(h.prepareExtraction).not.toHaveBeenCalled();
    expect(h.fetchCleanDocument).toHaveBeenCalledTimes(2);
  });

  it('gates a document that has never been scanned', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', null)]),
    );
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    // Exactly the unscanned one, and only it.
    expect(h.prepareExtraction).toHaveBeenCalledTimes(1);
    expect(h.prepareExtraction.mock.calls[0][0]).toMatchObject({ where: { receiptId: 'copy' } });
    expect(h.fetchCleanDocument).toHaveBeenCalledTimes(1);
  });

  it('gates a document whose scan is still pending rather than trusting it', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('copy', 'SCANNING')]));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.prepareExtraction).toHaveBeenCalledTimes(1);
    expect(h.fetchCleanDocument).not.toHaveBeenCalled();
  });

  it('sends EVERY readable document to the one determination call', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', 'CLEAN')]),
    );
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    const arg = h.determineExpense.mock.calls[0][0] as { documents: { documentId: string }[] };
    expect(arg.documents.map((d) => d.documentId)).toEqual(['bill', 'copy']);
  });

  it('drops an unreadable file instead of losing the whole determination', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', 'CLEAN')]),
    );
    h.fetchCleanDocument.mockResolvedValueOnce(null);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    const arg = h.determineExpense.mock.calls[0][0] as { documents: { documentId: string }[] };
    expect(arg.documents.map((d) => d.documentId)).toEqual(['copy']);
  });

  it('skips entirely when no document can be read', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.fetchCleanDocument.mockResolvedValue(null);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.determineExpense).not.toHaveBeenCalled();
    expect(h.tx.expenseLineItem.deleteMany).not.toHaveBeenCalled();
  });
});

describe('handleDetermineExpense · rebuild', () => {
  it('stamps what each document turned out to be', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', 'CLEAN')]),
    );
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.tx.receipt.update).toHaveBeenCalledWith({
      where: { id: 'bill' },
      data: { kind: 'ITEMIZED_BILL' },
    });
    expect(h.tx.receipt.update).toHaveBeenCalledWith({
      where: { id: 'copy' },
      data: { kind: 'CARD_COPY' },
    });
  });

  it('wipes and rebuilds the lines, then recomputes the report', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.tx.expenseLineItem.deleteMany).toHaveBeenCalledWith({ where: { expenseId: 'e1' } });
    expect(h.tx.expenseLineItem.create).toHaveBeenCalled();
    expect(h.supersedeDetermination).toHaveBeenCalled();
    // On the transaction client, under the lock the apply took — not the shared one.
    expect(h.recomputeReportTotal).toHaveBeenCalledWith(h.tx, 'rep1');
  });

  it('leaves a filed report alone — its numbers must not move under its approver', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')], 'SUBMITTED'));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.fetchCleanDocument).not.toHaveBeenCalled();
    expect(h.determineExpense).not.toHaveBeenCalled();
  });

  it('never throws when the model is unavailable', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockRejectedValue(new Error('ANTHROPIC_API_KEY is not configured'));
    await expect(handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' })).resolves.toBeUndefined();
    // Nothing was wiped, so the user's expense is exactly as they left it.
    expect(h.tx.expenseLineItem.deleteMany).not.toHaveBeenCalled();
  });
});

describe('handleDetermineExpense · human corrections survive the rebuild', () => {
  /**
   * Rule 3, and the one with real consequences. A rebuild that dropped somebody's
   * corrections would quietly re-introduce the mistake they fixed — and they would
   * only find out at approval, on a report they already believed was right.
   *
   * The overrides go INTO the prompt (so the pass reconciles to them) and are applied
   * again on the way OUT. They are parsed back out of the same rendered strings the
   * prompt was built from, so the model and the database cannot be told two different
   * things.
   */
  const withOverrides = (overrides: Record<string, string>) => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.currentDetermination.mockResolvedValue({ overrides });
  };

  it('keeps a corrected merchant, place and date over the model’s answer', async () => {
    withOverrides({ merchant: 'Chez Ada', location: 'Montréal, QC', date: '2026-07-01' });

    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });

    expect(update()).toMatchObject({ merchant: 'Chez Ada', placeText: 'Montréal, QC' });
    expect((update().date as Date).toISOString()).toContain('2026-07-01');
  });

  it('ignores an unparseable corrected date rather than writing Invalid Date', async () => {
    // The override map is free-form text from the UI; a bad date must fall through to
    // the model's, not poison the column.
    withOverrides({ date: 'last Tuesday' });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect((update().date as Date).toISOString()).toContain('2026-08-03'); // the model's
  });

  it('writes no date at all when neither the human nor the model has one', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockResolvedValue({
      ...DETERMINATION,
      data: { ...DETERMINATION.data, date: null },
    });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update()).not.toHaveProperty('date');
  });

  it('keeps corrected money, stripping the currency symbol the UI rendered', async () => {
    /**
     * The round-trip's sharp edge: what went into the prompt was "$1,250.00", so what
     * comes back out has to survive the symbol and the separators.
     */
    withOverrides({ total: '$1,250.00', subtotal: '1,100.00', taxGstHst: '$150.00' });

    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });

    expect(update().subtotalMinor).toBe(110_000n);
    expect(update(1).amountMinor).toBe(125_000n);
    expect(update(1).taxGstHstMinor).toBe(15_000n);
  });

  it('drops a corrected amount that is not a number', async () => {
    withOverrides({ total: 'about a hundred' });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    // Falls through to the line sum, not to NaN.
    expect(typeof update(1).amountMinor).toBe('bigint');
  });

  it('leaves the lines alone entirely when the human authored them', async () => {
    /**
     * `keepLineItems` is the strongest override: somebody split the bill by hand, and
     * a wipe-and-rebuild would throw that away. The existing rows are read back only
     * so tax still allocates across the real categories.
     */
    withOverrides({ lineItems: 'Dinner 100 / Drinks 30' });
    h.db.expenseLineItem.findMany.mockResolvedValue([
      { categoryId: 'cat-meals', amountMinor: 10_000n },
      { categoryId: 'cat-meals', amountMinor: 3_000n },
    ]);

    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });

    expect(h.tx.expenseLineItem.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.expenseLineItem.create).not.toHaveBeenCalled();
    // But the tax split still saw them, so the recoverable amount is still right.
    expect(h.allocateRecoverable.mock.calls[0][0].lines).toHaveLength(2);
    expect(update(1).amountMinor).toBe(13_000n);
  });

  it('prefers a human’s FX rate over anything extracted', async () => {
    withOverrides({ fxRate: '1.3712' });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.resolveExpenseFx.mock.calls[0][1].providedRate).toEqual({
      rate: '1.3712',
      source: 'MANUAL',
    });
  });
});

describe('handleDetermineExpense · the currency the set settled on', () => {
  const withCurrency = (currencyCode: string | null) => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockResolvedValue({
      ...DETERMINATION,
      data: { ...DETERMINATION.data, currencyCode },
    });
  };

  it('adopts a different currency the documents actually name', async () => {
    /**
     * Not cosmetic: every amount below is in THAT currency, and its exponent is what
     * parses them. Reading a ¥1,300 receipt with CAD's two decimals is a hundredfold
     * error, in the direction of paying it.
     */
    withCurrency('usd');
    h.db.currency.findUnique.mockResolvedValue({ code: 'USD' });

    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });

    expect(h.db.currency.findUnique).toHaveBeenCalledWith({
      where: { code: 'USD' }, // normalized
      select: { code: true },
    });
    expect(update()).toMatchObject({ currencyId: 'USD' });
  });

  it('parses the amounts with the adopted currency’s exponent', async () => {
    // JPY has none. 1300 yen is 1300 minor units, not 130,000.
    withCurrency('JPY');
    h.db.currency.findUnique.mockResolvedValue({ code: 'JPY' });
    h.getCurrency.mockReturnValue({ exponent: 0 });
    h.determineExpense.mockResolvedValue({
      ...DETERMINATION,
      data: {
        ...DETERMINATION.data,
        currencyCode: 'JPY',
        total: 1300,
        subtotal: 1300,
        taxGstHst: null,
        lineItems: [
          { description: 'Ramen', amount: 1300, quantity: 1, categoryCode: 'cat-meals', tip: null },
        ],
      },
    });

    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });

    expect(update().subtotalMinor).toBe(1300n);
    expect(lines()[0].amountMinor).toBe(1300n);
  });

  it('does not adopt a currency it does not know', async () => {
    // A hallucinated or mis-read code must not change what the expense is denominated
    // in — the existing currency is at least a real one somebody chose.
    withCurrency('XYZ');
    h.isKnownCurrency.mockReturnValue(false);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.db.currency.findUnique).not.toHaveBeenCalled();
    expect(update()).not.toHaveProperty('currencyId');
  });

  it('does not adopt a known code with no row behind it', async () => {
    withCurrency('USD');
    h.db.currency.findUnique.mockResolvedValue(null);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update()).not.toHaveProperty('currencyId');
  });

  it('leaves the currency alone when the set names the same one, or none', async () => {
    withCurrency('CAD');
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.db.currency.findUnique).not.toHaveBeenCalled();

    withCurrency(null);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.db.currency.findUnique).not.toHaveBeenCalled();
  });
});

describe('handleDetermineExpense · the rebuilt lines', () => {
  const withLines = (lineItems: unknown[], over: Record<string, unknown> = {}, cats = CATS) => {
    h.db.expenseCategory.findMany.mockResolvedValue(cats);
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockResolvedValue({
      ...DETERMINATION,
      data: { ...DETERMINATION.data, lineItems, ...over },
    });
  };

  it('keeps a tip only where the category admits one', async () => {
    /**
     * Otherwise the `acceptsTip` flag on ExpenseCategory is decorative, and a tip
     * shows up on a software renewal — which then has to be explained to an approver.
     */
    const cats = [
      ...CATS,
      { ...CATS[0], id: 'cat-software', label: { en: 'Software' }, acceptsTip: false },
    ];
    withLines(
      [
        { description: 'Dinner', amount: 130, quantity: 1, categoryCode: 'cat-meals', tip: 17 },
        { description: 'Seats', amount: 50, quantity: 1, categoryCode: 'cat-software', tip: 5 },
      ],
      {},
      cats,
    );

    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });

    expect(h.tipPayload.mock.calls.map((c) => c[0])).toEqual([1700n, 0n]);
  });

  it('rejects a tip that is not smaller than the line it sits inside', async () => {
    // A tip equal to (or larger than) the amount is a mis-read, not a generous diner —
    // and the line's net would go to zero or negative, which the tax split divides by.
    withLines([
      { description: 'Dinner', amount: 100, quantity: 1, categoryCode: 'cat-meals', tip: 100 },
    ]);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.tipPayload.mock.calls[0][0]).toBe(0n);
  });

  it('codes a line whose category the model invented to the fallback', async () => {
    withLines([
      { description: 'Dinner', amount: 130, quantity: 1, categoryCode: 'cat-nope', tip: null },
    ]);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(lines()[0].categoryId).toBe('cat-meals');
  });

  it('falls back to the first category when the derived one is invented too', async () => {
    // Coded to something is recoverable by a reviewer; coded to nothing is a line the
    // GL cannot accept at all.
    withLines(
      [{ description: 'Dinner', amount: 130, quantity: 1, categoryCode: null, tip: null }],
      {
        derivedCategoryCode: 'cat-nope',
      },
    );
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(lines()[0].categoryId).toBe('cat-meals');
  });

  it('drops a line with no amount, or a zero one', async () => {
    withLines([
      { description: 'Nothing', amount: null, quantity: 1, categoryCode: 'cat-meals', tip: null },
      { description: 'Free', amount: 0, quantity: 1, categoryCode: 'cat-meals', tip: null },
      { description: 'Dinner', amount: 130, quantity: 1, categoryCode: 'cat-meals', tip: null },
    ]);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(lines()).toHaveLength(1);
  });

  it('truncates a runaway description instead of failing the write', async () => {
    withLines([
      {
        description: 'x'.repeat(900),
        amount: 130,
        quantity: 1,
        categoryCode: 'cat-meals',
        tip: null,
      },
    ]);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect((lines()[0].notes as string).length).toBe(500);
  });

  it('stores a null note for a line the model did not describe', async () => {
    withLines([
      { description: null, amount: 130, quantity: 1, categoryCode: 'cat-meals', tip: null },
    ]);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(lines()[0].notes).toBeNull();
  });

  it('writes one whole-amount line when nothing itemized but a total is known', async () => {
    // Still coded, still adds up — a reviewer can split it; an expense with no lines
    // has nowhere to put a GL account.
    withLines([], { total: 130 });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(lines()).toHaveLength(1);
    expect(lines()[0].amountMinor).toBe(13_000n);
  });

  it('writes no line at all when there is neither an itemization nor a total', async () => {
    withLines([], { total: null });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.tx.expenseLineItem.deleteMany).toHaveBeenCalled(); // still wiped
    expect(h.tx.expenseLineItem.create).not.toHaveBeenCalled();
    expect(update(1).amountMinor).toBe(0n);
  });

  it('does nothing to the lines when there are no categories to code them to', async () => {
    withLines(
      [{ description: 'Dinner', amount: 130, quantity: 1, categoryCode: null, tip: null }],
      {
        derivedCategoryCode: null,
      },
      [],
    );
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.tx.expenseLineItem.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.expenseLineItem.create).not.toHaveBeenCalled();
  });

  it('attaches the GL account snapshot per line, in one lookup', async () => {
    withLines([
      { description: 'Dinner', amount: 130, quantity: 1, categoryCode: 'cat-meals', tip: null },
    ]);
    h.glAccountIds.mockResolvedValue(new Map([['cat-meals', 'gl-1']]));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.glAccountIds).toHaveBeenCalledTimes(1);
    expect(lines()[0].glAccountId).toBe('gl-1');
  });

  it('leaves the GL account null when the category has none mapped', async () => {
    withLines([
      { description: 'Dinner', amount: 130, quantity: 1, categoryCode: 'cat-meals', tip: null },
    ]);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(lines()[0].glAccountId).toBeNull();
  });

  it('ignores a verdict about a document that was not in this pass', async () => {
    // The model echoing an id we did not send it must not stamp some other expense's
    // receipt.
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.tx.receipt.update).toHaveBeenCalledTimes(1);
    expect(h.tx.receipt.update.mock.calls[0][0].where).toEqual({ id: 'bill' });
  });
});

describe('handleDetermineExpense · tax and totals', () => {
  const base = () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
  };

  it('stores nothing rather than zero for a tax that was not charged', async () => {
    /**
     * A stored 0 and a stored NULL read differently to a human: zero means "we looked
     * and there was none", null means "not applicable here". QST on an Ontario receipt
     * is the second.
     */
    base();
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update(1).taxGstHstMinor).toBe(1300n);
    expect(update(1).taxQstMinor).toBeNull();
    expect(update(1).taxPstMinor).toBeNull();
  });

  it('weights the recoverable split by each line’s net of tip', async () => {
    // The tip leaves the taxable base but stays inside its line's amount.
    base();
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.allocateRecoverable.mock.calls[0][0]).toMatchObject({
      gstHstMinor: 1300n,
      lines: [{ amountMinor: 11_300n, itcGstHstRate: 50, itcQstRate: 50 }],
      entityRecovers: true,
    });
  });

  it('assumes the entity recovers when it has no entity on file', async () => {
    // The tax-favourable default is the safe one here: it is visible on the report and
    // an approver can strike it, where a silently-forfeited ITC is money nobody sees.
    h.db.expense.findUnique.mockResolvedValue({
      ...expenseWith([receipt('bill', 'CLEAN')]),
      owner: { entity: null },
    });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.allocateRecoverable.mock.calls[0][0].entityRecovers).toBe(true);
  });

  it('honours an entity that does not recover', async () => {
    h.db.expense.findUnique.mockResolvedValue({
      ...expenseWith([receipt('bill', 'CLEAN')]),
      owner: { entity: { itcRecoverable: false, homeCurrencyId: 'CAD' } },
    });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.allocateRecoverable.mock.calls[0][0].entityRecovers).toBe(false);
  });

  it('defaults an unmapped category to fully recoverable', async () => {
    // Reading the lines back for a human-authored set gives category ids with no row
    // in the hint list; 100/100 matches the DB default rather than silently zeroing.
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.currentDetermination.mockResolvedValue({ overrides: { lineItems: 'authored' } });
    h.db.expenseLineItem.findMany.mockResolvedValue([
      { categoryId: 'cat-vanished', amountMinor: 10_000n },
    ]);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.allocateRecoverable.mock.calls[0][0].lines[0]).toMatchObject({
      itcGstHstRate: 100,
      itcQstRate: 100,
    });
  });

  it('totals from the lines rather than trusting the stated total', async () => {
    // The lines are what the GL sees; a header that disagrees with them is a report
    // that does not foot.
    h.db.expenseCategory.findMany.mockResolvedValue(CATS);
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockResolvedValue({
      ...DETERMINATION,
      data: {
        ...DETERMINATION.data,
        total: 999,
        lineItems: [
          { description: 'A', amount: 100, quantity: 1, categoryCode: 'cat-meals', tip: null },
          { description: 'B', amount: 30, quantity: 1, categoryCode: 'cat-meals', tip: null },
        ],
      },
    });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update(1).amountMinor).toBe(13_000n);
  });

  it('marks the tax as extracted, not calculated', async () => {
    base();
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update(1).taxSource).toBe('EXTRACTED');
  });
});

describe('handleDetermineExpense · FX from the statement', () => {
  const withFx = (fxRate: number | null, fxToCurrency: string | null, homeCode: string | null) => {
    h.db.expense.findUnique.mockResolvedValue({
      ...expenseWith([receipt('bill', 'CLEAN')]),
      owner: {
        entity: { itcRecoverable: true, homeCurrencyId: homeCode },
      },
    });
    h.determineExpense.mockResolvedValue({
      ...DETERMINATION,
      data: { ...DETERMINATION.data, fxRate, fxToCurrency },
    });
  };

  it('takes the rate off a statement that settled in the home currency', async () => {
    /**
     * A statement showing the same charge in the home currency IS the rate that was
     * applied to it — better evidence than the daily table, which is why EXTRACTED
     * outranks CALCULATED.
     */
    withFx(1.3712, 'cad', 'CAD');
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.resolveExpenseFx.mock.calls[0][1].providedRate).toEqual({
      rate: '1.3712',
      source: 'EXTRACTED',
    });
  });

  it('ignores a rate that converts to some third currency', async () => {
    // Only the leg that lands in the home currency is evidence of what was paid.
    withFx(1.09, 'EUR', 'CAD');
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.resolveExpenseFx.mock.calls[0][1].providedRate).toBeNull();
  });

  it('ignores a nonsensical rate', async () => {
    withFx(0, 'CAD', 'CAD');
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.resolveExpenseFx.mock.calls[0][1].providedRate).toBeNull();
  });

  it('ignores a rate with no target currency, and an entity with no home currency', async () => {
    withFx(1.37, null, 'CAD');
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.resolveExpenseFx.mock.calls[0][1].providedRate).toBeNull();

    withFx(1.37, 'CAD', null);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.resolveExpenseFx.mock.calls[1][1].providedRate).toBeNull();
  });

  it('keeps a rate already on the expense when the documents offer none', async () => {
    withFx(null, null, 'CAD');
    h.fxParamsFrom.mockReturnValue({
      amountMinor: 0n,
      currencyCode: 'CAD',
      providedRate: { rate: '1.4', source: 'CALCULATED' },
    });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.resolveExpenseFx.mock.calls[0][1].providedRate).toEqual({
      rate: '1.4',
      source: 'CALCULATED',
    });
  });
});

describe('handleDetermineExpense · the report the writes land on', () => {
  /**
   * The window this closes.
   *
   * `determineAndRebuild` checks the report's status ONCE, with a plain read, and it
   * takes that read BEFORE the model call. The model call is not quick — retries back
   * off for up to an hour and the Batch API polls for as long — so a person can submit,
   * and an approver can sign, while it is in flight. Every write below used to go
   * straight to the shared client with no lock: the merchant, the receipt kinds, the
   * whole line set, the tax, the FX snapshot, the determination and the report total
   * were restated on a claim somebody had already approved.
   *
   * So the apply re-reads the status under the report row's own lock and, unless the
   * report is still the submitter's, writes NOTHING.
   */
  const locked = (status: string | null) => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.tx.$queryRaw.mockResolvedValue(status === null ? [] : [{ status }]);
  };

  /** Every write the rebuild makes, on either client. */
  const writeCalls = () =>
    [
      h.tx.expense.update,
      h.tx.receipt.update,
      h.tx.expenseLineItem.deleteMany,
      h.tx.expenseLineItem.create,
      h.db.expense.update,
      h.db.receipt.update,
      h.db.expenseLineItem.deleteMany,
      h.db.expenseLineItem.create,
    ].reduce((n, m) => n + m.mock.calls.length, 0);

  it.each(['SUBMITTED', 'APPROVED', 'REIMBURSED', 'REJECTED'])(
    'writes nothing at all when the lock finds the report %s',
    async (status) => {
      locked(status);
      await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
      expect(writeCalls()).toBe(0);
      expect(h.supersedeDetermination).not.toHaveBeenCalled();
      expect(h.recomputeReportTotal).not.toHaveBeenCalled();
    },
  );

  it.each(['DRAFT', 'RETURNED'])(
    'applies the rebuild when the lock finds it %s',
    async (status) => {
      locked(status);
      await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
      expect(h.tx.expense.update).toHaveBeenCalledTimes(2); // header, then the money
      expect(h.tx.expenseLineItem.create).toHaveBeenCalled();
      expect(h.supersedeDetermination).toHaveBeenCalled();
      expect(h.recomputeReportTotal).toHaveBeenCalled();
    },
  );

  it('writes nothing when the report vanished under the job', async () => {
    // No row to lock is not an editable report; it is a report that is gone.
    locked(null);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(writeCalls()).toBe(0);
  });

  it('sends EVERY write to the transaction client, never the shared one', async () => {
    /**
     * The load-bearing assertion. A single write issued on `db` commits on its own
     * connection, outside the lock, and the guard becomes decoration — which is exactly
     * how this code looked before: `db.expense.update`, `db.receipt.update`,
     * `db.expenseLineItem.*`, `supersedeDetermination(db, …)`, `recomputeReportTotal(db, …)`.
     */
    locked('DRAFT');
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.db.expense.update).not.toHaveBeenCalled();
    expect(h.db.receipt.update).not.toHaveBeenCalled();
    expect(h.db.expenseLineItem.deleteMany).not.toHaveBeenCalled();
    expect(h.db.expenseLineItem.create).not.toHaveBeenCalled();
    expect(h.supersedeDetermination.mock.calls[0][0]).toBe(h.tx);
    expect(h.recomputeReportTotal).toHaveBeenCalledWith(h.tx, 'rep1');
  });

  it('takes the lock BEFORE it writes anything', async () => {
    // Order is the guarantee: a status read after the first write is a check that
    // cannot stop that write.
    locked('DRAFT');
    const seen: string[] = [];
    h.tx.$queryRaw.mockImplementation(async () => {
      seen.push('lock');
      return [{ status: 'DRAFT' }];
    });
    h.tx.expense.update.mockImplementation(async () => {
      seen.push('write');
      return {};
    });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(seen[0]).toBe('lock');
  });

  it('reads the claimant "before" ahead of the wipe, and writes its audit row last', async () => {
    /**
     * attendees-prefill-claimant. The snapshot after the wipe would make every rebuild
     * look like a first requiring line; the audit row anywhere but last would hold the
     * global audit-chain lock across the rest of the apply. Both on `tx`.
     */
    locked('DRAFT');
    const seen: string[] = [];
    const note = (label: string, result: unknown) => async () => {
      seen.push(label);
      return result;
    };
    h.lockClaimantSnapshot.mockImplementation(
      note('snapshot', { expenseId: 'e1', hadRequiringLine: false }),
    );
    h.tx.expenseLineItem.deleteMany.mockImplementation(note('wipe', { count: 0 }));
    h.tx.expenseLineItem.create.mockImplementation(note('line', {}));
    h.ensureClaimantAttendee.mockImplementation(note('ensure', 'att-1'));
    h.supersedeDetermination.mockImplementation(note('supersede', undefined));
    h.recomputeReportTotal.mockImplementation(note('rollup', undefined));
    h.writeAudit.mockImplementation(note('audit', undefined));

    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });

    expect(seen).toEqual(['snapshot', 'wipe', 'line', 'ensure', 'supersede', 'rollup', 'audit']);
    expect(h.lockClaimantSnapshot).toHaveBeenCalledWith(h.tx, 'e1');
    expect(h.writeAudit.mock.calls[0][0]).toBe(h.tx);
    expect(h.writeAudit.mock.calls[0][1]).toEqual({
      action: 'report.update',
      entityType: 'Expense',
      entityId: 'e1',
      actor: { kind: 'system', jobName: 'expense.determineExpense' },
      details: {
        claimantAttendeeAdded: true,
        claimantAttendeeId: 'att-1',
        expenseId: 'e1',
        source: 'expense.determineExpense',
      },
    });
  });

  it('writes no claimant audit row when nobody was added', async () => {
    locked('DRAFT');
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.ensureClaimantAttendee).toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it('keeps the model call OUT of the transaction', async () => {
    /**
     * A transaction opened before the model call would hold the report row for as long
     * as Anthropic takes — up to an hour — and block every submit on it. Everything the
     * write needs is resolved first; the transaction only writes.
     */
    locked('DRAFT');
    let openWhenModelRan = false;
    h.db.$transaction.mockImplementation(async (cb: (t: typeof h.tx) => unknown) => cb(h.tx));
    h.determineExpense.mockImplementation(async () => {
      openWhenModelRan = h.db.$transaction.mock.calls.length > 0;
      return DETERMINATION;
    });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(openWhenModelRan).toBe(false);
    // And the FX/GL reads the write depends on are resolved before it opens, too.
    expect(h.resolveExpenseFx.mock.calls[0][0]).toBe(h.db);
    expect(h.glAccountIds.mock.calls[0][0]).toBe(h.db);
  });

  it('leaves the refusal on the audit trail, the way the prefill does', async () => {
    // Otherwise a receipt that disagrees with its expense has no visible reason, and
    // the next person to look assumes the extraction failed.
    locked('APPROVED');
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.withAudit.mock.calls[0][1]).toMatchObject({
      action: 'report.extraction.skipped',
      entityType: 'Expense',
      entityId: 'e1',
      actor: { kind: 'system', jobName: 'expense.determineExpense' },
      details: { reportId: 'rep1', reportStatus: 'APPROVED', receiptIds: ['bill'] },
    });
  });

  it('does not fail the job when the refusal cannot be audited', async () => {
    locked('APPROVED');
    h.withAudit.mockRejectedValue(new Error('audit chain unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' })).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('handleDetermineExpense · nothing to do', () => {
  it('skips an expense that has been deleted underneath the job', async () => {
    h.db.expense.findUnique.mockResolvedValue(null);
    await expect(handleDetermineExpense({ organizationId: ORG, expenseId: 'gone' })).resolves.toBeUndefined();
    expect(h.determineExpense).not.toHaveBeenCalled();
  });

  it('skips an expense whose documents were all removed', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([]));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.determineExpense).not.toHaveBeenCalled();
  });

  it('rebuilds a RETURNED report, which is back in the submitter’s hands', async () => {
    // DRAFT and RETURNED are the two states where the numbers are still theirs to move.
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')], 'RETURNED'));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.determineExpense).toHaveBeenCalled();
  });
});

/**
 * VeloExpense (d43): the joint call is one model call, recorded once in `ai_usage`
 * against no single receipt — it read the whole set. Receipt reading is included in the
 * plan, so this is a usage record, never a credit charge.
 */
describe('handleDetermineExpense · usage (VeloExpense, d43)', () => {
  it('records the joint call once, as expense_determination', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', 'CLEAN')]),
    );
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.recordExtractionUsage).toHaveBeenCalledTimes(1);
    expect(h.recordExtractionUsage).toHaveBeenCalledWith(null, DETERMINATION, {
      feature: 'expense_determination',
    });
  });

  it('records nothing when the call never completed', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockRejectedValue(new Error('overloaded'));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(h.recordExtractionUsage).not.toHaveBeenCalled();
  });
});

/**
 * VeloExpense (f24): lines the model priced before tax. Seen on dev, 11 Oct: a $113 bill
 * and its $130 card slip came back as pre-tax lines plus the tip, so the expense — which
 * is totalled from its lines — was $117. The tax now spreads across the lines when the
 * gap is exactly the stated tax; any other disagreement keeps ExpenseOS's rule that the
 * lines win (the 999 case above).
 */
describe('handleDetermineExpense · lines priced before tax (VeloExpense, f24)', () => {
  const preTax = (over: Record<string, unknown> = {}) => ({
    ...DETERMINATION,
    data: {
      ...DETERMINATION.data,
      total: 130,
      subtotal: 100,
      taxGstHst: 13,
      lineItems: [
        { description: 'Steak frites', amount: 64, quantity: 2, categoryCode: 'cat-meals', tip: null },
        { description: 'Caesar salad', amount: 16, quantity: 1, categoryCode: 'cat-meals', tip: null },
        { description: 'Wine', amount: 37, quantity: 2, categoryCode: 'cat-meals', tip: 17 },
      ],
      ...over,
    },
  });

  it('the dev case: $100 of food, $13 HST and a $17 tip is $130, not $117', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', 'CLEAN')]),
    );
    h.determineExpense.mockResolvedValue(preTax());
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update(1).amountMinor).toBe(13_000n);
    // $113 of food and tax split 64 : 16 : 20, and the $17 tip stays on its line.
    expect(lines().map((l) => l.amountMinor)).toEqual([7232n, 1808n, 3960n]);
    expect(h.tipPayload).toHaveBeenLastCalledWith(1700n);
  });

  it('weights the recoverable split by each line net of its tip, after the spread', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockResolvedValue(preTax());
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(
      h.allocateRecoverable.mock.calls[0][0].lines.map((l: { amountMinor: bigint }) => l.amountMinor),
    ).toEqual([7232n, 1808n, 2260n]);
  });

  it('leaves the lines alone when the gap is not the tax', async () => {
    // $117 of lines against a $150 charge with $13 of tax: something else is wrong, and
    // a misread total must not rescale good lines.
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockResolvedValue(preTax({ total: 150 }));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(lines().map((l) => l.amountMinor)).toEqual([6400n, 1600n, 3700n]);
    expect(update(1).amountMinor).toBe(11_700n);
  });

  it('leaves lines that already include the tax alone', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(lines().map((l) => l.amountMinor)).toEqual([13_000n]);
    expect(update(1).amountMinor).toBe(13_000n);
  });

  it('honours a total a person corrected', async () => {
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockResolvedValue(preTax({ total: 999 }));
    h.overridesForPrompt.mockReturnValue([]);
    h.currentDetermination.mockResolvedValue({ overrides: { total: '$130.00' } });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update(1).amountMinor).toBe(13_000n);
  });
});

describe('reconcilePreTaxLines (VeloExpense, f24)', () => {
  it('spreads the tax and keeps tips, to the minor unit', async () => {
    const { reconcilePreTaxLines } = await import('./lib/determine');
    const lines = [
      { amountMinor: 6400n, tipMinor: 0n },
      { amountMinor: 1600n, tipMinor: 0n },
      { amountMinor: 3700n, tipMinor: 1700n },
    ];
    expect(reconcilePreTaxLines(lines, { charged: 13_000n, taxMinor: 1300n })).toBe(true);
    expect(lines.map((l) => l.amountMinor)).toEqual([7232n, 1808n, 3960n]);
    expect(lines.reduce((a, l) => a + l.amountMinor, 0n)).toBe(13_000n);
  });

  it('absorbs a cent of rounding, and no more', async () => {
    const { reconcilePreTaxLines } = await import('./lib/determine');
    const off = [{ amountMinor: 3333n, tipMinor: 0n }, { amountMinor: 3333n, tipMinor: 0n }];
    expect(reconcilePreTaxLines(off, { charged: 7533n, taxMinor: 866n })).toBe(true);
    expect(off[0].amountMinor + off[1].amountMinor).toBe(7533n);
    const far = [{ amountMinor: 3333n, tipMinor: 0n }];
    expect(reconcilePreTaxLines(far, { charged: 9000n, taxMinor: 866n })).toBe(false);
    expect(far[0].amountMinor).toBe(3333n);
  });

  it('does nothing without a charge, without tax, or when the lines already match', async () => {
    const { reconcilePreTaxLines } = await import('./lib/determine');
    const l = () => [{ amountMinor: 10_000n, tipMinor: 0n }];
    expect(reconcilePreTaxLines(l(), { charged: null, taxMinor: 1300n })).toBe(false);
    expect(reconcilePreTaxLines(l(), { charged: 11_300n, taxMinor: 0n })).toBe(false);
    expect(reconcilePreTaxLines(l(), { charged: 10_000n, taxMinor: 1300n })).toBe(false);
  });
});

/**
 * VeloExpense (f24, d45): with proof of payment in the set — a card copy or a statement —
 * the charged total is the evidence, and the lines are scaled to it whatever the gap. Seen on
 * dev, 11 Oct, after the pre-tax rule shipped: a $76.84 bill and its $90.00 card slip came
 * back as lines of 48 + 12 + 20.84 (the last holding the $13.16 tip) — neither tax-inclusive
 * nor exactly pre-tax — and the expense was $80.84.
 */
describe('handleDetermineExpense · proof of payment sets the total (VeloExpense, d45)', () => {
  const birch = {
    ...DETERMINATION,
    data: {
      ...DETERMINATION.data,
      documents: [
        { documentId: 'bill', kind: 'ITEMIZED_BILL', contributed: 'line detail + tax' },
        { documentId: 'copy', kind: 'CARD_COPY', contributed: 'the amount actually charged' },
      ],
      total: 90,
      subtotal: 68,
      taxGstHst: 8.84,
      lineItems: [
        { description: 'Burger', amount: 48, quantity: 2, categoryCode: 'cat-meals', tip: null },
        { description: 'Fries', amount: 12, quantity: 1, categoryCode: 'cat-meals', tip: null },
        { description: 'Iced tea', amount: 20.84, quantity: 2, categoryCode: 'cat-meals', tip: 13.16 },
      ],
    },
  };

  it('the dev case: a $90.00 card slip makes the expense $90.00, tip kept', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', 'CLEAN')]),
    );
    h.determineExpense.mockResolvedValue(birch);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update(1).amountMinor).toBe(9_000n);
    // $76.84 split 48 : 12 : 7.68 by largest remainder, and the $13.16 tip stays put.
    expect(lines().map((l) => l.amountMinor)).toEqual([5450n, 1362n, 2188n]);
    expect(h.tipPayload).toHaveBeenLastCalledWith(1316n);
  });

  it('a statement is proof of payment too', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', 'CLEAN')]),
    );
    h.determineExpense.mockResolvedValue({
      ...birch,
      data: {
        ...birch.data,
        documents: [
          { documentId: 'bill', kind: 'ITEMIZED_BILL', contributed: 'line detail + tax' },
          { documentId: 'copy', kind: 'BANK_STATEMENT', contributed: 'the settled amount' },
        ],
      },
    });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update(1).amountMinor).toBe(9_000n);
  });

  it('a verdict about a document outside this pass is not proof', async () => {
    // Only the bill was loaded; a CARD_COPY verdict for a file not in the set is the model
    // talking about something it was not shown.
    h.db.expense.findUnique.mockResolvedValue(expenseWith([receipt('bill', 'CLEAN')]));
    h.determineExpense.mockResolvedValue(birch);
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(lines().map((l) => l.amountMinor)).toEqual([4800n, 1200n, 2084n]);
    expect(update(1).amountMinor).toBe(8_084n);
  });

  it('without proof of payment the lines still win, as in ExpenseOS', async () => {
    h.db.expense.findUnique.mockResolvedValue(
      expenseWith([receipt('bill', 'CLEAN'), receipt('copy', 'CLEAN')]),
    );
    h.determineExpense.mockResolvedValue({
      ...birch,
      data: {
        ...birch.data,
        documents: [
          { documentId: 'bill', kind: 'ITEMIZED_BILL', contributed: 'line detail + tax' },
          { documentId: 'copy', kind: 'RECEIPT', contributed: 'a duplicate' },
        ],
      },
    });
    await handleDetermineExpense({ organizationId: ORG, expenseId: 'e1' });
    expect(update(1).amountMinor).toBe(8_084n);
  });
});

describe('reconcileToCharged (VeloExpense, d45)', () => {
  it('scales to the charge, keeps tips, adds up to the minor unit', async () => {
    const { reconcileToCharged } = await import('./lib/determine');
    const lines = [
      { amountMinor: 4800n, tipMinor: 0n },
      { amountMinor: 1200n, tipMinor: 0n },
      { amountMinor: 2084n, tipMinor: 1316n },
    ];
    expect(reconcileToCharged(lines, 9_000n)).toBe(true);
    expect(lines.map((l) => l.amountMinor)).toEqual([5450n, 1362n, 2188n]);
  });

  it('does nothing without a charge, when it already matches, or when tips exceed it', async () => {
    const { reconcileToCharged } = await import('./lib/determine');
    const l = () => [{ amountMinor: 1000n, tipMinor: 200n }];
    expect(reconcileToCharged(l(), null)).toBe(false);
    expect(reconcileToCharged(l(), 1000n)).toBe(false);
    expect(reconcileToCharged(l(), 150n)).toBe(false);
  });
});
