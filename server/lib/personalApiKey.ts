/**
 * The fixed policy for a personal API key — the one every user issues to an agent acting
 * as them, from `/profile`, without being asked to choose anything.
 *
 * ## Why this file exists at all
 *
 * The point of the simplified `/profile` box is that *every parameter is fixed by the
 * app*. That is only true if there is exactly one place the parameters are written down.
 * Six values, one constant: kind, name, scopes, rate limit, lifetime, IP allowlist.
 *
 * ## Why here, and not somewhere more obvious
 *
 *   · Not `@expenseos/api-scopes`. That package is the *grammar* — the scope vocabulary
 *     and the one rule that decides whether a scope list authorizes an operation. It is
 *     deliberately free of I/O and of product policy, and "which three scopes does a
 *     self-service key get" is product policy.
 *   · Not `apps/web/src/server/lib/apiKeys.ts`. That file is tokens and verification, and
 *     `apiKeyGuard.ts` imports it on the hot path of every API request. Provisioning
 *     policy is read twice in a key's life — at mint and at inspection — and does not
 *     belong in a module the guard pulls in per call.
 *
 * ## What this module does NOT do
 *
 * No Prisma, no I/O, no tRPC. It is data plus three pure functions, so it can be read by
 * the mint procedure, by the "is this key still in policy" query, and by tests, without
 * any of them dragging the others in.
 *
 * Ported from ExpenseOS `apps/web/src/server/lib/personalApiKey.ts` (1e682dd6), w6-04 (d88).
 */

import type { ApiKeyKind } from '@expenseos/db';

/**
 * The six fixed values.
 *
 * `expiresInDays` is a DURATION, not a date, and that is deliberate. The absolute
 * `expiresAt` is computed at mint time (see `personalKeyExpiresAt`); if the constant held
 * a date it would be a moving target that nothing could be compared against.
 *
 * `name` is absent here because it is derived per user — see `personalKeyName`.
 *
 * The `satisfies` clause is load-bearing: it pins `kind` to the Prisma enum, so renaming
 * or removing the `USER` member fails this build rather than failing at mint.
 */
export const PERSONAL_KEY_POLICY = {
  kind: 'USER',
  /**
   * Exactly three, and no more, because a self-service credential nobody chose the scopes
   * for must not carry authority its holder never considered. Read AND write on each:
   * there is no separate write flag in this vocabulary — holding `x.y.z` grants both.
   */
  scopes: [
    'expense_management.expense_report',
    'travel.travel_request',
    'collaboration.discussion',
  ],
  rateLimitPerMinute: 60,
  /** 180 days. A self-service credential with no end date is a credential nobody retires. */
  expiresInDays: 180,
  /** Empty means "enforced from nowhere", i.e. not enforced — the guard skips an empty list. */
  allowedIps: [],
} as const satisfies {
  kind: ApiKeyKind;
  scopes: readonly string[];
  rateLimitPerMinute: number;
  expiresInDays: number;
  allowedIps: readonly string[];
};

/** The longest `name` the provisioning path accepts — mirrors the zod cap in the router. */
const NAME_MAX = 120;

const SUFFIX = ' — personal key';

/**
 * What to call the key, given who it belongs to.
 *
 * Four cases, because both name columns on `User` are nullable and only `email` is not:
 *
 *   · both        → `"Jose Neto — personal key"`
 *   · first only  → `"Jose — personal key"`
 *   · last only   → `"Neto — personal key"`
 *   · neither     → `"jose.neto@e.inc — personal key"`
 *
 * **This makes no assumption about the shape of a personal name.** It does not split on
 * whitespace, take initials, upper-case, transliterate, or assume Latin script or a
 * two-part name. The columns are joined in the order they are stored and otherwise left
 * exactly as the user gave them. A whitespace-only column counts as absent, because a
 * name made of spaces is not a name and would otherwise produce `" — personal key"`.
 *
 * The suffix is English and not translated, deliberately: this string is *stored data*,
 * written once at mint and read later by an admin auditing the key list. A name that
 * changed with the reader's locale would make one row read two ways.
 */
export function personalKeyName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const parts = [user.firstName, user.lastName].map((p) => p?.trim() ?? '').filter((p) => p !== '');
  const who = parts.length > 0 ? parts.join(' ') : user.email.trim();
  return clampName(`${who}${SUFFIX}`);
}

/**
 * Keep the derived name inside the column's practical limit.
 *
 * An email address may be up to 254 characters, so `email + suffix` can overrun the 120 the
 * provisioning path accepts and the mint would fail — for the users with the least
 * complete profiles, which is the worst population to break for. Truncation is by CODE
 * POINT, not UTF-16 unit, so a name ending in an astral character cannot be cut into a
 * lone surrogate.
 */
function clampName(name: string): string {
  const chars = [...name];
  return chars.length <= NAME_MAX ? name : chars.slice(0, NAME_MAX).join('');
}

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/**
 * When a key minted now should stop working.
 *
 * Plain millisecond arithmetic, so the lifetime is exactly 180 × 24h regardless of which
 * daylight-saving boundaries fall inside it. `now` is a parameter so the mint path and the
 * tests can both pin it.
 */
export function personalKeyExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + PERSONAL_KEY_POLICY.expiresInDays * DAY_MS);
}

/** The shape `matchesPersonalPolicy` needs — a subset of `ApiKey`, so a row satisfies it. */
export type PersonalPolicyComparable = {
  scopes: readonly string[];
  rateLimitPerMinute: number | null;
  allowedIps: readonly string[];
  expiresAt: Date | null;
};

/**
 * Is this key still shaped the way the fixed policy says, or was it minted or edited
 * outside it?
 *
 * Four comparisons, and the fourth is the subtle one:
 *
 *   1. the scope SET matches exactly — no wider, no narrower, no substitutions
 *   2. `rateLimitPerMinute === 60`
 *   3. the IP allowlist is empty
 *   4. `expiresAt` is merely NOT NULL — **not** equal to any particular date
 *
 * (4) is not laziness. The policy holds a duration; the stored value is an absolute
 * instant computed at mint. Comparing them would make every key fail its own policy check
 * a millisecond after minting. What is actually being asked is "does this key expire at
 * all", and a legacy key with no end date is exactly the thing that answer must catch.
 *
 * Scopes are compared as a SET, because the router stores an array and array order carries
 * no meaning. A duplicate entry therefore compares equal to the single entry it repeats —
 * correct, since the authority granted is identical either way.
 *
 * Kind and ownership are deliberately NOT checked here. Which row we are holding is a
 * question the query answered; this function only judges the row's shape.
 */
export function matchesPersonalPolicy(key: PersonalPolicyComparable): boolean {
  return (
    sameScopeSet(key.scopes, PERSONAL_KEY_POLICY.scopes) &&
    key.rateLimitPerMinute === PERSONAL_KEY_POLICY.rateLimitPerMinute &&
    key.allowedIps.length === 0 &&
    key.expiresAt !== null
  );
}

function sameScopeSet(a: readonly string[], b: readonly string[]): boolean {
  const held = new Set(a);
  const wanted = new Set(b);
  if (held.size !== wanted.size) return false;
  for (const scope of wanted) if (!held.has(scope)) return false;
  return true;
}
