// Ported from ExpenseOS `apps/web/src/server/policy/builtinKinds.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:". REQUIRES_APPROVED_TRAVEL was left out at w4-02a and restored by w6-01.
/**
 * Built-in rule kinds — the pre-v2 hardcoded rules (R1–R12), migrated from the
 * `LEGACY_RULES` functions to first-class `RuleKind`s driven by seeded
 * `PolicyRule` instances (see seed.ts `seedPolicyRules`). Unlike the generic
 * PREDICATE kinds, these read per-category policies / FX rates / the fiscal-close
 * date from the aggregate context, so they can't be expressed as a flat
 * predicate — each is a dedicated AGGREGATE kind that scans the hydrated report
 * and emits findings (at line or report scope). Behaviour is a 1:1 port of the
 * old functions; the seeded instance supplies the severity + message key, and a
 * kind may override those per-finding for heterogeneous outputs (the
 * per-transaction kind's degraded `fxRateMissing`, the running-limit kind's
 * daily/monthly/annual keys).
 *
 * R6 (required custom field) is still a no-op stub in the legacy set — there is
 * no CustomFieldValue model to read — so it is intentionally NOT ported.
 * R7 (mileage max) IS ported now that #145 put a real `mileageKm` on line items.
 */
import { convertMoney, getCurrency } from '@expenseos/money';
import { z } from 'zod';
import type { Finding, RuleKind } from './kinds';
import type { HydratedReport } from './types';

type Line = HydratedReport['lineItems'][number];

// ── Money helpers (moved from engine.ts; only the built-in kinds use them) ──

/** Convert a line-item amount to the policy currency (BigInt cents in/out).
 *  Returns null when no FX rate is available — the caller decides (the
 *  per-transaction kind surfaces a degraded `fxRateMissing` INFO). */
function convertMinor(
  amountMinor: bigint,
  from: string,
  to: string,
  rates: Map<string, string>,
): bigint | null {
  if (from === to) return amountMinor;
  const converted = convertMoney({ amountMinor, currencyCode: from }, to, rates);
  return converted ? converted.amountMinor : null;
}

/** Minor-unit amount → `1,234.56 USD`-style string, scaled by the currency's
 *  ISO-4217 exponent. Used for the (currently cosmetic) message interpolation. */
function formatMoney(cents: bigint, currency: string): string {
  const exponent = getCurrency(currency).exponent;
  const b = 10n ** BigInt(exponent);
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / b;
  const frac = exponent > 0 ? `.${(abs % b).toString().padStart(exponent, '0')}` : '';
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac} ${currency}`;
}

const emptyParams = z.object({}).passthrough();

/** R1: per-transaction limit exceeded (WARNING), with a degraded `fxRateMissing`
 *  INFO when the line can't be converted to the policy currency. */
const perTxnLimitKind: RuleKind = {
  code: 'PER_TXN_LIMIT',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: emptyParams,
  defaultSeverity: 'WARNING',
  messageKey: 'perTransactionLimit',
  evaluateAggregate: (_inst, ctx) => {
    const out: Finding[] = [];
    for (const item of ctx.report.lineItems) {
      const policy = ctx.policiesByCategoryId.get(item.category.id);
      if (!policy?.perTransactionLimitMinor) continue;
      const inPolicy = convertMinor(
        item.amountMinor,
        item.currency.code,
        ctx.policyCurrency,
        ctx.fxRates,
      );
      if (inPolicy === null) {
        out.push({
          lineItemId: item.id,
          severity: 'INFO',
          messageKey: 'fxRateMissing',
          messageValues: { from: item.currency.code, to: ctx.policyCurrency },
          data: { from: item.currency.code, to: ctx.policyCurrency },
        });
        continue;
      }
      if (inPolicy > policy.perTransactionLimitMinor) {
        out.push({
          lineItemId: item.id,
          messageValues: {
            category: item.category.code,
            actual: formatMoney(inPolicy, ctx.policyCurrency),
            limit: formatMoney(policy.perTransactionLimitMinor, ctx.policyCurrency),
          },
          data: {
            actualMinor: inPolicy.toString(),
            limitMinor: policy.perTransactionLimitMinor.toString(),
            policyCurrency: ctx.policyCurrency,
          },
        });
      }
    }
    return out;
  },
};

/** R2/3/4: daily / monthly / annual running limits (WARNING). One kind covers
 *  all three windows; each firing carries the window's own message key. Flags
 *  the line that pushed a (category × window) running total over the limit. */
type Bucket = 'day' | 'month' | 'year';
const RUNNING: {
  bucket: Bucket;
  key: string;
  field: 'dailyLimitMinor' | 'monthlyLimitMinor' | 'annualLimitMinor';
}[] = [
  { bucket: 'day', key: 'dailyLimit', field: 'dailyLimitMinor' },
  { bucket: 'month', key: 'monthlyLimit', field: 'monthlyLimitMinor' },
  { bucket: 'year', key: 'annualLimit', field: 'annualLimitMinor' },
];
function bucketKey(item: Line, bucket: Bucket): string {
  const d = item.date;
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  if (bucket === 'day') return `${item.category.id}:${y}-${m}-${day}`;
  if (bucket === 'month') return `${item.category.id}:${y}-${m}`;
  return `${item.category.id}:${y}`;
}
const runningLimitKind: RuleKind = {
  code: 'RUNNING_LIMIT',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: emptyParams,
  defaultSeverity: 'WARNING',
  messageKey: 'dailyLimit',
  evaluateAggregate: (_inst, ctx) => {
    const out: Finding[] = [];
    const sorted = [...ctx.report.lineItems].sort(
      (a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id),
    );
    for (const { bucket, key, field } of RUNNING) {
      const totals = new Map<string, bigint>();
      for (const item of sorted) {
        const limit = ctx.policiesByCategoryId.get(item.category.id)?.[field] as
          | bigint
          | null
          | undefined;
        if (!limit) continue;
        const inPolicy = convertMinor(
          item.amountMinor,
          item.currency.code,
          ctx.policyCurrency,
          ctx.fxRates,
        );
        if (inPolicy === null) continue; // PER_TXN_LIMIT already surfaced fxRateMissing
        const k = bucketKey(item, bucket);
        const prior = totals.get(k) ?? 0n;
        const next = prior + inPolicy;
        totals.set(k, next);
        if (next > limit && prior <= limit) {
          out.push({
            lineItemId: item.id,
            messageKey: key,
            messageValues: {
              category: item.category.code,
              actual: formatMoney(next, ctx.policyCurrency),
              limit: formatMoney(limit, ctx.policyCurrency),
            },
            data: {
              bucket,
              actualMinor: next.toString(),
              limitMinor: limit.toString(),
              policyCurrency: ctx.policyCurrency,
            },
          });
        }
      }
    }
    return out;
  },
};

/**
 * R5: receipt required for the category and missing (BLOCK).
 *
 * Mileage is exempt. A mileage claim has no receipt to produce — nobody is handed
 * a document for driving their own car — and its evidence is the measured route
 * plus the rate, which ExpenseOS computes and snapshots onto the line. Demanding a
 * receipt asks for a thing that does not exist, and at BLOCK severity that made
 * the claim unfileable rather than merely annoying.
 */
const receiptRequiredKind: RuleKind = {
  code: 'RECEIPT_REQUIRED',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: emptyParams,
  defaultSeverity: 'BLOCK',
  messageKey: 'receiptMissing',
  evaluateAggregate: (_inst, ctx) => {
    const out: Finding[] = [];
    for (const item of ctx.report.lineItems) {
      if (item.category.isMileage) continue;
      const policy = ctx.policiesByCategoryId.get(item.category.id);
      if (!policy?.receiptRequired || item.receipts.length > 0) continue;
      out.push({ lineItemId: item.id, messageValues: { category: item.category.code } });
    }
    return out;
  },
};

/**
 * Receipt required above a money threshold, independent of category. The
 * category-driven `RECEIPT_REQUIRED` above answers "does this KIND of spend
 * need a receipt"; this answers "is this line big enough that it needs one
 * regardless". The threshold is an instance param and the severity comes from
 * the instance, so finance can run more than one — a WARNING that nudges at a
 * low threshold under a BLOCK that stops submission at a higher one. The seed
 * currently runs a single BLOCK at $25 (the WARNING instance exists, disabled).
 *
 * Compared in the policy currency, like every other money rule here. A line
 * that can't be converted is skipped rather than guessed at; PER_TXN_LIMIT has
 * already raised `fxRateMissing` for it.
 *
 * Mileage is exempt, and this rule is the reason the exemption matters. R5 above is
 * at least switchable — an admin can clear `receiptRequired` on the mileage
 * category. This one is category-INDEPENDENT, so it could not be turned off for
 * mileage without turning it off for everything: a long drive priced over the
 * threshold produced a violation that no action by the claimant could ever satisfy.
 */
const receiptThresholdKind: RuleKind = {
  code: 'RECEIPT_THRESHOLD',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: z.object({ thresholdMinor: z.string().regex(/^\d+$/) }).passthrough(),
  paramsSpec: [{ name: 'thresholdMinor', kind: 'moneyMinor', required: true }],
  defaultSeverity: 'WARNING',
  messageKey: 'receiptThreshold',
  evaluateAggregate: (inst, ctx) => {
    const raw = (inst.params as { thresholdMinor?: string } | null)?.thresholdMinor;
    if (!raw) return [];
    const threshold = BigInt(raw);
    const out: Finding[] = [];
    for (const item of ctx.report.lineItems) {
      if (item.category.isMileage) continue;
      if (item.receipts.length > 0) continue;
      const inPolicy = convertMinor(
        item.amountMinor,
        item.currency.code,
        ctx.policyCurrency,
        ctx.fxRates,
      );
      if (inPolicy === null) continue;
      if (inPolicy < threshold) continue;
      out.push({
        lineItemId: item.id,
        messageValues: {
          amount: formatMoney(inPolicy, ctx.policyCurrency),
          threshold: formatMoney(threshold, ctx.policyCurrency),
        },
        data: {
          amountMinor: inPolicy.toString(),
          thresholdMinor: threshold.toString(),
          policyCurrency: ctx.policyCurrency,
        },
      });
    }
    return out;
  },
};

/**
 * A tip out of proportion to the bill (WARNING).
 *
 * The percentage is taken against the PRE-TIP subtotal — `amountMinor - tipMinor` —
 * because that is what "a 20% tip" means to the person who left it and to the
 * reviewer checking it. Taking it against the line total would silently move the
 * bar: a 25% tip reads as 20% of the total, so a threshold of 20 would only catch
 * tips above roughly a quarter of the bill and the rule would look broken to
 * whoever set it.
 *
 * Lines with no tip are skipped, not scored as 0% — a rule that "passes" every
 * flight and taxi says nothing, and it would put a per-line finding on a report
 * where nobody left a tip at all.
 *
 * No currency conversion, deliberately, unlike every money rule around it: a ratio
 * of two amounts in the SAME currency is already currency-free, and converting both
 * sides would only introduce the FX-missing failure mode for no gain.
 */
const tipPercentageKind: RuleKind = {
  code: 'TIP_PERCENTAGE',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: z.object({ maxPercent: z.number().positive().max(1000) }).passthrough(),
  paramsSpec: [{ name: 'maxPercent', kind: 'number', required: true }],
  defaultSeverity: 'WARNING',
  messageKey: 'tipPercentage',
  evaluateAggregate: (inst, ctx) => {
    const maxPercent = (inst.params as { maxPercent?: number } | null)?.maxPercent;
    if (!maxPercent || maxPercent <= 0) return [];
    const out: Finding[] = [];
    for (const item of ctx.report.lineItems) {
      const tip = item.tipMinor;
      if (tip <= 0n) continue;
      const base = item.amountMinor - tip;
      // A tip on a zero (or negative) base is a data problem, not a generous tip;
      // any percentage of nothing is meaningless and would read as ∞%.
      if (base <= 0n) continue;
      // Scaled integer maths, then one divide: bigint has no fractions, and going
      // through Number first loses cents on a large bill.
      const pctBasisPoints = (tip * 10_000n) / base;
      const percent = Number(pctBasisPoints) / 100;
      if (percent <= maxPercent) continue;
      out.push({
        lineItemId: item.id,
        messageValues: {
          percent: percent.toFixed(1),
          maxPercent: String(maxPercent),
          tip: formatMoney(tip, item.currency.code),
          base: formatMoney(base, item.currency.code),
        },
        data: {
          tipMinor: tip.toString(),
          baseMinor: base.toString(),
          percent: percent.toFixed(1),
          maxPercent,
          currency: item.currency.code,
        },
      });
    }
    return out;
  },
};

/** R9: future-dated line item (WARNING). */
const futureDatedKind: RuleKind = {
  code: 'FUTURE_DATED',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: emptyParams,
  defaultSeverity: 'WARNING',
  messageKey: 'futureDated',
  evaluateAggregate: (_inst, ctx) => {
    const now = Date.now();
    const out: Finding[] = [];
    for (const item of ctx.report.lineItems) {
      if (item.date.getTime() > now) {
        out.push({
          lineItemId: item.id,
          messageValues: { date: item.date.toISOString().slice(0, 10) },
        });
      }
    }
    return out;
  },
};

/** R10: duplicate line item — same date + amount + currency + merchant (WARNING).
 *  Every same-key line beyond the first flags. */
const duplicateKind: RuleKind = {
  code: 'DUPLICATE',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: emptyParams,
  defaultSeverity: 'WARNING',
  messageKey: 'duplicate',
  evaluateAggregate: (_inst, ctx) => {
    const out: Finding[] = [];
    const seen = new Map<string, string>();
    for (const item of ctx.report.lineItems) {
      if (!item.merchant) continue;
      const key = `${item.date.toISOString().slice(0, 10)}|${item.amountMinor.toString()}|${item.currency.code}|${item.merchant.toLowerCase()}`;
      const prior = seen.get(key);
      if (prior) {
        out.push({
          lineItemId: item.id,
          messageValues: { merchant: item.merchant, date: item.date.toISOString().slice(0, 10) },
          data: { duplicateOfLineItemId: prior },
        });
      } else {
        seen.set(key, item.id);
      }
    }
    return out;
  },
};

/** R11: line currency differs from the submitter's home currency (INFO). */
const currencyMismatchKind: RuleKind = {
  code: 'CURRENCY_MISMATCH',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: emptyParams,
  defaultSeverity: 'INFO',
  messageKey: 'currencyMismatch',
  evaluateAggregate: (_inst, ctx) => {
    const home = ctx.report.submitter.homeCurrency;
    if (!home) return [];
    const out: Finding[] = [];
    for (const item of ctx.report.lineItems) {
      if (item.currency.code === home) continue;
      out.push({
        lineItemId: item.id,
        messageValues: { line: item.currency.code, home },
        data: { lineCurrency: item.currency.code, homeCurrency: home },
      });
    }
    return out;
  },
};

/** R12: any line dated on/before the fiscal-close date (BLOCK, report scope). */
const fiscalCloseKind: RuleKind = {
  code: 'FISCAL_CLOSE',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: emptyParams,
  defaultSeverity: 'BLOCK',
  messageKey: 'fiscalClose',
  evaluateAggregate: (_inst, ctx) => {
    const close = ctx.fiscalCloseDate;
    if (!close) return [];
    const hasPreClose = ctx.report.lineItems.some((i) => i.date.getTime() <= close.getTime());
    if (!hasPreClose) return [];
    return [
      {
        lineItemId: null,
        messageValues: { date: close.toISOString().slice(0, 10) },
        data: { fiscalCloseDate: close.toISOString() },
      },
    ];
  },
};

/** The migrated built-in kinds, registered into `RULE_KINDS` by kinds.ts. */
/**
 * R7: mileage maximum (WARNING).
 *
 * Two independent caps, both optional — an instance sets whichever it wants:
 *   `maxKmPerEntry`  a single claim is implausibly long (a 900 km day)
 *   `maxKmPerMonth`  the month's total across every mileage line
 *
 * Deliberately a WARNING, not a BLOCK. A long drive is usually legitimate and
 * occasionally a typo (600 vs 60), so the useful behaviour is to make the
 * approver look, not to stop the submission. Someone who really did drive that
 * far must still be able to claim it.
 *
 * Reads `mileageKm` — the server-computed distance from #145, not a
 * user-supplied amount — so the check can't be dodged by editing the money.
 * Ordinary lines carry null and are skipped, which also means the rule is inert
 * until mileage categories are in use.
 */
const mileageMaxParams = z
  .object({
    maxKmPerEntry: z.number().positive().optional(),
    maxKmPerMonth: z.number().positive().optional(),
  })
  .refine((p) => p.maxKmPerEntry !== undefined || p.maxKmPerMonth !== undefined, {
    message: 'Set maxKmPerEntry, maxKmPerMonth, or both.',
  });

/** `YYYY-MM` of a line's date, UTC — the monthly bucket key. */
function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const mileageMaxKind: RuleKind = {
  code: 'MILEAGE_MAX',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: mileageMaxParams,
  paramsSpec: [
    { name: 'maxKmPerEntry', kind: 'number', required: false },
    { name: 'maxKmPerMonth', kind: 'number', required: false },
  ],
  // Mirrors the schema's own refine: neither set means the rule does nothing.
  paramsAtLeastOneOf: ['maxKmPerEntry', 'maxKmPerMonth'],
  defaultSeverity: 'WARNING',
  messageKey: 'mileageMaxPerEntry',
  evaluateAggregate: (inst, ctx) => {
    const params = mileageMaxParams.safeParse(inst.params);
    if (!params.success) return [];
    const { maxKmPerEntry, maxKmPerMonth } = params.data;

    const out: Finding[] = [];
    // Bucket per month, remembering the last line so a monthly breach can be
    // attached to a real line item rather than floating at report scope.
    const monthly = new Map<string, { km: number; lastLineId: string }>();

    for (const item of ctx.report.lineItems) {
      if (item.mileageKm === null) continue;
      const km = Number(item.mileageKm);
      // A non-numeric or zero distance isn't a breach of anything.
      if (!Number.isFinite(km) || km <= 0) continue;

      if (maxKmPerEntry !== undefined && km > maxKmPerEntry) {
        out.push({
          lineItemId: item.id,
          messageKey: 'mileageMaxPerEntry',
          messageValues: { km: round1(km), limit: round1(maxKmPerEntry) },
          data: { km, limitKm: maxKmPerEntry, basis: 'entry' },
        });
      }

      if (maxKmPerMonth !== undefined) {
        const key = monthOf(item.date);
        const acc = monthly.get(key) ?? { km: 0, lastLineId: item.id };
        acc.km += km;
        acc.lastLineId = item.id;
        monthly.set(key, acc);
      }
    }

    if (maxKmPerMonth !== undefined) {
      for (const [month, acc] of monthly) {
        if (acc.km > maxKmPerMonth) {
          out.push({
            lineItemId: acc.lastLineId,
            messageKey: 'mileageMaxPerMonth',
            messageValues: { month, km: round1(acc.km), limit: round1(maxKmPerMonth) },
            data: { month, km: acc.km, limitKm: maxKmPerMonth, basis: 'month' },
          });
        }
      }
    }
    return out;
  },
};

/** One decimal place — distances are claimed to 0.1 km, and the raw float would
 *  otherwise surface as 123.40000000000001 in a violation message. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Spend in a pre-approved-travel category, filed without an approved trip.
 *
 * The legacy app hardcoded two arrays — `travelExemptRoles` and
 * `travelExemptEmployees` — and refused an airfare or hotel line unless the user
 * held an approved request. Refusing was right; hardcoding who is exempt was not.
 * Which categories need pre-approval, how hard the refusal is, and who is above it
 * are three policy questions, and this codebase has a policy-rule registry for
 * exactly that: an instance is scoped to a category by the admin, its severity is
 * the admin's (WARNING to nudge, BLOCK to stop submission), and the exemptions are
 * params rather than a deploy.
 *
 * `travelApproved` is deliberately false for a report linked to a request that is
 * still pending. The whole point of pre-approval is that the approval happened
 * BEFORE the spend, and "I filed a request this morning" is not that.
 */
const requiresApprovedTravelParams = z
  .object({
    /** Seniority above the rule — a VP who books their own flights. */
    exemptJobLevelIds: z.array(z.string().uuid()).optional(),
    /** Named individuals. A short list; a long one means the rule is wrong. */
    exemptUserIds: z.array(z.string().uuid()).optional(),
  })
  .passthrough();

const requiresApprovedTravelKind: RuleKind = {
  code: 'REQUIRES_APPROVED_TRAVEL',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: requiresApprovedTravelParams,
  // No paramsSpec: both params are uuid ARRAYS (job levels, named users) and the
  // generic editor renders money / number / boolean only. Exemptions therefore stay
  // API-authored for now — declared here so the omission is a stated decision rather
  // than a gap, and so `policy.paramsSpec.test.ts` can allow it explicitly.
  defaultSeverity: 'BLOCK',
  messageKey: 'requiresApprovedTravel',
  evaluateAggregate: (inst, ctx) => {
    if (ctx.report.travelApproved) return [];
    const params = requiresApprovedTravelParams.safeParse(inst.params ?? {});
    if (!params.success) return [];
    const { exemptJobLevelIds = [], exemptUserIds = [] } = params.data;
    if (exemptUserIds.includes(ctx.report.submitter.id)) return [];
    const jobLevelId = ctx.report.submitter.jobLevelId;
    if (jobLevelId && exemptJobLevelIds.includes(jobLevelId)) return [];

    // AGGREGATE kinds are not narrowed by the runner's category scoping (that is a
    // LINE-scope behaviour), so an instance's categoryId is applied here. An
    // instance with none covers every line, which is a legitimate — if aggressive —
    // way to say "no unapproved travel spend at all".
    const out: Finding[] = [];
    for (const item of ctx.report.lineItems) {
      if (inst.categoryId && item.category.id !== inst.categoryId) continue;
      out.push({
        lineItemId: item.id,
        messageValues: { category: item.category.code },
        data: { reason: 'noApprovedTravelRequest' },
      });
    }
    return out;
  },
};

/**
 * Documentation required above a money threshold — the "expense audit" rule.
 *
 * Large claims are the ones an auditor pulls, and the two things they always ask for
 * are why the money was spent and, for hospitality, who it was spent on. Below the
 * threshold that paperwork is friction; above it, it is the record. So this is one
 * rule with a threshold rather than a blanket requirement, and finance can run two
 * instances of it the way they run RECEIPT_THRESHOLD — a WARNING that nudges low and
 * a BLOCK that stops submission high.
 *
 * **Purpose, not explanation.** `Expense.purpose` says why the spend happened;
 * `explanation` justifies a warning after the fact. Accepting either would let a
 * claimant satisfy an audit requirement by explaining away the violation it raised,
 * which is circular. (A WARNING instance is still auto-justifiable by an explanation
 * — that is the engine's general exception path and applies to every warning. Set the
 * instance to BLOCK when the purpose itself is non-negotiable.)
 *
 * **Attendees only where the category says so.** Gated on
 * `ExpenseCategory.requiresAttendees`, which already marks the meal and entertainment
 * categories. A $2,000 flight has no attendees to name, and demanding them would
 * produce a violation no action by the claimant could ever satisfy — the same trap
 * mileage hit with the receipt rules.
 *
 * **One finding per line, whose message names EVERY gap.** Violation identity is
 * `(ruleCode, lineItemId)` and `runRules` dedupes on it, so per-gap findings would not
 * survive: a line missing both would emit `auditThresholdPurpose` and
 * `auditThresholdAttendees`, the second would be silently dropped, and the claimant
 * would add a purpose only to be stopped again by a requirement they were never shown.
 * Hence the third message key, `auditThresholdBoth`, and `data.missing` for the UI.
 *
 * (Emitting the same finding twice would be harmless — the dedup absorbs it. The thing
 * that matters is that the surviving finding is not one of two half-truths.)
 *
 * Compared in the policy currency like every other money rule; a line that cannot be
 * converted is skipped rather than guessed at (PER_TXN_LIMIT has already raised
 * `fxRateMissing` for it).
 */
const auditThresholdKind: RuleKind = {
  code: 'AUDIT_THRESHOLD',
  scope: 'AGGREGATE',
  requires: [],
  paramsSchema: z
    .object({
      thresholdMinor: z.string().regex(/^\d+$/),
      /** Master switches, so one instance can police purpose only. Default on. */
      requirePurpose: z.boolean().optional(),
      requireAttendees: z.boolean().optional(),
    })
    .passthrough(),
  paramsSpec: [
    { name: 'thresholdMinor', kind: 'moneyMinor', required: true },
    // Defaults match the evaluator's `!== false` reading: absent means ON.
    { name: 'requirePurpose', kind: 'boolean', default: true },
    { name: 'requireAttendees', kind: 'boolean', default: true },
  ],
  defaultSeverity: 'WARNING',
  messageKey: 'auditThresholdPurpose',
  evaluateAggregate: (inst, ctx) => {
    const params = (inst.params ?? {}) as {
      thresholdMinor?: string;
      requirePurpose?: boolean;
      requireAttendees?: boolean;
    };
    if (!params.thresholdMinor) return [];
    const threshold = BigInt(params.thresholdMinor);
    const wantPurpose = params.requirePurpose !== false;
    const wantAttendees = params.requireAttendees !== false;
    if (!wantPurpose && !wantAttendees) return [];

    const out: Finding[] = [];
    for (const item of ctx.report.lineItems) {
      const inPolicy = convertMinor(
        item.amountMinor,
        item.currency.code,
        ctx.policyCurrency,
        ctx.fxRates,
      );
      if (inPolicy === null) continue;
      if (inPolicy < threshold) continue;

      const missing: string[] = [];
      if (wantPurpose && !item.purpose) missing.push('purpose');
      if (wantAttendees && item.category.requiresAttendees && item.attendeeCount === 0) {
        missing.push('attendees');
      }
      if (missing.length === 0) continue;

      // One finding, and the key names the real gap rather than joining
      // translated fragments — word order and conjunctions differ per locale.
      const messageKey =
        missing.length === 2
          ? 'auditThresholdBoth'
          : missing[0] === 'purpose'
            ? 'auditThresholdPurpose'
            : 'auditThresholdAttendees';

      out.push({
        lineItemId: item.id,
        messageKey,
        messageValues: {
          amount: formatMoney(inPolicy, ctx.policyCurrency),
          threshold: formatMoney(threshold, ctx.policyCurrency),
        },
        data: {
          missing,
          amountMinor: inPolicy.toString(),
          thresholdMinor: threshold.toString(),
          policyCurrency: ctx.policyCurrency,
        },
      });
    }
    return out;
  },
};

export const BUILTIN_KINDS: readonly RuleKind[] = [
  perTxnLimitKind,
  runningLimitKind,
  receiptRequiredKind,
  receiptThresholdKind,
  tipPercentageKind,
  futureDatedKind,
  duplicateKind,
  currencyMismatchKind,
  fiscalCloseKind,
  mileageMaxKind,
  requiresApprovedTravelKind,
  auditThresholdKind,
];
