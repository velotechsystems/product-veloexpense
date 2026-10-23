/**
 * Mileage opening balances — carrying another system's year-to-date mileage (Concur) into
 * the ExpenseOS mileage bands.
 *
 * Mileage is banded on distance claimed in the calendar year: the first 5,000 km at one rate,
 * the rest at another. People arrive in ExpenseOS part-way through a year, and starting them
 * at zero would pay the first-band rate again on kilometres they had already driven. An admin
 * uploads the other system's year-to-date file; each person's distance becomes their opening
 * balance, and the engine (`ytdBasis`) adds it to the ExpenseOS mileage dated after the file's
 * period end.
 *
 * EVOLUTIONARY: every upload supersedes the previous one for its (source, year). A year-to-date
 * export is cumulative, so the newest file is the truth; the earlier ones stay as history.
 *
 * Two steps, so nothing is written before a person has seen it:
 *   - `preview` matches each name to a person and compares the file with the upload in force;
 *   - `commit` writes the upload, puts anybody paid a non-standard rate on a car-allowance
 *     rule at that rate, and re-prices the draft mileage of everybody whose balance moved.
 *
 * The file itself is parsed in the browser and never stored.
 */

import { auditActions, withAudit } from '@expenseos/audit';
import {
  type ExpenseReportStatus,
  type MileageUnit,
  Prisma,
  type PrismaClient,
} from '@expenseos/db';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  bandPosition,
  calendarYearBounds,
  convertScaled,
  resolveMileageRule,
  unscale,
  ytdBasis,
} from '@/server/lib/mileage';
import { buildNameMatcher, type NameMatch } from '@/server/lib/mileageBalanceMatch';
import { protectedProcedure, router, withPermission } from '@/server/trpc';
import { recomputeTotals, repriceMileageLines } from './expenses';

type Db = PrismaClient | Prisma.TransactionClient;

const SOURCE = z.enum(['concur']);
const DECIMAL = z.string().regex(/^\d{1,9}(\.\d{1,4})?$/);
/** The country the file's distances belong to. The file is CAD and in kilometres. */
const DEFAULT_COUNTRY = 'CA';
const DEFAULT_UNIT: MileageUnit = 'KM';
/** An approved amount this far from distance × rate is worth a second look. */
const AMOUNT_TOLERANCE = 0.1;

const rowInput = z.object({
  /** The name exactly as the file wrote it. */
  name: z.string().trim().min(1).max(200),
  distance: DECIMAL,
  paidRate: DECIMAL.nullable(),
  amount: DECIMAL.nullable(),
});

const fileInput = z.object({
  source: SOURCE,
  year: z.number().int().min(2000).max(2100),
  /** The file's period end (UTC date). */
  asOf: z.coerce.date(),
  filename: z.string().trim().min(1).max(255),
});

const toMinor = (rate: string) => BigInt(Math.round(Number(rate) * 100));

/** The upload in force for a source and year, with its balances. */
async function inForce(db: Db, source: string, year: number) {
  return db.mileageBalanceImport.findFirst({
    where: { source, year, supersededAt: null },
    select: {
      id: true,
      asOf: true,
      balances: { select: { userId: true, distance: true, sourceName: true } },
    },
  });
}

/** The country-default rule's bands in force on `on` — what a standard rate looks like. */
async function defaultBands(db: Db, country: string, on: Date) {
  const rule = await db.mileageRate.findFirst({
    where: {
      country,
      subjects: { none: {} },
      effectiveFrom: { lte: on },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: {
      tiers: { orderBy: { fromDistance: 'asc' }, select: { fromDistance: true, rateMinor: true } },
    },
  });
  return (rule?.tiers ?? []).map((t) => ({
    from: Number(t.fromDistance),
    rate: Number(t.rateMinor),
  }));
}

/** What the standard bands pay for `distance` from zero, in minor units. */
function bandedAmount(bands: { from: number; rate: number }[], distance: number): number {
  let total = 0;
  for (const [i, band] of bands.entries()) {
    const to = bands[i + 1]?.from ?? Number.POSITIVE_INFINITY;
    if (distance <= band.from) break;
    total += (Math.min(distance, to) - band.from) * band.rate;
  }
  return total;
}

// ── Year to date for one person (`ytdForUser`) ────────────────────

/**
 * Where a report's mileage counts in a person's year to date. Every status is named, so a
 * status added to the enum fails typecheck here until somebody decides where it belongs.
 *
 *   - `pending`: counted in the basis, not yet approved — a draft, a report in its approval
 *     chain (the engine's RUNNING is SUBMITTED), or one sent back;
 *   - `approved`: counted, and approved;
 *   - `excluded`: never counted — the engine leaves REJECTED out of the basis (`ytdBasis`).
 */
export const STATUS_BUCKET = {
  DRAFT: 'pending',
  SUBMITTED: 'pending',
  RETURNED: 'pending',
  APPROVED: 'approved',
  REIMBURSED: 'approved',
  REJECTED: 'excluded',
} as const satisfies Record<ExpenseReportStatus, 'pending' | 'approved' | 'excluded'>;

/** The statuses whose mileage counts toward the basis, read from {@link STATUS_BUCKET}. */
const COUNTED_STATUSES = (Object.keys(STATUS_BUCKET) as ExpenseReportStatus[]).filter(
  (s) => STATUS_BUCKET[s] !== 'excluded',
);

/**
 * One country of a person's mileage year to date. Distances are `"N.NN"` strings in `unit`;
 * dates are UTC midnights (an expense date, an upload's period end).
 */
export interface MileageYtdRow {
  /** ISO-2 — the bands are kept per country, never pooled. */
  country: string;
  /** The rule's unit; without a rule, the balance's, else the latest line's, else KM. */
  unit: MileageUnit;
  /** Carried over from another system (the upload in force). */
  carried: string;
  /** Claimed in ExpenseOS after the carry-over's period end: `total − carried`. */
  claimed: string;
  /** The part of `claimed` on reports not yet approved (DRAFT, SUBMITTED, RETURNED). */
  pending: string;
  /** The basis the bands price from — exactly `ytdBasis().totalScaled`. */
  total: string;
  /** The carry-over's period end; null without one. */
  carriedThrough: Date | null;
  /** The rule in force on the reference date; null when none, or when it has no tiers. */
  rule: {
    ruleId: string;
    /** A rule naming people (a car allowance), not the country default. */
    isCarAllowance: boolean;
    /** Ascending. `fromDistance` in `unit`; `rateMinor` per unit, in minor currency units. */
    tiers: { fromDistance: string; rateMinor: string }[];
  } | null;
  /** 0-based index into `rule.tiers` of the band `total` is in; null without a rule. */
  bandIndex: number | null;
  /** That band's lower bound. */
  bandFrom: string | null;
  /** The next band's lower bound; null in the top band (and for a single-tier rule). */
  nextBoundary: string | null;
  /** Distance left before `nextBoundary`. */
  remaining: string | null;
  /**
   * The date of the ExpenseOS line that took the total to `bandFrom`. Null in the first band,
   * and when the carry-over alone was already past it — the other system's crossing date is
   * not known, and its period end is not that date.
   */
  crossedAt: Date | null;
}

const scaledOf = (d: Prisma.Decimal) => BigInt(d.mul(100).toFixed(0));

/**
 * A person's year to date, per country, as {@link MileageYtdRow}s sorted by country.
 *
 * `total`, `carried` and `carriedThrough` come straight from `ytdBasis`, the figure pricing
 * uses, so the row cannot disagree with a line's price. `ytdBasis` returns no per-line detail,
 * so one more read of the same lines feeds `pending` and `crossedAt`; its filter mirrors the
 * engine's (owner, calendar year, counted status, a rule naming a country, after the
 * carry-over), and a db test holds the two to the same total.
 *
 * Reads: the balances and the lines once, then per country `ytdBasis` (2) and
 * `resolveMileageRule` (1–2), then one batched car-allowance lookup.
 */
async function ytdRows(
  db: PrismaClient,
  params: { userId: string; on: Date },
): Promise<MileageYtdRow[]> {
  const { userId, on } = params;
  const { start, end } = calendarYearBounds(on);

  // The same in-force uploads `ytdBasis` reads: any source, this year, not superseded.
  const balances = await db.mileageOpeningBalance.findMany({
    where: { userId, import: { year: start.getUTCFullYear(), supersededAt: null } },
    select: { id: true, country: true, unit: true, import: { select: { asOf: true } } },
  });
  const lines = await db.expenseLineItem.findMany({
    where: {
      mileageDistance: { not: null },
      // A line whose rule was deleted has no country, and the engine never counts it.
      mileageRateId: { not: null },
      expense: {
        ownerId: userId,
        date: { gte: start, lt: end },
        report: { status: { in: COUNTED_STATUSES } },
      },
    },
    // Date order, so the walk meets the trips in the order they were driven. Never id
    // order: a back-dated trip entered late still counts on its own date.
    orderBy: [{ expense: { date: 'asc' } }, { id: 'asc' }],
    select: {
      mileageDistance: true,
      mileageDistanceOverride: true,
      mileageUnit: true,
      mileageRate: { select: { country: true } },
      expense: { select: { date: true, report: { select: { status: true } } } },
    },
  });

  const countries = [
    ...new Set([
      ...balances.map((b) => b.country),
      ...lines.flatMap((l) => (l.mileageRate ? [l.mileageRate.country] : [])),
    ]),
  ].sort();

  const perCountry = await Promise.all(
    countries.map(async (country) => {
      const ownLines = lines.filter((l) => l.mileageRate?.country === country);
      const resolved = await resolveMileageRule(db, country, userId, on);
      // A rule without tiers breaks "the first tier is always 0" and names no band.
      const rule = resolved && resolved.tiers.length > 0 ? resolved : null;
      const unit = rule?.unit ?? fallbackUnit(balances, ownLines, country);
      const basis = await ytdBasis(db, { userId, country, on, unit });
      return { country, ownLines, rule, unit, basis };
    }),
  );

  const ruleIds = perCountry.flatMap((c) => (c.rule ? [c.rule.id] : []));
  const allowances = new Set(
    ruleIds.length === 0
      ? []
      : (
          await db.mileageRate.findMany({
            where: { id: { in: ruleIds }, subjects: { some: {} } },
            select: { id: true },
          })
        ).map((r) => r.id),
  );

  const rows: MileageYtdRow[] = [];
  for (const { country, ownLines, rule, unit, basis } of perCountry) {
    const { totalScaled, carriedScaled, carriedThrough } = basis;
    // Nothing carried, nothing claimed, no line at all: nothing to say about this country.
    if (totalScaled === 0n && carriedScaled === 0n && ownLines.length === 0) continue;

    const band = rule ? bandPosition(rule.tiers, totalScaled) : null;
    // The engine's window: after the carry-over's period end, which it already counted.
    const counted = carriedThrough
      ? // VeloExpense: `expense.date` is nullable; the query's date window already excludes null.
        ownLines.filter((l) => l.expense.date !== null && l.expense.date > carriedThrough)
      : ownLines;
    let pendingScaled = 0n;
    let running = carriedScaled;
    let crossedAt: Date | null = null;
    // First band, or the carry-over alone already at the band's floor: no line crossed it.
    let crossed = band === null || band.index === 0 || running >= band.fromScaled;
    for (const l of counted) {
      const d = l.mileageDistanceOverride ?? l.mileageDistance;
      if (!d) continue;
      // Per line, as `ytdBasis` converts, so the sums round identically.
      const scaled = convertScaled(scaledOf(d), (l.mileageUnit as MileageUnit | null) ?? unit, unit);
      if (STATUS_BUCKET[l.expense.report.status] === 'pending') pendingScaled += scaled;
      running += scaled;
      if (!crossed && band && running >= band.fromScaled) {
        crossed = true;
        crossedAt = l.expense.date;
      }
    }

    rows.push({
      country,
      unit,
      carried: unscale(carriedScaled),
      claimed: unscale(totalScaled - carriedScaled),
      pending: unscale(pendingScaled),
      total: unscale(totalScaled),
      carriedThrough,
      rule: rule
        ? {
            ruleId: rule.id,
            isCarAllowance: allowances.has(rule.id),
            tiers: rule.tiers.map((t) => ({
              fromDistance: unscale(t.fromScaled),
              rateMinor: t.rateMinor.toString(),
            })),
          }
        : null,
      bandIndex: band?.index ?? null,
      bandFrom: band ? unscale(band.fromScaled) : null,
      nextBoundary: band?.nextScaled != null ? unscale(band.nextScaled) : null,
      remaining: band?.remainingScaled != null ? unscale(band.remainingScaled) : null,
      crossedAt,
    });
  }
  return rows;
}

/**
 * The unit a country's basis is read in when no rule is in force: the balance's (an explicit
 * stored value for that country; the latest upload's when there are several), else the unit
 * of the person's latest line there (the rule that priced it), else KM.
 */
function fallbackUnit(
  // VeloExpense: both units are text with a CHECK (KM | MI), typed `string`.
  balances: { id: string; country: string; unit: MileageUnit | string; import: { asOf: Date } }[],
  lines: { mileageUnit: MileageUnit | string | null }[],
  country: string,
): MileageUnit {
  const [balance] = balances
    .filter((b) => b.country === country)
    .sort((a, b) => b.import.asOf.getTime() - a.import.asOf.getTime() || (a.id < b.id ? 1 : -1));
  if (balance) return balance.unit as MileageUnit;
  // `lines` is in date order, so the last one with a unit is the latest.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const lineUnit = lines[i].mileageUnit;
    if (lineUnit) return lineUnit as MileageUnit;
  }
  return 'KM';
}

export const mileageBalancesRouter = router({
  /**
   * Match a parsed file to people and compare it with the upload in force. Writes nothing.
   */
  preview: withPermission(P.config.mileageUpdate)
    .input(fileInput.extend({ rows: z.array(rowInput).min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      const current = await inForce(ctx.db, input.source, input.year);
      const people = await ctx.db.user.findMany({
        select: { id: true, firstName: true, lastName: true, email: true, deletedAt: true },
      });
      const remembered = new Map(
        (current?.balances ?? []).map((b) => [b.sourceName.trim(), b.userId] as const),
      );
      const match = buildNameMatcher(
        people.map((p) => ({ ...p, deactivated: p.deletedAt !== null })),
        remembered,
      );
      const bands = await defaultBands(ctx.db, DEFAULT_COUNTRY, input.asOf);
      const standardRates = new Set(bands.map((b) => b.rate));
      const previousKm = new Map(
        (current?.balances ?? []).map((b) => [b.userId, b.distance.toString()] as const),
      );

      const rows = input.rows.map((row) => {
        const matched: NameMatch = match(row.name);
        const distance = Number(row.distance);
        // A zero rate is "not reported", not a 0¢ allowance.
        const rate =
          row.paidRate && Number(row.paidRate) > 0 ? Number(toMinor(row.paidRate)) : null;
        const carAllowance = rate !== null && standardRates.size > 0 && !standardRates.has(rate);
        const flags: string[] = [];
        if (rate !== null && !carAllowance && bands.length > 1) {
          // The rate a person was last paid should be the band their distance sits in.
          const expected = [...bands].reverse().find((b) => distance >= b.from)?.rate;
          if (expected !== undefined && expected !== rate) flags.push('rateBand');
        }
        if (row.amount && rate !== null) {
          const expected = carAllowance ? distance * rate : bandedAmount(bands, distance);
          const amount = Number(row.amount) * 100;
          if (expected > 0 && Math.abs(amount - expected) / expected > AMOUNT_TOLERANCE) {
            flags.push('amount');
          }
        }
        const userId = 'userId' in matched ? matched.userId : null;
        return {
          ...row,
          match: matched,
          carAllowance,
          previousDistance: userId ? (previousKm.get(userId) ?? null) : null,
          flags,
        };
      });

      const candidateIds = new Set(
        rows.flatMap((r) =>
          r.match.status === 'ambiguous'
            ? r.match.candidateIds
            : 'userId' in r.match
              ? [r.match.userId]
              : [],
        ),
      );
      for (const id of previousKm.keys()) candidateIds.add(id);
      return {
        rows,
        /** People referenced by `rows` and `previous`, for display. */
        people: people
          .filter((p) => candidateIds.has(p.id))
          .map((p) => ({
            id: p.id,
            name: [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email,
            email: p.email,
            deactivated: p.deletedAt !== null,
          })),
        /** The upload in force — what this one would supersede. */
        current: current
          ? {
              id: current.id,
              asOf: current.asOf,
              balances: current.balances.map((b) => ({
                userId: b.userId,
                distance: b.distance.toString(),
              })),
            }
          : null,
        /** An upload older than the one in force cannot replace it. */
        stale: current !== null && input.asOf < current.asOf,
      };
    }),

  /**
   * Write the upload. Supersedes the one in force, keeps the car-allowance rule in step with
   * whoever was paid a non-standard rate, and re-prices draft mileage that the change moves.
   */
  commit: withPermission(P.config.mileageUpdate)
    .input(
      fileInput.extend({
        rows: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              userId: z.string().uuid(),
              distance: DECIMAL,
              paidRate: DECIMAL.nullable(),
            }),
          )
          .min(1)
          .max(5000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const seen = new Set<string>();
      for (const r of input.rows) {
        if (seen.has(r.userId)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `${r.name}: that person already has a row in this file.`,
          });
        }
        seen.add(r.userId);
      }
      // f77: one commit at a time per tenant, source and year. Two admins committing the same
      // year at once would otherwise both read the same upload in force (or none), and both
      // uploads would stay in force: a partial unique index cannot help, because the new row
      // is written before the old one is superseded. This transaction-scoped advisory lock
      // is held until the request's tenant transaction ends; the second commit waits, then
      // reads the first one's upload as the one in force and supersedes it (or is refused
      // as older). Keyed on the tenant too, so different tenants never wait on each other.
      await ctx.db.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(
          'mileage_balance_import:' || current_setting('app.current_org', true) || ':' || ${input.source} || ':' || ${String(input.year)},
          0
        ))`;
      const current = await inForce(ctx.db, input.source, input.year);
      if (current && input.asOf < current.asOf) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `This file ends ${input.asOf.toISOString().slice(0, 10)}, before the upload in force (${current.asOf.toISOString().slice(0, 10)}). An older file cannot replace a newer one.`,
        });
      }
      const { start } = calendarYearBounds(new Date(Date.UTC(input.year, 0, 1)));
      if (input.asOf.getUTCFullYear() !== input.year) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `The file's period ends in ${input.asOf.getUTCFullYear()}, not ${input.year}.`,
        });
      }

      const users = await ctx.db.user.findMany({
        where: { id: { in: [...seen] } },
        select: { id: true, country: true },
      });
      const countryOf = new Map(users.map((u) => [u.id, u.country ?? DEFAULT_COUNTRY]));
      if (users.length !== seen.size) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A matched person no longer exists.' });
      }

      // Who moved: new, changed or dropped since the upload in force.
      const before = new Map(
        (current?.balances ?? []).map((b) => [b.userId, b.distance.toString()] as const),
      );
      const moved = new Set<string>();
      for (const r of input.rows) {
        const was = before.get(r.userId);
        if (was === undefined || Number(was) !== Number(r.distance)) moved.add(r.userId);
      }
      const dropped = [...before.keys()].filter((id) => !seen.has(id));
      for (const id of dropped) moved.add(id);

      // Car allowances: everybody paid a rate the country default does not have.
      const bands = await defaultBands(ctx.db, DEFAULT_COUNTRY, input.asOf);
      const standardRates = new Set(bands.map((b) => b.rate));
      const allowanceGroups = new Map<number, string[]>();
      for (const r of input.rows) {
        if (!r.paidRate || Number(r.paidRate) <= 0 || standardRates.size === 0) continue;
        const rate = Number(toMinor(r.paidRate));
        if (standardRates.has(rate)) continue;
        allowanceGroups.set(rate, [...(allowanceGroups.get(rate) ?? []), r.userId]);
      }

      const actor = {
        kind: 'user' as const,
        id: ctx.rbac.id,
        name: ctx.session.user.name ?? ctx.session.user.email,
        roleLabel: ctx.rbac.roleLabel,
      };
      const now = new Date();

      const result = await withAudit(
        ctx.db,
        {
          action: auditActions.config('mileageBalanceImport'),
          entityType: 'MileageBalanceImport',
          actor,
          details: {
            source: input.source,
            year: input.year,
            asOf: input.asOf.toISOString().slice(0, 10),
            filename: input.filename,
            people: input.rows.length,
            supersedes: current?.id ?? null,
            balancesChanged: moved.size,
            dropped: dropped.length,
          },
        },
        async (tx) => {
          const created = await tx.mileageBalanceImport.create({
            data: {
              source: input.source,
              year: input.year,
              asOf: input.asOf,
              filename: input.filename,
              importedById: ctx.rbac.id,
              balances: {
                create: input.rows.map((r) => ({
                  userId: r.userId,
                  country: countryOf.get(r.userId) ?? DEFAULT_COUNTRY,
                  unit: DEFAULT_UNIT,
                  distance: new Prisma.Decimal(r.distance),
                  sourceName: r.name,
                  paidRate: r.paidRate ? new Prisma.Decimal(r.paidRate) : null,
                })),
              },
            },
            select: { id: true },
          });
          if (current) {
            await tx.mileageBalanceImport.update({
              where: { id: current.id },
              data: { supersededAt: now, supersededById: created.id },
            });
          }

          const allowances = await syncCarAllowances(tx, {
            country: DEFAULT_COUNTRY,
            yearStart: start,
            now,
            groups: allowanceGroups,
            inFile: seen,
            standardRates,
            actorId: ctx.rbac.id,
          });
          for (const ids of allowanceGroups.values()) for (const id of ids) moved.add(id);
          for (const id of allowances.released) moved.add(id);

          // Draft mileage of everybody whose basis or rule moved is re-priced; anything
          // already submitted keeps the price it was submitted with.
          const drafts = await tx.expense.findMany({
            where: {
              ownerId: { in: [...moved] },
              date: { gte: start, lt: new Date(Date.UTC(input.year + 1, 0, 1)) },
              report: { status: { in: ['DRAFT', 'RETURNED'] } },
              lineItems: { some: { kind: 'MILEAGE', mileageDistance: { not: null } } },
            },
            select: { id: true },
          });
          let repriced = 0;
          for (const d of drafts) repriced += await repriceMileageLines(tx, d.id);
          return {
            id: created.id,
            expenseIds: drafts.map((d) => d.id),
            repriced,
            carAllowances: allowances.summary,
          };
        },
        (r) => r.id,
      );
      for (const expenseId of result.expenseIds) await recomputeTotals(ctx.db, expenseId);
      return {
        id: result.id,
        people: input.rows.length,
        moved: moved.size,
        dropped: dropped.length,
        repricedLines: result.repriced,
        carAllowances: result.carAllowances,
      };
    }),

  /** Every upload for a source and year, newest first. */
  imports: withPermission(P.config.policyRead)
    .input(z.object({ source: SOURCE, year: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.mileageBalanceImport.findMany({
        where: { source: input.source, year: input.year },
        orderBy: { importedAt: 'desc' },
        select: {
          id: true,
          asOf: true,
          filename: true,
          importedAt: true,
          supersededAt: true,
          importedBy: { select: { firstName: true, lastName: true, email: true } },
          _count: { select: { balances: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        asOf: r.asOf,
        filename: r.filename,
        importedAt: r.importedAt,
        inForce: r.supersededAt === null,
        supersededAt: r.supersededAt,
        importedBy:
          [r.importedBy.firstName, r.importedBy.lastName].filter(Boolean).join(' ') ||
          r.importedBy.email,
        people: r._count.balances,
      }));
    }),

  /** What one upload contained. */
  importDetail: withPermission(P.config.policyRead)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const balances = await ctx.db.mileageOpeningBalance.findMany({
        where: { importId: input.id },
        orderBy: { sourceName: 'asc' },
        select: {
          id: true,
          sourceName: true,
          distance: true,
          unit: true,
          paidRate: true,
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      });
      return balances.map((b) => ({
        id: b.id,
        sourceName: b.sourceName,
        distance: b.distance.toString(),
        unit: b.unit,
        paidRate: b.paidRate?.toString() ?? null,
        user: {
          id: b.user.id,
          name: [b.user.firstName, b.user.lastName].filter(Boolean).join(' ') || b.user.email,
          email: b.user.email,
        },
      }));
    }),

  /** A person's carried-over distance in force, for their profile. */
  forUser: withPermission(P.config.policyRead)
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.mileageOpeningBalance.findMany({
        where: { userId: input.userId, import: { supersededAt: null } },
        orderBy: { import: { year: 'desc' } },
        select: {
          distance: true,
          unit: true,
          country: true,
          import: { select: { source: true, year: true, asOf: true } },
        },
      });
      return rows.map((r) => ({
        source: r.import.source,
        year: r.import.year,
        asOf: r.import.asOf,
        country: r.country,
        distance: r.distance.toString(),
        unit: r.unit,
      }));
    }),

  /**
   * Where a person stands in the mileage bands this year, per country: the basis (carried
   * over + claimed here, with the part not yet approved), the rule in force, and the band
   * the total is in. For the People drawer and the person's own profile.
   *
   * Anybody with policy-read may read anybody, themselves included; a person with only
   * read-own may read themselves. Identity is `ctx.rbac.id`, the id the permissions were
   * resolved for. An unknown person reads as `[]`, never NOT_FOUND. A read: no audit row.
   *
   * `year` defaults to the current UTC calendar year (the bands are calendar-year, not
   * fiscal). The rule is the one in force now, or on 31 December of a past year.
   */
  ytdForUser: protectedProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        year: z.number().int().min(2000).max(2100).optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<MileageYtdRow[]> => {
      // Deny by default, before anything is read. The message names the one permission
      // that would unlock this target.
      const perms = ctx.rbac.permissions;
      const isSelf = input.userId === ctx.rbac.id;
      const allowed =
        perms.includes(P.config.policyRead) || (isSelf && perms.includes(P.expense.report.readOwn));
      if (!allowed) {
        const missing = isSelf ? P.expense.report.readOwn : P.config.policyRead;
        throw new TRPCError({ code: 'FORBIDDEN', message: `Missing permission: ${missing}` });
      }

      const now = new Date();
      const thisYear = now.getUTCFullYear();
      const year = input.year ?? thisYear;
      if (year > thisYear) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${year} has not started yet. Choose ${thisYear} or an earlier year.`,
        });
      }
      const on = year === thisYear ? now : new Date(Date.UTC(year, 11, 31));
      return ytdRows(ctx.db, { userId: input.userId, on });
    }),
});

/**
 * Keep the car-allowance rules in step with the file: one flat rule per non-standard rate,
 * covering exactly the people last paid at it.
 *
 * Rules are found by what they ARE — a car-allowance rule (it names people) for the country,
 * in force, with a single band at that rate — so a rule an admin made by hand at the same flat
 * rate is treated as the same group. The file speaks only for the people in it: a group
 * keeps everybody the file does not mention, gains the people it says were paid that rate,
 * and loses the people it says were paid something else. When a group's membership changes,
 * a new rule replaces it from today (the first rule at a rate covers the whole year); when it
 * is left empty, it is closed. People who end up in no group fall back to the country default
 * (`released`). A rule starting on or after today cannot be replaced today, and is left alone
 * and reported.
 */
async function syncCarAllowances(
  tx: Prisma.TransactionClient,
  params: {
    country: string;
    yearStart: Date;
    now: Date;
    groups: ReadonlyMap<number, string[]>;
    /** Everybody the file names, at whatever rate. */
    inFile: ReadonlySet<string>;
    standardRates: ReadonlySet<number>;
    actorId: string;
  },
): Promise<{
  released: string[];
  summary: { rateMinor: number; people: number; action: string }[];
}> {
  const today = new Date(
    Date.UTC(params.now.getUTCFullYear(), params.now.getUTCMonth(), params.now.getUTCDate()),
  );
  // In force AFTER today: a rule closed today (an earlier upload the same day) is history.
  const inForce = await tx.mileageRate.findMany({
    where: {
      country: params.country,
      subjects: { some: {} },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: today } }],
    },
    orderBy: { effectiveFrom: 'asc' },
    select: {
      id: true,
      effectiveFrom: true,
      unit: true,
      glAccountId: true,
      tiers: { select: { rateMinor: true } },
      subjects: { select: { userId: true } },
    },
  });
  // Only flat rules at a non-standard rate are allowance groups; anything else is left alone.
  const rulesAt = new Map<number, typeof inForce>();
  for (const r of inForce) {
    if (r.tiers.length !== 1) continue;
    const rate = Number(r.tiers[0].rateMinor);
    if (params.standardRates.has(rate)) continue;
    rulesAt.set(rate, [...(rulesAt.get(rate) ?? []), r]);
  }

  /**
   * Who each group should cover: the people the file says were paid that rate, plus anybody
   * already covered whom the file does not mention. The file speaks only for the people in
   * it — a new hire on a hand-made allowance, who never used Concur, keeps it.
   */
  const current = new Map<number, Set<string>>();
  const desired = new Map<number, Set<string>>();
  for (const rate of new Set([...params.groups.keys(), ...rulesAt.keys()])) {
    const have = new Set((rulesAt.get(rate) ?? []).flatMap((r) => r.subjects.map((x) => x.userId)));
    current.set(rate, have);
    desired.set(
      rate,
      new Set([
        ...(params.groups.get(rate) ?? []),
        ...[...have].filter((id) => !params.inFile.has(id)),
      ]),
    );
  }
  const coveredAfter = new Set([...desired.values()].flatMap((set) => [...set]));
  const coveredBefore = new Set([...current.values()].flatMap((set) => [...set]));

  const released: string[] = [];
  const summary: { rateMinor: number; people: number; action: string }[] = [];
  for (const rate of [...desired.keys()].sort((a, b) => a - b)) {
    const have = current.get(rate) ?? new Set<string>();
    const want = desired.get(rate) ?? new Set<string>();
    const rules = rulesAt.get(rate) ?? [];
    if (have.size === want.size && [...want].every((id) => have.has(id))) {
      summary.push({ rateMinor: rate, people: want.size, action: 'unchanged' });
      continue;
    }
    if (rules.some((r) => r.effectiveFrom >= today)) {
      summary.push({ rateMinor: rate, people: want.size, action: 'skipped' });
      continue;
    }
    // A brand-new group of people nobody covered covers the whole year; anything else is a
    // change and starts today — otherwise somebody moving from another rate would be on two
    // allowances from 1 January until today.
    const fresh = rules.length === 0 && [...want].every((id) => !coveredBefore.has(id));
    const effectiveFrom = fresh ? params.yearStart : today;
    let created: { id: string } | null = null;
    if (want.size > 0) {
      created = await tx.mileageRate.create({
        data: {
          country: params.country,
          unit: rules[0]?.unit ?? 'KM',
          effectiveFrom,
          // Where the group's mileage posts is the group's, not the upload's to reset.
          glAccountId: rules[0]?.glAccountId ?? null,
          createdBy: params.actorId,
          tiers: { create: [{ fromDistance: 0, rateMinor: BigInt(rate) }] },
          subjects: { create: [...want].map((userId) => ({ userId })) },
        },
        select: { id: true },
      });
    }
    for (const [i, r] of rules.entries()) {
      await tx.mileageRate.update({
        where: { id: r.id },
        // One successor link per rule pair: `supersededById` is unique.
        data: {
          effectiveTo: effectiveFrom,
          ...(created && i === 0 ? { supersededById: created.id } : {}),
        },
      });
    }
    for (const id of have) if (!coveredAfter.has(id)) released.push(id);
    summary.push({
      rateMinor: rate,
      people: want.size,
      action: want.size === 0 ? 'closed' : rules.length === 0 ? 'created' : 'replaced',
    });
  }
  return { released, summary };
}
