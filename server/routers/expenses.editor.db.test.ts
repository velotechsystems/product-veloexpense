// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REFUSAL_KEYS, refusalData } from '@/server/refusal';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * Integration test for the Phase-2 report-editor procedures (report detail +
 * expense / line-item CRUD + derived-total recompute), using the tRPC caller
 * harness against a real database. Storage is mocked (no S3/MinIO); auth + the
 * Redis RBAC resolver are bypassed because we inject `ctx` directly.
 *
 * VeloExpense: ExpenseOS's `expenses.editor.db.test.ts`, for the procedures ported in
 * w2-08b and the report detail (`report`, w2-08c). The cases are ExpenseOS's; the harness
 * is VeloExpense's (`createTenantHarness`: the suite's own tenant, people, categories and
 * mileage category, every call under RLS). One adaptation runs through it: a person
 * carries business unit and department; VeloExpense has no class.
 * w2-11 brings "re-validating a report" (`validate`, on VeloExpense's policy pass) and
 * "blocks submit when a line was lowered under tax entered earlier" (`submit`); w2-10 the
 * `mileagePreview` block, once a traveller has a country.
 * Not ported here, and where they go: the NETSUITE defaults (VeloExpense has no NetSuite
 * position), and "a receipt still being read holds the submit" (extraction, Wave 3).
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.createOwn,
] as const;

describe.skipIf(!process.env.DATABASE_URL)('expenses report-editor (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let makeCaller: (perms: readonly string[], userId: string, router?: unknown) => any;
  let lastAudit: (entityType: string, entityId: string) => Promise<any>;
  let ownerId: string;
  let strangerId: string;
  let categoryId: string;
  let reportId: string;
  let expenseId: string;

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'expenses-editor',
      name: 'Expenses Editor',
      people: [{ email: 'stranger@expenses-editor.test', name: 'Stranger' }],
    });
    ({ db, makeCaller, lastAudit } = h);
    ownerId = h.people[0].id;
    strangerId = h.people[1].id;
    // VeloExpense: this suite's own categories (ExpenseOS reads seeded ones).
    categoryId = (
      await db.expenseCategory.create({ data: { label: { en: 'Editor meals' } }, select: { id: true } })
    ).id;
    await db.expenseCategory.create({
      data: { label: { en: 'Editor mileage' }, isMileage: true },
      select: { id: true },
    });
    // VeloExpense: a tip-accepting category, so "a tip survives" runs rather than returning
    // early as ExpenseOS's does where none is seeded.
    await db.expenseCategory.create({
      data: { label: { en: 'Editor tipped meals' }, acceptsTip: true },
      select: { id: true },
    });
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h.end();
  });

  // `createExpense` used to auto-create the report and take a currency. It now takes
  // a `reportId`: since d5e8303 a report is created first (or built around a receipt
  // upload) and expenses are added to it. This file still called the old signature,
  // so every test in it failed — invisibly, because CI has no DATABASE_URL and skips
  // the whole block.
  it('createExpense adds an expense to a report; report detail returns the tree', async () => {
    const caller = makeCaller(RW, ownerId);
    const report = await caller.create({ title: 'Editor integration', currency: 'CAD' });
    reportId = report.id;
    const { id } = await caller.createExpense({ reportId });
    expenseId = id;
    expect(expenseId).toBeTruthy();

    const detail = await caller.report({ reportId });
    expect(detail.status).toBe('DRAFT');
    expect(detail.totalMinor).toBe('0');
    expect(detail.expenses).toHaveLength(1);
    expect(detail.expenses[0].id).toBe(expenseId);
    expect(detail.expenses[0].lineItems).toHaveLength(0);
  });

  describe('a new expense is coded to the filer', () => {
    /**
     * The rule is decided by `defaultAllocationFrom` and unit-tested there. What this
     * proves is the WIRING — that `createExpense` actually reads the submitter's columns
     * and lands an allocation row — because a default nobody plumbed in is precisely the
     * shape of the original bug: `allocationSet` was the only writer, it ran only when
     * somebody opened the editor, and every expense began life uncoded.
     */
    // VeloExpense: business unit and department — VeloExpense has no class.
    it('copies business unit and department onto the expense', async () => {
      // VeloExpense: this suite's own business unit and department (ExpenseOS reads seeded
      // ones); created, not found, so neither assertion below can pass on a null.
      const bu = await db.businessUnit.create({
        data: { label: { en: 'Editor BU' } },
        select: { id: true },
      });
      const dept = await db.department.create({
        data: { label: { en: 'Editor Dept' } },
        select: { id: true },
      });
      const before = await db.user.findUniqueOrThrow({
        where: { id: ownerId },
        select: { businessUnitId: true, departmentId: true },
      });
      await db.user.update({
        where: { id: ownerId },
        data: {
          businessUnitId: bu?.id ?? null,
          departmentId: dept?.id ?? null,
        },
      });
      try {
        const caller = makeCaller(RW, ownerId);
        const r = await caller.create({ title: 'Coded by default', currency: 'CAD' });
        const { id } = await caller.createExpense({ reportId: r.id });
        const allocs = await db.expenseAllocation.findMany({ where: { expenseId: id } });

        expect(allocs, 'a new expense should arrive already coded').toHaveLength(1);
        expect(allocs[0].percentBp, 'the default covers the WHOLE expense').toBe(10_000);
        expect(allocs[0].businessUnitId).toBe(bu?.id ?? null);
        expect(allocs[0].departmentId).toBe(dept?.id ?? null);

        await db.expenseReport.delete({ where: { id: r.id } }).catch(() => {});
      } finally {
        await db.user.update({ where: { id: ownerId }, data: before });
      }
    });

    it('writes no allocation at all for a filer who carries none', async () => {
      /**
       * Three nulls would read as "coded to nothing", which looks deliberate and is worse
       * than blank. The three reports stuck on dev were filed by exactly such people.
       */
      const before = await db.user.findUniqueOrThrow({
        where: { id: ownerId },
        select: { businessUnitId: true, departmentId: true },
      });
      await db.user.update({
        where: { id: ownerId },
        data: { businessUnitId: null, departmentId: null },
      });
      try {
        const caller = makeCaller(RW, ownerId);
        const r = await caller.create({ title: 'Uncodeable filer', currency: 'CAD' });
        const { id } = await caller.createExpense({ reportId: r.id });
        expect(await db.expenseAllocation.count({ where: { expenseId: id } })).toBe(0);
        await db.expenseReport.delete({ where: { id: r.id } }).catch(() => {});
      } finally {
        await db.user.update({ where: { id: ownerId }, data: before });
      }
    });
  });

  describe('money input bounds', () => {
    it('refuses a negative amount, as a digit string and as a bigint alike', async () => {
      const caller = makeCaller(RW, ownerId);
      await expect(
        caller.lineItemCreate({ expenseId, categoryId, amountMinor: '-500' }),
      ).rejects.toThrow();
      await expect(
        caller.lineItemCreate({ expenseId, categoryId, amountMinor: -500n }),
      ).rejects.toThrow();
    });

    it('refuses an amount past the bigint ceiling instead of letting Postgres say so', async () => {
      const caller = makeCaller(RW, ownerId);
      // What `99999999999999999` in the dollars field becomes after ×100.
      await expect(
        caller.lineItemCreate({ expenseId, categoryId, amountMinor: '9999999999999999900' }),
      ).rejects.toThrow();
    });

    it('refuses a negative tip, which rides inside the taxable amount', async () => {
      const caller = makeCaller(RW, ownerId);
      await expect(
        caller.lineItemCreate({ expenseId, categoryId, amountMinor: '5000', tipMinor: '-100' }),
      ).rejects.toThrow();
    });

    it('still accepts zero, which is a deliberate part of the bound', async () => {
      // The tests in this file share one expense, and its amount is derived from its
      // lines — so this puts back exactly what it took, or it silently rewrites the
      // arithmetic every later assertion depends on.
      const caller = makeCaller(RW, ownerId);
      const zero = await caller.lineItemCreate({ expenseId, categoryId, amountMinor: '0' });
      expect(zero.id).toBeTruthy();
      await caller.lineItemRemove({ id: zero.id });
    });
  });

  it('lineItemCreate drives expense.amount + report.total (derived)', async () => {
    const caller = makeCaller(RW, ownerId);
    await caller.lineItemCreate({ expenseId, categoryId, amountMinor: '8040' });
    await caller.lineItemCreate({ expenseId, categoryId, amountMinor: '1960' });

    const detail = await caller.report({ reportId });
    const exp = detail.expenses[0];
    expect(exp.lineItems).toHaveLength(2);
    expect(exp.amountMinor).toBe('10000'); // 8040 + 1960
    expect(detail.totalMinor).toBe('10000');
  });

  /**
   * Switching a line's category across the mileage boundary.
   *
   * `computeLineFinancials` returned `mileage: null` for a non-mileage category and
   * the caller spread `...(fin.mileage ?? {})`, which spreads NOTHING — so a line
   * switched out of a mileage category kept its distance, unit, rate, YTD basis,
   * breakdown and route. The docstring already promised those were cleared.
   *
   * The residue is seeded directly rather than earned through a real mileage write:
   * that would need a MileageRate in force for the owner's country on the expense
   * date, which is seed data this test does not own. The precondition is what
   * matters, and it is exactly the state a real mileage line leaves behind.
   */
  it('switching OUT of a mileage category clears every mileage column', async () => {
    const caller = makeCaller(RW, ownerId);
    const { id: lineId } = await caller.lineItemCreate({
      expenseId,
      categoryId,
      amountMinor: '5000',
    });

    await db.expenseLineItem.update({
      where: { id: lineId },
      data: {
        mileageDistance: '120.00',
        mileageUnit: 'KM',
        mileageYtdBefore: '0.00',
        mileageBreakdown: [{ km: 120, rateMinor: 68 }],
        mileageRoute: { stops: [] },
        mileageDistanceOverride: '118.00',
      },
    });

    // A category change, on its own — which is all the UI sends.
    await caller.lineItemUpdate({ id: lineId, categoryId });

    const after = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
    expect(after.mileageDistance).toBeNull();
    expect(after.mileageUnit).toBeNull();
    expect(after.mileageRateId).toBeNull();
    expect(after.mileageYtdBefore).toBeNull();
    expect(after.mileageBreakdown).toBeNull();
    expect(after.mileageRoute).toBeNull();
    expect(after.mileageDistanceOverride).toBeNull();
    // The money carries over: nothing was lost, and the traveller can edit it.
    expect(after.amountMinor).toBe(5000n);

    await caller.lineItemRemove({ id: lineId });
  });

  /**
   * The other direction. A switch INTO a mileage category cannot carry a distance
   * yet, and `computeLineFinancials` threw 'A mileage line needs a distance.' — so
   * the change was rejected and the row went on showing its old amount, which is the
   * leftover figure this was reported as.
   */
  it('switching INTO a mileage category is allowed and zeroes the derived amount', async () => {
    const caller = makeCaller(RW, ownerId);
    // OrThrow, not an early return: a guard that skips silently would let this test
    // report success while asserting nothing. The suite already assumes seeded
    // reference data (see the user/category lookups in beforeAll).
    // VeloExpense: this suite's own mileage category (`beforeAll`).
    const mileageCategory = await db.expenseCategory.findFirstOrThrow({
      where: { isMileage: true },
      select: { id: true },
    });

    const { id: lineId } = await caller.lineItemCreate({
      expenseId,
      categoryId,
      amountMinor: '7500',
    });
    await caller.lineItemUpdate({ id: lineId, categoryId: mileageCategory.id });

    const after = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
    expect(after.categoryId).toBe(mileageCategory.id);
    // Zero, not 7500: a mileage amount is DERIVED, and showing the old typed figure
    // would be a number no rate produced.
    expect(after.amountMinor).toBe(0n);
    expect(after.mileageDistance).toBeNull();

    await caller.lineItemRemove({ id: lineId });
  });

  it('lineItemUpdate + lineItemRemove recompute the totals', async () => {
    const caller = makeCaller(RW, ownerId);
    const detail = await caller.report({ reportId });
    const [first, second] = detail.expenses[0].lineItems;

    await caller.lineItemUpdate({ id: first.id, amountMinor: '5000' });
    let d = await caller.report({ reportId });
    expect(d.expenses[0].amountMinor).toBe('6960'); // 5000 + 1960
    expect(d.totalMinor).toBe('6960');

    await caller.lineItemRemove({ id: second.id });
    d = await caller.report({ reportId });
    expect(d.expenses[0].lineItems).toHaveLength(1);
    expect(d.expenses[0].amountMinor).toBe('5000');
    expect(d.totalMinor).toBe('5000');
  });

  it('updateExpense patches header fields (not amount)', async () => {
    const caller = makeCaller(RW, ownerId);
    await caller.updateExpense({
      expenseId,
      merchant: 'Adobe',
      paymentMethod: 'OUT_OF_POCKET',
    });
    const d = await caller.report({ reportId });
    expect(d.expenses[0].merchant).toBe('Adobe');
    expect(d.expenses[0].paymentMethod).toBe('OUT_OF_POCKET');
    expect(d.expenses[0].amountMinor).toBe('5000'); // unchanged by header edit
  });

  /**
   * "When a user edits their request, it should audit what was edited" (UAT A12).
   *
   * The audit row for an edit used to read `{ fields: ['merchant', 'paymentMethod'] }` —
   * the keys the CLIENT SENT, with no values on either side. The editor posts its whole
   * model on save, so every edit recorded every field, and a reviewer asking "what was
   * the merchant before?" had nowhere to look.
   *
   * Written against the database rather than a mock because the "from" side comes out of
   * the row itself, and a stubbed `findUnique` would prove only that the code reads
   * something.
   */
  describe('what an edit records about itself', () => {
    // VeloExpense: `lastAudit` reads `audit_entry` (the harness), not `db.audit`.

    it('records the fields that changed, each with its old and new value', async () => {
      const caller = makeCaller(RW, ownerId);
      await caller.updateExpense({ expenseId, merchant: 'Adobe' });
      await caller.updateExpense({ expenseId, merchant: 'Adobe Inc.' });
      const row = await lastAudit('Expense', expenseId);
      expect(row?.details).toMatchObject({
        fields: ['merchant'],
        changed: { merchant: { from: 'Adobe', to: 'Adobe Inc.' } },
        unchanged: false,
      });
    });

    it('does not claim a field was edited just because the form sent it', async () => {
      const caller = makeCaller(RW, ownerId);
      await caller.updateExpense({ expenseId, merchant: 'Stripe' });
      // The editor re-posts its whole model; nothing about the expense actually moved.
      await caller.updateExpense({ expenseId, merchant: 'Stripe' });
      const row = await lastAudit('Expense', expenseId);
      expect(row?.details).toMatchObject({ fields: [], unchanged: true });
    });

    it('records clearing a field as an edit to null, not as an omission', async () => {
      const caller = makeCaller(RW, ownerId);
      await caller.updateExpense({ expenseId, purpose: 'Design tools' });
      await caller.updateExpense({ expenseId, purpose: null });
      const row = await lastAudit('Expense', expenseId);
      expect(row?.details).toMatchObject({
        changed: { purpose: { from: 'Design tools', to: null } },
      });
    });

    it('records a report edit the same way', async () => {
      const caller = makeCaller(RW, ownerId);
      await caller.updateReport({ reportId, title: 'Q3 travel' });
      const row = await lastAudit('ExpenseReport', reportId);
      expect((row?.details as { changed: Record<string, { to: unknown }> }).changed.title.to).toBe(
        'Q3 travel',
      );
    });
  });

  it('re-validating a report does not accumulate violation rows', async () => {
    /**
     * The GA readiness report recorded "genuine duplicates" in the Policy Violations
     * table — `PER_TXN_LIMIT ×4` on one report — and read them as the engine appending on
     * every re-evaluation (F11).
     *
     * It does not. `validateReport` deletes every violation for the report and re-inserts
     * inside one transaction, so the write is idempotent however many times it runs. What
     * the table actually shows is ONE ROW PER LINE ITEM under the same rule, rendered
     * without a column that distinguishes them and under a raw enum name — which is
     * indistinguishable from duplication when you are looking at it.
     *
     * Pinned here so nobody "fixes" a duplication bug that would need a
     * `NULLS NOT DISTINCT` unique across five nullable anchors to express, and would not
     * be a fix.
     *
     * VeloExpense: VeloExpense's pass reconciles rather than deleting and re-inserting, and
     * `policy_violation_identity_idx` makes a duplicate impossible; the claim is the same.
     * The rows are counted with SQL (no Prisma model).
     */
    const count = async () =>
      Number(
        (
          await h.admin.query(
            'SELECT count(*)::int AS n FROM policy_violation WHERE report_id = $1',
            [reportId],
          )
        ).rows[0].n,
      );
    const caller = makeCaller(RW, ownerId);
    await caller.validate({ reportId });
    const after1 = await count();
    await caller.validate({ reportId });
    const after2 = await count();
    expect(after2).toBe(after1);
    // A third pass, in case the first re-run happened to be a no-op.
    await caller.validate({ reportId });
    expect(await count()).toBe(after1);
  });

  it('a stranger cannot read or edit the report', async () => {
    const stranger = makeCaller(RW, strangerId);
    await expect(stranger.report({ reportId })).rejects.toThrow();
    await expect(stranger.updateExpense({ expenseId, merchant: 'evil' })).rejects.toThrow();
    await expect(
      stranger.lineItemCreate({ expenseId, categoryId, amountMinor: '1' }),
    ).rejects.toThrow();
  });

  it('deleteExpense removes the entry and recomputes the report total', async () => {
    const caller = makeCaller(RW, ownerId);
    await caller.deleteExpense({ expenseId });
    const d = await caller.report({ reportId });
    expect(d.expenses).toHaveLength(0);
    expect(d.totalMinor).toBe('0');
  });

  it('editing is refused once the report is no longer DRAFT', async () => {
    const caller = makeCaller(RW, ownerId);
    // Add an expense back, then flip the report to SUBMITTED out-of-band.
    const { id: eid } = await caller.createExpense({ reportId });
    await db.expenseReport.update({ where: { id: reportId }, data: { status: 'SUBMITTED' } });
    await expect(caller.updateExpense({ expenseId: eid, merchant: 'x' })).rejects.toThrow(
      /not editable/i,
    );
    await db.expenseReport.update({ where: { id: reportId }, data: { status: 'DRAFT' } });
  });

  /**
   * Category KIND — standard / standard-with-tip / mileage — and the one transition that
   * must be refused.
   *
   * `isMileage` was previously unwritable at all, for a real reason: it decides whether a
   * line's amount is DERIVED (distance × rate) or typed, so flipping it on a category
   * with filed lines silently restates them. That reason only holds once lines exist, so
   * the field opened up for creation and for edits while the category is still empty —
   * and the guard is asserted here rather than trusted to a disabled button.
   */
  describe('expenseCategories kind', () => {
    let categories: any;
    const createdIds: string[] = [];
    /** This block's own expense — the shared `expenseId` above is deleted by the
     *  deleteExpense test, which runs before this one. */
    let kindExpenseId: string;

    beforeAll(async () => {
      // VeloExpense: the harness's caller, on the categories router.
      const { expenseCategoriesRouter } = await import('@/server/routers/expenseCategories');
      categories = makeCaller(
        [P.admin.expenseCategory.create, P.admin.expenseCategory.update, P.admin.expenseCategory.list],
        ownerId,
        expenseCategoriesRouter,
      );
      kindExpenseId = (await makeCaller(RW, ownerId).createExpense({ reportId })).id;
    });

    afterAll(async () => {
      await db.expenseLineItem.deleteMany({ where: { expenseId: kindExpenseId } }).catch(() => {});
      await db.expense.delete({ where: { id: kindExpenseId } }).catch(() => {});
      for (const id of createdIds) {
        await db.expenseCategory.delete({ where: { id } }).catch(() => {});
      }
    });

    const make = async (kind: 'standard' | 'standard-with-tip' | 'mileage') => {
      const c = await categories.create({
        label: { en: `QA ${kind} ${Date.now()}`, 'fr-CA': `QA ${kind}` },
        itcGstHstRate: 100,
        itcQstRate: 100,
        pstRecoverable: false,
        kind,
        active: true,
      });
      createdIds.push(c.id);
      return c;
    };

    it('creates each kind, and encodes it in the two columns', async () => {
      expect(await make('standard')).toMatchObject({ isMileage: false, acceptsTip: false });
      expect(await make('standard-with-tip')).toMatchObject({
        isMileage: false,
        acceptsTip: true,
      });
      // The case that was previously impossible through the API at all.
      expect(await make('mileage')).toMatchObject({ isMileage: true, acceptsTip: false });
    });

    it('changes kind freely while the category has no lines', async () => {
      const c = await make('standard');
      const toMileage = await categories.update({ id: c.id, kind: 'mileage' });
      expect(toMileage).toMatchObject({ isMileage: true, acceptsTip: false });
      const back = await categories.update({ id: c.id, kind: 'standard-with-tip' });
      expect(back).toMatchObject({ isMileage: false, acceptsTip: true });
    });

    it('refuses to cross the mileage boundary once a line is filed', async () => {
      const caller = makeCaller(RW, ownerId);
      const c = await make('standard');
      const { id: lineId } = await caller.lineItemCreate({
        expenseId: kindExpenseId,
        categoryId: c.id,
        amountMinor: '1234',
      });

      await expect(categories.update({ id: c.id, kind: 'mileage' })).rejects.toThrow(
        /cannot change between mileage and a typed amount/i,
      );
      // Untouched, not half-applied.
      const after = await db.expenseCategory.findUniqueOrThrow({ where: { id: c.id } });
      expect(after.isMileage).toBe(false);

      await caller.lineItemRemove({ id: lineId });
    });

    it('still allows the tip flag to change with lines filed — it restates nothing', async () => {
      // Turning a tip on or off changes what the editor OFFERS from here on. It does not
      // reinterpret an amount already stored, so it is deliberately not guarded.
      const caller = makeCaller(RW, ownerId);
      const c = await make('standard');
      const { id: lineId } = await caller.lineItemCreate({
        expenseId: kindExpenseId,
        categoryId: c.id,
        amountMinor: '999',
      });
      const withTip = await categories.update({ id: c.id, kind: 'standard-with-tip' });
      expect(withTip).toMatchObject({ isMileage: false, acceptsTip: true });
      await caller.lineItemRemove({ id: lineId });
    });
  });

  /**
   * `mileagePreview` — the live "$ x.xx" beside the distance.
   *
   * The property worth defending is that the preview and the WRITE agree. They share
   * `computeLineFinancials` precisely so they cannot drift, and a preview that
   * disagrees with what gets saved is worse than none: it is a quoted price the
   * system then declines to honour.
   *
   * Owns every fixture it touches — its own traveller, its own report, and a rule for a
   * country code nothing else uses — rather than leaning on whichever mileage rates
   * happen to be seeded.
   *
   * That isolation is not fastidiousness. The first version set `country` on the
   * FIRST user in the table and priced against country 'ZZ'; both are shared, and the
   * whole DB suite runs concurrently against one database. mileageRule.db.test.ts
   * opens with `deleteMany({ where: { country: 'ZZ' } })`, so it deleted this block's
   * rate mid-run and the two files failed each other intermittently depending on
   * interleaving. A dedicated user and a private country code cost three inserts and
   * remove the whole class of flake.
   *
   * VeloExpense: ported with w2-10, when a traveller got a country (`app_user.country`,
   * 0055). The traveller is inserted as the superuser (VeloExpense has no first/last name
   * or role id to copy), the expense is given a date (VeloExpense's blank expense has none,
   * and a rate is resolved by it), and nothing is cleaned up — the harness's next suite
   * truncates the tenant.
   */
  describe('mileagePreview', () => {
    /** Distinct from mileageRule.db.test.ts's 'ZZ', which it wholesale deletes. */
    const COUNTRY = 'QZ';
    let previewExpenseId: string;
    let previewReportId: string;
    let travellerId: string;
    let mileageCategoryId: string;

    beforeAll(async () => {
      mileageCategoryId = (
        await db.expenseCategory.findFirstOrThrow({
          where: { isMileage: true },
          select: { id: true },
        })
      ).id;

      // A traveller of this block's own, so nothing else's expectations depend on the
      // country being changed underneath them.
      travellerId = (
        await h.admin.query(
          `INSERT INTO app_user (organization_id, email, display_name, country)
           VALUES ($1, $2, 'Mileage Preview', $3) RETURNING id`,
          [h.orgId, `mileage-preview-${Date.now()}@example.invalid`, COUNTRY],
        )
      ).rows[0].id;

      // 68¢ per unit, flat — one band, so the arithmetic is checkable by hand while
      // still going through the real banded pricer.
      // VeloExpense: its id was kept for ExpenseOS's cleanup, which the harness makes moot.
      await db.mileageRate.create({
        data: {
          country: COUNTRY,
          unit: 'KM',
          effectiveFrom: new Date('2000-01-01'),
          tiers: { create: [{ fromDistance: '0.00', rateMinor: 68n }] },
        },
        select: { id: true },
      });

      const caller = makeCaller(RW, travellerId);
      previewReportId = (await caller.create({ title: 'Mileage preview', currency: 'CAD' })).id;
      previewExpenseId = (await caller.createExpense({ reportId: previewReportId })).id;
      // VeloExpense: the date the rate is resolved by.
      await caller.updateExpense({ expenseId: previewExpenseId, date: new Date() });
    });

    it('quotes exactly what the write then stores', async () => {
      const caller = makeCaller(RW, travellerId);
      const quote = await caller.mileagePreview({
        expenseId: previewExpenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '25.66',
        mileageUnit: 'KM',
      });
      expect(quote.ok).toBe(true);
      // 25.66 × 0.68 = 17.4488 → 1745 minor, rounded not truncated.
      if (!quote.ok) throw new Error('expected a quote');
      expect(quote.amountMinor).toBe('1745');

      const { id: lineId } = await caller.lineItemCreate({
        expenseId: previewExpenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '25.66',
        mileageUnit: 'KM',
      });
      const written = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
      expect(written.amountMinor.toString()).toBe(quote.amountMinor);

      await caller.lineItemRemove({ id: lineId });
    });

    it('converts a distance entered in the other unit, exactly as the write does', async () => {
      const caller = makeCaller(RW, travellerId);
      const quote = await caller.mileagePreview({
        expenseId: previewExpenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '10',
        mileageUnit: 'MI',
      });
      if (!quote.ok) throw new Error('expected a quote');
      // 10 mi = 16.09 km at the rule's unit; priced there, not at 10.
      expect(quote.distance).toBe('16.09');
      expect(quote.unit).toBe('KM');

      const { id: lineId } = await caller.lineItemCreate({
        expenseId: previewExpenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '10',
        mileageUnit: 'MI',
      });
      const written = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
      expect(written.amountMinor.toString()).toBe(quote.amountMinor);
      await caller.lineItemRemove({ id: lineId });
    });

    it('leaves the repriced line out of its own YTD basis', async () => {
      const caller = makeCaller(RW, travellerId);
      const { id: lineId } = await caller.lineItemCreate({
        expenseId: previewExpenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '100',
        mileageUnit: 'KM',
      });

      // Without the exclusion this line's own 100 km would be in the basis, so the
      // quote would describe a traveller who had driven 200.
      const excluded = await caller.mileagePreview({
        expenseId: previewExpenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '100',
        mileageUnit: 'KM',
        lineItemId: lineId,
      });
      const counted = await caller.mileagePreview({
        expenseId: previewExpenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '100',
        mileageUnit: 'KM',
      });
      if (!excluded.ok || !counted.ok) throw new Error('expected quotes');
      expect(excluded.ytdBefore).toBe('0.00');
      expect(counted.ytdBefore).toBe('100.00');

      await caller.lineItemRemove({ id: lineId });
    });

    it('reports an unpriceable claim as a reason, not an exception', async () => {
      const caller = makeCaller(RW, travellerId);
      // The reported bug's precondition: a traveller with no country at all.
      await h.admin.query('UPDATE app_user SET country = NULL WHERE id = $1', [travellerId]);
      try {
        const quote = await caller.mileagePreview({
          expenseId: previewExpenseId,
          categoryId: mileageCategoryId,
          mileageDistance: '25.66',
          mileageUnit: 'KM',
        });
        expect(quote.ok).toBe(false);
        if (quote.ok) throw new Error('expected a refusal');
        expect(quote.reason).toMatch(/country/i);

        // The WRITE still throws. Only the preview softens it — a save that quietly
        // returned "ok: false" would drop the claim on the floor.
        await expect(
          caller.lineItemCreate({
            expenseId: previewExpenseId,
            categoryId: mileageCategoryId,
            mileageDistance: '25.66',
            mileageUnit: 'KM',
          }),
        ).rejects.toThrow(/country/i);
      } finally {
        await h.admin.query('UPDATE app_user SET country = $2 WHERE id = $1', [
          travellerId,
          COUNTRY,
        ]);
      }
    });

    /**
     * The From/To stops survive editing.
     *
     * `computeLineFinancials` writes the whole mileage column set on every write, so a
     * route it wasn't handed became JsonNull — and the edit row never sent one. Stops
     * were saved on create and then wiped by the very next distance edit, which is
     * indistinguishable from never having been stored.
     */
    it('keeps the route when an edit never mentions it', async () => {
      const caller = makeCaller(RW, travellerId);
      const route = {
        stops: [
          { description: '100 King St W, Toronto', placeId: 'place-a' },
          { description: '1 Yonge St, Toronto', placeId: 'place-b' },
        ],
        legs: [{ distance: '4.20' }],
      };
      const { id: lineId } = await caller.lineItemCreate({
        expenseId: previewExpenseId,
        categoryId: mileageCategoryId,
        mileageDistance: '4.20',
        mileageUnit: 'KM',
        mileageRoute: route,
      });
      const created = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
      expect(created.mileageRoute).toEqual(route);

      // The edit the UI actually sends on a distance change: no route mentioned.
      await caller.lineItemUpdate({ id: lineId, mileageDistance: '9.90', mileageUnit: 'KM' });
      const after = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
      expect(after.mileageDistance?.toString()).toBe('9.9');
      expect(after.mileageRoute).toEqual(route);

      // An explicit null is still how the stops get cleared — "absent" and "cleared"
      // have to stay different, or the last stop could never be removed.
      await caller.lineItemUpdate({ id: lineId, mileageDistance: '9.90', mileageRoute: null });
      const cleared = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
      expect(cleared.mileageRoute).toBeNull();

      await caller.lineItemRemove({ id: lineId });
    });

    it('a stranger gets nothing', async () => {
      const stranger = makeCaller(RW, strangerId);
      await expect(
        stranger.mileagePreview({
          expenseId: previewExpenseId,
          categoryId: mileageCategoryId,
          mileageDistance: '25.66',
          mileageUnit: 'KM',
        }),
      ).rejects.toThrow();
    });
  });

  describe('a tip survives the trip to the browser', () => {
    it('carries kind, payload and acceptsTip in the report detail', async () => {
      // The bug this pins: the worker wrote an extracted tip correctly into a
      // STANDARD_WITH_TIP line's payload, and the report-detail mapping dropped both `kind` and
      // `payload` — "line items are category + amount only". `tipMinorOf` reads exactly those
      // two, so the tip field rendered blank on a line the extractor had filled in. The value
      // was in the database the whole time and simply never reached the browser.
      //
      // A component test cannot catch this: it supplies its own line fixture, so it passes
      // whatever the router does. This asserts the wire.
      const caller = makeCaller(RW, ownerId);
      const report = await caller.create({ title: 'Tip on the wire', currency: 'CAD' });
      const { id: expenseIdLocal } = await caller.createExpense({ reportId: report.id });

      const tipCategory = await db.expenseCategory.findFirst({
        where: { acceptsTip: true, active: true },
        select: { id: true },
      });
      if (!tipCategory) return; // no tip-accepting category seeded in this environment

      await caller.lineItemCreate({
        expenseId: expenseIdLocal,
        categoryId: tipCategory.id,
        amountMinor: '5000',
        tipMinor: '750',
      });

      const detail = await caller.report({ reportId: report.id });
      const line = detail.expenses.find((e: any) => e.id === expenseIdLocal)?.lineItems[0];
      expect(line.kind).toBe('STANDARD_WITH_TIP');
      // What tipMinorOf parses. Asserting the shape, not just presence: a payload that arrives
      // without `tipMinor` reads as no tip at all, which is the same blank field.
      expect(line.payload).toMatchObject({ tipMinor: '750' });
      // The row decides which line-kind strategy to offer from this.
      expect(line.category.acceptsTip).toBe(true);

      await db.expenseReport.delete({ where: { id: report.id } }).catch(() => {});
    });
  });

  describe('paid tax is bounded by the gross', () => {
    /**
     * Real engine, real recompute: MANUAL tax is kept verbatim by `recomputeTotals`
     * and carved out of the gross at posting, so tax larger than the amount produced
     * an ITC receivable the company never paid and a negative expense line — with the
     * report total the approver saw unchanged.
     */
    it('refuses a MANUAL override larger than the expense, and accepts one within it', async () => {
      const caller = makeCaller(RW, ownerId);
      const report = await caller.create({ title: 'Tax bound', currency: 'CAD' });
      const { id: eid } = await caller.createExpense({ reportId: report.id });
      await caller.lineItemCreate({ expenseId: eid, categoryId, amountMinor: '11398' });

      const refused = await caller
        .expenseTaxUpdate({ expenseId: eid, taxSource: 'MANUAL', taxGstHstMinor: '500000' })
        .catch((e: unknown) => e);
      expect(refused).toMatchObject({
        message: expect.stringMatching(
          /Tax of 5000.00 CAD exceeds the expense amount of 113.98 CAD/,
        ),
      });
      // The tax panel renders this key with these figures, in the reader's language.
      expect(refusalData(refused)).toEqual({
        key: REFUSAL_KEYS.taxExceedsAmount,
        params: { tax: '5000.00 CAD', amount: '113.98 CAD' },
      });
      let row = await db.expense.findUniqueOrThrow({
        where: { id: eid },
        select: { taxGstHstMinor: true, taxSource: true },
      });
      // Nothing of the refused entry landed: the engine's own figure (0n on a line the
      // default jurisdiction taxes at nothing) and the CALCULATED source are untouched.
      expect(row).toEqual({ taxGstHstMinor: 0n, taxSource: 'CALCULATED' });

      await caller.expenseTaxUpdate({ expenseId: eid, taxSource: 'MANUAL', taxGstHstMinor: '500' });
      row = await db.expense.findUniqueOrThrow({
        where: { id: eid },
        select: { taxGstHstMinor: true, taxSource: true },
      });
      expect(row).toEqual({ taxGstHstMinor: 500n, taxSource: 'MANUAL' });

      await db.expenseReport.delete({ where: { id: report.id } }).catch(() => {});
    });

    it('blocks submit when a line was lowered under tax entered earlier', async () => {
      // The other order: tax first, then the amount edited down. Entry-time bounds
      // cannot see it; the submitted figure is the one that posts.
      const caller = makeCaller(RW, ownerId);
      const report = await caller.create({ title: 'Tax bound at submit', currency: 'CAD' });
      const { id: eid } = await caller.createExpense({ reportId: report.id });
      const line = await caller.lineItemCreate({
        expenseId: eid,
        categoryId,
        amountMinor: '11398',
      });
      await caller.expenseTaxUpdate({
        expenseId: eid,
        taxSource: 'MANUAL',
        taxGstHstMinor: '5000',
      });
      await caller.lineItemUpdate({ id: line.id, amountMinor: '1000' });

      const refused = await caller.submit({ reportId: report.id }).catch((e: unknown) => e);
      expect(refused).toMatchObject({
        message: expect.stringMatching(/Tax of 50.00 CAD exceeds the expense amount of 10.00 CAD/),
      });
      // At report level the sentence names the expense; a fresh one has no merchant yet.
      expect(refusalData(refused)).toEqual({
        key: REFUSAL_KEYS.taxExceedsAmount,
        params: { tax: '50.00 CAD', amount: '10.00 CAD' },
      });
      const after = await db.expenseReport.findUniqueOrThrow({
        where: { id: report.id },
        select: { status: true },
      });
      expect(after.status).toBe('DRAFT');

      await db.expenseReport.delete({ where: { id: report.id } }).catch(() => {});
    });
  });
});
