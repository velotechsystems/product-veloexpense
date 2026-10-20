// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the harness reads rows untyped. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../server/__test-helpers__/tenantHarness';
import { ensureClaimantAttendee, lockClaimantSnapshot } from './ownerAttendee';

/**
 * The claimant-as-first-attendee helper, against a real Postgres.
 *
 * The unit suite pins the name and the transition table. This one pins what a stub cannot
 * show: that the row lock actually serialises two line writes on one expense (so the second
 * reads the first one's line as its "before" and exactly one claimant row results), that the
 * lock is NO KEY UPDATE (a child insert on the same expense is not stalled behind it), and
 * that the reads go through the transaction it is handed (a rollback leaves nothing).
 *
 * VeloExpense (ExpenseOS 67db2e33, #588): ExpenseOS's cases, on VeloExpense's harness — the
 * suite's own tenant, every statement under RLS, a currency keyed by its code. Gated on
 * DATABASE_URL; the hermetic CI run skips it.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

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

/** A latch: `open()` resolves `opened`. */
function latch() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
}

describe.skipIf(!process.env.DATABASE_URL)('claimant attendee helper (db)', () => {
  let h: TenantHarness;
  let db: any;
  const tag = 'claimant';
  const currencyId = 'CAD';
  let ownerId: string;
  let namelessOwnerId: string;
  let requiringId: string;
  let plainId: string;

  /** A fresh DRAFT report with one expense owned by `owner`, no lines and no attendees. */
  async function expenseFor(owner: string): Promise<string> {
    const report = await db.expenseReport.create({
      data: { title: `${tag} report`, submitterId: owner, currencyId },
      select: { id: true },
    });
    const expense = await db.expense.create({
      data: {
        reportId: report.id,
        ownerId: owner,
        currencyId,
        date: new Date(),
        amountMinor: 1000n,
      },
      select: { id: true },
    });
    return expense.id;
  }

  const lineIn = (
    client: any,
    expenseId: string,
    categoryId: string,
  ) =>
    client.expenseLineItem.create({
      data: { expenseId, categoryId, amountMinor: 1000n },
      select: { id: true },
    });

  const attendeesOf = (expenseId: string) =>
    db.expenseAttendee.findMany({
      where: { expenseId },
      select: { id: true, name: true, company: true, isExternal: true },
    });

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'claimant-attendee', name: 'Claimant Attendee' });
    db = h.db;
    const person = async (email: string, first: string | null, last: string | null) =>
      (
        await h.admin.query(
          `INSERT INTO app_user (organization_id, email, display_name, first_name, last_name, role_id)
           VALUES ($1, $2, $3, $4, $5, '019e3000-0000-7000-8000-000000000004') RETURNING id`,
          [h.orgId, email, [first, last].filter(Boolean).join(' ') || email, first, last],
        )
      ).rows[0].id as string;
    ownerId = await person(`${tag}-owner@test.invalid`, 'Claire', 'Mant');
    namelessOwnerId = await person(`${tag}-nameless@test.invalid`, null, null);
    for (const requiresAttendees of [true, false]) {
      const { id } = await db.expenseCategory.create({
        data: {
          label: { en: `${tag} ${requiresAttendees ? 'requiring' : 'plain'}` },
          requiresAttendees,
        },
        select: { id: true },
      });
      if (requiresAttendees) requiringId = id;
      else plainId = id;
    }
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  describe('the snapshot', () => {
    it('records the expense it locked, and no requiring line on an empty expense', async () => {
      const id = await expenseFor(ownerId);
      const snap = await db.$transaction((tx: any) => lockClaimantSnapshot(tx, id));
      expect(snap.expenseId).toBe(id);
      expect(snap.hadRequiringLine).toBe(false);
    });

    it('reads plain lines only as "no requiring line"', async () => {
      const id = await expenseFor(ownerId);
      await lineIn(db, id, plainId);
      await lineIn(db, id, plainId);
      const snap = await db.$transaction((tx: any) => lockClaimantSnapshot(tx, id));
      expect(snap.hadRequiringLine).toBe(false);
    });

    it('reads one requiring line as "had a requiring line"', async () => {
      const id = await expenseFor(ownerId);
      await lineIn(db, id, plainId);
      await lineIn(db, id, requiringId);
      const snap = await db.$transaction((tx: any) => lockClaimantSnapshot(tx, id));
      expect(snap.hadRequiringLine).toBe(true);
    });
  });

  describe('ensureClaimantAttendee', () => {
    it('inserts the owner as the one internal attendee on the transition, and returns its id', async () => {
      const id = await expenseFor(ownerId);
      const inserted = await db.$transaction(async (tx: any) => {
        const snap = await lockClaimantSnapshot(tx, id);
        await lineIn(tx, id, requiringId);
        return ensureClaimantAttendee(tx, snap);
      });
      const rows = await attendeesOf(id);
      expect(rows).toEqual([
        { id: inserted, name: 'Claire Mant', company: null, isExternal: false },
      ]);
    });

    it('names an owner with no first or last name by their email', async () => {
      const id = await expenseFor(namelessOwnerId);
      await db.$transaction(async (tx: any) => {
        const snap = await lockClaimantSnapshot(tx, id);
        await lineIn(tx, id, requiringId);
        return ensureClaimantAttendee(tx, snap);
      });
      expect((await attendeesOf(id)).map((r: any) => r.name)).toEqual([`${tag}-nameless@test.invalid`]);
    });

    it('leaves a list that already has someone on it alone', async () => {
      const id = await expenseFor(ownerId);
      await db.expenseAttendee.create({
        data: { expenseId: id, name: 'A Client', company: 'Acme', isExternal: true },
        select: { id: true },
      });
      const out = await db.$transaction(async (tx: any) => {
        const snap = await lockClaimantSnapshot(tx, id);
        await lineIn(tx, id, requiringId);
        return ensureClaimantAttendee(tx, snap);
      });
      expect(out).toBeNull();
      expect((await attendeesOf(id)).map((r: any) => r.name)).toEqual(['A Client']);
    });

    it('writes nothing when the line write left no requiring line', async () => {
      const id = await expenseFor(ownerId);
      const out = await db.$transaction(async (tx: any) => {
        const snap = await lockClaimantSnapshot(tx, id);
        await lineIn(tx, id, plainId);
        return ensureClaimantAttendee(tx, snap);
      });
      expect(out).toBeNull();
      expect(await attendeesOf(id)).toEqual([]);
    });

    it('writes nothing when a requiring line was already there — an emptied list stays empty', async () => {
      const id = await expenseFor(ownerId);
      await lineIn(db, id, requiringId);
      const out = await db.$transaction(async (tx: any) => {
        const snap = await lockClaimantSnapshot(tx, id);
        await lineIn(tx, id, requiringId);
        return ensureClaimantAttendee(tx, snap);
      });
      expect(out).toBeNull();
      expect(await attendeesOf(id)).toEqual([]);
    });

    it('leaves no row behind when the transaction rolls back', async () => {
      const id = await expenseFor(ownerId);
      let insertedId: string | null = null;
      const rolledBack = db.$transaction(async (tx: any) => {
        const snap = await lockClaimantSnapshot(tx, id);
        await lineIn(tx, id, requiringId);
        insertedId = await ensureClaimantAttendee(tx, snap);
        throw new Error('roll back');
      });
      await expect(rolledBack).rejects.toThrow('roll back');
      expect(insertedId).not.toBeNull();
      expect(await attendeesOf(id)).toEqual([]);
      expect(await db.expenseLineItem.count({ where: { expenseId: id } })).toBe(0);
    });
  });

  describe('the row lock', () => {
    it('serialises two writers: the second waits, then reads the first one’s line and adds no one', async () => {
      const id = await expenseFor(ownerId);
      const aDone = latch();
      const releaseA = latch();
      let aInserted: string | null = null;

      const txA = db.$transaction(async (tx: any) => {
        const snap = await lockClaimantSnapshot(tx, id);
        await lineIn(tx, id, requiringId);
        aInserted = await ensureClaimantAttendee(tx, snap);
        aDone.open();
        await releaseA.opened;
      });
      await aDone.opened;

      const txB = db.$transaction(async (tx: any) => {
        const snap = await lockClaimantSnapshot(tx, id);
        await lineIn(tx, id, requiringId);
        return { snap, inserted: await ensureClaimantAttendee(tx, snap) };
      });
      expect(await settledWithin(txB, 300)).toBe('pending');

      releaseA.open();
      await txA;
      const b = await txB;
      expect(aInserted).not.toBeNull();
      expect(b.snap.hadRequiringLine).toBe(true);
      expect(b.inserted).toBeNull();
      expect((await attendeesOf(id)).map((r: any) => r.id)).toEqual([aInserted]);
    });

    it('is NO KEY UPDATE: a child insert on the same expense is not held behind it', async () => {
      const id = await expenseFor(ownerId);
      const aLocked = latch();
      const releaseA = latch();

      const txA = db.$transaction(async (tx: any) => {
        await lockClaimantSnapshot(tx, id);
        aLocked.open();
        await releaseA.opened;
      });
      await aLocked.opened;

      // The FK check on this insert takes FOR KEY SHARE on the Expense row. Under FOR UPDATE
      // it would queue behind txA; under FOR NO KEY UPDATE it goes straight through.
      const childInsert = lineIn(db, id, plainId);
      const outcome = await settledWithin(childInsert, 300);
      releaseA.open();
      await txA;
      await childInsert;
      expect(outcome).toBe('resolved');
    });
  });
});
