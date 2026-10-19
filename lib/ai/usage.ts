/**
 * AI usage metering — one `ai_usage` row per real model call (d43).
 *
 * Ported from VeloLedger's `lib/ai/gateway.ts` (its rate table, cost arithmetic and
 * `recordUsage`) and its 0050 table, NOT from ExpenseOS, which meters nothing. VeloLedger
 * routes every call through one gateway that records as it returns; VeloExpense's calls are
 * ExpenseOS's own (`@expenseos/receipt-extraction`, through the Anthropic SDK), ported
 * as they are, so the recording is a function the caller invokes with the response it got.
 *
 * Token counts are the authoritative meter; the platform owns the token→credit conversion
 * (VeloCRM's usage service, 6,000 tokens per credit). Cost is stored in micro-USD
 * (millionths of a dollar) so a small per-call cost does not round to zero, and is
 * informational: a stale rate here changes no invoice.
 *
 * INCLUDED vs METERED (VeloExpense, d43). The VeloExpense pricing doc (Sept 2026) includes
 * receipt AI in every plan, under a fair-use allowance, and meters credits only for the
 * unbounded analysis features. So every call is recorded — the cost and the fair-use
 * count need it — but only a METERED feature's rows are ever reported to the platform,
 * and none of today's features is metered.
 */
import type { Prisma } from '@/lib/generated/prisma/client';

/**
 * Which feature drove a call. VeloLedger's union, VeloExpense's members.
 * w6-03: `assistant` — every Messages API call a chat turn makes (the answer's rounds, the
 * title, the two reviews, the help-article reads), server/lib/assistantUsage.ts.
 */
export type AiFeature = 'receipt_extraction' | 'expense_determination' | 'assistant';

/**
 * Features whose use spends a customer's AI credits (reported to the platform). Receipt
 * reading is included (d43), so it is not here.
 *
 * w6-03: the assistant is. It is always on (CORE, AI is native — John, 10–11 Oct), so
 * nothing here refuses a turn when a tenant's credits run out: as with receipt reading, the
 * call runs and is recorded, and the platform, which owns the allowance and the
 * token→credit conversion, bills what is over it.
 */
export const METERED_FEATURES: ReadonlySet<AiFeature> = new Set<AiFeature>(['assistant']);

/**
 * Per-model rates in micro-USD per token (i.e. USD-per-million-tokens directly:
 * $3 / Mtok == 3 micro-USD / token). VERIFY against current Anthropic pricing —
 * token counts are authoritative and the platform owns the billed price, so a
 * stale rate here only affects the informational `cost_micro_usd` column.
 */
interface Rate {
  inMicroUsdPerTok: number;
  outMicroUsdPerTok: number;
}
const RATES: Record<string, Rate> = {
  // VERIFY against current Anthropic pricing. Unknown models fall through to a
  // 0 cost (informational only) — never a hard failure.
  'claude-sonnet-5': { inMicroUsdPerTok: 3, outMicroUsdPerTok: 15 },
  'claude-sonnet-4-6': { inMicroUsdPerTok: 3, outMicroUsdPerTok: 15 },
  // w6-03: the assistant's fast model (titles, reviews, article reads). VERIFY.
  'claude-haiku-4-5': { inMicroUsdPerTok: 1, outMicroUsdPerTok: 5 },
};

export function computeCostMicroUsd(
  model: string,
  inTok: number,
  outTok: number,
  opts: { batch?: boolean } = {},
): bigint {
  const rate = RATES[model];
  if (!rate) return 0n;
  const full =
    BigInt(inTok) * BigInt(rate.inMicroUsdPerTok) + BigInt(outTok) * BigInt(rate.outMicroUsdPerTok);
  // VeloExpense (w3-02b): a Message Batches call is billed at half the rate, which is the
  // reason the batch path exists. VERIFY with the rates above.
  return opts.batch ? full / 2n : full;
}

/**
 * The token counts an Anthropic Messages response reports, or null when it reports none.
 * VeloExpense: the extraction package hands back the response itself (`rawResponse`), so
 * the counts are read from its `usage` here rather than by a gateway.
 */
export function usageOf(response: unknown): { inputTokens: number; outputTokens: number } | null {
  const usage = (response as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)
    ?.usage;
  if (!usage) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return { inputTokens: n(usage.input_tokens), outputTokens: n(usage.output_tokens) };
}

export interface RecordUsageInput {
  feature: AiFeature;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Our own correlation id for the call. */
  requestId: string;
  receiptId?: string | null;
  actorUserId?: string | null;
  /** Made through the Message Batches API (half rate). */
  batch?: boolean;
}

/**
 * Write one `ai_usage` row, in the caller's tenant scope (the row's organization is the
 * scope's, as every VeloExpense tenant table's is).
 *
 * Callers treat this as best-effort, as VeloLedger's gateway does: a usage write never
 * fails the user's operation, but a failure is logged, because a dropped row under-counts
 * with no other trace.
 */
export async function recordUsage(
  db: Pick<Prisma.TransactionClient, 'aiUsage'>,
  input: RecordUsageInput,
): Promise<void> {
  await db.aiUsage.create({
    data: {
      feature: input.feature,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costMicroUsd: computeCostMicroUsd(input.model, input.inputTokens, input.outputTokens, {
        batch: input.batch,
      }),
      metered: METERED_FEATURES.has(input.feature),
      receiptId: input.receiptId ?? null,
      actorUserId: input.actorUserId ?? null,
      requestId: input.requestId,
    },
  });
}
