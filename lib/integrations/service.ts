/**
 * VX3-3 — per-tenant integration installations: connect, configure, test, and
 * resolve an adapter by CAPABILITY.
 *
 * The pure halves are `contract.ts` (what an adapter is) and `registry.ts` (which
 * ones exist); `lib/crypto/secrets.ts` does the at-rest encryption. This file is
 * the part that touches the database. Findings: GAP-AUDIT AC-1..AC-5.
 *
 * ── Four properties this file is responsible for ────────────────────────────
 *
 * 1. A SECRET NEVER LEAVES THE SERVER, AND NEVER ARRIVES IN CLEARTEXT. Reads go
 *    through `redact`, which blanks every field the ADAPTER marks secret. Writes
 *    merge a blank secret as "unchanged" — the screen cannot re-show one, so a
 *    blank submit means keep it. Ported from ExpenseOS's `secrets.ts`, which gets
 *    this right; what is not ported is its tolerance of unmarked plaintext (AC-4).
 * 2. CORE RESOLVES BY CAPABILITY. `resolveCapability` is the only way in, and it
 *    asks "who can post an expense report for this tenant", never "is this tenant
 *    on QuickBooks". AC-5: ExpenseOS declares capabilities, validates the strings
 *    at boot, and then gates on a vendor slug — so the taxonomy means nothing.
 * 3. ONE ACTIVE INSTALLATION PER INTEGRATION, enforced by a partial unique index
 *    in `0016` and translated here into a sentence. AC-3: theirs resolves with
 *    `take: 1` and no ordering, so two active installations pick arbitrarily and
 *    nothing notices.
 * 4. AN UNKNOWN SLUG IS VISIBLE, NOT FATAL. A tenant can hold an installation of
 *    an adapter a later deploy removed. Listing says so; resolving refuses.
 */
import type { QueryRunner } from '@/lib/db/client';
import { decryptSecret, encryptSecret, isEncrypted } from '@/lib/crypto/secrets';
import {
  isSecretField,
  type AccountingAdapter,
  type AdapterConfig,
  type Capability,
  type ConfigField,
} from '@/lib/integrations/contract';
import { adapterFor, isKnownAdapter, listAdapters } from '@/lib/integrations/registry';
import { IntegrationError } from '@/lib/integrations/errors';
import { capabilityWords, findCapabilityRival, rivalMessage } from '@/lib/integrations/conflicts';
import { freshAuthConfig } from '@/lib/integrations/oauth';
import { isModuleDisabled, requireModule } from '@/lib/modules/service';

const ORG = "current_setting('app.current_org', true)::uuid";

// VX3-9a: the class moved to `lib/integrations/errors.ts` so `oauth.ts` can throw
// it without this module and that one importing each other. Re-exported here, so
// every existing `import { IntegrationError } from '@/lib/integrations/service'`
// is untouched.
export { IntegrationError } from '@/lib/integrations/errors';

interface InstallationRow {
  id: string;
  integration_slug: string;
  code: string;
  label: string;
  active: boolean;
  config: Record<string, unknown>;
  connected_at: Date | null;
  connected_by_name: string | null;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  /** VX3-8. 'CONFIG' or 'OAUTH2' — decides which affordance the screen offers. */
  auth_kind: string;
  /** VX3-8. A refresh failed in a way only a human can fix; the screen says so. */
  oauth_needs_consent: boolean;
  /** VX3-8. Null until an OAUTH2 connection has been authorised at least once. */
  oauth_authorised_at: Date | null;
  /** VX3-8. The far end's id for the authorised account, shown for confidence. */
  external_account_id: string | null;
}

export interface InstallationView extends Omit<InstallationRow, 'config'> {
  /** Secrets blanked. Never the stored value. */
  config: Record<string, string>;
  /** Which secret fields HAVE a stored value, so the screen can say "set". */
  secretsSet: string[];
  /** Null when the adapter is no longer in the registry. */
  adapter: {
    name: string;
    description: string;
    capabilities: readonly Capability[];
    configFields: readonly ConfigField[];
    setupSteps?: readonly string[];
  } | null;
}

const SELECT_INSTALLATION = `
  SELECT i.id, i.integration_slug, i.code, i.label, i.active, i.config,
         i.connected_at, u.display_name AS connected_by_name,
         i.last_test_at, i.last_test_ok, i.last_test_error,
         i.auth_kind, i.oauth_needs_consent, i.oauth_authorised_at,
         i.external_account_id
    FROM integration_installation i
    LEFT JOIN app_user u ON u.id = i.connected_by_id`;

function secretNames(adapter: AccountingAdapter | null): string[] {
  return (adapter?.configFields ?? []).filter(isSecretField).map((f) => f.name);
}

/** Blank every secret, and report which ones are actually stored. */
function redact(row: InstallationRow, adapter: AccountingAdapter | null) {
  const config: Record<string, string> = {};
  const secrets = new Set(secretNames(adapter));
  const secretsSet: string[] = [];
  for (const [k, v] of Object.entries(row.config)) {
    if (secrets.has(k)) {
      if (typeof v === 'string' && v !== '') secretsSet.push(k);
      config[k] = '';
      continue;
    }
    config[k] = typeof v === 'string' ? v : String(v ?? '');
  }
  return { config, secretsSet };
}

function view(row: InstallationRow): InstallationView {
  const adapter = adapterFor(row.integration_slug);
  const { config, secretsSet } = redact(row, adapter);
  return {
    ...row,
    config,
    secretsSet,
    adapter: adapter
      ? {
          name: adapter.name,
          description: adapter.description,
          capabilities: adapter.capabilities,
          configFields: adapter.configFields,
          setupSteps: adapter.setupSteps,
        }
      : null,
  };
}

export async function listInstallations(tx: QueryRunner): Promise<InstallationView[]> {
  const r = await tx.query(`${SELECT_INSTALLATION} ORDER BY i.label`);
  return (r.rows as InstallationRow[]).map(view);
}

/** Adapters a tenant could still add — one active installation each. */
export async function availableAdapters(tx: QueryRunner) {
  const active = await tx.query(
    'SELECT integration_slug FROM integration_installation WHERE active',
  );
  const taken = new Set(active.rows.map((r) => r.integration_slug as string));
  return listAdapters()
    .filter((a) => !taken.has(a.slug))
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      description: a.description,
      capabilities: a.capabilities,
      configFields: a.configFields,
      setupSteps: a.setupSteps,
    }));
}

/**
 * Prepare a config for storage: required fields present, secrets encrypted,
 * blanks carried over from what is already there.
 */
function prepareConfig(
  adapter: AccountingAdapter,
  incoming: Record<string, string>,
  existing: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of adapter.configFields) {
    const raw = (incoming[field.name] ?? '').trim();
    if (isSecretField(field)) {
      if (raw === '') {
        // Blank means unchanged — the screen never re-shows a secret, so a blank
        // submit is not an instruction to clear one. Carried straight over, which
        // is already ciphertext.
        const held = existing[field.name];
        if (typeof held === 'string' && held !== '') {
          out[field.name] = held;
          continue;
        }
        if (field.required) {
          throw new IntegrationError(`${field.label} is required`, 'MISSING_FIELD');
        }
        continue;
      }
      out[field.name] = encryptSecret(raw);
      continue;
    }
    if (raw === '' && field.required) {
      throw new IntegrationError(`${field.label} is required`, 'MISSING_FIELD');
    }
    if (raw !== '') out[field.name] = raw;
  }
  return out;
}

/** Decrypt for use. Throws on an unmarked secret rather than using it (AC-4). */
function usableConfig(
  adapter: AccountingAdapter,
  stored: Record<string, unknown>,
): AdapterConfig {
  const config: AdapterConfig = {};
  const secrets = new Set(secretNames(adapter));
  for (const [k, v] of Object.entries(stored)) {
    if (typeof v !== 'string') continue;
    config[k] = secrets.has(k) ? decryptSecret(v) : v;
  }
  return config;
}

export async function installIntegration(
  tx: QueryRunner,
  input: { slug: string; code: string; label: string; config: Record<string, string> },
  actorId: string,
): Promise<InstallationView> {
  // VX4-1: the gate, before any read or write. GAP-AUDIT MT-3 is why it lives
  // here and not at the edge.
  await requireModule(tx, 'accounting');

  const adapter = adapterFor(input.slug);
  if (!adapter) {
    throw new IntegrationError(`no such integration: ${input.slug}`, 'UNKNOWN_ADAPTER');
  }
  const code = input.code.trim() || input.slug;
  const config = prepareConfig(adapter, input.config, {});

  // VX3-8. Two things follow from the adapter's auth mode, and both were wrong
  // when this function was written against a world with only CONFIG adapters:
  //
  //   · `auth_kind` is copied onto the row so it is legible without loading code
  //     (`0020`). Leaving it at the 'CONFIG' default made every OAUTH2
  //     installation lie about itself, and a test asserting the value rather than
  //     assuming it is what found that.
  //   · `active` CANNOT be true for an OAUTH2 install. Nothing is authorised yet,
  //     there is no refresh token, and `0020`'s `oauth_complete` CHECK refuses the
  //     row outright — correctly: "active" would have been a claim that stops
  //     being true within the hour. It becomes active when consent completes.
  const authKind = adapter.auth ?? 'CONFIG';
  const activeOnInstall = authKind !== 'OAUTH2';

  // AC-22, told to the admin before the ambiguity can exist rather than after.
  // Only when this install would be ACTIVE: an OAUTH2 row arrives inactive and is
  // checked again at `beginAuthorisation`, which is where it would become active.
  if (activeOnInstall) {
    const rival = await findCapabilityRival(tx, adapter);
    if (rival) throw new IntegrationError(rivalMessage(adapter, rival), 'AMBIGUOUS_CAPABILITY');
  }

  let inserted;
  try {
    inserted = await tx.query(
      `INSERT INTO integration_installation
         (organization_id, integration_slug, code, label, active, auth_kind, config,
          connected_at, connected_by_id)
       VALUES (${ORG}, $1, $2, $3, $6, $7, $4::jsonb, clock_timestamp(), $5)
       -- ── AC-20. Connecting again after a disconnect used to be IMPOSSIBLE ──
       --
       -- \`disconnect()\` keeps the row on purpose, so the history of what was
       -- connected and by whom survives, and its own comment already promised the
       -- rest: "a reconnect keeps the same \`code\`". Nothing implemented that. This
       -- was an INSERT, \`code\` is \`UNIQUE (organization_id, code)\` and that one is
       -- NOT partial (only the one-active index is), so a second connect collided
       -- with the deactivated row and failed with DUPLICATE_CODE — naming a value
       -- the admin never chose and cannot see, on a screen whose other error
       -- advises "Disconnect it first". One disconnect and that integration could
       -- never be connected again.
       --
       -- Reactivating the SAME row is what makes the promise true, and it keeps
       -- \`integration_post.installation_id\` pointing at the connection the reports
       -- were actually sent to rather than orphaning it.
       ON CONFLICT (organization_id, code) DO UPDATE
          SET label = EXCLUDED.label,
              active = EXCLUDED.active,
              auth_kind = EXCLUDED.auth_kind,
              config = EXCLUDED.config,
              connected_at = clock_timestamp(),
              connected_by_id = EXCLUDED.connected_by_id,
              -- A test result belongs to the credential that produced it.
              last_test_ok = NULL, last_test_at = NULL, last_test_error = NULL,
              -- And so does an authorisation. Redundant with \`disconnect()\` after
              -- AC-21, deliberately: this makes a reactivated row IDENTICAL in
              -- shape to a fresh insert, so an adapter that changes its auth kind
              -- between releases cannot reactivate a row still carrying the other
              -- kind's columns and trip \`config_has_no_tokens\`.
              oauth_access_token = NULL, oauth_refresh_token = NULL,
              oauth_access_expires_at = NULL, oauth_refresh_expires_at = NULL,
              oauth_scope = NULL, oauth_needs_consent = false,
              oauth_authorised_at = NULL, external_account_id = NULL,
              updated_at = clock_timestamp()
        WHERE integration_installation.active = false
          -- The code identifies a CONNECTION, not a product. Letting a different
          -- integration take over the code would rewrite this row's history
          -- instead of reconnecting it, so that case falls through to the
          -- DUPLICATE_CODE below rather than being quietly accepted.
          AND integration_installation.integration_slug = EXCLUDED.integration_slug
       RETURNING id`,
      [
        adapter.slug,
        code,
        input.label.trim() || adapter.name,
        JSON.stringify(config),
        actorId,
        activeOnInstall,
        authKind,
      ],
    );
  } catch (err) {
    const code23505 = (err as { code?: string }).code === '23505';
    const detail = String((err as { constraint?: string }).constraint ?? '');
    if (code23505 && detail.includes('one_active')) {
      throw new IntegrationError(
        `${adapter.name} is already connected for this organization. Disconnect it first, ` +
          `or edit the existing connection.`,
        'ALREADY_ACTIVE',
      );
    }
    if (code23505) {
      throw new IntegrationError(`the code '${code}' is already used here`, 'DUPLICATE_CODE');
    }
    throw err;
  }

  if (inserted.rows.length === 0) {
    // The conflict target matched and the WHERE above refused, which happens for
    // exactly two reasons. Which one it was decides what an admin is told, so ask
    // the row rather than guessing — "already used here" for a connection that is
    // simply already connected is the message this defect was made of.
    const existing = await tx.query(
      'SELECT active, integration_slug FROM integration_installation WHERE code = $1',
      [code],
    );
    const row = existing.rows[0] as { active: boolean; integration_slug: string } | undefined;
    if (row?.active) {
      throw new IntegrationError(
        `${adapter.name} is already connected for this organization. Disconnect it first, ` +
          `or edit the existing connection.`,
        'ALREADY_ACTIVE',
      );
    }
    throw new IntegrationError(
      `the code '${code}' belongs to a different integration here` +
        `${row ? ` (${row.integration_slug})` : ''}. Choose another code.`,
      'DUPLICATE_CODE',
    );
  }
  return (await getInstallation(tx, inserted.rows[0].id as string))!;
}

export async function getInstallation(
  tx: QueryRunner,
  id: string,
): Promise<InstallationView | null> {
  const r = await tx.query(`${SELECT_INSTALLATION} WHERE i.id = $1`, [id]);
  return r.rows.length === 0 ? null : view(r.rows[0] as InstallationRow);
}

export async function updateInstallation(
  tx: QueryRunner,
  id: string,
  patch: { label?: string; config?: Record<string, string> },
): Promise<InstallationView> {
  // VX4-1: the gate, before any read or write. GAP-AUDIT MT-3 is why it lives
  // here and not at the edge.
  await requireModule(tx, 'accounting');

  const current = await tx.query(
    'SELECT integration_slug, config FROM integration_installation WHERE id = $1',
    [id],
  );
  if (current.rows.length === 0) throw new IntegrationError('no such connection', 'NOT_FOUND');
  const slug = current.rows[0].integration_slug as string;
  const adapter = adapterFor(slug);
  if (!adapter) {
    throw new IntegrationError(
      `this connection names '${slug}', which this build does not have`,
      'UNKNOWN_ADAPTER',
    );
  }

  const sets: string[] = [];
  const values: unknown[] = [id];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.label !== undefined && patch.label.trim() !== '') set('label', patch.label.trim());
  if (patch.config !== undefined) {
    const stored = current.rows[0].config as Record<string, unknown>;
    set('config', JSON.stringify(prepareConfig(adapter, patch.config, stored)));
    sets[sets.length - 1] += '::jsonb';
  }
  if (sets.length > 0) {
    await tx.query(
      `UPDATE integration_installation SET ${sets.join(', ')}, updated_at = clock_timestamp()
        WHERE id = $1`,
      values,
    );
  }
  return (await getInstallation(tx, id))!;
}

/**
 * Disconnect: deactivate AND destroy the credentials.
 *
 * The row stays, so the history of what was connected and by whom survives, and a
 * reconnect keeps the same `code` — which AC-20 made true; before that fix this
 * comment described behaviour no code path implemented. The SECRETS do not stay —
 * "disconnect" that leaves a working credential in the database is not a
 * disconnect, and it is the kind of thing nobody checks until a breach report asks.
 *
 * ── AC-21, and it is the same sentence failing on its own terms ─────────────
 *
 * That paragraph was written when a credential could only be a jsonb config key.
 * `0020` put OAuth tokens in COLUMNS, and this function kept stripping only the
 * config — so disconnecting an OAuth integration left an encrypted, rotating,
 * perfectly usable REFRESH TOKEN in the row, plus the authorisation state that
 * makes the screen say "Re-authorise" as though a live grant were still there.
 * Nothing exploited it yet only because no OAUTH2 adapter can post until a
 * QuickBooks client is onboarded. The columns are cleared here now.
 */
export async function disconnect(tx: QueryRunner, id: string): Promise<void> {
  // VX4-1: the gate, before any read or write. GAP-AUDIT MT-3 is why it lives
  // here and not at the edge.
  await requireModule(tx, 'accounting');

  const current = await tx.query(
    'SELECT integration_slug, config FROM integration_installation WHERE id = $1',
    [id],
  );
  if (current.rows.length === 0) throw new IntegrationError('no such connection', 'NOT_FOUND');
  const adapter = adapterFor(current.rows[0].integration_slug as string);
  const stored = current.rows[0].config as Record<string, unknown>;
  const kept: Record<string, string> = {};
  const secrets = new Set(secretNames(adapter));
  for (const [k, v] of Object.entries(stored)) {
    if (secrets.has(k)) continue;
    if (typeof v === 'string') kept[k] = v;
  }
  await tx.query(
    `UPDATE integration_installation
        SET active = false, config = $2::jsonb, last_test_ok = NULL, last_test_at = NULL,
            last_test_error = NULL,
            -- AC-21. The credential half: an access token, and a refresh token that
            -- would keep working for months.
            oauth_access_token = NULL, oauth_refresh_token = NULL,
            oauth_access_expires_at = NULL, oauth_refresh_expires_at = NULL,
            -- And the state half. None of it is still true after a disconnect, and
            -- \`oauth_authorised_at\` left set makes the screen offer
            -- "Re-authorise" for a row holding nothing to re-authorise with.
            oauth_scope = NULL, oauth_needs_consent = false, oauth_authorised_at = NULL,
            external_account_id = NULL,
            updated_at = clock_timestamp()
      WHERE id = $1`,
    [id, JSON.stringify(kept)],
  );
}

/** Run the adapter's own check and record what happened. */
export async function testInstallation(
  tx: QueryRunner,
  id: string,
): Promise<{ ok: boolean; detail: string }> {
  // VX4-1: the gate, before any read or write. GAP-AUDIT MT-3 is why it lives
  // here and not at the edge.
  await requireModule(tx, 'accounting');

  const row = await tx.query(
    'SELECT integration_slug, config FROM integration_installation WHERE id = $1',
    [id],
  );
  if (row.rows.length === 0) throw new IntegrationError('no such connection', 'NOT_FOUND');
  const adapter = adapterFor(row.rows[0].integration_slug as string);
  if (!adapter) {
    throw new IntegrationError(
      `this connection names an integration this build does not have`,
      'UNKNOWN_ADAPTER',
    );
  }

  let result: { ok: boolean; detail: string };
  try {
    // VX3-9a: `withAuth`, not `usableConfig`. With the latter, an OAUTH2 adapter's
    // `testConnection` saw an empty config and reported "not authorised yet" —
    // FOREVER, including immediately after a successful authorisation. The Test
    // button lied, which is worse than it failing.
    result = await adapter.testConnection(
      await withAuth(tx, id, adapter, row.rows[0].config as Record<string, unknown>),
    );
  } catch (err) {
    // A thrown adapter is a failed test, not a failed request. An admin pressing
    // "test" is asking a question; an exception page is not an answer.
    result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  await tx.query(
    `UPDATE integration_installation
        SET last_test_at = clock_timestamp(), last_test_ok = $2, last_test_error = $3,
            updated_at = clock_timestamp()
      WHERE id = $1`,
    [id, result.ok, result.ok ? null : result.detail],
  );
  return result;
}

export interface ResolvedAdapter {
  installationId: string;
  adapter: AccountingAdapter;
  /** Decrypted. Do not log, do not return to a client. */
  config: AdapterConfig;
}

/**
 * THE function core is meant to use.
 *
 * "Who can post an expense report for this tenant" — never "is this tenant on
 * QuickBooks". Returns null when nothing is connected that can do the thing,
 * which is a normal state and not an error: a tenant with no ledger simply does
 * not post, and VX3-4's caller decides what that means.
 */
export async function resolveCapability(
  tx: QueryRunner,
  capability: Capability,
): Promise<ResolvedAdapter | null> {
  // VX4-1: the gate, before any read or write. GAP-AUDIT MT-3 is why it lives
  // here and not at the edge.
  await requireModule(tx, 'accounting');

  const r = await tx.query(
    // ORDERED, which the first version was not — see below on why ordering alone
    // would have been the wrong fix.
    `SELECT id, integration_slug, label, config FROM integration_installation
      WHERE active ORDER BY connected_at, id`,
  );
  const candidates = r.rows.filter((row) => {
    const slug = row.integration_slug as string;
    return isKnownAdapter(slug) && adapterFor(slug)!.capabilities.includes(capability);
  });

  // ── AC-22. TWO ACTIVE LEDGERS IS NOT A QUESTION THIS CAN ANSWER ────────────
  //
  // `0016`'s partial index allows one active installation per INTEGRATION, so two
  // VeloLedger connections are impossible — and a VeloLedger and a QuickBooks are
  // not. Both declare POST_EXPENSE_REPORT, and this function used to read the
  // active rows with no ORDER BY and return the first one it liked, which is
  // physical heap order: it moves whenever a row is updated. A tenant trialling a
  // second ledger without disconnecting the first would have had reports drafted
  // into one, then the other, silently.
  //
  // That is AC-3 — the finding this audit opened against ExpenseOS — reproduced
  // one level up: fixed per vendor, missed per capability.
  //
  // Ordering is now deterministic, and ordering is deliberately NOT the fix. A
  // stable wrong ledger is still the wrong ledger, and the tenant would have no
  // way of knowing which one won. This is a configuration state only a human can
  // resolve, so it refuses and says who is competing. `dispatch.ts` treats the
  // refusal as SKIPPED WITHOUT BURNING AN ATTEMPT — the same treatment as "nothing
  // is connected", for the same reason: the reports must still be waiting when
  // somebody disconnects one.
  if (candidates.length > 1) {
    const names = candidates.map((row) => `"${row.label as string}"`).join(' and ');
    throw new IntegrationError(
      `${names} are both connected and can ${capabilityWords(capability)}, so there is ` +
        `no single answer to which one should. Disconnect one of them.`,
      'AMBIGUOUS_CAPABILITY',
    );
  }

  for (const row of candidates) {
    const slug = row.integration_slug as string;
    const adapter = adapterFor(slug)!;
    const installationId = row.id as string;
    return {
      installationId,
      adapter,
      // VX3-9a FIXED A DEFECT HERE. This used to be `usableConfig(...)` alone —
      // the decrypted jsonb blob and nothing else. For a CONFIG adapter that is
      // the whole configuration and it was correct. For an OAUTH2 adapter it is
      // EMPTY: QuickBooks declares `configFields: []`, because its credentials are
      // the platform's and its tokens live in columns rather than in the blob.
      //
      // So VX3-8 stored tokens correctly, refreshed them correctly, and then
      // handed the adapter nothing. `freshAuthConfig` — the function that
      // decrypts, refreshes-if-due and returns exactly those keys — was called by
      // NOTHING but its own test.
      //
      // Why no test caught it: every posting test drove a CONFIG adapter, which
      // needs no token, and no OAUTH2 adapter could post because `stub-oauth`
      // declared no capabilities. That is the lesson VX3-7 put in this codebase —
      // a test double that cannot produce one of two outcomes hides every bug in
      // the outcome it cannot produce — and it was written two tickets before
      // this one.
      config: await withAuth(tx, installationId, adapter, row.config as Record<string, unknown>),
    };
  }
  return null;
}

/**
 * One config for both auth kinds: the adapter's own fields, plus — for an OAUTH2
 * installation — a live access token and the far end's account id.
 *
 * A CONFIG installation pays nothing for this: `freshAuthConfig` returns `{}`
 * without a network call once it sees `auth_kind <> 'OAUTH2'`.
 *
 * The OAuth keys are merged LAST and deliberately cannot be shadowed by a
 * tenant's stored blob — a config value called `oauthAccessToken` in the jsonb
 * must never override the real one.
 */
async function withAuth(
  tx: QueryRunner,
  installationId: string,
  adapter: AccountingAdapter,
  stored: Record<string, unknown>,
): Promise<AdapterConfig> {
  const base = usableConfig(adapter, stored);
  const auth = await freshAuthConfig(tx, installationId);
  return { ...base, ...auth };
}

/** Same, but a miss is an error — for a path that cannot proceed without one. */
export async function requireCapability(
  tx: QueryRunner,
  capability: Capability,
): Promise<ResolvedAdapter> {
  const resolved = await resolveCapability(tx, capability);
  if (!resolved) {
    throw new IntegrationError(
      `no connected integration in this organization can ${capability
        .toLowerCase()
        .replace(/_/g, ' ')}`,
      'NO_CAPABILITY',
    );
  }
  return resolved;
}

/**
 * "Can anything do this job, and if not, why not" — for a SCREEN.
 *
 * AC-22's refusal is an exception, which is right for the posting path and wrong
 * for a page: two connected ledgers must not turn `/admin/ledger-queue` into a
 * 500, and that screen is precisely where an operator goes to ask why nothing is
 * posting. So the two call sites that only wanted a boolean get the sentence too.
 */
export async function capabilityAvailability(
  tx: QueryRunner,
  capability: Capability,
): Promise<{ connected: boolean; problem: string | null }> {
  try {
    return { connected: (await resolveCapability(tx, capability)) !== null, problem: null };
  } catch (err) {
    // VX4-1. The accounting module is off for this tenant. NOT an error for a
    // screen: `/admin/ledger-queue` is exactly where somebody goes to ask why
    // nothing is posting, and a 500 is the least useful answer available. Same
    // argument as the ambiguity case below — a page gets a sentence, the posting
    // path gets a refusal.
    if (isModuleDisabled(err)) return { connected: false, problem: err.message };
    if (err instanceof IntegrationError && err.code === 'AMBIGUOUS_CAPABILITY') {
      // Something IS connected — too much of it. Reporting `connected: false` here
      // would put "no ledger is connected" on the screen of a tenant looking at
      // two, which is the kind of wrong message that costs a support call.
      return { connected: true, problem: err.message };
    }
    throw err;
  }
}

/** For a diagnostic: whether a stored secret is actually readable. */
export async function auditSecrets(
  tx: QueryRunner,
): Promise<Array<{ code: string; field: string; problem: string }>> {
  const r = await tx.query('SELECT code, integration_slug, config FROM integration_installation');
  const problems: Array<{ code: string; field: string; problem: string }> = [];
  for (const row of r.rows) {
    const adapter = adapterFor(row.integration_slug as string);
    for (const field of secretNames(adapter)) {
      const value = (row.config as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value === '') continue;
      if (!isEncrypted(value)) {
        problems.push({
          code: row.code as string,
          field,
          problem: 'stored in cleartext — this should be impossible; a writer bypassed encryption',
        });
        continue;
      }
      try {
        decryptSecret(value);
      } catch (err) {
        problems.push({
          code: row.code as string,
          field,
          problem: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return problems;
}
