/**
 * API key provisioning.
 *
 * Two kinds:
 *
 *   · A **USER** key is a personal access token. It carries exactly its owner's authority,
 *     never more — `apiKeyGuard` re-resolves the owner's real RBAC on every request.
 *   · A **PLATFORM** key is a service account that can act as any active user. Holding one
 *     is holding an impersonation capability.
 *
 * **Provisioning either kind takes `admin.apiKey.create`.** Not because minting a personal
 * key grants authority its owner lacked — it cannot — but because `create` and `update`
 * take arbitrary `scopes`, `expiresAt` and `allowedIps`, and a self-serve mint is therefore
 * a self-serve way to hold a key wider and longer-lived than any policy intends. A
 * compromised session widens a key the same way. Configuration is the admin's call; an
 * ordinary user asks for a key on fixed terms rather than describing the one they want.
 * Those fixed terms are `requestPersonal` / `regeneratePersonal` / `personal` below, which
 * take no input at all and are `protectedProcedure` on purpose — the reasoning is written
 * out at the head of that block and is not an oversight to tidy up.
 *
 * Visibility and management are separate questions, deliberately:
 *
 *   · You SEE a key if it acts as you (`userId = me`), or — with `admin.apiKey.list` — if
 *     it is a platform key.
 *   · You MANAGE a key if you minted it (`createdById = me`), or you hold
 *     `admin.apiKey.revoke`. So somebody can hold a token provisioned for them, see it in
 *     their list, and not be able to rescope or revoke it.
 *
 * Two questions means two predicates, everywhere both are asked: `list` reports them as
 * rows plus `manageable`, and the self-service box as rows plus `revocable`. Answering one
 * with the other's predicate is how a live key went missing from `/profile` — see
 * `personalKeysActingAs` and `manageablePersonalKeys`.
 *
 * The plaintext token is returned once, by `create`, and never again — nothing stores it.
 *
 * Ported from ExpenseOS `apps/web/src/server/routers/apiKeys.ts` (1e682dd6), w6-04 (d88).
 * VeloExpense: every procedure runs in the caller's tenant (the `tenant` middleware), and
 * `api_key` is per tenant (0079), so "a platform key" here is always THIS company's. The
 * personal key box lives on `/preferences`, VeloExpense's ExpenseOS `/profile`.
 */

import { createHash } from 'node:crypto';
import { ALL_SCOPES, unknownScopes } from '@expenseos/api-scopes';
import { auditActions, withAudit } from '@expenseos/audit';
import type { ApiKeyKind, Prisma } from '@expenseos/db';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { mintToken } from '@/server/lib/apiKeys';
import { validateAllowlistEntry } from '@/server/lib/ipMatch';
import {
  matchesPersonalPolicy,
  PERSONAL_KEY_POLICY,
  personalKeyExpiresAt,
  personalKeyName,
} from '@/server/lib/personalApiKey';
import { protectedProcedure, router, withPermission } from '@/server/trpc';

/** Never selects `tokenHash` — there is no reason for it to leave the database. */
const KEY_SELECT = {
  id: true,
  kind: true,
  name: true,
  prefix: true,
  userId: true,
  createdById: true,
  scopes: true,
  rateLimitPerMinute: true,
  allowedIps: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

const scopeList = z.array(z.string()).max(ALL_SCOPES.length);

/**
 * Refuse an address entry we cannot match against.
 *
 * An unparseable entry does not fail open or closed in an obvious way — it simply never
 * matches, so the key is refused from everywhere with `IP_BLOCKED` and nothing says why.
 * Catching it here means the mistake is visible at the moment somebody makes it.
 */
function assertAllowedIps(entries: readonly string[]) {
  const bad = entries.filter((e) => !validateAllowlistEntry(e));
  if (bad.length > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Not valid addresses or CIDR blocks: ${bad.join(', ')}`,
    });
  }
}

/** Refuse a scope this build does not know: it would authorize nothing, silently. */
function assertScopes(scopes: readonly string[]) {
  const unknown = unknownScopes(scopes);
  if (unknown.length > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Unknown scopes: ${unknown.join(', ')}`,
    });
  }
}

/**
 * The columns the personal box needs. Deliberately NOT `KEY_SELECT`: the `createdBy`
 * relation would join a user row onto every key on every poll, and `userId` is the caller
 * on every row by construction, because the query filters on it.
 *
 * `createdById` IS selected, and it is not decoration: it is the row half of the manage
 * question (see `manageablePersonalKeys`), so `personal` cannot say whether a row is the
 * caller's to revoke without it. This docblock used to justify omitting it on the grounds
 * that it, too, was always the caller — which was only true while the query filtered on
 * it, and that filter is exactly what this split removed.
 */
const PERSONAL_KEY_SELECT = {
  id: true,
  name: true,
  prefix: true,
  createdById: true,
  scopes: true,
  rateLimitPerMinute: true,
  allowedIps: true,
  lastUsedAt: true,
  expiresAt: true,
  createdAt: true,
} as const;

/**
 * TWO predicates, because there are two questions — and one of them used to answer both.
 *
 * `docs/design/api-keys.md` § "Visibility vs management" rules them apart, and has since
 * before any of this shipped:
 *
 *   · You **see** a key if it acts as you (`userId = you`).
 *   · You **manage** a key if you minted it (`createdById = you`), or you hold
 *     `admin.apiKey.revoke`.
 *
 * A single `{ userId, createdById }` predicate — which is what Phase 3 shipped — collapses
 * them and uses the *manage* answer to decide *visibility*. That is a hole rather than an
 * approximation: an admin holding `admin.apiKey.revoke` calls `rotate` on somebody's
 * personal key, the replacement is written `userId: <them>, createdById: <admin>`, and
 * from then on their `/profile` reports `state: 'NONE'` and offers "Request API key". They
 * mint a second one and hold two live credentials acting as them, one of which they can
 * neither see nor revoke.
 *
 * ## The SEE predicate: "a key that acts as me"
 *
 * Every unrevoked `USER` key whose authority is the caller's, whoever minted it. Drives
 * `personal`'s row set and `requestPersonal`'s conflict count. Three conditions, and
 * `list` is not a substitute for any of them:
 *
 *   · `kind: 'USER'`    — `list` hands every PLATFORM key to any holder of
 *     `admin.apiKey.list`, so an admin with no personal key at all would otherwise get a
 *     non-empty box with Regenerate pointed at an organisational service account.
 *   · `userId`          — the key must act as the caller. Note: *act as*, not *minted by*.
 *   · `revokedAt: null` — a revoked key is gone.
 *
 * Expiry is deliberately NOT in the predicate — see `personal`.
 */
function personalKeysActingAs(userId: string): Prisma.ApiKeyWhereInput {
  return { kind: 'USER', userId, revokedAt: null };
}

/**
 * The MANAGE predicate: "a key of mine that is mine to destroy". A strict subset of
 * `personalKeysActingAs`, and what `regeneratePersonal` revokes.
 *
 * It mirrors `requireManageable` exactly, and the mirroring is a requirement rather than a
 * stylistic preference: `personal` reports the same condition per row as `revocable`, so
 * the affordances the box offers and the gate the server applies cannot drift. A Revoke
 * button that answers `NOT_FOUND` is the failure this closes.
 *
 * **Widening what is seen does not widen what is destroyed.** Fixing the hole above by
 * widening all three call sites would fix visibility and then break something worse: an
 * ordinary user's Regenerate would revoke a credential a different actor provisioned and
 * is accountable for, with that actor absent and unnotified. That inverts the documented
 * boundary instead of restoring it, and it collides with this path's own rule that a live
 * key is never rewritten out from under whoever depends on it.
 *
 * `mayRevokeAny` is passed in rather than read here because it is a fact about the
 * SESSION, not about the row — the same reason `list` computes `manageable` at its call
 * site. It is the one place a permission legitimately changes this path's behaviour:
 * whether you may revoke genuinely does depend on what you hold, because
 * `requireManageable` says so.
 */
function manageablePersonalKeys(userId: string, mayRevokeAny: boolean): Prisma.ApiKeyWhereInput {
  const actsAsMe = personalKeysActingAs(userId);
  return mayRevokeAny ? actsAsMe : { ...actsAsMe, createdById: userId };
}

/**
 * The same manage question asked of a row already in hand, for `personal`'s `revocable`.
 *
 * Kept next to `manageablePersonalKeys` deliberately: one is the SQL form and one the
 * in-memory form of a single rule, and they have to be changed together or the box starts
 * offering buttons the server refuses.
 */
function mayRevokePersonalKey(
  row: { createdById: string },
  userId: string,
  mayRevokeAny: boolean,
): boolean {
  return mayRevokeAny || row.createdById === userId;
}

/**
 * Advisory-lock namespace for the self-service key path. `'PKEY'` as ASCII keeps it
 * greppable, the same way `packages/audit/src/chain.ts` uses `'AUDT'`.
 *
 * The TWO-argument form of `pg_advisory_xact_lock` is used on purpose: Postgres keeps
 * two-argument advisory locks in a different space from one-argument ones, so this can
 * never collide with the audit chain's own lock however the hashes fall.
 */
const PERSONAL_KEY_LOCK_CLASS = 0x504b_4559; // 'PKEY'

/**
 * A stable 32-bit lock id for one user.
 *
 * Hashed rather than sliced out of the uuid: primary keys here are UUIDv7, whose leading
 * bits are a millisecond timestamp, so the first eight hex digits are IDENTICAL for every
 * user created within the same ~49 days. Slicing them would serialize unrelated people
 * against each other.
 */
function personalKeyLockId(userId: string): number {
  return createHash('sha256').update(userId).digest().readInt32BE(0);
}

/**
 * Serialize this user's self-service key path against itself, for the length of the
 * surrounding transaction.
 *
 * Same primitive and same reasoning as `acquireChainLock`: a `SELECT ... FOR UPDATE`
 * cannot do this job, because the race that matters is the one where there are no rows
 * yet — two double-clicked `requestPersonal` calls both counting zero and both minting.
 * The lock is per user, so one person's mint never waits on anybody else's.
 *
 * MUST be the first statement inside the `withAudit` callback: `withAudit` opens the
 * transaction and the lock is only held until that transaction ends, so anything read
 * before it is read unprotected.
 *
 * Lock ordering is consistent across the codebase and so cannot deadlock: this lock is
 * taken at the top of the callback and the audit chain lock at the bottom, inside
 * `writeAudit`, by every writer alike.
 */
async function lockPersonalKeys(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PERSONAL_KEY_LOCK_CLASS}::int4, ${personalKeyLockId(userId)}::int4)`;
}

/** Who the key is for, read fresh — the session's `name` is a cache and may be stale. */
async function personalKeyOwner(ctx: {
  db: typeof import('@/lib/db/prisma').db;
  rbac: { id: string };
}) {
  return ctx.db.user.findUniqueOrThrow({
    where: { id: ctx.rbac.id },
    select: { firstName: true, lastName: true, email: true },
  });
}

export const apiKeysRouter = router({
  /**
   * Keys visible to the caller.
   *
   * A non-admin sees only keys that act as them. An admin additionally sees every platform
   * key, because a service account acting as anybody is an organisational object rather
   * than a personal one.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.rbac.permissions.includes(P.admin.apiKey.list);
    const where: Prisma.ApiKeyWhereInput = isAdmin
      ? { revokedAt: null, OR: [{ userId: ctx.rbac.id }, { kind: 'PLATFORM' }] }
      : { revokedAt: null, userId: ctx.rbac.id };

    const rows = await ctx.db.apiKey.findMany({
      where,
      select: KEY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    // `manageable` is computed here rather than in the client so the rule lives in one
    // place — the mutations below enforce the same condition.
    return rows.map((row) => ({
      ...row,
      manageable:
        row.createdById === ctx.rbac.id || ctx.rbac.permissions.includes(P.admin.apiKey.revoke),
    }));
  }),

  /**
   * The API request log — the forensic surface for "what did this key do", and "was
   * something being probed".
   *
   * Server-side filtering on the fields that decide WHICH rows exist at all (outcome, key,
   * age), because those are the ones a security question starts from and the table grows
   * without bound. Free-text refinement over the returned window happens client-side; a
   * window is honest here as long as the count says how big the match actually was.
   */
  requests: withPermission(P.admin.apiKey.list)
    .input(
      z.object({
        apiKeyId: z.string().uuid().nullish(),
        outcome: z.string().max(40).nullish(),
        /** Only rows newer than this many days. Null = the whole retained window. */
        sinceDays: z.number().int().min(1).max(400).nullish(),
        limit: z.number().int().min(1).max(2000).default(500),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: Prisma.ApiKeyRequestWhereInput = {
        ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
        ...(input.sinceDays
          ? { createdAt: { gte: new Date(Date.now() - input.sinceDays * 86_400_000) } }
          : {}),
      };
      const [rows, totalCount] = await Promise.all([
        ctx.db.apiKeyRequest.findMany({
          where,
          select: {
            id: true,
            apiKeyId: true,
            prefixTried: true,
            actingUserId: true,
            operation: true,
            toolName: true,
            scopeRequired: true,
            outcome: true,
            statusCode: true,
            durationMs: true,
            count: true,
            windowStart: true,
            ip: true,
            userAgent: true,
            createdAt: true,
            apiKey: { select: { id: true, name: true, kind: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: input.limit,
        }),
        ctx.db.apiKeyRequest.count({ where }),
      ]);
      // `totalCount` vs `rows.length` is the difference between "there are 40,000 of these"
      // and "here are the 500 you can see" — a log view that hides that reads as complete.
      return { rows, totalCount };
    }),

  /** Distinct outcomes present in the log, for the filter options. */
  requestOutcomes: withPermission(P.admin.apiKey.list).query(async ({ ctx }) => {
    const rows = await ctx.db.apiKeyRequest.groupBy({ by: ['outcome'], _count: true });
    return rows
      .map((r) => ({ outcome: r.outcome, count: r._count }))
      .sort((a, b) => b.count - a.count);
  }),

  /** The scope vocabulary, for the provisioning form. */
  scopeOptions: protectedProcedure.query(() => ALL_SCOPES),

  // ───────────────────────────────────────────────────────────────────────────────────
  // The self-service personal key.
  //
  // `personal`, `requestPersonal` and `regeneratePersonal` are the whole path an ordinary
  // user has to a key, and between them they hold three invariants that `create`,
  // `update` and `rotate` do not:
  //
  //   1. **Every parameter is fixed by the app.** Neither mutation declares an `.input()`
  //      at all. That is the point rather than an omission: a zod schema with `.default()`
  //      values would still accept a client-supplied override, and "the app chooses" would
  //      be a client-side convention. There is no parameter to override.
  //   2. **Nothing is ever rewritten in place.** A key minted under an older, wider policy
  //      is reported as-is and flagged; the only transition offered is revoke-and-reissue,
  //      which is visible, audited, and hands the user a token they must go install.
  //   3. **THIS PATH launders no legacy key forward** — and mind the scope of that claim:
  //      it is true of these three procedures, not of the router. `regeneratePersonal`
  //      deliberately does NOT go through `rotate`, which copies the old row's `scopes`,
  //      `rateLimitPerMinute`, `allowedIps` and `expiresAt` onto the replacement. Every
  //      value it writes comes from the policy module instead, so pressing Regenerate on
  //      an over-scoped legacy key narrows it rather than reproducing it with a fresh
  //      secret — which is what would make the fixed policy impossible to ever narrow.
  //
  //      An earlier version of this comment claimed the invariant outright, as "nothing
  //      launders a legacy key forward". That was false as stated, and worth correcting
  //      rather than deleting, because reading it that way leaves a real path unwatched:
  //      `rotate` is `protectedProcedure` behind `requireManageable`, and a self-minted
  //      key's `createdById` is its own owner, so whoever holds a legacy wide,
  //      never-expiring key can call `apiKeys.rotate({ id })` themselves and get a fresh
  //      secret on the identical configuration, indefinitely. That door is **deliberately
  //      left open here**: closing it means changing `rotate`, which serves
  //      `/admin/api-keys` and every PLATFORM key too, and that was ruled out of this
  //      task's scope on purpose. The claim above is what the self-service path
  //      guarantees; the router as a whole does not guarantee it.
  //
  // ## Why `protectedProcedure` and not `withPermission` — do not "fix" this
  //
  // The repo convention is that a new tRPC procedure is gated with `withPermission(P.x.y)`.
  // These three are a deliberate, argued exception, and it does not generalise to anything
  // else in this router.
  //
  // A personal key on the fixed policy carries exactly the caller's own authority and
  // nothing else: `apiKeyGuard` re-resolves the owner's real RBAC on every request, and
  // the scopes only ever narrow that. Issuing one therefore grants the caller nothing they
  // did not already have when they logged in — there is no capability here to gate, and a
  // permission would only decide WHICH employees may automate work they can already do by
  // hand. That is a licensing decision, not a security one.
  //
  // Contrast `create` and `update`, which ARE gated, and note that the gate there is not
  // about authority either: it is about *configuration*. Those procedures take arbitrary
  // `scopes`, `expiresAt` and `allowedIps`, so an ungated one is a self-serve way to hold
  // a key wider and longer-lived than any policy intends. Take the inputs away and the
  // reason for the gate goes with them. Anything that reintroduces an input here must
  // reintroduce the gate.
  // ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The caller's own personal keys, with enough state that the UI never has to guess.
   *
   * ## Every live key is its own row, and that is a security requirement
   *
   * Not "the primary key plus a count of the others", and — the correction this phase
   * makes — not "the keys you minted" either. A key you cannot see is a key you cannot
   * revoke, so EVERY unrevoked key that acts as the caller appears here individually with
   * its own id, including one somebody else provisioned for them. The Phase 3 predicate
   * excluded exactly those, which made an admin-provisioned key invisible to the one
   * person it acts as; see `personalKeysActingAs` for how that happens in practice.
   *
   * This docblock already claimed the property. It now delivers it.
   *
   * ## Expiry is data, not a filter
   *
   * Every key this path mints now dies after 180 days, so "expired but not revoked" is the
   * routine end state of the feature rather than a legacy oddity — and a query that simply
   * filtered expired rows out would report a user whose integration broke this morning as
   * having no key at all, which is the one thing they must not be told. So expired rows are
   * returned, flagged `expired`, and `state` distinguishes the three cases the UI has to
   * tell apart:
   *
   *   · `'NONE'`        — nothing at all. The request button belongs here and only here.
   *   · `'LIVE'`        — at least one key still works.
   *   · `'ALL_EXPIRED'` — the caller HAS keys and none of them work any more.
   *
   * `'ALL_EXPIRED'` exists so that the empty state cannot be reached by accident: a UI
   * that only checks `keys.length` conflates it with `'LIVE'`, and one that only checks
   * `liveCount` conflates it with `'NONE'`. Whatever the eventual expired-state design
   * turns out to be, it cannot be arrived at by forgetting a branch.
   *
   * ## Per-row `inPolicy`
   *
   * `false` marks a key minted or edited outside the fixed policy — wider scopes, an
   * address allowlist, no end date. It is reported and never repaired: nothing here
   * rewrites a live key, because silently narrowing a credential somebody's automation
   * depends on is a breakage with no notification attached. Regenerate is the transition.
   *
   * Note `inPolicy` and `expired` are independent. A key can be perfectly in policy and
   * simply old; conflating the two would have the UI offer to fix a key with nothing wrong
   * with it but age.
   *
   * ## Per-row `revocable`, and `revocableCount`
   *
   * Seeing a key is not being able to destroy it — `docs/design/api-keys.md` §
   * "Visibility vs management". `revocable` is the manage answer for that row and this
   * session (`mayRevokePersonalKey`, mirroring `requireManageable`), so the box can
   * withhold a Revoke the server would refuse with `NOT_FOUND` instead of offering it and
   * failing at the click.
   *
   * `revocableCount` is how many rows `regeneratePersonal` would actually revoke, and it
   * is a distinct number from `keys.length` for the same reason: the confirmation copy has
   * to name what is about to stop working, and over the wide row set `keys.length` would
   * overstate it. It can legitimately be `0` while `keys` is non-empty — a caller whose
   * only key was provisioned for them — and Regenerate is still the right offer there,
   * because it mints them one of their own.
   */
  personal: protectedProcedure.query(async ({ ctx }) => {
    const mayRevokeAny = ctx.rbac.permissions.includes(P.admin.apiKey.revoke);
    const rows = await ctx.db.apiKey.findMany({
      where: personalKeysActingAs(ctx.rbac.id),
      select: PERSONAL_KEY_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    const now = Date.now();
    const keys = rows.map((row) => ({
      ...row,
      /** Past its end date but not revoked — still a row, no longer a credential. */
      expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
      /** Still shaped the way the fixed policy says. `false` means legacy, not broken. */
      inPolicy: matchesPersonalPolicy(row),
      /** Whether THIS caller may destroy it. Seeing it is a different question. */
      revocable: mayRevokePersonalKey(row, ctx.rbac.id, mayRevokeAny),
    }));

    const liveCount = keys.filter((k) => !k.expired).length;
    const state: 'NONE' | 'LIVE' | 'ALL_EXPIRED' =
      keys.length === 0 ? 'NONE' : liveCount > 0 ? 'LIVE' : 'ALL_EXPIRED';

    // `revocableCount`, NOT `keys.length`: the two differ the moment somebody else
    // provisioned a key that acts as the caller, and it is this number the confirmation
    // copy has to name before the user commits to Regenerate.
    return {
      keys,
      liveCount,
      expiredCount: keys.length - liveCount,
      revocableCount: keys.filter((k) => k.revocable).length,
      state,
    };
  }),

  /**
   * Issue the caller a personal key on the fixed policy. Returns the plaintext once.
   *
   * Takes no input, by design — see the block comment above.
   *
   * **Refuses if any unrevoked key already acts as the caller** — expired or not, in
   * policy or not, and *whoever minted it*. The count is the wide `personalKeysActingAs`,
   * not the narrower manage predicate, and that width is a fix rather than a tidy-up: a
   * subject holding only an admin-provisioned key used to count zero here, so `/profile`
   * offered them "Request API key" and they ended up holding two live credentials acting
   * as them, one of which they could neither see nor revoke. Counting wide closes that
   * from both ends — `personal` now reports `LIVE`, so the button is not offered, and this
   * `CONFLICT` refuses the call regardless of what the client shows.
   *
   * Two procedures with disjoint preconditions are far easier to reason about than one
   * that sometimes tops up: this one is for the genuinely empty state, and
   * `regeneratePersonal` is the total function that always works. Note the asymmetry with
   * it is deliberate — this counts WIDE, Regenerate revokes NARROW — which is what sends a
   * subject in that position to Regenerate, where they get a key of their own and the
   * provisioned one is left for whoever is accountable for it.
   *
   * The refusal is also the double-click guard, and it is only sound because the count
   * happens under the per-user advisory lock. Without it two concurrent requests both
   * count zero and both mint, and the user quietly holds two credentials while the UI
   * shows one.
   */
  requestPersonal: protectedProcedure.mutation(async ({ ctx }) => {
    const owner = await personalKeyOwner(ctx);
    const name = personalKeyName(owner);
    const expiresAt = personalKeyExpiresAt();
    const scopes = [...PERSONAL_KEY_POLICY.scopes];
    // Minted before the transaction so no CSPRNG work happens while the lock is held. A
    // token discarded by the CONFLICT below was never stored and never left the process.
    const minted = mintToken(PERSONAL_KEY_POLICY.kind);

    const created = await withAudit(
      ctx.db,
      {
        action: auditActions.apiKey.create,
        entityType: 'ApiKey',
        actor: {
          kind: 'user',
          id: ctx.rbac.id,
          name: ctx.session.user.name ?? ctx.session.user.email,
          roleLabel: ctx.rbac.roleLabel,
        },
        details: {
          kind: PERSONAL_KEY_POLICY.kind,
          name,
          // Distinguishes a self-service mint from an admin's `create` in forensics —
          // both write `apiKey.create`, and only one of them chose its own configuration.
          via: 'requestPersonal',
          scopes,
          rateLimitPerMinute: PERSONAL_KEY_POLICY.rateLimitPerMinute,
          allowedIpCount: 0,
          expiresAt: expiresAt.toISOString(),
        },
      },
      async (tx) => {
        await lockPersonalKeys(tx, ctx.rbac.id);
        const held = await tx.apiKey.count({ where: personalKeysActingAs(ctx.rbac.id) });
        if (held > 0) {
          // **The `code` is the contract, not the message.** The client localizes off
          // `error.data.code` and does not render this string; a direct API consumer keys
          // off the same code. So this message is developer-facing on purpose — a
          // user-facing English sentence here reached an FR-CA reader untranslated,
          // immediately after translated copy. Do not add an i18n dependency to the
          // router to fix that: the catalogs belong with the components that render them.
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'requestPersonal: an unrevoked USER key already acts as this caller.',
          });
        }
        return tx.apiKey.create({
          data: {
            kind: PERSONAL_KEY_POLICY.kind,
            name,
            prefix: minted.prefix,
            tokenHash: minted.tokenHash,
            userId: ctx.rbac.id,
            createdById: ctx.rbac.id,
            scopes,
            rateLimitPerMinute: PERSONAL_KEY_POLICY.rateLimitPerMinute,
            allowedIps: [...PERSONAL_KEY_POLICY.allowedIps],
            expiresAt,
          },
          select: KEY_SELECT,
        });
      },
      (row) => row.id,
    );

    return { key: created, token: minted.token };
  }),

  /**
   * Replace the caller's personal keys with one fresh key on the current fixed policy.
   *
   * Takes no input, by design — see the block comment above.
   *
   * ## It does not call `rotate`, and must never be changed to
   *
   * `rotate` copies the existing row's `scopes`, `rateLimitPerMinute`, `allowedIps` and
   * `expiresAt` onto the replacement. Regenerating a key minted under the old form would
   * therefore reproduce that key exactly — same over-broad scopes, same allowlist, same
   * lifetime — with a fresh secret, forever, and the fixed policy could never be narrowed
   * for anybody who ever pressed the button. Every value below comes from the policy
   * module instead; nothing at all is read off the old rows except the record of what they
   * were, which goes in the audit row.
   *
   * `rotate` is also wrong on ownership for the reverse case: it gates on
   * `requireManageable`, so a key an admin minted for a user would give that user
   * `NOT_FOUND` on their own Regenerate. This procedure is not gated per key, so it
   * always succeeds — it simply narrows WHICH keys it touches, below.
   *
   * ## It is destructive over what the caller may MANAGE — not over what they can see
   *
   * The revoked set is `manageablePersonalKeys`: every unrevoked key that acts as the
   * caller AND is theirs to manage, meaning one they minted, or any of them if they hold
   * `admin.apiKey.revoke`. Expired ones included, since leaving an expired row unrevoked
   * would have `personal` report it for ever.
   *
   * Narrower than `personal`'s row set, and deliberately so. **It therefore no longer
   * converges the caller's set to exactly one.** A key an admin provisioned for them stays
   * live and stays listed: it is theirs to hold, not theirs to replace, and revoking it
   * here would break a credential on behalf of an actor who is absent, unnotified, and
   * accountable for it. That is the boundary `requireManageable` already draws for `revoke`
   * and `rotate` — `docs/design/api-keys.md` § "Visibility vs management" — and matching it
   * is what keeps this button honest about its own reach.
   *
   * A consequence to keep rather than guard against: `revokedCount` can be `0` and the
   * mint still happens. A caller whose only key was provisioned for them gets an on-policy
   * key of their own and the provisioned one is untouched. Correct, and not a case to throw
   * on — they had nothing of their own to replace, which is the empty state as far as this
   * procedure is concerned.
   *
   * `revokedCount` comes back because the confirmation the user sees before pressing this
   * has to name the number of credentials about to stop working, and that number is the
   * manageable ones. `personal.revocableCount` is the same count over the same session, so
   * the copy and the effect cannot disagree.
   *
   * The revocations and the mint are one transaction, so there is no instant at which the
   * caller has no key of their own, and no failure mode that leaves two live self-minted
   * ones.
   */
  regeneratePersonal: protectedProcedure.mutation(async ({ ctx }) => {
    const owner = await personalKeyOwner(ctx);
    const name = personalKeyName(owner);
    const expiresAt = personalKeyExpiresAt();
    const scopes = [...PERSONAL_KEY_POLICY.scopes];
    const minted = mintToken(PERSONAL_KEY_POLICY.kind);

    /**
     * Filled in below, from inside the transaction.
     *
     * `withAudit` spreads this input when it appends the row, which happens AFTER the
     * callback has returned, so fields set during the callback are in the row and covered
     * by its hash. That is deliberate and it is the only way to audit facts — which keys
     * were superseded, and what they could do — that are not knowable until the callback
     * has read them under the lock. Reading them beforehand instead would make the audit
     * row lie in exactly the double-click case it exists to explain.
     *
     * `details` is a single field of the 9-field hash payload, so adding keys inside it
     * changes nothing about the payload itself.
     */
    const details: Record<string, unknown> = {
      kind: PERSONAL_KEY_POLICY.kind,
      name,
      via: 'regeneratePersonal',
      scopesAfter: scopes,
      rateLimitPerMinute: PERSONAL_KEY_POLICY.rateLimitPerMinute,
      allowedIpCount: 0,
      expiresAt: expiresAt.toISOString(),
    };

    const out = await withAudit(
      ctx.db,
      {
        action: auditActions.apiKey.rotate,
        entityType: 'ApiKey',
        actor: {
          kind: 'user',
          id: ctx.rbac.id,
          name: ctx.session.user.name ?? ctx.session.user.email,
          roleLabel: ctx.rbac.roleLabel,
        },
        details,
      },
      async (tx) => {
        await lockPersonalKeys(tx, ctx.rbac.id);

        const superseded = await tx.apiKey.findMany({
          where: manageablePersonalKeys(
            ctx.rbac.id,
            ctx.rbac.permissions.includes(P.admin.apiKey.revoke),
          ),
          select: { id: true, scopes: true },
        });
        const revokedKeyIds = superseded.map((k) => k.id);

        // What the caller could do before, as a set, sorted so the row is comparable.
        // This is the forensic half of the anti-laundering rule: the audit says what
        // authority was withdrawn, not merely that something was replaced.
        //
        // Read off the SUPERSEDED rows only, never off everything `personal` would show.
        // A key that is still live had no authority withdrawn from it, and an audit row
        // claiming otherwise would misdirect whoever reads it after an incident.
        details.scopesBefore = [...new Set(superseded.flatMap((k) => k.scopes))].sort();
        details.revokedKeyIds = revokedKeyIds;
        details.revokedCount = revokedKeyIds.length;

        if (revokedKeyIds.length > 0) {
          // Soft-revoked, never deleted: audit rows reference these ids and the request
          // log is the forensic surface for what each key did.
          await tx.apiKey.updateMany({
            where: { id: { in: revokedKeyIds } },
            data: { revokedAt: new Date() },
          });
        }

        const replacement = await tx.apiKey.create({
          data: {
            kind: PERSONAL_KEY_POLICY.kind,
            name,
            prefix: minted.prefix,
            tokenHash: minted.tokenHash,
            userId: ctx.rbac.id,
            createdById: ctx.rbac.id,
            scopes,
            rateLimitPerMinute: PERSONAL_KEY_POLICY.rateLimitPerMinute,
            allowedIps: [...PERSONAL_KEY_POLICY.allowedIps],
            expiresAt,
          },
          select: KEY_SELECT,
        });
        return { replacement, revokedKeyIds };
      },
      (row) => row.replacement.id,
    );

    return {
      key: out.replacement,
      token: minted.token,
      revokedKeyIds: out.revokedKeyIds,
      revokedCount: out.revokedKeyIds.length,
    };
  }),

  /**
   * Mint a key. Returns the plaintext token exactly once.
   *
   * `userId` is not an input. A USER key always belongs to the caller and a PLATFORM key
   * always has none, so there is no shape of this request that mints somebody else a
   * personal token.
   *
   * Gated on `admin.apiKey.create` for BOTH kinds — see the module docblock. The gate is the
   * procedure's, not a branch in the body, so there is no kind that can slip past it.
   */
  create: withPermission(P.admin.apiKey.create)
    .input(
      z.object({
        kind: z.enum(['USER', 'PLATFORM']),
        name: z.string().trim().min(1).max(120),
        /** Empty is legal and means the key can do nothing — see @expenseos/api-scopes. */
        scopes: scopeList.default([]),
        rateLimitPerMinute: z.number().int().min(1).max(100_000).nullish(),
        allowedIps: z.array(z.string().trim().min(1)).max(64).default([]),
        expiresAt: z.date().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertScopes(input.scopes);
      assertAllowedIps(input.allowedIps);

      const minted = mintToken(input.kind);
      const created = await withAudit(
        ctx.db,
        {
          action: auditActions.apiKey.create,
          entityType: 'ApiKey',
          actor: {
            kind: 'user',
            id: ctx.rbac.id,
            name: ctx.session.user.name ?? ctx.session.user.email,
            roleLabel: ctx.rbac.roleLabel,
          },
          details: {
            kind: input.kind,
            name: input.name,
            scopes: input.scopes,
            rateLimitPerMinute: input.rateLimitPerMinute ?? null,
            allowedIpCount: input.allowedIps.length,
            expiresAt: input.expiresAt?.toISOString() ?? null,
          },
        },
        async (tx) =>
          tx.apiKey.create({
            data: {
              kind: input.kind,
              name: input.name,
              prefix: minted.prefix,
              tokenHash: minted.tokenHash,
              // A platform key has no single subject; it names one per request.
              userId: input.kind === 'USER' ? ctx.rbac.id : null,
              createdById: ctx.rbac.id,
              scopes: input.scopes,
              rateLimitPerMinute: input.rateLimitPerMinute ?? null,
              allowedIps: input.allowedIps,
              expiresAt: input.expiresAt ?? null,
            },
            select: KEY_SELECT,
          }),
        (row) => row.id,
      );

      return { key: created, token: minted.token };
    }),

  /**
   * Change what a key may do. Managing is a narrower right than seeing.
   *
   * Gated on `admin.apiKey.create` for the same reason `create` is: `scopes` is an input, so
   * an ungated `update` is a rescope-your-own-key-to-anything path, and `requireManageable`
   * admits the owner of a self-minted key by design. Both checks still run — the permission
   * says you may configure keys at all, `requireManageable` says whether this one is yours
   * to configure. The permission is checked first, so a caller without it gets `FORBIDDEN`
   * for every id alike and learns nothing about which ids exist.
   */
  update: withPermission(P.admin.apiKey.create)
    .input(
      z.object({
        id: z.string().uuid(),
        scopes: scopeList.optional(),
        rateLimitPerMinute: z.number().int().min(1).max(100_000).nullish(),
        allowedIps: z.array(z.string().trim().min(1)).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const key = await requireManageable(ctx, input.id);
      if (input.scopes) assertScopes(input.scopes);
      if (input.allowedIps) assertAllowedIps(input.allowedIps);

      return withAudit(
        ctx.db,
        {
          action: auditActions.apiKey.update,
          entityType: 'ApiKey',
          entityId: key.id,
          actor: {
            kind: 'user',
            id: ctx.rbac.id,
            name: ctx.session.user.name ?? ctx.session.user.email,
            roleLabel: ctx.rbac.roleLabel,
          },
          details: {
            kind: key.kind,
            name: key.name,
            scopesBefore: key.scopes,
            scopesAfter: input.scopes ?? key.scopes,
            rateLimitPerMinute: input.rateLimitPerMinute ?? key.rateLimitPerMinute,
          },
        },
        async (tx) =>
          tx.apiKey.update({
            where: { id: key.id },
            data: {
              ...(input.scopes ? { scopes: input.scopes } : {}),
              ...(input.allowedIps ? { allowedIps: input.allowedIps } : {}),
              ...(input.rateLimitPerMinute === undefined
                ? {}
                : { rateLimitPerMinute: input.rateLimitPerMinute }),
            },
            select: KEY_SELECT,
          }),
      );
    }),

  /**
   * Rotate a key: mint a replacement carrying the same configuration, revoke the original,
   * and return the new token once.
   *
   * One operation rather than two, deliberately. "Create a new key, reconfigure the client,
   * then remember to revoke the old one" ends with the old one still live — the last step is
   * exactly the step nobody does. Both halves happen in one transaction so a rotation
   * cannot leave two live keys behind.
   */
  rotate: protectedProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(120).optional() }))
    .mutation(async ({ ctx, input }) => {
      const key = await requireManageable(ctx, input.id);
      if (key.revokedAt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That key is already revoked.' });
      }
      const existing = await ctx.db.apiKey.findUniqueOrThrow({
        where: { id: key.id },
        select: {
          kind: true,
          name: true,
          userId: true,
          scopes: true,
          rateLimitPerMinute: true,
          allowedIps: true,
          expiresAt: true,
        },
      });
      // VeloExpense (w6-04): `kind` is text under a CHECK (0079).
      const minted = mintToken(existing.kind as ApiKeyKind);

      const created = await withAudit(
        ctx.db,
        {
          action: auditActions.apiKey.rotate,
          entityType: 'ApiKey',
          actor: {
            kind: 'user',
            id: ctx.rbac.id,
            name: ctx.session.user.name ?? ctx.session.user.email,
            roleLabel: ctx.rbac.roleLabel,
          },
          details: { kind: existing.kind, name: existing.name, replacedKeyId: key.id },
        },
        async (tx) => {
          const replacement = await tx.apiKey.create({
            data: {
              kind: existing.kind,
              name: input.name ?? existing.name,
              prefix: minted.prefix,
              tokenHash: minted.tokenHash,
              userId: existing.userId,
              createdById: ctx.rbac.id,
              scopes: existing.scopes,
              rateLimitPerMinute: existing.rateLimitPerMinute,
              allowedIps: existing.allowedIps,
              expiresAt: existing.expiresAt,
            },
            select: KEY_SELECT,
          });
          await tx.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
          return replacement;
        },
        (row) => row.id,
      );

      return { key: created, token: minted.token, revokedKeyId: key.id };
    }),

  /**
   * Revoke a key.
   *
   * A soft flag rather than a delete: audit rows reference the key's id and name, and
   * deleting the row would make historical entries unreadable.
   */
  revoke: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const key = await requireManageable(ctx, input.id);
      if (key.revokedAt) return { id: key.id, revokedAt: key.revokedAt };

      return withAudit(
        ctx.db,
        {
          action: auditActions.apiKey.revoke,
          entityType: 'ApiKey',
          entityId: key.id,
          actor: {
            kind: 'user',
            id: ctx.rbac.id,
            name: ctx.session.user.name ?? ctx.session.user.email,
            roleLabel: ctx.rbac.roleLabel,
          },
          details: { kind: key.kind, name: key.name, selfMinted: key.createdById === ctx.rbac.id },
        },
        async (tx) =>
          tx.apiKey.update({
            where: { id: key.id },
            data: { revokedAt: new Date() },
            select: { id: true, revokedAt: true },
          }),
      );
    }),
});

/**
 * Load a key the caller is allowed to MANAGE, or refuse.
 *
 * Deliberately does not distinguish "no such key" from "not yours to manage": both are
 * `NOT_FOUND`, so the endpoint cannot be used to discover which key ids exist.
 */
async function requireManageable(
  ctx: {
    db: typeof import('@/lib/db/prisma').db;
    rbac: { id: string; permissions: readonly string[] };
  },
  id: string,
) {
  const key = await ctx.db.apiKey.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      name: true,
      scopes: true,
      rateLimitPerMinute: true,
      createdById: true,
      revokedAt: true,
    },
  });
  if (!key) throw new TRPCError({ code: 'NOT_FOUND' });
  const mayManage =
    key.createdById === ctx.rbac.id || ctx.rbac.permissions.includes(P.admin.apiKey.revoke);
  if (!mayManage) throw new TRPCError({ code: 'NOT_FOUND' });
  return key;
}
