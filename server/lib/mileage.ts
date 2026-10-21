/**
 * Mileage pricing (A7, rebuilt for tiered rules).
 *
 * A line in a mileage-flagged category captures a distance; its amount is DERIVED
 * rather than typed, and the client never supplies it.
 *
 * Three things drive the price:
 *
 *   1. WHICH RULE. Scope-matched by the traveller's country and the expense date.
 *      A car-allowance rule naming the traveller beats the country default.
 *   2. HOW FAR THEY'VE ALREADY GONE. Rates are banded on distance already claimed
 *      this calendar year, so the rule alone doesn't fix the price.
 *   3. WHERE THE CLAIM LANDS IN THE BANDS. A trip crossing a boundary is split
 *      per unit — 100 km at 0.75 and 100 at 0.73 — because that's how the tax
 *      rule bands. Whole-trip-at-one-rate is wrong at every boundary.
 *
 * Everything the price depended on is snapshotted onto the line. A rate can be
 * superseded and an earlier report can be edited; neither may change what a filed
 * claim says.
 */

import type { MileageUnit, Prisma, PrismaClient } from '@expenseos/db';
import { readerCurrencyCode } from '@/server/lib/readerCurrency';

/** Distances are carried as hundredths of a unit (×100) — the scale of
 *  `Decimal(12,2)` — so the arithmetic stays in BigInt. */
const SCALE = 100n;
/** Exact, by definition. */
const KM_PER_MI = 1.609344;

export type MileageDb = Pick<
  PrismaClient | Prisma.TransactionClient,
  'mileageRate' | 'expenseLineItem' | 'mileageOpeningBalance'
>;

/** Parse a "123.45" distance into hundredths of a unit, or null when malformed. */
export function distanceToScaled(value: string): bigint | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(2, '0'));
}

/** Legacy alias — `kmToScaled` predates rules being denominated in miles. */
export const kmToScaled = distanceToScaled;

/** `amountMinor = round(distance × rateMinor)`, distance scaled ×100. Half-up. */
export function computeMileageMinor(scaled: bigint, rateMinor: bigint): bigint {
  return (scaled * rateMinor + SCALE / 2n) / SCALE;
}

/** Convert a scaled distance between units. Identity when they match. */
export function convertScaled(scaled: bigint, from: MileageUnit, to: MileageUnit): bigint {
  if (from === to) return scaled;
  const factor = from === 'MI' ? KM_PER_MI : 1 / KM_PER_MI;
  return BigInt(Math.round(Number(scaled) * factor));
}

// ── Rule resolution ────────────────────────────────────────────────

export interface ResolvedRule {
  id: string;
  unit: MileageUnit;
  glAccountId: string | null;
  /** Ascending by `fromDistance`, scaled ×100. The first is always 0. */
  tiers: { fromScaled: bigint; rateMinor: bigint }[];
}

const RULE_SELECT = {
  id: true,
  unit: true,
  glAccountId: true,
  tiers: {
    select: { fromDistance: true, rateMinor: true },
    orderBy: { fromDistance: 'asc' as const },
  },
} as const;

function toResolved(row: {
  id: string;
  /** VeloExpense: text with a CHECK (KM | MI, 0052), so the client types it `string`. */
  unit: MileageUnit | string;
  glAccountId: string | null;
  tiers: { fromDistance: Prisma.Decimal; rateMinor: bigint }[];
}): ResolvedRule {
  return {
    id: row.id,
    unit: row.unit as MileageUnit,
    glAccountId: row.glAccountId,
    tiers: row.tiers.map((t) => ({
      fromScaled: BigInt(t.fromDistance.mul(100).toFixed(0)),
      rateMinor: t.rateMinor,
    })),
  };
}

/**
 * The rule governing `userId` in `country` on `on`.
 *
 * A car-allowance rule naming the traveller wins over the country default. Within
 * a scope only one rule can be in force at a time — the router refuses an overlap
 * — so this is a lookup, not a tie-break.
 */
export async function resolveMileageRule(
  db: MileageDb,
  country: string,
  userId: string,
  on: Date,
): Promise<ResolvedRule | null> {
  const inForce = {
    country,
    effectiveFrom: { lte: on },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
  };
  const specific = await db.mileageRate.findFirst({
    where: { ...inForce, subjects: { some: { userId } } },
    select: RULE_SELECT,
  });
  if (specific) return toResolved(specific);

  const general = await db.mileageRate.findFirst({
    where: { ...inForce, subjects: { none: {} } },
    select: RULE_SELECT,
  });
  return general ? toResolved(general) : null;
}

// ── The unit a new line opens in (FR-11) ───────────────────────────

/** What decides the default unit for one person: their own country, and their home
 *  currency by the shared rule — VeloExpense (d92): their legal entity's, else the tenant's
 *  main entity's, else CAD (`readerCurrencyCode`); there is no per-person currency. */
export interface MileageUnitOwner {
  /** `User.country`, ISO-3166-1 alpha-2, or null when it was never set. */
  country: string | null;
  /** The person's home currency code (ISO-4217), already resolved by the shared rule. */
  homeCurrencyCode: string;
}

/**
 * The unit a NEW mileage line opens and prices in, for the person the claim is for.
 *
 * Miles when that person lives in the United States, or is paid in US dollars; kilometres
 * otherwise. Always the expense OWNER (`Expense.ownerId`): a delegate or a reader who works
 * in kilometres, filing for an American, still sees miles, because the trip is the owner's.
 * The report's currency never decides it, and the entity's currency counts only as a link
 * in the owner's own home-currency chain, never on its own.
 *
 * Only the default: a saved line keeps its stored unit and never reads this, and the
 * server still stores every line in its mileage rule's unit (`computeLineFinancials`).
 */
export function defaultMileageUnitFor(owner: MileageUnitOwner): MileageUnit {
  if (owner.country?.trim().toUpperCase() === 'US') return 'MI';
  return owner.homeCurrencyCode.trim().toUpperCase() === 'USD' ? 'MI' : 'KM';
}

/**
 * {@link defaultMileageUnitFor} for every owner on one read, keyed by user id.
 *
 * Batched by DISTINCT owner, never per expense: one `user.findMany` for the countries, and
 * the shared currency chain once per owner. A report's expenses almost always share one
 * owner, so that is two reads for the whole report. An id with no user row reads as no
 * country and the currency floor — kilometres — like any unknown person.
 */
export async function defaultMileageUnitsFor(
  db: PrismaClient,
  ownerIds: readonly string[],
): Promise<Map<string, MileageUnit>> {
  const ids = [...new Set(ownerIds)];
  if (ids.length === 0) return new Map();
  const [owners, currencies] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids } }, select: { id: true, country: true } }),
    Promise.all(ids.map((id) => readerCurrencyCode(db, id))),
  ]);
  const countryOf = new Map(owners.map((o) => [o.id, o.country]));
  return new Map(
    ids.map((id, i) => [
      id,
      defaultMileageUnitFor({
        country: countryOf.get(id) ?? null,
        homeCurrencyCode: currencies[i],
      }),
    ]),
  );
}

// ── Year-to-date basis ─────────────────────────────────────────────

/** Calendar year containing `on`, in UTC. The banded threshold is calendar-year
 *  and doesn't follow whatever the fiscal year happens to be. */
export function calendarYearBounds(on: Date): { start: Date; end: Date } {
  const y = on.getUTCFullYear();
  return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
}

/** What a person's year-to-date mileage basis is made of. All distances ×100, in `unit`. */
export interface YtdBasis {
  /** The basis the bands are priced from: carried over + claimed in ExpenseOS. */
  totalScaled: bigint;
  /** Carried over from another system (the upload in force), 0 when there is none. */
  carriedScaled: bigint;
  /** The upload's period end: ExpenseOS mileage dated on or before it is covered by it. */
  carriedThrough: Date | null;
}

/**
 * Distance this person has already claimed in `country` this calendar year, returned in
 * `unit` (×100) with what it is made of.
 *
 * Two parts:
 *
 *   - CARRIED OVER: the distance another system (Concur) had already paid them this year,
 *     from the upload in force (`MileageOpeningBalance`). People arrive part-way through a
 *     year, and starting them at zero would pay the first-band rate again on kilometres
 *     they already drove.
 *   - CLAIMED HERE: ExpenseOS mileage lines this year — only those dated AFTER the upload's
 *     period end when there is one, because the other system already counted that period.
 *
 * Counts every state except REJECTED: the tier is about distance actually driven,
 * and quoting a rate at entry time that changes on approval is worse than a
 * deleted draft rolling the basis back.
 *
 * Per country as well as per person — pooling Canadian kilometres with American
 * miles into one threshold would price both wrong.
 *
 * `excludeLineItemId` drops the line being repriced so an edit doesn't count
 * itself.
 */
export async function ytdBasis(
  db: MileageDb,
  params: {
    userId: string;
    country: string;
    on: Date;
    unit: MileageUnit;
    excludeLineItemId?: string;
  },
): Promise<YtdBasis> {
  const { start, end } = calendarYearBounds(params.on);
  const balances = await db.mileageOpeningBalance.findMany({
    where: {
      userId: params.userId,
      country: params.country,
      import: { year: start.getUTCFullYear(), supersededAt: null },
    },
    select: { distance: true, unit: true, import: { select: { asOf: true } } },
  });
  let carriedScaled = 0n;
  let carriedThrough: Date | null = null;
  for (const b of balances) {
    // VeloExpense: the unit is text with a CHECK (KM | MI, 0081), typed `string`.
    carriedScaled += convertScaled(
      BigInt(b.distance.mul(100).toFixed(0)),
      b.unit as MileageUnit,
      params.unit,
    );
    if (!carriedThrough || b.import.asOf > carriedThrough) carriedThrough = b.import.asOf;
  }

  const rows = await db.expenseLineItem.findMany({
    where: {
      ...(params.excludeLineItemId ? { id: { not: params.excludeLineItemId } } : {}),
      mileageDistance: { not: null },
      expense: {
        ownerId: params.userId,
        // After the carried-over period, when there is one: that period is in the balance.
        date: carriedThrough ? { gt: carriedThrough, lt: end } : { gte: start, lt: end },
        report: { status: { not: 'REJECTED' } },
      },
      // Only distance driven under a rule for the same country counts.
      mileageRate: { country: params.country },
    },
    select: { mileageDistance: true, mileageDistanceOverride: true, mileageUnit: true },
  });

  let claimed = 0n;
  for (const r of rows) {
    const d = r.mileageDistanceOverride ?? r.mileageDistance;
    if (!d) continue;
    const scaled = BigInt(d.mul(100).toFixed(0));
    // VeloExpense: the column is text with a CHECK (KM | MI, 0054), typed `string`.
    claimed += convertScaled(scaled, (r.mileageUnit as MileageUnit | null) ?? params.unit, params.unit);
  }
  return { totalScaled: carriedScaled + claimed, carriedScaled, carriedThrough };
}

/** The year-to-date basis alone — see {@link ytdBasis}. */
export async function ytdDistanceScaled(
  db: MileageDb,
  params: Parameters<typeof ytdBasis>[1],
): Promise<bigint> {
  return (await ytdBasis(db, params)).totalScaled;
}

// ── Banded pricing ─────────────────────────────────────────────────

export interface MileageSegment {
  /** Band's lower bound, in the rule's unit. */
  fromDistance: string;
  rateMinor: string;
  /** Distance billed in this band, in the rule's unit. */
  distance: string;
  amountMinor: string;
}

export interface PricedMileage {
  amountMinor: bigint;
  segments: MileageSegment[];
}

/** A scaled distance (×100) as its `"N.NN"` string — the form segments and the wire carry. */
export const unscale = (v: bigint): string => `${v / SCALE}.${String(v % SCALE).padStart(2, '0')}`;

/** Where a year-to-date total sits in a rule's bands. All distances ×100, in the rule's unit. */
export interface BandPosition {
  /** Index into the tiers of the band the total is in. */
  index: number;
  /** That band's lower bound. */
  fromScaled: bigint;
  /** The next band's lower bound; null in the top band. */
  nextScaled: bigint | null;
  /** Distance left before the next band; null in the top band. */
  remainingScaled: bigint | null;
}

/**
 * The band `totalScaled` is in: the last tier whose lower bound it has reached.
 *
 * Inclusive, by the same rule {@link priceMileage} prices with — exactly on a boundary
 * is already the upper band. `null` for a rule with no tiers, which breaks
 * `ResolvedRule`'s "the first is always 0" and so has no band to name.
 */
export function bandPosition(
  tiers: ResolvedRule['tiers'],
  totalScaled: bigint,
): BandPosition | null {
  if (tiers.length === 0) return null;
  let index = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    if (tiers[i].fromScaled <= totalScaled) index = i;
  }
  const nextScaled = tiers[index + 1]?.fromScaled ?? null;
  return {
    index,
    fromScaled: tiers[index].fromScaled,
    nextScaled,
    remainingScaled: nextScaled === null ? null : nextScaled - totalScaled,
  };
}

/**
 * Price `distanceScaled` starting from `ytdScaled`, splitting at every band
 * boundary it crosses.
 *
 * Rounding is per SEGMENT, not on the total: each band's amount is what the
 * breakdown shows, and a total that didn't equal the sum of its own lines would
 * be indefensible in a review.
 */
export function priceMileage(
  tiers: readonly { fromScaled: bigint; rateMinor: bigint }[],
  ytdScaled: bigint,
  distanceScaled: bigint,
): PricedMileage {
  const segments: MileageSegment[] = [];
  let remaining = distanceScaled;
  let cursor = ytdScaled;
  let total = 0n;

  while (remaining > 0n && tiers.length > 0) {
    // The last band whose lower bound the cursor has reached.
    let idx = 0;
    for (let i = 0; i < tiers.length; i += 1) {
      if (tiers[i].fromScaled <= cursor) idx = i;
    }
    const tier = tiers[idx];
    const nextBoundary = tiers[idx + 1]?.fromScaled;
    // Room left in this band; unbounded on the top band.
    const room = nextBoundary === undefined ? remaining : nextBoundary - cursor;
    const take = room < remaining ? room : remaining;
    // Defensive: a non-positive take would spin. Can only happen if the cursor
    // sits exactly on a boundary the loop didn't advance past.
    if (take <= 0n) break;

    const amount = computeMileageMinor(take, tier.rateMinor);
    segments.push({
      fromDistance: unscale(tier.fromScaled),
      rateMinor: tier.rateMinor.toString(),
      distance: unscale(take),
      amountMinor: amount.toString(),
    });
    total += amount;
    cursor += take;
    remaining -= take;
  }

  return { amountMinor: total, segments };
}
