/**
 * Where the Claude API key comes from.
 *
 * Ported from ExpenseOS `packages/db/src/anthropicConfig.ts` (1e682dd6), with ExpenseOS's
 * signatures so the assistant router and chat route call it unchanged.
 *
 * VeloExpense (w6-03): the ENVIRONMENT only. ExpenseOS reads an `anthropic` integration
 * installation first and falls back to the environment; VeloExpense has no such integration,
 * because AI is native to the product and paid for by Velotech (d40) — the key is one per
 * environment, from Secrets Manager (`veloexpense/<stage>/anthropic-api-key`, injected as
 * ANTHROPIC_API_KEY), exactly as receipt reading reads it (worker/src/handlers/lib/anthropic.ts).
 * So `db` is accepted and unused, `source` is always 'env', and the model overrides are the
 * task definition's ASSISTANT_MODEL / ASSISTANT_FAST_MODEL / RECEIPT_EXTRACTION_MODEL.
 *
 * `null` is a first-class answer, not an error: the assistant declines to offer itself
 * rather than opening a panel that fails on its first message.
 */

export interface AnthropicConfig {
  apiKey: string;
  /** Assistant reasoning model, or undefined to take the package default. */
  assistantModel?: string;
  /** Assistant title/condense model, or undefined for the package default. */
  assistantFastModel?: string;
  /** Receipt/invoice extraction model, or undefined for the package default. */
  extractionModel?: string;
  /** Which source answered. VeloExpense: always the environment. */
  source: 'env';
}

/** Trim to a value or undefined — an empty variable must not pin an empty model. */
function clean(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** The environment's config, else null. VeloExpense: `_db` is ExpenseOS's signature only. */
export async function resolveAnthropicConfig(
  _db?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AnthropicConfig | null> {
  const apiKey = clean(env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;
  return {
    apiKey,
    assistantModel: clean(env.ASSISTANT_MODEL),
    assistantFastModel: clean(env.ASSISTANT_FAST_MODEL),
    extractionModel: clean(env.RECEIPT_EXTRACTION_MODEL),
    source: 'env',
  };
}

/** Is Claude usable at all? The availability probe both consumers ask. */
export async function anthropicConfigured(
  db?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return (await resolveAnthropicConfig(db, env)) !== null;
}
