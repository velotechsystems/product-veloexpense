// Ported from ExpenseOS `apps/web/src/server/routers/policyViolations.db.test.ts` (550b2945), w4-02e (d63). Each
// adaptation is marked "VeloExpense:".
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { TRPCError } from '@trpc/server';

/**
 * Integration test for the policy-violation register polish:
 *   - validate persists `expenseId` on line-anchored violations,
 *   - policies.policyRule.violations lists them (kind resolved from ruleCode),
 *   - policies.policyRule.resolveViolation acknowledges (note) / clears (blank),
 *   - a BLOCK is never resolvable.
 *
 * Uses the seeded per-category default policy (receiptRequired + a $5,000
 * per-transaction limit), so a single receiptless over-limit line yields both a
 * RECEIPT_REQUIRED BLOCK and a PER_TXN_LIMIT WARNING. Gated on DATABASE_URL.
 */

/*
 * VeloExpense: its own tenant, with the two rules armed here — VeloExpense seeds no
 * default policy — as the cutover converts v1's: a RECEIPT_THRESHOLD BLOCK and a
 * per-transaction limit as a PREDICATE_LINE WARNING (0066). The kinds asserted are those.
 * Callers go through the app router as a request does (`caller`), so every read runs
 * under the tenant's RLS. Added: another tenant's violation is invisible and NOT_FOUND;
 * an employee is refused; the acknowledgement is audited into a chain that verifies; a
 * row from before the cutover (v1 kind name in `rule_code`) lists without breaking the
 * register.
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/jobs', () => ({ enqueue: vi.fn(async () => {}) }));

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

describe.skipIf(!process.env.DATABASE_URL)('policy-violation register (integration)', () => {
  const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  let A: string;
  let B: string;
  let ownerId: string;
  let reportId: string;
  let expenseId: string;
  let lineItemId: string;
  let caller: (email: string, organizationId: string) => ReturnType<typeof import('@/server/routers/_app').appRouter.createCaller>;
  const boss = () => caller('boss@viol-a.test', A);

  beforeAll(async () => {
    const { createOrganization } = await import('@/lib/onboarding/provision');
    const { createCallerFactory } = await import('@/server/trpc');
    const { appRouter } = await import('@/server/routers/_app');
    const { db } = await import('@/lib/db/prisma');
    caller = (email, organizationId) =>
      createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });

    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    A = (
      await createOrganization({ name: 'Viol A', slug: 'viol-a', adminEmail: 'boss@viol-a.test', adminName: 'Boss' })
    ).organizationId;
    B = (
      await createOrganization({ name: 'Viol B', slug: 'viol-b', adminEmail: 'boss@viol-b.test', adminName: 'Other' })
    ).organizationId;
    ownerId = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@viol-a.test'`)).rows[0].id;
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, 'emp@viol-a.test', 'Emp', 'EMPLOYEE')`,
      [A],
    );

    for (const [org, email] of [
      [A, 'boss@viol-a.test'],
      [B, 'boss@viol-b.test'],
    ] as const) {
      const categoryId = (
        await admin.query(
          `INSERT INTO expense_category (organization_id, code, label) VALUES ($1, 'VIOL', '{"en":"Viol meals"}') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO policy_rule (organization_id, kind_code, scope, severity, condition, params, message_key, effective_from) VALUES
           ($1, 'RECEIPT_THRESHOLD', 'AGGREGATE', 'BLOCK', NULL, '{"thresholdMinor":"2500"}', 'receiptThreshold', '2000-01-01'),
           ($1, 'PREDICATE_LINE', 'LINE', 'WARNING', '{"all":[{"field":"lineAmount","op":"gt","value":500000}]}', '{}', 'perTransactionLimit', '2000-01-01')`,
        [org],
      );
      const expenses = caller(email, org).expenses;
      const report = await expenses.create({ title: 'policy violations', currency: 'CAD' });
      const created = await expenses.createExpense({ reportId: report.id });
      // Over the $5,000 (500,000-cent) per-transaction limit + no receipt.
      const line = await expenses.lineItemCreate({ expenseId: created.id, categoryId, amountMinor: '600000' });
      if (org === A) {
        reportId = report.id;
        expenseId = created.id;
        lineItemId = (line as { id: string }).id;
      }
      await expenses.validate({ reportId: report.id });
    }
  });

  afterAll(async () => {
    await admin.end();
  });

  it('validate persists expenseId on line-anchored violations', async () => {
    const res = await boss().expenses.validate({ reportId });
    expect(res.counts.block).toBeGreaterThan(0);
    const rows = (
      await admin.query(`SELECT line_item_id, expense_id FROM policy_violation WHERE report_id = $1`, [reportId])
    ).rows as Array<{ line_item_id: string | null; expense_id: string | null }>;
    const anchored = rows.filter((r) => r.line_item_id);
    expect(anchored.length).toBeGreaterThan(0);
    for (const r of anchored) expect(r.expense_id).toBe(expenseId);
  });

  it('violations register lists the report’s violations with kind resolved', async () => {
    const list = await boss().policies.policyRule.violations();
    const mine = list.filter((v) => v.reportId === reportId);
    expect(mine.length).toBeGreaterThan(0);
    const kinds = new Set(mine.map((v) => v.kind));
    // VeloExpense: the kinds the cutover converts v1's rules to.
    expect(kinds.has('RECEIPT_THRESHOLD')).toBe(true);
    expect(kinds.has('PREDICATE_LINE')).toBe(true);
    // kind is the human code, never the raw instance-id ruleCode.
    for (const v of mine) expect(v.kind).not.toMatch(/^[0-9a-f-]{36}$/);
    // VeloExpense: the subject, expense, line and submitter come from the batched lookups.
    expect(mine.find((v) => v.lineItemId === lineItemId)).toMatchObject({
      subjectKind: 'REPORT',
      subjectTitle: 'policy violations',
      submitterName: 'Boss',
      expenseId,
      categoryLabel: { en: 'Viol meals' },
    });
  });

  it('acknowledges a WARNING with a note, then clears it on a blank note', async () => {
    const list = await boss().policies.policyRule.violations();
    const warning = list.find((v) => v.reportId === reportId && v.severity === 'WARNING');
    expect(warning).toBeTruthy();

    const ack = await boss().policies.policyRule.resolveViolation({
      id: warning!.id,
      note: 'Approved by CFO',
    });
    expect(ack.resolvedAt).toBeTruthy();
    expect(ack.resolveNote).toBe('Approved by CFO');
    expect(ack.resolvedBy).toBe(ownerId);

    const cleared = await boss().policies.policyRule.resolveViolation({ id: warning!.id, note: '  ' });
    expect(cleared.resolvedAt).toBeNull();
    expect(cleared.resolveNote).toBeNull();

    // VeloExpense: both writes audited against the violation, into a chain that verifies.
    const audit = (
      await admin.query(
        `SELECT action, entity_type, details->>'op' AS op, details->>'note' AS note FROM audit_entry
          WHERE entity_id = $1 ORDER BY sequence`,
        [warning!.id],
      )
    ).rows;
    expect(audit).toEqual([
      { action: 'POLICY_RULE_CHANGED', entity_type: 'PolicyViolation', op: 'resolveViolation', note: 'Approved by CFO' },
      { action: 'POLICY_RULE_CHANGED', entity_type: 'PolicyViolation', op: 'resolveViolation', note: null },
    ]);
    const { withOrg } = await import('@/lib/tenant/context');
    const { verifyChain } = await import('@/lib/audit/verify');
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('refuses to resolve a BLOCK violation', async () => {
    const list = await boss().policies.policyRule.violations();
    const block = list.find((v) => v.reportId === reportId && v.severity === 'BLOCK');
    expect(block).toBeTruthy();
    await expect(boss().policies.policyRule.resolveViolation({ id: block!.id })).rejects.toThrow();
  });

  it('keeps each tenant’s violations to itself (VeloExpense)', async () => {
    const theirs = (
      await admin.query(
        `SELECT id FROM policy_violation WHERE organization_id = $1 AND severity = 'WARNING' LIMIT 1`,
        [B],
      )
    ).rows[0].id as string;
    expect((await boss().policies.policyRule.violations()).map((v) => v.id)).not.toContain(theirs);
    expect(await codeOf(boss().policies.policyRule.resolveViolation({ id: theirs, note: 'mine now' }))).toBe('NOT_FOUND');
    expect(
      (await admin.query(`SELECT resolve_note FROM policy_violation WHERE id = $1`, [theirs])).rows[0].resolve_note,
    ).toBeNull();
  });

  it('refuses an employee (VeloExpense)', async () => {
    const emp = caller('emp@viol-a.test', A);
    expect(await codeOf(emp.policies.policyRule.violations())).toBe('FORBIDDEN');
    const any = (await boss().policies.policyRule.violations())[0];
    expect(await codeOf(emp.policies.policyRule.resolveViolation({ id: any.id, note: 'x' }))).toBe('FORBIDDEN');
  });

  it('lists a row from before the cutover, named by the kind its v1 rule became (VeloExpense)', async () => {
    /**
     * 0066 kept violations on submitted reports with v1's kind NAME in `rule_code`. Put in
     * a uuid lookup, that name is a query error, and the register would be down for every
     * tenant with history.
     */
    await admin.query(
      `INSERT INTO policy_violation (organization_id, report_id, rule_code, severity, message)
       VALUES ($1, $2, 'PER_TRANSACTION_LIMIT', 'WARNING', 'Over the per-transaction limit of $500.00')`,
      [A, reportId],
    );
    const old = (await boss().policies.policyRule.violations()).find((v) => v.message.startsWith('Over the per-transaction'));
    expect(old).toMatchObject({ kind: 'PER_TXN_LIMIT', subjectTitle: 'policy violations' });
  });
});
