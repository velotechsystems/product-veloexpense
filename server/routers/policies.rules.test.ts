// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The rest of the policy router: per-diem rates, custom fields, the v2 rule registry,
 * and the violation register.
 *
 * The two rules with real consequences:
 *
 *   · **A BLOCK violation is never resolvable from the admin register.** WARNING and
 *     INFO never stop a submission by construction, so acknowledging one is oversight.
 *     A BLOCK is the thing actually preventing a filing, and letting an admin clear it
 *     here would be an override with no approval behind it.
 *   · **A blank note CLEARS the acknowledgment** rather than storing an empty one, so
 *     the register distinguishes "somebody looked at this and signed off" from
 *     "somebody opened the dialog and changed their mind".
 *
 * Per-diem rates carry money as BigInt minor units, so every read has to stringify them
 * — a raw BigInt is unserialisable and a number loses precision.
 */

/*
 * VeloExpense: ported from ExpenseOS (550b2945) with the `policyRule` router (w4-02b). The
 * `perDiemRate` cases belong to the w1-09 port and were missed then; they are carried here
 * now. Not carried yet, each with the code it tests: `customField` (its sub-router is not
 * ported), and `policyRule.violations` / `policyRule.resolveViolation` (the violations
 * register, w4-02d). VeloExpense's own cases are marked; the same rules against Postgres
 * are in test/policy-rules.db.test.ts.
 */

const withAuditCalls: Array<Record<string, unknown>> = [];
vi.mock('@expenseos/audit', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/audit');
  return {
    ...actual,
    withAudit: vi.fn(
      async (db: unknown, envelope: Record<string, unknown>, fn: (tx: unknown) => unknown) => {
        withAuditCalls.push(envelope);
        return fn(db);
      },
    ),
  };
});
// VeloExpense: the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: stubFn(async () => {}),
}));

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const RATE = U('1');
const RULE = U('2');
const VIOLATION = U('3');

const perDiem = (over: Record<string, unknown> = {}) => ({
  id: RATE,
  country: 'CA',
  city: 'Toronto',
  categoryId: U('4'),
  amountMinor: 7_500n,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

function makeDb(over: Record<string, unknown> = {}) {
  return {
    perDiemRate: {
      findMany: stubFn(async () => [] as unknown[]),
      create: stubFn(async () => perDiem()),
      update: stubFn(async () => perDiem()),
      delete: stubFn(async () => perDiem()),
    },
    customField: {
      findMany: stubFn(async () => [] as unknown[]),
      create: stubFn(async () => ({ id: U('5') })),
      update: stubFn(async () => ({ id: U('5') })),
      delete: stubFn(async () => ({ id: U('5') })),
    },
    policyRule: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
      create: stubFn(async () => ({ id: RULE })),
      update: stubFn(async () => ({ id: RULE })),
      delete: stubFn(async () => ({ id: RULE })),
    },
    policyViolation: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => ({ id: VIOLATION, severity: 'WARNING' }) as unknown),
      update: stubFn(async () => ({ id: VIOLATION })),
    },
    // VeloExpense: the register's subject, expense, line and submitter lookups (w4-02e).
    expenseReport: { findMany: stubFn(async () => [] as unknown[]) },
    expense: { findMany: stubFn(async () => [] as unknown[]) },
    user: { findMany: stubFn(async () => [] as unknown[]) },
    expenseCategory: { findMany: stubFn(async () => [] as unknown[]) },
    jobLevel: { findMany: stubFn(async () => [] as unknown[]) },
    legalEntity: { findMany: stubFn(async () => [] as unknown[]) },
    businessUnit: { findMany: stubFn(async () => [] as unknown[]) },
    department: { findMany: stubFn(async () => [] as unknown[]) },
    role: { findMany: stubFn(async () => [] as unknown[]) },
    currency: { findMany: stubFn(async () => [] as unknown[]) },
    systemFlag: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => ({ value: 'CAD' }) as unknown),
      upsert: stubFn(async () => ({ key: 'k', value: 'v' })),
    },
    expensePolicy: { findMany: stubFn(async () => [] as unknown[]), upsert: vi.fn() },
    fxRate: { findMany: stubFn(async () => [] as unknown[]), create: vi.fn() },
    mileageRate: { findMany: stubFn(async () => [] as unknown[]) },
    expenseLineItem: { count: stubFn(async () => 0), findMany: stubFn(async () => [] as unknown[]) },
    // VeloExpense: `policyRule.kinds` reads the organization's policy currency (0015).
    $queryRaw: stubFn(async () => [{ code: 'CAD' }] as unknown[]),
    ...over,
  };
}

async function callerFor(db: unknown, permissions: readonly string[]) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { policiesRouter } = await import('./policies');
  return createCallerFactory(policiesRouter)(
    makeContext({ db, userId: ME, permissions, roleLabel: 'Admin', name: null, email: 'a@e.inc' }),
  );
}

const READ = [P.config.policyRead] as const;
const PER_DIEM = [P.config.perDiemUpdate] as const;
const POLICY = [P.config.policyUpdate] as const;

beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
});

describe('perDiemRate', () => {
  const rate = (over: Record<string, unknown> = {}) => ({
    country: 'CA',
    city: 'Toronto',
    categoryId: U('4'),
    amountMinor: '7500',
    effectiveFrom: '2026-01-01T00:00:00Z',
    ...over,
  });

  it('needs its own write permission', async () => {
    const db = makeDb();
    const reader = await callerFor(db, READ);
    await expect(reader.perDiemRate.list()).resolves.toBeTruthy();
    await expect(reader.perDiemRate.create(rate() as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('stringifies the amount on every path', async () => {
    /**
     * BigInt minor units: a raw BigInt cannot be serialised at all, and a number loses
     * precision. Every read and write has to convert.
     */
    const db = makeDb();
    db.perDiemRate.findMany.mockResolvedValue([perDiem()]);
    const c = await callerFor(db, [...READ, ...PER_DIEM]);
    expect((await c.perDiemRate.list())[0]?.amountMinor).toBe('7500');
    expect(
      ((await c.perDiemRate.create(rate() as never)) as { amountMinor: unknown }).amountMinor,
    ).toBe('7500');
    expect(
      ((await c.perDiemRate.update({ id: RATE, patch: {} } as never)) as { amountMinor: unknown })
        .amountMinor,
    ).toBe('7500');
  });

  it('orders by country, then city, then newest', async () => {
    // The list is read as a table of allowances, so the grouping has to be stable.
    const db = makeDb();
    const c = await callerFor(db, READ);
    await c.perDiemRate.list();
    expect(db.perDiemRate.findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { country: 'asc' },
      { city: 'asc' },
      { effectiveFrom: 'desc' },
    ]);
  });

  it('requires a two-letter country and a real city', async () => {
    const c = await callerFor(makeDb(), PER_DIEM);
    await expect(c.perDiemRate.create(rate({ country: 'CAN' }) as never)).rejects.toThrow();
    await expect(c.perDiemRate.create(rate({ city: '' }) as never)).rejects.toThrow();
  });

  it('requires a category, because the allowance IS per category', async () => {
    // One allowance per category is the per-diem model; a rate with no bucket cannot
    // be resolved against a line.
    const c = await callerFor(makeDb(), PER_DIEM);
    await expect(c.perDiemRate.create(rate({ categoryId: undefined }) as never)).rejects.toThrow();
  });

  it('allows every scoping dimension to be null, meaning everyone', async () => {
    const db = makeDb();
    const c = await callerFor(db, PER_DIEM);
    await expect(
      c.perDiemRate.create(
        rate({
          jobLevelId: null,
          legalEntityId: null,
          businessUnitId: null,
          currencyId: null,
        }) as never,
      ),
    ).resolves.toBeTruthy();
  });

  it('offers only active lookups on the form', async () => {
    const db = makeDb();
    const c = await callerFor(db, READ);
    await c.perDiemRate.options();
    // VeloExpense: every currency row is usable (no `active` column), so `currency` is not
    // among the filtered lookups.
    for (const model of ['expenseCategory', 'jobLevel', 'legalEntity', 'businessUnit'] as const) {
      expect(
        (db[model].findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.where,
        model,
      ).toEqual({ active: true });
    }
  });

  it('deletes a rate outright', async () => {
    // Unlike mileage rules, per-diem rates are not a succession chain.
    const db = makeDb();
    const c = await callerFor(db, PER_DIEM);
    await expect(c.perDiemRate.delete({ id: RATE })).resolves.toEqual({ ok: true });
    expect(db.perDiemRate.delete).toHaveBeenCalledWith({ where: { id: RATE } });
  });
});

describe('policyRule', () => {
  /**
   * An AGGREGATE kind, which carries no condition — the registry validates a
   * PREDICATE kind's condition, so using one here would make every test about the
   * predicate rather than about the router.
   */
  const rule = (over: Record<string, unknown> = {}) => ({
    kindCode: 'PER_DIEM',
    severity: 'WARNING',
    messageKey: 'policy.perDiem',
    effectiveFrom: '2026-01-01T00:00:00Z',
    ...over,
  });

  it('needs the policy write permission', async () => {
    const db = makeDb();
    const reader = await callerFor(db, READ);
    await expect(reader.policyRule.list()).resolves.toBeTruthy();
    await expect(reader.policyRule.create(rule() as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('records who created a rule', async () => {
    // A rule that changes what people may file needs an owner.
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await c.policyRule.create(rule() as never);
    expect(db.policyRule.create.mock.calls[0]?.[0]?.data).toMatchObject({ createdBy: ME });
  });

  it('audits create, update and delete, distinguished by op', async () => {
    /**
     * One action code for the whole registry (`config.policyRule`) with the operation
     * in `details.op` — so a reader filtering the trail by action sees every rule change
     * together, and the op says which kind it was.
     */
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await c.policyRule.create(rule() as never);
    await c.policyRule.update({ id: RULE, patch: rule() } as never);
    await c.policyRule.delete({ id: RULE });
    expect(withAuditCalls).toHaveLength(3);
    expect(withAuditCalls.map((a) => (a.details as { op: string }).op)).toEqual([
      'create',
      'update',
      'delete',
    ]);
    expect(new Set(withAuditCalls.map((a) => a.entityType))).toEqual(new Set(['PolicyRule']));
  });

  it('rejects an unknown severity', async () => {
    const c = await callerFor(makeDb(), POLICY);
    await expect(
      c.policyRule.create(rule({ severity: 'CATASTROPHIC' }) as never),
    ).rejects.toThrow();
  });

  it('requires a message key, because the violation has to say something', async () => {
    const c = await callerFor(makeDb(), POLICY);
    await expect(c.policyRule.create(rule({ messageKey: '' }) as never)).rejects.toThrow();
  });

  it('allows a null condition for an aggregate kind', async () => {
    // AGGREGATE kinds are computed rather than predicated, so they carry no condition.
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await expect(c.policyRule.create(rule({ condition: null }) as never)).resolves.toBeTruthy();
  });

  it('validates a PREDICATE kind’s condition', async () => {
    /**
     * The registry knows which kinds are predicated, and rejects a malformed condition
     * at authoring time — a rule whose predicate cannot parse would evaluate to nothing
     * and silently stop enforcing.
     */
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await expect(
      c.policyRule.create({
        kindCode: 'PREDICATE_LINE',
        severity: 'WARNING',
        messageKey: 'policy.predicateLine',
        effectiveFrom: '2026-01-01T00:00:00Z',
        condition: { nonsense: true },
      } as never),
    ).rejects.toThrow(/condition/i);
  });

  it('allows every scope dimension to be null', async () => {
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await expect(
      c.policyRule.create(
        rule({
          departmentId: null,
          jobLevelId: null,
          legalEntityId: null,
          businessUnitId: null,
          roleId: null,
          categoryId: null,
        }) as never,
      ),
    ).resolves.toBeTruthy();
  });

  it('offers only active lookups for scoping', async () => {
    const db = makeDb();
    const c = await callerFor(db, READ);
    const out = await c.policyRule.scopeOptions();
    // Roles are listed without an active filter — a rule scoped to a deactivated role
    // still has to be editable, or it becomes unreachable data.
    // VeloExpense: there is no role table until w4-10 (d64), so there are no roles to list.
    for (const model of [
      'jobLevel',
      'legalEntity',
      'businessUnit',
      'department',
      'expenseCategory',
    ] as const) {
      expect(
        (db[model].findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.where,
        model,
      ).toMatchObject({ active: true });
    }
    expect(db.role.findMany).not.toHaveBeenCalled();
    expect(out.roles).toEqual([]);
  });

  it('refuses a role scope until roles exist (VeloExpense, d64)', async () => {
    // `role_id` has no foreign key yet: an id accepted now could name nothing, and the
    // rule would quietly apply to nobody.
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await expect(c.policyRule.create(rule({ roleId: U('6') }) as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.policyRule.create).not.toHaveBeenCalled();
  });

  it('refuses a budget rule more severe than WARNING (VeloExpense, BG-4)', async () => {
    // A budget never blocks: the money has already left, and a claim nobody can submit
    // strands a real expense.
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await expect(
      c.policyRule.create(rule({ kindCode: 'BUDGET_OVERAGE', severity: 'BLOCK' }) as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      c.policyRule.create(rule({ kindCode: 'BUDGET_OVERAGE', severity: 'WARNING' }) as never),
    ).resolves.toBeTruthy();
  });

  it('takes the scope from the kind, never from the caller', async () => {
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await c.policyRule.create(rule({ scope: 'LINE' }) as never);
    expect(db.policyRule.create.mock.calls[0]?.[0]?.data).toMatchObject({ scope: 'AGGREGATE' });
  });

  it('refuses a condition on a kind that takes none', async () => {
    const c = await callerFor(makeDb(), POLICY);
    await expect(
      c.policyRule.create(rule({ condition: { field: 'amountMinor', op: 'gt', value: 1 } }) as never),
    ).rejects.toThrow(/takes no condition/);
  });

  it('refuses an unknown kind', async () => {
    const c = await callerFor(makeDb(), POLICY);
    await expect(c.policyRule.create(rule({ kindCode: 'NOPE' }) as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('audits an aggregate kind’s absent condition as null (VeloExpense)', async () => {
    // `Prisma.JsonNull` is a sentinel object; the chain hashes the value the row holds.
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await c.policyRule.create(rule() as never);
    expect((withAuditCalls[0]?.details as { condition: unknown }).condition).toBeNull();
    expect(withAuditCalls[0]).toMatchObject({ action: 'POLICY_RULE_CHANGED' });
  });

  it('answers what the table refuses as a 4xx, not a 500 (VeloExpense)', async () => {
    const fk = Object.assign(new Error('fk'), { code: 'P2003' });
    const missing = Object.assign(new Error('missing'), { code: 'P2025' });
    const range = new Error('violates check constraint "policy_rule_effective_range"');
    const db = makeDb();
    db.policyRule.create.mockRejectedValueOnce(fk).mockRejectedValueOnce(range);
    db.policyRule.update.mockRejectedValueOnce(missing);
    db.policyRule.delete.mockRejectedValueOnce(missing);
    const c = await callerFor(db, POLICY);
    await expect(c.policyRule.create(rule() as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.policyRule.create(rule() as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.policyRule.update({ id: RULE, patch: rule() } as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(c.policyRule.delete({ id: RULE })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('policyRule.violations', () => {
  it('caps the page and defaults it', async () => {
    const db = makeDb();
    const c = await callerFor(db, READ);
    await c.policyRule.violations();
    expect(db.policyViolation.findMany.mock.calls[0]?.[0]?.take).toBe(500);
    await expect(c.policyRule.violations({ limit: 1001 })).rejects.toThrow();
    await expect(c.policyRule.violations({ limit: 0 })).rejects.toThrow();
  });

  /**
   * The register carries BOTH subjects now.
   *
   * A violation belongs either to an expense report or to a travel request, and this is
   * the page that exists to show exceptions — so keeping the row shape report-shaped
   * would have hidden precisely the ones that BLOCK rather than warn. The subject is
   * projected to a neutral triple, which is the code these cases cover.
   *
   * VeloExpense: no travel yet, so ExpenseOS's two travel cases ("projects a travel
   * violation…", "lists both subjects in one page") wait for it; the row keeps the travel
   * fields, null. The subject, expense, line and submitter are separate lookups here
   * (PolicyViolation has no Prisma relations), so the fixture is four tables, not one
   * nested row.
   */
  const reportRow = {
    id: 'v-rep',
    severity: 'WARNING',
    message: 'perTransactionLimit',
    ruleCode: RULE,
    resolvedAt: null,
    resolveNote: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    reportId: 'rep-1',
    lineItemId: 'li-1',
    expenseId: 'exp-1',
  };
  const withSubject = (
    rows: unknown[],
    submitter: { name: string | null; email: string } = { name: 'Dana Patel', email: 'dana@e.inc' },
  ) =>
    makeDb({
      policyViolation: {
        findMany: stubFn(async () => rows),
        findUnique: stubFn(async () => null as unknown),
        update: stubFn(async () => ({})),
      },
      expenseReport: {
        findMany: stubFn(async () => [
          { id: 'rep-1', number: 'EXP-1042', title: 'Toronto client visit', submitterId: 'u-1' },
        ]),
      },
      expense: {
        findMany: stubFn(async () => [{ id: 'exp-1', merchant: 'Canoe', date: new Date('2026-07-28T00:00:00Z') }]),
      },
      expenseLineItem: {
        count: stubFn(async () => 0),
        findMany: stubFn(async () => [{ id: 'li-1', category: { label: { en: 'Meals' } } }]),
      },
      user: { findMany: stubFn(async () => [{ id: 'u-1', ...submitter }]) },
      policyRule: {
        findMany: stubFn(async () => [{ id: RULE, kindCode: 'PREDICATE_LINE' }]),
        findUnique: stubFn(async () => null as unknown),
      },
    });

  it('projects an expense violation to the neutral subject triple', async () => {
    const c = await callerFor(withSubject([reportRow]), READ);
    const [row] = await c.policyRule.violations();
    expect(row).toMatchObject({
      subjectKind: 'REPORT',
      subjectNumber: 'EXP-1042',
      subjectTitle: 'Toronto client visit',
      reportId: 'rep-1',
      travelRequestId: null,
      submitterName: 'Dana Patel',
      merchant: 'Canoe',
      categoryLabel: { en: 'Meals' },
      kind: 'PREDICATE_LINE',
    });
  });

  it('falls back to an email when a submitter has no name', async () => {
    // VeloExpense: on a report (no travel), and a blank display name rather than first/last.
    for (const name of [null, '  ']) {
      const c = await callerFor(withSubject([reportRow], { name, email: 'nobody@e.inc' }), READ);
      const [row] = await c.policyRule.violations();
      expect(row.submitterName).toBe('nobody@e.inc');
    }
  });

  it('renders a dash rather than crashing on a row with neither subject', async () => {
    /**
     * Unreachable while `PolicyViolation_one_subject` holds — which is the point of the
     * CHECK. But the register is a read path over historical rows, and a dash beats a
     * 500 if the constraint is ever dropped or the query is ever changed to a left join
     * that produces one.
     *
     * VeloExpense: the report's foreign key is the constraint; a report the lookup does
     * not return stands in for the missing subject.
     */
    const c = await callerFor(withSubject([{ ...reportRow, reportId: 'rep-gone' }]), READ);
    const [row] = await c.policyRule.violations();
    expect(row.submitterName).toBe('—');
    expect(row.subjectNumber).toBe('');
    expect(row.subjectTitle).toBeNull();
  });

  it('names a row from before the cutover by the kind its v1 rule became (VeloExpense)', async () => {
    /**
     * 0066 kept those rows with v1's kind NAME in `rule_code`. A name is not a rule id, and
     * in a uuid `IN` list it is a query error — the register would be down for any tenant
     * with history. So only uuid-shaped codes are looked up, and a v1 name maps to its kind.
     */
    const db = withSubject([
      reportRow,
      { ...reportRow, id: 'v-old', ruleCode: 'PER_TRANSACTION_LIMIT' },
      { ...reportRow, id: 'v-old2', ruleCode: 'RECEIPT_REQUIRED' },
      { ...reportRow, id: 'v-old3', ruleCode: 'NON_NEGATIVE_AMOUNT' },
    ]);
    const c = await callerFor(db, READ);
    const rows = await c.policyRule.violations();
    expect(rows.map((r) => r.kind)).toEqual(['PREDICATE_LINE', 'PER_TXN_LIMIT', 'RECEIPT_REQUIRED', 'NON_NEGATIVE_AMOUNT']);
    expect(db.policyRule.findMany.mock.calls[0]?.[0]).toMatchObject({ where: { id: { in: [RULE] } } });
  });
});

describe('policyRule.resolveViolation', () => {
  it('404s a violation that does not exist', async () => {
    const db = makeDb();
    db.policyViolation.findUnique.mockResolvedValue(null);
    const c = await callerFor(db, POLICY);
    await expect(c.policyRule.resolveViolation({ id: VIOLATION })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses to resolve a BLOCK', async () => {
    /**
     * WARNING and INFO never stop a submission by construction, so acknowledging one is
     * oversight. A BLOCK is the thing actually preventing a filing — clearing it here
     * would be an override with no approval behind it.
     */
    const db = makeDb();
    db.policyViolation.findUnique.mockResolvedValue({ id: VIOLATION, severity: 'BLOCK' });
    const c = await callerFor(db, POLICY);
    await expect(
      c.policyRule.resolveViolation({ id: VIOLATION, note: 'Approved verbally' }),
    ).rejects.toThrow();
    expect(db.policyViolation.update).not.toHaveBeenCalled();
  });

  it('acknowledges a warning with a note', async () => {
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await c.policyRule.resolveViolation({ id: VIOLATION, note: 'Client dinner, pre-approved' });
    const data = db.policyViolation.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.resolveNote).toBe('Client dinner, pre-approved');
    expect(data.resolvedBy).toBe(ME);
    expect(data.resolvedAt).toBeInstanceOf(Date);
  });

  it('clears the acknowledgment on a blank note', async () => {
    /**
     * A blank note un-acknowledges rather than storing an empty one, so the register
     * distinguishes "somebody signed off" from "somebody opened the dialog and changed
     * their mind".
     */
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    for (const note of [undefined, null, '', '   ']) {
      db.policyViolation.update.mockClear();
      await c.policyRule.resolveViolation({ id: VIOLATION, note } as never);
      const data = db.policyViolation.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
      expect(data.resolvedAt, JSON.stringify(note)).toBeNull();
      expect(data.resolveNote).toBeNull();
    }
  });

  it('trims the note before storing it', async () => {
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await c.policyRule.resolveViolation({ id: VIOLATION, note: '  Pre-approved  ' });
    expect(
      (db.policyViolation.update.mock.calls[0]?.[0]?.data as { resolveNote: string }).resolveNote,
    ).toBe('Pre-approved');
  });

  it('bounds the note', async () => {
    const c = await callerFor(makeDb(), POLICY);
    await expect(
      c.policyRule.resolveViolation({ id: VIOLATION, note: 'x'.repeat(2001) }),
    ).rejects.toThrow();
  });

  it('audits the acknowledgment against the violation, not the rule', async () => {
    const db = makeDb();
    const c = await callerFor(db, POLICY);
    await c.policyRule.resolveViolation({ id: VIOLATION, note: 'ok' });
    expect(withAuditCalls[0]?.entityType).toBe('PolicyViolation');
    // VeloExpense: one action for the registry, the op and note in details, the violation's id.
    expect(withAuditCalls[0]).toMatchObject({
      action: 'POLICY_RULE_CHANGED',
      entityId: VIOLATION,
      details: { op: 'resolveViolation', note: 'ok' },
    });
  });
});

describe('policyRule.kinds', () => {
  it('labels money params in the organization’s policy currency (VeloExpense)', async () => {
    const db = makeDb({ $queryRaw: stubFn(async () => [{ code: 'USD' }] as unknown[]) });
    const c = await callerFor(db, READ);
    const out = await c.policyRule.kinds();
    expect(out.policyCurrency).toBe('USD');
    expect(out.kinds.map((k) => k.code)).toContain('PREDICATE_LINE');
    expect(out.kinds.find((k) => k.code === 'PREDICATE_LINE')?.requiresCondition).toBe(true);
    expect(out.ops).toContain('gt');
  });

  it('falls back to CAD with no organization row', async () => {
    const db = makeDb({ $queryRaw: stubFn(async () => [] as unknown[]) });
    const c = await callerFor(db, READ);
    expect((await c.policyRule.kinds()).policyCurrency).toBe('CAD');
  });
});
