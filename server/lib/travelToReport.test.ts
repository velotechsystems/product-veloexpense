import { describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';

// VeloExpense (w6-01): the report number comes from the tenant's sequence
// (`nextReportNumber`, a raw query the stubbed db cannot answer); ExpenseOS's comes from a
// column default and needs no stub.
vi.mock('@expenseos/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@expenseos/db')>()),
  nextReportNumber: vi.fn(async () => 'EXP-000042'),
}));
import { assertPrismaFields } from '../__test-helpers__/prismaShape';
import { buildReportFromTravel, reportTitle } from './travelToReport';

/**
 * The legacy `importItinerary` produced data that looked plausible and was wrong:
 * hardcoded USD, hardcoded "US-Default", invented amounts, and one lodging line per
 * night. Each of those is a test here, because "looks plausible" is precisely the
 * failure mode nobody catches by looking.
 */

const APPROVED = {
  id: 'trv-1',
  status: 'APPROVED',
  submitterId: 'u-ada',
  purpose: 'Customer visit',
  destinationLabel: 'Toronto, ON, Canada',
  destinationCity: 'Toronto',
  departDate: new Date('2026-09-01T00:00:00Z'),
  returnDate: new Date('2026-09-04T00:00:00Z'),
  currencyId: 'cur-cad',
  budgetLines: [
    {
      // A budget line codes to a TRAVEL category; the generated expense line codes to
      // the EXPENSE category it maps to. `expenseCategoryId` is that crossing.
      category: { id: 'tc-air', label: { en: 'Airfare' }, expenseCategoryId: 'c-air' },
      glAccountId: 'acct-air',
      amountMinor: 74200n,
      basis: 'QUOTE',
      notes: 'YUL→YYZ · Air Canada · nonstop',
      kind: 'AIRFARE',
      payload: { travelClass: 'ECONOMY', fromLabel: 'YUL', toLabel: 'YYZ', legs: [] },
    },
    {
      category: { id: 'tc-hotel', label: { en: 'Hotel' }, expenseCategoryId: 'c-hotel' },
      glAccountId: null,
      amountMinor: 60000n,
      basis: 'QUOTE',
      notes: 'The Drake · 3 nights',
      kind: 'LODGING',
      payload: { nights: 3, propertyName: 'The Drake' },
    },
  ],
};

function stubDb(over: { request?: Record<string, unknown>; existingReport?: unknown } = {}) {
  // `stubFn`, because the test reads the payload this was CALLED with — the
  // generated report's own shape is the assertion.
  const create = stubFn(async () => ({ id: 'rep-1' }));
  const db = {
    travelRequest: {
      findUniqueOrThrow: vi.fn(async () => ({ ...APPROVED, ...over.request })),
    },
    expenseReport: {
      findFirst: vi.fn(async () => over.existingReport ?? null),
      create,
    },
  } as never;
  return { db, create };
}

/** The `data` the report create was called with. */
function created(create: ReturnType<typeof vi.fn>) {
  return create.mock.calls[0][0].data;
}

describe('reportTitle', () => {
  it('names the destination and the span', () => {
    expect(
      reportTitle('Toronto', new Date('2026-09-01T00:00:00Z'), new Date('2026-09-04T00:00:00Z')),
    ).toBe('Toronto · Sep 1, 2026 – Sep 4, 2026');
  });

  it('is a single date for a one-way trip', () => {
    expect(reportTitle('Toronto', new Date('2026-09-01T00:00:00Z'), null)).toBe(
      'Toronto · Sep 1, 2026',
    );
  });
});

describe('buildReportFromTravel', () => {
  it('uses the REQUEST’s currency, not a hardcoded one', async () => {
    const { db, create } = stubDb();
    await buildReportFromTravel(db, 'trv-1');
    const data = created(create);
    expect(data.currencyId).toBe('cur-cad');
    for (const e of data.expenses.create) expect(e.currencyId).toBe('cur-cad');
  });

  it('uses the real destination as the location', async () => {
    // Legacy wrote "US-Default" on every generated line. A per-diem rule matches on
    // this string, so getting it right is also what makes the line checkable.
    const { db, create } = stubDb();
    await buildReportFromTravel(db, 'trv-1');
    for (const e of created(create).expenses.create) expect(e.placeText).toBe('Toronto');
  });

  it('falls back to the full label when there is no city', async () => {
    const { db, create } = stubDb({ request: { destinationCity: null } });
    await buildReportFromTravel(db, 'trv-1');
    expect(created(create).expenses.create[0].placeText).toBe('Toronto, ON, Canada');
  });

  it('carries the APPROVED amounts rather than inventing fractions of them', async () => {
    const { db, create } = stubDb();
    await buildReportFromTravel(db, 'trv-1');
    const amounts = created(create).expenses.create.map(
      (e: { amountMinor: bigint }) => e.amountMinor,
    );
    expect(amounts).toEqual([74200n, 60000n]);
    expect(created(create).totalMinor).toBe(134200n);
  });

  it('generates ONE lodging expense, not one per night', async () => {
    // A hotel issues one folio. Reconciling it against three lines is work nobody
    // needs.
    const { db, create } = stubDb();
    const out = await buildReportFromTravel(db, 'trv-1');
    expect(out.expenses).toBe(2);
    expect(created(create).expenses.create).toHaveLength(2);
  });

  it('carries the budget line’s GL account across, not the category’s', async () => {
    // The budget snapshotted the account when it was priced. Re-reading the category
    // here would let a re-pointing between approval and filing move the actuals away
    // from the budget they exist to be compared with.
    const { db, create } = stubDb();
    await buildReportFromTravel(db, 'trv-1');
    const lines = created(create).expenses.create.map(
      (e: { lineItems: { create: { glAccountId: string | null } } }) => e.lineItems.create,
    );
    expect(lines[0].glAccountId).toBe('acct-air');
    expect(lines[1].glAccountId).toBeNull();
  });

  it('links the report back to the request', async () => {
    expect((await stubDbAndBuild()).travelRequestId).toBe('trv-1');
  });

  it('numbers the report from the tenant’s sequence (VeloExpense)', async () => {
    // VeloExpense (w6-01): ExpenseOS's column default mints the number; here the router
    // must, or the report has none.
    expect((await stubDbAndBuild()).number).toBe('EXP-000042');
  });

  it('refuses a request that has not been approved', async () => {
    const { db } = stubDb({ request: { status: 'SUBMITTED' } });
    await expect(buildReportFromTravel(db, 'trv-1')).rejects.toThrow(/only an approved request/);
  });

  it('returns the existing DRAFT instead of building a rival copy', async () => {
    const { db, create } = stubDb({ existingReport: { id: 'rep-old', status: 'DRAFT' } });
    const out = await buildReportFromTravel(db, 'trv-1');
    // `skipped` is empty on a reuse: this call decided nothing, it reported what an
    // earlier one already did.
    expect(out).toEqual({ reportId: 'rep-old', expenses: 0, reused: true, skipped: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('skips a travel category that maps to no expense category, and says which', async () => {
    /**
     * There is no expense category to code the generated line to, and inventing one
     * would put a bucket in the accounting taxonomy no accountant chose. So the line
     * is dropped — but NAMED, because the traveller is about to file a report short by
     * that amount and finding out by arithmetic is worse than being told.
     */
    const { db, create } = stubDb({
      request: {
        budgetLines: [
          {
            category: { id: 'tc-air', label: { en: 'Airfare' }, expenseCategoryId: 'c-air' },
            glAccountId: 'acct-air',
            amountMinor: 74200n,
            basis: 'QUOTE',
            notes: null,
          },
          {
            category: { id: 'tc-visa', label: { en: 'Visa fees' }, expenseCategoryId: null },
            glAccountId: null,
            amountMinor: 15000n,
            basis: 'MANUAL',
            notes: null,
          },
        ],
      },
    });
    const out = await buildReportFromTravel(db, 'trv-1');
    expect(out.expenses).toBe(1);
    expect(out.skipped).toEqual([{ categoryId: 'tc-visa', label: { en: 'Visa fees' } }]);
    // The total follows the lines actually created, or the report opens disagreeing
    // with the sum of its own expenses.
    expect(create.mock.calls[0]?.[0]?.data?.totalMinor).toBe(74200n);
  });

  it('refuses once the report has been submitted', async () => {
    // That report is in an approval chain. Quietly generating a second copy of it is
    // worse than refusing.
    const { db } = stubDb({ existingReport: { id: 'rep-old', status: 'SUBMITTED' } });
    await expect(buildReportFromTravel(db, 'trv-1')).rejects.toThrow(/already has a submitted/);
  });

  it('is content with an approved request whose budget is empty', async () => {
    const { db, create } = stubDb({ request: { budgetLines: [] } });
    const out = await buildReportFromTravel(db, 'trv-1');
    expect(out.expenses).toBe(0);
    expect(created(create).totalMinor).toBe(0n);
  });
});

async function stubDbAndBuild() {
  const { db, create } = stubDb();
  await buildReportFromTravel(db, 'trv-1');
  return created(create);
}

describe('the generated payload matches the real schema', () => {
  /**
   * The guard for a whole class of bug that the stub above cannot see.
   *
   * `buildReportFromTravel` writes a nested `expenses: { create: [...] }`, and the
   * stubbed `create` accepts any shape at all — so when `Expense.location` was renamed
   * to `placeText`, this file kept passing while travel → report generation was
   * broken for every request that had a destination. Prisma throws
   * `Unknown argument \`location\`` only once the value is non-null, which is why it
   * looked fine in review and failed in use.
   *
   * `assertPrismaFields` reads `schema.prisma`, so this stays hermetic.
   */
  it('names only real ExpenseReport and Expense fields', async () => {
    const { db, create } = stubDb();
    await buildReportFromTravel(db, 'trv-1');
    assertPrismaFields('ExpenseReport', created(create), {
      expenses: 'Expense',
    });
  });

  it('puts the destination on placeText, the column that exists', async () => {
    // Not merely "a real field" — the RIGHT one. `placeText` is what per-diem rules
    // match on, so a destination written anywhere else silently stops matching.
    const { db, create } = stubDb();
    await buildReportFromTravel(db, 'trv-1');
    const data = created(create) as { expenses: { create: Array<{ placeText?: string }> } };
    expect(data.expenses.create[0].placeText).toBe('Toronto');
  });
});

// ── The approved cabin, carried across ────────────────────────────────────────

describe('the approved cabin', () => {
  /** The generated line items, in budget-line order. */
  const lineItems = (create: ReturnType<typeof stubDb>['create']) =>
    (
      created(create as never).expenses.create as Array<{
        lineItems: { create: { notes: string | null } };
      }>
    ).map((e) => e.lineItems.create);

  it('notes a premium cabin on the generated line', async () => {
    /**
     * Context for whoever reviews the claim, deliberately NOT something a rule keys on.
     * The cabin restriction blocks at REQUEST time; by expense time the only signal left
     * is the amount, and what makes an unexpected amount legible is knowing what was
     * approved.
     */
    const { db, create } = stubDb({
      request: {
        budgetLines: [
          {
            category: { id: 'tc-air', label: { en: 'Airfare' }, expenseCategoryId: 'c-air' },
            glAccountId: null,
            amountMinor: 480000n,
            basis: 'QUOTE',
            notes: 'YUL→LHR',
            kind: 'AIRFARE',
            payload: { travelClass: 'BUSINESS', fromLabel: 'YUL', toLabel: 'LHR', legs: [] },
          },
        ],
      },
    });
    await buildReportFromTravel(db, 'trv-1');
    expect(lineItems(create)[0].notes).toBe('Approved cabin · business');
  });

  it('says nothing for economy', async () => {
    // Every ordinary trip would otherwise carry a note saying nothing, and a note that is
    // always there is a note nobody reads.
    const { db, create } = stubDb();
    await buildReportFromTravel(db, 'trv-1');
    expect(lineItems(create)[0].notes).toBeNull();
  });

  it('says nothing on a line that is not a flight', async () => {
    // A LODGING payload has no cabin, and parsing it against the airfare schema would
    // report ECONOMY on a hotel.
    const { db, create } = stubDb();
    await buildReportFromTravel(db, 'trv-1');
    expect(lineItems(create)[1].notes).toBeNull();
  });

  it('says nothing on a payload it cannot read, rather than throwing', async () => {
    const { db, create } = stubDb({
      request: {
        budgetLines: [
          {
            category: { id: 'tc-air', label: { en: 'Airfare' }, expenseCategoryId: 'c-air' },
            glAccountId: null,
            amountMinor: 1n,
            basis: 'MANUAL',
            notes: null,
            kind: 'AIRFARE',
            payload: { travelClass: 99 },
          },
        ],
      },
    });
    await buildReportFromTravel(db, 'trv-1');
    expect(lineItems(create)[0].notes).toBeNull();
  });
});
