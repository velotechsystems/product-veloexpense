// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The report-level procedures, against a real database.
 *
 * These are the ones whose mistakes are structural rather than cosmetic — a report
 * deleted that should not have been, an allocation set that no longer totals 100%, a
 * currency written as a code into a foreign key. Everything runs through real Prisma and
 * the real hash-chained `withAudit`, because the audit write is part of the contract
 * rather than a decoration: a delete that left no audit row is a delete nobody can
 * account for.
 *
 * Storage is mocked (no MinIO), and gated on DATABASE_URL like every `*.db.test.ts`.
 *
 * VeloExpense: ExpenseOS's `expenses.reports.db.test.ts`, the blocks for the procedures
 * ported in w2-07 (`list`, `create`, `deleteReport`) and the three `report`-view cases
 * inside "listing my reports" (`viewInReaderCurrency`, w2-08c), and "allocating an
 * expense across dimensions" (`allocationSet`, w2-03 — less the class case: VeloExpense has
 * no class). The NETSUITE blocks are not ported: VeloExpense has no NetSuite and always
 * runs in ExpenseOS's `EXPENSEOS` business unit position, which the blocks above cover.
 * The harness differs, the cases do not:
 *   · ExpenseOS runs against its seeded database; this creates its own tenant, two people
 *     and a currency pair, and runs every call inside that tenant (`withTenantDb`);
 *   · `makeInstance` writes the approval engine's tables itself (a RUNNING `approval_instance`
 *     and its tasks), where ExpenseOS's harness started one through the engine;
 *   · storage is VeloExpense's (`setStorage`), with its `delete` spied on.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [
  P.expense.report.readOwn,
  P.expense.report.createOwn,
  P.expense.report.updateOwn,
  P.expense.report.deleteDraft,
] as const;

describe.skipIf(!process.env.DATABASE_URL)('expense reports (integration)', () => {
  let db: any;
  let withTenantDb: <T>(org: string, fn: () => Promise<T>) => Promise<T>;
  let admin: import('pg').Pool;
  let makeCaller: (perms: readonly string[], userId: string) => any;
  let storage: { delete: ReturnType<typeof vi.fn> };
  let orgId: string;
  let ownerId: string;
  let strangerId: string;
  let currencyId: string;
  let currencyCode: string;

  /** VeloExpense: every call runs in the test tenant, as the request middleware would. */
  const inOrg = (fn: () => Promise<any>): Promise<any> => withTenantDb(orgId, fn);
  /** VeloExpense: the suite's bare client and caller, for blocks that scope them (below). */
  const suiteDb = (): any => db;
  const suiteCaller = (perms: readonly string[], userId: string): any => makeCaller(perms, userId);

  beforeAll(async () => {
    const { Pool } = await import('pg');
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    ({ db, withTenantDb } = await import('@/lib/db/prisma'));
    const { createOrganization } = await import('@/lib/onboarding/provision');
    const { MemoryStorage, setStorage } = await import('@/lib/storage');

    // VeloExpense: as every db suite here does, start from an empty set of tenants.
    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    orgId = (
      await createOrganization({
        name: 'Expenses Reports',
        slug: 'expenses-reports',
        adminEmail: 'owner@reports.test',
        adminName: 'Owner',
      })
    ).organizationId;
    const users = await admin.query(
      `SELECT id FROM app_user WHERE organization_id = $1 AND email = 'owner@reports.test'`,
      [orgId],
    );
    ownerId = users.rows[0].id;
    strangerId = (
      await admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, 'stranger@reports.test', 'Stranger', '019e3000-0000-7000-8000-000000000004') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;

    const memory = new MemoryStorage();
    const remove = memory.delete.bind(memory);
    storage = { delete: vi.fn((key: string) => remove(key)) };
    setStorage(Object.assign(memory, { delete: storage.delete }) as never);

    const { createCallerFactory } = await import('@/server/trpc');
    const { expensesRouter } = await import('@/server/routers/expenses');
    const factory = createCallerFactory(expensesRouter);
    makeCaller = (perms, userId) =>
      factory(makeContext({ db, userId, permissions: perms, email: userId === ownerId ? 'owner@reports.test' : 'stranger@reports.test' }));

    // VeloExpense: currencies are keyed by their code, so the "id" is the code.
    currencyId = 'CAD';
    currencyCode = 'CAD';
  });

  /** A report owned by `ownerId`, with `expenses` blank expenses on it. */
  const makeReport = async (
    over: Record<string, unknown> = {},
    expenses = 0,
  ): Promise<{ id: string }> =>
    inOrg(() =>
      db.expenseReport.create({
        data: {
          title: 'report under test',
          currencyId,
          submitterId: ownerId,
          ...over,
          ...(expenses > 0
            ? {
                expenses: {
                  create: Array.from({ length: expenses }, (_, i) => ({
                    ownerId,
                    currencyId,
                    date: new Date('2026-07-01T12:00:00Z'),
                    amountMinor: BigInt(1000 * (i + 1)),
                    merchant: `Merchant ${i + 1}`,
                  })),
                },
              }
            : {}),
        },
        select: { id: true },
      }),
    );

  /**
   * A real approval instance, since `ApprovalInstance.workflowVersionId` is a
   * Restrict FK and `cursor` is required — there is no shortcut to a plausible one.
   *
   * VeloExpense: VeloExpense's approval tables — a request for the report, RUNNING while
   * any task is pending, and one task per entry in step order.
   */
  /**
   * An approval instance on a report, with its tasks — ExpenseOS's helper (an instance on a
   * throwaway workflow version, tasks in order of creation).
   *
   * VeloExpense (w4-00c): written as the admin, under the suite's tenant, and pointed at the
   * report (`approval_instance_id`), which is where ExpenseOS's list reads it from. Tasks are
   * created a millisecond apart so "the first one" is the first one written.
   */
  const makeInstance = async (
    reportId: string,
    tasks: Array<{ assigneeUserId?: string; status?: string }>,
  ): Promise<string> => {
    const workflow = await admin.query(
      `INSERT INTO approval_workflow (organization_id, key, name, subject_type)
       VALUES ($1, $2, 'pendingWith harness', 'EXPENSE_REPORT') RETURNING id`,
      [orgId, `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`],
    );
    const version = await admin.query(
      `INSERT INTO approval_workflow_version (organization_id, workflow_id, version, match_condition, graph)
       VALUES ($1, $2, 1, '{}', '{"nodes":[],"edges":[]}') RETURNING id`,
      [orgId, workflow.rows[0].id],
    );
    const instance = await admin.query(
      `INSERT INTO approval_instance (organization_id, workflow_version_id, subject_type, subject_id, cursor)
       VALUES ($1, $2, 'EXPENSE_REPORT', $3, '{}') RETURNING id`,
      [orgId, version.rows[0].id, reportId],
    );
    const instanceId = instance.rows[0].id as string;
    for (const [i, t] of tasks.entries()) {
      await admin.query(
        `INSERT INTO approval_instance_task (organization_id, instance_id, node_id, status, assignee_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::int / 1000.0))`,
        [orgId, instanceId, `n-${i}`, t.status ?? 'PENDING', t.assigneeUserId ?? null, i],
      );
    }
    await admin.query(`UPDATE expense_report SET approval_instance_id = $1 WHERE id = $2`, [
      instanceId,
      reportId,
    ]);
    return instanceId;
  };

  /** The newest audit row for an entity. `occurredAt` is the column, not createdAt. */
  const lastAudit = async (entityType: string, entityId: string) =>
    (
      await admin.query(
        `SELECT action FROM audit_entry WHERE entity_type = $1 AND entity_id = $2 ORDER BY occurred_at DESC LIMIT 1`,
        [entityType, entityId],
      )
    ).rows[0] ?? null;

  beforeEach(() => {
    storage.delete.mockClear();
  });

  /**
   * Take the rows back out.
   *
   * The test database is shared by every `*.db.test.ts` and is not reset between runs,
   * so a suite that leaves its fixtures behind grows it forever — and a neighbour that
   * scans a whole table (the fraud sweep) eventually times out on volume nobody
   * intended. Deleting the reports cascades their expenses, receipts and allocations.
   */
  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await admin.end();
  });

  // ── list ────────────────────────────────────────────────────────────────────

  describe('listing my reports', () => {
    it('returns only the caller’s own', async () => {
      /**
       * The list is scoped by submitter, not by permission: read-own means own, and a
       * leak here would show one employee another's spending.
       */
      const mine = await makeReport();
      const theirs = await makeReport({ submitterId: strangerId });
      const rows = await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }));
      const ids = rows.map((r: { id: string }) => r.id);
      expect(ids).toContain(mine.id);
      if (strangerId !== ownerId) expect(ids).not.toContain(theirs.id);
    });

    it('narrows to a status', async () => {
      const draft = await makeReport();
      const submitted = await makeReport({ status: 'SUBMITTED' });
      const rows = await inOrg(() => makeCaller(RW, ownerId).list({ status: 'SUBMITTED', limit: 100 }));
      const ids = rows.map((r: { id: string }) => r.id);
      expect(ids).toContain(submitted.id);
      expect(ids).not.toContain(draft.id);
    });

    it('honours the limit', async () => {
      await makeReport();
      await makeReport();
      const rows = await inOrg(() => makeCaller(RW, ownerId).list({ limit: 1 }));
      expect(rows).toHaveLength(1);
    });

    it('works with no input at all', async () => {
      // The client calls it bare on first paint.
      await makeReport();
      await expect(inOrg(() => makeCaller(RW, ownerId).list())).resolves.toBeInstanceOf(Array);
    });

    it('offers the report’s total in the READER’s currency, at a disclosed rate', async () => {
      /**
       * F52: the audit looked for a way to read a historical USD report in CAD and found
       * only the FX override, which converts foreign LINES into the report's currency — the
       * opposite direction.
       *
       * ONE RATE over the already-correct roll-up, not a second roll-up at the reader's
       * currency: a second one would discard every expense's snapshotted `fxRate` and
       * silently re-value a filed claim at today's rates, and it would recompute
       * `missingRates` against the target so a DISPLAY toggle could change which lines count.
       */
      // VeloExpense: the reader's currency is their entity's, else CAD (`readerCurrencyCode`);
      // a person carries no currency of their own, and a currency is keyed by its code.
      const { readerCurrencyCode } = await import('@/server/lib/readerCurrency');
      const readerCode = await inOrg(() => readerCurrencyCode(db, ownerId));
      const foreign = await inOrg(() =>
        db.currency.findFirstOrThrow({
          where: { code: { not: readerCode } },
          select: { code: true },
        }),
      );
      const r = await makeReport({ currencyId: foreign.code }, 1);
      const out = await inOrg(() => makeCaller(RW, ownerId).report({ reportId: r.id }));

      // Either a converted view with the rate that produced it, or null — never a figure
      // without the rate behind it, which would be a guess presented as an answer.
      if (out.viewInReaderCurrency !== null) {
        expect(out.viewInReaderCurrency.currency).toBe(readerCode);
        expect(typeof out.viewInReaderCurrency.totalMinor).toBe('string');
      }
    });

    it('values the report at the rate its expense was FILED at, not today’s', async () => {
      /**
       * GA audit v2, GA-3. One expense, one date, two answers:
       *
       *     Report header, toggled to CAD   CAD 174.29
       *     The one line composing it       CAD 174.14
       *
       * Source USD 125.50 in both views. Not rounding — rounding one amount at one rate
       * cannot produce two figures. The line showed the rate the expense was FILED at,
       * snapshotted on the row; the header converted the rolled-up total at whatever the
       * FX table says today.
       *
       * The snapshot is authoritative. A claim's value in another currency is what it was
       * worth when incurred — otherwise an approved report's total moves daily and an
       * employee reconciling a reimbursement line by line never ties out.
       */
      // VeloExpense: a currency is keyed by its code, so its "id" is the code; the reader's
      // currency is their entity's, so the owner is given a CAD entity.
      const usd = { id: 'USD' };
      const cad = { id: 'CAD' };
      await inOrg(async () => {
        const entity = await db.legalEntity.create({
          data: { label: { en: 'Reports CA' }, country: 'CA', homeCurrencyId: cad.id },
          select: { id: true },
        });
        await db.user.update({ where: { id: ownerId }, data: { legalEntityId: entity.id } });
      });

      // Today's table says one thing…
      await inOrg(() => db.fxRate.deleteMany({ where: { base: 'USD', quote: 'CAD' } }));
      await inOrg(() =>
        db.fxRate.create({
          data: { base: 'USD', quote: 'CAD', rate: '1.38876', fetchedAt: new Date() },
        }),
      );

      const r = await inOrg(() => db.expenseReport.create({
        data: {
          title: 'filed-rate report',
          currencyId: usd.id,
          submitterId: ownerId,
          expenses: {
            // …and the expense was filed at another.
            create: [
              {
                ownerId,
                currencyId: usd.id,
                date: new Date('2026-08-27T12:00:00Z'),
                amountMinor: 12_550n,
                merchant: 'Core Flow',
                fxRate: '1.38757',
                homeCurrency: 'CAD',
              },
            ],
          },
        },
        select: { id: true },
      }));

      const out = await inOrg(() => makeCaller(RW, ownerId).report({ reportId: r.id }));
      expect(out.viewInReaderCurrency).not.toBeNull();
      // 12550 × 1.38757 = 17414, which is what the LINE shows.
      // Today's rate would give 17429 — the header's figure, and the defect.
      expect(out.viewInReaderCurrency?.totalMinor).toBe('17414');
    });

    it('offers NOTHING when the reader’s currency IS the report’s', async () => {
      // A toggle between a currency and itself is noise.
      // VeloExpense: as above — `readerCurrencyCode`, and the code is the key.
      const { readerCurrencyCode } = await import('@/server/lib/readerCurrency');
      const readerCode = await inOrg(() => readerCurrencyCode(db, ownerId));
      const same = await inOrg(() =>
        db.currency.findFirstOrThrow({
          where: { code: readerCode },
          select: { code: true },
        }),
      );
      const r = await makeReport({ currencyId: same.code }, 1);
      const out = await inOrg(() => makeCaller(RW, ownerId).report({ reportId: r.id }));
      expect(out.viewInReaderCurrency).toBeNull();
    });

    it('converts each total into the reader’s own currency', async () => {
      /**
       * "Open balance" used to sum `totalMinor` raw across every submitted and approved
       * report — USD cents added to CAD cents — and print one generic `$` in front of the
       * result. Because CAD and USD share that glyph, nothing on screen disclosed it (GA
       * readiness report F54).
       *
       * The row now carries the total converted into the reader's currency, so the client
       * can sum ONE currency, and `null` where no rate connects the pair so it can leave
       * that report out and say so instead of folding it in at the wrong scale.
       */
      // VeloExpense: the reader's currency is their entity's, else CAD (`readerCurrencyCode`).
      const { readerCurrencyCode } = await import('@/server/lib/readerCurrency');
      const expectedHome = await inOrg(() => readerCurrencyCode(db, ownerId));

      const mine = await makeReport({ currencyId: expectedHome, totalMinor: 10_000n });
      const rows = await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }));
      const row = rows.find((r: { id: string }) => r.id === mine.id);

      expect(row.homeCurrency).toBe(expectedHome);
      // Same currency as the reader: exactly the stored total, with no rate lookup and no
      // rounding in between.
      expect(row.homeTotalMinor).toBe('10000');

      // And every row answers the question one way or the other — a string, or an explicit
      // null. `undefined` would let the client treat it as zero without knowing.
      for (const r of rows) {
        expect(r.homeCurrency).toBe(expectedHome);
        expect(r.homeTotalMinor === null || typeof r.homeTotalMinor === 'string').toBe(true);
      }
    });

    it('values a foreign report through the rate table, or excludes it', async () => {
      /**
       * The rule `buildReportRollup` already follows for a report, applied to the list: an
       * amount with no path to the reader's currency is EXCLUDED and disclosed, never added
       * in at the wrong units. Zero would be a lie the client could not detect.
       */
      const { readerCurrencyCode } = await import('@/server/lib/readerCurrency');
      const expectedHome = await inOrg(() => readerCurrencyCode(db, ownerId));
      const foreign = await inOrg(() =>
        db.currency.findFirstOrThrow({
          where: { code: { not: expectedHome } },
          select: { code: true },
        }),
      );

      const r = await makeReport({ currencyId: foreign.code, totalMinor: 5_000n }, 1);
      const rows = await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }));
      const row = rows.find((x: { id: string }) => x.id === r.id);

      // Whichever way it goes, it must not be the raw minor amount dressed up as the
      // reader's currency — that is precisely the bug.
      if (row.homeTotalMinor === null) {
        expect(row.homeTotalMinor).toBeNull(); // no rate in either direction: excluded
      } else {
        expect(row.homeTotalMinor).not.toBe('5000');
      }
    });

    it('sends the total as a string, because it is a BigInt', async () => {
      /**
       * `JSON.stringify` throws on a BigInt, so a raw column here would fail the whole
       * response rather than one field.
       */
      const r = await makeReport({ totalMinor: 4200n });
      const row = (await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }))).find(
        (x: { id: string }) => x.id === r.id,
      );
      expect(row.totalMinor).toBe('4200');
    });

    it('counts the expenses on each report', async () => {
      const r = await makeReport({}, 3);
      const row = (await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }))).find(
        (x: { id: string }) => x.id === r.id,
      );
      expect(row.expenseCount).toBe(3);
    });

    it('says nobody is holding a draft', async () => {
      const r = await makeReport();
      const row = (await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }))).find(
        (x: { id: string }) => x.id === r.id,
      );
      expect(row.pendingWith).toBeNull();
    });

    it('names who a submitted report is sitting with', async () => {
      /**
       * The reason the query exists: "Submitted" alone tells the submitter nothing about
       * whether their report is stuck, or with whom.
       */
      const r = await makeReport({ status: 'SUBMITTED' });
      await makeInstance(r.id, [{ assigneeUserId: strangerId }]);
      const row = (await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }))).find(
        (x: { id: string }) => x.id === r.id,
      );
      expect(row.pendingWith).not.toBeNull();
      expect(row.pendingWith.email).toBeTruthy();
    });

    it('reports a parallel gate by its first approver, not by a list', async () => {
      /**
       * The row has space for one name. Naming the earliest task is a choice, and a
       * stable one; inventing a list the column cannot show is not.
       */
      const r = await makeReport({ status: 'SUBMITTED' });
      await makeInstance(r.id, [{ assigneeUserId: ownerId }, { assigneeUserId: strangerId }]);
      const row = (await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }))).find(
        (x: { id: string }) => x.id === r.id,
      );
      expect(row.pendingWith).not.toBeNull();
      // VeloExpense: and it is the first one, by creation.
      expect(row.pendingWith.email).toBe('owner@reports.test');
    });

    it('says nobody for an unclaimed pool task', async () => {
      // A filter-pool task has no assignee yet; "with nobody" is the honest answer.
      const r = await makeReport({ status: 'SUBMITTED' });
      await makeInstance(r.id, [{}]);
      const row = (await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }))).find(
        (x: { id: string }) => x.id === r.id,
      );
      expect(row.pendingWith).toBeNull();
    });

    it('says nobody once every task is decided', async () => {
      const r = await makeReport({ status: 'APPROVED', approvedAt: new Date() });
      await makeInstance(r.id, [{ assigneeUserId: strangerId, status: 'APPROVED' }]);
      const row = (await inOrg(() => makeCaller(RW, ownerId).list({ limit: 100 }))).find(
        (x: { id: string }) => x.id === r.id,
      );
      expect(row.pendingWith).toBeNull();
    });
  });

  // VeloExpense: the cases above inject the caller's context; this one goes through the
  // request path — the tenant middleware resolves the session from the database and the
  // role's permissions — so the router is proven reachable the way the app reaches it.
  describe('through the request path (VeloExpense)', () => {
    it("lists the caller's own reports, and creates one, as the signed-in member", async () => {
      const { createCallerFactory } = await import('@/server/trpc');
      const { appRouter } = await import('@/server/routers/_app');
      const asOwner = createCallerFactory(appRouter)({
        session: null,
        db,
        rbac: null,
        caller: { email: 'owner@reports.test', organizationId: orgId },
      } as never);
      const created = await asOwner.expenses.create({ title: 'via the app', currency: 'CAD' });
      const rows = await asOwner.expenses.list({ limit: 100 });
      expect(rows.map((r: { id: string }) => r.id)).toContain(created.id);
      // Somebody who is not a member of the tenant is refused outright.
      const other = await createCallerFactory(appRouter)({
        session: null,
        db,
        rbac: null,
        caller: { email: 'nobody@elsewhere.test', organizationId: orgId },
      } as never);
      await expect(other.expenses.list({ limit: 100 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe('creating a report', () => {
    it('accepts a currency CODE and stores the foreign key', async () => {
      /**
       * The client still sends "USD" in places. Writing a code into `currencyId` would
       * be a dangling reference the money helpers cannot resolve.
       */
      const row = await inOrg(() =>
        makeCaller(RW, ownerId).create({
          title: 'by code',
          currency: currencyCode,
        }),
      );
      const stored = await inOrg(() =>
        db.expenseReport.findUniqueOrThrow({
          where: { id: row.id },
          select: { currencyId: true },
        }),
      );
      expect(stored.currencyId).toBe(currencyId);
    });

    // VeloExpense: ExpenseOS's 'accepts a currency id' is not ported. A VeloExpense
    // currency's id IS its code, which the case above covers; there is no uuid to accept.

    it('accepts a lowercase code', async () => {
      // Typed by hand, or carried from an import.
      const row = await inOrg(() =>
        makeCaller(RW, ownerId).create({
          title: 'lowercase',
          currency: currencyCode.toLowerCase(),
        }),
      );
      expect(row.id).toBeTruthy();
    });

    it('refuses a currency nothing recognises', async () => {
      /**
       * A report in a currency with no `Currency` row cannot be converted, totalled or
       * formatted — better to refuse than to create something unusable.
       */
      await expect(
        inOrg(() => makeCaller(RW, ownerId).create({ title: 'bad', currency: 'XXZ' })),
      ).rejects.toThrow(/Unknown currency/);
    });

    it('refuses a currency id that does not exist', async () => {
      await expect(
        inOrg(() =>
          makeCaller(RW, ownerId).create({
            title: 'bad',
            currency: '00000000-0000-7000-8000-0000000000ff',
          }),
        ),
      ).rejects.toThrow(/Unknown currency/);
    });

    it('files the report under the caller', async () => {
      const row = await inOrg(() => makeCaller(RW, ownerId).create({ title: 'mine', currency: currencyCode }));
      const stored = await inOrg(() =>
        db.expenseReport.findUniqueOrThrow({
          where: { id: row.id },
          select: { submitterId: true, status: true },
        }),
      );
      expect(stored.submitterId).toBe(ownerId);
      expect(stored.status).toBe('DRAFT');
    });

    /**
     * No currency sent: the report opens in the filer's resolved currency. Ported from
     * ExpenseOS 67db2e33 (#581), where it was `.default('USD')`.
     *
     * VeloExpense: a person carries no currency of their own (Wave 2), so the rule is
     * `homeCurrencyCode` (f29) — the person's legal entity's, else the tenant's main
     * entity's, else CAD. Every default case expects CAD, because the old fallback was USD
     * and a USD expectation would pass by accident; the explicit-currency case expects USD
     * for the mirror reason. ExpenseOS's "the person's own currency wins" case has no
     * counterpart here.
     */
    describe('with no currency sent', () => {
      let n = 0;
      const entityIn = async (code: string | null): Promise<string> =>
        (
          await admin.query(
            `INSERT INTO legal_entity (organization_id, label, currency_code) VALUES ($1, $2, $3) RETURNING id`,
            [orgId, JSON.stringify({ en: `hc entity ${++n}` }), code],
          )
        ).rows[0].id as string;
      const filer = async (tag: string, legalEntityId: string | null): Promise<string> =>
        (
          await admin.query(
            `INSERT INTO app_user (organization_id, email, display_name, role_id, legal_entity_id)
             VALUES ($1, $2, $2, '019e3000-0000-7000-8000-000000000004', $3) RETURNING id`,
            [orgId, `hc-${tag}@reports.test`, legalEntityId],
          )
        ).rows[0].id as string;
      const storedCurrencyOf = async (userId: string): Promise<string> => {
        const row = await inOrg(() => makeCaller(RW, userId).create({ title: 'x' }));
        return (
          await inOrg(() =>
            db.expenseReport.findUniqueOrThrow({ where: { id: row.id }, select: { currencyId: true } }),
          )
        ).currencyId;
      };

      it('files in the filer’s entity currency when none is sent', async () => {
        const userId = await filer('entity', await entityIn('CAD'));
        expect(await storedCurrencyOf(userId)).toBe('CAD');
      });

      it('files a person with no entity in the same currency their totals are read in', async () => {
        // The tenant's main entity's, else CAD — one rule with `readerCurrencyCode` (f29).
        const userId = await filer('none', null);
        const { homeCurrencyCode } = await import('@expenseos/db');
        const expected = await inOrg(() => homeCurrencyCode(db, userId));
        expect(await storedCurrencyOf(userId)).toBe(expected);
      });

      it('lets an explicit currency win over the filer’s default', async () => {
        const userId = await filer('explicit', await entityIn('CAD'));
        const row = await inOrg(() => makeCaller(RW, userId).create({ title: 'x', currency: 'USD' }));
        const stored = await inOrg(() =>
          db.expenseReport.findUniqueOrThrow({ where: { id: row.id }, select: { currencyId: true } }),
        );
        expect(stored.currencyId).toBe('USD');
      });

      it('tells each caller their own default currency, and nobody else’s', async () => {
        /**
         * `defaultCurrency` takes no input, so the session is the only thing that can
         * pick whose answer it is. Two callers in different currencies, asked back to
         * back, each get their own — a cached or shared answer would give one of them
         * the other's.
         */
        const cadUser = await filer('dc-cad', await entityIn('CAD'));
        const usdUser = await filer('dc-usd', await entityIn('USD'));
        expect(await inOrg(() => makeCaller(RW, cadUser).defaultCurrency())).toEqual({ code: 'CAD' });
        expect(await inOrg(() => makeCaller(RW, usdUser).defaultCurrency())).toEqual({ code: 'USD' });
      });
    });

    // VeloExpense: the number VeloExpense's writer has always minted, per tenant.
    it('numbers the report from the tenant’s own sequence', async () => {
      const a = await inOrg(() => makeCaller(RW, ownerId).create({ title: 'numbered', currency: currencyCode }));
      const b = await inOrg(() => makeCaller(RW, ownerId).create({ title: 'numbered', currency: currencyCode }));
      expect(a.number).toMatch(/^EXP-\d{6}$/);
      expect(Number(b.number.slice(4))).toBe(Number(a.number.slice(4)) + 1);
    });
  });

  // ── deleteReport ────────────────────────────────────────────────────────────

  describe('allocating an expense across dimensions', () => {
    /**
     * VeloExpense: inside this block `db` and `makeCaller` run every call in the test
     * tenant (the suite's own are bare and go through `inOrg`), so the ported bodies stay
     * ExpenseOS's.
     */
    const db: any = new Proxy(
      {},
      {
        get: (_t, model) =>
          new Proxy(
            {},
            {
              get:
                (_m, method) =>
                (...args: unknown[]) =>
                  inOrg(() => suiteDb()[model][method](...args)),
            },
          ),
      },
    );
    const makeCaller = (perms: readonly string[], userId: string): any =>
      new Proxy(
        {},
        {
          get:
            (_t, procedure) =>
            (...args: unknown[]) =>
              inOrg(() => suiteCaller(perms, userId)[procedure](...args)),
        },
      );

    const allocation = (over: Record<string, unknown> = {}) => ({
      percentBp: 10_000,
      businessUnitId: null as string | null,
      departmentId: null as string | null,
      // VeloExpense: no class.
      ...over,
    });

    let buId: string;
    let deptId: string;

    beforeAll(async () => {
      // VeloExpense: this block's own business unit and department (ExpenseOS reads seeded
      // ones).
      buId = (await db.businessUnit.create({ data: { label: { en: 'Alloc BU' } }, select: { id: true } })).id;
      deptId = (await db.department.create({ data: { label: { en: 'Alloc dept' } }, select: { id: true } })).id;
    });

    const expenseOn = async () => {
      const report = await makeReport({}, 1);
      const e = await db.expense.findFirstOrThrow({
        where: { reportId: report.id },
        select: { id: true },
      });
      return e.id;
    };

    it('stores a split that totals 100%', async () => {
      const expenseId = await expenseOn();
      await makeCaller(RW, ownerId).allocationSet({
        expenseId,
        allocations: [
          allocation({ percentBp: 6000, businessUnitId: buId, departmentId: deptId }),
          allocation({ percentBp: 4000, businessUnitId: buId, departmentId: deptId }),
        ],
      });
      const rows = await db.expenseAllocation.findMany({ where: { expenseId } });
      expect(rows).toHaveLength(2);
      expect(rows.reduce((a: number, r: { percentBp: number }) => a + r.percentBp, 0)).toBe(10_000);
    });

    it('refuses a split that does not total 100%', async () => {
      /**
       * The allocation set IS the cost split. 90% allocated means 10% of the charge is
       * booked nowhere, which reconciles against nothing.
       */
      const expenseId = await expenseOn();
      await expect(
        makeCaller(RW, ownerId).allocationSet({
          expenseId,
          allocations: [
            allocation({ percentBp: 9000, businessUnitId: buId, departmentId: deptId }),
          ],
        }),
      ).rejects.toThrow(/total 100%/);
    });

    it('refuses a row with no business unit', async () => {
      // The two dimensions every downstream report groups by.
      const expenseId = await expenseOn();
      await expect(
        makeCaller(RW, ownerId).allocationSet({
          expenseId,
          allocations: [allocation({ departmentId: deptId })],
        }),
      ).rejects.toThrow(/Business Unit and Department/);
    });

    it('refuses a row with no department', async () => {
      const expenseId = await expenseOn();
      await expect(
        makeCaller(RW, ownerId).allocationSet({
          expenseId,
          allocations: [allocation({ businessUnitId: buId })],
        }),
      ).rejects.toThrow(/Business Unit and Department/);
    });

    // VeloExpense: "accepts an explicit 'no class'" is not ported — VeloExpense has no class.

    it('replaces the whole set rather than adding to it', async () => {
      // The editor sends the whole split on save; merging would double it.
      const expenseId = await expenseOn();
      const caller = makeCaller(RW, ownerId);
      await caller.allocationSet({
        expenseId,
        allocations: [
          allocation({ percentBp: 5000, businessUnitId: buId, departmentId: deptId }),
          allocation({ percentBp: 5000, businessUnitId: buId, departmentId: deptId }),
        ],
      });
      await caller.allocationSet({
        expenseId,
        allocations: [allocation({ businessUnitId: buId, departmentId: deptId })],
      });
      const rows = await db.expenseAllocation.findMany({ where: { expenseId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].percentBp).toBe(10_000);
    });

    it('clears the split when handed an empty list', async () => {
      /**
       * "No explicit split" is a legitimate state — the expense then inherits the
       * report's own coding — so an empty array must not be read as a 0% error.
       */
      const expenseId = await expenseOn();
      const caller = makeCaller(RW, ownerId);
      await caller.allocationSet({
        expenseId,
        allocations: [allocation({ businessUnitId: buId, departmentId: deptId })],
      });
      await caller.allocationSet({ expenseId, allocations: [] });
      expect(await db.expenseAllocation.count({ where: { expenseId } })).toBe(0);
    });

    it('leaves an audit row behind', async () => {
      // Cost allocation is a financial statement about where money landed.
      const expenseId = await expenseOn();
      await makeCaller(RW, ownerId).allocationSet({
        expenseId,
        allocations: [allocation({ businessUnitId: buId, departmentId: deptId })],
      });
      expect(await lastAudit('Expense', expenseId)).not.toBeNull();
    });

    it('refuses to touch a submitted report’s expense', async () => {
      /**
       * A submitted report is evidence in somebody else's queue; re-coding it under an
       * approver would change what they are looking at.
       */
      const report = await makeReport({ status: 'SUBMITTED' }, 1);
      const e = await db.expense.findFirstOrThrow({
        where: { reportId: report.id },
        select: { id: true },
      });
      await expect(
        makeCaller(RW, ownerId).allocationSet({
          expenseId: e.id,
          allocations: [allocation({ businessUnitId: buId, departmentId: deptId })],
        }),
      ).rejects.toThrow();
    });
  });

  describe('deleting a draft report', () => {
    it('deletes it, and everything hanging off it', async () => {
      const report = await makeReport({}, 2);
      await inOrg(() => makeCaller(RW, ownerId).deleteReport({ reportId: report.id }));
      expect(await inOrg(() => db.expenseReport.findUnique({ where: { id: report.id } }))).toBeNull();
      expect(await inOrg(() => db.expense.count({ where: { reportId: report.id } }))).toBe(0);
    });

    it('refuses somebody else’s report, as not found', async () => {
      /**
       * NOT_FOUND rather than FORBIDDEN: whether a report exists is itself information
       * a stranger should not get.
       */
      if (strangerId === ownerId) return;
      const report = await makeReport({ submitterId: strangerId });
      await expect(
        inOrg(() => makeCaller(RW, ownerId).deleteReport({ reportId: report.id })),
      ).rejects.toThrow();
      expect(await inOrg(() => db.expenseReport.findUnique({ where: { id: report.id } }))).not.toBeNull();
    });

    it('refuses a report that has been submitted', async () => {
      /**
       * Once it is out for approval it is somebody else's queue item, and deleting it
       * would silently empty their inbox.
       */
      const report = await makeReport({ status: 'SUBMITTED' });
      await expect(
        inOrg(() => makeCaller(RW, ownerId).deleteReport({ reportId: report.id })),
      ).rejects.toThrow(/Only DRAFT/);
    });

    it('refuses a report that no longer exists', async () => {
      await expect(
        inOrg(() =>
          makeCaller(RW, ownerId).deleteReport({
            reportId: '00000000-0000-7000-8000-0000000000fe',
          }),
        ),
      ).rejects.toThrow();
    });

    it('removes the receipts’ files, collected before the cascade', async () => {
      /**
       * The keys have to be read while the Receipt rows still exist — after the cascade
       * there is nothing left to enumerate, and the objects would be orphaned in S3
       * forever.
       */
      const report = await makeReport({}, 1);
      const expense = await inOrg(() =>
        db.expense.findFirstOrThrow({
          where: { reportId: report.id },
          select: { id: true },
        }),
      );
      await inOrg(() =>
        db.receipt.create({
          data: {
            expenseId: expense.id,
            filename: 'receipt.pdf',
            contentType: 'application/pdf',
            sizeBytes: 100,
            s3Key: `${report.id}/to-be-deleted.pdf`,
            uploadedById: ownerId,
          },
        }),
      );
      await inOrg(() => makeCaller(RW, ownerId).deleteReport({ reportId: report.id }));
      expect(storage.delete).toHaveBeenCalledWith(`${report.id}/to-be-deleted.pdf`);
    });

    it('still deletes when the storage removal fails', async () => {
      /**
       * Best-effort on purpose: an orphaned object costs pennies, where a report that
       * cannot be deleted because S3 is down is a person stuck.
       */
      const report = await makeReport({}, 1);
      const expense = await inOrg(() =>
        db.expense.findFirstOrThrow({
          where: { reportId: report.id },
          select: { id: true },
        }),
      );
      await inOrg(() =>
        db.receipt.create({
          data: {
            expenseId: expense.id,
            filename: 'receipt.pdf',
            contentType: 'application/pdf',
            sizeBytes: 100,
            s3Key: `${report.id}/unreachable.pdf`,
            uploadedById: ownerId,
          },
        }),
      );
      storage.delete.mockRejectedValueOnce(new Error('S3 unreachable'));
      await expect(
        inOrg(() => makeCaller(RW, ownerId).deleteReport({ reportId: report.id })),
      ).resolves.toMatchObject({ ok: true });
      expect(await inOrg(() => db.expenseReport.findUnique({ where: { id: report.id } }))).toBeNull();
    });

    it('leaves an audit row naming the report', async () => {
      const report = await makeReport();
      await inOrg(() => makeCaller(RW, ownerId).deleteReport({ reportId: report.id }));
      // VeloExpense: under VeloExpense's name for ExpenseOS's `report.delete`.
      expect(await lastAudit('ExpenseReport', report.id)).toEqual({ action: 'REPORT_DELETED' });
    });
  });

  // ── who reads a report, and what each reader is sent ───────────────────────────

  describe('reading somebody else’s report', () => {
    /**
     * `expenses.report`, `explainTax` and `explainPerDiem` admit exactly the drawer's
     * audience (`canViewReport`): the submitter, their direct manager, anyone a task on
     * the report touched, and AP / readers of all. Widening the report page to that
     * audience is only safe because a reader who cannot WRITE the line is sent what the
     * drawer sends them — the route as stop names, and no year-to-date basis.
     *
     * The people are picked by relationship, not position: an arbitrary "stranger" can be
     * the submitter's manager, and the refusal would then fail for a legitimate reason.
     * Everyone but the submitter carries an ordinary employee's permissions, so the only
     * way in is the relationship under test.
     */
    let submitter: string;
    let manager: string;
    let decider: string;
    let outsider: string;
    let reportId: string;
    let expenseId: string;
    let lineId: string;

    const STORED_ROUTE = {
      stops: [
        { description: 'Head office', placeId: 'place-office' },
        { description: 'Client site', placeId: 'place-client' },
      ],
      legs: [{ fromPlaceId: 'place-office', toPlaceId: 'place-client', meters: 20000 }],
    };

    /*
     * VeloExpense: the people are made here, in the suite's tenant, rather than picked from
     * ExpenseOS's shared seed — the relationship each one has is then the only one. The decided
     * task is written beside `makeInstance`'s (which writes no decider).
     */
    beforeAll(async () => {
      const person = async (email: string, managerId: string | null = null) =>
        (
          await admin.query(
            `INSERT INTO app_user (organization_id, email, display_name, role_id, manager_id)
             VALUES ($1, $2, $2, '019e3000-0000-7000-8000-000000000004', $3) RETURNING id`,
            [orgId, email, managerId],
          )
        ).rows[0].id as string;
      manager = await person('reader-manager@reports.test');
      submitter = await person('reader-submitter@reports.test', manager);
      decider = await person('reader-decider@reports.test');
      outsider = await person('reader-outsider@reports.test');

      const { id: categoryId } = await inOrg(() =>
        db.expenseCategory.create({
          data: { label: { en: `QA mileage ${Date.now()}` } },
          select: { id: true },
        }),
      );

      const report = await inOrg(() =>
        db.expenseReport.create({
          data: {
            title: 'report under test',
            currencyId,
            submitterId: submitter,
            status: 'SUBMITTED',
            expenses: {
              create: {
                ownerId: submitter,
                currencyId,
                date: new Date('2026-07-01T12:00:00Z'),
                amountMinor: 1500n,
                merchant: 'Drive to the client',
                lineItems: {
                  create: {
                    kind: 'MILEAGE',
                    categoryId,
                    amountMinor: 1500n,
                    mileageDistance: '25.00',
                    mileageUnit: 'KM',
                    mileageYtdBefore: '1200.50',
                    mileageRoute: STORED_ROUTE,
                  },
                },
              },
            },
          },
          select: {
            id: true,
            expenses: { select: { id: true, lineItems: { select: { id: true } } } },
          },
        }),
      );
      reportId = report.id;
      expenseId = report.expenses[0].id;
      lineId = report.expenses[0].lineItems[0].id;

      // A decided task only: nobody is eligible to decide now, so the decider is admitted
      // by having decided, and the outsider by nothing at all.
      const instanceId = await makeInstance(reportId, []);
      await admin.query(
        `INSERT INTO approval_instance_task (organization_id, instance_id, node_id, status, decided_by_id, decided_at)
         VALUES ($1, $2, 'n-decided', 'APPROVED', $3, now())`,
        [orgId, instanceId, decider],
      );
    });

    const lineOf = (screen: any) =>
      screen.expenses
        .flatMap((e: { lineItems: unknown[] }) => e.lineItems)
        .find((li: { id: string }) => li.id === lineId);

    it('admits the submitter’s direct manager and somebody who decided a task', async () => {
      for (const reader of [manager, decider]) {
        const screen = await inOrg(() => makeCaller(RW, reader).report({ reportId }));
        expect(screen.id).toBe(reportId);
      }
    });

    it('hides it from somebody with no relationship to it, as NOT_FOUND', async () => {
      await expect(inOrg(() => makeCaller(RW, outsider).report({ reportId }))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('sends a reader who cannot write the line stop names only, and no year-to-date basis', async () => {
      for (const reader of [manager, decider]) {
        const screen = await inOrg(() => makeCaller(RW, reader).report({ reportId }));
        const wire = JSON.stringify(screen);
        expect(wire).not.toContain('placeId');
        expect(wire).not.toContain('legs');
        expect(wire).not.toContain('meters');

        const line = lineOf(screen);
        expect(line.mileageRoute).toEqual({
          stops: [{ description: 'Head office' }, { description: 'Client site' }],
        });
        expect(line.mileageYtdBefore).toBeNull();
        // The drawer's reading of the route travels too: 20 km filed, 25 km claimed.
        expect(line.routeDistance).toBe('20.00');
        expect(line.mileageRouteUnavailable).toBe(false);
      }
    });

    it('sends the submitter their route exactly as stored, legs and place ids intact', async () => {
      /** The editor re-saves the route it is handed, so a trimmed route reaching the
       *  submitter would erase their place ids and legs on the next save. */
      const stored = await inOrg(() =>
        db.expenseLineItem.findUniqueOrThrow({
          where: { id: lineId },
          select: { mileageYtdBefore: true },
        }),
      );
      const line = lineOf(await inOrg(() => makeCaller(RW, submitter).report({ reportId })));
      expect(line.mileageRoute).toEqual(STORED_ROUTE);
      expect(line.mileageYtdBefore).toBe(stored.mileageYtdBefore.toString());
      expect(line.routeDistance).toBe('20.00');
      expect(line.mileageRouteUnavailable).toBe(false);
    });

    it('lets the manager ask why the tax is what it is, and refuses the outsider', async () => {
      await expect(inOrg(() => makeCaller(RW, manager).explainTax({ expenseId }))).resolves.toBeDefined();
      await expect(inOrg(() => makeCaller(RW, outsider).explainTax({ expenseId }))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    // VeloExpense: ExpenseOS's `explainPerDiem` case is not carried — that procedure is not
    // ported yet (see the router's header).
  });
});
