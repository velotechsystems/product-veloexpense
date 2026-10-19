// Ported from ExpenseOS `apps/web/src/server/policy/travelKinds.test.ts` (1e682dd6), w6-01 (d88), unchanged.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { runTravelRules } from './engine';
import { RULE_KINDS } from './kinds';
import type { AggregateContext, PolicyRuleInstance, TravelRequestContext } from './types';

/**
 * The two travel rule kinds, and the travel runner.
 *
 * The asymmetry these encode is the whole feature: the cabin restriction BLOCKS at
 * request time, and the overrun WARNS at expense time. It is a deliberate split, because
 * they catch different things — the block stops a discouraged booking before the money
 * moves, and the warning catches the person who was blocked and booked it anyway (whose
 * travel request says ECONOMY, so no cabin check can see them).
 */

const VP = '019f9a10-0000-7000-8000-00000000e001';
const IC = '019f9a10-0000-7000-8000-00000000i001';
const LINE_A = '019f9a10-0000-7000-8000-0000000000a1';
const LINE_B = '019f9a10-0000-7000-8000-0000000000b1';

const cabinRule = (over: Partial<PolicyRuleInstance> = {}): PolicyRuleInstance => ({
  id: 'rule-cabin',
  kindCode: 'TRAVEL_CABIN_CLASS',
  scope: 'TRAVEL_REQUEST',
  severity: 'BLOCK',
  condition: null,
  params: { cabin: 'BUSINESS', allowedJobLevelIds: [VP] },
  messageKey: 'travelCabinClass',
  categoryId: null,
  ...over,
});

function travelCtx(
  lines: Array<{
    id: string;
    kind: string;
    payload: unknown;
    amountMinor?: bigint;
    notes?: string | null;
  }>,
  jobLevelId: string | null = IC,
): TravelRequestContext {
  return {
    request: {
      id: 'trv-1',
      tripType: 'ROUND_TRIP',
      departDate: new Date('2026-09-01T00:00:00Z'),
      returnDate: new Date('2026-09-05T00:00:00Z'),
      destinationCity: 'London',
      destinationCountry: 'GB',
      currencyCode: 'CAD',
      totalMinor: lines.reduce((a, l) => a + (l.amountMinor ?? 0n), 0n),
    },
    submitter: { id: 'u1', jobLevelId },
    lines: lines.map((l) => ({
      id: l.id,
      categoryId: 'cat-air',
      categoryCode: 'AIRFARE',
      kind: l.kind as never,
      payload: l.payload,
      amountMinor: l.amountMinor ?? 0n,
      basis: 'QUOTE' as never,
      // Explained by default, so the cabin cases above are not also exercising the
      // notes-required rule by accident.
      notes: l.notes === undefined ? 'Client kickoff' : l.notes,
    })),
    t: (key) => key,
  };
}

const business = { travelClass: 'BUSINESS', fromLabel: 'YUL', toLabel: 'LHR' };
const economy = { travelClass: 'ECONOMY', fromLabel: 'YUL', toLabel: 'LHR' };

// ── The cabin block ───────────────────────────────────────────────────────────

describe('TRAVEL_CABIN_CLASS', () => {
  it('blocks a business-class line for a job level that is not on the list', () => {
    const out = runTravelRules({
      travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: business }], IC),
      rules: [cabinRule()],
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('BLOCK');
    // Anchored to the LINE, so the drawer can put the sentence under the flight it is
    // about rather than in a list the reader has to match up by hand.
    expect(out[0].lineItemId).toBe(LINE_A);
    expect(out[0].data).toMatchObject({ cabin: 'BUSINESS' });
  });

  it('allows it for a job level that IS on the list', () => {
    expect(
      runTravelRules({
        travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: business }], VP),
        rules: [cabinRule()],
      }),
    ).toEqual([]);
  });

  it('blocks a submitter with NO job level, rather than exempting them', () => {
    /**
     * The direction this fails in matters. An unlevelled employee is a data gap — the
     * directory seed reports unmapped titles for exactly this reason — and reading a
     * missing level as "allowed" would make the block bypassable by having no level.
     */
    const out = runTravelRules({
      travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: business }], null),
      rules: [cabinRule()],
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('BLOCK');
  });

  it('blocks everyone when the allow-list is empty', () => {
    // "First class is nobody" is a real configuration, and `[]` is how it is expressed.
    const out = runTravelRules({
      travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: business }], VP),
      rules: [cabinRule({ params: { cabin: 'BUSINESS', allowedJobLevelIds: [] } })],
    });
    expect(out).toHaveLength(1);
  });

  it('ignores a cabin the rule does not restrict', () => {
    expect(
      runTravelRules({
        travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: economy }], IC),
        rules: [cabinRule()],
      }),
    ).toEqual([]);
  });

  it('reads only AIRFARE lines', () => {
    /**
     * A LODGING payload has no `travelClass` at all, and a registry lookup against the
     * wrong schema would either throw or — worse — parse to defaults and report ECONOMY
     * on something that is not a flight.
     */
    expect(
      runTravelRules({
        travel: travelCtx([{ id: LINE_A, kind: 'LODGING', payload: { nights: 4 } }], IC),
        rules: [cabinRule()],
      }),
    ).toEqual([]);
  });

  it('fires once per offending line', () => {
    const out = runTravelRules({
      travel: travelCtx(
        [
          { id: LINE_A, kind: 'AIRFARE', payload: business },
          { id: LINE_B, kind: 'AIRFARE', payload: business },
        ],
        IC,
      ),
      rules: [cabinRule()],
    });
    // Two flights, two blocks — `dedupe` keys on (rule, line), so a multi-city trip in
    // the wrong cabin is not collapsed into one sentence about an unnamed leg.
    expect(out.map((v) => v.lineItemId)).toEqual([LINE_A, LINE_B]);
  });

  it('says nothing on a payload it cannot read, rather than throwing', () => {
    // `readTravelLinePayload` is the tolerant reader; a payload written by an older
    // deployment must degrade to "no finding", not to a stack trace inside a rule.
    expect(
      runTravelRules({
        travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: { travelClass: 42 } }], IC),
        rules: [cabinRule()],
      }),
    ).toEqual([]);
  });

  it('does nothing when the instance names no cabin', () => {
    expect(
      runTravelRules({
        travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: business }], IC),
        rules: [cabinRule({ params: {} })],
      }),
    ).toEqual([]);
  });
});

// ── The runner ────────────────────────────────────────────────────────────────

describe('runTravelRules', () => {
  it('skips an instance whose scope is not TRAVEL_REQUEST', () => {
    // The report validator's rules are loaded by a query that shares this shape; a
    // travel run must not try to evaluate a LINE kind against a budget line.
    expect(
      runTravelRules({
        travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: business }], IC),
        rules: [
          {
            id: 'r-line',
            kindCode: 'PREDICATE_LINE',
            scope: 'LINE',
            severity: 'BLOCK',
            condition: null,
            params: {},
            messageKey: 'policy.generic',
            categoryId: null,
          },
        ],
      }),
    ).toEqual([]);
  });

  it('skips an instance whose ROW scope disagrees with its kind', () => {
    /**
     * `PolicyRule.scope` is denormalized from the kind, so a kind re-scoped in code after
     * an instance was authored leaves a row claiming the wrong thing. The kind's own scope
     * governs — otherwise a report kind would be handed a travel context.
     */
    expect(
      runTravelRules({
        travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: business }], IC),
        rules: [cabinRule({ kindCode: 'PREDICATE_LINE' })],
      }),
    ).toEqual([]);
  });

  it('keeps only the most severe of two instances of one kind on one line', () => {
    /**
     * A warn-and-block pair from the same kind is ONE problem. Reporting both matters
     * because the submit gate counts unjustified WARNINGs — the traveller would be asked
     * to justify a warning about the very thing already blocking them, and justifying it
     * would change nothing.
     */
    const out = runTravelRules({
      travel: travelCtx([{ id: LINE_A, kind: 'AIRFARE', payload: business }], IC),
      rules: [
        cabinRule({ id: 'warn', severity: 'WARNING' }),
        cabinRule({ id: 'block', severity: 'BLOCK' }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('BLOCK');
  });
});

// ── The expense-side overrun, per category ───────────────────────────────────

const overrunRule = (params: Record<string, unknown>): PolicyRuleInstance => ({
  id: 'rule-overrun',
  kindCode: 'TRAVEL_OVERRUN',
  scope: 'AGGREGATE',
  severity: 'WARNING',
  condition: null,
  params,
  messageKey: 'travelOverrun',
  categoryId: null,
});

const AIR = 'ec-air';
const HOTEL = 'ec-hotel';
const MEALS = 'ec-meals';

/** A claim line in an expense category, in CAD. */
const claim = (categoryId: string, amountMinor: bigint, currency = 'CAD') => ({
  id: `li-${categoryId}-${amountMinor}`,
  date: new Date('2026-09-10'),
  amountMinor,
  merchant: null,
  category: { id: categoryId, code: categoryId, isMileage: false, requiresAttendees: false },
  currency: { code: currency },
  receipts: [],
  mileageKm: null,
  tipMinor: 0n,
  purpose: null,
  attendeeCount: 0,
});

function aggWith(
  lines: ReturnType<typeof claim>[],
  budgeted: Record<string, bigint> | null,
  fxRates = new Map<string, string>(),
): AggregateContext {
  return {
    report: {
      id: 'rep-1',
      submittedAt: null,
      submitter: { id: 'u1', homeCurrency: 'CAD', localePref: 'en', jobLevelId: null },
      travelApproved: true,
      lineItems: lines,
    },
    policiesByCategoryId: new Map(),
    policyCurrency: 'CAD',
    fxRates,
    fiscalCloseDate: null,
    perDiemEnabled: false,
    perDiem: null,
    budgetImpacts: null,
    travelBudget:
      budgeted === null
        ? null
        : {
            budgetedByExpenseCategoryId: new Map(Object.entries(budgeted)),
            travelLabels: new Map(Object.entries(budgeted).map(([k]) => [k, [`travel-${k}`]])),
          },
    t: (key) => key,
  };
}

/** 10% tolerance, $200 absolute floor. */
const STANDARD = { tolerancePercent: 10, absoluteFloorMinor: '20000' };

const run = (
  lines: ReturnType<typeof claim>[],
  budgeted: Record<string, bigint> | null,
  params: Record<string, unknown> = STANDARD,
  fxRates?: Map<string, string>,
) =>
  RULE_KINDS.TRAVEL_OVERRUN.evaluateAggregate?.(
    overrunRule(params),
    aggWith(lines, budgeted, fxRates),
  ) ?? [];

/** The offending categories carried on the single finding. */
const offenders = (findings: ReturnType<typeof run>) =>
  ((findings[0]?.data?.categories ?? []) as Array<{ expenseCategoryId: string }>).map(
    (c) => c.expenseCategoryId,
  );

describe('TRAVEL_OVERRUN, per category', () => {
  it('catches an airfare overrun that the TOTAL would have hidden', () => {
    /**
     * The case the whole rule exists for, and the one a total comparison cannot see.
     *
     * Somebody blocked from business class books it anyway, so their request says ECONOMY
     * and the only surviving signal is the amount — but they offset it by underspending on
     * the hotel. Budget $1,200 + $900 = $2,100; claim $2,000 + $100 = $2,100. Identical
     * totals. The airfare is 67% over.
     */
    const out = run([claim(AIR, 200_000n), claim(HOTEL, 10_000n)], {
      [AIR]: 120_000n,
      [HOTEL]: 90_000n,
    });
    expect(out).toHaveLength(1);
    expect(offenders(out)).toEqual([AIR]);
    expect(out[0].data).toMatchObject({ overrunPercent: 66, categoryCount: 1 });
  });

  it('says NOTHING about spend the trip never budgeted', () => {
    /**
     * The false positive a total comparison generates on ordinary reports. An unexpected
     * client dinner is real money in a category the estimate never mentioned — comparing
     * totals reports it as an overrun of the travel request, which it is not.
     */
    const out = run([claim(AIR, 120_000n), claim(MEALS, 500_000n)], { [AIR]: 120_000n });
    expect(out).toEqual([]);
  });

  it('ignores a travel category that maps to nothing, because it claims nothing', () => {
    // `buildReportFromTravel` skips unmapped travel categories, so no expense line is ever
    // coded to them. The loader drops them; nothing here should invent a bucket.
    const out = run([claim(AIR, 500_000n)], { [AIR]: 120_000n });
    expect(offenders(out)).toEqual([AIR]);
  });

  it('reports every offending category on ONE finding', () => {
    /**
     * One finding, not one per category. A violation's identity is
     * `(ruleCode, lineItemId)`, so a second finding with the same null anchor is dropped
     * by `dedupe` and any justification would attach to whichever came first.
     */
    const out = run([claim(AIR, 500_000n), claim(HOTEL, 400_000n)], {
      [AIR]: 120_000n,
      [HOTEL]: 90_000n,
    });
    expect(out).toHaveLength(1);
    expect(offenders(out).sort()).toEqual([AIR, HOTEL]);
    expect(out[0].data).toMatchObject({ categoryCount: 2 });
    // The worst leads, because that is the one worth acting on first.
    expect(out[0].data?.overrunPercent).toBe(344);
  });

  it('names the TRAVEL categories that fed the bucket', () => {
    // The bucket key has to be the expense category — it is the only axis both sides
    // share — but the finding should still read in travel's vocabulary.
    const out = run([claim(AIR, 500_000n)], { [AIR]: 120_000n });
    expect((out[0].data?.categories as Array<{ travelLabels: string[] }>)[0].travelLabels).toEqual([
      `travel-${AIR}`,
    ]);
  });

  it('is silent within tolerance', () => {
    // $1,200 budget, $1,250 claimed: 4%, under 10%.
    expect(run([claim(AIR, 125_000n)], { [AIR]: 120_000n })).toEqual([]);
  });

  it('is silent when only the PERCENTAGE is exceeded', () => {
    // $40 budget, $60 claimed: 50% over and $20. A rounding error on a cheap category is
    // not something to make somebody write a paragraph about.
    expect(run([claim(AIR, 6_000n)], { [AIR]: 4_000n })).toEqual([]);
  });

  it('is silent when only the FLOOR is exceeded', () => {
    // $50,000 budget, $50,300 claimed: $300 clears the floor, 0.6% is well within
    // tolerance.
    expect(run([claim(AIR, 5_030_000n)], { [AIR]: 5_000_000n })).toEqual([]);
  });

  it('is silent on an UNDERRUN', () => {
    // Spending less than approved is not what this rule is about.
    expect(run([claim(AIR, 50_000n)], { [AIR]: 120_000n })).toEqual([]);
  });

  it('is silent on a budgeted category with no claims at all', () => {
    expect(run([claim(HOTEL, 90_000n)], { [AIR]: 120_000n, [HOTEL]: 90_000n })).toEqual([]);
  });

  it('is silent when there is no linked approved request', () => {
    expect(run([claim(AIR, 999_000n)], null)).toEqual([]);
  });

  it('is silent when the budget map is empty', () => {
    expect(run([claim(AIR, 999_000n)], {})).toEqual([]);
  });

  it('does not divide by a zero budget', () => {
    // A category budgeted at nothing has no percentage to be over.
    expect(run([claim(AIR, 999_000n)], { [AIR]: 0n })).toEqual([]);
  });

  it('sums several claims in one category before comparing', () => {
    // Two tickets against one airfare budget: $700 + $700 against $1,200.
    const out = run([claim(AIR, 70_000n), claim(AIR, 70_000n)], { [AIR]: 120_000n });
    expect(offenders(out)).toEqual([AIR]);
    expect((out[0].data?.categories as Array<{ claimedMinor: string }>)[0].claimedMinor).toBe(
      '140000',
    );
  });

  it('converts a foreign claim before comparing, rather than adding raw minor units', () => {
    /**
     * $1,000 USD at 1.35 is $1,350 CAD against a $1,200 CAD budget — a 12% overrun. Added
     * raw, 100,000 against 120,000 reads as an UNDERRUN, so the rule would go quiet on a
     * genuine overspend purely because of the currency it was claimed in.
     */
    const out = run(
      [claim(AIR, 100_000n, 'USD')],
      { [AIR]: 120_000n },
      { tolerancePercent: 10, absoluteFloorMinor: '10000' },
      new Map([['USD->CAD', '1.35']]),
    );
    expect(offenders(out)).toEqual([AIR]);
    expect((out[0].data?.categories as Array<{ claimedMinor: string }>)[0].claimedMinor).toBe(
      '135000',
    );
  });

  it('defaults to a 10% tolerance when the instance sets none', () => {
    expect(run([claim(AIR, 125_000n)], { [AIR]: 120_000n }, {})).toEqual([]);
    expect(run([claim(AIR, 200_000n)], { [AIR]: 120_000n }, {})).not.toEqual([]);
  });

  it('carries the policy currency, so the FE can format the figures', () => {
    expect(run([claim(AIR, 500_000n)], { [AIR]: 120_000n })[0].data).toMatchObject({
      policyCurrency: 'CAD',
    });
  });
});

// ── The unexplained line ──────────────────────────────────────────────────────

const detailRule = (params: Record<string, unknown> = {}): PolicyRuleInstance => ({
  id: 'rule-notes',
  kindCode: 'TRAVEL_LINE_DETAIL_REQUIRED',
  scope: 'TRAVEL_REQUEST',
  severity: 'BLOCK',
  condition: null,
  params,
  messageKey: 'travelLineDetailRequired',
  categoryId: null,
});

describe('TRAVEL_LINE_DETAIL_REQUIRED', () => {
  const run = (
    lines: Array<{ id: string; amountMinor: bigint; notes: string | null }>,
    params: Record<string, unknown> = {},
  ) =>
    runTravelRules({
      travel: travelCtx(lines.map((l) => ({ ...l, kind: 'STANDARD', payload: {} }))),
      rules: [detailRule(params)],
    });

  it('blocks a line the traveller left unexplained', () => {
    const out = run([{ id: LINE_A, amountMinor: 480_000n, notes: null }]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('BLOCK');
    expect(out[0].lineItemId).toBe(LINE_A);
  });

  it('accepts a line that has one', () => {
    expect(
      run([{ id: LINE_A, amountMinor: 480_000n, notes: 'Only nonstop that lands in time' }]),
    ).toEqual([]);
  });

  it('does not accept whitespace as an explanation', () => {
    // The router trims on write; this guards a row written before it did.
    expect(run([{ id: LINE_A, amountMinor: 480_000n, notes: '   ' }])).toHaveLength(1);
  });

  it('ignores a line under the threshold', () => {
    /**
     * The point of the threshold. A $12 taxi needs no essay; demanding one on every line
     * is how a control becomes something everybody types "n/a" into.
     */
    expect(
      run([{ id: LINE_A, amountMinor: 1_200n, notes: null }], {
        thresholdMinor: '20000',
      }),
    ).toEqual([]);
  });

  it('flags a line exactly ON the threshold', () => {
    // At-or-over, not strictly over. A threshold of $200 that ignores a $200 line is a
    // threshold of $200.01, which is not what anybody typed.
    expect(
      run([{ id: LINE_A, amountMinor: 20_000n, notes: null }], { thresholdMinor: '20000' }),
    ).toHaveLength(1);
  });

  it('requires one on EVERY line when the threshold is zero', () => {
    const out = run(
      [
        { id: LINE_A, amountMinor: 100n, notes: null },
        { id: LINE_B, amountMinor: 900n, notes: 'Airport transfer' },
      ],
      { thresholdMinor: '0' },
    );
    expect(out.map((v) => v.lineItemId)).toEqual([LINE_A]);
  });

  it('defaults to requiring one everywhere when the instance sets no threshold', () => {
    // A rule saved with empty params must still do something, and the safe direction for
    // a "you must explain this" control is to ask.
    expect(run([{ id: LINE_A, amountMinor: 1n, notes: null }])).toHaveLength(1);
  });
});
