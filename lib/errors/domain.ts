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
 * ── PARAMETERS: THE 2c-1 CONSTRAINT, WALKED BACK ON PURPOSE ────────────────
 *
 * Part 2c-1 said a user message carries NO values, and argued that a refusal is
 * a statement about the action somebody just took, on the screen they took it
 * from, with their own input in front of them. That holds for the employee and
 * approver half — "the end date is before the start date" genuinely needs no
 * dates in it.
 *
 * It does NOT hold across the admin half, and pretending otherwise would have
 * cost real information. Fourteen of those messages carry a value the person
 * cannot see anywhere on the page:
 *
 *   that account is in use (3 categories, 12 expense lines, 2 child accounts)
 *   #0284c7 cannot carry readable text: 4.10:1 against white, 4.46:1 against ink
 *   the logo is 812 KiB and the limit is 512 KiB
 *   the ledger reports these account numbers more than once: 4010, 4020
 *
 * Every one of those is a COMPUTED fact. "That account is in use" without the
 * counts leaves an admin hunting; the contrast message without both ratios is
 * the exact defect `branding-flow` was written to pin ("Contrast too low" is not
 * something an admin can act on). So parameters exist, scoped by three rules:
 *
 *   1. Declared. Each code lists the keys its sentence needs, exactly as
 *      `POLICY_MESSAGES.requires` does, and the test asserts the throw sites
 *      supply them.
 *   2. Never an identifier. `assertRenderableParams` refuses a UUID-shaped
 *      value, because the whole point of part 2c was getting record ids off
 *      screens and out of URLs. A count, a ratio, an account number, a size, a
 *      mime type, something the person just typed — those are facts about their
 *      own action. A row's primary key never is.
 *   3. Carried IN the error value, not beside it: `?error=CODE~<base64url>`.
 *      One query key and one prop, so all twenty `ErrorBanner` call sites and
 *      every page that reads `searchParams.error` are untouched. A second key
 *      would have meant twenty pages threading it, which is MT-3 again.
 *
 * Where a value only chose between two wordings it is still a second CODE
 * rather than a parameter (`BLOCKED_BY_POLICY_ONE`/`_MANY`, and money's
 * one-decimal-place case) — a parameter that exists to pick a branch is a
 * template language starting up.
 */
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';

/**
 * The base class for every error this product throws deliberately.
 *
 * Subclasses keep their own `code` union — it is what the CALLERS branch on and
 * this changes none of it. `userMessage` is additive and optional, so a class
 * converts one throw site at a time.
 */
/** A code, with the values its sentence interpolates. */
export interface UserMessage {
  code: UserMessageCode;
  params?: MessageParams;
}

export abstract class DomainError extends Error {
  /**
   * What a person should be told, or null for "nobody decided". Null is not a
   * gap to fill in later: an invariant failure genuinely has no user-facing
   * sentence, and inventing one would be worse than the generic.
   */
  readonly userMessage: UserMessage | null;

  constructor(message: string, userMessage: UserMessageCode | UserMessage | null = null) {
    super(message);
    // A bare code is accepted so that part 2c-1's ~35 call sites did not have to
    // be rewritten to `{ code: … }` for the sake of the fourteen that need
    // params. The normalisation is here, once, rather than at every throw.
    this.userMessage =
      userMessage === null
        ? null
        : typeof userMessage === 'string'
          ? { code: userMessage }
          : userMessage;
  }
}

/** `null` for anything that is not one of ours, or has no reader copy. */
export function userMessageOf(err: unknown): UserMessage | null {
  return err instanceof DomainError ? err.userMessage : null;
}

/**
 * What goes in `?error=`.
 *
 * THE ONE PLACE an exception becomes a query parameter. Two cases now, where
 * 2c-1 had three:
 *
 *   1. A `userMessage` — `CODE`, or `CODE~<base64url params>`. The page renders
 *      it for its reader.
 *   2. ANYTHING ELSE — the generic, and the real error is logged with its stack.
 *
 * **The transitional branch is gone.** 2c-1 had a middle case: a `DomainError`
 * with no `userMessage` put its English message in the URL, which kept the
 * uncatalogued admin screens working while the catalogue filled in. Every
 * reachable message is now catalogued, so that branch would only ever fire for
 * an invariant failure — and an invariant failure's message is written for an
 * engineer. Deleting it is what finishes IL-11, and it closes the last of the
 * disclosure: nothing an exception carries reaches a URL any more, whoever threw
 * it.
 *
 * It also means an arbitrary string in a hand-edited link no longer renders as
 * though the product said it — `renderUserMessage` refuses anything that is not
 * a known code.
 *
 * Note what case 2 does NOT do: swallow. The error is logged before the generic
 * is returned, so the information moves from the user's URL to the place that
 * was always supposed to have it.
 */
export function errorParam(err: unknown, context: string): string {
  return encodeUserMessage(userMessageOrGeneric(err, context));
}

/**
 * The same decision as `errorParam`, stopping one step earlier.
 *
 * For a caller that has to hand the message onwards as DATA rather than as a
 * query value — `decideFromToken` returns `{ kind: 'REFUSED', reason }` and the
 * action encodes it. Splitting it this way is what lets `reason` be typed as a
 * `UserMessage` instead of an opaque string, so a code that does not exist is a
 * compile error at the throw site rather than a generic banner in production.
 */
export function userMessageOrGeneric(err: unknown, context: string): UserMessage {
  const user = userMessageOf(err);
  if (user !== null) return user;
  console.error(`[${context}] unexpected error surfaced to a user:`, err);
  return { code: 'UNEXPECTED' };
}

/**
 * The query value for a code a caller ALREADY has, with no exception to inspect.
 *
 * Two callers: `/approve`, where `decideFromToken` returns a refusal code rather
 * than throwing, and the ledger queue's dry run, where a missing row is a plain
 * `null` return. Separate from `errorParam` because it takes a
 * `UserMessageCode` — the compiler checks the code exists, which a bare string
 * in a template literal would not — and because `check:i18n` recognises both
 * names, so the destination gate stays meaningful.
 */
export function errorCodeParam(code: UserMessageCode): string {
  return encodeURIComponent(code);
}

/* ── the wire format ───────────────────────────────────────────────────────── */

/**
 * Values a sentence may interpolate. Deliberately narrow: no objects, no
 * nesting, nothing that needs a schema. If a message wants more than this, it
 * wants to be two messages.
 */
export type MessageParams = Record<string, string | number>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refuse a parameter that is a record identifier.
 *
 * Rule 2 from the header, enforced rather than documented. Part 2c existed
 * because `user ${actorId} may not decide approval task ${taskId}` reached a
 * screen; adding a parameter mechanism without this check would be handing that
 * defect a new road in, and a nicer one — a URL, where it also gets logged by
 * every proxy in between.
 *
 * Throws rather than dropping the key: a caller passing an id has made a
 * mistake about what this mechanism is for, and the tests are where that should
 * be loud. `errorParam` is the only caller and it is inside a catch already, so
 * the worst case at runtime is the generic message, which is the right answer
 * for a message we cannot safely render.
 */
export function assertRenderableParams(params: MessageParams): void {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && UUID.test(value.trim())) {
      throw new Error(
        `refusing to put a record id in a user message: param "${key}" looks like a uuid`,
      );
    }
  }
}

/**
 * `CODE`, or `CODE~<base64url of the params>`.
 *
 * base64url rather than `encodeURIComponent(JSON.stringify(…))` because the
 * result is nested inside a query value that is itself encoded by the caller,
 * and double-encoding JSON's quotes and braces is how a URL gets long enough to
 * be truncated by something in the middle. base64url has no character any of
 * those layers will touch.
 */
export function encodeUserMessage(user: UserMessage): string {
  if (user.params === undefined || Object.keys(user.params).length === 0) return user.code;
  try {
    assertRenderableParams(user.params);
  } catch (err) {
    console.error('[user-message] refusing to encode params:', err);
    return 'UNEXPECTED';
  }
  const json = JSON.stringify(user.params);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  return `${user.code}~${b64}`;
}

/**
 * Split a `?error=` value back into a code and its params.
 *
 * Never throws and never trusts the input: the value arrives from a URL, so it
 * can be truncated, hand-edited or from an older release. A params blob that
 * does not decode is dropped and the CODE is still returned — a sentence with
 * its numbers missing degrades to the generic through `requires`, which is a
 * better outcome than losing the fact that something failed at all.
 */
export function decodeUserMessage(value: string): { code: string; params: MessageParams } {
  const cut = value.indexOf('~');
  if (cut < 0) return { code: value, params: {} };
  const code = value.slice(0, cut);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value.slice(cut + 1), 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { code, params: {} };
    }
    const params: MessageParams = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') params[k] = v;
    }
    return { code, params };
  } catch {
    return { code, params: {} };
  }
}
