// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * The live tax/FX preview, and the one property that matters: **it agrees with saving.**
 *
 * A preview exists so somebody can see the converted total and the recoverable tax while
 * deciding, instead of after filing. That is only useful if the numbers are the numbers
 * that will be stored. A preview that is nearly right is worse than none, because it will
 * be believed — and money that is wrong by a cent is exactly the kind of wrong nobody
 * notices until a reconciliation.
 *
 * So these tests do not assert hardcoded figures. They compute the preview, then actually
 * SAVE the same lines and compare — which is the only assertion that cannot drift as the
 * tax rules change. A hardcoded expectation would have to be updated alongside any rule
 * change and would then be re-derived from the same code it is meant to check.
 *
 * Gated on DATABASE_URL; the hermetic run skips it.
 *
 * VeloExpense: ExpenseOS's `totalsPreview.db.test.ts`. The cases are ExpenseOS's; the
 * harness is VeloExpense's (`createTenantHarness`: the suite's own tenant, people,
 * categories, entity and USD->CAD rate, every call under RLS). ExpenseOS reads seeded rows
 * and returns early when a tip category is missing; this suite creates one, so the two tip
 * cases always run. A currency is keyed by its ISO code.
 */

// VeloExpense: Auth.js and the host's tenant, in place of ExpenseOS's auth, RBAC resolver
// and job queue (the procedures here enqueue nothing in VeloExpense).
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const PERMS = [P.expense.report.readOwn, P.expense.report.updateOwn, P.expense.report.createOwn];

describe.skipIf(!process.env.DATABASE_URL)('expense totals preview (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let caller: any;
  let userId: string;
  let currencyId: string;
  let reportId: string;
  let categoryId: string;
  let otherCategoryId: string;
  /**
   * Ontario, HST 13%. Set on every fixture expense on purpose: without a jurisdiction the
   * tax split is all zeroes, and every equivalence assertion below would compare 0 to 0 and
   * pass while proving nothing. The first version of this file did exactly that — the tip
   * control caught it.
   */
  let jurisdictionId: string | null = null;
  const expenseIds: string[] = [];
  const reportIds: string[] = [];

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'totals-preview',
      name: 'Totals Preview',
      people: [
        { email: 'stranger@totals-preview.test', name: 'Stranger' },
        { email: 'cad-owner@totals-preview.test', name: 'CAD owner' },
      ],
    });
    db = h.db;
    userId = h.people[0].id;
    caller = h.makeCaller(PERMS, userId);
    // VeloExpense: a currency is keyed by its ISO code.
    currencyId = (
      await db.currency.findFirstOrThrow({ where: { code: 'CAD' }, select: { code: true } })
    ).code;
    // VeloExpense: this suite's own fixtures (ExpenseOS reads seeded ones) — two ordinary
    // categories, one that accepts a tip, a CAD-home entity for the second person, and a
    // USD->CAD rate in this tenant's table.
    for (const label of ['Preview meals', 'Preview supplies']) {
      await db.expenseCategory.create({ data: { label: { en: label } }, select: { id: true } });
    }
    await db.expenseCategory.create({
      data: { label: { en: 'Preview tipped meals' }, acceptsTip: true },
      select: { id: true },
    });
    const cadEntity = await db.legalEntity.create({
      data: { label: { en: 'Preview CA' }, country: 'CA', homeCurrencyId: 'CAD' },
      select: { id: true },
    });
    await db.user.update({ where: { id: h.people[2].id }, data: { legalEntityId: cadEntity.id } });
    await db.fxRate.create({ data: { base: 'USD', quote: 'CAD', rate: '1.37000000' } });
    const cats = await db.expenseCategory.findMany({
      where: { active: true, isMileage: false, acceptsTip: false },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: 2,
    });
    categoryId = cats[0].id;
    otherCategoryId = cats[1]?.id ?? cats[0].id;

    jurisdictionId =
      (
        await db.taxJurisdiction.findFirst({
          where: { countryCode: 'CA', code: 'ON' },
          select: { id: true },
        })
      )?.id ?? null;

    reportId = (
      await db.expenseReport.create({
        data: {
          title: `preview fixture ${Date.now()}`,
          submitterId: userId,
          currencyId,
          status: 'DRAFT',
        },
        select: { id: true },
      })
    ).id;
    reportIds.push(reportId);
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  /** A fresh expense with no lines. */
  const newExpense = async () => {
    const e = await db.expense.create({
      data: {
        reportId,
        ownerId: userId,
        date: new Date('2026-08-01'),
        amountMinor: 0n,
        currencyId,
        taxJurisdictionId: jurisdictionId,
      },
      select: { id: true },
    });
    expenseIds.push(e.id);
    return e.id;
  };

  /** What the expense actually holds after a save. */
  const saved = async (expenseId: string) => {
    const e = await db.expense.findUniqueOrThrow({
      where: { id: expenseId },
      select: {
        amountMinor: true,
        taxGstHstMinor: true,
        taxQstMinor: true,
        taxPstMinor: true,
        recoverableGstHstMinor: true,
        recoverableQstMinor: true,
        homeCurrency: true,
        homeAmountMinor: true,
        fxRate: true,
      },
    });
    return {
      grossMinor: e.amountMinor.toString(),
      taxGstHstMinor: e.taxGstHstMinor?.toString() ?? null,
      taxQstMinor: e.taxQstMinor?.toString() ?? null,
      taxPstMinor: e.taxPstMinor?.toString() ?? null,
      recoverableGstHstMinor: e.recoverableGstHstMinor?.toString() ?? null,
      recoverableQstMinor: e.recoverableQstMinor?.toString() ?? null,
      homeCurrency: e.homeCurrency ?? null,
      homeAmountMinor: e.homeAmountMinor?.toString() ?? null,
      fxRate: e.fxRate?.toString() ?? null,
    };
  };

  it('matches what saving the same single line produces', async () => {
    const expenseId = await newExpense();
    const lines = [{ categoryId, amountMinor: '11500' }];

    const preview = await caller.totalsPreview({ expenseId, addLines: lines });
    await caller.lineItemCreate({ expenseId, categoryId, amountMinor: '11500' });

    expect(preview).toEqual(await saved(expenseId));
    // The equivalence above is only meaningful if there is tax to get wrong. Ontario HST
    // on 115.00 is non-zero, so a preview that computed nothing would fail here rather
    // than matching a stored zero.
    expect(preview.taxGstHstMinor).not.toBe('0');
    expect(preview.taxGstHstMinor).not.toBeNull();
  });

  it('matches across SEVERAL lines in different categories', async () => {
    /**
     * The case a per-line preview would get wrong. The recoverable ITC re-allocates across
     * the line categories, so previewing one line in isolation gives a different answer
     * than saving it alongside the others — which is why the procedure derives over the
     * whole set (the saved lines plus every addition) rather than per line.
     */
    const expenseId = await newExpense();
    const lines = [
      { categoryId, amountMinor: '8000' },
      { categoryId: otherCategoryId, amountMinor: '3500' },
    ];

    const preview = await caller.totalsPreview({ expenseId, addLines: lines });
    for (const l of lines) {
      await caller.lineItemCreate({
        expenseId,
        categoryId: l.categoryId,
        amountMinor: l.amountMinor,
      });
    }

    expect(preview).toEqual(await saved(expenseId));
    expect(preview.grossMinor).toBe('11500');
  });

  it('keeps a tip out of the taxable base, exactly as saving does', async () => {
    // A voluntary tip is reimbursed but not taxed. If the preview forgot that, it would
    // overstate the tax on every tipped meal — and only on tipped meals, which is the kind
    // of discrepancy that looks like a rounding bug.
    const tipCategory = await db.expenseCategory.findFirst({
      where: { active: true, acceptsTip: true, isMileage: false },
      select: { id: true },
    });
    if (!tipCategory) return; // no tip-accepting category seeded here

    const withTip = await newExpense();
    const previewWithTip = await caller.totalsPreview({
      expenseId: withTip,
      addLines: [{ categoryId: tipCategory.id, amountMinor: '11500', tipMinor: '1500' }],
    });
    await caller.lineItemCreate({
      expenseId: withTip,
      categoryId: tipCategory.id,
      amountMinor: '11500',
      tipMinor: '1500',
    });
    expect(previewWithTip).toEqual(await saved(withTip));

    // And the tip genuinely changes the answer — otherwise the assertion above would hold
    // even if `tipMinor` were ignored on both sides.
    const noTip = await newExpense();
    const previewNoTip = await caller.totalsPreview({
      expenseId: noTip,
      addLines: [{ categoryId: tipCategory.id, amountMinor: '11500' }],
    });
    expect(previewWithTip.taxGstHstMinor).not.toBe(previewNoTip.taxGstHstMinor);
  });

  it('counts the ALREADY-SAVED lines, including a saved tip it was never sent', async () => {
    /**
     * The reason only the additions cross the wire.
     *
     * A person adds a second line to an expense that already holds a tipped meal. The
     * preview has to include the saved meal — and has to know its tip is not taxable. The
     * drawer's wire shape carries category and amount only, so a client that assembled the
     * full set itself would send the saved meal with no tip and overstate the tax. Reading
     * the saved lines here means the tip comes from its stored payload, and this test would
     * fail the moment that changed.
     */
    const tipCategory = await db.expenseCategory.findFirst({
      where: { active: true, acceptsTip: true, isMileage: false },
      select: { id: true },
    });
    if (!tipCategory) return;

    const expenseId = await newExpense();
    // Saved first, with a tip — this is the line the preview is never told about.
    await caller.lineItemCreate({
      expenseId,
      categoryId: tipCategory.id,
      amountMinor: '9000',
      tipMinor: '1800',
    });

    const preview = await caller.totalsPreview({
      expenseId,
      addLines: [{ categoryId, amountMinor: '4000' }],
    });
    await caller.lineItemCreate({ expenseId, categoryId, amountMinor: '4000' });

    expect(preview).toEqual(await saved(expenseId));
    // The saved line is in the total, so the preview is not previewing the addition alone.
    expect(preview.grossMinor).toBe('13000');
    // And the saved tip left the taxable base: HST is charged on 130.00 - 18.00, not on
    // 130.00. A preview that dropped the tip would show the larger figure here.
    const taxedOnFull = await caller.totalsPreview({
      expenseId: await newExpense(),
      addLines: [{ categoryId, amountMinor: '13000' }],
    });
    expect(preview.taxGstHstMinor).not.toBe(taxedOnFull.taxGstHstMinor);
  });

  it('converts a foreign-currency expense to the home currency, as saving does', async () => {
    /**
     * The half of the preview the reimbursement actually depends on: an expense filed in
     * USD is paid out in the entity's home currency, and the employee is deciding whether
     * to claim it based on the converted figure. A preview that skipped the conversion
     * would show the USD amount under a CAD label.
     *
     * This needs its own fixture rather than reusing the one above, because the conversion
     * only happens when the expense currency differs from the owner's home currency — and
     * the seeded rate table carries `X -> CAD`, so the owner must be a CAD entity and the
     * expense must be in USD. The first version of this file previewed a CAD expense for a
     * USD-home owner, found no rate, and asserted null === null: dropping the whole FX
     * block from the procedure did not fail a single test.
     */
    // VeloExpense: the person given a CAD-home entity in `beforeAll`; an entity's
    // `homeCurrencyId` is the code itself.
    const cadOwner = await db.user.findFirst({
      where: { deletedAt: null, entity: { homeCurrencyId: 'CAD' } },
      select: { id: true },
    });
    const usd = await db.currency.findFirst({ where: { code: 'USD' }, select: { code: true } });
    // Asserted rather than skipped: silently passing when the fixture is unavailable is
    // how this gap survived the first time.
    expect(cadOwner, 'no CAD-home user seeded').not.toBeNull();
    expect(usd, 'no USD currency seeded').not.toBeNull();
    expect(
      await db.fxRate.count({ where: { base: 'USD', quote: 'CAD' } }),
      'no USD->CAD rate seeded',
    ).toBeGreaterThan(0);

    const fxReport = await db.expenseReport.create({
      data: {
        title: `preview fx fixture ${Date.now()}`,
        submitterId: cadOwner.id,
        currencyId: usd.code,
        status: 'DRAFT',
      },
      select: { id: true },
    });
    reportIds.push(fxReport.id);
    const fxExpense = await db.expense.create({
      data: {
        reportId: fxReport.id,
        ownerId: cadOwner.id,
        date: new Date('2026-08-01'),
        amountMinor: 0n,
        currencyId: usd.code,
        // No jurisdiction: a US purchase carries no Canadian tax to recover, and we do
        // not collect foreign tax at all. This isolates the FX half.
        taxJurisdictionId: null,
      },
      select: { id: true },
    });
    expenseIds.push(fxExpense.id);

    const fxCaller = h.makeCaller(PERMS, cadOwner.id);

    const preview = await fxCaller.totalsPreview({
      expenseId: fxExpense.id,
      addLines: [{ categoryId, amountMinor: '84732' }],
    });
    await fxCaller.lineItemCreate({
      expenseId: fxExpense.id,
      categoryId,
      amountMinor: '84732',
    });

    // Null means the expense was not found, which would make every assertion below
    // vacuous — so it fails here instead.
    if (!preview) throw new Error('totalsPreview returned null for an existing expense');

    expect(preview).toEqual(await saved(fxExpense.id));
    // And the conversion genuinely happened — otherwise the equality above holds with
    // both sides null, which is exactly the trap this test exists to close.
    expect(preview.homeCurrency).toBe('CAD');
    expect(preview.fxRate).not.toBeNull();
    const home = preview.homeAmountMinor;
    expect(home).not.toBeNull();
    // 847.32 USD is worth MORE than 847.32 CAD, so a conversion that silently returned
    // the original amount would fail this rather than pass as "converted".
    expect(BigInt(home ?? '0')).toBeGreaterThan(84732n);
  });

  it('WRITES NOTHING — the expense is untouched after a preview', async () => {
    /**
     * The other half of the contract. A preview that quietly persisted would make typing
     * into the amount field mutate the report total, and an abandoned edit would leave the
     * expense holding a figure nobody filed.
     */
    const expenseId = await newExpense();
    const before = await saved(expenseId);
    const lineCountBefore = await db.expenseLineItem.count({ where: { expenseId } });

    await caller.totalsPreview({
      expenseId,
      addLines: [{ categoryId, amountMinor: '999999' }],
    });

    expect(await saved(expenseId)).toEqual(before);
    expect(await db.expenseLineItem.count({ where: { expenseId } })).toBe(lineCountBefore);
  });

  it('previews an empty draft as zero rather than failing', async () => {
    // The state a row is in the moment it is added and before an amount is typed.
    const expenseId = await newExpense();
    const preview = await caller.totalsPreview({ expenseId, addLines: [] });
    expect(preview.grossMinor).toBe('0');
  });

  it('refuses an expense the caller does not own', async () => {
    // It reads the owner's legal entity and the FX table, so it must not be a way to probe
    // somebody else's expense.
    const other = await db.user.findFirst({
      where: { deletedAt: null, id: { not: userId } },
      select: { id: true },
    });
    if (!other) return;
    const stranger = h.makeCaller(PERMS, other.id);
    const expenseId = await newExpense();
    await expect(
      stranger.totalsPreview({ expenseId, addLines: [{ categoryId, amountMinor: '100' }] }),
    ).rejects.toThrow();
  });
});
