/**
 * API keys — minting, verifying, and working out whose authority a request carries.
 *
 * Two kinds, and the difference is the whole security story:
 *
 *   · **USER** — a personal access token. `userId` is its owner; it carries exactly that
 *     person's authority and never more, because the guard re-resolves the owner's real
 *     RBAC on every request.
 *   · **PLATFORM** — a service account. `userId` is NULL: it has no single subject, and
 *     names one per request instead. Holding one is holding the ability to act as other
 *     people.
 *
 * There are two ways a key comes into existence, and the difference is *who chose its
 * configuration*, not whose authority it carries:
 *
 *   · `apiKeys.requestPersonal` — self-service, and the only path an ordinary user has.
 *     It takes no input at all: kind, name, scopes, rate limit, lifetime and address
 *     allowlist are all fixed by `server/lib/personalApiKey.ts`.
 *   · `apiKeys.create` / `apiKeys.update` — arbitrary configuration, and therefore
 *     `admin.apiKey.create` for BOTH kinds. Not because minting a personal key escalates
 *     anything (it cannot), but because a self-serve mint that names its own `scopes`,
 *     `expiresAt` and `allowedIps` is a self-serve way to hold a key wider and
 *     longer-lived than any policy intends.
 *
 * Three properties hold, and each is enforced here rather than assumed:
 *
 *   1. **A key never out-ranks the person it acts as.** Permissions come from the acting
 *      user in the normal way; the key contributes none of its own. Scopes only narrow.
 *   2. **Scopes are deny-by-default.** An empty scope list authorizes nothing. There is no
 *      separate write flag — holding `x.y.z` grants write, `x.y.z.readonly` grants read,
 *      so the two can never disagree.
 *   3. **The audit says who really did it.** See `delegationAuditDetails`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKey, ApiKeyKind, PrismaClient } from '@expenseos/db';

/*
 * Ported from ExpenseOS `apps/web/src/server/lib/apiKeys.ts` (1e682dd6), w6-04 (d88).
 * VeloExpense adaptations are marked "VeloExpense (w6-04):".
 *
 * VeloExpense (w6-04): everything here runs INSIDE the key's tenant. A request has no session
 * to name one, so `/api/mcp` first asks `apiKeyTenantId` (lib/tenant/context.ts, 0079's
 * hatch) which tenant holds a key with the presented token's hash, and only then calls the
 * guard and this file, under `tenant_isolation`. A key in another tenant is therefore a row
 * that is not there: `resolveApiKey` cannot find it, by construction.
 */

/** `vxe_u_` for a user key, `vxe_p_` for a platform key.
 *  VeloExpense (w6-04): ExpenseOS's tokens read `eos_`; VeloExpense's read `vxe_`. */
const KIND_TAG: Record<ApiKeyKind, string> = { USER: 'u', PLATFORM: 'p' };

const PREFIX_BYTES = 8; // 16 hex chars — the public, indexed half
const SECRET_BYTES = 32; // 256 bits from a CSPRNG

/**
 * SHA-256, deliberately, and not a password hash.
 *
 * Slow hashing exists to defeat dictionary attacks on low-entropy human secrets. This
 * secret is 256 random bits: there is no dictionary, so there is nothing for a slow hash
 * to frustrate — while an argon2 verification on every API request would be a
 * self-inflicted rate limit on the hot path.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface MintedKey {
  /** Shown to the human exactly once. Never stored. */
  readonly token: string;
  readonly prefix: string;
  readonly tokenHash: string;
}

/** Mint a new token. The plaintext exists only in the return value. */
export function mintToken(kind: ApiKeyKind): MintedKey {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `vxe_${KIND_TAG[kind]}_${prefix}_${secret}`;
  return { token, prefix, tokenHash: hashToken(token) };
}

/**
 * Pull the lookup prefix out of a presented token.
 *
 * Returns null rather than throwing on anything malformed: a bad token is an ordinary
 * 401, not an exception, and neither the caller nor the response should distinguish
 * "wrong shape" from "wrong secret".
 */
export function parseToken(token: string): { kind: ApiKeyKind; prefix: string } | null {
  const m = /^vxe_([up])_([0-9a-f]{16})_[A-Za-z0-9_-]{20,}$/.exec(token);
  if (!m) return null;
  return { kind: m[1] === 'u' ? 'USER' : 'PLATFORM', prefix: m[2] };
}

/** VeloExpense (w6-04): a uuid, for the platform key's per-request subject. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the bearer token out of an Authorization header. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** Constant-time compare of two hex digests of equal length. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Every way resolution can refuse. Mirrors `ApiKeyRequest.outcome`. */
export type ApiKeyFailure =
  | 'INVALID_KEY'
  | 'REVOKED'
  | 'EXPIRED'
  | 'SUBJECT_REQUIRED'
  | 'SUBJECT_NOT_ALLOWED'
  | 'SUBJECT_UNKNOWN';

export interface ResolvedApiKey {
  readonly key: ApiKey;
  /** The user whose authority this request carries. */
  readonly actingUserId: string;
  /** True when a platform key is acting as somebody. */
  readonly delegated: boolean;
}

export type ResolveResult =
  | { readonly ok: true; readonly resolved: ResolvedApiKey }
  | { readonly ok: false; readonly failure: ApiKeyFailure; readonly prefixTried: string | null };

/**
 * Verify a presented token and work out who it is acting as.
 *
 * `onBehalfOf` is the subject a platform key names for THIS request. It is per-request
 * rather than baked into the key on purpose: one integration serving many people should
 * produce audit rows naming each of them, not one row naming a robot.
 */
export async function resolveApiKey(
  db: PrismaClient,
  token: string,
  onBehalfOf?: string | null,
): Promise<ResolveResult> {
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, failure: 'INVALID_KEY', prefixTried: null };

  // VeloExpense (w6-04): `kind` is text under a CHECK (0079), so the row is narrowed here.
  const key = (await db.apiKey.findUnique({ where: { prefix: parsed.prefix } })) as ApiKey | null;
  // The prefix is public and carries no secret, so a miss here leaks nothing the caller
  // did not already supply.
  if (!key) return { ok: false, failure: 'INVALID_KEY', prefixTried: parsed.prefix };
  if (!hashesMatch(key.tokenHash, hashToken(token))) {
    return { ok: false, failure: 'INVALID_KEY', prefixTried: parsed.prefix };
  }
  if (key.revokedAt) return { ok: false, failure: 'REVOKED', prefixTried: key.prefix };
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
    return { ok: false, failure: 'EXPIRED', prefixTried: key.prefix };
  }

  if (key.kind === 'USER') {
    if (!key.userId) {
      // A user key with no owner cannot act as anybody. Treated as invalid rather than
      // defaulted, because there is no correct default.
      return { ok: false, failure: 'INVALID_KEY', prefixTried: key.prefix };
    }
    // A user key naming somebody else is not a mistake to accommodate — it is a personal
    // token being used as an impersonation capability.
    if (onBehalfOf && onBehalfOf !== key.userId) {
      return { ok: false, failure: 'SUBJECT_NOT_ALLOWED', prefixTried: key.prefix };
    }
    return { ok: true, resolved: { key, actingUserId: key.userId, delegated: false } };
  }

  if (!onBehalfOf) return { ok: false, failure: 'SUBJECT_REQUIRED', prefixTried: key.prefix };
  // VeloExpense (w6-04): the header is free text; a malformed id is an unknown subject, not
  // a database error (`app_user.id` is a uuid column).
  if (!UUID.test(onBehalfOf)) return { ok: false, failure: 'SUBJECT_UNKNOWN', prefixTried: key.prefix };
  const subject = await db.user.findFirst({
    // VeloExpense (w6-04): and `hasAccess` (People 1, 0072): a person whose access is off is
    // not somebody a platform key may act as, as the sign-in and every request refuse them.
    where: { id: onBehalfOf, deletedAt: null, hasAccess: true },
    select: { id: true },
  });
  if (!subject) return { ok: false, failure: 'SUBJECT_UNKNOWN', prefixTried: key.prefix };
  return { ok: true, resolved: { key, actingUserId: subject.id, delegated: true } };
}

/**
 * The delegation record that rides along on every audited action.
 *
 * `actorId` / `actorName` stay the acting person — their authority is what was used, and
 * an audit row claiming a robot approved something would be false. What must not be lost
 * is that a key drafted it, so that goes in `details`, which **is** part of the audit hash
 * payload: the marker cannot be stripped from a row without breaking the chain, and it
 * needed no change to the frozen 9-field payload to get there.
 */
export function delegationAuditDetails(resolved: ResolvedApiKey): Record<string, unknown> {
  return {
    viaApiKey: {
      id: resolved.key.id,
      name: resolved.key.name,
      kind: resolved.key.kind,
      ...(resolved.delegated ? { onBehalfOf: resolved.actingUserId } : {}),
    },
  };
}

/** Record that a key was used. Best-effort: a failed touch must not fail the request. */
export async function touchLastUsed(db: PrismaClient, keyId: string): Promise<void> {
  await db.apiKey
    .update({ where: { id: keyId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}
