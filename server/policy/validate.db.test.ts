// Ported from ExpenseOS `apps/web/src/server/policy/validate.db.test.ts` (550b2945), w4-02d (d63). Each adaptation is
// marked "VeloExpense:".
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

/**
 * `validateReport` under CONCURRENT callers, against a real database.
 *
 * A db test because the fault is a property of Postgres isolation, which no fake
 * reproduces: the swap is `findMany → deleteMany → createMany` inside one transaction, and
 * under READ COMMITTED two such transactions overlapping each see the other's rows as
 * absent — an uncommitted delete or insert is invisible — so both delete nothing and both
 * insert. The report then carries two identical rows for one finding, 2 ms apart, and the
 * workbench says "2 violations" for one; justifying one leaves the other blocking submit.
 *
 * That overlap is not hypothetical: the workbench fires one validate per edit and another
 * when receipt extraction settles, which is how `expense-per-diem.spec.ts:101` flaked.
 *
 * The fix is a `SELECT ... FOR UPDATE` on the report row at the top of the transaction,
 * so the second caller waits and then sees — and replaces — the first caller's rows. This
 * file is what proves it: run several validates at once, expect exactly one row per
 * finding. It fails without the lock — the first round of four callers left 12 rows for
 * 4 findings, measured — and passes with it.
 *
 * Uses the seeded per-category default policy (receipt required + a per-transaction
 * limit), so one receiptless over-limit line yields a stable set of findings without this
 * file arming a rule of its own. Gated on DATABASE_URL, like every `*.db.test.ts`.
 */

/*
 * VeloExpense: replaces VeloExpense's own v1 test of the same race
 * (test/policy-concurrent-validate.db.test.ts), whose engine this cutover deletes. Its own
 * tenant, provisioned here, with its two rules armed here — VeloExpense seeds no default
 * policy. Each validate runs in its own tenant transaction (`withTenantDb`), which is what a
 * request is; four of them started together overlap for real.
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/jobs', () => ({ enqueue: vi.fn(async () => {}) }));

const t = (k: string) => k;

describe.skipIf(!process.env.DATABASE_URL)('validateReport under concurrent callers', () => {
  const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  let orgId: string;
  let ownerId: string;
  let reportId: string;
  let validateReport: typeof import('./validate').validateReport;
  let withTenantDb: typeof import('@/lib/db/prisma').withTenantDb;

  const validate = () => withTenantDb(orgId, (db) => validateReport({ db, reportId, t }));
  const rowsOf = () =>
    withTenantDb(orgId, (db) =>
      db.policyViolation.findMany({ where: { reportId }, select: { id: true, lineItemId: true, ruleCode: true, severity: true, resolveNote: true, resolvedAt: true } }),
    );

  beforeAll(async () => {
    ({ validateReport } = await import('./validate'));
    ({ withTenantDb } = await import('@/lib/db/prisma'));
    const { createOrganization } = await import('@/lib/onboarding/provision');
    const { createCallerFactory } = await import('@/server/trpc');
    const { appRouter } = await import('@/server/routers/_app');
    const { db } = await import('@/lib/db/prisma');

    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    orgId = (
      await createOrganization({ name: 'Race Co', slug: 'race-co-v2', adminEmail: 'race@race.test', adminName: 'Racer' })
    ).organizationId;
    ownerId = (await admin.query(`SELECT id FROM app_user WHERE email = 'race@race.test'`)).rows[0].id;
    const categoryId = (
      await admin.query(
        `INSERT INTO expense_category (organization_id, code, label) VALUES ($1, 'RACE', '{"en":"Race"}') RETURNING id`,
        [orgId],
      )
    ).rows[0].id as string;
    // VeloExpense: the two rules ExpenseOS's seed provides — a receipt threshold and a
    // per-transaction limit (as the cutover converts v1's, a line predicate).
    await admin.query(
      `INSERT INTO policy_rule (organization_id, kind_code, scope, severity, condition, params, message_key, effective_from) VALUES
         ($1, 'RECEIPT_THRESHOLD', 'AGGREGATE', 'BLOCK', NULL, '{"thresholdMinor":"2500"}', 'receiptThreshold', '2000-01-01'),
         ($1, 'PREDICATE_LINE', 'LINE', 'WARNING', '{"all":[{"field":"lineAmount","op":"gt","value":50000}]}', '{}', 'perTransactionLimit', '2000-01-01')`,
      [orgId],
    );

    const expenses = createCallerFactory(appRouter)({
      session: null,
      db,
      rbac: null,
      caller: { email: 'race@race.test', organizationId: orgId },
    }).expenses;
    const report = await expenses.create({ title: 'concurrent validate', currency: 'CAD' });
    reportId = report.id;
    const created = await expenses.createExpense({ reportId });
    // Over the per-transaction limit and receiptless: at least two findings, every run.
    await expenses.lineItemCreate({ expenseId: created.id, categoryId, amountMinor: '600000' });
  });

  afterAll(async () => {
    await admin.end();
  });

  /** One row per (lineItemId, ruleCode) — the identity the carry-forward keys on. */
  const identities = (rows: Array<{ lineItemId: string | null; ruleCode: string }>) =>
    rows.map((r) => `${r.lineItemId ?? ''}|${r.ruleCode}`).sort();

  it('serial validates produce one row per finding (the baseline)', async () => {
    const res = await validate();
    expect(res.violations.length).toBeGreaterThanOrEqual(2);
    const rows = await rowsOf();
    expect(rows).toHaveLength(res.violations.length);
    expect(new Set(identities(rows)).size).toBe(rows.length);
  });

  it('concurrent validates on one report still produce exactly one row per finding', async () => {
    /**
     * Four at once, four rounds. One pair overlapping is enough to duplicate without the
     * lock, and four callers make the overlap near-certain; the rounds are there so a
     * single lucky serialization cannot pass the file. Every caller computes the same
     * finding set, so the row count after each round must equal one caller's result.
     */
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all(Array.from({ length: 4 }, () => validate()));
      const expected = identities(results[0].violations);
      expect(expected.length).toBeGreaterThanOrEqual(2);
      for (const r of results) expect(identities(r.violations)).toEqual(expected);

      expect(identities(await rowsOf())).toEqual(expected);
    }
  });

  it('a justification survives the concurrent swap on a single surviving row', async () => {
    /**
     * The user-facing half of the bug: with two rows for one WARNING, the note lands on
     * one and the other keeps blocking. After the lock there is one row to carry the note
     * onto, and it is still there after four callers race.
     */
    await validate();
    const warning = (await rowsOf()).find((r) => r.severity === 'WARNING');
    expect(warning).toBeTruthy();
    await withTenantDb(orgId, (db) =>
      db.policyViolation.update({
        where: { id: warning!.id },
        data: { resolveNote: 'Pre-approved by finance', resolvedAt: new Date(), resolvedBy: ownerId },
      }),
    );

    await Promise.all(Array.from({ length: 4 }, () => validate()));

    const survivors = (await rowsOf()).filter(
      (r) => r.lineItemId === warning!.lineItemId && r.ruleCode === warning!.ruleCode,
    );
    expect(survivors).toHaveLength(1);
    expect(survivors[0].resolveNote).toBe('Pre-approved by finance');
    expect(survivors[0].resolvedAt).toBeTruthy();
  });
});
