/**
 * VX3-3 — per-tenant integration installations, against a real Postgres.
 *
 * Own org slug ('integ-co'). `INTEGRATIONS_ENABLE_STUB` is set BEFORE the registry
 * is imported, because the registry decides what exists at module load — see the
 * note there on why that read is deliberate.
 *
 * ── The tests worth reading ─────────────────────────────────────────────────
 *
 * `resolves by capability` is the ticket's whole point. Core asks "who can post an
 * expense report for this tenant" and never "is this tenant on QuickBooks" —
 * GAP-AUDIT AC-5, where ExpenseOS declares capabilities, validates the strings at
 * boot, and then gates on a vendor slug so the taxonomy means nothing.
 *
 * `a second active installation is refused` is AC-3: theirs resolves with
 * `take: 1` and no ordering, so two active installations of one type pick
 * arbitrarily and nothing notices.
 *
 * `a secret is never returned` and `disconnect destroys the credential` are the
 * two that would fail silently if they regressed.
 */
process.env.INTEGRATIONS_ENABLE_STUB = '1';
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 3).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as integrations from '@/lib/integrations/service';
import { adaptersWithCapability, listAdapters } from '@/lib/integrations/registry';
import { stubControl, stubOAuthAdapter } from '@/lib/integrations/stub';
import { findCapabilityRival } from '@/lib/integrations/conflicts';
import { isEncrypted } from '@/lib/crypto/secrets';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let otherOrgId: string;
let actorId: string;
const stub = stubControl();

const CONFIG = { ledgerUrl: 'https://ledger.test', apiToken: 'super-secret-token' };

async function connect(code = 'main', config = CONFIG) {
  return withOrg(orgId, (tx) =>
    integrations.installIntegration(
      tx,
      { slug: 'stub-ledger', code, label: 'Stub', config },
      actorId,
    ),
  );
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('integ-co','Integ Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  const other = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('integ-other','Other') RETURNING id",
  );
  otherOrgId = other.rows[0].id;
  const u = await admin.query(
    "INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'a@integ.test','Ada') RETURNING id",
    [orgId],
  );
  actorId = u.rows[0].id;

  // VX4-1: ABSENCE MEANS OFF, so a suite that exercises accounting has to entitle
  // its tenants — the same row `scripts/seed.mjs` writes for the demo orgs. Every
  // org this file created, because the TRUNCATE above means these are the only ones.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled)
     SELECT id, 'accounting', true FROM organization
     ON CONFLICT (organization_id, module_code) DO NOTHING`,
  );
});

beforeEach(async () => {
  await admin.query('DELETE FROM integration_installation');
  stub.reset();
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('the registry', () => {
  it('has the stub adapter, and it declares what it implements', () => {
    expect(listAdapters().map((a) => a.slug)).toContain('stub-ledger');
    expect(adaptersWithCapability('POST_EXPENSE_REPORT').map((a) => a.slug)).toContain(
      'stub-ledger',
    );
    // The pairing guard runs at import; if it were broken this file would not load.
    expect(adaptersWithCapability('READ_PAYMENT_STATUS')).not.toEqual([]);
  });
});

describe('connecting', () => {
  it('stores the config with the secret ENCRYPTED and never returns it', async () => {
    const installed = await connect();
    expect(installed.config.ledgerUrl).toBe('https://ledger.test');
    // Blanked on the way out, and named as set so a screen can say so.
    expect(installed.config.apiToken).toBe('');
    expect(installed.secretsSet).toEqual(['apiToken']);

    // And on disk it is neither the plaintext nor readable as one.
    const raw = await admin.query('SELECT config FROM integration_installation LIMIT 1');
    const stored = raw.rows[0].config.apiToken as string;
    expect(stored).not.toContain('super-secret-token');
    expect(isEncrypted(stored)).toBe(true);
  });

  it('refuses an unknown adapter slug', async () => {
    await expect(
      withOrg(orgId, (tx) =>
        integrations.installIntegration(
          tx,
          { slug: 'netsuite', code: 'ns', label: 'NS', config: {} },
          actorId,
        ),
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_ADAPTER' });
  });

  it('refuses a missing required field, naming it', async () => {
    await expect(
      withOrg(orgId, (tx) =>
        integrations.installIntegration(
          tx,
          { slug: 'stub-ledger', code: 'x', label: 'X', config: { ledgerUrl: 'https://x.test' } },
          actorId,
        ),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_FIELD' });
  });

  it('refuses a SECOND ACTIVE installation of the same integration — AC-3', async () => {
    await connect('main');
    await expect(connect('second')).rejects.toMatchObject({ code: 'ALREADY_ACTIVE' });
  });

  it('records who connected it and when', async () => {
    const installed = await connect();
    expect(installed.connected_by_name).toBe('Ada');
    expect(installed.connected_at).toBeInstanceOf(Date);
  });
});

describe('editing', () => {
  it('a blank secret means UNCHANGED, not cleared', async () => {
    const installed = await connect();
    await withOrg(orgId, (tx) =>
      integrations.updateInstallation(tx, installed.id, {
        config: { ledgerUrl: 'https://moved.test', apiToken: '' },
      }),
    );
    const after = await withOrg(orgId, (tx) => integrations.getInstallation(tx, installed.id));
    expect(after?.config.ledgerUrl).toBe('https://moved.test');
    expect(after?.secretsSet).toEqual(['apiToken']);
    // Still usable, which is the property that matters: the screen cannot re-show
    // a secret, so a blank submit must not silently break the connection.
    const result = await withOrg(orgId, (tx) => integrations.testInstallation(tx, installed.id));
    expect(result.ok).toBe(true);
  });

  it('a re-entered secret replaces the old one', async () => {
    const installed = await connect();
    const before = await admin.query('SELECT config FROM integration_installation LIMIT 1');
    await withOrg(orgId, (tx) =>
      integrations.updateInstallation(tx, installed.id, {
        config: { ledgerUrl: CONFIG.ledgerUrl, apiToken: 'rotated' },
      }),
    );
    const after = await admin.query('SELECT config FROM integration_installation LIMIT 1');
    expect(after.rows[0].config.apiToken).not.toBe(before.rows[0].config.apiToken);
    const resolved = await withOrg(orgId, (tx) =>
      integrations.resolveCapability(tx, 'POST_EXPENSE_REPORT'),
    );
    expect(resolved?.config.apiToken).toBe('rotated');
  });
});

describe('testing the connection', () => {
  it('records a success', async () => {
    const installed = await connect();
    const result = await withOrg(orgId, (tx) => integrations.testInstallation(tx, installed.id));
    expect(result.ok).toBe(true);
    const after = await withOrg(orgId, (tx) => integrations.getInstallation(tx, installed.id));
    expect(after?.last_test_ok).toBe(true);
    expect(after?.last_test_error).toBeNull();
  });

  it('turns a THROWN adapter into a failed test, not a failed request', async () => {
    const installed = await connect();
    stub.failNext('the ledger refused the token');
    const result = await withOrg(orgId, (tx) => integrations.testInstallation(tx, installed.id));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/refused the token/);
    const after = await withOrg(orgId, (tx) => integrations.getInstallation(tx, installed.id));
    expect(after?.last_test_ok).toBe(false);
    expect(after?.last_test_error).toMatch(/refused the token/);
  });
});

describe('resolving by capability', () => {
  it('finds the adapter for a capability, with a usable config', async () => {
    await connect();
    const resolved = await withOrg(orgId, (tx) =>
      integrations.resolveCapability(tx, 'POST_EXPENSE_REPORT'),
    );
    expect(resolved?.adapter.slug).toBe('stub-ledger');
    // DECRYPTED here — this is the one place a credential is in the clear.
    expect(resolved?.config.apiToken).toBe('super-secret-token');
  });

  it('returns null when nothing is connected, and that is not an error', async () => {
    const resolved = await withOrg(orgId, (tx) =>
      integrations.resolveCapability(tx, 'POST_EXPENSE_REPORT'),
    );
    expect(resolved).toBeNull();
  });

  it('requireCapability throws where resolve returns null', async () => {
    await expect(
      withOrg(orgId, (tx) => integrations.requireCapability(tx, 'POST_EXPENSE_REPORT')),
    ).rejects.toMatchObject({ code: 'NO_CAPABILITY' });
  });

  it('does not resolve a DISCONNECTED installation', async () => {
    const installed = await connect();
    await withOrg(orgId, (tx) => integrations.disconnect(tx, installed.id));
    expect(
      await withOrg(orgId, (tx) => integrations.resolveCapability(tx, 'POST_EXPENSE_REPORT')),
    ).toBeNull();
  });

  it('does not see ANOTHER TENANT\'s connection', async () => {
    await connect();
    const resolved = await withOrg(otherOrgId, (tx) =>
      integrations.resolveCapability(tx, 'POST_EXPENSE_REPORT'),
    );
    expect(resolved).toBeNull();
    expect(await withOrg(otherOrgId, (tx) => integrations.listInstallations(tx))).toEqual([]);
  });
});

describe('disconnecting', () => {
  it('DESTROYS the credential and keeps the row', async () => {
    const installed = await connect();
    await withOrg(orgId, (tx) => integrations.disconnect(tx, installed.id));
    const after = await withOrg(orgId, (tx) => integrations.getInstallation(tx, installed.id));
    expect(after).not.toBeNull();
    expect(after?.active).toBe(false);
    expect(after?.secretsSet).toEqual([]);
    // Non-secret config survives, so a reconnect does not start from nothing.
    expect(after?.config.ledgerUrl).toBe('https://ledger.test');
    // And it is gone from the row, not merely blanked on the way out.
    const raw = await admin.query('SELECT config FROM integration_installation LIMIT 1');
    expect(raw.rows[0].config.apiToken).toBeUndefined();
  });

  it('frees the slot, so the same integration can be reconnected under a NEW code', async () => {
    const installed = await connect('main');
    await withOrg(orgId, (tx) => integrations.disconnect(tx, installed.id));
    await expect(connect('again')).resolves.toMatchObject({ active: true });
  });

  /**
   * AC-20, and the test above is why it survived six phases.
   *
   * "The same integration can be reconnected" was asserted with a DIFFERENT code
   * ('again' rather than 'main') — the one path that worked. The screen has no
   * code input at all: `connectFromForm` sends the slug, every time. So the only
   * reconnect a real admin can perform was the one nothing exercised, and it was
   * impossible: `UNIQUE (organization_id, code)` is not partial, so it collided
   * with the row the disconnect left and failed with DUPLICATE_CODE — naming a
   * value the admin never chose, on a screen whose other error says "Disconnect
   * it first". One disconnect, and that integration was gone for good.
   *
   * The same shape as AC-17 and AC-19: a test that looks like coverage of a
   * behaviour, standing next to the case that does not work.
   */
  it('reconnects UNDER THE SAME CODE, reactivating the same row — AC-20', async () => {
    const first = await connect('main');
    await withOrg(orgId, (tx) => integrations.testInstallation(tx, first.id));
    await withOrg(orgId, (tx) => integrations.disconnect(tx, first.id));

    const again = await connect('main', { ...CONFIG, apiToken: 'a-new-token' });

    // THE SAME ROW, not a second one — which is what keeps `integration_post`'s
    // `installation_id` pointing at the connection those reports were sent to.
    expect(again.id).toBe(first.id);
    expect(again.active).toBe(true);
    const rows = await admin.query('SELECT count(*)::int AS n FROM integration_installation');
    expect(rows.rows[0].n).toBe(1);

    // The new credential is in force, and the old test result is gone: a "worked"
    // stamp belongs to the credential that earned it.
    expect(again.last_test_at).toBeNull();
    const resolved = await withOrg(orgId, (tx) =>
      integrations.resolveCapability(tx, 'POST_EXPENSE_REPORT'),
    );
    expect(resolved?.config.apiToken).toBe('a-new-token');
  });

  it('will not let a DIFFERENT integration take over the code', async () => {
    // The code identifies a connection, not a product. Reactivating someone
    // else's row would rewrite its history rather than reconnect it.
    const installed = await connect('main');
    await withOrg(orgId, (tx) => integrations.disconnect(tx, installed.id));
    await expect(
      withOrg(orgId, (tx) =>
        integrations.installIntegration(
          tx,
          { slug: 'stub-oauth', code: 'main', label: 'Other', config: {} },
          actorId,
        ),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_CODE' });
  });

  it('says ALREADY_ACTIVE, not DUPLICATE_CODE, when it is simply still connected', async () => {
    // Same code, still active. The old code path reached this through the unique
    // violation and said "the code 'main' is already used here", which is true and
    // useless — it describes a constraint, not the situation.
    await connect('main');
    await expect(connect('main')).rejects.toMatchObject({ code: 'ALREADY_ACTIVE' });
  });
});

describe('two adapters claiming one capability (AC-22)', () => {
  /**
   * `0016` guarantees one ACTIVE installation per INTEGRATION. It does NOT stop a
   * VeloLedger and a QuickBooks both being active while both declare
   * POST_EXPENSE_REPORT — and `resolveCapability` read the active rows with no
   * ORDER BY and returned the first one it liked, which is physical heap order and
   * moves whenever a row is updated. Which ledger a tenant's approved reports were
   * drafted into was therefore unstable, and nothing said so.
   *
   * That is AC-3, the finding this audit opened against ExpenseOS, reproduced one
   * level up: fixed per vendor, missed per capability.
   *
   * Driven with the two stubs because they are the only pair of adapters in this
   * build that both claim a capability — which is also why no test could reach the
   * state before: in a deployed build VeloLedger is the only one, because
   * QuickBooks is dormant until its platform credentials are set.
   */
  async function activeStubOAuth() {
    // stub-oauth installs INACTIVE (OAUTH2, nothing authorised yet), so the row is
    // activated directly. The authorisation path has its own guard, tested in
    // `integration-oauth.db.test.ts`.
    const installed = await withOrg(orgId, (tx) =>
      integrations.installIntegration(
        tx,
        { slug: 'stub-oauth', code: 'byauth', label: 'The OAuth one', config: {} },
        actorId,
      ),
    );
    await admin.query(
      `UPDATE integration_installation
          SET active = true, oauth_refresh_token = 'enc:v1:pretend', auth_kind = 'OAUTH2'
        WHERE id = $1`,
      [installed.id],
    );
    return installed.id;
  }

  it('REFUSES to choose, rather than picking one', async () => {
    await connect('main');
    await activeStubOAuth();

    // The refusal names both connections by the labels the admin gave them,
    // because "a conflict exists" is not something anybody can act on.
    const failure = await withOrg(orgId, (tx) =>
      integrations.resolveCapability(tx, 'POST_EXPENSE_REPORT').then(
        () => null,
        (err) => err as { code: string; message: string },
      ),
    );
    expect(failure?.code).toBe('AMBIGUOUS_CAPABILITY');
    expect(failure?.message).toContain('Stub');
    expect(failure?.message).toContain('The OAuth one');
    expect(failure?.message).toMatch(/post expense report/);
  });

  it('a screen gets a sentence instead of an exception', async () => {
    // Two connected ledgers must not turn /admin/ledger-queue into a 500 — that is
    // the screen an operator opens to ask why nothing is posting.
    await connect('main');
    await activeStubOAuth();
    const status = await withOrg(orgId, (tx) =>
      integrations.capabilityAvailability(tx, 'POST_EXPENSE_REPORT'),
    );
    // `connected: true` deliberately: something IS connected, too much of it.
    // Reporting false would print "no ledger is connected" to a tenant looking at
    // two.
    expect(status.connected).toBe(true);
    expect(status.problem).toContain('Disconnect one of them');
  });

  it('refuses the second CONNECT, before the ambiguity can exist', async () => {
    // The real pair, and the real admin's path: a tenant on the stub ledger tries
    // to add VeloLedger without disconnecting. Both are CONFIG adapters and both
    // claim POST_EXPENSE_REPORT, so this is the state the old code would have
    // accepted and then resolved by coin flip.
    await connect('main');
    const refused = await withOrg(orgId, (tx) =>
      integrations
        .installIntegration(
          tx,
          {
            slug: 'veloledger',
            code: 'velo',
            label: 'VeloLedger',
            config: {
              baseUrl: 'https://ledger.test',
              apiKey: 'key',
              entityId: '00000000-0000-4000-8000-00000000000e',
              vendorRef: 'V-1',
            },
          },
          actorId,
        )
        .then(
          () => null,
          (err) => err as { code: string; message: string },
        ),
    );
    expect(refused?.code).toBe('AMBIGUOUS_CAPABILITY');
    // Names the connection the admin already has, and what to do about it.
    expect(refused?.message).toContain('Stub');
    expect(refused?.message).toContain('Disconnect');
    // And nothing was written: a refusal that half-connects is worse than either
    // outcome.
    const rows = await admin.query('SELECT count(*)::int AS n FROM integration_installation');
    expect(rows.rows[0].n).toBe(1);
  });

  it('one active installation still resolves, and an inactive rival is not one', async () => {
    // The property the refusal must not break: a dormant or disconnected rival is
    // not competition. stub-oauth installs inactive, so this is also the QuickBooks
    // case — registered, invisible, and harmless.
    await connect('main');
    await withOrg(orgId, (tx) =>
      integrations.installIntegration(
        tx,
        { slug: 'stub-oauth', code: 'dormant', label: 'Dormant', config: {} },
        actorId,
      ),
    );
    const resolved = await withOrg(orgId, (tx) =>
      integrations.resolveCapability(tx, 'POST_EXPENSE_REPORT'),
    );
    expect(resolved?.adapter.slug).toBe('stub-ledger');
  });

  it('an adapter with NO capabilities never conflicts', async () => {
    // What keeps QuickBooks installable while dormant: `capabilities: []` means it
    // cannot be chosen and cannot block anybody.
    await connect('main');
    const rival = await withOrg(orgId, (tx) =>
      findCapabilityRival(tx, { ...stubOAuthAdapter, capabilities: [] }),
    );
    expect(rival).toBeNull();
  });
});

describe('the secret audit', () => {
  it('reports nothing on a healthy installation', async () => {
    await connect();
    expect(await withOrg(orgId, (tx) => integrations.auditSecrets(tx))).toEqual([]);
  });

  it('catches a cleartext secret written around the encryption path', async () => {
    // Exactly ExpenseOS's bootstrap.ts defect (AC-4): a writer that skips the
    // encrypt helper. Impossible through the service, so it is simulated by
    // writing the row directly — which is what a future `scripts/bootstrap` would
    // do if somebody wrote one carelessly.
    await connect();
    await admin.query(
      `UPDATE integration_installation
          SET config = jsonb_set(config, '{apiToken}', '"plaintext-token"')`,
    );
    const problems = await withOrg(orgId, (tx) => integrations.auditSecrets(tx));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ field: 'apiToken' });
    expect(problems[0].problem).toMatch(/cleartext/);
  });

  it('catches a secret that no longer decrypts', async () => {
    await connect();
    await admin.query(
      `UPDATE integration_installation
          SET config = jsonb_set(config, '{apiToken}', '"enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"')`,
    );
    const problems = await withOrg(orgId, (tx) => integrations.auditSecrets(tx));
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toMatch(/key is wrong|altered|truncated/);
  });
});
