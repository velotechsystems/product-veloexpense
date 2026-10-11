/**
 * The Claude credential, for the worker's document-extraction jobs.
 *
 * Thin wrapper over `resolveAnthropicConfig` that reduces it to what extraction
 * actually needs — key plus model — so a handler threads one small object rather than
 * a config shape it has no other use for.
 *
 * Resolved per job rather than cached for the process: the credential is a database
 * row now, and an admin who rotates a key or pins a cheaper extraction model should
 * see it take effect on the next receipt, not the next deploy. One indexed read per
 * job, against a job that is about to make a network call to a vision model.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/lib/anthropic.ts` (550b2945).
 * VeloExpense: the credential is NOT a database row. ExpenseOS keeps it as an `anthropic`
 * integration a tenant admin installs; in VeloExpense AI is native to the product (d40)
 * and paid for by Velotech, so the key is one per environment, from Secrets Manager
 * (`veloexpense/<stage>/anthropic-api-key`, injected as ANTHROPIC_API_KEY), and the model
 * is RECEIPT_EXTRACTION_MODEL when the task definition pins one. A rotated key reaches the
 * worker when its task restarts, not on the next receipt.
 */

export interface AnthropicForExtraction {
  apiKey: string;
  /** Undefined leaves the package's own default in force. */
  model?: string;
}

/**
 * `null` when Claude is not configured at all.
 *
 * Callers pass the result straight through: extraction treats a missing credential as
 * `ExtractionUnavailableError`, which the satellite records as PENDING rather than
 * FAILED — the expense and the uploaded file both survive, and the job is retryable
 * once somebody installs the integration. That is why this returns null instead of
 * throwing, and why the worker does not gate the whole job on it.
 */
export async function anthropicForExtraction(): Promise<AnthropicForExtraction | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.RECEIPT_EXTRACTION_MODEL?.trim() || undefined;
  return { apiKey, model };
}
