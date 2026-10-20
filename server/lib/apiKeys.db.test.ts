// @vitest-environment node
// Ported from ExpenseOS `apps/web/src/server/lib/apiKeys.db.test.ts` (1e682dd6), w6-04 (d88).
// Each adaptation is marked "VeloExpense (w6-04):".
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense (w6-04): ExpenseOS's suite holds its db and caller untyped (`any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';
import { delegationAuditDetails, mintToken, resolveApiKey } from './apiKeys';

/**
 * API keys against a real database.
 *
 * Everything dangerous is in resolution and visibility: a key decides WHOSE authority a
 * request carries, and the list decides who learns a key exists. So the tests are mostly
 * refusals, each a distinct way the check could be walked around.
 *
 * Gated on DATABASE_URL; the hermetic run skips it.
 */

// VeloExpense (w6-04): VeloExpense's auth and tenant-host modules, as the other ported suites.
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/rbac/server', () => ({ resolveRbacUser: vi.fn(), getRbacRedis: vi.fn() }));

const REPORT_SCOPE = 'expense_management.expense_report';

describe.skipIf(!process.env.DATABASE_URL)('api keys (integration)', () => {
  let db: any;
  // VeloExpense (w6-04): a fresh tenant with two people (the harness), instead of ExpenseOS's
  // seeded database; its `db` runs each call in that tenant, and so does its caller.
  let h: TenantHarness;
  let caller: (userId: string, perms?: readonly string[]) => any;
  let aliceId: string;
  let bobId: string;
  const keyIds: string[] = [];

  const seedKey = async (over: Record<string, unknown> = {}) => {
    const kind = (over.kind as 'USER' | 'PLATFORM') ?? 'USER';
    const minted = mintToken(kind);
    const row = await db.apiKey.create({
      data: {
        kind,
        name: 'test key',
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
        userId: kind === 'USER' ? aliceId : null,
        createdById: aliceId,
        scopes: [REPORT_SCOPE],
        ...over,
      },
    });
    keyIds.push(row.id);
    return { row, token: minted.token };
  };

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'api-keys',
      name: 'API Keys Co',
      people: [{ email: 'bob@api-keys.test', name: 'Bob Builder' }],
    });
    db = h.db;
    const { apiKeysRouter } = await import('../routers/apiKeys');
    caller = (userId, perms = []) => h.makeCaller(perms, userId, apiKeysRouter);
    aliceId = h.people[0].id;
    bobId = h.people[1].id;
  });

  afterAll(async () => {
    if (keyIds.length) {
      await db.apiKeyRequest.deleteMany({ where: { apiKeyId: { in: keyIds } } });
      await db.apiKey.deleteMany({ where: { id: { in: keyIds } } });
    }
    await h?.end();
  });

  describe('resolveApiKey', () => {
    it('resolves a user key to its owner', async () => {
      const { token } = await seedKey();
      const res = await resolveApiKey(db, token);
      expect(res).toMatchObject({
        ok: true,
        resolved: { actingUserId: aliceId, delegated: false },
      });
    });

    it('refuses an unknown prefix, and reports the prefix tried', async () => {
      // The prefix is recorded so a brute-force sweep leaves a trail.
      const stranger = mintToken('USER');
      const res = await resolveApiKey(db, stranger.token);
      expect(res).toMatchObject({ ok: false, failure: 'INVALID_KEY' });
      expect((res as any).prefixTried).toHaveLength(16);
    });

    it('refuses the right prefix with the wrong secret', async () => {
      // Finding the row must not be the same as proving the secret.
      const { row } = await seedKey();
      const forged = `vxe_u_${row.prefix}_${'A'.repeat(43)}`;
      expect(await resolveApiKey(db, forged)).toMatchObject({ failure: 'INVALID_KEY' });
    });

    it('refuses a malformed token without a prefix to report', async () => {
      expect(await resolveApiKey(db, 'not-a-token')).toEqual({
        ok: false,
        failure: 'INVALID_KEY',
        prefixTried: null,
      });
    });

    it('refuses revoked and expired keys distinctly', async () => {
      const revoked = await seedKey({ revokedAt: new Date() });
      const expired = await seedKey({ expiresAt: new Date(Date.now() - 1000) });
      expect(await resolveApiKey(db, revoked.token)).toMatchObject({ failure: 'REVOKED' });
      expect(await resolveApiKey(db, expired.token)).toMatchObject({ failure: 'EXPIRED' });
    });

    it('refuses a user key trying to act as somebody else', async () => {
      // A personal token being used as an impersonation capability.
      const { token } = await seedKey();
      expect(await resolveApiKey(db, token, bobId)).toMatchObject({
        failure: 'SUBJECT_NOT_ALLOWED',
      });
    });

    it('requires a platform key to name its subject', async () => {
      // A platform key has no owner to fall back on — defaulting would make every
      // unattended call look like the provisioning admin acting personally.
      const { token } = await seedKey({ kind: 'PLATFORM' });
      expect(await resolveApiKey(db, token)).toMatchObject({ failure: 'SUBJECT_REQUIRED' });
    });

    it('refuses a platform key naming somebody who does not exist', async () => {
      const { token } = await seedKey({ kind: 'PLATFORM' });
      const res = await resolveApiKey(db, token, '00000000-0000-7000-8000-00000000dead');
      expect(res).toMatchObject({ failure: 'SUBJECT_UNKNOWN' });
    });

    it('resolves a platform key to the named subject, flagged delegated', async () => {
      const { token } = await seedKey({ kind: 'PLATFORM' });
      expect(await resolveApiKey(db, token, bobId)).toMatchObject({
        ok: true,
        resolved: { actingUserId: bobId, delegated: true },
      });
    });

    it('treats a USER key with no owner as invalid rather than guessing', async () => {
      const { token } = await seedKey({ kind: 'USER', userId: null });
      expect(await resolveApiKey(db, token)).toMatchObject({ failure: 'INVALID_KEY' });
    });
  });

  describe('delegationAuditDetails', () => {
    it('names the subject only when somebody was impersonated', async () => {
      // `actorId` stays the acting person; `details` is inside the audit hash payload, so
      // this marker cannot be stripped without breaking the chain.
      const personal = await seedKey();
      const platform = await seedKey({ kind: 'PLATFORM' });
      const a = (await resolveApiKey(db, personal.token)) as any;
      const b = (await resolveApiKey(db, platform.token, bobId)) as any;
      expect(delegationAuditDetails(a.resolved).viaApiKey).not.toHaveProperty('onBehalfOf');
      expect((delegationAuditDetails(b.resolved) as any).viaApiKey.onBehalfOf).toBe(bobId);
    });
  });

  describe('provisioning and visibility', () => {
    it('lets an admin mint a personal key, owned by them', async () => {
      const out = await caller(aliceId, [P.admin.apiKey.create]).create({
        kind: 'USER',
        name: 'my laptop',
        scopes: [REPORT_SCOPE],
      });
      keyIds.push(out.key.id);
      expect(out.token.startsWith('vxe_u_')).toBe(true);
      expect(out.key.userId).toBe(aliceId);
      expect(out.key.createdById).toBe(aliceId);
    });

    it('refuses a platform key without admin.apiKey.create', async () => {
      await expect(
        caller(aliceId).create({ kind: 'PLATFORM', name: 'integration' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('mints a platform key with no owner', async () => {
      const out = await caller(aliceId, [P.admin.apiKey.create]).create({
        kind: 'PLATFORM',
        name: 'integration',
        scopes: [`${REPORT_SCOPE}.readonly`],
      });
      keyIds.push(out.key.id);
      expect(out.key.kind).toBe('PLATFORM');
      expect(out.key.userId).toBeNull();
    });

    it('refuses a scope this build does not know', async () => {
      // Otherwise the key silently cannot do what its owner believes it can.
      await expect(
        caller(aliceId, [P.admin.apiKey.create]).create({
          kind: 'USER',
          name: 'typo',
          scopes: ['expense.reprot'],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('accepts an empty scope list, which grants nothing', async () => {
      const out = await caller(aliceId, [P.admin.apiKey.create]).create({
        kind: 'USER',
        name: 'inert',
        scopes: [],
      });
      keyIds.push(out.key.id);
      expect(out.key.scopes).toEqual([]);
    });

    it('never returns the token hash', async () => {
      const rows = await caller(aliceId).list();
      for (const row of rows) expect(row).not.toHaveProperty('tokenHash');
    });

    it('shows a non-admin only keys that act as them', async () => {
      await seedKey({ kind: 'PLATFORM', name: 'platform-only' });
      const rows = await caller(bobId).list();
      expect(rows.every((r: any) => r.userId === bobId)).toBe(true);
      expect(rows.some((r: any) => r.kind === 'PLATFORM')).toBe(false);
    });

    it('shows an admin every platform key as well as their own', async () => {
      const { row } = await seedKey({ kind: 'PLATFORM', name: 'visible-to-admin' });
      const rows = await caller(bobId, [P.admin.apiKey.list]).list();
      expect(rows.some((r: any) => r.id === row.id)).toBe(true);
    });

    it('marks a key provisioned FOR somebody as not theirs to manage', async () => {
      // The ruled distinction: you see a key that acts as you, without being able to
      // rescope or revoke one you did not mint.
      const row = await db.apiKey.create({
        data: {
          kind: 'USER',
          name: 'provisioned for bob',
          prefix: mintToken('USER').prefix,
          tokenHash: mintToken('USER').tokenHash,
          userId: bobId,
          createdById: aliceId,
          scopes: [],
        },
      });
      keyIds.push(row.id);
      const seen = (await caller(bobId).list()).find((r: any) => r.id === row.id);
      expect(seen).toBeTruthy();
      expect(seen.manageable).toBe(false);
      await expect(caller(bobId).revoke({ id: row.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      // Bob is given the provisioning permission here on purpose: the point under test is
      // `requireManageable`, and without the permission the refusal would be the gate's.
      await expect(
        caller(bobId, [P.admin.apiKey.create]).update({ id: row.id, scopes: [REPORT_SCOPE] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('hides the difference between "not yours" and "does not exist"', async () => {
      // Both NOT_FOUND, so the endpoint cannot be used to discover which ids are real.
      await expect(
        caller(bobId).revoke({ id: '00000000-0000-7000-8000-0000000000ee' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lets an admin with revoke manage a key they did not mint', async () => {
      const { row } = await seedKey();
      const out = await caller(bobId, [P.admin.apiKey.revoke]).revoke({ id: row.id });
      expect(out.revokedAt).toBeTruthy();
    });

    it('lets an admin rescope a key they minted', async () => {
      const { row } = await seedKey();
      const out = await caller(aliceId, [P.admin.apiKey.create]).update({
        id: row.id,
        scopes: [`${REPORT_SCOPE}.readonly`],
      });
      expect(out.scopes).toEqual([`${REPORT_SCOPE}.readonly`]);
    });

    it('refuses an address entry that could never match', async () => {
      // An unparseable entry does not fail open or closed obviously — the key is simply
      // refused from everywhere with IP_BLOCKED and nothing says why.
      await expect(
        caller(aliceId, [P.admin.apiKey.create]).create({
          kind: 'USER',
          name: 'bad ip',
          allowedIps: ['203.0.113.0/33'],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('accepts IPv6 in an allowlist', async () => {
      const out = await caller(aliceId, [P.admin.apiKey.create]).create({
        kind: 'USER',
        name: 'v6',
        allowedIps: ['2001:db8::/32'],
      });
      keyIds.push(out.key.id);
      expect(out.key.allowedIps).toEqual(['2001:db8::/32']);
    });

    it('rotates a key: new secret, same configuration, old one revoked', async () => {
      // One operation, because "create, reconfigure, then remember to revoke" ends with the
      // old key still live.
      const { row } = await seedKey({
        scopes: [`${REPORT_SCOPE}.readonly`],
        rateLimitPerMinute: 30,
        allowedIps: ['203.0.113.0/24'],
      });
      const out = await caller(aliceId).rotate({ id: row.id });
      keyIds.push(out.key.id);

      expect(out.token.startsWith('vxe_u_')).toBe(true);
      expect(out.key.id).not.toBe(row.id);
      expect(out.key.scopes).toEqual([`${REPORT_SCOPE}.readonly`]);
      expect(out.key.rateLimitPerMinute).toBe(30);
      expect(out.key.allowedIps).toEqual(['203.0.113.0/24']);

      const old = await db.apiKey.findUnique({ where: { id: row.id } });
      expect(old.revokedAt).toBeTruthy();
    });

    it('will not rotate a key it will not let you manage', async () => {
      const row = await db.apiKey.create({
        data: {
          kind: 'USER',
          name: 'not bobs to rotate',
          prefix: mintToken('USER').prefix,
          tokenHash: mintToken('USER').tokenHash,
          userId: bobId,
          createdById: aliceId,
          scopes: [],
        },
      });
      keyIds.push(row.id);
      await expect(caller(bobId).rotate({ id: row.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses to rotate an already-revoked key', async () => {
      const { row } = await seedKey({ revokedAt: new Date() });
      await expect(caller(aliceId).rotate({ id: row.id })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('refuses to rescope onto an unknown scope', async () => {
      const { row } = await seedKey();
      await expect(
        caller(aliceId, [P.admin.apiKey.create]).update({ id: row.id, scopes: ['nope.nope'] }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  /**
   * The provisioning gate.
   *
   * `create` and `update` both take `scopes` verbatim, and `assertScopes` checks only that a
   * scope string is one this build knows — never that it is one the caller ought to hold.
   * `requireManageable` admits whoever minted a key, and a self-minted key's `createdById`
   * IS its owner. So with nothing on the procedures themselves, anybody could mint
   * themselves a key carrying every scope in the vocabulary, or quietly widen the one they
   * already have. Both now take `admin.apiKey.create`.
   *
   * The scope strings below are spelled out literally on purpose. Importing the policy
   * constant would let a rename update the assertion in step with the code, and the test
   * would then prove nothing.
   */
  describe('the provisioning gate', () => {
    const WIDE = [
      'admin.security.api_key',
      'admin.people.user',
      'expense_management.expense_approval',
    ];
    const NARROW = 'expense_management.expense_report.readonly';

    it('refuses a non-admin minting themselves a wide personal key', async () => {
      await expect(
        caller(bobId).create({ kind: 'USER', name: 'everything', scopes: WIDE }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses a non-admin minting a personal key at all, however narrow', async () => {
      // The gate is on provisioning, not on the width of what is asked for. Letting the
      // narrow mint through would just make it the foothold for a later `update`.
      await expect(
        caller(bobId).create({ kind: 'USER', name: 'modest', scopes: [NARROW] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses a non-admin widening their OWN key, and leaves the row as it was', async () => {
      // This is the actual hole. `requireManageable` admits the owner of a self-minted key,
      // so a test that used somebody else's key would be refused for the wrong reason.
      const minted = mintToken('USER');
      const own = await db.apiKey.create({
        data: {
          kind: 'USER',
          name: 'bobs own key',
          prefix: minted.prefix,
          tokenHash: minted.tokenHash,
          userId: bobId,
          createdById: bobId,
          scopes: [NARROW],
        },
      });
      keyIds.push(own.id);

      await expect(caller(bobId).update({ id: own.id, scopes: WIDE })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });

      // Proven at the row, not merely at the error: a refusal that still wrote would be
      // indistinguishable from this one at the call site.
      const after = await db.apiKey.findUniqueOrThrow({ where: { id: own.id } });
      expect(after.scopes).toEqual([NARROW]);
    });

    it('still lets an admin create and then rescope a platform key', async () => {
      const admin = caller(aliceId, [P.admin.apiKey.create]);
      const out = await admin.create({
        kind: 'PLATFORM',
        name: 'gated but allowed',
        scopes: [NARROW],
      });
      keyIds.push(out.key.id);
      expect(out.key.kind).toBe('PLATFORM');
      expect(out.key.scopes).toEqual([NARROW]);

      const updated = await admin.update({ id: out.key.id, scopes: WIDE });
      expect(updated.scopes).toEqual(WIDE);
    });
  });

  /**
   * The self-service personal key: `personal`, `requestPersonal`, `regeneratePersonal`.
   *
   * **Every scope string below is spelled out as a literal and `PERSONAL_KEY_POLICY` is
   * never imported into the assertion side of a test.** If the assertions read the
   * constant, renaming a scope would move code and expectation together and these tests
   * would pass while proving nothing at all.
   *
   * Assertions are on the PERSISTED row wherever the question is what was written. A
   * procedure that returned the right object and stored something else would satisfy a
   * return-value assertion perfectly.
   */
  describe('the self-service personal key', () => {
    const POLICY_SCOPES = [
      'expense_management.expense_report',
      'travel.travel_request',
      'collaboration.discussion',
    ];
    const DAY_MS = 86_400_000;

    /**
     * Put a user back in the empty state.
     *
     * Needed because earlier describes in this file leave Alice holding a dozen live
     * self-minted USER keys, and `requestPersonal` refuses when the caller already has
     * one. Revoking rather than deleting is what the product itself does, so the starting
     * state each test sets up is a state the product can actually be in.
     *
     * **`createdById` is deliberately absent from this filter — do not put it back.** It
     * has to match `requestPersonal`'s conflict predicate, which since this phase is the
     * wide "any unrevoked USER key that acts as you", whoever minted it. `provisioning
     * and visibility` leaves Bob holding unrevoked keys that Alice minted for him (see
     * "marks a key provisioned FOR somebody as not theirs to manage"), so a filter narrowed
     * back to `createdById` would silently stop reaching the empty state and every
     * `requestPersonal` test below would start failing `CONFLICT` for a reason that has
     * nothing to do with what it is testing.
     */
    const clearPersonal = async (userId: string) => {
      await db.apiKey.updateMany({
        where: { kind: 'USER', userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    };

    /** The audit rows written for one key, newest first.
     *  VeloExpense (w6-04): VeloExpense's chain is `audit_entry`, read through the harness's
     *  admin pool, and its action names are the registry's (`apiKey.create` -> API_KEY_CREATED). */
    const ACTION_NAME: Record<string, string> = {
      'apiKey.create': 'API_KEY_CREATED',
      'apiKey.update': 'API_KEY_UPDATED',
      'apiKey.rotate': 'API_KEY_ROTATED',
      'apiKey.revoke': 'API_KEY_REVOKED',
    };
    const auditFor = async (entityId: string, action: string) =>
      (
        await h.admin.query(
          `SELECT action, actor_id AS "actorId", details FROM audit_entry
            WHERE entity_id = $1 AND action = $2 ORDER BY sequence DESC`,
          [entityId, ACTION_NAME[action] ?? action],
        )
      ).rows;

    /** A key belonging to `userId` that was NOT minted through the policy path. */
    const seedOffPolicy = async (userId: string, over: Record<string, unknown> = {}) => {
      const minted = mintToken('USER');
      const row = await db.apiKey.create({
        data: {
          kind: 'USER',
          name: 'legacy key',
          prefix: minted.prefix,
          tokenHash: minted.tokenHash,
          userId,
          createdById: userId,
          scopes: ['admin.security.api_key', 'admin.people.user'],
          rateLimitPerMinute: 6000,
          allowedIps: ['203.0.113.0/24'],
          expiresAt: null,
          ...over,
        },
      });
      keyIds.push(row.id);
      return { row, token: minted.token };
    };

    describe('requestPersonal', () => {
      it('mints exactly the six fixed values, and nothing the caller chose', async () => {
        // Acceptance criterion 4, asserted on the PERSISTED row.
        await clearPersonal(bobId);
        const before = Date.now();
        const out = await caller(bobId).requestPersonal();
        keyIds.push(out.key.id);
        const after = Date.now();

        const row = await db.apiKey.findUniqueOrThrow({ where: { id: out.key.id } });
        expect(row.kind).toBe('USER');
        expect(row.userId).toBe(bobId);
        expect(row.createdById).toBe(bobId);
        expect([...row.scopes].sort()).toEqual([...POLICY_SCOPES].sort());
        expect(row.scopes).toHaveLength(3);
        expect(row.rateLimitPerMinute).toBe(60);
        expect(row.allowedIps).toEqual([]);
        expect(row.revokedAt).toBeNull();

        // 180 days out, bracketed by the call rather than pinned to a clock.
        expect(row.expiresAt).not.toBeNull();
        const ttl = (row.expiresAt as Date).getTime();
        expect(ttl).toBeGreaterThanOrEqual(before + 180 * DAY_MS);
        expect(ttl).toBeLessThanOrEqual(after + 180 * DAY_MS);
      });

      it('derives the name from the owner rather than accepting one', async () => {
        await clearPersonal(bobId);
        const bob = await db.user.findUniqueOrThrow({ where: { id: bobId } });
        const out = await caller(bobId).requestPersonal();
        keyIds.push(out.key.id);
        const row = await db.apiKey.findUniqueOrThrow({ where: { id: out.key.id } });
        expect(row.name.endsWith(' — personal key')).toBe(true);
        expect(row.name).toContain(bob.firstName ?? bob.email);
      });

      it('needs no permission — this is the deliberate exception to the repo rule', async () => {
        // The caller carries no permissions at all. A personal key on the fixed policy
        // grants nothing the caller did not already have, so there is nothing to gate.
        await clearPersonal(bobId);
        const out = await caller(bobId, []).requestPersonal();
        keyIds.push(out.key.id);
        expect(out.token.startsWith('vxe_u_')).toBe(true);
      });

      it('returns a token that resolves to the caller', async () => {
        await clearPersonal(bobId);
        const out = await caller(bobId).requestPersonal();
        keyIds.push(out.key.id);
        expect(await resolveApiKey(db, out.token)).toMatchObject({
          ok: true,
          resolved: { actingUserId: bobId, delegated: false },
        });
      });

      it('refuses a second key while one is unrevoked, and writes nothing', async () => {
        // The double-click guard, and the reason the empty state is the only place the
        // request button belongs. Proven at the row count, because a refusal that still
        // inserted would look identical at the call site.
        await clearPersonal(bobId);
        const first = await caller(bobId).requestPersonal();
        keyIds.push(first.key.id);

        await expect(caller(bobId).requestPersonal()).rejects.toMatchObject({
          code: 'CONFLICT',
        });
        // Counted wide — every unrevoked key acting as Bob, whoever minted it — because
        // that is the set the refusal is now defending.
        const held = await db.apiKey.count({
          where: { kind: 'USER', userId: bobId, revokedAt: null },
        });
        expect(held).toBe(1);
      });

      it('refuses while the only key is expired, so Regenerate is the way back', async () => {
        // Deliberate: `regeneratePersonal` is the total function. Letting a top-up through
        // here would leave the user holding an unrevoked dead row plus a live one.
        await clearPersonal(bobId);
        await seedOffPolicy(bobId, { expiresAt: new Date(Date.now() - 1000) });
        await expect(caller(bobId).requestPersonal()).rejects.toMatchObject({
          code: 'CONFLICT',
        });
      });

      it('leaves an audit row that does not contain the plaintext token', async () => {
        // Criterion 10, plus the property nothing asserted before: the one secret this
        // procedure produces must not be recoverable from the audit trail.
        await clearPersonal(bobId);
        const out = await caller(bobId).requestPersonal();
        keyIds.push(out.key.id);

        const rows = await auditFor(out.key.id, 'apiKey.create');
        expect(rows).toHaveLength(1);
        expect(rows[0].actorId).toBe(bobId);
        expect(JSON.stringify(rows)).not.toContain(out.token);
        expect(rows[0].details).toMatchObject({ via: 'requestPersonal' });
      });
    });

    describe('regeneratePersonal', () => {
      it('revokes the previous key rather than deleting it', async () => {
        // Criterion 6. REVOKED and not INVALID_KEY is the whole assertion: `ok === false`
        // alone would also pass against an implementation that hard-deleted the row, which
        // would break the audit trail and the /admin/api-keys forensics with it.
        await clearPersonal(bobId);
        const first = await caller(bobId).requestPersonal();
        keyIds.push(first.key.id);

        const again = await caller(bobId).regeneratePersonal();
        keyIds.push(again.key.id);

        expect(await resolveApiKey(db, first.token)).toMatchObject({ failure: 'REVOKED' });
        expect(await resolveApiKey(db, again.token)).toMatchObject({
          ok: true,
          resolved: { actingUserId: bobId },
        });
        expect(again.key.id).not.toBe(first.key.id);
      });

      it('does NOT launder a legacy key forward — the replacement is on policy', async () => {
        // The single most important test in this phase, and the reason `rotate` is
        // disqualified: `rotate` copies scopes, rate limit, allowlist and expiry onto the
        // replacement, so regenerating an over-scoped legacy key would reproduce it exactly
        // with a fresh secret, indefinitely.
        await clearPersonal(bobId);
        const legacy = await seedOffPolicy(bobId, {
          scopes: [
            'admin.security.api_key',
            'admin.people.user',
            'expense_management.expense_approval',
          ],
          rateLimitPerMinute: 100_000,
          allowedIps: ['203.0.113.0/24', '2001:db8::/32'],
          expiresAt: new Date(Date.now() + 3650 * DAY_MS),
        });

        const out = await caller(bobId).regeneratePersonal();
        keyIds.push(out.key.id);

        const row = await db.apiKey.findUniqueOrThrow({ where: { id: out.key.id } });
        expect([...row.scopes].sort()).toEqual([...POLICY_SCOPES].sort());
        expect(row.scopes).not.toContain('admin.security.api_key');
        expect(row.scopes).not.toContain('admin.people.user');
        expect(row.scopes).not.toContain('expense_management.expense_approval');
        expect(row.rateLimitPerMinute).toBe(60);
        expect(row.allowedIps).toEqual([]);
        // Not the legacy row's decade-long expiry, and not null either.
        expect(row.expiresAt).not.toBeNull();
        expect((row.expiresAt as Date).getTime()).toBeLessThan(Date.now() + 181 * DAY_MS);

        const old = await db.apiKey.findUniqueOrThrow({ where: { id: legacy.row.id } });
        expect(old.revokedAt).toBeTruthy();
      });

      it('records what the replaced key could do, and what the new one can', async () => {
        // RC-4. Without `scopesBefore` the audit trail cannot answer "what authority was
        // withdrawn here", which is the question a laundering incident starts from.
        await clearPersonal(bobId);
        await seedOffPolicy(bobId, { scopes: ['admin.people.user'] });

        const out = await caller(bobId).regeneratePersonal();
        keyIds.push(out.key.id);

        const rows = await auditFor(out.key.id, 'apiKey.rotate');
        expect(rows).toHaveLength(1);
        const details = rows[0].details as Record<string, unknown>;
        expect(details.scopesBefore).toEqual(['admin.people.user']);
        expect([...(details.scopesAfter as string[])].sort()).toEqual([...POLICY_SCOPES].sort());
        expect(details.via).toBe('regeneratePersonal');
        expect(details.revokedCount).toBe(1);
        expect(JSON.stringify(rows)).not.toContain(out.token);
      });

      it('works from the empty state and reports that it revoked nothing', async () => {
        await clearPersonal(bobId);
        const out = await caller(bobId).regeneratePersonal();
        keyIds.push(out.key.id);
        expect(out.revokedCount).toBe(0);
        expect(out.revokedKeyIds).toEqual([]);
        expect(out.token.startsWith('vxe_u_')).toBe(true);
      });

      it('revokes EVERY live personal key and says how many', async () => {
        // The confirmation copy has to name a count, so the count has to be real.
        await clearPersonal(bobId);
        const a = await seedOffPolicy(bobId, { name: 'one' });
        const b = await seedOffPolicy(bobId, { name: 'two' });
        const c = await seedOffPolicy(bobId, { name: 'three' });

        const out = await caller(bobId).regeneratePersonal();
        keyIds.push(out.key.id);

        expect(out.revokedCount).toBe(3);
        expect([...out.revokedKeyIds].sort()).toEqual([a.row.id, b.row.id, c.row.id].sort());

        const live = await db.apiKey.findMany({
          where: { kind: 'USER', userId: bobId, createdById: bobId, revokedAt: null },
        });
        expect(live).toHaveLength(1);
        expect(live[0].id).toBe(out.key.id);
      });

      it('does not touch a key somebody else minted for the caller', async () => {
        // Alice provisions Bob a key. It is his to hold, not his to replace — regenerating
        // must not revoke a credential he did not issue and cannot re-issue.
        await clearPersonal(bobId);
        const minted = mintToken('USER');
        const forBob = await db.apiKey.create({
          data: {
            kind: 'USER',
            name: 'provisioned for bob by alice',
            prefix: minted.prefix,
            tokenHash: minted.tokenHash,
            userId: bobId,
            createdById: aliceId,
            scopes: ['expense_management.expense_report'],
          },
        });
        keyIds.push(forBob.id);

        const out = await caller(bobId).regeneratePersonal();
        keyIds.push(out.key.id);

        expect(out.revokedKeyIds).not.toContain(forBob.id);
        const still = await db.apiKey.findUniqueOrThrow({ where: { id: forBob.id } });
        expect(still.revokedAt).toBeNull();
      });
    });

    describe('personal', () => {
      it('reports no key when the caller has none', async () => {
        await clearPersonal(bobId);
        const out = await caller(bobId).personal();
        expect(out.state).toBe('NONE');
        expect(out.keys).toEqual([]);
        expect(out.liveCount).toBe(0);
        expect(out.expiredCount).toBe(0);
        expect(out.revocableCount).toBe(0);
      });

      it('gives an admin holding only a PLATFORM key no personal key at all', async () => {
        // The bug the naive `list().length > 0` predicate introduces: `list` returns every
        // platform key to any holder of `admin.apiKey.list`, so an admin with zero personal
        // keys would see the metadata view — with Regenerate and Revoke pointed at an
        // organisational service account.
        await clearPersonal(bobId);
        const platform = await seedKey({ kind: 'PLATFORM', name: 'org integration' });

        const admin = caller(bobId, [P.admin.apiKey.list, P.admin.apiKey.revoke]);
        expect((await admin.list()).some((r: any) => r.id === platform.row.id)).toBe(true);

        const out = await admin.personal();
        expect(out.state).toBe('NONE');
        expect(out.keys).toEqual([]);
      });

      it('counts a key somebody else minted for the caller, and says it is not theirs to revoke', async () => {
        // **This assertion is inverted from the one this test shipped with**, which
        // required `state: 'NONE'` here. That was the bug: a key you cannot see is a key
        // you cannot revoke, and reporting NONE also offered the subject a second key.
        // `docs/design/api-keys.md` § "Visibility vs management" keeps seeing and managing
        // apart; the old predicate answered the first question with the second one's rule.
        await clearPersonal(bobId);
        const minted = mintToken('USER');
        const forBob = await db.apiKey.create({
          data: {
            kind: 'USER',
            name: 'provisioned for bob by alice',
            prefix: minted.prefix,
            tokenHash: minted.tokenHash,
            userId: bobId,
            createdById: aliceId,
            scopes: ['expense_management.expense_report'],
          },
        });
        keyIds.push(forBob.id);

        expect((await caller(bobId).list()).some((r: any) => r.id === forBob.id)).toBe(true);

        const out = await caller(bobId).personal();
        expect(out.state).toBe('LIVE');
        expect(out.keys.map((k: any) => k.id)).toEqual([forBob.id]);
        expect(out.liveCount).toBe(1);
        // Seen, and not his to destroy — so the box must not offer him a Revoke.
        expect(out.keys[0].revocable).toBe(false);
        expect(out.revocableCount).toBe(0);

        // Holding `admin.apiKey.revoke` changes the MANAGE answer and nothing else: same
        // single row, same `state`, now revocable. That the permission moves this and not
        // the row set is the whole point of the split — it is what `requireManageable`
        // already says for `revoke` and `rotate`.
        const asRevoker = await caller(bobId, [P.admin.apiKey.revoke]).personal();
        expect(asRevoker.state).toBe('LIVE');
        expect(asRevoker.keys.map((k: any) => k.id)).toEqual([forBob.id]);
        expect(asRevoker.keys[0].revocable).toBe(true);
        expect(asRevoker.revocableCount).toBe(1);
      });

      it('does not count a revoked key', async () => {
        await clearPersonal(bobId);
        await seedOffPolicy(bobId, { revokedAt: new Date() });
        expect((await caller(bobId).personal()).state).toBe('NONE');
      });

      it('reports an expired key as expired, not as absent and not as live', async () => {
        // At 180 days this is the routine end state of every key this path mints. A query
        // that filtered it out would tell a user whose integration broke this morning that
        // they have no key — the one thing they must not be told.
        await clearPersonal(bobId);
        const dead = await seedOffPolicy(bobId, {
          scopes: [
            'expense_management.expense_report',
            'travel.travel_request',
            'collaboration.discussion',
          ],
          rateLimitPerMinute: 60,
          allowedIps: [],
          expiresAt: new Date(Date.now() - 1000),
        });

        const out = await caller(bobId).personal();
        expect(out.state).toBe('ALL_EXPIRED');
        expect(out.liveCount).toBe(0);
        expect(out.expiredCount).toBe(1);
        expect(out.keys).toHaveLength(1);
        expect(out.keys[0].id).toBe(dead.row.id);
        expect(out.keys[0].expired).toBe(true);
        // Expired and off-policy are independent questions: this key is shaped correctly
        // and is simply old, so nothing should offer to "fix" it.
        expect(out.keys[0].inPolicy).toBe(true);
      });

      it('flags a legacy key as off policy and leaves the row exactly as it was', async () => {
        await clearPersonal(bobId);
        const legacy = await seedOffPolicy(bobId, {
          scopes: ['admin.people.user'],
          rateLimitPerMinute: 6000,
          allowedIps: ['203.0.113.0/24'],
          expiresAt: null,
        });

        const out = await caller(bobId).personal();
        expect(out.state).toBe('LIVE');
        expect(out.keys[0].inPolicy).toBe(false);
        expect(out.keys[0].expired).toBe(false);

        // Reported, never repaired. Reading the box must not rewrite a live credential.
        const row = await db.apiKey.findUniqueOrThrow({ where: { id: legacy.row.id } });
        expect(row.scopes).toEqual(['admin.people.user']);
        expect(row.rateLimitPerMinute).toBe(6000);
        expect(row.allowedIps).toEqual(['203.0.113.0/24']);
        expect(row.expiresAt).toBeNull();
      });

      it('returns EVERY live key as its own row, never a primary key plus a count', async () => {
        // RC-3. A key you cannot see is a key you cannot revoke, so a shape that collapsed
        // the extras into a number would hide a live credential from its owner.
        await clearPersonal(bobId);
        const a = await seedOffPolicy(bobId, { name: 'first' });
        const b = await seedOffPolicy(bobId, { name: 'second' });

        const out = await caller(bobId).personal();
        expect(out.state).toBe('LIVE');
        expect(out.liveCount).toBe(2);
        expect(out.keys.map((k: any) => k.id).sort()).toEqual([a.row.id, b.row.id].sort());
      });

      it('reports LIVE when one key still works and another has expired', async () => {
        // `ALL_EXPIRED` means exactly what it says — every key is dead. One survivor is
        // enough to make the state LIVE, with the corpse still listed and counted.
        await clearPersonal(bobId);
        const alive = await caller(bobId).requestPersonal();
        keyIds.push(alive.key.id);
        const dead = await seedOffPolicy(bobId, {
          name: 'dead alongside a live one',
          expiresAt: new Date(Date.now() - 1000),
        });

        const out = await caller(bobId).personal();
        expect(out.state).toBe('LIVE');
        expect(out.liveCount).toBe(1);
        expect(out.expiredCount).toBe(1);
        expect(out.keys).toHaveLength(2);
        expect(out.keys.find((k: any) => k.id === dead.row.id).expired).toBe(true);
        expect(out.keys.find((k: any) => k.id === alive.key.id).expired).toBe(false);
      });

      it('never returns the token hash', async () => {
        await clearPersonal(bobId);
        const out = await caller(bobId).requestPersonal();
        keyIds.push(out.key.id);
        for (const key of (await caller(bobId).personal()).keys) {
          expect(key).not.toHaveProperty('tokenHash');
        }
      });

      it('shows a key the moment it is minted, and stops showing it once revoked', async () => {
        // Criteria 5 and 7 at the server: the metadata view on arrival, and the return to
        // the empty state after Revoke. `revoke` itself is unchanged by this phase.
        await clearPersonal(bobId);
        const out = await caller(bobId).requestPersonal();
        keyIds.push(out.key.id);
        expect((await caller(bobId).personal()).state).toBe('LIVE');

        await caller(bobId).revoke({ id: out.key.id });
        expect((await caller(bobId).personal()).state).toBe('NONE');

        // Criterion 10 for the third path.
        const rows = await auditFor(out.key.id, 'apiKey.revoke');
        expect(rows.length).toBeGreaterThanOrEqual(1);
      });
    });

    /**
     * A key that acts as the caller but was minted by somebody else.
     *
     * The state the whole visibility/management split exists for, and the one the previous
     * predicate got wrong in both directions at once: invisible on `/profile`, so the
     * subject was offered a second credential, and untouched by Regenerate, so they could
     * not have got rid of it either way. `docs/design/api-keys.md` § "Visibility vs
     * management" is the rule these tests hold the code to — see it if it acts as you,
     * manage it if you minted it or hold `admin.apiKey.revoke`.
     */
    describe('a key provisioned by somebody else', () => {
      /**
       * Reach the state through the product rather than by writing the row by hand.
       *
       * `rotate` is `protectedProcedure` behind `requireManageable`, so an admin holding
       * `admin.apiKey.revoke` may rotate anybody's key — and `rotate` writes
       * `userId: <the original owner>, createdById: <whoever rotated>`. That is the
       * reachability claim, proven rather than assumed: a hand-written row would only test
       * the predicate, not that the product can put a user here.
       *
       * Returns the id of the replacement, which is Bob's to hold and Alice's to manage.
       */
      const adminRotatesBobsKey = async () => {
        await clearPersonal(bobId);
        const own = await caller(bobId).requestPersonal();
        keyIds.push(own.key.id);

        const rotated = await caller(aliceId, [P.admin.apiKey.revoke]).rotate({ id: own.key.id });
        keyIds.push(rotated.key.id);

        const row = await db.apiKey.findUniqueOrThrow({ where: { id: rotated.key.id } });
        expect(row.kind).toBe('USER');
        expect(row.userId).toBe(bobId);
        expect(row.createdById).toBe(aliceId);
        expect(row.revokedAt).toBeNull();
        return rotated.key.id;
      };

      it('is a row on the subject own box, live, and flagged not revocable', async () => {
        const id = await adminRotatesBobsKey();

        const out = await caller(bobId).personal();
        expect(out.state).toBe('LIVE');
        expect(out.liveCount).toBe(1);
        expect(out.keys.map((k: any) => k.id)).toEqual([id]);
        expect(out.keys[0].revocable).toBe(false);
        expect(out.revocableCount).toBe(0);
      });

      it('closes the second-credential path: requestPersonal refuses and writes nothing', async () => {
        // The reported harm. With the conflict count narrowed to `createdById`, the subject
        // counted zero here, was shown "Request API key", and ended up holding two live
        // credentials acting as them. Asserted on the persisted rows, because a refusal
        // that still inserted would look identical at the call site.
        const id = await adminRotatesBobsKey();
        const actingAsBob = {
          where: { kind: 'USER' as const, userId: bobId, revokedAt: null },
        };
        const before = await db.apiKey.count(actingAsBob);
        expect(before).toBe(1);

        await expect(caller(bobId).requestPersonal()).rejects.toMatchObject({ code: 'CONFLICT' });

        expect(await db.apiKey.count(actingAsBob)).toBe(before);
        expect((await db.apiKey.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();
      });

      it('survives the subject Regenerate, which still mints having revoked nothing', async () => {
        // `revokedCount: 0` and a mint is the correct outcome, not an error: the caller had
        // nothing of their OWN to replace, so Regenerate is exactly the offer they need.
        const id = await adminRotatesBobsKey();

        const out = await caller(bobId).regeneratePersonal();
        keyIds.push(out.key.id);
        expect(out.revokedCount).toBe(0);
        expect(out.revokedKeyIds).toEqual([]);
        expect(out.token.startsWith('vxe_u_')).toBe(true);

        expect((await db.apiKey.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();

        const minted = await db.apiKey.findUniqueOrThrow({ where: { id: out.key.id } });
        expect(minted.createdById).toBe(bobId);
        expect([...minted.scopes].sort()).toEqual([...POLICY_SCOPES].sort());
        expect(minted.rateLimitPerMinute).toBe(60);
        expect(minted.expiresAt).not.toBeNull();

        // Two rows now, and Regenerate deliberately did NOT converge the set to one.
        const box = await caller(bobId).personal();
        expect(box.keys.map((k: any) => k.id).sort()).toEqual([id, out.key.id].sort());
        expect(box.revocableCount).toBe(1);
      });

      it('is left alone while Regenerate revokes the keys the subject did mint', async () => {
        const id = await adminRotatesBobsKey();
        const mine = await seedOffPolicy(bobId, { name: 'bobs own, alongside' });

        const out = await caller(bobId).regeneratePersonal();
        keyIds.push(out.key.id);
        expect(out.revokedCount).toBe(1);
        expect(out.revokedKeyIds).toEqual([mine.row.id]);

        expect((await db.apiKey.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();
        expect(
          (await db.apiKey.findUniqueOrThrow({ where: { id: mine.row.id } })).revokedAt,
        ).toBeTruthy();

        // The audit has to be truthful about the NARROWED set. Claiming authority was
        // withdrawn from a key that is still live would misdirect whoever reads this row
        // after an incident — and `scopesBefore` is the field a laundering question starts
        // from, so it must describe only what actually stopped working.
        const rows = await auditFor(out.key.id, 'apiKey.rotate');
        expect(rows).toHaveLength(1);
        const details = rows[0].details as Record<string, unknown>;
        expect(details.revokedKeyIds).toEqual([mine.row.id]);
        expect(details.revokedCount).toBe(1);
        expect(details.scopesBefore).toEqual(['admin.people.user', 'admin.security.api_key']);
        expect(details.scopesBefore).not.toContain('travel.travel_request');
      });

      it('IS the subject to revoke once they hold admin.apiKey.revoke', async () => {
        // The one place a permission legitimately moves this path: `requireManageable` says
        // whether you may revoke depends on what you hold, so `revocable` has to say so
        // too. `revocable` mirroring that gate is what stops the box offering a Revoke the
        // server answers with NOT_FOUND.
        const id = await adminRotatesBobsKey();

        // Without it: not revocable in the box, and `revoke` refuses the same row.
        const plain = await caller(bobId).personal();
        expect(plain.keys.find((k: any) => k.id === id).revocable).toBe(false);
        await expect(caller(bobId).revoke({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });

        // With it: revocable in the box, and Regenerate does destroy it.
        const asRevoker = caller(bobId, [P.admin.apiKey.revoke]);
        const box = await asRevoker.personal();
        expect(box.keys.find((k: any) => k.id === id).revocable).toBe(true);
        expect(box.revocableCount).toBe(1);

        const out = await asRevoker.regeneratePersonal();
        keyIds.push(out.key.id);
        expect(out.revokedKeyIds).toContain(id);
        expect((await db.apiKey.findUniqueOrThrow({ where: { id } })).revokedAt).toBeTruthy();
      });
    });
  });
});
