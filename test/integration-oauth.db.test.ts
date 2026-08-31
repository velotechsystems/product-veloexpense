/**
 * VX3-8 — the OAuth2 machinery, against a real Postgres.
 *
 * Driven through `stub-oauth`, deliberately NOT through QuickBooks. VX3-7's lesson
 * applies twice over here: an assertion that only passes for the adapter the
 * mechanism was written around proves nothing about the mechanism, and the only
 * real OAUTH2 adapter would need a network or a mock of one.
 *
 * What is asserted is the part that would be expensive to get wrong later: the
 * state is a single-use hashed credential, the callback derives its tenant from
 * that state and nothing else, tokens are encrypted at rest, a rotating refresh
 * token is not lost, and the difference between "a human must re-consent" and
 * "try again in a minute" is respected in both directions.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { installIntegration, IntegrationError } from '@/lib/integrations/service';
import {
  beginAuthorisation,
  completeAuthorisation,
  freshAuthConfig,
  purgeStaleAuthorisations,
} from '@/lib/integrations/oauth';
import { stubOAuthControl } from '@/lib/integrations/stub';
import { isEncrypted } from '@/lib/crypto/secrets';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});
const stub = stubOAuthControl();

let orgId: string;
let otherOrgId: string;
let actorId: string;
let installationId: string;

const REDIRECT = 'https://velo.test/api/integrations/stub-oauth/callback';

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    `INSERT INTO organization (slug, name)
     VALUES ('oauth-co','OAuth Co'), ('oauth-co-2','OAuth Co 2') RETURNING id, slug`,
  );
  orgId = o.rows.find((r) => r.slug === 'oauth-co').id;
  otherOrgId = o.rows.find((r) => r.slug === 'oauth-co-2').id;
  for (const [org, email] of [
    [orgId, 'a@oauth.test'],
    [otherOrgId, 'b@oauth.test'],
  ] as const) {
    const u = await withOrg(org, (tx) =>
      tx.query(
        `INSERT INTO app_user (organization_id, email, display_name, role)
         VALUES ($1, $2, 'Admin', 'ADMIN') RETURNING id`,
        [org, email],
      ),
    );
    if (org === orgId) actorId = u.rows[0].id;
  }
});

beforeEach(async () => {
  stub.reset();
  await admin.query('DELETE FROM integration_oauth_state');
  await admin.query('DELETE FROM integration_installation');
  const installed = await withOrg(orgId, (tx) =>
    installIntegration(
      tx,
      { slug: 'stub-oauth', code: 'main', label: 'Stub OAuth', config: {} },
      actorId,
    ),
  );
  installationId = installed.id;
  // `installIntegration` predates VX3-8, so it writes `auth_kind` from the
  // adapter. Asserted rather than assumed, because everything below depends on it.
  const kind = await admin.query(
    'SELECT auth_kind FROM integration_installation WHERE id = $1',
    [installationId],
  );
  expect(kind.rows[0].auth_kind).toBe('OAUTH2');
});

afterAll(async () => {
  await admin.end();
});

/** Pull the plaintext state out of the URL the adapter built. */
function stateFromUrl(url: string): string {
  return new URL(url).searchParams.get('state')!;
}

describe('beginning an authorisation', () => {
  it('stores a HASH of the state, never the value', async () => {
    const { authorizeUrl } = await withOrg(orgId, (tx) =>
      beginAuthorisation(tx, { installationId, actorId, redirectUri: REDIRECT }),
    );
    const state = stateFromUrl(authorizeUrl);
    expect(state.length).toBeGreaterThan(30);

    const rows = await admin.query(
      'SELECT state_hash, redirect_uri, consumed_at FROM integration_oauth_state',
    );
    expect(rows.rows).toHaveLength(1);
    // THE assertion. A database read must not yield a replayable credential —
    // same property `action_token` has, and for the same reason.
    expect(rows.rows[0].state_hash).not.toBe(state);
    expect(rows.rows[0].state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.rows[0].redirect_uri).toBe(REDIRECT);
    expect(rows.rows[0].consumed_at).toBeNull();
  });

  it('refuses an adapter that is not authorised by redirect', async () => {
    const configKind = await withOrg(orgId, (tx) =>
      installIntegration(
        tx,
        {
          slug: 'stub-ledger',
          code: 'pasted',
          label: 'Stub ledger',
          config: { ledgerUrl: 'https://x.test', apiToken: 'tok' },
        },
        actorId,
      ),
    );
    await expect(
      withOrg(orgId, (tx) =>
        beginAuthorisation(tx, {
          installationId: configKind.id,
          actorId,
          redirectUri: REDIRECT,
        }),
      ),
    ).rejects.toThrow(/takes configuration values/);
  });
});

describe('completing an authorisation', () => {
  async function begin() {
    const { authorizeUrl } = await withOrg(orgId, (tx) =>
      beginAuthorisation(tx, { installationId, actorId, redirectUri: REDIRECT }),
    );
    return stateFromUrl(authorizeUrl);
  }

  it('derives the tenant from the state, and stores tokens ENCRYPTED', async () => {
    const state = await begin();
    const result = await completeAuthorisation({
      stateValue: state,
      code: 'good-code',
      callbackParams: { realmId: 'company-42' },
    });
    // The callback had no session: the tenant came from the state row alone.
    expect(result.organizationId).toBe(orgId);
    expect(result.installationId).toBe(installationId);

    const row = (
      await admin.query(
        `SELECT active, oauth_access_token, oauth_refresh_token, external_account_id,
                oauth_scope, oauth_needs_consent, oauth_access_expires_at,
                oauth_refresh_expires_at, connected_by_id
           FROM integration_installation WHERE id = $1`,
        [installationId],
      )
    ).rows[0];

    expect(row.active).toBe(true);
    expect(isEncrypted(row.oauth_access_token)).toBe(true);
    expect(isEncrypted(row.oauth_refresh_token)).toBe(true);
    // Not merely "encrypted" — the plaintext must not appear anywhere in the value.
    expect(row.oauth_access_token).not.toContain('access-1');
    expect(row.external_account_id).toBe('company-42');
    expect(row.oauth_scope).toBe('stub.accounting');
    expect(row.oauth_needs_consent).toBe(false);
    expect(row.oauth_access_expires_at).toBeInstanceOf(Date);
    expect(row.oauth_refresh_expires_at).toBeInstanceOf(Date);
    // Attribution comes from the state row's creator, so the audit of "who
    // connected this" survives a flow that has no session at the callback.
    expect(row.connected_by_id).toBe(actorId);
  });

  it('consumes the state, so a REPLAY fails', async () => {
    const state = await begin();
    await completeAuthorisation({
      stateValue: state,
      code: 'good-code',
      callbackParams: { realmId: 'c1' },
    });
    await expect(
      completeAuthorisation({
        stateValue: state,
        code: 'good-code',
        callbackParams: { realmId: 'attacker-company' },
      }),
    ).rejects.toThrow(/no longer valid|already completed/);
    // And the attacker's company id did NOT land on the row.
    const row = await admin.query(
      'SELECT external_account_id FROM integration_installation WHERE id = $1',
      [installationId],
    );
    expect(row.rows[0].external_account_id).toBe('c1');
  });

  it('consumes the state even when the EXCHANGE fails', async () => {
    // The deliberate ordering: consume first, exchange second. A failed exchange
    // costs the admin one extra click; a replayable state costs an account
    // takeover. This pins the trade so a later "improvement" has to argue with it.
    const state = await begin();
    await expect(
      completeAuthorisation({ stateValue: state, code: 'BAD', callbackParams: {} }),
    ).rejects.toThrow(/refused this code/);

    const stateRow = await admin.query('SELECT consumed_at FROM integration_oauth_state');
    expect(stateRow.rows[0].consumed_at).toBeInstanceOf(Date);
    // And nothing was written to the installation.
    const row = await admin.query(
      'SELECT active, oauth_access_token FROM integration_installation WHERE id = $1',
      [installationId],
    );
    expect(row.rows[0].active).toBe(false);
    expect(row.rows[0].oauth_access_token).toBeNull();
  });

  it('rejects an unknown state, and an EXPIRED one, with the same message', async () => {
    await expect(
      completeAuthorisation({ stateValue: 'never-minted', code: 'c', callbackParams: {} }),
    ).rejects.toThrow(/no longer valid/);

    const state = await begin();
    await admin.query(
      "UPDATE integration_oauth_state SET expires_at = clock_timestamp() - interval '1 second'",
    );
    // Same wording on purpose: distinguishing "unknown" from "expired" tells an
    // attacker whether a state ever existed.
    await expect(
      completeAuthorisation({ stateValue: state, code: 'c', callbackParams: {} }),
    ).rejects.toThrow(/no longer valid/);
  });

  it('two callbacks racing the same state: exactly one wins', async () => {
    const state = await begin();
    const results = await Promise.allSettled([
      completeAuthorisation({ stateValue: state, code: 'good', callbackParams: { realmId: 'a' } }),
      completeAuthorisation({ stateValue: state, code: 'good', callbackParams: { realmId: 'b' } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(stub.counts().exchanges).toBe(1);
  });
});

describe('using and refreshing the token', () => {
  async function authorise() {
    const { authorizeUrl } = await withOrg(orgId, (tx) =>
      beginAuthorisation(tx, { installationId, actorId, redirectUri: REDIRECT }),
    );
    await completeAuthorisation({
      stateValue: stateFromUrl(authorizeUrl),
      code: 'good',
      callbackParams: { realmId: 'c1' },
    });
  }

  it('returns the decrypted token WITHOUT refreshing when it is still fresh', async () => {
    await authorise();
    const config = await withOrg(orgId, (tx) => freshAuthConfig(tx, installationId));
    expect(config.oauthAccessToken).toBe('access-1');
    expect(config.externalAccountId).toBe('c1');
    expect(stub.counts().refreshes).toBe(0);
  });

  it('refreshes when the token is due, and does not lose a ROTATED refresh token', async () => {
    await authorise();
    const before = (
      await admin.query(
        'SELECT oauth_refresh_token, oauth_refresh_expires_at FROM integration_installation WHERE id = $1',
        [installationId],
      )
    ).rows[0];

    // Inside the refresh margin: due, but not yet expired.
    await admin.query(
      `UPDATE integration_installation
          SET oauth_access_expires_at = clock_timestamp() + interval '10 seconds'
        WHERE id = $1`,
      [installationId],
    );

    const config = await withOrg(orgId, (tx) => freshAuthConfig(tx, installationId));
    expect(stub.counts().refreshes).toBe(1);
    expect(config.oauthAccessToken).toBe('access-2');

    const after = (
      await admin.query(
        'SELECT oauth_refresh_token, oauth_refresh_expires_at FROM integration_installation WHERE id = $1',
        [installationId],
      )
    ).rows[0];
    // THE assertion of this test. The far end rotated the refresh token and
    // invalidated the old one, so failing to store the new value would leave a
    // connection that works until the next refresh and then dies.
    expect(after.oauth_refresh_token).not.toBe(before.oauth_refresh_token);
    expect(isEncrypted(after.oauth_refresh_token)).toBe(true);
    // The refresh EXPIRY was absent from that response, so the previous one is
    // kept rather than nulled.
    expect(after.oauth_refresh_expires_at).toEqual(before.oauth_refresh_expires_at);
  });

  it('keeps the existing refresh token when the far end does not rotate', async () => {
    await authorise();
    stub.setRotate(false);
    const before = (
      await admin.query(
        'SELECT oauth_refresh_token FROM integration_installation WHERE id = $1',
        [installationId],
      )
    ).rows[0].oauth_refresh_token;
    await admin.query(
      `UPDATE integration_installation SET oauth_access_expires_at = clock_timestamp()
        WHERE id = $1`,
      [installationId],
    );
    await withOrg(orgId, (tx) => freshAuthConfig(tx, installationId));
    const after = (
      await admin.query(
        'SELECT oauth_refresh_token FROM integration_installation WHERE id = $1',
        [installationId],
      )
    ).rows[0].oauth_refresh_token;
    // `undefined` means "keep what we have", not "there is none".
    expect(after).toBe(before);
  });

  it('a refresh that NEEDS CONSENT deactivates and flags, and says so', async () => {
    await authorise();
    stub.nextRefresh('needs-consent');
    await admin.query(
      `UPDATE integration_installation SET oauth_access_expires_at = clock_timestamp()
        WHERE id = $1`,
      [installationId],
    );
    await expect(
      withOrg(orgId, (tx) => freshAuthConfig(tx, installationId)),
    ).rejects.toThrow(/revoked/);

    const row = (
      await admin.query(
        'SELECT active, oauth_needs_consent FROM integration_installation WHERE id = $1',
        [installationId],
      )
    ).rows[0];
    // Deactivated, because an active connection that cannot authenticate keeps
    // being chosen by resolveCapability and fails every report behind it.
    expect(row.active).toBe(false);
    expect(row.oauth_needs_consent).toBe(true);

    // And a subsequent call refuses immediately rather than hammering the far end.
    await expect(
      withOrg(orgId, (tx) => freshAuthConfig(tx, installationId)),
    ).rejects.toThrow(/needs authorising again/);
    expect(stub.counts().refreshes).toBe(1);
  });

  it('a TRANSIENT refresh failure leaves the connection alone', async () => {
    // The other half, and the one that is easy to get wrong: marking a working
    // connection dead because the network blipped would make an admin
    // re-authorise for nothing. Same distinction as AC-17, one layer down.
    await authorise();
    stub.nextRefresh('transient');
    await admin.query(
      `UPDATE integration_installation SET oauth_access_expires_at = clock_timestamp()
        WHERE id = $1`,
      [installationId],
    );
    await expect(
      withOrg(orgId, (tx) => freshAuthConfig(tx, installationId)),
    ).rejects.toThrow(/could not be reached/);

    const row = (
      await admin.query(
        'SELECT active, oauth_needs_consent FROM integration_installation WHERE id = $1',
        [installationId],
      )
    ).rows[0];
    expect(row.active).toBe(true);
    expect(row.oauth_needs_consent).toBe(false);
  });

  it('returns nothing for a CONFIG adapter, so one code path serves both', async () => {
    const configKind = await withOrg(orgId, (tx) =>
      installIntegration(
        tx,
        {
          slug: 'stub-ledger',
          code: 'pasted',
          label: 'Stub ledger',
          config: { ledgerUrl: 'https://x.test', apiToken: 'tok' },
        },
        actorId,
      ),
    );
    const config = await withOrg(orgId, (tx) => freshAuthConfig(tx, configKind.id));
    expect(config).toEqual({});
  });
});

describe('the state table is tenant-isolated and self-cleaning', () => {
  it('one tenant cannot see another tenant\'s authorisation attempts', async () => {
    await withOrg(orgId, (tx) =>
      beginAuthorisation(tx, { installationId, actorId, redirectUri: REDIRECT }),
    );
    const mine = await withOrg(orgId, (tx) =>
      tx.query('SELECT id FROM integration_oauth_state'),
    );
    expect(mine.rows).toHaveLength(1);
    const theirs = await withOrg(otherOrgId, (tx) =>
      tx.query('SELECT id FROM integration_oauth_state'),
    );
    expect(theirs.rows).toHaveLength(0);
  });

  it('purges consumed and expired attempts, and nothing else', async () => {
    const live = await withOrg(orgId, (tx) =>
      beginAuthorisation(tx, { installationId, actorId, redirectUri: REDIRECT }),
    );
    expect(live.authorizeUrl).toContain('state=');
    // One consumed and one expired, both aged past the window.
    await admin.query(
      `INSERT INTO integration_oauth_state
           (organization_id, installation_id, state_hash, redirect_uri, expires_at,
            consumed_at, created_by_id, created_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + interval '5 min',
               clock_timestamp(), $5, clock_timestamp() - interval '48 hours'),
              ($1, $2, $6, $4, clock_timestamp() - interval '1 hour',
               NULL, $5, clock_timestamp() - interval '48 hours')`,
      [orgId, installationId, 'c'.repeat(64), REDIRECT, actorId, 'd'.repeat(64)],
    );
    const removed = await withOrg(orgId, (tx) => purgeStaleAuthorisations(tx, 24));
    expect(removed).toBe(2);
    const left = await withOrg(orgId, (tx) =>
      tx.query('SELECT consumed_at, expires_at FROM integration_oauth_state'),
    );
    // The live one survives: purging an in-flight authorisation would break a
    // consent the admin is halfway through.
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0].consumed_at).toBeNull();
  });
});

describe('an adapter with unmet prerequisites is invisible', () => {
  it('QuickBooks is not offered until the platform has credentials', async () => {
    // The whole "ready to connect later" mechanism, asserted rather than trusted.
    // Imported lazily so the env change below is read at CALL time (NT-14).
    const { listAdapters } = await import('@/lib/integrations/registry');
    const slugs = () => listAdapters().map((a) => a.slug);

    delete process.env.QUICKBOOKS_CLIENT_ID;
    delete process.env.QUICKBOOKS_CLIENT_SECRET;
    expect(slugs()).not.toContain('quickbooks');

    process.env.QUICKBOOKS_CLIENT_ID = 'id';
    process.env.QUICKBOOKS_CLIENT_SECRET = 'secret';
    expect(slugs()).toContain('quickbooks');

    delete process.env.QUICKBOOKS_CLIENT_ID;
    delete process.env.QUICKBOOKS_CLIENT_SECRET;
    expect(slugs()).not.toContain('quickbooks');
  });

  it('and cannot be installed while it is invisible', async () => {
    delete process.env.QUICKBOOKS_CLIENT_ID;
    await expect(
      withOrg(orgId, (tx) =>
        installIntegration(
          tx,
          { slug: 'quickbooks', code: 'qb', label: 'QB', config: {} },
          actorId,
        ),
      ),
    ).rejects.toThrow(IntegrationError);
  });
});
