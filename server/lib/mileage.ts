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

/** Distances are carried as hundredths of a unit (×100) — the scale of
 *  `Decimal(12,2)` — so the arithmetic stays in BigInt. */
const SCALE = 100n;
/** Exact, by definition. */
const KM_PER_MI = 1.609344;

export type MileageDb = Pick<
  PrismaClient | Prisma.TransactionClient,
  'mileageRate' | 'expenseLineItem'
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

// ── Year-to-date basis ─────────────────────────────────────────────

/** Calendar year containing `on`, in UTC. The banded threshold is calendar-year
 *  and doesn't follow whatever the fiscal year happens to be. */
export function calendarYearBounds(on: Date): { start: Date; end: Date } {
  const y = on.getUTCFullYear();
  return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
}

/**
 * Distance this person has already claimed in `country` this calendar year,
 * returned in `unit` (×100).
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
export async function ytdDistanceScaled(
  db: MileageDb,
  params: {
    userId: string;
    country: string;
    on: Date;
    unit: MileageUnit;
    excludeLineItemId?: string;
  },
): Promise<bigint> {
  const { start, end } = calendarYearBounds(params.on);
  const rows = await db.expenseLineItem.findMany({
    where: {
      ...(params.excludeLineItemId ? { id: { not: params.excludeLineItemId } } : {}),
      mileageDistance: { not: null },
      expense: {
        ownerId: params.userId,
        date: { gte: start, lt: end },
        report: { status: { not: 'REJECTED' } },
      },
      // Only distance driven under a rule for the same country counts.
      mileageRate: { country: params.country },
    },
    select: { mileageDistance: true, mileageDistanceOverride: true, mileageUnit: true },
  });

  let total = 0n;
  for (const r of rows) {
    const d = r.mileageDistanceOverride ?? r.mileageDistance;
    if (!d) continue;
    const scaled = BigInt(d.mul(100).toFixed(0));
    // VeloExpense: the column is text with a CHECK (KM | MI, 0054), typed `string`.
    total += convertScaled(scaled, (r.mileageUnit as MileageUnit | null) ?? params.unit, params.unit);
  }
  return total;
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

const unscale = (v: bigint): string => `${v / SCALE}.${String(v % SCALE).padStart(2, '0')}`;

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
