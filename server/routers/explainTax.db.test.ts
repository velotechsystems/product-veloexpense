// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * "Why do I have $0 recoverable ITC?" — end to end.
 *
 * The assistant must never reason about this number, so the product has to be able to answer
 * it. Each test below is a DIFFERENT true cause producing the SAME $0, which is the whole
 * problem: with only the figures in context, all four look identical, and a plausible
 * explanation of the wrong one is indistinguishable from a right answer.
 *
 * Gated on DATABASE_URL; the hermetic run skips it.
 *
 * VeloExpense: ExpenseOS's `explainTax.db.test.ts`. The cases are ExpenseOS's; the harness
 * is VeloExpense's (`createTenantHarness`: the suite's own tenant, people, entities and
 * categories, every call under RLS). ExpenseOS reads seeded rows and returns early when one
 * is missing; this suite creates each of them, so no case can pass by skipping.
 */

// VeloExpense: Auth.js and the host's tenant, in place of ExpenseOS's auth, RBAC resolver
// and job queue (the procedures here enqueue nothing in VeloExpense).
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const PERMS = [P.expense.report.readOwn, P.expense.report.updateOwn, P.expense.report.createOwn];

describe.skipIf(!process.env.DATABASE_URL)('expenses.explainTax (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let caller: any;
  let strangerCaller: any;
  let userId: string;
  let currencyId: string;
  let reportId: string;
  /** Ontario, HST 13% — without it every figure is zero and the tests prove nothing. */
  let ontarioId: string;
  let recoverableCategoryId: string;
  let entertainmentCategoryId: string | null = null;
  let registrantEntityId: string | null = null;
  let nonRegistrantEntityId: string | null = null;

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'explain-tax',
      name: 'Explain Tax',
      people: [{ email: 'stranger@explain-tax.test', name: 'Stranger' }],
    });
    db = h.db;
    userId = h.people[0].id;
    caller = h.makeCaller(PERMS, userId);
    strangerCaller = h.makeCaller(PERMS, h.people[1].id);

    // VeloExpense: a currency is keyed by its ISO code.
    currencyId = 'CAD';
    ontarioId = (
      await db.taxJurisdiction.findFirstOrThrow({
        where: { countryCode: 'CA', code: 'ON' },
        select: { id: true },
      })
    ).id;
    // VeloExpense: this suite's own categories and entities (ExpenseOS reads seeded ones).
    recoverableCategoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Explain meals' }, itcGstHstRate: 100 },
        select: { id: true },
      })
    ).id;
    entertainmentCategoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Explain entertainment' }, itcGstHstRate: 0 },
        select: { id: true },
      })
    ).id;
    registrantEntityId = (
      await db.legalEntity.create({
        data: { label: { en: 'Registrant' }, country: 'CA', homeCurrencyId: 'CAD', itcRecoverable: true },
        select: { id: true },
      })
    ).id;
    nonRegistrantEntityId = (
      await db.legalEntity.create({
        data: { label: { en: 'Non-registrant' }, country: 'CA', homeCurrencyId: 'CAD', itcRecoverable: false },
        select: { id: true },
      })
    ).id;
    // The seeded claimant's entity decides every recoverable figure, so the fixture sets it
    // rather than inheriting it — the first seeded user belongs to a NON-registrant entity,
    // which silently turns every "the credit exists" assertion into a zero.
    if (registrantEntityId) {
      await db.user.update({ where: { id: userId }, data: { legalEntityId: registrantEntityId } });
    }

    reportId = (
      await db.expenseReport.create({
        data: {
          title: `explainTax fixture ${Date.now()}`,
          submitterId: userId,
          currencyId,
          status: 'DRAFT',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  /** An expense with one line, at a given jurisdiction and category. */
  const expenseWith = async (opts: {
    jurisdictionId?: string | null;
    categoryId?: string;
    amountMinor?: bigint;
    lines?: boolean;
  }) => {
    const amountMinor = opts.amountMinor ?? 11300n;
    const expense = await db.expense.create({
      data: {
        reportId,
        ownerId: userId,
        date: new Date('2026-08-01'),
        amountMinor,
        currencyId,
        taxJurisdictionId: opts.jurisdictionId === undefined ? ontarioId : opts.jurisdictionId,
        ...(opts.lines === false
          ? {}
          : {
              lineItems: {
                create: [
                  {
                    categoryId: opts.categoryId ?? recoverableCategoryId,
                    amountMinor,
                    kind: 'STANDARD',
                  },
                ],
              },
            }),
      },
      select: { id: true },
    });
    return expense.id;
  };

  it('explains a credit that exists without inventing a reason for it', async () => {
    const expenseId = await expenseWith({});
    const out = await caller.explainTax({ expenseId });
    expect(BigInt(out.gstHst.recoverableMinor)).toBeGreaterThan(0n);
    expect(out.gstHst.zeroReason).toBeNull();
    expect(out.jurisdiction?.code).toBe('ON');
  });

  describe('the four ways to get $0', () => {
    it('foreign: no Canadian tax was charged, so there is nothing to recover', async () => {
      // Nothing is wrong here. Foreign tax stays inside the line cost by decision, and an
      // answer that sent somebody to recode the category would be advice about a
      // non-problem.
      const expenseId = await expenseWith({ jurisdictionId: null });
      const out = await caller.explainTax({ expenseId });
      expect(out.gstHst.recoverableMinor).toBe('0');
      expect(out.gstHst.zeroReason).toBe('NO_TAX_CHARGED');
      expect(out.gstHst.noTaxReason).toBe('FOREIGN_JURISDICTION');
    });

    it('the entity: tax was charged, the category recovers, and the credit is still zero', async () => {
      // The cause that is invisible in the tax split, and the reason a split-only
      // explanation would confidently blame the category instead.
      if (!nonRegistrantEntityId) return; // no non-registrant entity seeded
      await db.user.update({
        where: { id: userId },
        data: { legalEntityId: nonRegistrantEntityId },
      });
      try {
        const expenseId = await expenseWith({});
        const out = await caller.explainTax({ expenseId });
        expect(BigInt(out.taxCharged.gstHstMinor)).toBeGreaterThan(0n);
        expect(out.gstHst.recoverableMinor).toBe('0');
        expect(out.gstHst.zeroReason).toBe('ENTITY_NOT_REGISTERED');
        expect(out.entity.itcRecoverable).toBe(false);
      } finally {
        await db.user.update({
          where: { id: userId },
          data: { legalEntityId: registrantEntityId },
        });
      }
    });

    it('the category: tax was charged and this category recovers none of it', async () => {
      if (!entertainmentCategoryId) return; // no 0% category seeded
      const expenseId = await expenseWith({ categoryId: entertainmentCategoryId });
      const out = await caller.explainTax({ expenseId });
      expect(BigInt(out.taxCharged.gstHstMinor)).toBeGreaterThan(0n);
      expect(out.gstHst.zeroReason).toBe('CATEGORIES_NOT_RECOVERABLE');
      expect(out.lines[0].itcGstHstRate).toBe(0);
    });

    it('an empty expense: nothing has been entered yet, so nothing was taxed', async () => {
      // The gross comes from the line items, so an expense with none has no taxable amount.
      // The answer must not be "your province has no tax rates" — Ontario charges 13%, and
      // that would send somebody to check tax configuration over an empty form.
      const expenseId = await expenseWith({ lines: false });
      const out = await caller.explainTax({ expenseId });
      expect(out.gstHst.zeroReason).toBe('NO_TAX_CHARGED');
      expect(out.gstHst.noTaxReason).toBe('NO_TAXABLE_AMOUNT');
    });

    it('tax read off a receipt before any lines exist: nothing to allocate it across', async () => {
      // Extraction fills the tax in first. Until the claimant itemises, there is a real tax
      // amount and no credit, and neither the jurisdiction nor a category is to blame.
      const expense = await db.expense.create({
        data: {
          reportId,
          ownerId: userId,
          date: new Date('2026-08-01'),
          amountMinor: 11300n,
          currencyId,
          taxJurisdictionId: ontarioId,
          taxSource: 'EXTRACTED',
          taxGstHstMinor: 1300n,
        },
        select: { id: true },
      });
      const out = await caller.explainTax({ expenseId: expense.id });
      expect(out.taxCharged.gstHstMinor).toBe('1300');
      expect(out.gstHst.zeroReason).toBe('NO_LINES');
    });
  });

  it('refuses somebody else’s expense as NOT_FOUND', async () => {
    // Tax detail is expense detail. Indistinguishable from "does not exist", so the
    // endpoint cannot be used to discover which expense ids are real.
    const expenseId = await expenseWith({});
    await expect(strangerCaller.explainTax({ expenseId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses an expense that does not exist', async () => {
    await expect(
      caller.explainTax({ expenseId: '00000000-0000-7000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
