/**
 * VX4-7 part 2c — the two audiences a thrown error has, and why one string
 * cannot serve both.
 *
 * ── WHAT THE AUDIT FOUND, RESTATED FROM THE CODE ────────────────────────────
 *
 * IL-11 counts 157 English server messages rendered verbatim in upstream's UI
 * and says ours has "the same exposure and the same choice to make". Making it
 * turned up something the count does not: our messages are not English *copy*
 * that happens to be untranslated. They are DIAGNOSTICS.
 *
 *   `approval task ${taskId} does not exist`
 *   `user ${actorId} may not decide approval task ${taskId}`
 *   `report ${reportId} not found`
 *
 * Those are three of 265 throw sites, and every one of them reaches a screen
 * today through `?error=${encodeURIComponent(err.message)}`. A person who is not
 * an approver, clicking a stale link, is told the task's UUID and their own —
 * which is both unreadable and more than they should learn. Translating that
 * sentence into French would have been the wrong ticket.
 *
 * So the split is not English-vs-French. It is:
 *
 *   `message`      — for the LOG. Ids, statuses, whatever the next engineer
 *                    needs. Stays exactly as it is; tests keep asserting on it.
 *   `userMessage`  — for the SCREEN. A code into `lib/i18n/catalog/errors.ts`,
 *                    or null.
 *
 * `null` is the important default. An error with no `userMessage` is one nobody
 * decided a person should read, so the UI shows a generic sentence and the real
 * one goes to the server log. That closes the disclosure gap BY CONSTRUCTION
 * rather than by remembering — MT-3's lesson, which this project has now
 * relearned three times: a gate at the edge is a gate the next caller forgets.
 *
 * ── WHY A MESSAGE CODE WHEN 19 CLASSES ALREADY CARRY A `code` ───────────────
 *
 * They do, and it is not enough — the same discovery part 2b made one layer
 * down. `DelegationError`'s `INVALID_RANGE` covers three different sentences
 * ("give a start date", "give an end date, or leave it open-ended", "the end
 * date is before the start date") because a CALLER branching on the code does
 * not need to tell them apart. A READER does; they are three different things to
 * go and fix. And `NOT_FOUND` covers both "that person is not in this
 * organization" — which a user caused and can fix — and "delegation not found
 * after insert", which is an invariant failure no user should ever see.
 *
 * An error code answers "what kind of failure is this". A message code answers
 * "what should the person be told". Those are different questions, and the
 * existing codes answer the first one well enough to keep.
 *
 * ── NO PARAMETERS, DELIBERATELY ─────────────────────────────────────────────
 *
 * `UserMessageCode` carries no values. That is a constraint, not an oversight:
 * it is what lets the code travel in `?error=CODE` and be rendered by the page
 * in the reader's locale, with no encoding scheme, no jsonb, and no second
 * source of truth about what a sentence interpolates. Where a message wanted a
 * value, the branch became its own code (`BLOCKED_BY_POLICY_ONE` /
 * `_MANY`) — one code per branch, exactly as `POLICY_MESSAGE_CODES` does.
 *
 * The one message that loses information is the blocking-violation count, and
 * the policy panel immediately below the banner enumerates every one of them.
 */
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';

/**
 * The base class for every error this product throws deliberately.
 *
 * Subclasses keep their own `code` union — it is what the CALLERS branch on and
 * this changes none of it. `userMessage` is additive and optional, so a class
 * converts one throw site at a time.
 */
export abstract class DomainError extends Error {
  /**
   * What a person should be told, or null for "nobody decided". Null is not a
   * gap to fill in later for most sites: an invariant failure genuinely has no
   * user-facing sentence, and inventing one would be worse than the generic.
   */
  readonly userMessage: UserMessageCode | null;

  constructor(message: string, userMessage: UserMessageCode | null = null) {
    super(message);
    this.userMessage = userMessage;
  }
}

/** `null` for anything that is not one of ours, or has no reader copy. */
export function userMessageOf(err: unknown): UserMessageCode | null {
  return err instanceof DomainError ? err.userMessage : null;
}

/**
 * What goes in `?error=`.
 *
 * THE ONE PLACE an exception becomes a query parameter. Three cases, in the
 * order that matters:
 *
 *   1. A `userMessage` — the code travels, and the page renders it for its
 *      reader. This is the destination for every reachable throw site.
 *   2. A `DomainError` without one — its English message travels, exactly as
 *      before. Transitional: it keeps every admin screen saying what it says
 *      today while the catalogue fills in, and part 2c-2 deletes this branch.
 *   3. ANYTHING ELSE — a generic code, and the real error is logged. This is the
 *      security half. A `TypeError` from a bug, a `pg` error carrying a fragment
 *      of SQL, an `AggregateError` from a fetch — none of those were ever
 *      supposed to be printed, and `err instanceof Error ? err.message : …` at
 *      eleven call sites printed all of them.
 *
 * Note what case 3 does NOT do: swallow. The error is logged with its stack
 * before the generic code is returned, so the information moves from the user's
 * URL to the place that was always supposed to have it.
 */
export function errorParam(err: unknown, context: string): string {
  const code = userMessageOf(err);
  if (code !== null) return code;
  if (err instanceof DomainError) return err.message;
  console.error(`[${context}] unexpected error surfaced to a user:`, err);
  return 'UNEXPECTED';
}
