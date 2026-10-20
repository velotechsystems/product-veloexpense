// @vitest-environment node
/**
 * The authorization server against the database — registration, consent, both token grants,
 * revocation, and the per-call grant check.
 *
 * Ported from VeloCRM `__tests__/oauth/{token,revoke,multiTenant,audit,mcpAuth}.test.ts`
 * (59fce1c). VeloCRM's versions test simulations — "simulateAtomicConsume", rows filtered in
 * an array, "the RLS policy uses app.current_tenant" asserted on a string the test wrote — so
 * none of them could fail if the service changed. Each case below is one of theirs, run against
 * lib/mcpOauth/service.ts and a real tenant, plus the regressions for the two VeloCRM defects
 * the port fixes (a replay's revocation rolled back; revoking from an unverified token).
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '@/server/__test-helpers__/tenantHarness';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(async () => ({ permissions: ['expense.report.createOwn'] })),
  getRbacRedis: vi.fn(),
}));

const BASE = 'https://mcp.veloexpense.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

describe.skipIf(!process.env.DATABASE_URL)('the MCP OAuth server (integration)', () => {
  let h: TenantHarness;
  let svc: typeof import('./service');
  let tokens: typeof import('./tokens');
  let prisma: typeof import('@/lib/db/prisma');
  let orgB: string;
  let userB: string;

  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  /** Register a client, consent as `userId` in `org`, and return everything a client holds. */
  const connect = async (org: string, userId: string, scopes = ['travel.travel_request']) => {
    const client = await svc.registerClient({
      clientName: 'Claude',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
    });
    const p = pkce();
    const { code, grantId } = await svc.consent(
      { organizationId: org, userId, name: 'Someone' },
      client,
      scopes,
      REDIRECT,
      p.challenge,
    );
    return { client, code, grantId, ...p };
  };

  const exchange = (c: Awaited<ReturnType<typeof connect>>, over: Record<string, string> = {}) =>
    svc.exchangeCode({ base: BASE, code: c.code, codeVerifier: c.verifier, clientId: c.client.clientId, redirectUri: REDIRECT, ...over });

  const grantRow = async (id: string) =>
    (await h.admin.query('SELECT revoked_at, revoke_reason, activated_at FROM mcp_oauth_grant WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'oauth-a',
      name: 'OAuth A',
      people: [{ email: 'bob@oauth-a.test', name: 'Bob Builder' }],
    });
    svc = await import('./service');
    tokens = await import('./tokens');
    prisma = await import('@/lib/db/prisma');
    const { createOrganization } = await import('@/lib/onboarding/provision');
    orgB = (await createOrganization({ name: 'OAuth B', slug: 'oauth-b', adminEmail: 'founder@oauth-b.test', adminName: 'Founder' }))
      .organizationId;
    userB = (await h.admin.query(`SELECT id FROM app_user WHERE organization_id = $1`, [orgB])).rows[0].id;
  });

  beforeEach(async () => {
    await h.admin.query(`UPDATE app_user SET has_access = true WHERE organization_id = $1`, [h.orgId]);
  });

  afterAll(async () => {
    await h?.admin.query('DELETE FROM mcp_oauth_grant');
    await h?.admin.query('DELETE FROM mcp_oauth_client');
    await h?.end();
  });

  describe('the authorization_code grant', () => {
    it('exchanges a consented code for a 15-minute access token and a refresh token, and activates the grant', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r = await exchange(c);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'travel.travel_request' });
      const claims = await tokens.verifyAccessToken(BASE, r.body.access_token);
      expect(claims).toEqual({
        sub: h.people[1].id,
        tenant_id: h.orgId,
        scope: 'travel.travel_request',
        client_id: c.client.clientId,
        gid: c.grantId,
      });
      expect((await grantRow(c.grantId)).activated_at).not.toBeNull();
      // Stored hashed: neither the code nor the refresh token is in the database.
      const raw = await h.admin.query(
        `SELECT 1 FROM mcp_oauth_code WHERE code_hash = $1 OR code_hash = $2 UNION ALL
         SELECT 1 FROM mcp_oauth_refresh_token WHERE token_hash = $2`,
        [c.code, r.body.refresh_token],
      );
      expect(raw.rows).toHaveLength(0);
    });

    it('writes the consent and the first token to the audit chain', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      await exchange(c);
      const rows = await h.admin.query(
        `SELECT action, actor_id FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
        [c.grantId],
      );
      expect(rows.rows).toEqual([
        { action: 'OAUTH_GRANT_CREATED', actor_id: h.people[1].id },
        { action: 'OAUTH_TOKEN_ISSUED', actor_id: h.people[1].id },
      ]);
    });

    it('refuses the wrong PKCE verifier, the wrong redirect_uri and another client', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      expect(await exchange(c, { codeVerifier: pkce().verifier })).toMatchObject({ ok: false, error: 'invalid_grant' });
      expect(await exchange(c, { redirectUri: 'https://claude.ai/other' })).toMatchObject({ ok: false, error: 'invalid_grant' });
      const other = await connect(h.orgId, h.people[1].id);
      expect(await exchange(c, { clientId: other.client.clientId })).toMatchObject({ ok: false, error: 'invalid_grant' });
      // None of those consumed it.
      expect((await exchange(c)).ok).toBe(true);
    });

    it('a code used twice is refused the second time AND ends what it issued (RFC 6749 §4.1.2)', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const first = await exchange(c);
      expect(first.ok).toBe(true);
      expect(await exchange(c)).toMatchObject({ ok: false, error: 'invalid_grant' });
      expect(await grantRow(c.grantId)).toMatchObject({ revoke_reason: 'REPLAY' });
    });

    it('concurrent exchanges of one code: exactly one wins, the other is invalid_grant, never a 500', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const results = await Promise.all([exchange(c), exchange(c)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ error: 'invalid_grant' })]);
    });

    it('refuses an expired code', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      await h.admin.query(`UPDATE mcp_oauth_code SET expires_at = now() - interval '1 second'`);
      expect(await exchange(c)).toMatchObject({ ok: false, error: 'invalid_grant' });
    });

    it('refuses a person whose access has been turned off', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      await h.admin.query(`UPDATE app_user SET has_access = false WHERE id = $1`, [h.people[1].id]);
      expect(await exchange(c)).toMatchObject({ ok: false, error: 'invalid_grant' });
    });

    it('an unknown code finds no tenant', async () => {
      expect(
        await svc.exchangeCode({ base: BASE, code: 'nope', codeVerifier: pkce().verifier, clientId: 'x', redirectUri: REDIRECT }),
      ).toMatchObject({ ok: false, error: 'invalid_grant' });
    });
  });

  describe('the refresh_token grant', () => {
    it('rotates: a new refresh token each time, the old one used', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r1 = await exchange(c);
      if (!r1.ok) throw new Error('exchange failed');
      const r2 = await svc.refreshTokens({ base: BASE, refreshToken: r1.body.refresh_token, clientId: c.client.clientId });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.body.refresh_token).not.toBe(r1.body.refresh_token);
      expect(await tokens.verifyAccessToken(BASE, r2.body.access_token)).toMatchObject({ gid: c.grantId });
    });

    it('a used refresh token presented again revokes the grant — and the revocation COMMITS (VeloCRM rolled it back)', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r1 = await exchange(c);
      if (!r1.ok) throw new Error('exchange failed');
      const r2 = await svc.refreshTokens({ base: BASE, refreshToken: r1.body.refresh_token, clientId: c.client.clientId });
      if (!r2.ok) throw new Error('refresh failed');
      const replay = await svc.refreshTokens({ base: BASE, refreshToken: r1.body.refresh_token, clientId: c.client.clientId });
      expect(replay).toMatchObject({ ok: false, error: 'invalid_grant' });
      expect(await grantRow(c.grantId)).toMatchObject({ revoke_reason: 'REPLAY' });
      // The thief's copy and the client's newer one are both dead.
      expect(
        await svc.refreshTokens({ base: BASE, refreshToken: r2.body.refresh_token, clientId: c.client.clientId }),
      ).toMatchObject({ ok: false, error: 'invalid_grant' });
    });

    it('refuses another client presenting the token, and an expired one', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r1 = await exchange(c);
      if (!r1.ok) throw new Error('exchange failed');
      expect(await svc.refreshTokens({ base: BASE, refreshToken: r1.body.refresh_token, clientId: 'someone-else' })).toMatchObject({
        ok: false,
      });
      await h.admin.query(`UPDATE mcp_oauth_refresh_token SET expires_at = now() - interval '1 second'`);
      expect(
        await svc.refreshTokens({ base: BASE, refreshToken: r1.body.refresh_token, clientId: c.client.clientId }),
      ).toMatchObject({ ok: false, error: 'invalid_grant' });
    });
  });

  describe('revocation (RFC 7009)', () => {
    it('a verified access token ends its grant', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r = await exchange(c);
      if (!r.ok) throw new Error('exchange failed');
      await svc.revokeByClient({ base: BASE, token: r.body.access_token, clientId: c.client.clientId });
      expect(await grantRow(c.grantId)).toMatchObject({ revoke_reason: 'CLIENT' });
    });

    it('a refresh token ends its grant, for its own client only', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r = await exchange(c);
      if (!r.ok) throw new Error('exchange failed');
      await svc.revokeByClient({ base: BASE, token: r.body.refresh_token, clientId: 'not-the-owner' });
      expect((await grantRow(c.grantId)).revoked_at).toBeNull();
      await svc.revokeByClient({ base: BASE, token: r.body.refresh_token, clientId: c.client.clientId });
      expect(await grantRow(c.grantId)).toMatchObject({ revoke_reason: 'CLIENT' });
    });

    it('an UNSIGNED token naming a grant revokes nothing (VeloCRM decoded without verifying)', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      await exchange(c);
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const forged = `${enc({ alg: 'none' })}.${enc({ sub: h.people[1].id, tenant_id: h.orgId, gid: c.grantId, client_id: c.client.clientId })}.x`;
      await svc.revokeByClient({ base: BASE, token: forged, clientId: c.client.clientId });
      expect((await grantRow(c.grantId)).revoked_at).toBeNull();
    });
  });

  describe('per tenant', () => {
    it('a grant lives in the consenting person\'s tenant, and its token names that tenant', async () => {
      const c = await connect(orgB, userB);
      const r = await exchange(c);
      if (!r.ok) throw new Error('exchange failed');
      expect((await tokens.verifyAccessToken(BASE, r.body.access_token))?.tenant_id).toBe(orgB);
      const rows = await h.admin.query('SELECT organization_id FROM mcp_oauth_grant WHERE id = $1', [c.grantId]);
      expect(rows.rows[0].organization_id).toBe(orgB);
      // From tenant A, B's grant does not exist.
      const seen = await prisma.withTenantDb(h.orgId, (tx) =>
        svc.liveGrantFor(tx, { gid: c.grantId, sub: userB, client_id: c.client.clientId }),
      );
      expect(seen).toBeNull();
    });

    it('consent refuses a person from another tenant (composite key)', async () => {
      const client = await svc.registerClient({ clientName: 'X', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], responseTypes: ['code'] });
      await expect(
        svc.consent({ organizationId: h.orgId, userId: userB, name: 'B' }, client, ['travel.travel_request'], REDIRECT, pkce().challenge),
      ).rejects.toThrow();
    });
  });

  describe('the per-call guard', () => {
    const guard = async (claims: import('./tokens').AccessClaims, requiredScope: string | null = null) => {
      const { guardOAuthRequest } = await import('@/server/lib/oauthGuard');
      return prisma.withTenantDb(claims.tenant_id, () =>
        guardOAuthRequest(prisma.db, {
          claims,
          ip: '1.2.3.4',
          userAgent: 'Claude',
          operation: 'tools/call',
          toolName: 't',
          requiredScope: requiredScope as never,
          access: 'write',
        }),
      );
    };

    it('passes a live grant with its scopes and logs the call against it', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r = await exchange(c);
      if (!r.ok) throw new Error('exchange failed');
      const claims = (await tokens.verifyAccessToken(BASE, r.body.access_token))!;
      const g = await guard(claims, 'travel.travel_request');
      expect(g).toMatchObject({ ok: true, principal: { grantId: c.grantId, scopes: ['travel.travel_request'] } });
      const log = await h.admin.query('SELECT outcome, oauth_grant_id, api_key_id FROM api_key_request WHERE id = $1', [
        (g as { requestLogId: string }).requestLogId,
      ]);
      expect(log.rows[0]).toEqual({ outcome: 'OK', oauth_grant_id: c.grantId, api_key_id: null });
    });

    it('refuses a tool outside the grant\'s scopes, before anything runs', async () => {
      const c = await connect(h.orgId, h.people[1].id, ['travel.travel_request.readonly']);
      const r = await exchange(c);
      if (!r.ok) throw new Error('exchange failed');
      const claims = (await tokens.verifyAccessToken(BASE, r.body.access_token))!;
      expect(await guard(claims, 'expense_management.expense_approval')).toMatchObject({ ok: false, outcome: 'DENIED_SCOPE' });
      expect(await guard(claims, 'travel.travel_request')).toMatchObject({ ok: false, outcome: 'DENIED_SCOPE' });
    });

    it('a revoked grant stops its access token on the very next call — no blocklist, no Redis', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r = await exchange(c);
      if (!r.ok) throw new Error('exchange failed');
      const claims = (await tokens.verifyAccessToken(BASE, r.body.access_token))!;
      expect((await guard(claims)).ok).toBe(true);
      await prisma.withTenantDb(h.orgId, (tx) => svc.revokeGrant(tx, c.grantId, 'USER', { id: h.people[1].id, name: 'Bob' }));
      expect(await guard(claims)).toMatchObject({ ok: false, outcome: 'REVOKED', status: 401 });
      expect((await h.admin.query('SELECT action FROM audit_entry WHERE entity_id = $1 ORDER BY sequence DESC LIMIT 1', [c.grantId])).rows[0].action).toBe(
        'OAUTH_GRANT_REVOKED',
      );
    });

    it('refuses a token whose claims do not match its grant (another person)', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r = await exchange(c);
      if (!r.ok) throw new Error('exchange failed');
      const claims = (await tokens.verifyAccessToken(BASE, r.body.access_token))!;
      expect(await guard({ ...claims, sub: h.people[0].id })).toMatchObject({ ok: false, outcome: 'REVOKED' });
    });

    it('refuses once the person\'s access is off', async () => {
      const c = await connect(h.orgId, h.people[1].id);
      const r = await exchange(c);
      if (!r.ok) throw new Error('exchange failed');
      const claims = (await tokens.verifyAccessToken(BASE, r.body.access_token))!;
      await h.admin.query(`UPDATE app_user SET has_access = false WHERE id = $1`, [h.people[1].id]);
      expect(await guard(claims)).toMatchObject({ ok: false, outcome: 'SUBJECT_UNKNOWN' });
    });
  });
});
