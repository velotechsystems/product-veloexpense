import { describe, expect, it } from 'vitest';
import { codingDefaultsFor } from './businessUnitSource';
import { allocationCreateFor, defaultAllocationFrom } from './expenseCodingDefaults';

/**
 * "What is a blank expense coded as?" — asserted here so the four creation paths that ask
 * it (add by hand, receipts-to-new-report, receipts-onto-a-report, inbound email) cannot
 * each grow their own answer. That is exactly how `coding.ts` came to exist on the
 * NetSuite side, after the card path and the report path drifted on "what counts as coded".
 *
 * VeloExpense: ExpenseOS's `expenseCodingDefaults.test.ts`, its `EXPENSEOS` cases, on
 * VeloExpense's two dimensions (business unit and department; there is no class). Not
 * ported: the NETSUITE cases, "maps nsClassId onto classId", and `noClassIdFor` /
 * `newUserClassDefault` — VeloExpense has neither the NetSuite position nor a class.
 * "Still writes a partial allocation" keeps its point on the dimension VeloExpense can
 * actually leave blank.
 */

const FULL = { businessUnitId: 'bu', departmentId: 'dept' };

describe('defaultAllocationFrom', () => {
  it("copies the filer's coding as one whole-expense allocation", () => {
    expect(defaultAllocationFrom(FULL, 'EXPENSEOS')).toEqual({
      percentBp: 10_000,
      businessUnitId: 'bu',
      departmentId: 'dept',
    });
  });

  it('is the WHOLE expense, not a share of it', () => {
    // `allocationSet` refuses anything that does not total 100%, and a default that summed
    // to less would produce a report nobody could submit without deleting it first.
    expect(defaultAllocationFrom(FULL, 'EXPENSEOS')?.percentBp).toBe(10_000);
  });

  it('still writes a partial allocation when the filer has no department', () => {
    /**
     * Worth writing anyway — the submitter is then one visible gap away from submitting
     * rather than two.
     *
     * VeloExpense: ExpenseOS's case is a filer with no class; VeloExpense has no class, so
     * the gap it leaves is the department.
     */
    expect(defaultAllocationFrom({ ...FULL, departmentId: null }, 'EXPENSEOS')).toEqual({
      percentBp: 10_000,
      businessUnitId: 'bu',
      departmentId: null,
    });
  });

  it('gives nothing when the filer carries no coding at all', () => {
    /**
     * An allocation of nulls reads as "coded to nothing", which is worse than no
     * allocation: it looks deliberate. This is not hypothetical — the three reports stuck
     * on dev were filed by people with all three columns null.
     */
    expect(
      defaultAllocationFrom({ businessUnitId: null, departmentId: null }, 'EXPENSEOS'),
    ).toBeNull();
  });

  it('gives nothing for an absent filer', () => {
    expect(defaultAllocationFrom(null, 'EXPENSEOS')).toBeNull();
  });
});

describe('allocationCreateFor', () => {
  it('nests the allocation so it lands in the same statement as the expense', () => {
    // Atomicity is the point: an expense that exists without its default allocation is the
    // uncoded row this module was written to stop producing.
    expect(allocationCreateFor(FULL, 'EXPENSEOS')).toEqual({
      allocations: {
        create: { percentBp: 10_000, businessUnitId: 'bu', departmentId: 'dept' },
      },
    });
  });

  it('spreads to nothing when there is no coding, rather than an empty create', () => {
    // `{ allocations: { create: [] } }` would be a different thing entirely — Prisma would
    // accept it and the expense would carry an allocation relation with no rows.
    expect(allocationCreateFor(null, 'EXPENSEOS')).toEqual({});
  });
});

describe('codingDefaultsFor', () => {
  it('is null for an absent filer', async () => {
    await expect(codingDefaultsFor({} as never, null, 'EXPENSEOS')).resolves.toBeNull();
  });

  it('EXPENSEOS: the stored columns, as today, without reading anything (FR-4)', async () => {
    // VeloExpense: a db that throws on any access proves "without reading anything".
    const db = new Proxy({}, { get: () => { throw new Error('read the database'); } });
    const out = await codingDefaultsFor(
      db as never,
      { businessUnitId: 'bu-x', departmentId: 'dept' },
      'EXPENSEOS',
    );
    expect(out).toEqual({ businessUnitId: 'bu-x', departmentId: 'dept' });
  });
});
