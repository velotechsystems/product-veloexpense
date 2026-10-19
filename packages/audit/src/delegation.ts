/**
 * VeloExpense (w6-03): ported verbatim from ExpenseOS `packages/audit/src/delegation.ts` (1e682dd6).
 *
 * Ambient delegation context — "this action was performed through an API key".
 *
 * The problem: `Audit.actorId` must stay the acting PERSON, because their authority is what
 * was used and a row claiming a robot approved something would be false. But the fact that a
 * key drafted it has to survive, and that fact is known at the edge of the request — not at
 * the several dozen `withAudit` call sites scattered across the routers.
 *
 * Threading it through would mean editing every one of those call sites and every future one,
 * and the failure mode of forgetting is silent: an audit row that looks like a person acting
 * directly. So instead the transport opens a scope for the request and `writeAudit` reads it.
 *
 *     await runWithDelegation({ viaApiKey: { id, name, kind } }, () => handler(request));
 *
 * `AsyncLocalStorage` is the right primitive: the scope follows the async call chain into
 * every procedure the request touches, and cannot leak across concurrent requests the way a
 * module-level variable would.
 *
 * The marker lands in `Audit.details`, which is **inside the hash payload** — so it cannot be
 * stripped from a row without breaking the chain. That is why this needed no change to the
 * frozen 9-field payload.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface DelegationContext {
  /** Identity of the credential the request arrived with. */
  readonly viaApiKey?: Record<string, unknown>;
  /**
   * Set when a model drafted the action and a human pressed confirm.
   *
   * The person's authority is still what was used and `actorId` is still them — they pressed
   * it. But "who approved this" reads differently when the proposal came from an assistant,
   * and a reviewer six months later has no other way to tell. Same mechanism, same hashed
   * `details`, different question answered.
   */
  readonly viaAssistant?: Record<string, unknown>;
}

/** The markers this module merges. Adding one is a one-line change here and nowhere else. */
const MARKERS = ['viaApiKey', 'viaAssistant'] as const;

const storage = new AsyncLocalStorage<DelegationContext>();

/** Run `fn` with a delegation context every audit write inside it will pick up. */
export function runWithDelegation<T>(context: DelegationContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/** The delegation context for the current async scope, if any. */
export function currentDelegation(): DelegationContext | undefined {
  return storage.getStore();
}

/**
 * Merge the ambient delegation markers into an audit row's details.
 *
 * Explicit input wins per marker. A call site that already set one knows something this does
 * not, and silently overwriting it would make the more-specific record the less reliable one.
 */
export function withDelegation(
  details: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const context = currentDelegation();
  if (!context) return details;
  let merged = details;
  for (const marker of MARKERS) {
    const value = context[marker];
    if (value === undefined) continue;
    if (merged && marker in merged) continue;
    merged = { ...(merged ?? {}), [marker]: value };
  }
  return merged;
}
