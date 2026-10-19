/**
 * Travel requests — draft → an estimate the traveller composes → approval → a trip.
 *
 * WHAT THIS IS FOR. An employee asking a manager for permission to travel, with a
 * number attached. It is an estimate, not an accounting document: no re-pricing, no
 * price tracking, no cost allocation. Those belong to the expense report the trip
 * later becomes.
 *
 * That framing is why the budget is COMPOSED rather than built. The module used to
 * generate a per-diem line for every category with a rate at the destination, on
 * create, on every edit, and again inside the submit transaction. It no longer does
 * anything of the kind. A traveller adds the lines their trip actually has, each one
 * priced when it is added, and a figure they typed survives permanently.
 *
 * The server is still the only thing that decides a derived number. A client may
 * propose an amount, and it lands as `MANUAL` — labelled as somebody's typed figure. It
 * can never arrive wearing `PER_DIEM`, `POLICY_CAP` or `QUOTE`, which is what the
 * prototype in archive/ allowed when it let the form post its own total.
 *
 * Approval is the engine's job, not this router's: a travel request is an
 * `ApprovalSubjectType` like any other, so routing, self-approval blocking, delegation,
 * escalation and TTL expiry all come for free.
 */

import { pickPerDiemRate } from '@expenseos/approvals';
import { canDecide, decideTask, startInstance } from '@expenseos/approvals/engine';
import { auditActions, withAudit } from '@expenseos/audit';
import type { Prisma } from '@expenseos/db';
// VeloExpense (w6-01): the line kind and price basis are text under CHECKs (0077), not Prisma
// enums; the policy layer names the two unions (server/policy/types.ts).
import type { TravelLineKind, TravelPriceBasis } from '@/server/policy/types';
// VeloExpense (w6-01): every query runs inside the request's tenant transaction, so the
// client handed around is `TenantDb` where ExpenseOS's is `PrismaClient`.
import type { TenantDb } from '@/lib/db/prisma';
import { convertMoney, fxRateMapFrom } from '@expenseos/money';
// VeloExpense (w6-01): ExpenseOS's `@expenseos/notifications` is VeloExpense's notification
// service (lib/notifications/service.ts), which records on a QueryRunner.
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import type { EventType } from '@/lib/notifications/catalog';
import {
  notifyRecipients as notifyServiceRecipients,
  recordActivity as recordServiceActivity,
} from '@/lib/notifications/service';
import { subjectPayload } from '@/server/lib/subjectPayload';
import { permissions as P } from '@expenseos/rbac';
import {
  derivedAmountMinor,
  parseTravelLinePayload,
  TRAVEL_CLASS_NAMES,
} from '@expenseos/travel-lines';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { taskRecipientIds } from '@/server/approvals/notify';
import { resolveDecideAccess } from '@/server/lib/decideAccess';
import {
  buildHomeRollup,
  type CurrencyGroup,
  homeConverterFor,
  readerCurrencyCode,
} from '@/server/lib/readerCurrency';
import { currencySymbol } from '@/server/lib/currencySymbol';
import { perDiemForCategory } from '@/server/lib/travelBudget';
import { TRAVEL_CATEGORY_CODES } from '@/server/lib/travelCategoryCodes';
// Aliased: the procedures below are also called `searchFlightOptions` /
// `searchStayOptions`, and a property whose value calls an identifier of the same name
// reads as recursion to anyone skimming.
import {
  searchFlightOptions as findFlightOptions,
  searchStayOptions as findStayOptions,
} from '@/server/lib/travelOptions';
import {
  type CachedCandidate,
  clearCandidates,
  getCandidate,
} from '@/server/lib/travelOptionsCache';
import { buildReportFromTravel } from '@/server/lib/travelToReport';
import { travelVariance } from '@/server/lib/travelVariance';
import { executeWorkflowEffects } from '@/server/lib/workflowEffects';
import { getMapsConfig, searchCities } from '@/server/platform/googleMaps';
import { getSerpApiConfig } from '@/server/platform/serpapi';
import { validateTravelRequest } from '@/server/policy/validateTravel';
import {
  withPermission as basePermission,
  protectedProcedure as baseProcedure,
  moduleActive,
  router,
} from '@/server/trpc';

// Every procedure is gated on the travel module being active — the server-side
// companion to the sidebar's module gate. Shadowing the two bases applies it to
// every procedure, present and future.
const travelGate = moduleActive('travel');
const protectedProcedure = baseProcedure.use(travelGate);
const withPermission = (permission: Parameters<typeof basePermission>[0]) =>
  basePermission(permission).use(travelGate);

type Ctx = {
  rbac: { id: string; roleLabel: string; permissions: readonly string[] };
  session: { user: { name?: string | null; email?: string | null } };
};

/** The engine stores the message KEY; the FE assembles the sentence in the reader's
 *  locale from it plus `data`. Same fallback the expense router uses, and for the same
 *  reason: a violation read by a traveller AND an approver who need not share a language
 *  cannot be pre-localized when the rule fires. */
const fallbackTranslator = (key: string) => key;

function actorOf(ctx: Ctx) {
  return {
    kind: 'user' as const,
    id: ctx.rbac.id,
    name: ctx.session.user.name || ctx.session.user.email || ctx.rbac.id,
    roleLabel: ctx.rbac.roleLabel,
  };
}

/**
 * `satisfies` rather than a bare `as const`, and it is load-bearing.
 *
 * A select assigned to a VARIABLE skips TypeScript's excess-property check, so a
 * field the model does not have compiles cleanly and throws at runtime instead —
 * which is exactly what `category: { name }` did here (the column is `label`).
 * `satisfies` restores the check while keeping the literal types the row inference
 * needs.
 */
const REQUEST_SELECT = {
  id: true,
  number: true,
  submitterId: true,
  purpose: true,
  notes: true,
  destinationLabel: true,
  destinationCity: true,
  destinationCountry: true,
  destinationAirports: true,
  destinationAirport: true,
  originLabel: true,
  originCity: true,
  originCountry: true,
  originAirport: true,
  tripType: true,
  departDate: true,
  returnDate: true,
  includeCar: true,
  status: true,
  approvalInstanceId: true,
  submittedAt: true,
  approvedAt: true,
  approvedTotalMinor: true,
  currencyId: true,
  // VeloExpense (w6-01): the shared `currency` table has no symbol column; the screens take
  // it from the code (`currencySymbol`), as the expense screens do.
  currency: { select: { code: true } },
  createdAt: true,
  submitter: { select: { id: true, firstName: true, lastName: true, email: true } },
  /**
   * Policy violations on this estimate, so the drawer can show them beside the line
   * that caused them without a second round-trip.
   *
   * `message` holds the message KEY, not a sentence — the FE assembles it in the
   * READER's locale from `data`, because a traveller and their approver need not share
   * a language and money formatting is locale-dependent for the same reason.
   */
  policyViolations: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      travelLineId: true,
      ruleCode: true,
      severity: true,
      message: true,
      data: true,
      resolveNote: true,
      resolvedAt: true,
    },
  },
  budgetLines: {
    // The itinerary order, then creation as the tie-break. Lines carry the order now,
    // so reading them by `createdAt` alone would render a reordered trip in the order
    // it was typed.
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      categoryId: true,
      glAccountId: true,
      amountMinor: true,
      basis: true,
      confidence: true,
      notes: true,
      derivedAmountMinor: true,
      kind: true,
      payload: true,
      sortOrder: true,
      category: { select: { id: true, label: true, icon: true, color: true, lineKind: true } },
    },
  },
} satisfies Prisma.TravelRequestSelect;

/**
 * VeloExpense (w6-01): ExpenseOS's activity calls, on VeloExpense's notification service —
 * the shape `server/lib/reportNotify.ts` gives the report router:
 *   · AWAITED, on the request's own tenant transaction, where ExpenseOS fires and forgets
 *     after the commit; the outbox delivers. Still best-effort: each fan-out runs under a
 *     savepoint, and a failure rolls back to it and is logged, so a downed notifier never
 *     undoes the submit or the decision it follows;
 *   · VeloExpense's events: there is no SUBMITTED (NT-15) — a submit tells the first
 *     approvers TASK_ASSIGNED, as a report's does;
 *   · every activity carries the request's placeholders (`subjectPayload`: number,
 *     destination, total), which the travel templates read.
 */
async function recordTravelActivity(
  db: TenantDb,
  entry: { subjectId: string; type: EventType; actorId: string },
): Promise<{ id: string }> {
  const id = await recordServiceActivity(queryRunnerOf(db), {
    subjectType: 'TRAVEL_REQUEST',
    subjectId: entry.subjectId,
    eventType: entry.type,
    actorId: entry.actorId,
    payload: await subjectPayload(db, 'TRAVEL_REQUEST', entry.subjectId),
  });
  return { id };
}

async function notifyRecipients(db: TenantDb, activityId: string, recipients: string[]) {
  await notifyServiceRecipients(queryRunnerOf(db), activityId, recipients);
}

async function bestEffort(db: TenantDb, label: string, fn: () => Promise<void>): Promise<void> {
  await db.$executeRaw`SAVEPOINT travel_notify`;
  try {
    await fn();
    await db.$executeRaw`RELEASE SAVEPOINT travel_notify`;
  } catch (e) {
    await db.$executeRaw`ROLLBACK TO SAVEPOINT travel_notify`;
    console.warn(`[travel] ${label} activity failed`, e);
  }
}

/** A request is editable by its submitter while it has not been submitted, or after
 *  it came back. Once an approver holds it, edits go through them. */
const EDITABLE = new Set(['DRAFT', 'RETURNED']);

/** $1,000,000.00 in minor units — the fat-finger ceiling on a single line.
 *  Not a policy limit: policy lives in the approval tiers, which is where a total
 *  this large is supposed to be argued about. */
const MAX_LINE_MINOR = 100_000_000n;

const placeInput = z.object({
  placeId: z.string().trim().max(400).nullish(),
  label: z.string().trim().min(1).max(300),
  city: z.string().trim().max(200).nullish(),
  country: z.string().trim().max(200).nullish(),
  /** Set only when the traveller pinned a specific airport over the metro. */
  airport: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'An IATA code is three uppercase letters.')
    .nullish(),
});

/**
 * The trip fields, declared WITHOUT defaults.
 *
 * Defaults live on `tripInput` (create) only, and deliberately not on
 * `tripPatchInput` (update). `z.object({...}).partial()` does NOT strip a `.default()`
 * — it only makes the key optional, and the default still fills in when the key is
 * absent. Deriving the update schema from a defaulted base therefore made every
 * partial edit send values the client never typed:
 *
 *   · `tripType` always arrived as ROUND_TRIP, so editing a ONE_WAY trip's purpose
 *     failed outright with "A round trip needs a return date."
 *   · `includeCar` always arrived as `false`, and the handler's
 *     `input.includeCar !== undefined` guard was therefore always true — so editing
 *     any field silently dropped the rental car from the budget.
 *
 * Two schemas off one field set is the fix; do not re-add defaults to the patch shape.
 */
const tripFields = {
  purpose: z.string().trim().min(3).max(2000),
  notes: z.string().trim().max(4000).nullish(),
  destination: placeInput,
  /**
   * Required, and deliberately not defaulted.
   *
   * Defaulting to the traveller's legal-entity city would price more trips without
   * anyone typing — and would quietly assume everybody flies from the city their
   * entity is registered in, which is wrong for every remote employee and produces a
   * confidently incorrect fare rather than a missing one. Blank and required makes
   * the traveller state it.
   */
  origin: placeInput,
  tripType: z.enum(['ROUND_TRIP', 'ONE_WAY', 'MULTI_CITY']),
  departDate: z.string().datetime(),
  returnDate: z.string().datetime().nullish(),
  includeCar: z.boolean(),
  // VeloExpense (w6-01): a currency is keyed by its ISO code (`currency_code`).
  currencyId: z.string().regex(/^[A-Z]{3}$/),
} as const;

/** Create: a whole trip, with the two conveniences defaulted. */
const tripInput = z.object(tripFields).extend({
  tripType: tripFields.tripType.default('ROUND_TRIP'),
  includeCar: tripFields.includeCar.default(false),
});

/** Update: every field optional and NOTHING defaulted — absent means "leave it". */
const tripPatchInput = z.object(tripFields).partial();

/**
 * Reject a trip whose dates cannot be flown before anything is priced.
 *
 * A round trip with no return, or a return before departure, would otherwise reach
 * `tripDays` — which degrades to a single day rather than throwing, correct for
 * budgeting but wrong as an answer to "is this request coherent".
 */
function assertDates(tripType: string, departDate: Date, returnDate: Date | null) {
  if (Number.isNaN(departDate.getTime())) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Departure date is not a date.' });
  }
  if (tripType === 'ROUND_TRIP' && !returnDate) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A round trip needs a return date.' });
  }
  if (returnDate && returnDate < departDate) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The return date is before the departure date.',
    });
  }
}

/**
 * The rate table, the FX table and the currency list, loaded once.
 *
 * Split out of `pricingContext` so the CREATE drawer can be answered too: it prices a
 * line that has no request yet, so there is no row to read the destination and the dates
 * off — they arrive as input instead. Everything else is the same three reads, and the
 * conversion into a target currency is the same closure, parameterised on the code.
 */
async function pricingTables(db: TenantDb) {
  const [rates, fxRows, currencies] = await Promise.all([
    db.perDiemRate.findMany({
      select: {
        city: true,
        categoryId: true,
        amountMinor: true,
        firstLastDay: true,
        effectiveFrom: true,
        effectiveTo: true,
        jobLevelId: true,
        legalEntityId: true,
        businessUnitId: true,
        currencyId: true,
      },
    }),
    db.fxRate.findMany({ orderBy: { fetchedAt: 'desc' } }),
    // VeloExpense (w6-01): a currency's id IS its ISO code, so the map is code → code.
    db.currency.findMany({ select: { code: true } }),
  ]);
  const fx = fxRateMapFrom(fxRows);
  const codeById = new Map(currencies.map((c) => [c.code, c.code]));

  const converterTo =
    (to: string) =>
    (amountMinor: bigint, currencyId: string | null): bigint => {
      // A rate with no currency is quoted in the org policy currency, which is what the
      // request defaults to; treat it as already converted rather than dropping the
      // allowance, which would silently under-budget the trip.
      const from = currencyId ? codeById.get(currencyId) : null;
      if (!from || from === to) return amountMinor;
      const converted = convertMoney({ amountMinor, currencyCode: from }, to, fx);
      // A missing rate falls back to the raw figure rather than to zero. Under-budgeting
      // by the whole line is worse than under-budgeting by the spread.
      return converted ? converted.amountMinor : amountMinor;
    };

  return { rates, codeById, converterTo };
}

/**
 * Everything needed to price ONE line, loaded once.
 *
 * A single read for the request, the rates, the FX table and the currencies, because
 * every line-writing path needs the same four and doing them per-line would turn
 * adding five lines into twenty queries.
 */
async function pricingContext(db: TenantDb, requestId: string) {
  const req = await tripRow(db, requestId);
  const { rates, converterTo } = await pricingTables(db);
  return { req, rates, toRequestMinor: converterTo(req.currency.code) };
}

/** The facts of a saved trip that pricing reads: where, when, whose tier, which currency.
 *  `submitterId` rides along for the one caller that has to check ownership. */
function tripRow(db: TenantDb, requestId: string) {
  return db.travelRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: {
      submitterId: true,
      destinationCity: true,
      departDate: true,
      returnDate: true,
      currency: { select: { code: true } },
      submitter: { select: { jobLevelId: true, legalEntityId: true, businessUnitId: true } },
    },
  });
}

/**
 * The allowance a category resolves to on a trip, or null — the read behind
 * `previewLine` and `perDiemRate`.
 *
 * One function so the two queries cannot disagree with each other or with `priceLine`
 * about where the trip's facts come from. With a `requestId` they are the saved request's,
 * and the request has to be the caller's own: this reads nothing an owner could not see on
 * their own drawer, but a lookup keyed on any id in the org would tell a stranger where
 * somebody is going and when. Without one they are the caller's — their tier row, and the
 * destination, dates and currency they have typed into a form that has not been saved.
 */
async function previewAllowance(
  ctx: { db: TenantDb; rbac: { id: string } },
  input: {
    categoryId: string;
    requestId?: string | null;
    destinationCity?: string | null;
    departDate?: string | null;
    returnDate?: string | null;
    currencyId?: string | null;
  },
) {
  const category = await lineCategory(ctx.db, input.categoryId);
  if (!category?.active || !category.expenseCategoryId) return null;

  let trip: {
    destinationCity: string | null;
    departDate: Date;
    returnDate: Date | null;
    tier: {
      jobLevelId: string | null;
      legalEntityId: string | null;
      businessUnitId: string | null;
    };
    currencyCode: string | null;
  };
  let tables: Awaited<ReturnType<typeof pricingTables>>;

  if (input.requestId) {
    const [req, loadedTables] = await Promise.all([
      tripRow(ctx.db, input.requestId).catch(() => null),
      pricingTables(ctx.db),
    ]);
    if (!req || req.submitterId !== ctx.rbac.id) throw new TRPCError({ code: 'NOT_FOUND' });
    tables = loadedTables;
    trip = {
      destinationCity: req.destinationCity,
      departDate: req.departDate,
      returnDate: req.returnDate,
      tier: req.submitter,
      currencyCode: req.currency.code,
    };
  } else {
    if (!input.departDate) return null;
    const departDate = new Date(input.departDate);
    if (Number.isNaN(departDate.getTime())) return null;
    const [traveller, loadedTables] = await Promise.all([
      ctx.db.user.findUnique({
        where: { id: ctx.rbac.id },
        select: { jobLevelId: true, legalEntityId: true, businessUnitId: true },
      }),
      pricingTables(ctx.db),
    ]);
    tables = loadedTables;
    trip = {
      destinationCity: input.destinationCity?.trim() || null,
      departDate,
      returnDate: input.returnDate ? new Date(input.returnDate) : null,
      // A caller with no user row has no tier; the wildcard rates still apply to them,
      // which is what an empty tier resolves to.
      tier: traveller ?? { jobLevelId: null, legalEntityId: null, businessUnitId: null },
      // An unknown currency prices nothing rather than pricing in the wrong one: the
      // write will still derive the figure in the request's real currency on save.
      currencyCode: input.currencyId ? (tables.codeById.get(input.currencyId) ?? null) : null,
    };
  }
  if (!trip.currencyCode) return null;

  const allowance = perDiemForCategory(
    {
      destinationCity: trip.destinationCity,
      departDate: trip.departDate,
      returnDate: trip.returnDate,
      tier: trip.tier,
      rates: tables.rates,
      expenseCategoryId: category.expenseCategoryId,
    },
    tables.converterTo(trip.currencyCode),
  );
  return allowance ? { ...allowance, city: trip.destinationCity } : null;
}

/** The travel category a line is being written for, with everything the write needs
 *  stamped off it: the block, the GL account, and the expense category its allowance
 *  is looked up under. */
async function lineCategory(db: TenantDb, categoryId: string) {
  const category = await db.travelCategory.findUnique({
    where: { id: categoryId },
    select: {
      id: true,
      active: true,
      lineKind: true,
      glAccountId: true,
      expenseCategoryId: true,
      // The fallback account: a mapped travel category declares its GL in one place,
      // on the expense category, rather than two that can disagree.
      expenseCategory: { select: { glAccountId: true } },
    },
  });
  // VeloExpense (w6-01): `line_kind` is text under a CHECK (0077) holding exactly
  // ExpenseOS's TravelLineKind values, so it is read as that union.
  return category ? { ...category, lineKind: category.lineKind as TravelLineKind } : null;
}

type LineCategory = NonNullable<Awaited<ReturnType<typeof lineCategory>>>;

/**
 * What a line will actually be stored as.
 *
 * No `notes`. It used to be called `detail` and to carry a server-composed sentence
 * explaining the figure; that is now the TRAVELLER's field — free text a policy rule can
 * require, and the business purpose of the expense the line eventually becomes. The
 * explanation did not disappear; it moved into the payload as FACTS and is composed at
 * render, in the reader's locale rather than in English.
 *
 * `derivedAmountMinor` IS here, because only this function knows it: it is what the
 * policy would have produced for a line the traveller then priced themselves.
 */
interface PricedLine {
  amountMinor: bigint;
  basis: TravelPriceBasis;
  payload: Prisma.InputJsonValue | undefined;
  /** Set only when a typed figure REPLACED a derivation. Absent otherwise. */
  derivedAmountMinor?: bigint;
}

/** The four payload fields only the server may set. See `priceLine`. */
const DERIVED_PER_DIEM_KEYS = [
  'perDiemDays',
  'perDiemCity',
  'perDiemDailyMinor',
  'perDiemEdgeHalved',
] as const;

/** A posted payload with the server-only per-diem fields removed. Only STANDARD has
 *  them, so every other kind passes through untouched. */
function stripDerivedPerDiem(kind: TravelLineKind, payload: unknown): unknown {
  if (kind !== 'STANDARD' || payload == null || typeof payload !== 'object') return payload;
  const out = { ...(payload as Record<string, unknown>) };
  for (const key of DERIVED_PER_DIEM_KEYS) delete out[key];
  return out;
}

/**
 * Price one line, from its payload and its category, server-side.
 *
 * The whole basis ladder lives here, in one place, because "where did this number come
 * from" is the question an approver is entitled to have answered and three callers
 * answering it differently is how a policy cap ends up labelled as a market price:
 *
 *   · an amount the CLIENT supplied            → MANUAL, and it wins outright
 *   · a figure the payload implies             → POLICY_CAP (a daily cap × days) or
 *                                                PER_DIEM (an allowance per head)
 *   · a STANDARD line with an allowance        → PER_DIEM
 *   · nothing derivable                        → MANUAL at zero, for the traveller to fill
 *
 * `QUOTE` is not reachable from here on purpose. A quoted number comes from a stored
 * `TravelQuote`, written by the provider path, and nothing a client posts may wear it.
 */
async function priceLine(
  db: TenantDb,
  requestId: string,
  category: LineCategory,
  payload: unknown,
  clientAmountMinor: bigint | null,
): Promise<PricedLine> {
  /**
   * The client's payload, with any per-diem derivation STRIPPED.
   *
   * Those four fields describe a calculation the server performed. A client posting them
   * would be asserting an allowance was applied when it was not — the same forgery the
   * `basis` ladder exists to prevent, one level down. They are re-added below, on the one
   * path that actually computed them.
   */
  const posted = stripDerivedPerDiem(category.lineKind, payload ?? {});
  const validated = parseTravelLinePayload(category.lineKind, posted) as
    | Prisma.InputJsonValue
    | undefined;

  // Derivable from the payload alone — a cap × days, or heads × occurrences × days.
  const derived = derivedAmountMinor(category.lineKind, validated ?? {});
  if (derived != null) {
    const basis: TravelPriceBasis =
      category.lineKind === 'DEPARTMENT_MEAL' ? 'PER_DIEM' : 'POLICY_CAP';
    /**
     * A typed figure takes precedence, permanently — that is the whole of "a manual edit
     * wins": there is no re-price to undo it, and restoring the allowance means adding a
     * fresh line and deleting this one.
     *
     * The derivation is computed FIRST now, even when it is about to be discarded,
     * because it is the only moment it exists. Returning early on the manual branch —
     * which is what this did — threw away the figure the traveller was overriding, and
     * left an approver unable to tell a raised allowance from a number typed into an
     * empty line (GA-6).
     */
    if (clientAmountMinor != null) {
      return {
        amountMinor: clientAmountMinor,
        basis: 'MANUAL',
        payload: validated,
        derivedAmountMinor: derived,
      };
    }
    return { amountMinor: derived, basis, payload: validated };
  }
  // Nothing derivable from the payload, but a typed figure still wins outright. The
  // per-diem lookup below is skipped: it is a database round trip whose only purpose
  // would be to compute a number this line is not going to use.
  if (clientAmountMinor != null && !category.expenseCategoryId) {
    return { amountMinor: clientAmountMinor, basis: 'MANUAL', payload: validated };
  }

  // Otherwise the allowance for the mapped expense category, which is what makes
  // picking "Meals" fill its own amount in.
  if (category.expenseCategoryId) {
    const { req, rates, toRequestMinor } = await pricingContext(db, requestId);
    const allowance = perDiemForCategory(
      {
        destinationCity: req.destinationCity,
        departDate: req.departDate,
        returnDate: req.returnDate,
        tier: {
          jobLevelId: req.submitter.jobLevelId,
          legalEntityId: req.submitter.legalEntityId,
          businessUnitId: req.submitter.businessUnitId,
        },
        rates,
        expenseCategoryId: category.expenseCategoryId,
      },
      toRequestMinor,
    );
    if (allowance) {
      // The case the audit actually hit: a per-diem line whose derived figure a
      // traveller raised. The allowance is what they overrode, so it is what is kept.
      if (clientAmountMinor != null) {
        return {
          amountMinor: clientAmountMinor,
          basis: 'MANUAL',
          payload: validated,
          derivedAmountMinor: allowance.amountMinor,
        };
      }
      return {
        amountMinor: allowance.amountMinor,
        basis: 'PER_DIEM',
        // The derivation, as data. Re-parsed rather than spread onto `validated`, so the
        // registry is still the thing that decides what a payload may contain.
        payload: parseTravelLinePayload(category.lineKind, {
          ...(posted as Record<string, unknown>),
          perDiemDays: allowance.days,
          perDiemCity: req.destinationCity ?? null,
          perDiemDailyMinor: allowance.dailyRateMinor.toString(),
          perDiemEdgeHalved: allowance.edgeDaysHalved,
        }) as Prisma.InputJsonValue,
      };
    }
  }

  // Nothing could price it. Zero and MANUAL, so the line exists and visibly wants a
  // number — refusing the add would leave the traveller with no way to record a cost
  // the org has no rate for, which is the situation planned items existed for.
  //
  // A typed figure here is NOT an override: there was no derivation to replace, so
  // `derivedAmountMinor` stays null and the approver is told nothing that is not true.
  if (clientAmountMinor != null) {
    return { amountMinor: clientAmountMinor, basis: 'MANUAL', payload: validated };
  }
  return { amountMinor: 0n, basis: 'MANUAL', payload: validated };
}

/** The GL account a line stamps: the travel category's own, else the mapped expense
 *  category's. Snapshotted, never resolved at read time — a category an admin
 *  re-points must not restate an estimate somebody already approved. */
function stampedGlAccountId(category: LineCategory): string | null {
  return category.glAccountId ?? category.expenseCategory?.glAccountId ?? null;
}

/**
 * The currency conversions the option pickers need, loaded once.
 *
 * Three directions, because three different callers hold three different handles on a
 * currency and pretending one function serves all of them is how a code got passed where
 * an id was expected:
 *
 *   · `toRequestMinor(minor, code)`             — a provider quotes in a CODE
 *   · `toRequestMinorByCurrencyId(minor, id)`   — a stored row carries an ID
 *   · `toMajor(minor)`                          — the provider's `maxPrice` is major units
 */
async function quoteCurrencyContext(db: TenantDb, requestId: string) {
  const [req, fxRows, currencies] = await Promise.all([
    db.travelRequest.findUniqueOrThrow({
      where: { id: requestId },
      // VeloExpense (w6-01): ExpenseOS's `precision` is VeloExpense's `minorUnit`.
      select: { currencyId: true, currency: { select: { code: true, minorUnit: true } } },
    }),
    db.fxRate.findMany({ orderBy: { fetchedAt: 'desc' } }),
    // VeloExpense (w6-01): a currency's id IS its ISO code.
    db.currency.findMany({ select: { code: true } }),
  ]);
  const fx = fxRateMapFrom(fxRows);
  const idByCode = new Map(currencies.map((c) => [c.code, c.code]));
  const codeById = new Map(currencies.map((c) => [c.code, c.code]));
  const to = req.currency.code;

  const toRequestMinor = (amountMinor: bigint, fromCode: string): bigint => {
    const from = fromCode.toUpperCase();
    if (from === to) return amountMinor;
    const converted = convertMoney({ amountMinor, currencyCode: from }, to, fx);
    if (!converted) {
      // The raw figure rather than zero, and it says so: under-budgeting by the spread
      // beats under-budgeting by a whole airfare, and a missing rate is a configuration
      // gap rather than a travel problem.
      console.warn(`[travel] no FX rate ${from}->${to}; using the unconverted figure`);
      return amountMinor;
    }
    return converted.amountMinor;
  };

  return {
    to,
    toRequestMinor,
    toRequestMinorByCurrencyId: (amountMinor: bigint, currencyId: string | null) => {
      const from = currencyId ? codeById.get(currencyId) : null;
      return from ? toRequestMinor(amountMinor, from) : amountMinor;
    },
    /** An unknown code stores under the request's currency — a reference-data gap is not
     *  a reason to lose the evidence, and mislabelling it is not how to report one. */
    currencyIdOf: (code: string) => idByCode.get(code.toUpperCase()) ?? req.currencyId,
    /** Minor → major at the REQUEST currency's exponent. JPY has none, so dividing by a
     *  hardcoded 100 would offer the provider a cap a hundred times too small. */
    toMajor: (amountMinor: bigint) => Number(amountMinor) / 10 ** (req.currency.minorUnit ?? 2),
  };
}

/**
 * The per-night lodging allowance at the request's destination, in its currency.
 *
 * Read for the DEPARTURE day rather than summed across the trip: what a nightly rate is
 * compared against is a nightly ceiling, and a total would compare one night's price
 * against a week's allowance. Wildcard tier — the tightest reading of policy is the
 * right one to filter or warn against.
 */
async function lodgingCapMinor(db: TenantDb, requestId: string): Promise<bigint | null> {
  const req = await db.travelRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { destinationCity: true, departDate: true },
  });
  if (!req.destinationCity) return null;

  // VeloExpense (w6-01): `code` is unique within the tenant, and RLS scopes this read to it.
  const category = await db.travelCategory.findFirst({
    where: { code: TRAVEL_CATEGORY_CODES.lodging },
    select: { expenseCategoryId: true },
  });
  if (!category?.expenseCategoryId) return null;

  const rates = await db.perDiemRate.findMany({
    where: { categoryId: category.expenseCategoryId },
    select: {
      city: true,
      categoryId: true,
      amountMinor: true,
      firstLastDay: true,
      effectiveFrom: true,
      effectiveTo: true,
      jobLevelId: true,
      legalEntityId: true,
      businessUnitId: true,
      currencyId: true,
    },
  });
  const rate = pickPerDiemRate(rates, {
    placeText: req.destinationCity,
    date: req.departDate,
    categoryId: category.expenseCategoryId,
    jobLevelId: null,
    legalEntityId: null,
    businessUnitId: null,
  });
  if (!rate) return null;
  const money = await quoteCurrencyContext(db, requestId);
  return money.toRequestMinorByCurrencyId(rate.amountMinor, rate.currencyId);
}

/**
 * The line payload for a chosen option.
 *
 * Built from the STORED candidate — its `option` half for what was chosen, its `search`
 * half for the cabin, trip shape and dates that were asked for. Neither comes from the
 * client, which is the point of storing candidates at all.
 *
 * Validated through the kind registry before it is written, so a build that drifts from
 * the schema fails here rather than leaving a line whose block cannot read it.
 *
 * `notes` is a human sentence read back years later beside the figure it explains,
 * which is why it is not translated — it would otherwise render in whoever is LOOKING's
 * language rather than the one it was approved in.
 */
function buildChosenPayload(
  kind: TravelLineKind,
  candidate: CachedCandidate,
): { payload: Prisma.InputJsonValue } {
  const option = candidate.option ?? {};
  const search = candidate.search ?? {};

  if (kind === 'AIRFARE') {
    const legs = Array.isArray(option.legs) ? (option.legs as Record<string, unknown>[]) : [];
    const payload = parseTravelLinePayload('AIRFARE', {
      fromId: search.fromId ?? null,
      fromLabel: String(search.fromLabel ?? legs[0]?.from ?? '—'),
      toId: search.toId ?? null,
      toLabel: String(search.toLabel ?? legs[legs.length - 1]?.to ?? '—'),
      tripType: search.tripType ?? 'ONE_WAY',
      travelClass: search.travelClass ?? 'ECONOMY',
      maxStops: search.maxStops ?? null,
      outboundDate: String(search.outboundDate ?? ''),
      returnDate: search.returnDate ?? null,
      legs,
      bookingToken: option.bookingToken ?? null,
      pricedAt: search.pricedAt ?? null,
      // What the airline quoted, before FX. The one thing the dropped `TravelQuote` row
      // held that the line did not, so it moves here rather than being lost.
      providerAmountMinor: candidate.providerAmountMinor,
      providerCurrency: candidate.providerCurrency,
    }) as Prisma.InputJsonValue;

    /**
     * No summary composed here any more, and this is the case the change was really for.
     *
     * Picking a flight used to overwrite the line's notes with "YUL→LHR · AC 412".
     * That is now the traveller's field — the place they say WHY this fare and not the
     * cheaper one on the other carrier, which is exactly the question an approver has —
     * and a picker silently replacing their sentence with a route summary would delete
     * the answer. The route, the flight numbers and the airline are all in the payload;
     * the summary composes at render.
     */
    return { payload };
  }

  const nights = typeof search.nights === 'number' ? search.nights : 0;
  const name = typeof option.name === 'string' ? option.name : null;
  const payload = parseTravelLinePayload('LODGING', {
    city: search.city ?? null,
    checkIn: String(search.checkIn ?? ''),
    checkOut: String(search.checkOut ?? ''),
    nights,
    propertyName: name,
    propertyToken: option.propertyToken ?? null,
    nightlyMinor: option.nightlyMinor ?? null,
    rating: option.rating ?? null,
    starClass: option.starClass ?? null,
    capPerNightMinor: search.capPerNightMinor ?? null,
    providerAmountMinor: candidate.providerAmountMinor,
    providerCurrency: candidate.providerCurrency,
  }) as Prisma.InputJsonValue;

  return { payload };
}

/**
 * The request a line mutation is about to touch, or a refusal.
 *
 * Three checks, all four line mutations need all three, and one of them is easy to
 * forget: EXISTS, belongs to the CALLER, and is still EDITABLE. Factored out because a
 * mutation that skipped the ownership check would be an endpoint for editing anyone's
 * estimate, and that is not the kind of thing to re-type four times.
 */
async function editableRequest(
  ctx: { db: TenantDb; rbac: { id: string } },
  id: string,
): Promise<{ id: string }> {
  const req = await ctx.db.travelRequest.findUnique({
    where: { id },
    select: { id: true, submitterId: true, status: true },
  });
  if (!req) throw new TRPCError({ code: 'NOT_FOUND' });
  if (req.submitterId !== ctx.rbac.id) throw new TRPCError({ code: 'FORBIDDEN' });
  if (!EDITABLE.has(req.status)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A submitted request can no longer be edited.',
    });
  }
  return { id: req.id };
}

/** Next position in the itinerary. Lines carry the order now, so a new one goes at the
 *  end rather than wherever `createdAt` happens to sort it. */
/** One planned budget line, as the client describes it. Shared by `create` and `addLine`. */
const budgetLineInput = z.object({
  categoryId: z.string().uuid(),
  /**
   * An explicit amount, when the traveller is typing one rather than accepting what the
   * category derives.
   *
   * Positive and bounded. Zero is not an estimate, and a negative one would silently
   * reduce the total an approver is being asked to authorise — the one direction that
   * must never be typeable. The ceiling is a fat-finger guard: a million in minor units
   * is past any plausible single travel line, and a BigInt with no bound reaches the
   * approval-tier lookup unclamped.
   */
  amountMinor: z.bigint().positive().max(MAX_LINE_MINOR).nullish(),
  /** The kind's own fields. Validated against the CATEGORY's kind, not against anything
   *  the client claims the kind is. */
  payload: z.unknown().nullish(),
  /**
   * The traveller's own words: why this line, and on a quoted line why THIS fare.
   *
   * Was called `note`, then `detail`, and was once written only as a fallback behind a
   * server-composed sentence. The server writes none now — which is what lets a policy
   * rule require it, and what makes the generated expense's business purpose a purpose
   * rather than a description of arithmetic.
   */
  notes: z.string().trim().max(2000).nullish(),
});

type BudgetLineInput = z.infer<typeof budgetLineInput>;

/**
 * Validate and PRICE one budget line, without writing it.
 *
 * Split from the write so the caller can put the priced figure into the audit envelope —
 * `withAudit` builds that before its callback runs, and "a line was added" with no basis
 * and no amount is an entry nobody can reconcile.
 *
 * Extracted so `create` can accept lines without re-implementing the rules `addLine`
 * enforces: the category has to be active, the figure has to come from `priceLine`, and an
 * override of a policy-derived amount has to say why. A second copy of those three is a
 * second place for them to stop being true.
 */
async function priceBudgetLine(
  db: TenantDb,
  requestId: string,
  input: BudgetLineInput,
) {
  const category = await lineCategory(db, input.categoryId);
  /**
   * Must exist AND be active.
   *
   * A retired category is one an admin has taken out of the picker, and estimating
   * against it produces a line whose actuals can never be filed under the same category —
   * so budget-vs-actual would show a permanent overrun on one side and a permanent
   * underrun on the other. `?.active` covers both cases with one refusal: naming which
   * would tell an outsider whether an id exists.
   */
  if (!category?.active) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That travel category is not available.' });
  }
  const priced = await priceLine(db, requestId, category, input.payload, input.amountMinor ?? null);
  const notesText = input.notes?.trim() || '';
  /**
   * An override of a policy-derived figure must say why.
   *
   * Only when a derivation was actually REPLACED — `derivedAmountMinor` is set only on
   * that path. Typing a number into a line the policy could not price is not an override
   * and is not questioned, which is what keeps this from becoming a toll on every planned
   * item.
   */
  if (priced.derivedAmountMinor !== undefined && !notesText) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Raising a policy-derived amount needs a reason. Say why in the notes for this line.',
    });
  }
  return { category, priced, notesText };
}

/** Write a line already validated and priced by `priceBudgetLine`. */
function insertBudgetLine(
  tx: Prisma.TransactionClient,
  requestId: string,
  { category, priced, notesText }: Awaited<ReturnType<typeof priceBudgetLine>>,
  sortOrder: number,
) {
  return tx.travelBudgetLine.create({
    data: {
      travelRequestId: requestId,
      categoryId: category.id,
      glAccountId: stampedGlAccountId(category),
      kind: category.lineKind,
      payload: priced.payload,
      amountMinor: priced.amountMinor,
      basis: priced.basis,
      sortOrder,
      // Whatever they typed, or nothing. There is no server-composed fallback to fall
      // back TO any more — that sentence is data in the payload now.
      notes: notesText || null,
      derivedAmountMinor: priced.derivedAmountMinor ?? null,
    },
  });
}

async function nextSortOrder(
  db: TenantDb,
  requestId: string,
): Promise<number> {
  const max = await db.travelBudgetLine.aggregate({
    where: { travelRequestId: requestId },
    _max: { sortOrder: true },
  });
  return (max._max.sortOrder ?? -1) + 1;
}

/** Can this user see this request? Submitter, their direct manager, anyone who has
 *  held or can hold one of its tasks, or an admin. */
export async function canRead(
  db: TenantDb,
  requestId: string,
  userId: string,
  isAdmin: boolean,
): Promise<{ instanceId: string | null } | null> {
  const req = await db.travelRequest.findUnique({
    where: { id: requestId },
    select: { submitterId: true, approvalInstanceId: true },
  });
  if (!req) return null;
  const instanceId: string | null = req.approvalInstanceId;
  if (isAdmin || req.submitterId === userId) return { instanceId };

  const submitter = await db.user.findUnique({
    where: { id: req.submitterId },
    select: { managerId: true },
  });
  if (submitter?.managerId === userId) return { instanceId };
  if (!instanceId) return null;

  const tasks = await db.approvalTask.findMany({
    where: { instanceId },
    select: { id: true, status: true, assigneeUserId: true, decidedById: true },
  });
  if (tasks.some((t) => t.assigneeUserId === userId || t.decidedById === userId)) {
    return { instanceId };
  }
  for (const t of tasks) {
    if (t.status === 'PENDING' && (await canDecide(db, t.id, userId, false))) return { instanceId };
  }
  return null;
}

export const travelRequestsRouter = router({
  /**
   * My travel requests, newest first.
   *
   * `take: 500`, matching both siblings below. It is a bound on AVAILABILITY, not an
   * authorization fix — there is no missing gate here and no data exposure: an unbounded
   * `findMany` over `REQUEST_SELECT` pulls every budget line, every line payload and
   * every policy violation of every trip a person has ever filed, and a legitimate heavy
   * traveller triggers that by signing in.
   *
   * The cap is only honest because the page no longer counts these rows: the "my trips"
   * header reads `summaryOwn.count`, which is the whole set. Adding a `take` while a
   * caller still derived its count from `items.length` would have silently changed a
   * truthful number into a capped one, which is the shape this phase exists to remove.
   */
  listOwn: protectedProcedure.query(async ({ ctx }) => {
    const items = await ctx.db.travelRequest.findMany({
      where: { submitterId: ctx.rbac.id },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: REQUEST_SELECT,
    });
    return { items };
  }),

  /**
   * "My travel requests" as an AGGREGATE — the count and the money for the whole set.
   *
   * GATING, and the asymmetry is deliberate. Its expense twin is wrapped in
   * `withPermission(P.expense.report.readOwn)`; this one is a bare `protectedProcedure`
   * because THERE IS NO `P.travel.request.readOwn` in the registry — the travel block
   * defines six permissions and every one of them is a write or a decision. Inventing a
   * read permission here would 403 every admin-authored custom role, since the seed only
   * ever touches the four system role codes. What replaces it is narrowing inside the
   * resolver: `submitterId: ctx.rbac.id` is the whole `where`, so the procedure cannot
   * return a row the caller did not file. Note also that `protectedProcedure` is
   * SHADOWED at the top of this file with `moduleActive('travel')`, so this inherits the
   * module gate exactly as every other procedure here does.
   *
   * MONEY. A travel request has no scalar total column: the figure is
   * `approvedTotalMinor` once an approver has snapshotted one, and the sum of the budget
   * lines while it is still being composed — the same rule the list page's `budgetMinor`
   * applies per row. So the aggregate is two grouped reads per currency rather than one:
   * the snapshots, plus the lines of the requests that have no snapshot yet. Still O(one
   * query per currency the caller has used), never O(requests).
   */
  summaryOwn: protectedProcedure.query(async ({ ctx }) => {
    // `groupBy` takes scalars only — `currencyId`, never `currency.code`.
    const groups = await ctx.db.travelRequest.groupBy({
      by: ['currencyId'],
      where: { submitterId: ctx.rbac.id },
      // `_all` counts rows; `approvedTotalMinor` counts the NON-NULL ones, which is
      // exactly the set an approver has snapshotted. Both come out of the groupBy that
      // was already being issued — no extra query — and the second is what lets the
      // caller label the money honestly: a figure that is entirely estimates is a
      // REQUESTED total, one that is entirely snapshots is an APPROVED total, and a
      // mixture is neither and must not be called either.
      _count: { _all: true, approvedTotalMinor: true },
      _sum: { approvedTotalMinor: true },
    });
    const [currencies, openLineSums] = await Promise.all([
      groups.length
        ? // VeloExpense (w6-01): `currencyId` IS the ISO code, and the symbol is the platform's.
          ctx.db.currency
            .findMany({
              where: { code: { in: groups.map((g) => g.currencyId) } },
              select: { code: true },
            })
            .then((rows) =>
              rows.map((c) => ({ id: c.code, code: c.code, symbol: currencySymbol(c.code) })),
            )
        : Promise.resolve([]),
      // The estimate half: lines belonging to MY requests in this currency that have not
      // been approved. `approvedTotalMinor: null` is exactly the complement of the rows
      // `_sum.approvedTotalMinor` above added up, so no request is counted twice and none
      // is missed.
      Promise.all(
        groups.map((g) =>
          ctx.db.travelBudgetLine.aggregate({
            where: {
              travelRequest: {
                submitterId: ctx.rbac.id,
                currencyId: g.currencyId,
                approvedTotalMinor: null,
              },
            },
            _sum: { amountMinor: true },
          }),
        ),
      ),
    ]);
    const currencyById = new Map(currencies.map((c) => [c.id, c]));

    const homeCurrency = await readerCurrencyCode(ctx.db, ctx.rbac.id);
    const inHomeCurrency = await homeConverterFor(
      ctx.db,
      homeCurrency,
      currencies.map((c) => c.code),
    );
    const rollup = buildHomeRollup(
      groups.flatMap<CurrencyGroup>((g, i) => {
        const currency = currencyById.get(g.currencyId);
        return currency
          ? [
              {
                code: currency.code,
                symbol: currency.symbol,
                count: g._count._all,
                // Both `?? 0n` are SUM over an empty set — "this currency has no approved
                // request" / "no unapproved line" — never "an amount we could not
                // convert is zero", which is the thing `homeConverterFor` forbids.
                totalMinor:
                  (g._sum.approvedTotalMinor ?? 0n) + (openLineSums[i]._sum.amountMinor ?? 0n),
              },
            ]
          : [];
      }),
      inHomeCurrency,
    );

    return {
      homeCurrency,
      count: rollup.byCurrency.reduce((n, c) => n + c.count, 0),
      /**
       * How many of those requests carry an approver's snapshot.
       *
       * It exists so a caller can name what the total IS rather than guessing from the
       * rows it happens to be showing. Zero means every figure in the sum is a request;
       * equal to `count` means every one of them was approved; anything between is a
       * mixture, and a sum of the two is neither — it is a budget. Deriving this from a
       * capped page of rows would answer for the five that fit, not for the set.
       */
      approvedCount: groups.reduce((n, g) => n + g._count.approvedTotalMinor, 0),
      ...rollup,
    };
  }),

  /** Requests awaiting or bearing my decision, plus everything for an admin.
   *  Non-admins see their direct reports' trips and anything they have a task on —
   *  the same reach the detail page allows, so every row in the list can be opened. */
  listOversight: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.rbac.permissions.includes(P.user.readAll);
    if (isAdmin) {
      const items = await ctx.db.travelRequest.findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: REQUEST_SELECT,
      });
      return { items };
    }
    const [reports, tasks] = await Promise.all([
      ctx.db.user.findMany({ where: { managerId: ctx.rbac.id }, select: { id: true } }),
      ctx.db.approvalTask.findMany({
        where: {
          instance: { subjectType: 'TRAVEL_REQUEST' },
          OR: [{ assigneeUserId: ctx.rbac.id }, { decidedById: ctx.rbac.id }],
        },
        select: { instance: { select: { subjectId: true } } },
      }),
    ]);
    const items = await ctx.db.travelRequest.findMany({
      where: {
        OR: [
          { submitterId: { in: reports.map((r) => r.id) } },
          { id: { in: [...new Set(tasks.map((t) => t.instance.subjectId))] } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: REQUEST_SELECT,
    });
    return { items };
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const isAdmin = ctx.rbac.permissions.includes(P.user.readAll);
      if (!(await canRead(ctx.db, input.id, ctx.rbac.id, isAdmin))) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      return ctx.db.travelRequest.findUniqueOrThrow({
        where: { id: input.id },
        select: REQUEST_SELECT,
      });
    }),

  /** Read-only approval progress — the instance status plus the per-step trail. */
  timeline: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const isAdmin = ctx.rbac.permissions.includes(P.user.readAll);
      const access = await canRead(ctx.db, input.id, ctx.rbac.id, isAdmin);
      if (!access) throw new TRPCError({ code: 'FORBIDDEN' });
      if (!access.instanceId) return { instanceStatus: null, tasks: [] };
      const instance = await ctx.db.approvalInstance.findUnique({
        where: { id: access.instanceId },
        select: {
          status: true,
          tasks: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              label: true,
              status: true,
              decidedAt: true,
              note: true,
              createdAt: true,
              assignee: { select: { firstName: true, lastName: true, email: true } },
              decidedBy: { select: { firstName: true, lastName: true, email: true } },
            },
          },
        },
      });
      return { instanceStatus: instance?.status ?? null, tasks: instance?.tasks ?? [] };
    }),

  /** Travel approval tasks awaiting my decision. No permission gate — eligibility
   *  IS being the resolved approver. */
  myTasks: protectedProcedure.query(async ({ ctx }) => {
    const tasks = await ctx.db.approvalTask.findMany({
      where: {
        status: 'PENDING',
        assigneeUserId: ctx.rbac.id,
        instance: { status: 'RUNNING', subjectType: 'TRAVEL_REQUEST' },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, createdAt: true, instance: { select: { subjectId: true } } },
    });
    const requests = await ctx.db.travelRequest.findMany({
      where: { id: { in: tasks.map((t) => t.instance.subjectId) } },
      select: REQUEST_SELECT,
    });
    const byId = new Map(requests.map((r) => [r.id, r]));
    return {
      items: tasks
        .map((t) => ({ taskId: t.id, label: t.label, request: byId.get(t.instance.subjectId) }))
        .filter((row) => row.request != null),
    };
  }),

  /**
   * Destination suggestions, proxied server-side because the Maps key must never
   * reach the browser.
   *
   * Cities only — you fly to a city, and a city is what per-diem matches on and
   * what the hotel query takes. `available: false` rather than an error when no key
   * is configured: the form falls back to a typed destination, which still prices
   * from per-diem if the text happens to match a rate's city.
   */
  searchDestinations: withPermission(P.travel.request.createOwn)
    .input(
      z.object({
        query: z.string().trim().min(3).max(200),
        sessionToken: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const cfg = await getMapsConfig(ctx.db);
      if (!cfg) return { available: false as const, items: [], error: null };
      try {
        return {
          available: true as const,
          items: await searchCities(cfg, input.query, input.sessionToken),
          error: null,
        };
      } catch (err) {
        // The reason goes back to the caller. Swallowing it into an empty list is
        // how a rejected API key came to look like every city in North America
        // having vanished — diagnosed once already, on the mileage form.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[travel.searchDestinations] "${input.query}": ${message}`);
        return { available: true as const, items: [], error: message };
      }
    }),

  /** What the new-request form needs before anyone types: currencies, and whether
   *  the two optional integrations are usable. */
  formOptions: withPermission(P.travel.request.createOwn).query(async ({ ctx }) => {
    const [currencies, maps, serp, me] = await Promise.all([
      // VeloExpense (w6-01): the shared `currency` table has no `active` flag or symbol —
      // every row is offered, the id is the code, the symbol is the platform's (as
      // `expenses.currencies` does).
      ctx.db.currency
        .findMany({ orderBy: { code: 'asc' }, select: { code: true } })
        .then((rows) =>
          rows.map((c) => ({ id: c.code, code: c.code, symbol: currencySymbol(c.code) })),
        ),
      getMapsConfig(ctx.db),
      getSerpApiConfig(ctx.db),
      ctx.db.user.findUnique({
        where: { id: ctx.rbac.id },
        select: { entity: { select: { homeCurrency: { select: { code: true } } } } },
      }),
    ]);
    return {
      currencies,
      placeLookup: maps !== null,
      pricing: serp !== null,
      // The traveller's entity's home currency, so the form opens on the one they
      // will almost always want rather than on an alphabetical accident. Matched by
      // CODE because that is what the entity stores.
      defaultCurrencyId:
        currencies.find((c) => c.code === me?.entity?.homeCurrency?.code)?.id ??
        currencies[0]?.id ??
        null,
    };
  }),

  create: withPermission(P.travel.request.createOwn)
    .input(
      tripInput.extend({
        /**
         * The trip's planned budget, filed WITH the request.
         *
         * The form used to post the trip and nothing else, so a traveller composing a
         * request had to save it, wait for the drawer to reopen on the saved record, and
         * only then start adding what they intended to spend. Two screens and a round
         * trip for one act.
         *
         * Every line goes through `writeBudgetLine`, the same path `addLine` uses, so a
         * line filed at create time obeys the same rules as one added afterwards — the
         * category has to be active, the figure comes from the pricing engine, and an
         * override of a policy-derived amount has to say why. Bounded because a create is
         * one transaction and an unbounded list is an unbounded one.
         */
        lines: z.array(budgetLineInput).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const departDate = new Date(input.departDate);
      const returnDate = input.returnDate ? new Date(input.returnDate) : null;
      assertDates(input.tripType, departDate, returnDate);

      return withAudit(
        ctx.db,
        {
          action: auditActions.travel.create,
          entityType: 'TravelRequest',
          actor: actorOf(ctx),
          details: {
            destination: input.destination.label,
            ...(input.lines?.length ? { linesFiled: input.lines.length } : {}),
          },
        },
        async (tx) => {
          const created = await tx.travelRequest.create({
            data: {
              submitterId: ctx.rbac.id,
              purpose: input.purpose,
              notes: input.notes ?? null,
              destinationPlaceId: input.destination.placeId ?? null,
              destinationLabel: input.destination.label,
              destinationCity: input.destination.city ?? null,
              destinationCountry: input.destination.country ?? null,
              destinationAirport: input.destination.airport ?? null,
              originPlaceId: input.origin.placeId ?? null,
              originLabel: input.origin.label,
              originCity: input.origin.city ?? null,
              originCountry: input.origin.country ?? null,
              originAirport: input.origin.airport ?? null,
              tripType: input.tripType,
              departDate,
              returnDate,
              includeCar: input.includeCar,
              currencyId: input.currencyId,
            },
            select: { id: true },
          });
          /**
           * Only what the traveller asked for.
           *
           * A new request used to arrive pre-populated with a per-diem line for every
           * category that had a rate at the destination, which meant a traveller's first
           * job was deleting the ones their trip did not involve — and, worse, that a
           * line they corrected came back on the next edit. Nothing is invented here: the
           * lines are the ones the form posted, in the order it posted them, and a request
           * filed with none has none.
           *
           * Sequential rather than concurrent: `sortOrder` is positional and the lines
           * have to land in the order the traveller wrote them.
           */
          for (const [i, line] of (input.lines ?? []).entries()) {
            /**
             * AWAITED — and it was not, which is why no line filed through the create
             * drawer ever reached the database. A Prisma query is a lazy `PrismaPromise`:
             * it is sent only when something awaits it, so an un-awaited `create` inside a
             * transaction is a no-op that throws nothing. Every stubbed unit test passed,
             * because a stub executes eagerly; the browser found it the first time a
             * create posted a line and then looked for it.
             */
            await insertBudgetLine(tx, created.id, await priceBudgetLine(tx, created.id, line), i);
          }
          return tx.travelRequest.findUniqueOrThrow({
            where: { id: created.id },
            select: REQUEST_SELECT,
          });
        },
        (r) => r.id,
      );
    }),

  update: withPermission(P.travel.request.updateOwn)
    .input(tripPatchInput.extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const req = await ctx.db.travelRequest.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          submitterId: true,
          status: true,
          tripType: true,
          departDate: true,
          returnDate: true,
        },
      });
      if (!req) throw new TRPCError({ code: 'NOT_FOUND' });
      if (req.submitterId !== ctx.rbac.id) throw new TRPCError({ code: 'FORBIDDEN' });
      if (!EDITABLE.has(req.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A submitted request can no longer be edited.',
        });
      }
      const departDate = input.departDate ? new Date(input.departDate) : req.departDate;
      const returnDate =
        input.returnDate === undefined
          ? req.returnDate
          : input.returnDate
            ? new Date(input.returnDate)
            : null;
      assertDates(input.tripType ?? req.tripType, departDate, returnDate);

      return withAudit(
        ctx.db,
        {
          action: auditActions.travel.update,
          entityType: 'TravelRequest',
          entityId: req.id,
          actor: actorOf(ctx),
          details: {},
        },
        async (tx) => {
          await tx.travelRequest.update({
            where: { id: req.id },
            data: {
              ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
              ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
              ...(input.destination
                ? {
                    destinationPlaceId: input.destination.placeId ?? null,
                    destinationLabel: input.destination.label,
                    destinationCity: input.destination.city ?? null,
                    destinationCountry: input.destination.country ?? null,
                    destinationAirport: input.destination.airport ?? null,
                    // The resolved metro is only valid for the place it was resolved
                    // FOR. Moving the destination without clearing it would price
                    // the new city's trip with the old city's airports.
                    destinationSerpId: null,
                    destinationAirports: [],
                  }
                : {}),
              ...(input.origin
                ? {
                    originPlaceId: input.origin.placeId ?? null,
                    originLabel: input.origin.label,
                    originCity: input.origin.city ?? null,
                    originCountry: input.origin.country ?? null,
                    originAirport: input.origin.airport ?? null,
                    // The resolved metro belongs to the place it was resolved FOR.
                    originSerpId: null,
                    originAirports: [],
                  }
                : {}),
              ...(input.tripType !== undefined ? { tripType: input.tripType } : {}),
              departDate,
              returnDate,
              ...(input.includeCar !== undefined ? { includeCar: input.includeCar } : {}),
              ...(input.currencyId !== undefined ? { currencyId: input.currencyId } : {}),
            },
          });
          /**
           * The lines are NOT re-priced after an edit.
           *
           * Moving the dates or the destination does change what the allowance would
           * be, and the traveller can see that: the amount on each line is the one it
           * was created with, and adding a fresh line in the same category prices it
           * against the new dates. Re-pricing here is what silently restored a figure
           * somebody had deliberately corrected.
           */
          return tx.travelRequest.findUniqueOrThrow({
            where: { id: req.id },
            select: REQUEST_SELECT,
          });
        },
      );
    }),

  /**
   * Flight options for the request's route, for the traveller to pick from.
   *
   * A MUTATION, not a query, and that is a cost decision rather than a semantic one:
   * react-query refetches a query on mount, on window focus and on invalidation, and
   * every one of those would spend a SerpApi credit nobody asked to spend.
   *
   * Returns candidates with ids. The prices in them are for DISPLAY — `chooseLineOption`
   * re-reads the amount from the stored row, so a client that edits one changes nothing.
   */
  searchFlightOptions: withPermission(P.travel.request.updateOwn)
    .input(
      z.object({
        id: z.string().uuid(),
        tripType: z.enum(['ROUND_TRIP', 'ONE_WAY', 'MULTI_CITY']).default('ROUND_TRIP'),
        travelClass: z.enum(TRAVEL_CLASS_NAMES).default('ECONOMY'),
        maxStops: z.number().int().min(0).max(3).nullish(),
        deepSearch: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await editableRequest(ctx, input.id);
      const config = await getSerpApiConfig(ctx.db);
      const money = await quoteCurrencyContext(ctx.db, input.id);
      return findFlightOptions(ctx.db, config, input.id, input, money.toRequestMinor);
    }),

  /**
   * Lodging options for the given nights at the request's destination.
   *
   * The per-diem lodging cap is resolved server-side and pushed to the provider as a
   * price filter — the client does not get to widen it, and filtering after paying for
   * forty results would waste most of the search.
   */
  searchStayOptions: withPermission(P.travel.request.updateOwn)
    .input(
      z.object({
        id: z.string().uuid(),
        checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        adults: z.number().int().min(1).max(20).nullish(),
        vacationRentals: z.boolean().default(false),
        /** Off by default. A cap is a WARNING threshold on a quoted stay, and using it
         *  as a hard provider filter can hide every hotel in an expensive city — which
         *  reads as "no results" rather than "everything here is over policy". */
        applyCap: z.boolean().default(false),
        sortBy: z.union([z.literal(3), z.literal(8), z.literal(13)]).default(3),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await editableRequest(ctx, input.id);
      const config = await getSerpApiConfig(ctx.db);
      const money = await quoteCurrencyContext(ctx.db, input.id);
      const cap = input.applyCap ? await lodgingCapMinor(ctx.db, input.id) : null;
      return findStayOptions(
        ctx.db,
        config,
        input.id,
        { ...input, capPerNightMinor: cap },
        money.toRequestMinor,
        money.toMajor,
      );
    }),

  /**
   * Take one of the searched options onto a line.
   *
   * The amount and the payload both come from the STORED candidate, never from the
   * client. That is the whole reason a search writes rows before anything can be
   * picked: a picker that accepted "here is the option I chose, and here is what it
   * cost" would be the archived prototype's posted-total bug wearing a new shape.
   *
   * `basis` becomes QUOTE and the payload records the itinerary — the flight numbers, the
   * cabin, the dates and what the provider quoted before FX — so the line can always answer
   * what justified its figure. And it stays that way: there is no re-price, the traveller
   * picked a flight, and a fare that moves next week is not this estimate's problem.
   */
  chooseLineOption: withPermission(P.travel.request.updateOwn)
    .input(
      z.object({
        id: z.string().uuid(),
        lineId: z.string().uuid(),
        candidateId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const req = await editableRequest(ctx, input.id);
      const line = await ctx.db.travelBudgetLine.findUnique({
        where: { id: input.lineId },
        select: { id: true, travelRequestId: true, categoryId: true, kind: true },
      });
      // Belonging to THIS request, not merely existing. Without it a caller could point any
      // line in the org at a candidate by id.
      if (!line || line.travelRequestId !== req.id) throw new TRPCError({ code: 'NOT_FOUND' });

      /**
       * The kinds have to agree. A FLIGHT option on a LODGING line would write an airfare
       * payload into a block with no field to read it, which is unreadable rather than
       * merely wrong.
       */
      const wanted = line.kind === 'AIRFARE' ? 'FLIGHT' : line.kind === 'LODGING' ? 'STAY' : null;
      if (wanted == null) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only an airfare or lodging line can take a searched option.',
        });
      }

      /**
       * The cached candidate, keyed by REQUEST and kind — so an id from another request, or
       * a stay id offered to an airfare line, simply is not found.
       *
       * Expiry is an ordinary outcome, not an error: a traveller who left the drawer open
       * over lunch gets this, and the message says what to do rather than reading as a bug.
       */
      const candidate = await getCandidate(req.id, wanted, input.candidateId);
      if (!candidate) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'That option is no longer available to choose — prices are held for a short ' +
            'while. Search again and pick from the fresh results.',
        });
      }

      /**
       * The amount comes from the CACHE, never from the input — which has no amount field
       * at all. Already converted into the request's currency when the search ran, so the
       * figure the traveller was shown is the figure that lands: an FX table that moved in
       * between cannot silently restate the price they agreed to.
       */
      const amountMinor = BigInt(candidate.amountMinor);
      // VeloExpense (w6-01): the stored kind is text under 0077's CHECK.
      const built = buildChosenPayload(line.kind as TravelLineKind, candidate);

      return withAudit(
        ctx.db,
        {
          action: auditActions.travel.update,
          entityType: 'TravelRequest',
          entityId: req.id,
          actor: actorOf(ctx),
          details: {
            lineOptionChosen: {
              lineId: line.id,
              candidateId: input.candidateId,
              amountMinor: amountMinor.toString(),
              // What the provider quoted, before FX — the figure the dropped quote table
              // used to be the only record of.
              providerAmountMinor: candidate.providerAmountMinor,
              providerCurrency: candidate.providerCurrency,
            },
          },
        },
        async (tx) => {
          await tx.travelBudgetLine.update({
            where: { id: line.id },
            data: {
              amountMinor,
              basis: 'QUOTE',
              payload: built.payload,
              // `notes` deliberately untouched. It holds the traveller's reason for
              // this fare — the answer to "why AA and not United" — and a picker that
              // overwrote it with a route summary would delete the one thing an approver
              // cannot reconstruct from the payload.
            },
          });
          return tx.travelRequest.findUniqueOrThrow({
            where: { id: req.id },
            select: REQUEST_SELECT,
          });
        },
      ).then(async (result) => {
        /**
         * The rival fares stop being redeemable once one is taken.
         *
         * AFTER the write, and outside it: a Redis failure must not roll back a choice that
         * is already correct in the database. Leaving them would let a stale id from the
         * same result set silently replace a deliberate pick.
         */
        await clearCandidates(req.id).catch((e) => {
          console.warn('[travel] could not clear option candidates', e);
        });
        return result;
      });
    }),

  /**
   * The expense categories a planned item may be filed against.
   *
   * Its own procedure rather than `expenses.categories`, for two reasons that are not
   * tidiness:
   *
   *   · it is TRAVEL-gated. `expenses.categories` requires `expense.report.read.own`
   *     and carries no module gate, so a role that may plan a trip but not file a
   *     report would be refused a travel affordance by an expense permission.
   *   · it returns `code`, which the expense line picker has no use for and travel
   *     does: the drawer has to recognise the rental-car bucket to say that a car
   *     nobody can quote still has to be planned by hand.
   */
  categories: withPermission(P.travel.request.updateOwn).query(async ({ ctx }) => {
    // TRAVEL categories: fifteen things you can book a trip against, not the
    // thirty-one an accountant codes to. `lineKind` rides along because it decides
    // which editor block the picked category opens.
    const items = await ctx.db.travelCategory.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, code: true, label: true, icon: true, color: true, lineKind: true },
    });
    return { items, carCode: TRAVEL_CATEGORY_CODES.car };
  }),

  /**
   * What the policy would derive for a line BEFORE it exists.
   *
   * The drawers used to learn the allowance only after the write: the create form filed a
   * blank amount and the derived figure appeared once the request came back, and the
   * saved-request editor showed it on the block the add produced. So a traveller picking
   * "Meals" met an empty box, and one who typed a figure into it learnt from the server's
   * refusal — not from the screen — that they had just overridden a policy amount without
   * saying why. This answers the question up front, read-only, so the amount can be
   * POPULATED when the category is picked and the note requirement mirrored inline.
   *
   * The same ladder `priceLine` walks, through the same `perDiemForCategory`, with the same
   * rates and FX — never a second copy of the arithmetic. What differs is where the trip's
   * facts come from:
   *
   *   · with `requestId` — the saved request, exactly as `priceLine` reads it, so the
   *     saved-request editor previews the figure the write will produce;
   *   · without one — the CALLER's own tier (job level, entity, business unit: the person
   *     asking is the person travelling), a destination and dates typed into the create
   *     drawer, and the currency it will be filed in.
   *
   * Null derivation, never a throw, for a category that maps to no expense category or a
   * destination no rate covers: that is "nothing to populate", and the box stays for the
   * traveller to fill, which is not an error. The write path is still the enforcement; a
   * client that skips this query changes nothing about what the server accepts.
   */
  previewLine: withPermission(P.travel.request.updateOwn)
    .input(
      z.object({
        categoryId: z.string().uuid(),
        /** A SAVED request to read the trip off. The remaining fields are ignored then. */
        requestId: z.string().uuid().nullish(),
        destinationCity: z.string().trim().max(200).nullish(),
        departDate: z.string().datetime().nullish(),
        returnDate: z.string().datetime().nullish(),
        // VeloExpense (w6-01): a currency is keyed by its ISO code.
        currencyId: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const preview = await previewAllowance(ctx, input);
      return {
        derivedAmountMinor: preview?.amountMinor.toString() ?? null,
        basis: preview ? ('PER_DIEM' as const) : null,
        days: preview?.days ?? 0,
        dailyRateMinor: preview?.dailyRateMinor.toString() ?? null,
        edgeDaysHalved: preview?.edgeDaysHalved ?? false,
        city: preview?.city ?? null,
      };
    }),

  /**
   * The per-diem allowance one category resolves to on one request, per person.
   *
   * So the meal block can SHOW the rate it is multiplying by, pre-filled and overridable,
   * instead of a blank box beside a total nobody can check. "Three people, twice a day,
   * four days" is only auditable if the fourth number is on screen — and a traveller who
   * cannot see the rate has no way to tell an allowance they should question from one
   * they should not.
   *
   * A thin reading of `previewLine`, kept because the attendee editor wants ONE number and
   * a name that says which one: the DAILY rate, not the trip total. The block multiplies
   * it by heads and by occurrences itself, so handing it a figure that already counts the
   * days would multiply the trip length in twice. Null when the category maps to no
   * expense category, or when no rate covers the destination and the traveller's tier —
   * the block then behaves as it always did, with an empty box the traveller fills in.
   */
  perDiemRate: withPermission(P.travel.request.updateOwn)
    .input(z.object({ id: z.string().uuid(), categoryId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const preview = await previewAllowance(ctx, {
        requestId: input.id,
        categoryId: input.categoryId,
      });
      return {
        ratePerPersonMinor:
          preview && preview.dailyRateMinor > 0n ? preview.dailyRateMinor.toString() : null,
      };
    }),

  /**
   * Add a line to the estimate.
   *
   * Replaces `addPlannedItem`, and the rename is the change: there is no longer a
   * distinction between the lines the server generated and the "planned items" a
   * traveller added by hand. There are only lines, and the traveller writes all of them.
   *
   * The category decides the KIND, which decides the payload and how the amount is
   * derived. The client never chooses any of that — see `priceLine` for the basis
   * ladder. An amount the client does send lands as `MANUAL`, labelled as a typed
   * figure, which is exactly what it is.
   *
   * The amount is in the REQUEST's currency. Lines carry no currency of their own — the
   * request's is what the total, the approval tier and the variance are all read in, and
   * letting a line dissent would make the total meaningless.
   */
  addLine: withPermission(P.travel.request.updateOwn)
    .input(budgetLineInput.extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const req = await editableRequest(ctx, input.id);
      // Priced BEFORE the audit envelope is built, because the envelope carries the basis
      // and the amount — "a line was added" with neither is an entry nobody can reconcile.
      const line = await priceBudgetLine(ctx.db, req.id, input);
      const sortOrder = await nextSortOrder(ctx.db, req.id);
      return withAudit(
        ctx.db,
        {
          action: auditActions.travel.update,
          entityType: 'TravelRequest',
          entityId: req.id,
          actor: actorOf(ctx),
          details: {
            lineAdded: {
              categoryId: line.category.id,
              kind: line.category.lineKind,
              basis: line.priced.basis,
              amountMinor: line.priced.amountMinor.toString(),
            },
          },
        },
        async (tx) => {
          // The rules live in `priceBudgetLine`, shared with `create` — a second copy
          // would be a second place for them to stop being true.
          await insertBudgetLine(tx, req.id, line, sortOrder);
          return tx.travelRequest.findUniqueOrThrow({
            where: { id: req.id },
            select: REQUEST_SELECT,
          });
        },
      );
    }),

  /**
   * Edit a line that is already there.
   *
   * The mutation the module has never had. Until now a saved line could only be deleted
   * and retyped, which meant correcting a single figure lost the category, the note and
   * the payload alongside it.
   *
   * Two ways to change the amount, and they mean different things:
   *
   *   · **`amountMinor`** — a typed figure. Becomes `MANUAL` and STAYS manual. The
   *     payload is kept, so a department meal that somebody rounded up still knows who
   *     is going to it.
   *   · **`payload`** — new kind fields. The amount is RE-DERIVED from them, because
   *     changing the attendee list and leaving the total alone produces a line whose
   *     own fields contradict its figure.
   */
  updateLine: withPermission(P.travel.request.updateOwn)
    .input(
      z.object({
        id: z.string().uuid(),
        lineId: z.string().uuid(),
        amountMinor: z.bigint().positive().max(MAX_LINE_MINOR).nullish(),
        payload: z.unknown().nullish(),
        notes: z.string().trim().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const req = await editableRequest(ctx, input.id);
      const line = await ctx.db.travelBudgetLine.findUnique({
        where: { id: input.lineId },
        // `notes` so an override can be justified by what the line ALREADY says: a
        // traveller raising an amount on a line they have already explained should not
        // have to retype the explanation to get past the guard below.
        select: {
          id: true,
          travelRequestId: true,
          categoryId: true,
          payload: true,
          notes: true,
        },
      });
      // Belonging to THIS request, not merely existing. Without it this is an endpoint
      // for editing any line in the org by id.
      if (!line || line.travelRequestId !== req.id) throw new TRPCError({ code: 'NOT_FOUND' });

      const category = await lineCategory(ctx.db, line.categoryId);
      if (!category) throw new TRPCError({ code: 'NOT_FOUND' });

      // An untouched payload keeps whatever is stored, so an amount-only edit does not
      // have to resend fields it is not changing.
      const payload = input.payload === undefined ? line.payload : input.payload;
      const priced = await priceLine(ctx.db, req.id, category, payload, input.amountMinor ?? null);

      /**
       * An override of a policy-derived figure must say why — see `addLine` for the
       * reasoning. Satisfied by notes being SENT or already STORED, because the
       * requirement is that the override is explained, not that it is re-explained.
       */
      const notesText =
        input.notes === undefined ? (line.notes ?? '') : (input.notes?.trim() ?? '');
      if (priced.derivedAmountMinor !== undefined && !notesText.trim()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Raising a policy-derived amount needs a reason. Say why in the notes for this line.',
        });
      }

      return withAudit(
        ctx.db,
        {
          action: auditActions.travel.update,
          entityType: 'TravelRequest',
          entityId: req.id,
          actor: actorOf(ctx),
          details: {
            lineUpdated: {
              lineId: line.id,
              basis: priced.basis,
              amountMinor: priced.amountMinor.toString(),
            },
          },
        },
        async (tx) => {
          await tx.travelBudgetLine.update({
            where: { id: line.id },
            data: {
              payload: priced.payload,
              amountMinor: priced.amountMinor,
              basis: priced.basis,
              // An explicit empty string CLEARS it; an absent field leaves it alone. The
              // distinction matters because a rule may require this to be non-blank, so
              // "I withdraw what I wrote" has to be expressible.
              ...(input.notes === undefined ? {} : { notes: input.notes?.trim() || null }),
              ...(priced.derivedAmountMinor === undefined
                ? {}
                : { derivedAmountMinor: priced.derivedAmountMinor }),
            },
          });
          return tx.travelRequest.findUniqueOrThrow({
            where: { id: req.id },
            select: REQUEST_SELECT,
          });
        },
      );
    }),

  /**
   * Remove a line.
   *
   * ANY line, where the old `removePlannedItem` refused anything but `MANUAL`. That
   * restriction existed because a re-price was the only way a quoted or per-diem line
   * could change, so deleting one left a hole nothing would refill — a traveller could
   * drop the quoted airfare and submit a trip priced at its meals.
   *
   * There is no re-price now. Every line is written deliberately and the total is the
   * sum of what is there, so removing one is a visible, complete act — and it is how a
   * traveller undoes a mistake: add a fresh line, delete the old one.
   */
  removeLine: withPermission(P.travel.request.updateOwn)
    .input(z.object({ id: z.string().uuid(), lineId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const req = await editableRequest(ctx, input.id);
      const line = await ctx.db.travelBudgetLine.findUnique({
        where: { id: input.lineId },
        select: { id: true, travelRequestId: true, amountMinor: true, categoryId: true },
      });
      if (!line || line.travelRequestId !== req.id) throw new TRPCError({ code: 'NOT_FOUND' });

      return withAudit(
        ctx.db,
        {
          action: auditActions.travel.update,
          entityType: 'TravelRequest',
          entityId: req.id,
          actor: actorOf(ctx),
          details: {
            lineRemoved: {
              lineId: line.id,
              categoryId: line.categoryId,
              amountMinor: line.amountMinor.toString(),
            },
          },
        },
        async (tx) => {
          await tx.travelBudgetLine.delete({ where: { id: line.id } });
          return tx.travelRequest.findUniqueOrThrow({
            where: { id: req.id },
            select: REQUEST_SELECT,
          });
        },
      );
    }),

  /**
   * Reorder the lines.
   *
   * The itinerary IS the ordered set of lines — an airfare line's payload is a flight
   * segment, two of them are a multi-city trip — so the order carries meaning and
   * `createdAt` is not something a traveller can correct.
   *
   * Ids not belonging to this request are ignored rather than refused, which is what
   * makes a stale client list harmless instead of fatal.
   */
  reorderLines: withPermission(P.travel.request.updateOwn)
    .input(z.object({ id: z.string().uuid(), lineIds: z.array(z.string().uuid()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const req = await editableRequest(ctx, input.id);
      return withAudit(
        ctx.db,
        {
          action: auditActions.travel.update,
          entityType: 'TravelRequest',
          entityId: req.id,
          actor: actorOf(ctx),
          details: { linesReordered: input.lineIds.length },
        },
        async (tx) => {
          for (let sortOrder = 0; sortOrder < input.lineIds.length; sortOrder++) {
            await tx.travelBudgetLine.updateMany({
              // Scoped to the request: `updateMany` makes a foreign id a no-op rather
              // than a way to reorder somebody else's estimate.
              where: { id: input.lineIds[sortOrder], travelRequestId: req.id },
              data: { sortOrder },
            });
          }
          return tx.travelRequest.findUniqueOrThrow({
            where: { id: req.id },
            select: REQUEST_SELECT,
          });
        },
      );
    }),

  /**
   * Run the policy engine over this estimate. Idempotent — rewrites the request's
   * `PolicyViolation` rows wholesale on each call, so the drawer can call it on a
   * debounced edit the way the expense workbench does.
   *
   * `updateOwn` rather than `readOwn`: it writes.
   */
  validate: withPermission(P.travel.request.updateOwn)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const req = await ctx.db.travelRequest.findUnique({
        where: { id: input.id },
        select: { submitterId: true },
      });
      if (!req || req.submitterId !== ctx.rbac.id) throw new TRPCError({ code: 'NOT_FOUND' });
      return validateTravelRequest({
        db: ctx.db,
        travelRequestId: input.id,
        t: fallbackTranslator,
      });
    }),

  /**
   * Attach a justification to a WARNING/INFO violation — the comment that unblocks
   * submit. A blank note clears it.
   *
   * A BLOCK is never justifiable, and on a travel request that is the whole point: the
   * money has not moved, so a discouraged booking is fixed rather than explained. This
   * is the same refusal the expense side makes, said out loud in the one place where it
   * is the normal outcome rather than the exception.
   */
  justifyViolation: withPermission(P.travel.request.updateOwn)
    .input(
      z.object({ violationId: z.string().uuid(), note: z.string().trim().max(2000).nullish() }),
    )
    .mutation(async ({ ctx, input }) => {
      const v = await ctx.db.policyViolation.findUnique({
        where: { id: input.violationId },
        select: {
          id: true,
          severity: true,
          travelRequest: { select: { id: true, submitterId: true, status: true } },
        },
      });
      // `travelRequest` is null on an EXPENSE violation, which this procedure must not
      // reach — that one is `expenses.justifyViolation`, gated on the report's submitter.
      if (!v?.travelRequest || v.travelRequest.submitterId !== ctx.rbac.id) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (!EDITABLE.has(v.travelRequest.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A submitted request can no longer be edited.',
        });
      }
      if (v.severity === 'BLOCK') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A blocking violation must be fixed, not justified.',
        });
      }
      const note = input.note?.trim() ? input.note.trim() : null;
      await ctx.db.policyViolation.update({
        where: { id: input.violationId },
        data: note
          ? { resolveNote: note, resolvedAt: new Date(), resolvedBy: ctx.rbac.id }
          : { resolveNote: null, resolvedAt: null, resolvedBy: null },
      });
      // The whole request back, so the caller re-renders the violation list and the
      // submit gate from one response.
      return ctx.db.travelRequest.findUniqueOrThrow({
        where: { id: v.travelRequest.id },
        select: REQUEST_SELECT,
      });
    }),

  /** Submit for approval. The budget is rebuilt inside the transaction, so what
   *  the approver decides on is what the server computed — not what the form sent. */
  submit: withPermission(P.travel.request.submitOwn)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const req = await ctx.db.travelRequest.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          submitterId: true,
          status: true,
          tripType: true,
          departDate: true,
          returnDate: true,
        },
      });
      if (!req) throw new TRPCError({ code: 'NOT_FOUND' });
      if (req.submitterId !== ctx.rbac.id) throw new TRPCError({ code: 'FORBIDDEN' });
      if (!EDITABLE.has(req.status)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This request is already submitted.' });
      }
      assertDates(req.tripType, req.departDate, req.returnDate);

      /**
       * The policy gate, and the one place the estimate stops being purely advisory.
       *
       * Re-run server-side rather than trusting whatever the drawer last computed —
       * the same reasoning as every other number on this router. A BLOCK refuses
       * outright; an unjustified WARNING refuses too, which is what forces the
       * traveller to write the explanation the approver then reads.
       *
       * Outside the transaction, because `validateTravelRequest` opens its own (the
       * violation set is swapped wholesale) and Postgres has no nested transactions to
       * borrow. The expense submit gate sits in exactly the same place for the same
       * reason. The cost is that a request can be validated and then not submitted,
       * which leaves an accurate violation set behind — the harmless direction.
       *
       * VeloExpense (w6-01): there is no "outside" here — the whole procedure is one tenant
       * transaction (server/trpc.ts), and the validator runs on it. So a REFUSED submit rolls
       * the fresh violation set back with everything else, as a refused report submit does
       * (`expenses.submit`'s `policyPass`): the refusal carries the list in `cause`, which is
       * what the drawer names the blockers from, and the stored set is the one the drawer's
       * last `validate` call wrote.
       */
      const policy = await validateTravelRequest({
        db: ctx.db,
        travelRequestId: req.id,
        t: fallbackTranslator,
      });
      if (policy.counts.block > 0 || policy.counts.unjustifiedWarning > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This request has unresolved policy violations.',
          // Carries the list + counts so the drawer can name the specific blockers
          // rather than saying "something is wrong".
          cause: policy,
        });
      }

      let createdTaskIds: string[] = [];
      let firedEffectIds: string[] = [];
      const result = await withAudit(
        ctx.db,
        {
          action: auditActions.travel.submit,
          entityType: 'TravelRequest',
          entityId: req.id,
          actor: actorOf(ctx),
          details: {},
        },
        async (tx) => {
          /**
           * No rebuild here either, and the guarantee it used to provide has moved
           * rather than gone.
           *
           * It was: "the budget is recomputed inside the submit transaction, so what
           * the approver decides on is what the server computed." It is now: "every
           * line's amount was computed or validated by the server when the line was
           * written, and a client-supplied figure is stored as MANUAL." The client
           * still cannot post a number wearing PER_DIEM or QUOTE, which is the
           * property that mattered.
           *
           * What is deliberately given up: a per-diem rate revised between composing
           * the estimate and submitting it is not picked up. That is the point — an
           * estimate is a statement of what the traveller asked for.
           */
          await tx.travelRequest.update({
            where: { id: req.id },
            data: { status: 'SUBMITTED', submittedAt: new Date() },
          });
          const start = await startInstance(tx, 'TRAVEL_REQUEST', req.id);
          // VeloExpense (w6-01, d58): a request no workflow governs is refused, and the whole
          // submit rolls back. ExpenseOS leaves it SUBMITTED with nobody to decide it. Every
          // tenant has a default travel flow (0077's `seed_travel_defaults`), so this is an
          // admin who deactivated it.
          if (start.status === 'NO_WORKFLOW' || start.instanceId === null) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message:
                'No approval workflow covers this travel request. Ask an administrator to set one up.',
            });
          }
          createdTaskIds = start.createdTaskIds;
          firedEffectIds = start.firedEffects;
          if (start.instanceId) {
            await tx.travelRequest.update({
              where: { id: req.id },
              data: { approvalInstanceId: start.instanceId },
            });
          }
          return tx.travelRequest.findUniqueOrThrow({
            where: { id: req.id },
            select: REQUEST_SELECT,
          });
        },
      );

      // VeloExpense (w6-01): awaited on the request's transaction, under a savepoint, and as
      // TASK_ASSIGNED — see `recordTravelActivity`. No tasks (an auto-approval) tells nobody.
      if (createdTaskIds.length > 0) {
        await bestEffort(ctx.db, 'submit', async () => {
          const activity = await recordTravelActivity(ctx.db, {
            subjectId: req.id,
            type: 'TASK_ASSIGNED',
            actorId: ctx.rbac.id,
          });
          const approvers = await taskRecipientIds(ctx.db, createdTaskIds);
          await notifyRecipients(
            ctx.db,
            activity.id,
            approvers.filter((id) => id !== ctx.rbac.id),
          );
        });
      }

      // VeloExpense (w6-01): awaited — it runs on the caller's transaction (under its own
      // savepoint), so it must finish before the procedure returns.
      await executeWorkflowEffects(ctx.db, {
        subjectType: 'TRAVEL_REQUEST',
        subjectId: req.id,
        effectNodeIds: firedEffectIds,
        actorId: ctx.rbac.id,
      });
      return result;
    }),

  /** Withdraw your own request before it is decided. */
  cancel: withPermission(P.travel.request.updateOwn)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const req = await ctx.db.travelRequest.findUnique({
        where: { id: input.id },
        select: { id: true, submitterId: true, status: true, approvalInstanceId: true },
      });
      if (!req) throw new TRPCError({ code: 'NOT_FOUND' });
      if (req.submitterId !== ctx.rbac.id) throw new TRPCError({ code: 'FORBIDDEN' });
      if (req.status === 'APPROVED' || req.status === 'CANCELLED') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'An approved or cancelled request cannot be withdrawn.',
        });
      }
      return withAudit(
        ctx.db,
        {
          action: auditActions.travel.update,
          entityType: 'TravelRequest',
          entityId: req.id,
          actor: actorOf(ctx),
          details: { cancelled: true },
        },
        async (tx) => {
          if (req.approvalInstanceId) {
            await tx.approvalTask.updateMany({
              where: { instanceId: req.approvalInstanceId, status: 'PENDING' },
              data: { status: 'SKIPPED' },
            });
            await tx.approvalInstance.update({
              where: { id: req.approvalInstanceId },
              data: { status: 'CANCELLED', completedAt: new Date() },
            });
          }
          return tx.travelRequest.update({
            where: { id: req.id },
            data: { status: 'CANCELLED' },
            select: REQUEST_SELECT,
          });
        },
      );
    }),

  /**
   * Budget vs actual — the question the whole module exists to make answerable.
   *
   * Both sides key on the EXPENSE category, because that is the only key the actuals
   * have: an expense line item is coded to an expense category, and a budget line is
   * coded to a travel one. So the budget side crosses `TravelCategory.expenseCategoryId`
   * to get there, and neither side resolves through anything an admin can re-point
   * after the fact.
   *
   * The cost of two taxonomies is `unmappable`: a budget line on a travel category
   * with no expense counterpart has no actuals it could ever be compared against. It
   * is reported, not dropped — money nobody can reconcile is exactly what somebody
   * needs to be told about, and silently omitting it would make a trip look on budget.
   *
   * Returns rows even before anything is filed: `hasActuals` distinguishes "on budget"
   * from "no receipts yet", which look identical if you only compare the totals.
   */
  variance: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const isAdmin = ctx.rbac.permissions.includes(P.user.readAll);
      if (!(await canRead(ctx.db, input.id, ctx.rbac.id, isAdmin))) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      const [lines, reports] = await Promise.all([
        ctx.db.travelBudgetLine.findMany({
          where: { travelRequestId: input.id },
          select: {
            amountMinor: true,
            category: {
              select: { id: true, label: true, icon: true, expenseCategoryId: true },
            },
          },
        }),
        ctx.db.expenseReport.findMany({
          where: { travelRequestId: input.id },
          select: {
            id: true,
            number: true,
            status: true,
            expenses: {
              select: { lineItems: { select: { categoryId: true, amountMinor: true } } },
            },
          },
        }),
      ]);

      /** The travel label, keyed by the expense category it maps to — preferred over
       *  the accounting label for a row the traveller actually budgeted, since it is
       *  the name they picked from. */
      const travelLabelByExpense = new Map<string, { label: unknown; icon: string | null }>();
      const budgetLines: { categoryId: string; amountMinor: bigint }[] = [];
      const unmappable: {
        categoryId: string;
        label: unknown;
        icon: string | null;
        amountMinor: bigint;
      }[] = [];
      for (const l of lines) {
        const mapped = l.category.expenseCategoryId;
        if (mapped == null) {
          unmappable.push({
            categoryId: l.category.id,
            label: l.category.label,
            icon: l.category.icon,
            amountMinor: l.amountMinor,
          });
          continue;
        }
        budgetLines.push({ categoryId: mapped, amountMinor: l.amountMinor });
        if (!travelLabelByExpense.has(mapped)) {
          travelLabelByExpense.set(mapped, { label: l.category.label, icon: l.category.icon });
        }
      }

      const actualLines = reports.flatMap((r) => r.expenses.flatMap((e) => e.lineItems));
      const v = travelVariance({ budgetLines, actualLines });
      const categories = await ctx.db.expenseCategory.findMany({
        where: { id: { in: v.rows.map((r) => r.categoryId) } },
        select: { id: true, label: true, icon: true },
      });
      const byId = new Map(categories.map((c) => [c.id, c]));
      return {
        ...v,
        rows: v.rows.map((r) => {
          // Travel's own name where the traveller budgeted it; the accounting name for
          // unplanned spend, which no travel category was ever chosen for.
          const travel = travelLabelByExpense.get(r.categoryId);
          const expense = byId.get(r.categoryId);
          const category = travel
            ? { id: r.categoryId, label: travel.label, icon: travel.icon }
            : (expense ?? null);
          return { ...r, category };
        }),
        unmappable,
        reports: reports.map((r) => ({ id: r.id, number: r.number, status: r.status })),
      };
    }),

  /**
   * Turn an approved trip into an expense report skeleton.
   *
   * Idempotent: a second call returns the existing draft rather than making a rival
   * copy, which the legacy app did every time somebody pressed the button twice.
   * Available to the traveller (it is their report) and to an admin.
   */
  buildReport: withPermission(P.expense.report.createOwn)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const req = await ctx.db.travelRequest.findUnique({
        where: { id: input.id },
        select: { submitterId: true, status: true },
      });
      if (!req) throw new TRPCError({ code: 'NOT_FOUND' });
      const isAdmin = ctx.rbac.permissions.includes(P.user.readAll);
      if (req.submitterId !== ctx.rbac.id && !isAdmin) throw new TRPCError({ code: 'FORBIDDEN' });
      if (req.status !== 'APPROVED') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only an approved request can become an expense report.',
        });
      }
      try {
        return await withAudit(
          ctx.db,
          {
            action: auditActions.report.create,
            entityType: 'ExpenseReport',
            actor: actorOf(ctx),
            details: { fromTravelRequest: input.id },
          },
          (tx) => buildReportFromTravel(tx, input.id),
          (r) => r.reportId,
        );
      } catch (e) {
        // The one refusal worth naming: an already-submitted report is in an
        // approval chain, and generating a second copy of it would be worse than
        // saying no.
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('already has a submitted')) {
          throw new TRPCError({ code: 'CONFLICT', message });
        }
        throw e;
      }
    }),

  /** Approve or reject a task. Eligibility is `canDecide` — which is also what
   *  blocks self-approval, via the engine's TRAVEL_REQUEST owner lookup. The engine
   *  drives the request's status and snapshots the approved total. The override is
   *  `travel.request.decide.any` (it was `user.read.all`, which let an AP clerk or
   *  card administrator approve anybody's trip), and it is audited as an override. */
  decide: protectedProcedure
    .input(
      z.object({
        taskId: z.string().uuid(),
        approve: z.boolean(),
        note: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.db.approvalTask.findUnique({
        where: { id: input.taskId },
        select: {
          status: true,
          instance: { select: { subjectId: true, subjectType: true } },
        },
      });
      if (!task) throw new TRPCError({ code: 'NOT_FOUND' });
      if (task.instance.subjectType !== 'TRAVEL_REQUEST') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a travel approval task.' });
      }
      if (task.status !== 'PENDING') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Task already decided.' });
      }
      const access = await resolveDecideAccess(
        ctx.db,
        input.taskId,
        ctx.rbac.id,
        ctx.rbac.permissions.includes(P.travel.request.decideAny),
      );
      if (!access.allowed) throw new TRPCError({ code: 'FORBIDDEN' });
      const res = await withAudit(
        ctx.db,
        {
          action: input.approve ? auditActions.travel.approve : auditActions.travel.reject,
          entityType: 'TravelRequest',
          entityId: task.instance.subjectId,
          actor: actorOf(ctx),
          details: { taskId: input.taskId, note: input.note ?? null, override: access.override },
        },
        (tx) => decideTask(tx, input.taskId, input.approve, ctx.rbac.id, input.note ?? null),
      );

      // VeloExpense (w6-01): awaited on the request's transaction, under a savepoint.
      await bestEffort(ctx.db, 'decide', async () => {
        if (res.status === 'APPROVED' || res.status === 'REJECTED') {
          const activity = await recordTravelActivity(ctx.db, {
            subjectId: res.subjectId,
            type: res.status,
            actorId: ctx.rbac.id,
          });
          const request = await ctx.db.travelRequest.findUnique({
            where: { id: res.subjectId },
            select: { submitterId: true },
          });
          if (request && request.submitterId !== ctx.rbac.id) {
            await notifyRecipients(ctx.db, activity.id, [request.submitterId]);
          }
        }
        if (res.createdTaskIds.length > 0) {
          const activity = await recordTravelActivity(ctx.db, {
            subjectId: res.subjectId,
            type: 'TASK_ASSIGNED',
            actorId: ctx.rbac.id,
          });
          const approvers = await taskRecipientIds(ctx.db, res.createdTaskIds);
          await notifyRecipients(
            ctx.db,
            activity.id,
            approvers.filter((id) => id !== ctx.rbac.id),
          );
        }
      });

      // VeloExpense (w6-01): awaited, on the caller's transaction.
      await executeWorkflowEffects(ctx.db, {
        subjectType: 'TRAVEL_REQUEST',
        subjectId: res.subjectId,
        effectNodeIds: res.firedEffects,
        actorId: ctx.rbac.id,
      });
      return res;
    }),
});
