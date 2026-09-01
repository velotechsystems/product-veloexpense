/**
 * VX3-8 — the OAuth2 half of the integration registry.
 *
 * Core owns everything generic and everything security-sensitive here; an adapter
 * contributes three small vendor-shaped functions (`authorizeUrl`,
 * `exchangeCode`, `refreshTokens`) and never touches state, storage or encryption.
 * That split is why an adapter author cannot get the dangerous part wrong.
 *
 * ── The three things this file is careful about ──────────────────────────────
 *
 * 1. THE STATE IS A CREDENTIAL. Anyone who can replay a state value can attach
 *    their own far-end account to somebody else's installation. So it is minted
 *    from `randomBytes`, only its sha256 is stored (`0020`, same reasoning as
 *    `action_token` in `0012`), it is single-use, and it expires in minutes.
 *
 * 2. THE CALLBACK HAS NO SESSION. It arrives from the far end with a code and a
 *    state and nothing else — no cookie, no tenant. So the tenant is DERIVED from
 *    the state row, through `0020`'s narrow `platform_read` policy which matches
 *    only unconsumed, unexpired states. A replayed or stale callback finds no row,
 *    which makes "reject it" an absence rather than an `if` somebody has to
 *    remember to write. Every subsequent write happens inside `withOrg` for the
 *    tenant that row named.
 *
 * 3. A REFRESH TOKEN THAT ROTATES MUST NOT BE LOST. QuickBooks returns a new
 *    refresh token and invalidates the old one, so the write that stores it is the
 *    difference between a working connection and a dead one. It happens in ONE
 *    statement with the flag-clearing, and a failure leaves the previous token in
 *    place rather than a half-updated row.
 */
import { createHash, randomBytes } from 'node:crypto';
import { withOrg, withPlatformRead } from '@/lib/tenant/context';
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets';
import { adapterFor } from '@/lib/integrations/registry';
import { IntegrationError } from '@/lib/integrations/errors';
import { findCapabilityRival, rivalMessage } from '@/lib/integrations/conflicts';
import { requeueWaitingPosts } from '@/lib/integrations/post-outbox';
import { OAuthConsentRequired, type AdapterConfig } from '@/lib/integrations/contract';
import type { QueryRunner } from '@/lib/db/client';

const ORG = "current_setting('app.current_org', true)::uuid";

/**
 * How long an admin has to finish consenting. Ten minutes: long enough to read a
 * consent screen and pick a company, short enough that an abandoned attempt is not
 * a credential lying around. Same spirit as VX2-8's approve-link TTL, three orders
 * of magnitude shorter because this one is a single click away.
 */
export const STATE_TTL_SECONDS = 600;

/**
 * Refresh this long BEFORE the access token actually expires.
 *
 * Not zero, on purpose. A token that expires while a post is in flight fails a
 * report for no reason, and clock skew between us and the far end is real. Sixty
 * seconds of margin costs one extra refresh occasionally.
 */
export const REFRESH_MARGIN_SECONDS = 60;

function hashState(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface BeginResult {
  /** Where to send the admin's browser. */
  authorizeUrl: string;
}

/**
 * Start an authorisation. Called from a tenant-scoped action, so `tx` is already
 * inside `withOrg` and RLS scopes every read below.
 */
export async function beginAuthorisation(
  tx: QueryRunner,
  input: { installationId: string; actorId: string; redirectUri: string },
): Promise<BeginResult> {
  const r = await tx.query(
    `SELECT id, integration_slug, auth_kind, config
       FROM integration_installation WHERE id = $1`,
    [input.installationId],
  );
  if (r.rows.length === 0) throw new IntegrationError('no such connection', 'NOT_FOUND');
  const row = r.rows[0] as { integration_slug: string; auth_kind: string; config: unknown };

  const adapter = adapterFor(row.integration_slug);
  if (!adapter) {
    throw new IntegrationError(
      `this connection names '${row.integration_slug}', which this build does not have`,
      'UNKNOWN_ADAPTER',
    );
  }
  if (adapter.auth !== 'OAUTH2' || !adapter.authorizeUrl) {
    throw new IntegrationError(
      `${adapter.name} is not connected by authorisation — it takes configuration values`,
      'NOT_OAUTH',
    );
  }

  // AC-22, checked BEFORE the browser leaves. Sending an admin to a far end to
  // consent to something this end will refuse on the way back is the worst place
  // to discover a configuration conflict: they have granted a real permission to a
  // connection that will not be activated.
  const rival = await findCapabilityRival(tx, adapter, input.installationId);
  if (rival) throw new IntegrationError(rivalMessage(adapter, rival), 'AMBIGUOUS_CAPABILITY');

  // Fresh secret per attempt. 32 bytes base64url: not guessable, and short enough
  // to survive every URL length limit in the chain.
  const state = randomBytes(32).toString('base64url');

  await tx.query(
    `INSERT INTO integration_oauth_state
         (organization_id, installation_id, state_hash, redirect_uri, expires_at, created_by_id)
     VALUES (${ORG}, $1, $2, $3, clock_timestamp() + ($4 || ' seconds')::interval, $5)`,
    [input.installationId, hashState(state), input.redirectUri, String(STATE_TTL_SECONDS), input.actorId],
  );

  return {
    authorizeUrl: adapter.authorizeUrl({
      config: (row.config ?? {}) as AdapterConfig,
      state,
      redirectUri: input.redirectUri,
    }),
  };
}

export interface CompleteResult {
  organizationId: string;
  installationId: string;
  adapterName: string;
}

/**
 * Finish an authorisation, from the callback route.
 *
 * Owns its own transactions rather than taking a `tx`, because the caller has no
 * tenant to open one for — establishing which tenant this is is the FIRST thing
 * this function does.
 *
 * The token exchange happens OUTSIDE any transaction. Same rule as VX3-4's
 * dispatch: never hold a database transaction open across a network call to
 * somebody else's system.
 */
export async function completeAuthorisation(input: {
  stateValue: string;
  code: string;
  callbackParams: Record<string, string>;
}): Promise<CompleteResult> {
  // 1. Who is this? Read through the narrow platform hatch — which matches only
  //    unconsumed, unexpired states, so a replay finds nothing here.
  //
  //    THE STATE ROW ALONE, and the first version of this joined
  //    `integration_installation` to fetch the slug in one query. That returned
  //    NOTHING, every time, and the reason is the hatch working as designed:
  //    `0020` gives `platform_read` to this table and to no other, so a join
  //    reaches a table where the tenant context is unset and RLS filters
  //    everything. A test is what caught it; the lesson is that the hatch is
  //    exactly one table wide and reads that need more must first learn the
  //    tenant and then use `withOrg`.
  const found = await withPlatformRead((tx) =>
    tx.query(
      `SELECT id, organization_id, installation_id, redirect_uri
         FROM integration_oauth_state
        WHERE state_hash = $1`,
      [hashState(input.stateValue)],
    ),
  );
  if (found.rows.length === 0) {
    // Deliberately one message for all three causes — unknown, already used,
    // expired. Telling a caller which one it was tells an attacker whether a
    // state existed.
    throw new IntegrationError(
      'this authorisation link is no longer valid. Start the connection again from ' +
        'the integrations screen.',
      'STATE_INVALID',
    );
  }
  const state = found.rows[0] as {
    id: string;
    organization_id: string;
    installation_id: string;
    redirect_uri: string;
  };

  // 2. Inside the tenant now: read the installation and CLAIM the state, in one
  //    transaction.
  //
  //    Consuming BEFORE the exchange is deliberate and this is the safe direction.
  //    A code that fails to exchange cannot then be retried on the same state, so
  //    the admin starts again — one extra click. Exchanging first would leave a
  //    window in which the same state could be replayed with a different code, and
  //    the cost of that is somebody else's account attached to this installation.
  //    One click against an account takeover is not a close call.
  const claimed = await withOrg(state.organization_id, async (tx) => {
    const inst = await tx.query(
      'SELECT integration_slug, config FROM integration_installation WHERE id = $1',
      [state.installation_id],
    );
    const updated = await tx.query(
      `UPDATE integration_oauth_state
          SET consumed_at = clock_timestamp()
        WHERE id = $1 AND consumed_at IS NULL`,
      [state.id],
    );
    return { inst: inst.rows[0] as { integration_slug: string; config: unknown } | undefined, rowCount: updated.rowCount };
  });

  if (claimed.rowCount !== 1) {
    // The atomic-claim idiom, seventh use in this codebase: two callbacks arriving
    // together, and exactly one may proceed.
    throw new IntegrationError('this authorisation was already completed', 'STATE_INVALID');
  }
  if (!claimed.inst) {
    throw new IntegrationError('the connection this authorisation belongs to is gone', 'NOT_FOUND');
  }

  const adapter = adapterFor(claimed.inst.integration_slug);
  if (!adapter?.exchangeCode) {
    throw new IntegrationError(
      `this connection names '${claimed.inst.integration_slug}', which this build cannot authorise`,
      'UNKNOWN_ADAPTER',
    );
  }

  // 3. The network call, outside any transaction — VX3-4's rule: never hold one
  //    open across a request to somebody else's system.
  const tokens = await adapter.exchangeCode({
    config: (claimed.inst.config ?? {}) as AdapterConfig,
    code: input.code,
    redirectUri: state.redirect_uri,
    callbackParams: input.callbackParams,
  });

  // 4. Store it. `active = true` and the refresh token land together, which is
  //    what `0020`'s `oauth_complete` CHECK requires.
  await withOrg(state.organization_id, async (tx) => {
    await tx.query(
      `UPDATE integration_installation
          SET oauth_access_token       = $2,
              oauth_refresh_token      = COALESCE($3, oauth_refresh_token),
              oauth_access_expires_at  = CASE WHEN $4::int IS NULL THEN NULL
                                         ELSE clock_timestamp() + ($4 || ' seconds')::interval END,
              oauth_refresh_expires_at = CASE WHEN $5::int IS NULL THEN NULL
                                         ELSE clock_timestamp() + ($5 || ' seconds')::interval END,
              external_account_id      = COALESCE($6, external_account_id),
              oauth_scope              = COALESCE($7, oauth_scope),
              oauth_needs_consent      = false,
              oauth_authorised_at      = clock_timestamp(),
              active                   = true,
              connected_at             = COALESCE(connected_at, clock_timestamp()),
              connected_by_id          = COALESCE(connected_by_id, (
                  SELECT created_by_id FROM integration_oauth_state WHERE id = $8
              )),
              updated_at               = clock_timestamp()
        WHERE id = $1`,
      [
        state.installation_id,
        encryptSecret(tokens.accessToken),
        tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
        tokens.expiresInSeconds ?? null,
        tokens.refreshExpiresInSeconds ?? null,
        tokens.externalAccountId ?? null,
        tokens.scope ?? null,
        state.id,
      ],
    );

    // AC-24. This installation has just become able to post, and the tenant's
    // approvals from before the authorisation were each skipped with an hour's
    // backoff. Same transaction as the activation.
    //
    // This caller is why the nudge moved out of the Modules screen's action: an
    // OAuth callback never touches that code, so an edge-placed hook would have
    // missed the one path where the wait is longest — the admin has just come back
    // from a far end and is watching the screen.
    await requeueWaitingPosts(tx);
  });

  return {
    organizationId: state.organization_id,
    installationId: state.installation_id,
    adapterName: adapter.name,
  };
}

/**
 * The OAuth fields a capability call needs, decrypted, refreshed if due.
 *
 * Returns them in `AdapterConfig` shape so an adapter reads `config.
 * oauthAccessToken` alongside its own fields and needs no second argument — which
 * keeps `postExpenseReport`'s signature the same for both auth kinds.
 */
export async function freshAuthConfig(
  tx: QueryRunner,
  installationId: string,
): Promise<AdapterConfig> {
  const r = await tx.query(
    `SELECT organization_id, integration_slug, auth_kind, config, external_account_id,
            oauth_access_token, oauth_refresh_token, oauth_needs_consent,
            oauth_access_expires_at,
            (oauth_access_expires_at IS NOT NULL
             AND oauth_access_expires_at <= clock_timestamp() + ($2 || ' seconds')::interval)
              AS due_for_refresh
       FROM integration_installation WHERE id = $1`,
    [installationId, String(REFRESH_MARGIN_SECONDS)],
  );
  if (r.rows.length === 0) throw new IntegrationError('no such connection', 'NOT_FOUND');
  const row = r.rows[0] as Record<string, unknown>;
  if (row.auth_kind !== 'OAUTH2') return {};

  if (row.oauth_needs_consent === true) {
    throw new IntegrationError(
      'this connection needs authorising again — somebody with access to the ' +
        'accounting system has to sign in and approve it.',
      'NEEDS_CONSENT',
    );
  }

  const out: AdapterConfig = {};
  if (typeof row.external_account_id === 'string') {
    out.externalAccountId = row.external_account_id;
  }

  if (!row.due_for_refresh && typeof row.oauth_access_token === 'string') {
    out.oauthAccessToken = decryptSecret(row.oauth_access_token);
    return out;
  }

  // Due (or missing) — refresh. Note this is a NETWORK CALL made while `tx` is
  // open, which the dispatch rule says to avoid; it is accepted here because the
  // alternative is threading a refresh through every caller, and a token refresh
  // is a single fast request to an endpoint that exists to serve them. If it ever
  // shows up as lock contention, the fix is to refresh before opening the
  // transaction rather than to make this cleverer.
  const slug = row.integration_slug as string;
  const adapter = adapterFor(slug);
  if (!adapter?.refreshTokens) {
    throw new IntegrationError(
      `this connection names '${slug}', which this build cannot refresh`,
      'UNKNOWN_ADAPTER',
    );
  }
  if (typeof row.oauth_refresh_token !== 'string') {
    throw new IntegrationError(
      'this connection has no refresh token, so it cannot be renewed. Authorise it again.',
      'NEEDS_CONSENT',
    );
  }

  let tokens;
  try {
    tokens = await adapter.refreshTokens({
      config: (row.config ?? {}) as AdapterConfig,
      refreshToken: decryptSecret(row.oauth_refresh_token),
    });
  } catch (err) {
    if (err instanceof OAuthConsentRequired) {
      // Only a human can fix this, so record it — and DEACTIVATE, because an
      // active connection that cannot authenticate would keep being selected by
      // `resolveCapability` and fail every report behind it.
      //
      // ── IN ITS OWN TRANSACTION, and the first version was not ──────────────
      //
      // Writing this on `tx` and then throwing meant the throw ROLLED THE WRITE
      // BACK. The flag never persisted, so nothing was ever recorded, no admin was
      // ever told, and every subsequent post would have called the far end again
      // to be refused again — forever, silently. A test asserting `active` is
      // false afterwards is what caught it; nothing about the code looked wrong.
      //
      // Same shape as VX3-4's `markNeedsReview`, which records a permanent failure
      // on a connection of its own for exactly this reason: a fact you are about to
      // throw over cannot be written in the transaction you are abandoning.
      await withOrg(row.organization_id as string, (own) =>
        own.query(
          `UPDATE integration_installation
              SET oauth_needs_consent = true, active = false, updated_at = clock_timestamp()
            WHERE id = $1`,
          [installationId],
        ),
      );
      throw new IntegrationError(err.message, 'NEEDS_CONSENT');
    }
    // Anything else is ambiguous or transient. Leave the row alone so the next
    // attempt tries again — nagging an admin to re-authorise because of a network
    // blip is the mistake this branch exists to avoid.
    throw err;
  }

  await tx.query(
    `UPDATE integration_installation
        SET oauth_access_token      = $2,
            oauth_refresh_token     = COALESCE($3, oauth_refresh_token),
            oauth_access_expires_at = CASE WHEN $4::int IS NULL THEN NULL
                                      ELSE clock_timestamp() + ($4 || ' seconds')::interval END,
            oauth_refresh_expires_at = CASE WHEN $5::int IS NULL THEN oauth_refresh_expires_at
                                       ELSE clock_timestamp() + ($5 || ' seconds')::interval END,
            oauth_needs_consent     = false,
            updated_at              = clock_timestamp()
      WHERE id = $1`,
    [
      installationId,
      encryptSecret(tokens.accessToken),
      tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      tokens.expiresInSeconds ?? null,
      tokens.refreshExpiresInSeconds ?? null,
    ],
  );

  out.oauthAccessToken = tokens.accessToken;
  return out;
}

/**
 * Housekeeping: drop state rows that are consumed or long expired.
 *
 * Not wired to a schedule — there is no scheduler in this product yet (NT-19's
 * outbox is polled, not cron'd). Exported so the audit-retention ticket that
 * eventually owns purging has one less thing to design, and so a test can prove
 * it only removes what it should.
 */
export async function purgeStaleAuthorisations(
  tx: QueryRunner,
  olderThanHours = 24,
): Promise<number> {
  const r = await tx.query(
    `DELETE FROM integration_oauth_state
      WHERE (consumed_at IS NOT NULL OR expires_at < clock_timestamp())
        AND created_at < clock_timestamp() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
  return r.rowCount ?? 0;
}
