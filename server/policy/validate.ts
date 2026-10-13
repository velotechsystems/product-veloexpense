// Ported from ExpenseOS `apps/web/src/server/policy/validate.ts` (550b2945), w4-02d (d63). Each adaptation is
// marked "VeloExpense:"; travel, which is out of VeloExpense's scope, is the main one.
/**
 * Policy engine orchestrator — the only function the tRPC layer calls.
 *
 * Steps:
 *
 *   1. Load the report + every join the rules need in one query.
 *   2. Load the reference tables (policies, FX rates, system flags).
 *   3. Run the rule registry (`engine.runRules`).
 *   4. Replace the prior `PolicyViolation` rows for this report —
 *      wholesale swap inside a transaction so callers never see
 *      a half-validated state.
 *   5. Return the violation list to the caller (FE renders inline).
 *
 * The whole thing is one Postgres round-trip + a write transaction —
 * comfortable for the Phase 2 scale (≤ ~50 line items per report).
 * Phase 3+ optimization options: cache the reference-data load by
 * `updatedAt` snapshot, or move validation to a worker job for
 * reports past N lines.
 */

// VeloExpense: no ExpenseOS `evaluateReportAgainstBudgets` and no budget-alert markers
// (VeloExpense's alerts are lib/budgets/alerts.ts); the budget impacts come from VeloExpense's
// budgets through ./budgetBridge (d66), which the approval engine reads too (w4-04). No `convertMoney`: it served
// the travel budget only.
import type { RuleScope } from '@expenseos/db';
import { tipMinorOf } from '@expenseos/expense-lines';
import { fxRateMapFrom } from '@expenseos/money';
import type { Prisma, TenantDb } from '@/lib/db/prisma';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { budgetImpactsFor } from './budgetBridge';
import { type PolicyContext, runRules } from './engine';
import { buildFacts } from './facts';
import type { PolicyRuleInstance, RuleTranslator, Violation } from './types';

export interface ValidateOpts {
  /** VeloExpense: the tenant-scoped client (lib/db/prisma), already inside the request's
   *  transaction — ExpenseOS's `PrismaClient | TransactionClient`. */
  db: TenantDb;
  reportId: string;
  /** Localized-message renderer wired at the tRPC boundary. */
  t: RuleTranslator;
  /**
   * Whoever's action moved the numbers, for the budget-threshold Activity's
   * actor. Optional because most of validate does not care who called it; a
   * missing actor produces a system-attributed alert rather than none.
   */
  actorId?: string | null;
}

export interface ValidateResult {
  violations: Violation[];
  /** Count by severity — surfaced to the FE so the submit gate can
   *  flash a header summary without re-grouping the list.
   *  `unjustifiedWarning` = WARNINGs still lacking a justification note;
   *  the submit gate blocks while it's > 0 (a warning is submittable only
   *  once the submitter attaches a comment over the exception). */
  counts: { info: number; warning: number; block: number; unjustifiedWarning: number };
}

/** A locale-keyed Json label ({ en, "fr-CA" }) → a plain display token for
 *  policy-violation messages. Prefers EN, then any value. */
function categoryCode(label: unknown): string {
  if (label && typeof label === 'object' && !Array.isArray(label)) {
    const m = label as Record<string, unknown>;
    const v = m.en ?? Object.values(m)[0];
    if (typeof v === 'string') return v;
  }
  return typeof label === 'string' ? label : '';
}

export async function validateReport(opts: ValidateOpts): Promise<ValidateResult> {
  // VeloExpense: `actorId` attributed ExpenseOS's budget alerts, which do not fire here.
  const { db, reportId, t } = opts;

  // 1. Load the report with the joins the rules need. Entry-level
  //    facts (date, merchant, currency, receipts) live on the Expense;
  //    coding + amount on its line items. We flatten to one row per
  //    line item — the shape the engine already consumes — carrying the
  //    parent Expense's facts down onto each line.
  const loaded = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: {
      id: true,
      submittedAt: true,
      totalMinor: true,
      currency: { select: { code: true } },
      // VeloExpense: no `travelRequest` (travel is out of scope).
      submitter: {
        select: {
          id: true,
          // VeloExpense: the person's home currency is their legal entity's (`legal_entity.
          // currency_code`); ExpenseOS keeps one on the user. No `localePref` (VeloExpense
          // keeps a person's locale elsewhere, and no kind reads it) and no `roleId` (no
          // role table until w4-10, d64).
          entity: { select: { homeCurrency: { select: { code: true } } } },
          // Submitter tier — matches per-diem rates + rule scoping.
          jobLevelId: true,
          departmentId: true,
          legalEntityId: true,
          businessUnitId: true,
        },
      },
      expenses: {
        select: {
          id: true,
          date: true,
          // VeloExpense: an expense's date may still be blank on a draft (ExpenseOS's is
          // required); its creation time stands in, below.
          createdAt: true,
          // The place drives per-diem day/place grouping.
          placeText: true,
          merchant: true,
          // A non-empty per-expense explanation justifies that expense's
          // WARNING violations (the "Explain this charge" field).
          explanation: true,
          // Business purpose + attendees — what AUDIT_THRESHOLD requires on a
          // large claim. Both live on the Expense, so they ride down onto each
          // of its line items with the other entry-level facts.
          purpose: true,
          currency: { select: { code: true } },
          receipts: { select: { id: true } },
          _count: { select: { attendees: true } },
          lineItems: {
            select: {
              id: true,
              amountMinor: true,
              // The tip lives in the kind-specific payload; `tipMinorOf` reads it.
              kind: true,
              payload: true,
              mileageDistance: true,
              mileageUnit: true,
              category: {
                select: {
                  id: true,
                  code: true,
                  label: true,
                  isMileage: true,
                  requiresAttendees: true,
                  // VeloExpense (d70): CATEGORY_ACTIVE reads it.
                  active: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!loaded) {
    throw new Error(`policy.validate: report ${reportId} not found`);
  }

  // VeloExpense: the submitter's home currency, from their legal entity (see the select).
  const homeCurrency = loaded.submitter.entity?.homeCurrency?.code ?? null;
  // VeloExpense: an undated draft expense is judged as of when it was entered.
  const dateOf = (e: { date: Date | null; createdAt: Date }) => e.date ?? e.createdAt;

  const report = {
    id: loaded.id,
    submittedAt: loaded.submittedAt,
    // `homeCurrency` is a FK now; HydratedReport is the rule-facing shape and a
    // rule compares currency CODES, so it is flattened here rather than leaking a
    // row into every rule signature.
    submitter: {
      id: loaded.submitter.id,
      homeCurrency,
      // VeloExpense: no per-person locale on the user here; no kind reads it.
      localePref: DEFAULT_LOCALE,
      jobLevelId: loaded.submitter.jobLevelId,
    },
    // VeloExpense: no `travelApproved` (travel is out of scope).
    lineItems: loaded.expenses.flatMap((e) =>
      e.lineItems.map((li) => ({
        id: li.id,
        date: dateOf(e),
        amountMinor: li.amountMinor,
        merchant: e.merchant,
        // `code` is now a real column, so a rule keyed on it survives a rename;
        // the locale-keyed label remains the fallback for a category an admin
        // created by hand, which has no code and needs none.
        category: {
          id: li.category.id,
          code: li.category.code ?? categoryCode(li.category.label),
          isMileage: li.category.isMileage,
          requiresAttendees: li.category.requiresAttendees,
          active: li.category.active,
        },
        currency: e.currency,
        receipts: e.receipts,
        // The policy context stays in KM because the MILEAGE_MAX threshold is a
        // km figure; a line denominated in miles is converted rather than
        // compared raw, which would under-trigger by ~38%.
        mileageKm:
          li.mileageDistance == null
            ? null
            : li.mileageUnit === 'MI'
              ? (Number(li.mileageDistance) * 1.609344).toFixed(2)
              : li.mileageDistance.toString(),
        tipMinor: tipMinorOf(li),
        purpose: e.purpose?.trim() || null,
        attendeeCount: e._count.attendees,
      })),
    ),
  };

  // Line item → parent expense, so a line-anchored violation can link back to
  // its expense (FE navigation + the register's expense column).
  const expenseByLineId = new Map<string, string>();
  for (const e of loaded.expenses) for (const li of e.lineItems) expenseByLineId.set(li.id, e.id);
  // Trimmed explanation per expense — a non-empty one auto-justifies that
  // expense's WARNING violations without a separate exception comment.
  const explanationByExpenseId = new Map<string, string>();
  for (const e of loaded.expenses) {
    const expl = e.explanation?.trim();
    if (expl) explanationByExpenseId.set(e.id, expl);
  }
  const explanationJustifies = (v: Violation): string | null => {
    if (v.severity !== 'WARNING' || !v.lineItemId) return null;
    const expenseId = expenseByLineId.get(v.lineItemId);
    return (expenseId && explanationByExpenseId.get(expenseId)) || null;
  };

  // 2. Load reference data — three independent queries in parallel.
  // VeloExpense: no `systemFlag` table. The policy currency is the organization's
  // (`policy_currency_code`, 0015), read in the tenant's transaction.
  const [policies, fxRows, orgRows] = await Promise.all([
    db.expensePolicy.findMany(),
    db.fxRate.findMany({ orderBy: { fetchedAt: 'desc' } }),
    db.$queryRaw<Array<{ code: string }>>`
      SELECT policy_currency_code AS code FROM organization
       WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`,
  ]);

  const policiesByCategoryId = new Map(policies.map((p) => [p.categoryId, p]));

  // Latest FxRate per (base, quote), plus each missing opposite direction as the
  // reciprocal. Shared with the roll-up and the approvals engine so a line the report
  // total can value is never one the policy engine silently cannot.
  const fxRates = fxRateMapFrom(fxRows);

  // VeloExpense: ExpenseOS's three system flags. The policy currency is the organization's;
  // `perDiemEnabled` and `fiscalCloseDate` have no setting here yet, so they read as
  // ExpenseOS's defaults when unset — per-diem checks off, no fiscal close.
  const policyCurrency = orgRows[0]?.code ?? 'CAD';
  const perDiemEnabled = false;
  const fiscalCloseDate: Date | null = null;

  // v2: enabled, effective, scope-matched admin-authored rule instances. The
  // per-line categoryId scope is applied in the runner, not here.
  const now = new Date();
  const sub = loaded.submitter;
  const ruleRows = await db.policyRule.findMany({
    where: {
      enabled: true,
      // VeloExpense: no TRAVEL_REQUEST scope to exclude (the table's CHECK has none).
      AND: [
        { effectiveFrom: { lte: now } },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
        { OR: [{ departmentId: null }, { departmentId: sub.departmentId }] },
        { OR: [{ jobLevelId: null }, { jobLevelId: sub.jobLevelId }] },
        { OR: [{ legalEntityId: null }, { legalEntityId: sub.legalEntityId }] },
        { OR: [{ businessUnitId: null }, { businessUnitId: sub.businessUnitId }] },
        // VeloExpense: no roles until w4-10 (d64), so only an unscoped rule applies.
        // (`{ roleId: undefined }` would be no filter at all in Prisma, not "no role".)
        { roleId: null },
      ],
    },
  });
  const rules: PolicyRuleInstance[] = ruleRows.map((r) => ({
    id: r.id,
    kindCode: r.kindCode,
    // VeloExpense: the column is text under a CHECK (0064), not ExpenseOS's Prisma enum.
    scope: r.scope as RuleScope,
    severity: r.severity,
    condition: r.condition,
    params: r.params,
    messageKey: r.messageKey,
    categoryId: r.categoryId,
  }));

  // Per-diem inputs (only when enabled) — tier-matched rates + rate-currency
  // lookup + the per-expense grouping the shared overage helper consumes.
  let perDiem: PolicyContext['perDiem'] = null;
  if (perDiemEnabled) {
    const [perDiemRates, currencies] = await Promise.all([
      db.perDiemRate.findMany({
        where: {
          AND: [
            { OR: [{ jobLevelId: null }, { jobLevelId: sub.jobLevelId }] },
            { OR: [{ legalEntityId: null }, { legalEntityId: sub.legalEntityId }] },
            { OR: [{ businessUnitId: null }, { businessUnitId: sub.businessUnitId }] },
          ],
        },
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
      // VeloExpense: a currency is keyed by its code (no uuid).
      db.currency.findMany({ select: { code: true } }),
    ]);
    if (perDiemRates.length > 0) {
      perDiem = {
        expenses: loaded.expenses.map((e) => ({
          date: dateOf(e),
          placeText: e.placeText,
          lineItems: e.lineItems.map((li) => ({
            amountMinor: li.amountMinor,
            categoryId: li.category.id,
          })),
        })),
        reportCurrencyCode: loaded.currency.code,
        rates: perDiemRates,
        tier: {
          jobLevelId: sub.jobLevelId,
          legalEntityId: sub.legalEntityId,
          businessUnitId: sub.businessUnitId,
        },
        rateCurrencyCodeById: new Map(currencies.map((c) => [c.code, c.code])),
      };
    }
  }

  // v2 fact projection (LINE + REPORT) for admin-authored rule instances.
  // Built here (after the FX map + policyCurrency load) so amount facts are
  // converted into the policy currency for cross-currency-safe thresholds.
  const facts = buildFacts({
    now,
    reportTotalMinor: loaded.totalMinor,
    reportCurrencyCode: loaded.currency.code,
    submitter: {
      jobLevelId: loaded.submitter.jobLevelId,
      departmentId: loaded.submitter.departmentId,
      legalEntityId: loaded.submitter.legalEntityId,
      businessUnitId: loaded.submitter.businessUnitId,
      homeCurrency,
    },
    lines: loaded.expenses.flatMap((e) =>
      e.lineItems.map((li) => ({
        lineItemId: li.id,
        categoryId: li.category.id,
        categoryCode: li.category.code ?? categoryCode(li.category.label),
        amountMinor: li.amountMinor,
        currencyCode: e.currency.code,
        merchant: e.merchant,
        date: dateOf(e),
        hasReceipt: e.receipts.length > 0,
      })),
    ),
    // VeloExpense: no `travelApproved` (travel is out of scope).
    fxRates,
    policyCurrency,
  });

  // VeloExpense: ExpenseOS's travel budget (TRAVEL_OVERRUN's input) is not loaded — travel
  // is out of scope.

  // Budget impacts. Only when a BUDGET_OVERAGE instance is actually enabled —
  // the scan is the expensive part of this loader, and a deployment with no
  // budget rule should not pay for it on every validate.
  //
  // VeloExpense (d66): from VeloExpense's budgets (./budgetBridge), which v1's budget rule
  // read and the approval engine's budget facts read (w4-04). No module check: a tenant with
  // no budgets has no periods, and the loader answers nothing. No alert markers here:
  // VeloExpense's budget alerts fire from its own rollup (lib/budgets/alerts.ts).
  let budgetImpacts: PolicyContext['budgetImpacts'] = null;
  if (rules.some((r) => r.kindCode === 'BUDGET_OVERAGE')) {
    budgetImpacts = await budgetImpactsFor(db, reportId);
  }

  // 3. Run the rules.
  const violations = runRules({
    report,
    policiesByCategoryId,
    policyCurrency,
    fxRates,
    fiscalCloseDate,
    perDiemEnabled,
    perDiem,
    budgetImpacts,
    rules,
    facts,
    t,
  });

  // 4. Replace the prior violation set for this report. One transaction so
  // partial writes can't leak through. A violation's identity is
  // (lineItemId, ruleCode); we carry any prior justification (resolve fields)
  // forward onto the matching new row so a re-validate doesn't wipe a comment
  // the submitter already attached to an unchanged exception.
  const key = (lineItemId: string | null, ruleCode: string) => `${lineItemId ?? ''}|${ruleCode}`;
  const carried = new Map<
    string,
    { resolveNote: string | null; resolvedAt: Date | null; resolvedBy: string | null }
  >();
  // VeloExpense: `db` is the tenant client, already inside the request's one transaction
  // (lib/db/prisma) — ExpenseOS opens one here. The lock and the swap below run in it.
  await (async (tx: TenantDb) => {
    // Serialize the swap per report. The transaction alone does not: two validates
    // overlapping (the workbench fires one per edit and another when extraction
    // settles) each read the other's rows as absent — READ COMMITTED never shows an
    // uncommitted delete or insert — so both delete nothing and both insert, and the
    // report ends up with two identical rows for one finding, 2 ms apart. Nothing in
    // the schema refuses that: there is no unique key on (report, line, rule), and
    // adding one is a data-model decision. Locking the report row makes the second
    // caller wait, and once it proceeds every statement below sees the first caller's
    // committed rows, which its deleteMany then replaces. Held for the length of this
    // transaction only — three statements.
    await tx.$queryRaw`SELECT id FROM expense_report WHERE id = ${reportId}::uuid FOR UPDATE`;
    const prior = await tx.policyViolation.findMany({
      where: { reportId },
      select: {
        lineItemId: true,
        ruleCode: true,
        resolveNote: true,
        resolvedAt: true,
        resolvedBy: true,
      },
    });
    for (const p of prior) {
      if (p.resolvedAt) {
        carried.set(key(p.lineItemId, p.ruleCode), {
          resolveNote: p.resolveNote,
          resolvedAt: p.resolvedAt,
          resolvedBy: p.resolvedBy,
        });
      }
    }
    await tx.policyViolation.deleteMany({ where: { reportId } });
    if (violations.length > 0) {
      await tx.policyViolation.createMany({
        data: violations.map((v) => {
          const prev = carried.get(key(v.lineItemId, v.ruleCode));
          // A prior explicit exception comment wins; otherwise the parent
          // expense's explanation stands in as the justification.
          const expl = prev ? null : explanationJustifies(v);
          return {
            reportId,
            lineItemId: v.lineItemId,
            // Anchor a line-scoped violation to its parent expense too.
            expenseId: v.lineItemId ? (expenseByLineId.get(v.lineItemId) ?? null) : null,
            ruleCode: v.ruleCode,
            severity: v.severity,
            message: v.message,
            // VeloExpense: the column is never null (`{}`), where ExpenseOS's is.
            data: (v.data ?? {}) as Prisma.InputJsonValue,
            resolveNote: prev?.resolveNote ?? expl,
            resolvedAt: prev?.resolvedAt ?? (expl ? now : null),
            resolvedBy: prev?.resolvedBy ?? (expl ? loaded.submitter.id : null),
          };
        }),
      });
    }
  })(db);

  // 5. Severity tally for the FE submit gate. A WARNING is "unjustified" until
  // it carries a resolve note — the submit gate blocks while any remain.
  const counts = { info: 0, warning: 0, block: 0, unjustifiedWarning: 0 };
  for (const v of violations) {
    if (v.severity === 'INFO') counts.info += 1;
    else if (v.severity === 'WARNING') {
      counts.warning += 1;
      const justified = carried.has(key(v.lineItemId, v.ruleCode)) || explanationJustifies(v);
      if (!justified) counts.unjustifiedWarning += 1;
    } else counts.block += 1;
  }

  return { violations, counts };
}
