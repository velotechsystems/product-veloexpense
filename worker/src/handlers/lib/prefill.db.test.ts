// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../../server/__test-helpers__/tenantHarness';

/**
 * Uploading a receipt must produce expense line items.
 *
 * The reported failure: upload a receipt, extraction runs, and no line items appear.
 * The cause was one word — `prefillExpense` wrote `location:` on the Expense, a column
 * renamed to `placeText` long before (the old name collided with the NetSuite Location
 * dimension carried on `ExpenseAllocation`).
 *
 * Why nothing caught it:
 *
 *   · `tsc` passed — the payload contains conditional spreads, which widen the object
 *     literal enough to defeat excess-property checking;
 *   · the unit tests passed — they assert against a stub that knows nothing about
 *     Expense;
 *   · **it only failed for some receipts.** Prisma DROPS an unknown key whose value is
 *     `undefined`, so a receipt with no address prefilled perfectly. A receipt WITH an
 *     address threw `Unknown argument \`location\``, the deliberately best-effort
 *     handler swallowed it, and the header update aborted BEFORE line items were
 *     created.
 *
 * So this test does the one thing that reproduces it: a real Prisma write, with an
 * address present. The `placeText` assertion is secondary; the load-bearing assertion
 * is that line items exist at all.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/lib/prefill.db.test.ts` (550b2945).
 * VeloExpense: the suite's own tenant (`createTenantHarness`) with its own two categories
 * and a report made through the ported procedure; `prefillExpense` runs exactly as the
 * worker runs it — statement at a time in the tenant's scope (`withTenantStatements`), so
 * the `FOR UPDATE` and the audit row go through RLS as `veloapp`; a currency is its code;
 * the APPROVED report is put there by the superuser pool, as no procedure here approves
 * one; and the audit row is VeloExpense's `audit_entry`, the action its registry name.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [P.expense.report.readOwn, P.expense.report.createOwn, P.expense.report.updateOwn] as const;

const ADDRESS = '123 King St W, Toronto, ON';

describe.skipIf(!process.env.DATABASE_URL)('receipt prefill creates line items', () => {
  let h: TenantHarness;
  let db: any;
  let prefill: (...args: unknown[]) => Promise<unknown>;
  let reportId: string;
  let expenseId: string;
  let categoryId: string;
  let currencyId: string;
  let ownerId: string;
  const extraIds: string[] = [];
  const extraReportIds: string[] = [];

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'prefill', name: 'Prefill' });
    db = h.db;
    const { prefillExpense } = await import('./prefill');
    const { withTenantStatements } = await import('@/lib/db/prisma');
    prefill = (...args: unknown[]) =>
      withTenantStatements(h.orgId, () => (prefillExpense as (...a: unknown[]) => Promise<unknown>)(...args));

    ownerId = h.people[0].id;
    // VeloExpense: a currency's key is its code.
    currencyId = 'CAD';
    // VeloExpense: this suite's own categories (ExpenseOS reads seeded ones) — two, as the
    // cases below look for a second one.
    categoryId = (
      await db.expenseCategory.create({
        data: { label: { en: 'Prefill meals' }, itcGstHstRate: 50, itcQstRate: 50 },
        select: { id: true },
      })
    ).id;
    await db.expenseCategory.create({
      data: { label: { en: 'Prefill lodging' } },
      select: { id: true },
    });

    reportId = (await h.makeCaller(RW, ownerId).create({ title: `prefill fixture ${Date.now()}`, currency: 'CAD' }))
      .id;
    // A blank expense, exactly as the upload flow persists it before extraction:
    // no merchant, so prefill treats it as fresh and writes the header.
    const expense = await db.expense.create({
      data: { reportId, ownerId, date: new Date(), amountMinor: 0n, currencyId },
      select: { id: true },
    });
    expenseId = expense.id;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    void extraIds;
    void extraReportIds;
    await h?.end();
  });

  it('writes nothing to a report that is no longer editable, and leaves an audit line', async () => {
    /**
     * A filed report's numbers must not move under its approver. The joint pass has
     * always refused; this single-document path did not, so a receipt attached to an
     * APPROVED report — or one whose extraction simply landed late — replaced the
     * line set, the amount, the tax and the FX snapshot, and the report total
     * followed, with nobody re-asked and NetSuite posting the new figure.
     *
     * Real Prisma, because the refusal happens under a `FOR UPDATE` on the report row
     * and the audit row goes through the real hash chain.
     */
    const approved = await h.makeCaller(RW, ownerId).create({
      title: `prefill approved fixture ${Date.now()}`,
      currency: 'CAD',
    });
    // VeloExpense: no procedure here approves a report, so the fixture is put in that
    // state directly, as ExpenseOS creates it in it.
    await h.admin.query(`UPDATE expense_report SET status = 'APPROVED', total_minor = 11300 WHERE id = $1`, [
      approved.id,
    ]);
    extraReportIds.push(approved.id);
    const expense = await db.expense.create({
      data: {
        reportId: approved.id,
        ownerId,
        date: new Date(),
        merchant: 'Approved As Filed',
        amountMinor: 11300n,
        currencyId,
        taxGstHstMinor: 500n,
        taxSource: 'MANUAL',
      },
      select: { id: true },
    });
    extraIds.push(expense.id);
    await db.expenseLineItem.create({
      data: { expenseId: expense.id, categoryId, amountMinor: 11300n, kind: 'STANDARD' },
    });
    const categories = await db.expenseCategory.findMany({
      where: { active: true },
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

    // A perfectly readable receipt for TEN times the approved amount.
    await prefill(
      expense.id,
      categories,
      {
        vendor: 'Doctored Diner',
        address: ADDRESS,
        date: '2026-08-14',
        currencyCode: 'CAD',
        total: 1130.0,
        subtotal: 1000.0,
        taxGstHst: 130.0,
        taxQst: null,
        taxPst: null,
        voluntaryTip: null,
        confidence: 0.99,
        derivedCategoryCode: categoryId,
        lineItems: [],
      } as never,
      0.7,
      null,
    );

    const after = await db.expense.findUniqueOrThrow({
      where: { id: expense.id },
      select: {
        merchant: true,
        amountMinor: true,
        taxGstHstMinor: true,
        taxSource: true,
        lineItems: { select: { amountMinor: true } },
      },
    });
    expect(after).toMatchObject({
      merchant: 'Approved As Filed',
      amountMinor: 11300n,
      taxGstHstMinor: 500n,
      taxSource: 'MANUAL',
    });
    expect(after.lineItems.map((l: { amountMinor: bigint }) => l.amountMinor)).toEqual([11300n]);
    const report = await db.expenseReport.findUniqueOrThrow({
      where: { id: approved.id },
      select: { totalMinor: true },
    });
    expect(report.totalMinor).toBe(11300n);

    // The refusal is on the record, so the receipt/expense disagreement has a reason.
    // VeloExpense: `audit_entry`, under the registry's name for ExpenseOS's
    // `report.extraction.skipped`.
    const audit = (
      await h.admin.query(
        `SELECT actor_name, details FROM audit_entry
          WHERE action = 'REPORT_EXTRACTION_SKIPPED' AND entity_id = $1`,
        [expense.id],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      actor_name: 'system:expense.extractReceipt',
      details: { reportId: approved.id, reportStatus: 'APPROVED' },
    });
    // VeloExpense: the job's row (no user, role SYSTEM) is part of the tenant's chain, and
    // the chain still verifies with it in.
    const { withOrg } = await import('@/lib/tenant/context');
    const { verifyChain } = await import('@/lib/audit/verify');
    expect(await withOrg(h.orgId, (tx) => verifyChain(tx))).toMatchObject({ ok: true });
  });

  it('creates line items from an extraction that carries an address', async () => {
    const categories = await db.expenseCategory.findMany({
      where: { active: true },
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

    await prefill(
      expenseId,
      categories,
      {
        vendor: 'Le Bremner',
        // The field that made the difference. With this null the bug was invisible.
        address: ADDRESS,
        date: '2026-08-14',
        currencyCode: 'CAD',
        total: 128.4,
        subtotal: 112.0,
        taxGstHst: 5.6,
        taxQst: 11.17,
        taxPst: null,
        voluntaryTip: null,
        confidence: 0.95,
        derivedCategoryCode: categoryId,
        lineItems: [],
      } as never,
      0.7,
    );

    const lines = await db.expenseLineItem.findMany({
      where: { expenseId },
      select: { id: true, categoryId: true, amountMinor: true },
    });
    // The whole point: before the fix this was [].
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].categoryId).toBe(categoryId);

    const expense = await db.expense.findUniqueOrThrow({
      where: { id: expenseId },
      select: { merchant: true, placeText: true, amountMinor: true },
    });
    expect(expense.merchant).toBe('Le Bremner');
    // The address lands on the column that exists, rather than being dropped.
    expect(expense.placeText).toBe(ADDRESS);
    expect(expense.amountMinor).toBe(12840n);
  });

  it('does not destroy what the person typed when the extraction reads nothing', async () => {
    /**
     * A receipt the model cannot read must not empty the expense.
     *
     * Observed on dev: a $113.00 line was entered by hand, a receipt attached, and
     * twelve seconds later the expense read $0.00 with "No line items yet." No submit
     * was involved — the wipe is the prefill's, and it is persisted.
     *
     * The mechanism is order of operations. `deleteMany` ran unconditionally, BEFORE
     * the replacement set was known; lines are only created when a category was
     * derived; and the total falls back to `totalMinor ?? 0n`, which is `0n` when the
     * extraction carries no total. So an unreadable receipt deletes the lines, writes
     * none back, and then writes a zero over the amount.
     *
     * The header fields were already guarded for exactly this reason — "a manual
     * header wins" — and the money was not.
     *
     * Everything here is what a blank/unreadable document yields: no category, no
     * total, no tax.
     */
    const expense = await db.expense.create({
      data: {
        reportId,
        ownerId,
        date: new Date(),
        // What the person entered, and what has to still be here afterwards.
        merchant: 'Typed By Hand',
        amountMinor: 11300n,
        currencyId,
        taxGstHstMinor: 500n,
        taxQstMinor: 998n,
      },
      select: { id: true },
    });
    extraIds.push(expense.id);
    await db.expenseLineItem.create({
      data: { expenseId: expense.id, categoryId, amountMinor: 11300n, kind: 'STANDARD' },
    });

    const categories = await db.expenseCategory.findMany({
      where: { active: true },
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

    await prefill(
      expense.id,
      categories,
      {
        vendor: null,
        address: null,
        date: null,
        currencyCode: null,
        total: null,
        subtotal: null,
        taxGstHst: null,
        taxQst: null,
        taxPst: null,
        voluntaryTip: null,
        confidence: 0,
        derivedCategoryCode: null,
        lineItems: [],
      } as never,
      0.7,
    );

    const lines = await db.expenseLineItem.findMany({
      where: { expenseId: expense.id },
      select: { amountMinor: true },
    });
    expect(lines.map((l: { amountMinor: bigint }) => l.amountMinor)).toEqual([11300n]);

    const after = await db.expense.findUniqueOrThrow({
      where: { id: expense.id },
      select: { amountMinor: true, taxGstHstMinor: true, taxQstMinor: true },
    });
    expect(after.amountMinor).toBe(11300n);
    expect(after.taxGstHstMinor).toBe(500n);
    expect(after.taxQstMinor).toBe(998n);
  });

  it('collapses a US folio to ONE line even when tax rows are coded elsewhere', async () => {
    /**
     * The Hampton Inn folio (`docs/samples/FOLIODETE_20250714061449.pdf`), whose five
     * rows sum to the TOTAL rather than the subtotal because four of them are tax:
     *   Guest Room 299.00 · Occupancy Tax 2.00 · Javits Center Fee 1.50 ·
     *   City Tax 17.57 · State Tax 26.54  →  346.61
     *
     * Non-Canadian tax is deliberately not collected, so those rows belong INSIDE the
     * lodging cost. Before `reconcileLineItems` this came out right only because the
     * model happened to tag all five rows as lodging; tagging the taxes as something
     * else — which the per-line category instruction invites, and which a 0.95
     * confidence made the engine trust — produced a separate expense line for a tax.
     *
     * So the tax rows are deliberately coded to a DIFFERENT category here. One line
     * carrying the full 346.61 is the assertion.
     */
    const other = await db.expenseCategory.findFirstOrThrow({
      where: { active: true, isMileage: false, id: { not: categoryId } },
      select: { id: true },
    });
    const expense = await db.expense.create({
      data: { reportId, ownerId: ownerId, date: new Date(), amountMinor: 0n, currencyId },
      select: { id: true },
    });
    extraIds.push(expense.id);
    const categories = await db.expenseCategory.findMany({
      where: { active: true },
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

    await prefill(
      expense.id,
      categories,
      {
        vendor: 'Hampton Inn New York LaGuardia Airport',
        address: '102-40 Ditmars Blvd, East Elmhurst, NY 11369, United States of America',
        date: '2025-07-14',
        time: '06:14',
        transactionId: '2927664',
        currencyCode: 'USD',
        total: 346.61,
        subtotal: 299,
        taxGstHst: null,
        taxQst: null,
        taxPst: null,
        mandatoryGratuity: null,
        voluntaryTip: null,
        confidence: 0.95,
        derivedCategoryCode: categoryId,
        lineItems: [
          { description: 'Guest Room', amount: 299, quantity: 1, categoryCode: categoryId },
          { description: 'Occupancy Tax', amount: 2, quantity: 1, categoryCode: other.id },
          { description: 'Javits Center Fee', amount: 1.5, quantity: 1, categoryCode: other.id },
          { description: 'City Tax', amount: 17.57, quantity: 1, categoryCode: other.id },
          { description: 'State Tax', amount: 26.54, quantity: 1, categoryCode: other.id },
        ],
      } as never,
      0.7,
    );

    const lines = await db.expenseLineItem.findMany({
      where: { expenseId: expense.id },
      select: { amountMinor: true, categoryId: true },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].amountMinor).toBe(34661n);
    // On the receipt-level category, not the one the tax rows carried.
    expect(lines[0].categoryId).toBe(categoryId);

    const e = await db.expense.findUniqueOrThrow({
      where: { id: expense.id },
      select: { amountMinor: true, subtotalMinor: true, taxPstMinor: true },
    });
    expect(e.amountMinor).toBe(34661n);
    // The US tax is inside the line cost, and explicitly NOT smuggled into a
    // Canadian tax column to make it fit.
    expect(e.taxPstMinor).toBeNull();
  });

  it('does not trust per-line categories below the review threshold', async () => {
    /**
     * The OTHER half of the gate, which predates the folio work and had no test: a
     * document whose lines reconcile to the subtotal — so they are genuine pre-tax
     * purchases — must still not be split on per-line categories when the model says it
     * read the document poorly. Confidence 0.4 against a 0.7 threshold.
     */
    const other = await db.expenseCategory.findFirstOrThrow({
      where: { active: true, isMileage: false, id: { not: categoryId } },
      select: { id: true },
    });
    const expense = await db.expense.create({
      data: { reportId, ownerId, date: new Date(), amountMinor: 0n, currencyId },
      select: { id: true },
    });
    extraIds.push(expense.id);
    const categories = await db.expenseCategory.findMany({
      where: { active: true },
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

    await prefill(
      expense.id,
      categories,
      {
        vendor: 'Corner Bistro',
        address: null,
        date: '2026-08-01',
        currencyCode: 'CAD',
        total: 115,
        subtotal: 100,
        taxGstHst: 5,
        taxQst: 10,
        taxPst: null,
        voluntaryTip: null,
        mandatoryGratuity: null,
        // Below the 0.7 threshold the run is passed.
        confidence: 0.4,
        derivedCategoryCode: categoryId,
        lineItems: [
          { description: 'Dinner', amount: 80, quantity: 1, categoryCode: categoryId },
          { description: 'Parking', amount: 20, quantity: 1, categoryCode: other.id },
        ],
      } as never,
      0.7,
    );

    const lines = await db.expenseLineItem.findMany({
      where: { expenseId: expense.id },
      select: { categoryId: true },
    });
    // Everything on the receipt-level category — a low-confidence per-line guess is
    // not evidence.
    expect(new Set(lines.map((l: { categoryId: string }) => l.categoryId))).toEqual(
      new Set([categoryId]),
    );
  });
});
