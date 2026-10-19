// Ported from ExpenseOS `apps/web/src/server/policy/validateTravel.ts` (1e682dd6), w6-01 (d88). Each
// adaptation is marked "VeloExpense (w6-01):".
/**
 * Policy engine orchestrator for TRAVEL REQUESTS — the travel half of `validate.ts`.
 *
 * Same five steps, same wholesale-replace, same justification carry-forward. What
 * differs is the subject, and everything that follows from it:
 *
 *   · the fact set is the estimate's budget lines with their travel payloads, not
 *     expenses with receipts and merchants;
 *   · a BLOCK is the normal outcome rather than the exception. Travel blocks where
 *     expense warns, because nothing has been spent yet — the discouraged booking can
 *     be refused before it is made instead of explained afterwards;
 *   · there is no per-expense `explanation` standing in as a justification. On a report
 *     an "Explain this charge" note auto-justifies that expense's WARNINGs; a travel
 *     line has no such field, so a warning here is justified only by an explicit
 *     comment through `justifyViolation`.
 *
 * A separate file rather than a branch in `validate.ts`: the loader is the bulk of that
 * module and none of it applies here (no policies-by-category, no fiscal close, no
 * per-diem inputs, no budget impacts). Sharing it would mean six early returns.
 */

import type { Prisma, TenantDb } from '@/lib/db/prisma';
import { runTravelRules } from './engine';
import type {
  PolicyRuleInstance,
  RuleScope,
  RuleTranslator,
  TravelLineKind,
  TravelPriceBasis,
  TravelRequestContext,
  Violation,
} from './types';

export interface ValidateTravelOpts {
  /** VeloExpense (w6-01): the tenant-scoped client (lib/db/prisma), already inside the
   *  request's transaction — ExpenseOS's `PrismaClient | TransactionClient`, as validate.ts. */
  db: TenantDb;
  travelRequestId: string;
  /** Localized-message renderer wired at the tRPC boundary. */
  t: RuleTranslator;
}

export interface ValidateTravelResult {
  violations: Violation[];
  /** `unjustifiedWarning` is what the submit gate blocks on alongside `block` — a
   *  WARNING is submittable only once the traveller has attached a comment over it. */
  counts: { info: number; warning: number; block: number; unjustifiedWarning: number };
}

export async function validateTravelRequest(
  opts: ValidateTravelOpts,
): Promise<ValidateTravelResult> {
  const { db, travelRequestId, t } = opts;

  const loaded = await db.travelRequest.findUnique({
    where: { id: travelRequestId },
    select: {
      id: true,
      tripType: true,
      departDate: true,
      returnDate: true,
      destinationCity: true,
      destinationCountry: true,
      currency: { select: { code: true } },
      submitter: {
        select: {
          id: true,
          jobLevelId: true,
          departmentId: true,
          legalEntityId: true,
          businessUnitId: true,
          roleId: true,
        },
      },
      budgetLines: {
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          categoryId: true,
          kind: true,
          payload: true,
          amountMinor: true,
          basis: true,
          notes: true,
          category: { select: { code: true } },
        },
      },
    },
  });
  if (!loaded) {
    throw new Error(`policy.validateTravel: travel request ${travelRequestId} not found`);
  }

  const now = new Date();
  const sub = loaded.submitter;
  // The SAME dimension filter the report validator applies, so a rule scoped to a
  // department means the same thing on both sides of the product.
  const ruleRows = await db.policyRule.findMany({
    where: {
      enabled: true,
      scope: 'TRAVEL_REQUEST',
      AND: [
        { effectiveFrom: { lte: now } },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
        { OR: [{ departmentId: null }, { departmentId: sub.departmentId }] },
        { OR: [{ jobLevelId: null }, { jobLevelId: sub.jobLevelId }] },
        { OR: [{ legalEntityId: null }, { legalEntityId: sub.legalEntityId }] },
        { OR: [{ businessUnitId: null }, { businessUnitId: sub.businessUnitId }] },
        { OR: [{ roleId: null }, { roleId: sub.roleId }] },
      ],
    },
  });
  const rules: PolicyRuleInstance[] = ruleRows.map((r) => ({
    id: r.id,
    kindCode: r.kindCode,
    // VeloExpense (w6-01): the column is text under a CHECK (0064/0077), not a Prisma enum.
    scope: r.scope as RuleScope,
    severity: r.severity,
    condition: r.condition,
    params: r.params,
    messageKey: r.messageKey,
    categoryId: r.categoryId,
  }));

  const travel: TravelRequestContext = {
    request: {
      id: loaded.id,
      tripType: loaded.tripType,
      departDate: loaded.departDate,
      returnDate: loaded.returnDate,
      destinationCity: loaded.destinationCity,
      destinationCountry: loaded.destinationCountry,
      currencyCode: loaded.currency.code,
      totalMinor: loaded.budgetLines.reduce((a, l) => a + l.amountMinor, 0n),
    },
    submitter: { id: sub.id, jobLevelId: sub.jobLevelId },
    lines: loaded.budgetLines.map((l) => ({
      id: l.id,
      categoryId: l.categoryId,
      categoryCode: l.category.code ?? '',
      // VeloExpense (w6-01): text under 0077's CHECKs, so typed here rather than by Prisma.
      kind: l.kind as TravelLineKind,
      payload: l.payload,
      amountMinor: l.amountMinor,
      basis: l.basis as TravelPriceBasis,
      notes: l.notes,
    })),
    t,
  };

  const violations = runTravelRules({ travel, rules });

  // Replace the prior set, carrying forward any justification the traveller already
  // attached to an unchanged exception. Identity is (line, ruleCode) — the same key the
  // report side uses, so a re-validate on an untouched line does not wipe a comment.
  const key = (lineId: string | null, ruleCode: string) => `${lineId ?? ''}|${ruleCode}`;
  const carried = new Map<
    string,
    { resolveNote: string | null; resolvedAt: Date | null; resolvedBy: string | null }
  >();
  // VeloExpense (w6-01): `db` is the tenant client, already inside the request's one
  // transaction (lib/db/prisma) — ExpenseOS opens one here, as validate.ts notes.
  await (async (tx: TenantDb) => {
    // Same row lock as `validateReport`, for the same reason: two overlapping validates
    // would otherwise both see an empty prior set and both insert. See the comment there.
    await tx.$queryRaw`SELECT id FROM travel_request WHERE id = ${travelRequestId}::uuid FOR UPDATE`;
    const prior = await tx.policyViolation.findMany({
      where: { travelRequestId },
      select: {
        travelLineId: true,
        ruleCode: true,
        resolveNote: true,
        resolvedAt: true,
        resolvedBy: true,
      },
    });
    for (const p of prior) {
      if (p.resolvedAt) {
        carried.set(key(p.travelLineId, p.ruleCode), {
          resolveNote: p.resolveNote,
          resolvedAt: p.resolvedAt,
          resolvedBy: p.resolvedBy,
        });
      }
    }
    await tx.policyViolation.deleteMany({ where: { travelRequestId } });
    if (violations.length > 0) {
      await tx.policyViolation.createMany({
        data: violations.map((v) => {
          const prev = carried.get(key(v.lineItemId, v.ruleCode));
          return {
            travelRequestId,
            // The engine's generic line anchor, written into the travel column. The
            // CHECK constraint is what stops this ever landing in `lineItemId`.
            travelLineId: v.lineItemId,
            ruleCode: v.ruleCode,
            severity: v.severity,
            message: v.message,
            // VeloExpense (w6-01): the column is never null (`{}`), as validate.ts writes it.
            data: (v.data ?? {}) as Prisma.InputJsonValue,
            resolveNote: prev?.resolveNote ?? null,
            resolvedAt: prev?.resolvedAt ?? null,
            resolvedBy: prev?.resolvedBy ?? null,
          };
        }),
      });
    }
  })(db);

  const counts = { info: 0, warning: 0, block: 0, unjustifiedWarning: 0 };
  for (const v of violations) {
    if (v.severity === 'INFO') counts.info += 1;
    else if (v.severity === 'WARNING') {
      counts.warning += 1;
      if (!carried.has(key(v.lineItemId, v.ruleCode))) counts.unjustifiedWarning += 1;
    } else counts.block += 1;
  }

  return { violations, counts };
}
