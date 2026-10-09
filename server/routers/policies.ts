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
 * sub-router at a time as its screen is ported: `fxRate` with /admin/fx-rates (w1-07).
 * The others arrive with their screens (mileage and per-diem rates later in Wave 1; the
 * expense policy and custom fields with theirs). VeloExpense differences, marked below:
 * `fx_rate` is per tenant (0051, d18), so every read and write is the tenant's own; a
 * currency the system has no row for, or a pair quoted against itself, is answered
 * BAD_REQUEST rather than as a 500 from the table's foreign key or check; and the audit
 * row names the pair in its details rather than as the entity id.
 */

import { auditActions, withAudit } from '@expenseos/audit';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/lib/db/prisma';
import { REFUSAL_KEYS, refusal } from '@/server/refusal';
import { router, withPermission } from '@/server/trpc';

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

export const policiesRouter = router({
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
});
