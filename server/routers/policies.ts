/**
 * Policies admin router — Module 3 reference data (Phase 2).
 *
 * Five sub-resources, each with `list` + `upsert` + (where it makes
 * sense) `delete`:
 *
 *   - expensePolicy  — per-category policy (limits + receipt/approval flags)
 *   - fxRate         — currency-pair rates (append-only; "delete" means
 *                      drop an outdated row; admin refreshes by writing
 *                      a new fetchedAt)
 *   - perDiemRate    — country/city × effective-range rates
 *   - mileageRate    — country × unit × effective-range rates
 *   - customField    — admin-defined REPORT / EMPLOYEE extras
 *   - systemFlag     — global key/value bag
 *
 * Every write goes through `withAudit` so admins can later prove what
 * policy was active when a report was validated. Reads are gated on
 * `config.policy.read`; writes on the per-resource update permission.
 *
 * Ported from ExpenseOS `apps/web/src/server/routers/policies.ts` (550b2945), one
 * sub-router at a time as its screen is ported: `fxRate` with /admin/fx-rates (w1-07),
 * `mileageRate` with /admin/mileage-rates (w1-08), `perDiemRate` with /admin/per-diem-rates
 * (w1-09).
 * The others arrive with their screens (mileage and per-diem rates later in Wave 1; the
 * expense policy and custom fields with theirs). VeloExpense differences, marked below:
 * `fx_rate` is per tenant (0051, d18), so every read and write is the tenant's own; a
 * currency the system has no row for, or a pair quoted against itself, is answered
 * BAD_REQUEST rather than as a 500 from the table's foreign key or check; and the audit
 * row names the pair in its details rather than as the entity id. For mileage: a person
 * is one display name (VeloExpense's `app_user`), returned in ExpenseOS's first/last
 * shape; another tenant's person, a GL account that is not the tenant's own postable
 * one, or a negative rate is BAD_REQUEST rather than a 500 from the table; a rule that
 * is not the tenant's is NOT_FOUND on delete; and the delete is audited. For per-diem
 * rates: the currency is the ISO code (VeloExpense keys a currency by it), every write is
 * audited (ExpenseOS's per-diem writes are not, though this header says they are), and a
 * refusal the table makes — another tenant's category or scope, an end before the
 * start, a negative cap — is a 4xx (`perDiemWrite`). `policyRule` with the Rule Builder,
 * /admin/policy-rules (w4-02b, d63), and `expensePolicy` with /admin/policies (w4-02c,
 * d65): see their sections below for what differs.
 */

import { auditActions, withAudit } from '@expenseos/audit';
import { PolicyViolationSeverity } from '@expenseos/db';
import { PREDICATE_OPS } from '@expenseos/predicate';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma, type TenantDb } from '@/lib/db/prisma';
// VeloExpense: ExpenseOS's `Currency.symbol`, from the platform (shared with the expenses router).
import { currencySymbol } from '@/server/lib/currencySymbol';
import { LINE_FIELDS, REPORT_FIELDS } from '@/server/policy/facts';
import { RULE_KIND_CODES, RULE_KINDS } from '@/server/policy/kinds';
import { REFUSAL_KEYS, refusal } from '@/server/refusal';
import { router, withPermission } from '@/server/trpc';

// ── Common shapes ────────────────────────────────────────────────────

/** BigInt cents come back to clients as strings — same convention used
 *  by every other money-bearing tRPC router in the app. */
function minorOut(n: bigint | null | undefined): string | null {
  return n == null ? null : n.toString();
}

/** Z input that accepts string|number|bigint and coerces to bigint
 *  cents (with a sanity range). null → null (use to clear a limit). */
const optionalMinorInput = z
  .union([z.string(), z.number(), z.bigint(), z.null()])
  .transform((v) => {
    if (v == null) return null;
    if (typeof v === 'bigint') return v;
    const n = BigInt(typeof v === 'string' ? v : Math.round(v));
    return n;
  })
  .nullable();

// ── ExpensePolicy ────────────────────────────────────────────────────
//
// VeloExpense (w4-02c, d65): ExpenseOS's per-category policy, on `expense_category_policy`
// (0065), read by ExpenseOS's per-category kinds since the cutover (w4-02d). Differences,
// marked: the screen is told the organization's policy
// currency (`currency`), where ExpenseOS's assumes CAD; what the table refuses is a 4xx
// (`expensePolicyWrite`); and the audit action is VeloExpense's registry name.

const expensePolicyOut = (p: {
  categoryId: string;
  receiptRequired: boolean;
  approvalRequired: boolean;
  perTransactionLimitMinor: bigint | null;
  dailyLimitMinor: bigint | null;
  monthlyLimitMinor: bigint | null;
  annualLimitMinor: bigint | null;
  notes: string | null;
}) => ({
  categoryId: p.categoryId,
  receiptRequired: p.receiptRequired,
  approvalRequired: p.approvalRequired,
  perTransactionLimitMinor: minorOut(p.perTransactionLimitMinor),
  dailyLimitMinor: minorOut(p.dailyLimitMinor),
  monthlyLimitMinor: minorOut(p.monthlyLimitMinor),
  annualLimitMinor: minorOut(p.annualLimitMinor),
  notes: p.notes,
});

const expensePolicyPatch = z.object({
  receiptRequired: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  perTransactionLimitMinor: optionalMinorInput.optional(),
  dailyLimitMinor: optionalMinorInput.optional(),
  monthlyLimitMinor: optionalMinorInput.optional(),
  annualLimitMinor: optionalMinorInput.optional(),
  notes: z.string().nullable().optional(),
});

/** VeloExpense: a policy patch with its BigInt limits as minor-unit strings, for the audit. */
function auditablePatch(patch: z.infer<typeof expensePolicyPatch>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
  );
}

/**
 * VeloExpense: what `expense_category_policy` refuses (0065), as a 4xx. A category the
 * tenant does not have fails the composite foreign key (P2003). If another tenant already
 * has a policy row under that id, the upsert's ON CONFLICT reaches a row RLS hides, which
 * Postgres refuses ("new row violates row-level security policy"; P2002 if it ever surfaces
 * as the key instead); that is answered the same way, so it says nothing about the other
 * tenant. And a limit cannot be negative.
 */
function expensePolicyRefusal(cause: unknown): TRPCError | null {
  const err = cause as { code?: string; message?: string } | null;
  const hiddenRow =
    err?.message?.includes('row-level security policy') &&
    err.message.includes('expense_category_policy');
  if (err?.code === 'P2003' || err?.code === 'P2002' || hiddenRow) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That category is not one this organization has.',
      cause,
    });
  }
  if (err?.message?.includes('expense_category_policy_limits_nonnegative')) {
    return new TRPCError({ code: 'BAD_REQUEST', message: 'A limit cannot be negative.', cause });
  }
  return null;
}

/** VeloExpense: `withPermission(P.config.policyUpdate)` with `expensePolicyRefusal` applied. */
function expensePolicyWrite() {
  return withPermission(P.config.policyUpdate).use(async ({ next }) => {
    const result = await next();
    if (!result.ok) {
      const refused = expensePolicyRefusal(result.error.cause);
      if (refused) throw refused;
    }
    return result;
  });
}

/**
 * VeloExpense: the organization's policy currency (`policy_currency_code`, 0015, NOT NULL
 * DEFAULT 'CAD'), read in the tenant's transaction. ExpenseOS reads a `policyCurrency`
 * system flag. CAD when there is no organization row, as ExpenseOS defaults.
 */
async function policyCurrencyOf(db: TenantDb): Promise<string> {
  const rows = await db.$queryRaw<Array<{ code: string }>>`
    SELECT policy_currency_code AS code FROM organization
     WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`;
  return rows[0]?.code ?? 'CAD';
}

// ── FxRate ───────────────────────────────────────────────────────────

/** Hard ceiling on a hand-entered rate. Technical, not a business rule: the column is
 *  Decimal(18,8) and no currency pair is quoted anywhere near a million. What it
 *  refuses is the zero and the fat-fingered `137` for `1.37` — a zero rate values every
 *  un-snapshotted foreign line at nothing while `missingRates` stays empty. */
const MAX_FX_RATE = 1_000_000;

/**
 * How far a hand-entered rate may sit from the LAST one recorded for the same pair
 * before it needs a stated reason. Percent, either direction, inclusive.
 *
 * The ceiling above catches the absurd; this catches the plausible-looking wrong
 * number — an inverted quote (0.73 typed for 1.37 is 47% away), a pair entered
 * backwards, a stale figure from a different year. Each is a rate the engine would
 * convert every foreign claim at and NetSuite would receive as `exchangeRate`.
 *
 * The number is a judgement, not a quotation. The only feed is the Bank of Canada
 * daily noon pull (`integration.boc.fxRateSync`), and nothing else in the repo defines
 * an FX tolerance, so there is no source figure to cite: a major pair moves low single
 * digits between two daily observations and rarely more than that across the gap a
 * manual entry usually bridges, while the mistakes listed above sit far outside. 25%
 * is wide enough that a genuine move never asks for a reason and narrow enough that
 * none of those gets in without one.
 *
 * It is a bound, not a wall: a wrong PRIOR row would otherwise block its own
 * correction, so `reason` (with `confirmDeviation`) lets the caller cross it on the
 * record — see `fxRate.add`.
 */
export const MAX_FX_DEVIATION_PERCENT = 25;

const fxRatePatch = z
  .object({
    base: z.string().length(3),
    quote: z.string().length(3),
    // Rate as a decimal string. Use string at the boundary so we don't
    // lose precision through the JSON Number path.
    // The (0, MAX_FX_RATE] bound is checked in the mutation, not here: a Zod failure
    // reaches the browser as the generic "some details are not valid", and a typed zero
    // deserves its own sentence, in the reader's language (`REFUSAL_KEYS.fxRateOutOfBounds`).
    rate: z.string().regex(/^\d+(\.\d+)?$/),
    /** The correction path past `MAX_FX_DEVIATION_PERCENT`. The reason is what makes
     *  the correction traceable — it lands in the audit row beside both rates — so the
     *  explicit flag is never accepted without one. */
    confirmDeviation: z.literal(true).optional(),
    reason: z.string().trim().min(10).max(500).optional(),
  })
  .refine((v) => !v.confirmDeviation || v.reason !== undefined, {
    message: 'confirmDeviation requires a reason of at least 10 characters',
    path: ['reason'],
  });

function assertRateInBounds(rate: string): void {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_FX_RATE) {
    throw refusal(
      'BAD_REQUEST',
      REFUSAL_KEYS.fxRateOutOfBounds,
      `Rate must be a positive number no greater than ${MAX_FX_RATE}.`,
      { max: MAX_FX_RATE },
    );
  }
}

/**
 * VeloExpense: the pair is checked against the system's currencies before the write.
 * ExpenseOS's `FxRate` has no foreign key to its currencies; VeloExpense's has (0015), so
 * an unknown code, or a pair quoted against itself (`fx_rate_distinct_chk`), would
 * otherwise reach the person as a 500.
 */
async function assertPairKnown(
  db: { currency: { count: (args: { where: { code: { in: string[] } } }) => Promise<number> } },
  base: string,
  quote: string,
): Promise<void> {
  if (base === quote) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A rate needs two different currencies.' });
  }
  const known = await db.currency.count({ where: { code: { in: [base, quote] } } });
  if (known !== 2) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${base}→${quote}: both currencies must be ones the system knows.`,
    });
  }
}

/** ExpenseOS's money-input coercion: a minor-unit amount as a string, number or bigint. */
const requiredMinorInput = z.union([z.string(), z.number(), z.bigint()]).transform((v) => {
  if (typeof v === 'bigint') return v;
  return BigInt(typeof v === 'string' ? v : Math.round(v));
});

// ── PerDiemRate ──────────────────────────────────────────────────────

const perDiemRatePatch = z.object({
  country: z.string().min(2).max(2),
  city: z.string().min(1).max(100),
  // The per-diem "bucket" is the expense category — one allowance per category.
  categoryId: z.string().uuid(),
  amountMinor: requiredMinorInput,
  firstLastDay: z.boolean().optional(),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable().optional(),
  // Optional scoping dimensions (null = applies to everyone). See the
  // per-diem resolver in @expenseos/approvals.
  jobLevelId: z.string().uuid().nullable().optional(),
  legalEntityId: z.string().uuid().nullable().optional(),
  businessUnitId: z.string().uuid().nullable().optional(),
  // VeloExpense: the ISO code — VeloExpense keys a currency by it (0053).
  currencyId: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
});

/**
 * VeloExpense: the refusals `per_diem_rate` makes, answered with the code they mean
 * rather than a 500 — ExpenseOS's router writes straight through and lets its own
 * database errors out. A reference the tenant cannot see (another tenant's category or
 * scope, an unknown currency) fails a foreign key (P2003); a rate that is not the
 * tenant's is missing (P2025); and the table's checks hold an ISO country, a city, a
 * non-negative cap and an end that does not precede the start.
 */
function perDiemRefusal(cause: unknown): TRPCError | null {
  const err = cause as { code?: string; name?: string; message?: string } | null;
  if (err?.code === 'P2025') return new TRPCError({ code: 'NOT_FOUND', cause });
  if (err?.code === 'P2003') {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The category, scope or currency is not one this organization has.',
      cause,
    });
  }
  const check = err?.message?.match(/violates check constraint "(per_diem_rate_\w+)"/)?.[1];
  if (check) {
    const why: Record<string, string> = {
      per_diem_rate_country_iso: 'Use a two-letter country code (e.g. CA).',
      per_diem_rate_city: 'A city is required.',
      per_diem_rate_amount_nonnegative: 'A daily cap cannot be negative.',
      per_diem_rate_window: 'A rate cannot end before it starts.',
    };
    return new TRPCError({ code: 'BAD_REQUEST', message: why[check] ?? 'That rate is not valid.', cause });
  }
  return null;
}

/** VeloExpense: `withPermission` for the per-diem writes, with `perDiemRefusal` applied. */
function perDiemWrite() {
  return withPermission(P.config.perDiemUpdate).use(async ({ next }) => {
    const result = await next();
    if (!result.ok) {
      const refusal = perDiemRefusal(result.error.cause);
      if (refusal) throw refusal;
    }
    return result;
  });
}

// ── MileageRate ──────────────────────────────────────────────────────

/** VeloExpense: ExpenseOS's Prisma enum `MileageUnit`; text with a CHECK here (0052). */
const MileageUnit = { KM: 'KM', MI: 'MI' } as const;

const mileageRuleInput = z.object({
  country: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/, 'ISO-3166-1 alpha-2 (uppercase)'),
  unit: z.enum(MileageUnit),
  effectiveFrom: z.coerce.date(),
  /** Where this rule's mileage posts; null falls back to the category's account. */
  glAccountId: z.string().uuid().nullable().optional(),
  /** Empty = the country default. Non-empty = a car allowance for those people. */
  subjectUserIds: z.array(z.string().uuid()).max(500).default([]),
  /** Bands, lowest bound first. Must start at 0; validated below. */
  tiers: z
    .array(
      z.object({
        fromDistance: z.number().nonnegative(),
        // VeloExpense: never negative (0052's CHECK). A negative rate would make a
        // mileage claim pay the company; ExpenseOS's screen refuses one, its router did not.
        rateMinor: requiredMinorInput.refine((v) => v >= 0n, 'A rate cannot be negative.'),
      }),
    )
    .min(1)
    .max(20),
});

/**
 * The rule in force for the same SCOPE as `input`, if any.
 *
 * Scope is "the country default" (no subjects) or "a car allowance covering
 * person X". A country default and a car-allowance rule coexist by design — the
 * specific one wins at pricing time — so only a same-scope collision counts.
 *
 * Returns every colliding rule, because a new car-allowance rule naming five
 * people can collide with up to five existing ones.
 */
async function findScopeCollisions(
  db: TenantDb,
  input: { country: string; effectiveFrom: Date; subjectUserIds: string[] },
): Promise<{ id: string; effectiveFrom: Date }[]> {
  const stillInForce = {
    country: input.country,
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.effectiveFrom } }],
  };
  return db.mileageRate.findMany({
    where: {
      ...stillInForce,
      ...(input.subjectUserIds.length > 0
        ? { subjects: { some: { userId: { in: input.subjectUserIds } } } }
        : { subjects: { none: {} } }),
    },
    select: { id: true, effectiveFrom: true },
  });
}

/** Tiers must start at 0 and have no duplicate bounds — the model can't express
 *  a gap, but it can express a first band that doesn't start at zero, which
 *  would leave the opening kilometres unpriced. */
function assertTiersWellFormed(tiers: { fromDistance: number }[]): void {
  const sorted = [...tiers].sort((a, b) => a.fromDistance - b.fromDistance);
  if (sorted[0]?.fromDistance !== 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The first band must start at 0 — otherwise the opening distance has no rate.',
    });
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].fromDistance === sorted[i - 1].fromDistance) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Two bands both start at ${sorted[i].fromDistance}.`,
      });
    }
  }
}

/**
 * VeloExpense: the people and the GL account a rule names must be the tenant's own, and
 * the account postable. RLS hides another tenant's rows, so the composite foreign keys
 * (0052) would refuse them — as a 500. This answers BAD_REQUEST first, saying which.
 */
async function assertMileageReferencesKnown(
  db: TenantDb,
  input: { subjectUserIds: string[]; glAccountId?: string | null },
): Promise<void> {
  const people = [...new Set(input.subjectUserIds)];
  if (people.length > 0) {
    const known = await db.user.count({ where: { id: { in: people } } });
    if (known !== people.length) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Someone on this rule is not a person in this organization.' });
    }
  }
  if (input.glAccountId) {
    const account = await db.glAccount.findUnique({
      where: { id: input.glAccountId },
      select: { isPostable: true, isActive: true },
    });
    if (!account || !account.isPostable || !account.isActive) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'That GL account cannot take postings.' });
    }
  }
}

// ── PolicyRule (v2 — admin-authored rule instances) ──────────────────
//
// A rule INSTANCE binds a registry rule KIND (code) to a severity, an
// optional `condition` (a Predicate over the kind's fact set), `params`,
// a message key, and optional scoping dimensions + an effective window.
// The KIND governs the shape: `scope` is denormalized from it (an admin
// can't mismatch), the `condition` is validated against the kind's
// conditionSchema, and `params` against its paramsSchema.
//
// VeloExpense (w4-02b): since the cutover (w4-02d) these rows are what submit checks
// (server/policy/validate.ts). Differences from ExpenseOS, marked:
//   · the policy currency is the organization's `policy_currency_code` (0015), where
//     ExpenseOS keeps a `policyCurrency` system flag;
//   · there is no role table until the role builder (w4-10, d64): `scopeOptions` offers
//     no roles and a rule cannot be scoped to one yet;
//   · each write is audited in the same transaction as the row (ExpenseOS writes the row,
//     then the audit in a second, empty transaction), and what the table refuses — another
//     tenant's scope or category, an end before the start, a rule that is not the
//     tenant's — is a 4xx rather than a 500 (`policyRuleWrite`);
//   · `violations` and `resolveViolation` arrive with the violations register (w4-02d).

const policyRuleInput = z.object({
  kindCode: z.string().min(1),
  severity: z.enum(PolicyViolationSeverity),
  /** A `Predicate` for PREDICATE kinds; null for AGGREGATE kinds. */
  condition: z.unknown().nullish(),
  params: z.unknown().optional(),
  messageKey: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  departmentId: z.string().uuid().nullish(),
  jobLevelId: z.string().uuid().nullish(),
  legalEntityId: z.string().uuid().nullish(),
  businessUnitId: z.string().uuid().nullish(),
  roleId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullish(),
});

/** Validate an instance against its kind and shape it into the Prisma row.
 *  Throws BAD_REQUEST when the kind is unknown or the condition/params
 *  don't satisfy the kind's schemas — so a bad rule can never be persisted. */
function coerceRuleData(input: z.infer<typeof policyRuleInput>) {
  const kind = RULE_KINDS[input.kindCode];
  if (!kind) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown rule kind: ${input.kindCode}` });
  }

  let condition: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
  if (kind.conditionSchema) {
    const parsed = kind.conditionSchema.safeParse(input.condition ?? undefined);
    if (!parsed.success) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Invalid condition: ${parsed.error.message}`,
      });
    }
    condition = parsed.data as Prisma.InputJsonValue;
  } else if (input.condition != null) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `${kind.code} takes no condition` });
  }

  const params = kind.paramsSchema.safeParse(input.params ?? {});
  if (!params.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid params: ${params.error.message}`,
    });
  }

  // VeloExpense (BG-4): a kind's severity ceiling — a budget never blocks.
  const rank = { INFO: 0, WARNING: 1, BLOCK: 2 } as const;
  if (kind.maxSeverity && rank[input.severity] > rank[kind.maxSeverity]) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${kind.code} cannot be more severe than ${kind.maxSeverity}.`,
    });
  }

  // VeloExpense: no role table until w4-10 (d64), so `role_id` has no foreign key behind
  // it. A role id accepted now could name nothing, and the rule would apply to nobody
  // without saying so. Refused until roles exist; the Rule Builder offers none.
  if (input.roleId != null) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Rules cannot be scoped to a role yet.',
    });
  }

  return {
    kindCode: kind.code,
    scope: kind.scope, // denormalized from the kind — never client-supplied
    severity: input.severity,
    condition,
    params: params.data as Prisma.InputJsonValue,
    messageKey: input.messageKey,
    enabled: input.enabled ?? true,
    departmentId: input.departmentId ?? null,
    jobLevelId: input.jobLevelId ?? null,
    legalEntityId: input.legalEntityId ?? null,
    businessUnitId: input.businessUnitId ?? null,
    roleId: input.roleId ?? null,
    categoryId: input.categoryId ?? null,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
  };
}

/**
 * VeloExpense: what `policy_rule` refuses (0064), as a 4xx. A scope or category the tenant
 * does not have fails a composite foreign key (P2003); a rule that is not the tenant's is
 * missing (P2025); and the table holds an end after the start.
 */
function policyRuleRefusal(cause: unknown): TRPCError | null {
  const err = cause as { code?: string; message?: string } | null;
  if (err?.code === 'P2025') return new TRPCError({ code: 'NOT_FOUND', cause });
  if (err?.code === 'P2003') {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The department, level, entity, unit or category is not one this organization has.',
      cause,
    });
  }
  if (err?.message?.includes('policy_rule_effective_range')) {
    return new TRPCError({ code: 'BAD_REQUEST', message: 'A rule cannot end before it starts.', cause });
  }
  return null;
}

/** VeloExpense: `withPermission(P.config.policyUpdate)` with `policyRuleRefusal` applied. */
function policyRuleWrite() {
  return withPermission(P.config.policyUpdate).use(async ({ next }) => {
    const result = await next();
    if (!result.ok) {
      const refused = policyRuleRefusal(result.error.cause);
      if (refused) throw refused;
    }
    return result;
  });
}

/**
 * VeloExpense: the audit details for a rule write — ExpenseOS's `{ op, ...data }`, with the
 * stored condition written as `null` where the row holds SQL NULL (`Prisma.JsonNull` is a
 * sentinel object, not a value the audit chain should hash).
 */
function policyRuleDetails(op: string, data: Partial<ReturnType<typeof coerceRuleData>>) {
  return {
    op,
    ...data,
    ...('condition' in data ? { condition: data.condition === Prisma.JsonNull ? null : data.condition } : {}),
  };
}

// ── Router ───────────────────────────────────────────────────────────

export const policiesRouter = router({
  // ── ExpensePolicy (one row per ExpenseCategory) ────────────────
  expensePolicy: router({
    list: withPermission(P.config.policyRead).query(async ({ ctx }) => {
      const rows = await ctx.db.expensePolicy.findMany({
        orderBy: { categoryId: 'asc' },
      });
      return rows.map(expensePolicyOut);
    }),
    /** Admin "Expense Policies" page view — every active category
     *  joined with its policy (or null when missing). Returned in
     *  sortOrder so the table reads the same as the category picker. */
    byCategory: withPermission(P.config.policyRead).query(async ({ ctx }) => {
      const cats = await ctx.db.expenseCategory.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        // The GL account is a reference now, so its number comes from the joined
        // row rather than off the category.
        include: { policy: true, glAccount: { select: { number: true } } },
      });
      return cats.map((c) => ({
        category: {
          id: c.id,
          label: c.label as Record<string, string>,
          icon: c.icon,
          glAccount: c.glAccount?.number ?? null,
        },
        policy: c.policy ? expensePolicyOut(c.policy) : null,
      }));
    }),
    /** VeloExpense: the currency the limits are in — the organization's policy currency —
     *  so the screen labels and converts them in it (ExpenseOS's screen assumes CAD); and,
     *  for the control that changes it (d68), the currencies it may be. */
    currency: withPermission(P.config.policyRead).query(async ({ ctx }) => {
      const [code, rows] = await Promise.all([
        policyCurrencyOf(ctx.db),
        ctx.db.currency.findMany({ select: { code: true }, orderBy: { code: 'asc' } }),
      ]);
      return { code, options: rows.map((r) => r.code) };
    }),

    /**
     * VeloExpense (w4-02d, d68): change the organization's policy currency.
     *
     * ExpenseOS keeps it in a system flag with no screen; VeloExpense's v1 policy screen
     * was its only control, and went with v1's engine at the cutover, so it lives here,
     * beside the limits it is the currency of. The limits already set are NOT converted —
     * a limit is a figure an admin chose in a currency, and silently re-pricing it at
     * today's rate would be a policy nobody chose (the screen says so). Audited.
     */
    setCurrency: withPermission(P.config.policyUpdate)
      .input(z.object({ code: z.string().regex(/^[A-Za-z]{3}$/) }))
      .mutation(async ({ ctx, input }) => {
        const code = input.code.toUpperCase();
        const known = await ctx.db.currency.findUnique({ where: { code }, select: { code: true } });
        if (!known) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `${code} is not a currency the system has.` });
        }
        const from = await policyCurrencyOf(ctx.db);
        await withAudit(
          ctx.db,
          {
            action: 'POLICY_CURRENCY_SET',
            entityType: 'Organization',
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: { from, to: code },
          },
          // `organization` is not RLS-scoped (it has no organization_id): the WHERE on the
          // tenant's own id is what keeps this to one row (PE-8's write half). The row's id
          // is the audit entry's entity; no row means no tenant, and nothing is audited.
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ id: string }>>`
              UPDATE organization SET policy_currency_code = ${code}, updated_at = now()
               WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid
              RETURNING id::text AS id`;
            if (rows.length !== 1) {
              throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'No tenant to set the policy currency for.' });
            }
            return rows[0].id;
          },
          (id) => id,
        );
        return { code };
      }),
    /** Upsert by categoryId. Always called with a known category id —
     *  the policy row is created at seed time, so this is effectively
     *  an update, but using upsert keeps the handler tolerant if
     *  someone hand-deleted a row. */
    upsert: expensePolicyWrite()
      .input(z.object({ categoryId: z.string().uuid(), patch: expensePolicyPatch }))
      .mutation(async ({ ctx, input }) => {
        // Hash-chained via withAudit — a placeholder `entryHash: ''` collides on
        // the second policy edit (the hash column is unique).
        const updated = await withAudit(
          ctx.db,
          {
            action: auditActions.config('policy'),
            entityType: 'ExpensePolicy',
            entityId: input.categoryId,
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            // VeloExpense: the limits as minor-unit strings. The audit chain refuses a BigInt
            // (it would not survive the hash's canonical JSON), which ExpenseOS's patch holds.
            details: { categoryId: input.categoryId, patch: auditablePatch(input.patch) },
          },
          (tx) =>
            tx.expensePolicy.upsert({
              where: { categoryId: input.categoryId },
              update: input.patch,
              create: { categoryId: input.categoryId, ...input.patch },
            }),
        );
        return expensePolicyOut(updated);
      }),
  }),

  // ── FxRate (append-only — new fetchedAt per refresh) ───────────
  fxRate: router({
    /** Latest row per (base, quote) pair — what the engine uses at
     *  validation time. */
    latest: withPermission(P.config.policyRead).query(async ({ ctx }) => {
      // Group by (base, quote) and return the row with max fetchedAt
      // per group. Implemented in two steps to keep the query
      // database-agnostic; the table is small enough that this is fine.
      const all = await ctx.db.fxRate.findMany({ orderBy: { fetchedAt: 'desc' } });
      const seen = new Set<string>();
      const out: Array<{ base: string; quote: string; rate: string; fetchedAt: Date }> = [];
      for (const r of all) {
        const k = `${r.base}:${r.quote}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ base: r.base, quote: r.quote, rate: r.rate.toString(), fetchedAt: r.fetchedAt });
      }
      return out;
    }),
    /** The append-only history for ONE pair, newest first. Scoped to a pair
     *  because that's the only question worth asking of it — "how has USD→CAD
     *  moved"; the whole undifferentiated log interleaved every pair and read
     *  as noise. */
    history: withPermission(P.config.policyRead)
      .input(z.object({ base: z.string().length(3), quote: z.string().length(3) }))
      .query(async ({ ctx, input }) => {
        const all = await ctx.db.fxRate.findMany({
          where: { base: input.base.toUpperCase(), quote: input.quote.toUpperCase() },
          orderBy: { fetchedAt: 'desc' },
          take: 200,
        });
        return all.map((r) => ({
          base: r.base,
          quote: r.quote,
          rate: r.rate.toString(),
          fetchedAt: r.fetchedAt,
        }));
      }),
    /** Add a new rate row. Each (base, quote, fetchedAt) is a distinct
     *  history entry; the latest wins at validation.
     *
     *  Audited, like every other write in this router. It was the one that was
     *  not, and a hand-entered rate is the figure every foreign claim converts at
     *  and NetSuite receives as `exchangeRate` — the FxRate table has no actor
     *  column, so without this row nobody could say who typed it. */
    add: withPermission(P.config.fxRateUpdate)
      .input(fxRatePatch)
      .mutation(async ({ ctx, input }) => {
        assertRateInBounds(input.rate);
        const fetchedAt = new Date();
        const base = input.base.toUpperCase();
        const quote = input.quote.toUpperCase();
        await assertPairKnown(ctx.db, base, quote); // VeloExpense: see assertPairKnown.

        /**
         * Bounded against the pair's own last row. `fetchedAt` is stamped here, so the
         * row in force is simply the newest one; a first-ever rate for a pair has nothing
         * to be measured against and is taken as typed (the ceiling still applies).
         *
         * Decimal arithmetic throughout — the column is Decimal(18,8) and a float
         * round-trip could put an exactly-on-the-line rate on the wrong side of it.
         */
        const prior = await ctx.db.fxRate.findFirst({
          where: { base, quote },
          orderBy: { fetchedAt: 'desc' },
        });
        const priorRate = prior ? new Prisma.Decimal(String(prior.rate)) : null;
        const deviationPercent = priorRate
          ? new Prisma.Decimal(input.rate).minus(priorRate).abs().div(priorRate).times(100)
          : null;
        const exceeded = deviationPercent?.greaterThan(MAX_FX_DEVIATION_PERCENT) ?? false;
        if (exceeded && input.reason === undefined) {
          const on = prior?.fetchedAt.toISOString().slice(0, 10) ?? '';
          const deviation = deviationPercent?.toFixed(1) ?? '';
          // Thrown as a refusal, not a bare `TRPCError`: the drawer renders the catalog
          // sentence for `data.refusal.key` in the reader's language, and falls back to
          // this English one. The figures travel pre-formatted — `priorRate` is a
          // Decimal string, `on` an ISO date — so both languages say the same numbers.
          throw refusal(
            'PRECONDITION_FAILED',
            REFUSAL_KEYS.fxRateFarFromPrior,
            `${base}→${quote} was last recorded at ${priorRate} on ${on}. ` +
              `${input.rate} is ${deviation}% away from that — more than ` +
              `the ${MAX_FX_DEVIATION_PERCENT}% a rate may move without a reason. If the ` +
              'earlier rate was the wrong one, add this one with a reason saying so.',
            {
              base,
              quote,
              prior: String(priorRate),
              on,
              rate: input.rate,
              deviation,
              bound: MAX_FX_DEVIATION_PERCENT,
            },
          );
        }

        const row = await withAudit(
          ctx.db,
          {
            action: auditActions.config('fxRate'),
            entityType: 'FxRate',
            // VeloExpense: no `entityId`. ExpenseOS writes `${base}:${quote}`; VeloExpense's
            // audit chain keys an entity by uuid, and a rate has none, so the pair is named
            // by `base` and `quote` in the details below (the writer keeps the type there).
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: {
              base,
              quote,
              rate: input.rate,
              fetchedAt: fetchedAt.toISOString(),
              // The row this one was measured against, and how far it sits from it —
              // so the audit trail reads as "1.36 → 2.00, +47%, on a stated reason"
              // rather than a bare number a reviewer has to go and compare.
              priorRate: priorRate?.toString() ?? null,
              priorFetchedAt: prior?.fetchedAt.toISOString() ?? null,
              deviationPercent: deviationPercent ? Number(deviationPercent.toFixed(2)) : null,
              /** True only when the bound was crossed on purpose — the fact a reviewer
               *  will filter for. A reason given inside the bound is kept but is not
               *  a confirmation of anything. */
              deviationConfirmed: exceeded,
              reason: input.reason ?? null,
            },
          },
          (tx) =>
            tx.fxRate.create({
              data: { base, quote, rate: new Prisma.Decimal(input.rate), fetchedAt },
            }),
        );
        return { ...row, rate: row.rate.toString() };
      }),
  }),
  // ── PerDiemRate ────────────────────────────────────────────────
  perDiemRate: router({
    list: withPermission(P.config.policyRead).query(async ({ ctx }) => {
      const rows = await ctx.db.perDiemRate.findMany({
        orderBy: [{ country: 'asc' }, { city: 'asc' }, { effectiveFrom: 'desc' }],
      });
      return rows.map((r) => ({ ...r, amountMinor: r.amountMinor.toString() }));
    }),
    /** Option lists for the create/edit form's category + scoping pickers. */
    options: withPermission(P.config.policyRead).query(async ({ ctx }) => {
      const [categories, jobLevels, legalEntities, businessUnits, currencyRows] = await Promise.all([
        ctx.db.expenseCategory.findMany({
          where: { active: true },
          select: { id: true, label: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        }),
        ctx.db.jobLevel.findMany({
          where: { active: true },
          select: { id: true, code: true, label: true, sortOrder: true },
          orderBy: { sortOrder: 'asc' },
        }),
        ctx.db.legalEntity.findMany({
          where: { active: true },
          select: { id: true, label: true },
          orderBy: { createdAt: 'asc' },
        }),
        ctx.db.businessUnit.findMany({
          where: { active: true },
          select: { id: true, label: true },
          orderBy: { createdAt: 'asc' },
        }),
        // VeloExpense: every currency row is usable (no `active` column), keyed by code.
        ctx.db.currency.findMany({
          select: { code: true },
          orderBy: { code: 'asc' },
        }),
      ]);
      // VeloExpense: ExpenseOS's `{ id, code, symbol }`, the code as the id (the value
      // `currencyId` carries here) and the symbol from the platform (`currencySymbol`).
      const currencies = currencyRows.map((c) => ({ id: c.code, code: c.code, symbol: currencySymbol(c.code) }));
      return { categories, jobLevels, legalEntities, businessUnits, currencies };
    }),
    create: perDiemWrite()
      .input(perDiemRatePatch)
      .mutation(async ({ ctx, input }) => {
        // VeloExpense: audited, as every other write in this router is.
        const row = await withAudit(
          ctx.db,
          {
            action: 'PER_DIEM_RATE_CREATED',
            entityType: 'PerDiemRate',
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: { country: input.country, city: input.city, categoryId: input.categoryId },
          },
          (tx) => tx.perDiemRate.create({ data: input }),
          (r) => r.id,
        );
        return { ...row, amountMinor: row.amountMinor.toString() };
      }),
    update: perDiemWrite()
      .input(z.object({ id: z.string().uuid(), patch: perDiemRatePatch.partial() }))
      .mutation(async ({ ctx, input }) => {
        const row = await withAudit(
          ctx.db,
          {
            action: 'PER_DIEM_RATE_UPDATED',
            entityType: 'PerDiemRate',
            entityId: input.id,
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: { changedFields: Object.keys(input.patch) },
          },
          (tx) => tx.perDiemRate.update({ where: { id: input.id }, data: input.patch }),
        );
        return { ...row, amountMinor: row.amountMinor.toString() };
      }),
    delete: perDiemWrite()
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        await withAudit(
          ctx.db,
          {
            action: 'PER_DIEM_RATE_DELETED',
            entityType: 'PerDiemRate',
            entityId: input.id,
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
          },
          (tx) => tx.perDiemRate.delete({ where: { id: input.id } }),
        );
        return { ok: true };
      }),
  }),

  // ── MileageRate ────────────────────────────────────────────────
  //
  // Rules are always enforced: there is no draft or disabled state. Creating a
  // rule SUPERSEDES whatever held the same scope, closing it in the same
  // transaction. The only other way to end a rule is `retire`, for a country you
  // have stopped operating in.
  mileageRate: router({
    list: withPermission(P.config.policyRead).query(async ({ ctx }) => {
      const rows = await ctx.db.mileageRate.findMany({
        orderBy: [{ country: 'asc' }, { effectiveFrom: 'desc' }],
        include: {
          tiers: { orderBy: { fromDistance: 'asc' } },
          subjects: {
            select: {
              userId: true,
              // VeloExpense: one display name, not firstName/lastName.
              user: { select: { name: true, email: true } },
            },
          },
        },
      });
      return rows.map((r) => ({
        ...r,
        tiers: r.tiers.map((t) => ({
          id: t.id,
          fromDistance: t.fromDistance.toString(),
          rateMinor: t.rateMinor.toString(),
        })),
        // VeloExpense: ExpenseOS's subject shape, the display name as `firstName`, so the
        // screen's `personName` reads it unchanged.
        subjects: r.subjects.map((sub) => ({
          userId: sub.userId,
          user: { firstName: sub.user.name, lastName: null, email: sub.user.email },
        })),
      }));
    }),

    /**
     * Create a rule, superseding whatever held the same scope.
     *
     * All of it in one transaction: the incumbent's `effectiveTo` is closed at
     * the new rule's start and its succession pointer set, so there is never a
     * moment with two rules in force for one scope, and never a gap either.
     */
    create: withPermission(P.config.mileageUpdate)
      .input(mileageRuleInput)
      .mutation(async ({ ctx, input }) => {
        assertTiersWellFormed(input.tiers);
        await assertMileageReferencesKnown(ctx.db, input); // VeloExpense: see the helper.
        const collisions = await findScopeCollisions(ctx.db, input);
        // A rule that starts before one it would supersede can't be slotted in —
        // that's a rewrite of history, not a rate change.
        const earlier = collisions.find((c) => c.effectiveFrom >= input.effectiveFrom);
        if (earlier) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'A rule for this scope already starts on or after that date. Supersede it with a later start instead.',
          });
        }

        return withAudit(
          ctx.db,
          {
            action: auditActions.config('mileageRate'),
            entityType: 'MileageRate',
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: {
              country: input.country,
              subjects: input.subjectUserIds.length,
              supersedes: collisions.map((c) => c.id),
            },
          },
          async (tx) => {
            const created = await tx.mileageRate.create({
              data: {
                country: input.country,
                unit: input.unit,
                effectiveFrom: input.effectiveFrom,
                glAccountId: input.glAccountId ?? null,
                createdBy: ctx.rbac.id,
                tiers: {
                  create: input.tiers.map((t) => ({
                    fromDistance: t.fromDistance,
                    rateMinor: BigInt(t.rateMinor),
                  })),
                },
                subjects: { create: input.subjectUserIds.map((userId) => ({ userId })) },
              },
              select: { id: true },
            });
            for (const c of collisions) {
              await tx.mileageRate.update({
                where: { id: c.id },
                data: { effectiveTo: input.effectiveFrom, supersededById: created.id },
              });
            }
            return created;
          },
          (created) => created.id,
        );
      }),

    /**
     * Retire a rule with no successor — the country is no longer operated in.
     * A claim there past the end date is then refused, which is the honest
     * answer, rather than priced at zero.
     */
    retire: withPermission(P.config.mileageUpdate)
      .input(z.object({ id: z.string().uuid(), effectiveTo: z.coerce.date() }))
      .mutation(async ({ ctx, input }) => {
        const rule = await ctx.db.mileageRate.findUnique({
          where: { id: input.id },
          select: { effectiveFrom: true, supersededById: true },
        });
        if (!rule) throw new TRPCError({ code: 'NOT_FOUND' });
        if (rule.supersededById) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This rule was already superseded; retire its successor instead.',
          });
        }
        if (input.effectiveTo < rule.effectiveFrom) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A rule cannot end before it starts.',
          });
        }
        return withAudit(
          ctx.db,
          {
            action: auditActions.config('mileageRate'),
            entityType: 'MileageRate',
            entityId: input.id,
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: { retiredAt: input.effectiveTo.toISOString() },
          },
          (tx) =>
            tx.mileageRate.update({
              where: { id: input.id },
              data: { effectiveTo: input.effectiveTo },
              select: { id: true },
            }),
        );
      }),

    /**
     * Delete a rule outright. Only a rule nothing has been priced under — once a
     * claim references it, the succession chain is the audit trail and deleting
     * it would strand that claim's `mileageRateId`.
     */
    delete: withPermission(P.config.mileageUpdate)
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const used = await ctx.db.expenseLineItem.count({ where: { mileageRateId: input.id } });
        if (used > 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `${used} expense line(s) were priced with this rule. Supersede or retire it instead.`,
          });
        }
        // VeloExpense: a rule that is not the tenant's (or no longer exists) is NOT_FOUND
        // rather than Prisma's 500, and the delete is audited — ExpenseOS deletes without
        // a row, so nobody could say who removed a rate.
        const rule = await ctx.db.mileageRate.findUnique({
          where: { id: input.id },
          select: { country: true, effectiveFrom: true, effectiveTo: true },
        });
        if (!rule) throw new TRPCError({ code: 'NOT_FOUND' });
        await withAudit(
          ctx.db,
          {
            action: 'MILEAGE_RATE_DELETED',
            entityType: 'MileageRate',
            entityId: input.id,
            actor: {
              kind: 'user',
              id: ctx.rbac.id,
              name: ctx.session.user.name ?? ctx.session.user.email,
              roleLabel: ctx.rbac.roleLabel,
            },
            details: {
              country: rule.country,
              effectiveFrom: rule.effectiveFrom.toISOString(),
              effectiveTo: rule.effectiveTo?.toISOString() ?? null,
            },
          },
          (tx) => tx.mileageRate.delete({ where: { id: input.id }, select: { id: true } }),
        );
        return { ok: true };
      }),
  }),

  // ── PolicyRule (v2 — admin-authored policy rule instances) ─────
  policyRule: router({
    /** The rule-kind registry + the predicate vocabulary the Rule Builder
     *  needs to render a condition editor. Static, but permission-gated so
     *  the shape isn't exposed to unauthenticated callers. */
    kinds: withPermission(P.config.policyRead).query(async ({ ctx }) => ({
      /**
       * The currency every money param is expressed in — the same
       * `policyCurrency` flag the evaluator compares against, defaulting to CAD.
       *
       * Sent because a bare "threshold" box is a trap: the value is stored in MINOR
       * units, so a well-meaning admin typing 1000 for "a thousand dollars" would
       * create a rule that fires at ten. The drawer takes major units and labels the
       * currency, and the conversion happens where the exponent is known.
       *
       * VeloExpense: the organization's `policy_currency_code` (0015, NOT NULL DEFAULT
       * 'CAD'), read in the tenant's transaction, rather than a `policyCurrency` system flag.
       */
      policyCurrency: await policyCurrencyOf(ctx.db),
      kinds: RULE_KIND_CODES.map((code) => {
        const k = RULE_KINDS[code]!;
        return {
          code: k.code,
          scope: k.scope,
          defaultSeverity: k.defaultSeverity,
          messageKey: k.messageKey,
          requiresCondition: Boolean(k.conditionSchema),
          // How to render this kind's editable params. Without it the drawer could
          // only ever post `params: {}`, which saves a valid but inert rule.
          paramsSpec: k.paramsSpec ?? [],
          paramsAtLeastOneOf: k.paramsAtLeastOneOf ?? [],
        };
      }),
      lineFields: LINE_FIELDS,
      reportFields: REPORT_FIELDS,
      ops: PREDICATE_OPS,
    })),

    /** Option lists for the Rule Builder's scoping pickers. */
    scopeOptions: withPermission(P.config.policyRead).query(async ({ ctx }) => {
      const [jobLevels, legalEntities, businessUnits, departments, categories] =
        await Promise.all([
          ctx.db.jobLevel.findMany({
            where: { active: true },
            select: { id: true, code: true, label: true },
            orderBy: { sortOrder: 'asc' },
          }),
          ctx.db.legalEntity.findMany({
            where: { active: true },
            select: { id: true, label: true },
            orderBy: { createdAt: 'asc' },
          }),
          ctx.db.businessUnit.findMany({
            where: { active: true },
            select: { id: true, label: true },
            orderBy: { createdAt: 'asc' },
          }),
          ctx.db.department.findMany({
            where: { active: true },
            select: { id: true, label: true },
            orderBy: { createdAt: 'asc' },
          }),
          ctx.db.expenseCategory.findMany({
            where: { active: true },
            select: { id: true, label: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          }),
        ]);
      // VeloExpense: no role table until the role builder (w4-10, d64), so no roles to
      // offer. The shape keeps ExpenseOS's `roles` so the Rule Builder ports unchanged.
      const roles: Array<{ id: string; label: string }> = [];
      return { jobLevels, legalEntities, businessUnits, departments, roles, categories };
    }),

    list: withPermission(P.config.policyRead).query(async ({ ctx }) => {
      const rows = await ctx.db.policyRule.findMany({
        orderBy: [{ enabled: 'desc' }, { scope: 'asc' }, { createdAt: 'desc' }],
      });
      return rows.map((r) => ({
        ...r,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
      }));
    }),

    create: policyRuleWrite()
      .input(policyRuleInput)
      .mutation(async ({ ctx, input }) => {
        const data = coerceRuleData(input);
        return withAudit(
          ctx.db,
          policyRuleAudit(ctx, policyRuleDetails('create', data)),
          (tx) => tx.policyRule.create({ data: { ...data, createdBy: ctx.rbac.id } }),
          (row) => row.id,
        );
      }),

    update: policyRuleWrite()
      .input(z.object({ id: z.string().uuid(), patch: policyRuleInput }))
      .mutation(async ({ ctx, input }) => {
        const data = coerceRuleData(input.patch);
        return withAudit(
          ctx.db,
          policyRuleAudit(ctx, policyRuleDetails('update', data), input.id),
          (tx) => tx.policyRule.update({ where: { id: input.id }, data }),
        );
      }),

    delete: policyRuleWrite()
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        await withAudit(
          ctx.db,
          policyRuleAudit(ctx, policyRuleDetails('delete', {}), input.id),
          (tx) => tx.policyRule.delete({ where: { id: input.id }, select: { id: true } }),
        );
        return { ok: true };
      }),
  }),
});

interface PolicyRuleAuditCtx {
  rbac: { id: string; roleLabel: string };
  session: { user: { name?: string | null; email: string } };
}

/**
 * The audit envelope for a policy-rule write: one action for the whole registry
 * (`config.policyRule`) with the operation in `details.op`.
 *
 * VeloExpense: ExpenseOS's `writePolicyRuleAudit` runs `withAudit` with an empty body
 * AFTER the write, so a failed audit leaves an unaudited rule. Here the envelope is
 * handed to `withAudit` around the write itself, in one transaction. The violation
 * entity type arrives with `resolveViolation` (w4-02d).
 */
function policyRuleAudit(ctx: PolicyRuleAuditCtx, details: Record<string, unknown>, entityId?: string) {
  return {
    action: auditActions.config('policyRule'),
    entityType: 'PolicyRule',
    ...(entityId ? { entityId } : {}),
    actor: {
      kind: 'user' as const,
      id: ctx.rbac.id,
      name: ctx.session.user.name ?? ctx.session.user.email,
      roleLabel: ctx.rbac.roleLabel,
    },
    details,
  };
}
