// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REFUSAL_KEYS, refusalData } from '@/server/refusal';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The policy-configuration router: expense policy, FX rates, mileage rules, custom
 * fields, system flags, and the v2 rule registry.
 *
 * The mileage rules are the part with real invariants, because they are versioned and a
 * claim's price depends on which rule was in force:
 *
 *   · **Creating a rule closes the incumbent's window at the new rule's start**, in one
 *     transaction — so there is never a moment with two rules in force for one scope,
 *     and never a gap either.
 *   · **A rule cannot be back-dated in front of one it would supersede.** That is a
 *     rewrite of history, not a rate change.
 *   · **Tiers must start at 0.** The model cannot express a gap, but it CAN express a
 *     first band starting above zero — and then the opening kilometres have no rate.
 *   · **A rule anything was priced under cannot be deleted**, only superseded or
 *     retired; deleting it would strand every claim's `mileageRateId`.
 */

/*
 * VeloExpense: ported from ExpenseOS (550b2945) for the sub-routers ported so far —
 * `fxRate` (w1-07) and `mileageRate` (w1-08). The stub `db` gains the lookups VeloExpense
 * adds before a write, and the audit assertions use VeloExpense's registry names; each
 * marked. The same rules against Postgres are in test/fx-rates.db.test.ts and
 * test/mileage-rates.db.test.ts.
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

function makeDb(over: Record<string, unknown> = {}) {
  return {
    expensePolicy: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
      upsert: stubFn(async () => ({
        categoryId: U('1'),
        receiptRequired: true,
        approvalRequired: false,
        perTransactionLimitMinor: null as bigint | null,
        dailyLimitMinor: null as bigint | null,
        monthlyLimitMinor: null as bigint | null,
        annualLimitMinor: null as bigint | null,
        notes: null as string | null,
      })),
    },
    fxRate: {
      findMany: stubFn(async () => [] as unknown[]),
      // The pair's last row, which `add` bounds the new rate against. Null = first ever.
      findFirst: stubFn(async () => null as unknown),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        ...args.data,
        rate: { toString: () => '1.35' },
      })),
    },
    mileageRate: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
      create: stubFn(async () => ({ id: U('2') })),
      update: stubFn(async () => ({ id: U('2') })),
      delete: stubFn(async () => ({ id: U('2') })),
    },
    expenseLineItem: { count: stubFn(async () => 0) },
    // VeloExpense: the lookups VeloExpense adds before a write — the pair's currencies
    // (`assertPairKnown`), a rule's people and GL account (`assertMileageReferencesKnown`).
    // By default every id asked about is the tenant's own.
    currency: {
      count: vi.fn(async (args: { where: { code: { in: string[] } } }) => args.where.code.in.length),
      findMany: stubFn(async () => [] as unknown[]),
    },
    user: { count: vi.fn(async (args: { where: { id: { in: string[] } } }) => args.where.id.in.length) },
    glAccount: { findUnique: stubFn(async () => ({ isPostable: true, isActive: true }) as unknown) },
    perDiemRate: {
      findMany: stubFn(async () => [] as unknown[]),
      create: stubFn(async () => ({ id: U('3') })),
      update: stubFn(async () => ({ id: U('3') })),
      delete: stubFn(async () => ({ id: U('3') })),
    },
    customField: {
      findMany: stubFn(async () => [] as unknown[]),
      create: stubFn(async () => ({ id: U('4') })),
      update: stubFn(async () => ({ id: U('4') })),
      delete: stubFn(async () => ({ id: U('4') })),
    },
    systemFlag: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => ({ value: 'CAD' }) as unknown),
      upsert: stubFn(async () => ({ key: 'k', value: 'v' })),
    },
    expenseCategory: { findMany: stubFn(async () => [] as unknown[]) },
    businessUnit: { findMany: stubFn(async () => [] as unknown[]) },
    department: { findMany: stubFn(async () => [] as unknown[]) },
    legalEntity: { findMany: stubFn(async () => [] as unknown[]) },
    jobLevel: { findMany: stubFn(async () => [] as unknown[]) },
    role: { findMany: stubFn(async () => [] as unknown[]) },
    policyRule: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
      create: stubFn(async () => ({ id: U('5') })),
      update: stubFn(async () => ({ id: U('5') })),
      delete: stubFn(async () => ({ id: U('5') })),
    },
    policyViolation: { findMany: stubFn(async () => [] as unknown[]) },
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
const MILEAGE = [P.config.mileageUpdate] as const;

const rule = (over: Record<string, unknown> = {}) => ({
  country: 'CA',
  unit: 'KM',
  effectiveFrom: '2026-01-01T00:00:00Z',
  subjectUserIds: [] as string[],
  tiers: [{ fromDistance: 0, rateMinor: '70' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
});

describe('permission gates', () => {
  it('separates read from each write permission', async () => {
    const db = makeDb();
    const reader = await callerFor(db, READ);
    await expect(reader.mileageRate.list()).resolves.toBeTruthy();
    await expect(reader.mileageRate.create(rule() as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      reader.expensePolicy.upsert({ categoryId: U('1'), patch: { receiptRequired: true } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reader.fxRate.add({ base: 'usd', quote: 'cad', rate: '1.35' } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a caller with nothing at all', async () => {
    const db = makeDb();
    const c = await callerFor(db, []);
    await expect(c.mileageRate.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.expensePolicy.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // VeloExpense: kept from the w1-07 port, beside ExpenseOS's `expensePolicy` line.
    await expect(c.fxRate.latest()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// VeloExpense: the `systemFlag` tests arrive with that sub-router's port. `policyRule.kinds`
// is at the end of this file, as in ExpenseOS; the rest of `policyRule` is in
// policies.rules.test.ts.

describe('expensePolicy', () => {
  it('serialises the money columns as strings', async () => {
    /**
     * These are BigInt minor units. Returning them raw makes the response
     * unserialisable; returning them as numbers loses precision at scale.
     */
    const db = makeDb();
    db.expensePolicy.upsert.mockResolvedValue({
      categoryId: U('1'),
      receiptRequired: true,
      approvalRequired: false,
      perTransactionLimitMinor: 250_00n,
      dailyLimitMinor: null,
      monthlyLimitMinor: null,
      annualLimitMinor: null,
      notes: null,
    });
    const c = await callerFor(db, [P.config.policyUpdate]);
    const out = await c.expensePolicy.upsert({
      categoryId: U('1'),
      patch: { receiptRequired: true },
    });
    expect(out.perTransactionLimitMinor).toBe('25000');
    expect(out.dailyLimitMinor).toBeNull();
  });

  it('upserts so a category with no policy yet still works', async () => {
    const db = makeDb();
    const c = await callerFor(db, [P.config.policyUpdate]);
    await c.expensePolicy.upsert({ categoryId: U('1'), patch: { approvalRequired: true } });
    const args = db.expensePolicy.upsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.where).toEqual({ categoryId: U('1') });
    expect(args.create).toMatchObject({ categoryId: U('1'), approvalRequired: true });
  });

  it('records the patch in the audit trail', async () => {
    const db = makeDb();
    const c = await callerFor(db, [P.config.policyUpdate]);
    await c.expensePolicy.upsert({ categoryId: U('1'), patch: { receiptRequired: false } });
    expect(withAuditCalls[0]).toMatchObject({
      entityType: 'ExpensePolicy',
      entityId: U('1'),
      details: { categoryId: U('1'), patch: { receiptRequired: false } },
    });
    // VeloExpense: the registry's name for ExpenseOS's `config.policy.update`.
    expect(withAuditCalls[0]).toMatchObject({ action: 'EXPENSE_POLICY_CHANGED' });
  });

  it('answers what the table refuses as a 4xx, not a 500 (VeloExpense)', async () => {
    const db = makeDb();
    db.expensePolicy.upsert
      .mockRejectedValueOnce(Object.assign(new Error('fk'), { code: 'P2003' }))
      .mockRejectedValueOnce(Object.assign(new Error('pk'), { code: 'P2002' }))
      .mockRejectedValueOnce(new Error('violates check constraint "expense_category_policy_limits_nonnegative"'))
      .mockRejectedValueOnce(
        new Error('new row violates row-level security policy (USING expression) for table "expense_category_policy"'),
      );
    const c = await callerFor(db, [P.config.policyUpdate]);
    for (let i = 0; i < 4; i += 1) {
      await expect(
        c.expensePolicy.upsert({ categoryId: U('1'), patch: { dailyLimitMinor: '100' } }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('tells the screen the organization’s policy currency, and the ones it may be (VeloExpense)', async () => {
    const db = makeDb({
      $queryRaw: stubFn(async () => [{ code: 'USD' }] as unknown[]),
      currency: {
        findMany: stubFn(async () => [{ code: 'CAD' }, { code: 'USD' }] as unknown[]),
        findUnique: stubFn(async () => null as unknown),
      },
    });
    const c = await callerFor(db, READ);
    await expect(c.expensePolicy.currency()).resolves.toEqual({ code: 'USD', options: ['CAD', 'USD'] });
  });

  describe('setCurrency (VeloExpense, d68)', () => {
    const withCurrencies = () =>
      makeDb({
        // One stub for both raw statements: the current currency read, then the UPDATE
        // ... RETURNING id (its id is the audit entity).
        $queryRaw: stubFn(async () => [{ code: 'CAD', id: 'org-1' }] as unknown[]),
        currency: {
          findMany: stubFn(async () => [] as unknown[]),
          findUnique: stubFn(async (a: { where: { code: string } }) =>
            (['CAD', 'USD'].includes(a.where.code) ? { code: a.where.code } : null) as unknown,
          ),
        },
      });

    it('needs the policy write permission', async () => {
      const c = await callerFor(withCurrencies(), READ);
      await expect(c.expensePolicy.setCurrency({ code: 'USD' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('sets a currency the system has, audited with where it came from', async () => {
      const db = withCurrencies();
      const c = await callerFor(db, [P.config.policyUpdate]);
      await expect(c.expensePolicy.setCurrency({ code: 'usd' })).resolves.toEqual({ code: 'USD' });
      expect((db as unknown as { $queryRaw: ReturnType<typeof stubFn> }).$queryRaw).toHaveBeenCalledTimes(2);
      expect(withAuditCalls[0]).toMatchObject({ action: 'POLICY_CURRENCY_SET', details: { from: 'CAD', to: 'USD' } });
    });

    it('refuses one it does not have', async () => {
      const db = withCurrencies();
      const c = await callerFor(db, [P.config.policyUpdate]);
      await expect(c.expensePolicy.setCurrency({ code: 'ZZZ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect((db as unknown as { $queryRaw: ReturnType<typeof stubFn> }).$queryRaw).not.toHaveBeenCalled();
    });
  });
});

describe('fxRate', () => {
  it('returns the newest row per pair only', async () => {
    /**
     * The table is append-only, so `latest` has to collapse the history — the engine
     * converts at the newest rate and a stale row winning would silently misprice
     * every foreign claim.
     */
    const db = makeDb();
    db.fxRate.findMany.mockResolvedValue([
      { base: 'USD', quote: 'CAD', rate: { toString: () => '1.36' }, fetchedAt: new Date(2) },
      { base: 'USD', quote: 'CAD', rate: { toString: () => '1.35' }, fetchedAt: new Date(1) },
      { base: 'EUR', quote: 'CAD', rate: { toString: () => '1.50' }, fetchedAt: new Date(1) },
    ]);
    const c = await callerFor(db, READ);
    const out = await c.fxRate.latest();
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.base === 'USD')?.rate).toBe('1.36');
  });

  it('scopes the history to one pair and caps it', async () => {
    // The undifferentiated log interleaved every pair and read as noise.
    const db = makeDb();
    const c = await callerFor(db, READ);
    await c.fxRate.history({ base: 'usd', quote: 'cad' });
    const args = db.fxRate.findMany.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.where).toEqual({ base: 'USD', quote: 'CAD' });
    expect(args.take).toBe(200);
  });

  it('upper-cases the pair on write, so lookups match', async () => {
    // A lower-case row would never be found by the engine's upper-cased lookup.
    const db = makeDb();
    const c = await callerFor(db, [P.config.fxRateUpdate]);
    await c.fxRate.add({ base: 'usd', quote: 'cad', rate: '1.35' } as never);
    expect(db.fxRate.create.mock.calls[0]?.[0]?.data).toMatchObject({
      base: 'USD',
      quote: 'CAD',
    });
  });

  it('stamps its own fetch time rather than trusting the client', async () => {
    const db = makeDb();
    const c = await callerFor(db, [P.config.fxRateUpdate]);
    await c.fxRate.add({ base: 'USD', quote: 'CAD', rate: '1.35' } as never);
    expect(
      (db.fxRate.create.mock.calls[0]?.[0]?.data as { fetchedAt: Date }).fetchedAt,
    ).toBeInstanceOf(Date);
  });

  it('refuses a zero or absurd rate', async () => {
    /**
     * `0` passed the old regex and valued every un-snapshotted foreign line at nothing
     * while `missingRates` stayed empty; `137` for `1.37` inflated every USD claim a
     * hundredfold. Neither is a rate anybody meant.
     */
    const db = makeDb();
    const c = await callerFor(db, [P.config.fxRateUpdate]);
    for (const rate of ['0', '0.0', '1000001']) {
      const err = await c.fxRate
        .add({ base: 'USD', quote: 'CAD', rate } as never)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/positive number no greater than/),
      });
      // Not a Zod failure — those reach the browser as "some details are not valid" —
      // but a refusal with its own sentence, in the reader's language.
      expect(refusalData(err)).toEqual({
        key: REFUSAL_KEYS.fxRateOutOfBounds,
        params: { max: 1_000_000 },
      });
    }
    expect(db.fxRate.create).not.toHaveBeenCalled();
    await c.fxRate.add({ base: 'USD', quote: 'CAD', rate: '1000000' } as never);
    expect(db.fxRate.create).toHaveBeenCalledOnce();
  });

  it('leaves an audit row naming who typed the rate', async () => {
    /**
     * The FxRate table has no actor column, and this was the one write in the router
     * outside `withAudit` — the figure every foreign claim converts at, and NetSuite
     * receives as `exchangeRate`, could be inserted with no trace of who did it.
     */
    const db = makeDb();
    const c = await callerFor(db, [P.config.fxRateUpdate]);
    await c.fxRate.add({ base: 'usd', quote: 'cad', rate: '1.35' } as never);
    expect(withAuditCalls).toHaveLength(1);
    // VeloExpense: the registry's name for the action, and no entity id — the audit chain
    // keys an entity by uuid and a rate has none, so the pair is in the details.
    expect(withAuditCalls[0]).toMatchObject({
      action: 'FX_RATE_ADDED',
      entityType: 'FxRate',
      actor: { kind: 'user', id: ME },
      details: { base: 'USD', quote: 'CAD', rate: '1.35' },
    });
    expect(withAuditCalls[0]).not.toHaveProperty('entityId');
  });

  it('requires three-letter codes', async () => {
    const c = await callerFor(makeDb(), [P.config.fxRateUpdate]);
    await expect(c.fxRate.add({ base: 'US', quote: 'CAD', rate: '1' } as never)).rejects.toThrow();
    await expect(c.fxRate.history({ base: 'DOLLAR', quote: 'CAD' } as never)).rejects.toThrow();
  });
});

describe('fxRate.add bounded by the prior row', () => {
  /**
   * The ceiling refuses the absurd; this refuses the plausible-looking wrong number — an
   * inverted quote, a pair typed backwards, a stale year's figure — by measuring the new
   * rate against the LAST row for the same pair. And because a wrong prior row would
   * otherwise block its own correction, a stated reason crosses the bound on the record.
   */
  const PRIOR_AT = new Date('2026-09-14T16:30:00.000Z');
  const withPrior = (rate: string) => {
    const db = makeDb();
    db.fxRate.findFirst.mockResolvedValue({
      base: 'USD',
      quote: 'CAD',
      rate: { toString: () => rate },
      fetchedAt: PRIOR_AT,
    });
    return db;
  };
  const add = (rate: string, extra: Record<string, unknown> = {}) =>
    ({ base: 'USD', quote: 'CAD', rate, ...extra }) as never;

  it('takes a first-ever rate for a pair as typed — there is nothing to measure it against', async () => {
    const db = makeDb();
    const c = await callerFor(db, [P.config.fxRateUpdate]);
    await c.fxRate.add(add('1.36'));
    expect(db.fxRate.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { base: 'USD', quote: 'CAD' },
      orderBy: { fetchedAt: 'desc' },
    });
    expect(db.fxRate.create).toHaveBeenCalledOnce();
    expect(withAuditCalls[0]?.details).toMatchObject({
      priorRate: null,
      priorFetchedAt: null,
      deviationPercent: null,
      deviationConfirmed: false,
      reason: null,
    });
  });

  it('accepts a rate within the bound, and records how far it moved', async () => {
    // 1.36 → 1.40 is +2.94%: an ordinary week for a major pair.
    const db = withPrior('1.36');
    const c = await callerFor(db, [P.config.fxRateUpdate]);
    await c.fxRate.add(add('1.40'));
    expect(db.fxRate.create).toHaveBeenCalledOnce();
    expect(withAuditCalls[0]?.details).toMatchObject({
      priorRate: '1.36',
      priorFetchedAt: PRIOR_AT.toISOString(),
      deviationPercent: 2.94,
      deviationConfirmed: false,
    });
  });

  it('refuses a rate more than 25% from the prior row, naming both rates', async () => {
    /**
     * 2.00 for a pair last recorded at 1.36 is +47% — nothing USD/CAD has ever done in
     * a day, and exactly what an inverted or mistyped quote looks like. The message
     * carries both figures and the bound so the reader can see which one is wrong.
     */
    const db = withPrior('1.36');
    const c = await callerFor(db, [P.config.fxRateUpdate]);
    const failure = await c.fxRate.add(add('2.00')).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((failure as Error).message).toContain('1.36');
    expect((failure as Error).message).toContain('2.00');
    expect((failure as Error).message).toContain('47.1%');
    expect((failure as Error).message).toContain('25%');
    expect((failure as Error).message).toContain('2026-09-14');
    // And the same figures again as a catalog key, so an FR-CA reader is told the same
    // thing in French rather than being handed the English sentence beside it.
    expect(refusalData(failure)).toEqual({
      key: REFUSAL_KEYS.fxRateFarFromPrior,
      params: {
        base: 'USD',
        quote: 'CAD',
        prior: '1.36',
        on: '2026-09-14',
        rate: '2.00',
        deviation: '47.1',
        bound: 25,
      },
    });
    expect(db.fxRate.create).not.toHaveBeenCalled();
    // A refusal is not a config change; it leaves no audit row to mislead a reviewer.
    expect(withAuditCalls).toHaveLength(0);
  });

  it('measures the move in either direction', async () => {
    // 0.73 typed for 1.36 is the inverted quote: -46%, refused just the same.
    const c = await callerFor(withPrior('1.36'), [P.config.fxRateUpdate]);
    await expect(c.fxRate.add(add('0.73'))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('treats the bound as inclusive, in decimal', async () => {
    /**
     * 1.00 → 1.25 is exactly 25% and passes; 1.2501 does not. Computed in Decimal so a
     * rate sitting on the line is not pushed over it by a float round-trip.
     */
    const ok = await callerFor(withPrior('1.00'), [P.config.fxRateUpdate]);
    await expect(ok.fxRate.add(add('1.25'))).resolves.toBeTruthy();
    const over = await callerFor(withPrior('1.00'), [P.config.fxRateUpdate]);
    await expect(over.fxRate.add(add('1.2501'))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('crosses the bound on a stated reason, and writes the reason into the audit row', async () => {
    /**
     * The correction path. The same permission, the same row — plus a reason that lands
     * beside both rates, so "who overrode the FX bound, from what to what, and why" is
     * one audit query rather than a conversation.
     */
    const db = withPrior('1.36');
    const c = await callerFor(db, [P.config.fxRateUpdate]);
    const reason =
      'Prior row was entered as CAD per USD inverted; 2.00 matches the bank statement.';
    await c.fxRate.add(add('2.00', { confirmDeviation: true, reason }));
    expect(db.fxRate.create).toHaveBeenCalledOnce();
    expect(withAuditCalls).toHaveLength(1);
    expect(withAuditCalls[0]?.details).toMatchObject({
      rate: '2.00',
      priorRate: '1.36',
      deviationPercent: 47.06,
      deviationConfirmed: true,
      reason,
    });
  });

  it('will not take the flag without a reason, nor a reason too short to mean anything', async () => {
    // `confirmDeviation: true` alone is a click; the reason is what makes it traceable.
    const c = await callerFor(withPrior('1.36'), [P.config.fxRateUpdate]);
    await expect(c.fxRate.add(add('2.00', { confirmDeviation: true }))).rejects.toThrow();
    await expect(
      c.fxRate.add(add('2.00', { confirmDeviation: true, reason: 'typo' })),
    ).rejects.toThrow();
    await expect(c.fxRate.add(add('2.00', { reason: 'too short' }))).rejects.toThrow();
  });

  it('keeps a reason given inside the bound, without calling it a confirmation', async () => {
    /** `deviationConfirmed` is the fact a reviewer filters for; a note on an ordinary
     *  add must not show up in that filter. */
    const c = await callerFor(withPrior('1.36'), [P.config.fxRateUpdate]);
    await c.fxRate.add(add('1.37', { reason: 'Month-end rate from treasury.' }));
    expect(withAuditCalls[0]?.details).toMatchObject({
      deviationConfirmed: false,
      reason: 'Month-end rate from treasury.',
    });
  });

  it('still refuses the absurd even with a reason', async () => {
    // The reason crosses the deviation bound, not the ceiling: a zero rate is never right.
    const c = await callerFor(withPrior('1.36'), [P.config.fxRateUpdate]);
    await expect(
      c.fxRate.add(add('0', { confirmDeviation: true, reason: 'because I said so, ok' })),
    ).rejects.toThrow(/positive number no greater than/);
  });
});

describe('mileageRate.create', () => {
  const caller = (db: unknown) => callerFor(db, MILEAGE);

  it('requires the first band to start at zero', async () => {
    /**
     * The model cannot express a gap, but it CAN express a first band starting above
     * zero — and then the opening kilometres of every claim have no rate at all.
     */
    const db = makeDb();
    await expect(
      (await caller(db)).mileageRate.create(
        rule({ tiers: [{ fromDistance: 5, rateMinor: '70' }] }) as never,
      ),
    ).rejects.toThrow(/first band must start at 0/);
    expect(db.mileageRate.create).not.toHaveBeenCalled();
  });

  it('refuses two bands with the same lower bound', async () => {
    const db = makeDb();
    await expect(
      (await caller(db)).mileageRate.create(
        rule({
          tiers: [
            { fromDistance: 0, rateMinor: '70' },
            { fromDistance: 0, rateMinor: '64' },
          ],
        }) as never,
      ),
    ).rejects.toThrow(/Two bands both start at 0/);
  });

  it('accepts bands supplied out of order', async () => {
    // The form can emit them in any order; sorting is the router's job.
    const db = makeDb();
    await expect(
      (await caller(db)).mileageRate.create(
        rule({
          tiers: [
            { fromDistance: 5000, rateMinor: '64' },
            { fromDistance: 0, rateMinor: '70' },
          ],
        }) as never,
      ),
    ).resolves.toBeTruthy();
  });

  it('closes the incumbent’s window at the new rule’s start', async () => {
    /**
     * One transaction, so there is never a moment with two rules in force for a scope
     * and never a gap either — a claim dated in between would otherwise price at
     * nothing or at two rates.
     */
    const db = makeDb();
    db.mileageRate.findMany.mockResolvedValue([
      { id: U('7'), effectiveFrom: new Date('2025-01-01T00:00:00Z') },
    ]);
    await (await caller(db)).mileageRate.create(rule() as never);
    expect(db.mileageRate.update).toHaveBeenCalledWith({
      where: { id: U('7') },
      data: { effectiveTo: new Date('2026-01-01T00:00:00Z'), supersededById: U('2') },
    });
  });

  it('refuses a rule back-dated in front of one it would supersede', async () => {
    // That is a rewrite of history, not a rate change.
    const db = makeDb();
    db.mileageRate.findMany.mockResolvedValue([
      { id: U('7'), effectiveFrom: new Date('2027-01-01T00:00:00Z') },
    ]);
    await expect((await caller(db)).mileageRate.create(rule() as never)).rejects.toThrow(
      /already starts on or after that date/,
    );
    expect(db.mileageRate.create).not.toHaveBeenCalled();
  });

  it('looks for a country default when no subjects are named', async () => {
    /**
     * Empty subjects means the country default, so the collision search must look for
     * rules with NO subjects — matching against subjectful rules would supersede
     * somebody's car allowance with a country rate.
     */
    const db = makeDb();
    await (await caller(db)).mileageRate.create(rule() as never);
    expect(db.mileageRate.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      subjects: { none: {} },
    });
  });

  it('looks for the named subjects’ rules when subjects are given', async () => {
    const db = makeDb();
    await (await caller(db)).mileageRate.create(rule({ subjectUserIds: [U('3')] }) as never);
    expect(db.mileageRate.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      subjects: { some: { userId: { in: [U('3')] } } },
    });
  });

  it('treats a rule with no end date as still in force', async () => {
    const db = makeDb();
    await (await caller(db)).mileageRate.create(rule() as never);
    const where = db.mileageRate.findMany.mock.calls[0]?.[0]?.where as { OR: unknown[] };
    expect(where.OR).toContainEqual({ effectiveTo: null });
  });

  it('stores each band’s rate as a BigInt', async () => {
    // The column is BigInt; a JS number is rejected by Prisma.
    const db = makeDb();
    await (await caller(db)).mileageRate.create(rule() as never);
    const data = db.mileageRate.create.mock.calls[0]?.[0]?.data as {
      tiers: { create: { rateMinor: unknown }[] };
    };
    expect(typeof data.tiers.create[0]?.rateMinor).toBe('bigint');
  });

  it('records what it superseded', async () => {
    const db = makeDb();
    db.mileageRate.findMany.mockResolvedValue([
      { id: U('7'), effectiveFrom: new Date('2025-01-01T00:00:00Z') },
    ]);
    await (await caller(db)).mileageRate.create(rule({ subjectUserIds: [U('3')] }) as never);
    expect(withAuditCalls[0]?.details).toEqual({
      country: 'CA',
      subjects: 1,
      supersedes: [U('7')],
    });
  });

  it('requires an uppercase two-letter country', async () => {
    const c = await caller(makeDb());
    for (const country of ['ca', 'CAN', 'C', '']) {
      await expect(c.mileageRate.create(rule({ country }) as never), country).rejects.toThrow();
    }
  });

  it('requires at least one band and caps them', async () => {
    const c = await caller(makeDb());
    await expect(c.mileageRate.create(rule({ tiers: [] }) as never)).rejects.toThrow();
    const many = Array.from({ length: 21 }, (_, i) => ({
      fromDistance: i * 100,
      rateMinor: '70',
    }));
    await expect(c.mileageRate.create(rule({ tiers: many }) as never)).rejects.toThrow();
  });

  it('caps the subject list', async () => {
    const c = await caller(makeDb());
    const many = Array.from({ length: 501 }, () => U('3'));
    await expect(c.mileageRate.create(rule({ subjectUserIds: many }) as never)).rejects.toThrow();
  });
});

describe('mileageRate.retire', () => {
  const caller = (db: unknown) => callerFor(db, MILEAGE);

  it('404s a rule that does not exist', async () => {
    const db = makeDb();
    await expect(
      (await caller(db)).mileageRate.retire({
        id: U('2'),
        effectiveTo: '2026-12-31T00:00:00Z',
      } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a rule that was already superseded', async () => {
    // Its window is already closed; retiring it would move a boundary the successor
    // depends on.
    const db = makeDb();
    db.mileageRate.findUnique.mockResolvedValue({
      effectiveFrom: new Date('2025-01-01T00:00:00Z'),
      supersededById: U('8'),
    });
    await expect(
      (await caller(db)).mileageRate.retire({
        id: U('2'),
        effectiveTo: '2026-12-31T00:00:00Z',
      } as never),
    ).rejects.toThrow(/retire its successor instead/);
  });

  it('refuses an end date before the start', async () => {
    const db = makeDb();
    db.mileageRate.findUnique.mockResolvedValue({
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      supersededById: null,
    });
    await expect(
      (await caller(db)).mileageRate.retire({
        id: U('2'),
        effectiveTo: '2025-12-31T00:00:00Z',
      } as never),
    ).rejects.toThrow(/cannot end before it starts/);
  });

  it('retires a live rule', async () => {
    /**
     * A claim in that country past the end date is then refused, which is the honest
     * answer — rather than priced at zero, which looks like a working claim worth
     * nothing.
     */
    const db = makeDb();
    db.mileageRate.findUnique.mockResolvedValue({
      effectiveFrom: new Date('2025-01-01T00:00:00Z'),
      supersededById: null,
    });
    await (await caller(db)).mileageRate.retire({
      id: U('2'),
      effectiveTo: '2026-12-31T00:00:00Z',
    } as never);
    expect(db.mileageRate.update.mock.calls[0]?.[0]?.data).toEqual({
      effectiveTo: new Date('2026-12-31T00:00:00Z'),
    });
  });

  it('allows ending on the same day it started', async () => {
    const db = makeDb();
    db.mileageRate.findUnique.mockResolvedValue({
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      supersededById: null,
    });
    await expect(
      (await caller(db)).mileageRate.retire({
        id: U('2'),
        effectiveTo: '2026-01-01T00:00:00Z',
      } as never),
    ).resolves.toBeTruthy();
  });
});

describe('mileageRate.delete', () => {
  const caller = (db: unknown) => callerFor(db, MILEAGE);

  it('refuses a rule anything was priced under, naming the count', async () => {
    /**
     * Once a claim references the rule, the succession chain IS the audit trail —
     * deleting it strands that claim's `mileageRateId` and the number on the report
     * can no longer be explained.
     */
    const db = makeDb();
    db.expenseLineItem.count.mockResolvedValue(3);
    await expect((await caller(db)).mileageRate.delete({ id: U('2') })).rejects.toThrow(
      /3 expense line\(s\) were priced with this rule/,
    );
    expect(db.mileageRate.delete).not.toHaveBeenCalled();
  });

  it('deletes an unused rule', async () => {
    const db = makeDb();
    // VeloExpense: the rule is read first — NOT_FOUND when it is not the tenant's, and its
    // country and dates go into the audit row the delete now writes.
    db.mileageRate.findUnique.mockResolvedValue({
      country: 'CA',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: null,
    });
    await expect((await caller(db)).mileageRate.delete({ id: U('2') })).resolves.toEqual({
      ok: true,
    });
    // VeloExpense: `select: { id }`, so the delete returns only the id into the audit.
    expect(db.mileageRate.delete).toHaveBeenCalledWith({ where: { id: U('2') }, select: { id: true } });
    expect(withAuditCalls[0]).toMatchObject({ action: 'MILEAGE_RATE_DELETED', entityId: U('2') });
  });
});

describe('mileageRate.list', () => {
  it('stringifies the BigInt band bounds and rates', async () => {
    const db = makeDb();
    db.mileageRate.findMany.mockResolvedValue([
      {
        id: U('2'),
        country: 'CA',
        tiers: [{ id: 't1', fromDistance: 0n, rateMinor: 70n }],
        subjects: [],
      },
    ]);
    const c = await callerFor(db, READ);
    const out = await c.mileageRate.list();
    expect(out[0]?.tiers[0]).toEqual({ id: 't1', fromDistance: '0', rateMinor: '70' });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('orders bands lowest bound first', async () => {
    // The bands are read as a ladder; out of order they are unreadable.
    const db = makeDb();
    const c = await callerFor(db, READ);
    await c.mileageRate.list();
    const include = db.mileageRate.findMany.mock.calls[0]?.[0]?.include as {
      tiers: { orderBy: unknown };
    };
    expect(include.tiers.orderBy).toEqual({ fromDistance: 'asc' });
  });
});

describe('policyRule.kinds', () => {
  it('is readable with the read permission and lists the registry', async () => {
    // The registry is code-owned, so this is the client's only way to know what rule
    // types this build supports.
    const db = makeDb();
    const c = await callerFor(db, READ);
    const out = (await c.policyRule.kinds()) as Record<string, unknown>;
    expect(out).toBeTruthy();
  });
});
