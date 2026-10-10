// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { explainExpenseTax, resolveExpenseTax } from './expenseTax';

// String literals rather than the ExpenseTaxSource enum value — importing the
// value from @expenseos/db loads the Prisma client (needs DATABASE_URL). The
// literals are assignable to the ExpenseTaxSource string-union type.

/** Minimal stub of the two delegates resolveExpenseTax reads. */
function stubDb(opts: {
  categories: { id: string; itcGstHstRate: number; itcQstRate: number }[];
  jurisdiction?: {
    gstRate: number;
    hstRate: number;
    pstRate: number;
    qstRate: number;
    salesTaxRate: number;
  } | null;
}) {
  return {
    expenseCategory: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        opts.categories.filter((c) => where.id.in.includes(c.id)),
    },
    taxJurisdiction: { findUnique: async () => opts.jurisdiction ?? null },
  } as never;
}

const ONTARIO = { gstRate: 0, hstRate: 13, pstRate: 0, qstRate: 0, salesTaxRate: 0 };

describe('resolveExpenseTax', () => {
  it('CALCULATED reverse-calcs HST and full ITC from the gross', async () => {
    const tax = await resolveExpenseTax(
      stubDb({
        categories: [{ id: 'c1', itcGstHstRate: 100, itcQstRate: 100 }],
        jurisdiction: ONTARIO,
      }),
      {
        grossMinor: 11300n, // $113.00 incl. 13% HST → $100.00 net + $13.00 HST
        taxJurisdictionId: 'j1',
        taxSource: 'CALCULATED',
        // explicit is ignored for CALCULATED even if present
        explicit: { gstHstMinor: 999n },
        lines: [{ categoryId: 'c1', amountMinor: 11300n }],
      },
    );
    expect(tax.taxGstHstMinor).toBe(1300n);
    expect(tax.recoverableGstHstMinor).toBe(1300n);
    expect(tax.taxQstMinor).toBe(0n);
  });

  it('leaves a voluntary tip out of the taxable base', async () => {
    // $113.00 of food+HST plus a $20.00 tip. The tip is reimbursed but never
    // taxed, so the HST is still $13.00 — not 13/113 of $133.00.
    const tax = await resolveExpenseTax(
      stubDb({
        categories: [{ id: 'meal', itcGstHstRate: 50, itcQstRate: 50 }],
        jurisdiction: ONTARIO,
      }),
      {
        grossMinor: 13300n,
        untaxedTipMinor: 2000n,
        taxJurisdictionId: 'j1',
        taxSource: 'CALCULATED',
        lines: [{ categoryId: 'meal', amountMinor: 13300n }],
      },
    );
    expect(tax.taxGstHstMinor).toBe(1300n);
    // …and the credit follows the tax, at the meal rate.
    expect(tax.recoverableGstHstMinor).toBe(650n);
  });

  it('keeps taxing the whole gross when there is no tip', async () => {
    const tax = await resolveExpenseTax(
      stubDb({
        categories: [{ id: 'c1', itcGstHstRate: 100, itcQstRate: 100 }],
        jurisdiction: ONTARIO,
      }),
      {
        grossMinor: 13300n,
        untaxedTipMinor: 0n,
        taxJurisdictionId: 'j1',
        taxSource: 'CALCULATED',
        lines: [{ categoryId: 'c1', amountMinor: 13300n }],
      },
    );
    expect(tax.taxGstHstMinor).toBe(1530n);
  });

  it('ignores a nonsensical tip larger than the expense rather than inventing a credit', async () => {
    const tax = await resolveExpenseTax(
      stubDb({
        categories: [{ id: 'c1', itcGstHstRate: 100, itcQstRate: 100 }],
        jurisdiction: ONTARIO,
      }),
      {
        grossMinor: 11300n,
        untaxedTipMinor: 99_999n,
        taxJurisdictionId: 'j1',
        taxSource: 'CALCULATED',
        lines: [{ categoryId: 'c1', amountMinor: 11300n }],
      },
    );
    expect(tax.taxGstHstMinor).toBe(1300n);
  });

  it('leaves EXPLICIT tax alone — a tip cannot change an amount off the receipt', async () => {
    const tax = await resolveExpenseTax(
      stubDb({
        categories: [{ id: 'c1', itcGstHstRate: 100, itcQstRate: 100 }],
        jurisdiction: ONTARIO,
      }),
      {
        grossMinor: 13300n,
        untaxedTipMinor: 2000n,
        taxJurisdictionId: 'j1',
        taxSource: 'EXTRACTED',
        explicit: { gstHstMinor: 1300n },
        lines: [{ categoryId: 'c1', amountMinor: 13300n }],
      },
    );
    expect(tax.taxGstHstMinor).toBe(1300n);
  });

  it('MANUAL trusts the explicit tax but derives the recoverable slice (50% meal)', async () => {
    const tax = await resolveExpenseTax(
      stubDb({
        categories: [{ id: 'meal', itcGstHstRate: 50, itcQstRate: 50 }],
        jurisdiction: ONTARIO,
      }),
      {
        grossMinor: 11300n,
        taxJurisdictionId: 'j1',
        taxSource: 'MANUAL',
        explicit: { gstHstMinor: 1300n },
        lines: [{ categoryId: 'meal', amountMinor: 11300n }],
      },
    );
    // explicit-wins on the paid amount…
    expect(tax.taxGstHstMinor).toBe(1300n);
    // …but the recoverable ITC is engine-derived at the category's 50%.
    expect(tax.recoverableGstHstMinor).toBe(650n);
  });

  it('allocates the recoverable across mixed-category lines by amount × ITC%', async () => {
    const tax = await resolveExpenseTax(
      stubDb({
        categories: [
          { id: 'meal', itcGstHstRate: 50, itcQstRate: 50 },
          { id: 'travel', itcGstHstRate: 100, itcQstRate: 100 },
        ],
        jurisdiction: ONTARIO,
      }),
      {
        grossMinor: 11300n, // net $100 + $13 HST
        taxJurisdictionId: 'j1',
        taxSource: 'CALCULATED',
        // Equal gross split → $6.50 HST each; recoverable = 6.50×50% + 6.50×100%.
        lines: [
          { categoryId: 'meal', amountMinor: 5650n },
          { categoryId: 'travel', amountMinor: 5650n },
        ],
      },
    );
    expect(tax.taxGstHstMinor).toBe(1300n);
    expect(tax.recoverableGstHstMinor).toBe(975n); // 325 (meal) + 650 (travel)
  });

  it('itcRecoverable=false forces the recoverable GST/HST slice to 0 (A6)', async () => {
    const tax = await resolveExpenseTax(
      stubDb({
        categories: [{ id: 'c1', itcGstHstRate: 100, itcQstRate: 100 }],
        jurisdiction: ONTARIO,
      }),
      {
        grossMinor: 11300n,
        taxJurisdictionId: 'j1',
        taxSource: 'CALCULATED',
        lines: [{ categoryId: 'c1', amountMinor: 11300n }],
        itcRecoverable: false,
      },
    );
    // Tax is still expensed…
    expect(tax.taxGstHstMinor).toBe(1300n);
    // …but a non-registrant entity can't reclaim any of it.
    expect(tax.recoverableGstHstMinor).toBe(0n);
  });

  it('no jurisdiction → no tax computed', async () => {
    const tax = await resolveExpenseTax(
      stubDb({ categories: [{ id: 'c1', itcGstHstRate: 100, itcQstRate: 100 }] }),
      {
        grossMinor: 5000n,
        taxJurisdictionId: null,
        taxSource: 'CALCULATED',
        lines: [{ categoryId: 'c1', amountMinor: 5000n }],
      },
    );
    expect(tax.taxGstHstMinor).toBe(0n);
    expect(tax.taxQstMinor).toBe(0n);
    expect(tax.recoverableGstHstMinor).toBe(0n);
  });
});

describe('a legal entity that cannot reclaim ITCs', () => {
  // The credit belongs to the entity that incurred the cost, so the entity
  // decides whether one arises at all. The category rate only ever narrows a
  // credit that exists — which is why this zeroes BOTH taxes and ignores the
  // category's 50%/100% entirely.
  const QUEBEC = { gstRate: 5, hstRate: 0, pstRate: 0, qstRate: 9.975, salesTaxRate: 0 };
  const db = (itc: number) =>
    stubDb({
      categories: [{ id: 'c1', itcGstHstRate: itc, itcQstRate: itc }],
      jurisdiction: QUEBEC,
    });
  const base = {
    grossMinor: 11_498n,
    taxJurisdictionId: 'jur-qc',
    taxSource: 'MANUAL' as const,
    explicit: { gstHstMinor: 500n, qstMinor: 998n },
    lines: [{ categoryId: 'c1', amountMinor: 11_498n }],
  };

  it('recovers neither GST/HST nor QST, even on a fully recoverable category', async () => {
    const tax = await resolveExpenseTax(db(100), { ...base, itcRecoverable: false });
    // The tax PAID is still recorded — it was paid. Only the credit is zero.
    expect(tax.taxGstHstMinor).toBe(500n);
    expect(tax.taxQstMinor).toBe(998n);
    expect(tax.recoverableGstHstMinor).toBe(0n);
    expect(tax.recoverableQstMinor).toBe(0n);
  });

  it('still recovers, at the category rate, for a registrant entity', async () => {
    const tax = await resolveExpenseTax(db(50), { ...base, itcRecoverable: true });
    expect(tax.recoverableGstHstMinor).toBe(250n);
    expect(tax.recoverableQstMinor).toBe(499n);
  });

  it('defaults to recoverable when the flag is absent', async () => {
    const tax = await resolveExpenseTax(db(50), base);
    expect(tax.recoverableGstHstMinor).toBe(250n);
  });
});

describe('explainExpenseTax', () => {
  const ONTARIO_DB = (rate: number) =>
    stubDb({
      categories: [{ id: 'c1', itcGstHstRate: rate, itcQstRate: rate }],
      jurisdiction: ONTARIO,
    });

  const base = {
    grossMinor: 11300n,
    taxJurisdictionId: 'j1',
    taxSource: 'CALCULATED' as const,
    lines: [{ categoryId: 'c1', amountMinor: 11300n }],
  };

  it('returns exactly what the write path returns', async () => {
    // The explanation has to be about the number on the screen. Two implementations would
    // eventually disagree, and the divergence would surface as an explanation nobody can
    // reconcile with the report.
    const explained = await explainExpenseTax(ONTARIO_DB(100), base);
    const resolved = await resolveExpenseTax(ONTARIO_DB(100), base);
    const { taxTrace, recoverableTrace, ...figures } = explained;
    expect(figures).toEqual(resolved);
    expect(taxTrace).toBeDefined();
    expect(recoverableTrace).toBeDefined();
  });

  it('explains a foreign expense as having no Canadian tax, not as a coding problem', async () => {
    const { taxTrace, recoverableTrace } = await explainExpenseTax(
      stubDb({
        categories: [{ id: 'c1', itcGstHstRate: 100, itcQstRate: 100 }],
        jurisdiction: null,
      }),
      base,
    );
    expect(taxTrace.gstHst.zeroReason).toBe('FOREIGN_JURISDICTION');
    expect(recoverableTrace.gstHst.zeroReason).toBe('NO_TAX_CHARGED');
  });

  it('blames the entity when the entity is the reason', async () => {
    // The cause a split-only trace cannot see: tax WAS charged and the category DOES
    // recover, and the credit is still zero because the legal entity is not a registrant.
    const { taxTrace, recoverableTrace } = await explainExpenseTax(ONTARIO_DB(100), {
      ...base,
      itcRecoverable: false,
    });
    expect(taxTrace.gstHst.zeroReason).toBeNull();
    expect(recoverableTrace.gstHst.zeroReason).toBe('ENTITY_NOT_REGISTERED');
    expect(recoverableTrace.entityRecovers).toBe(false);
  });

  it('blames the category when the category is the reason', async () => {
    const { recoverableTrace } = await explainExpenseTax(ONTARIO_DB(0), base);
    expect(recoverableTrace.gstHst.zeroReason).toBe('CATEGORIES_NOT_RECOVERABLE');
    expect(recoverableTrace.lines[0].itcGstHstRate).toBe(0);
  });

  it('explains an expense with no lines yet', async () => {
    const { recoverableTrace } = await explainExpenseTax(ONTARIO_DB(100), { ...base, lines: [] });
    expect(recoverableTrace.gstHst.zeroReason).toBe('NO_LINES');
  });

  it('explains a zero somebody typed', async () => {
    // Extraction read no tax off the receipt, or the claimant entered none. Worth a human
    // looking at the receipt — which is a different answer to every other zero here.
    const { taxTrace } = await explainExpenseTax(ONTARIO_DB(100), {
      ...base,
      taxSource: 'MANUAL',
      explicit: { gstHstMinor: 0n },
    });
    expect(taxTrace.gstHst.zeroReason).toBe('PROVIDED_ZERO');
  });
});
