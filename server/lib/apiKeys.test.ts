import { describe, expect, it, vi } from 'vitest';
import {
  bearerToken,
  delegationAuditDetails,
  hashToken,
  mintToken,
  parseToken,
  resolveApiKey,
  touchLastUsed,
} from './apiKeys';

/**
 * API keys: minting, verifying, and working out whose authority a request carries.
 *
 * The two kinds are the whole security story. A **USER** key is a personal access token —
 * it carries exactly its owner's authority, so anyone may mint one for themselves because
 * doing so grants nothing they did not already have. A **PLATFORM** key is a service
 * account with no subject of its own; it names one per request, which is why minting one
 * is handing out the ability to act as other people.
 *
 * Three properties, each enforced rather than assumed, and each with a test below:
 *
 *   1. **A key never out-ranks the person it acts as.** A user key naming somebody else is
 *      refused outright — that is not a mistake to accommodate, it is a personal token
 *      being used as an impersonation capability.
 *   2. **A platform key MUST name a subject.** Defaulting to anybody would make one
 *      integration's audit trail read as a robot doing everything.
 *   3. **The audit says who really did it.** The acting person stays the actor, and the
 *      key rides in `details` — which is inside the hash payload, so the marker cannot be
 *      stripped from a row without breaking the chain.
 */

const APPROVED_HASH = hashToken;

function key(over: Record<string, unknown> = {}) {
  return {
    id: 'k-1',
    name: 'CI bot',
    kind: 'USER',
    prefix: 'a'.repeat(16),
    tokenHash: 'unset',
    userId: 'u-1',
    revokedAt: null,
    expiresAt: null,
    ...over,
  };
}

function makeDb(row: unknown, subject: unknown = { id: 'u-2' }) {
  return {
    // Args typed on every stub, or `mock.calls` infers as `[]` and reading calls[0] is a
    // type error rather than a test.
    apiKey: {
      findUnique: vi.fn(async (_args: unknown) => row),
      update: vi.fn(async (_args: unknown) => ({})),
    },
    user: { findFirst: vi.fn(async (_args: unknown) => subject) },
  };
}

describe('minting', () => {
  it('tags the token with its kind, so a key’s nature is visible in a paste', () => {
    /** Somebody pasting `vxe_p_…` into a config file can see it is a service account
     *  without looking it up. */
    expect(mintToken('USER').token).toMatch(/^vxe_u_[0-9a-f]{16}_/);
    expect(mintToken('PLATFORM').token).toMatch(/^vxe_p_[0-9a-f]{16}_/);
  });

  it('returns the plaintext once and the hash to store', () => {
    const minted = mintToken('USER');
    expect(minted.tokenHash).toBe(APPROVED_HASH(minted.token));
    expect(minted.token).toContain(minted.prefix);
  });

  it('never repeats a token', () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintToken('USER').token));
    expect(seen.size).toBe(50);
  });

  it('carries at least 256 bits of secret past the public prefix', () => {
    /**
     * The reason SHA-256 is the right hash here: there is no dictionary against a CSPRNG
     * secret, so a slow hash would only rate-limit our own hot path.
     *
     * Read with a regex rather than `split('_')[3]`, because the secret is base64url and
     * base64url contains `_` — that split returns whatever precedes the first underscore
     * INSIDE the secret, so it passes or fails depending on the random bytes. (It is also
     * why `parseToken`'s pattern admits `_` in the final segment.)
     */
    const secret = /^vxe_[up]_[0-9a-f]{16}_(.+)$/.exec(mintToken('USER').token)?.[1] ?? '';
    expect(secret.length).toBeGreaterThanOrEqual(40);
  });

  it('mints a token whose secret contains base64url punctuation and still parses', () => {
    // 200 draws is enough that a `-` or `_` in the secret is a near-certainty; a parser
    // that rejected them would refuse a small fraction of perfectly good keys.
    const tokens = Array.from({ length: 200 }, () => mintToken('USER').token);
    expect(tokens.some((t) => /[-_]/.test(t.slice(24)))).toBe(true);
    for (const token of tokens) expect(parseToken(token)).not.toBeNull();
  });
});

describe('parsing a presented token', () => {
  it('reads the kind and the lookup prefix', () => {
    const minted = mintToken('PLATFORM');
    expect(parseToken(minted.token)).toEqual({ kind: 'PLATFORM', prefix: minted.prefix });
  });

  it('returns null for anything malformed rather than throwing', () => {
    /** A bad token is an ordinary 401, not an exception — and neither the caller nor the
     *  response should be able to tell "wrong shape" from "wrong secret". */
    for (const bad of [
      '',
      'Bearer',
      'vxe_x_aaaaaaaaaaaaaaaa_secretsecretsecret1234',
      'vxe_u_short_secretsecretsecretsecret',
      'vxe_u_ZZZZZZZZZZZZZZZZ_secretsecretsecret1234',
      'vxe_u_aaaaaaaaaaaaaaaa_tooshort',
      `${mintToken('USER').token} extra`,
    ]) {
      expect(parseToken(bad)).toBeNull();
    }
  });
});

describe('the Authorization header', () => {
  it('takes the token after Bearer, case-insensitively', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer abc123')).toBe('abc123');
  });

  it('tolerates surrounding whitespace', () => {
    expect(bearerToken('  Bearer abc123  ')).toBe('abc123');
  });

  it('refuses a header that is not a bearer credential', () => {
    for (const bad of [null, undefined, '', 'Basic abc', 'Bearer', 'Bearer a b']) {
      expect(bearerToken(bad)).toBeNull();
    }
  });
});

describe('resolving a user key', () => {
  it('acts as its owner', async () => {
    const minted = mintToken('USER');
    const db = makeDb(key({ prefix: minted.prefix, tokenHash: minted.tokenHash }));
    const out = await resolveApiKey(db as never, minted.token);
    expect(out).toMatchObject({ ok: true });
    expect(out.ok && out.resolved).toMatchObject({ actingUserId: 'u-1', delegated: false });
  });

  it('accepts a subject that names its own owner', async () => {
    // Harmless and useful: a client that always sends the header does not need a special
    // case for personal tokens.
    const minted = mintToken('USER');
    const db = makeDb(key({ prefix: minted.prefix, tokenHash: minted.tokenHash }));
    const out = await resolveApiKey(db as never, minted.token, 'u-1');
    expect(out.ok).toBe(true);
  });

  it('refuses a user key naming somebody else', async () => {
    /**
     * Not a mistake to accommodate. A personal token that can name a subject IS an
     * impersonation capability, and anybody may mint one for themselves.
     */
    const minted = mintToken('USER');
    const db = makeDb(key({ prefix: minted.prefix, tokenHash: minted.tokenHash }));
    expect(await resolveApiKey(db as never, minted.token, 'someone-else')).toMatchObject({
      ok: false,
      failure: 'SUBJECT_NOT_ALLOWED',
    });
  });

  it('refuses a user key with no owner rather than defaulting one', async () => {
    /** There is no correct default. An ownerless user key cannot act as anybody. */
    const minted = mintToken('USER');
    const db = makeDb(key({ prefix: minted.prefix, tokenHash: minted.tokenHash, userId: null }));
    expect(await resolveApiKey(db as never, minted.token)).toMatchObject({
      ok: false,
      failure: 'INVALID_KEY',
    });
  });
});

describe('resolving a platform key', () => {
  const platform = (over: Record<string, unknown> = {}) =>
    key({ kind: 'PLATFORM', userId: null, ...over });

  it('acts as the subject it names, marked as delegated', async () => {
    /** Per-request rather than baked into the key: one integration serving many people
     *  should produce audit rows naming each of them, not one row naming a robot. */
    const minted = mintToken('PLATFORM');
    // VeloExpense (w6-04): the subject is a uuid (`app_user.id`); anything else is refused
    // as unknown before the database is asked (see the next-but-two case).
    const subject = '019e3000-0000-7000-8000-0000000000a2';
    const db = makeDb(platform({ prefix: minted.prefix, tokenHash: minted.tokenHash }), {
      id: subject,
    });
    const out = await resolveApiKey(db as never, minted.token, subject);
    expect(out.ok && out.resolved).toMatchObject({ actingUserId: subject, delegated: true });
  });

  it('refuses to act with no subject named', async () => {
    const minted = mintToken('PLATFORM');
    const db = makeDb(platform({ prefix: minted.prefix, tokenHash: minted.tokenHash }));
    expect(await resolveApiKey(db as never, minted.token)).toMatchObject({
      ok: false,
      failure: 'SUBJECT_REQUIRED',
    });
  });

  it('refuses a subject that does not exist', async () => {
    const minted = mintToken('PLATFORM');
    const db = makeDb(platform({ prefix: minted.prefix, tokenHash: minted.tokenHash }), null);
    expect(await resolveApiKey(db as never, minted.token, 'ghost')).toMatchObject({
      ok: false,
      failure: 'SUBJECT_UNKNOWN',
    });
  });

  it('refuses a subject who has left', async () => {
    /** A departed employee's row survives because audit pins it. Acting as them would let
     *  an integration keep submitting expenses for somebody who left in March. */
    const minted = mintToken('PLATFORM');
    const db = makeDb(platform({ prefix: minted.prefix, tokenHash: minted.tokenHash }), null);
    const departed = '019e3000-0000-7000-8000-0000000000d1';
    await resolveApiKey(db as never, minted.token, departed);
    // VeloExpense (w6-04): and `hasAccess` — access turned off on the People screen (0072).
    expect((db.user.findFirst.mock.calls[0]?.[0] as { where: unknown } | undefined)?.where).toEqual(
      {
        id: departed,
        deletedAt: null,
        hasAccess: true,
      },
    );
  });

  it('refuses a subject that is not an id, without asking the database', async () => {
    // VeloExpense (w6-04): the header is free text and `app_user.id` a uuid column; a
    // malformed value would otherwise be a database error and a 500.
    const minted = mintToken('PLATFORM');
    const db = makeDb(platform({ prefix: minted.prefix, tokenHash: minted.tokenHash }));
    expect(await resolveApiKey(db as never, minted.token, 'sam@e.inc')).toMatchObject({
      ok: false,
      failure: 'SUBJECT_UNKNOWN',
    });
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('reports a malformed token with no prefix to log', async () => {
    const db = makeDb(null);
    expect(await resolveApiKey(db as never, 'not-a-token')).toEqual({
      ok: false,
      failure: 'INVALID_KEY',
      prefixTried: null,
    });
    expect(db.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('reports the prefix it tried for an unknown key', async () => {
    /** The prefix is public and carries no secret, so logging it leaks nothing the caller
     *  did not already supply — and it is what makes a probing client identifiable. */
    const minted = mintToken('USER');
    const db = makeDb(null);
    expect(await resolveApiKey(db as never, minted.token)).toMatchObject({
      failure: 'INVALID_KEY',
      prefixTried: minted.prefix,
    });
  });

  it('refuses a right prefix with a wrong secret', async () => {
    /** The prefix half is a lookup key, not a credential. */
    const minted = mintToken('USER');
    const other = mintToken('USER');
    const db = makeDb(key({ prefix: minted.prefix, tokenHash: other.tokenHash }));
    expect(await resolveApiKey(db as never, minted.token)).toMatchObject({
      failure: 'INVALID_KEY',
    });
  });

  it('refuses a hash of a different length without throwing', async () => {
    /** `timingSafeEqual` throws on mismatched lengths — a stored hash from an older scheme
     *  would 500 the auth path instead of 401-ing it. */
    const minted = mintToken('USER');
    const db = makeDb(key({ prefix: minted.prefix, tokenHash: 'short' }));
    await expect(resolveApiKey(db as never, minted.token)).resolves.toMatchObject({
      failure: 'INVALID_KEY',
    });
  });

  it('refuses a revoked key before considering anything else', async () => {
    const minted = mintToken('USER');
    const db = makeDb(
      key({ prefix: minted.prefix, tokenHash: minted.tokenHash, revokedAt: new Date() }),
    );
    expect(await resolveApiKey(db as never, minted.token)).toMatchObject({ failure: 'REVOKED' });
  });

  it('refuses an expired key', async () => {
    const minted = mintToken('USER');
    const db = makeDb(
      key({
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    expect(await resolveApiKey(db as never, minted.token)).toMatchObject({ failure: 'EXPIRED' });
  });

  it('accepts a key that expires in the future', async () => {
    const minted = mintToken('USER');
    const db = makeDb(
      key({
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    expect((await resolveApiKey(db as never, minted.token)).ok).toBe(true);
  });

  it('distinguishes revoked from expired, because the fixes differ', async () => {
    /** One means "mint a new one"; the other means "somebody turned this off on purpose".
     *  Collapsing them into INVALID_KEY sends the caller to the wrong person. */
    const minted = mintToken('USER');
    const both = makeDb(
      key({
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    // Revocation is deliberate, so it wins.
    expect(await resolveApiKey(both as never, minted.token)).toMatchObject({ failure: 'REVOKED' });
  });
});

describe('the delegation marker', () => {
  it('names the key on every audited action', async () => {
    /**
     * Inside `details`, which IS part of the audit hash payload — so the marker cannot be
     * stripped from a row without breaking the chain, and it needed no change to the
     * frozen nine-field payload to get there.
     */
    const resolved = {
      key: key({ id: 'k-9', name: 'Zapier', kind: 'PLATFORM' }),
      actingUserId: 'u-2',
      delegated: true,
    };
    expect(delegationAuditDetails(resolved as never)).toEqual({
      viaApiKey: { id: 'k-9', name: 'Zapier', kind: 'PLATFORM', onBehalfOf: 'u-2' },
    });
  });

  it('omits the subject for a personal token, where there is no delegation', async () => {
    /** `onBehalfOf` on a user key would suggest an impersonation that did not happen. */
    const resolved = { key: key(), actingUserId: 'u-1', delegated: false };
    expect(delegationAuditDetails(resolved as never)).toEqual({
      viaApiKey: { id: 'k-1', name: 'CI bot', kind: 'USER' },
    });
  });
});

describe('touchLastUsed', () => {
  it('stamps the key', async () => {
    const db = makeDb(null);
    await touchLastUsed(db as never, 'k-1');
    expect((db.apiKey.update.mock.calls[0][0] as { where: unknown }).where).toEqual({
      id: 'k-1',
    });
  });

  it('never fails the request it was recording', async () => {
    /** Telemetry. A row-lock timeout on the stamp must not turn a successful API call into
     *  a 500. */
    const db = makeDb(null);
    db.apiKey.update.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(touchLastUsed(db as never, 'k-1')).resolves.toBeUndefined();
  });
});
