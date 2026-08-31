/**
 * VX3-3 — a stub ledger, for tests and for the e2e.
 *
 * Same argument as VX2-8's MEMORY email transport and VX1-9's s3rver: a
 * capability nothing exercises is a capability nobody has checked. This adapter
 * implements every method the contract offers, holds what it was given in module
 * state, and lets `test/integrations.db.test.ts` and the e2e drive a full
 * connect → test → post round trip with no network and no ledger.
 *
 * ── It is NOT registered by default ─────────────────────────────────────────
 *
 * `registry.ts` includes it only when `INTEGRATIONS_ENABLE_STUB=1`. VX1-9 wrote
 * down what the alternative costs: "MemoryStorage signs `memory://` URLs no
 * browser can fetch, which is why the vitest suites can be green while a real
 * upload is broken." A stub that a tenant could accidentally connect to in
 * production would be worse than that — it accepts every post and reports success,
 * so a finance team would see a queue draining to nowhere.
 */
import {
  AdapterError,
  OAuthConsentRequired,
  type AccountingAdapter,
  type AdapterConfig,
  type PostResult,
  type PostableReport,
  type RemoteAccount,
  type TestResult,
} from '@/lib/integrations/contract';

interface StubState {
  posted: Array<{ report: PostableReport; externalId: string }>;
  accounts: RemoteAccount[];
  /** Set to make the next call fail, so a failure path can be tested. */
  failWith: string | null;
  /**
   * How the next failure classifies. VX3-7: the stub used to throw a bare
   * `Error`, which is AMBIGUOUS — so no test could exercise the REFUSED branch
   * through a non-VeloLedger adapter, and the defect where only VeloLedger could
   * report a refusal was invisible to the suite. A test double that cannot
   * produce one of the two outcomes is a test double that hides a bug.
   */
  failRefused: boolean;
  /** Throw a plain Error instead of an AdapterError — see `failNextBare`. */
  failBare: boolean;
  paid: Set<string>;
}

const state: StubState = {
  posted: [],
  accounts: [],
  failWith: null,
  failRefused: false,
  failBare: false,
  paid: new Set(),
};

/** Test seam. Returns a restore function, same shape as `setEmailTransport`. */
export function stubControl() {
  return {
    posted: () => [...state.posted],
    setAccounts(accounts: RemoteAccount[]) {
      state.accounts = accounts;
    },
    /**
     * `refused: true` means the far end rejected the call and certainly did not
     * apply it — a 401, a validation failure. `false` (the default) means it
     * might have applied, which is what a timeout looks like.
     */
    failNext(message: string | null, refused = false) {
      state.failWith = message;
      state.failRefused = refused;
      state.failBare = false;
    },
    /**
     * Throw a BARE `Error` rather than an `AdapterError` — what an adapter looks
     * like when a vendor SDK's own error type escapes it. Core must classify that
     * as ambiguous, and a test double with no way to produce it could not prove so.
     */
    failNextBare(message: string) {
      state.failWith = message;
      state.failRefused = false;
      state.failBare = true;
    },
    markPaid(externalId: string) {
      state.paid.add(externalId);
    },
    reset() {
      state.posted = [];
      state.accounts = [];
      state.failWith = null;
      state.failRefused = false;
      state.failBare = false;
      state.paid = new Set();
    },
  };
}

function consumeFailure(): void {
  if (state.failWith === null) return;
  const message = state.failWith;
  // One-shot: a test that wants two failures says so twice, and a test that
  // forgets to reset does not poison the next one silently.
  const refused = state.failRefused;
  const bare = state.failBare;
  state.failWith = null;
  state.failRefused = false;
  state.failBare = false;
  if (bare) throw new Error(message);
  throw new AdapterError(message, refused);
}

export const stubAdapter: AccountingAdapter = {
  slug: 'stub-ledger',
  name: 'Stub ledger (testing)',
  description:
    'A fake ledger that records what it is given. Available only when ' +
    'INTEGRATIONS_ENABLE_STUB is set; never in a deployed environment.',
  capabilities: ['POST_EXPENSE_REPORT', 'PULL_CHART_OF_ACCOUNTS', 'READ_PAYMENT_STATUS'],

  /**
   * VX3-8: this gate used to live in `registry.ts` as
   * `a.slug !== 'stub-ledger' || process.env.INTEGRATIONS_ENABLE_STUB === '1'`.
   * It belongs here — the reason the stub is gated is a fact about the stub.
   *
   * Read at CALL time, never at module load (NT-14): ES imports are hoisted, so a
   * module-load read cannot be varied by a test, and `test/integration-registry.
   * test.ts` sets this flag inside a test body.
   */
  available: () => process.env.INTEGRATIONS_ENABLE_STUB === '1',
  configFields: [
    {
      name: 'ledgerUrl',
      label: 'Ledger URL',
      type: 'url',
      required: true,
      placeholder: 'https://ledger.example.test',
    },
    {
      name: 'apiToken',
      label: 'API token',
      type: 'secret',
      required: true,
      help: 'Stored encrypted; never shown again after saving.',
    },
  ],
  setupSteps: ['There is nothing to set up. This adapter exists for tests.'],

  async testConnection(config: AdapterConfig): Promise<TestResult> {
    consumeFailure();
    if (!config.apiToken) return { ok: false, detail: 'No API token was saved.' };
    return { ok: true, detail: `Reached the stub ledger at ${config.ledgerUrl}.` };
  },

  async postExpenseReport(_config: AdapterConfig, report: PostableReport): Promise<PostResult> {
    consumeFailure();
    const externalId = `stub-${report.reportId}`;
    state.posted.push({ report, externalId });
    return { externalId, detail: `Recorded as ${externalId}.` };
  },

  async pullChartOfAccounts(): Promise<RemoteAccount[]> {
    consumeFailure();
    return [...state.accounts];
  },

  async readPaymentStatus(_config: AdapterConfig, externalId: string) {
    consumeFailure();
    return state.paid.has(externalId) ? ('PAID' as const) : ('UNPAID' as const);
  },
};

/* ── a second double: the OAUTH2 machinery (VX3-8) ───────────────────────────
 *
 * Same argument as the stub ledger above, one layer over. The generic OAuth
 * plumbing — state minting, single use, expiry, token storage, refresh-on-use,
 * re-consent — is the part most likely to be subtly wrong and the part no test
 * could reach otherwise: the only real OAUTH2 adapter is QuickBooks, and driving
 * it means either a network or a mock of the network.
 *
 * VX3-7's lesson, written down one ticket earlier: a test double that cannot
 * produce one of two outcomes hides every bug in the outcome it cannot produce.
 * So this one can produce all of them — a refresh that rotates, a refresh that
 * needs consent, and a refresh that merely fails.
 */
interface OAuthStubState {
  exchanges: number;
  refreshes: number;
  /** What the next refresh does. */
  nextRefresh: 'ok' | 'needs-consent' | 'transient';
  /** Rotate the refresh token on each refresh, as QuickBooks does. */
  rotate: boolean;
  accessTtlSeconds: number | undefined;
  lastAuthorizeUrl: string | null;
}

const oauthState: OAuthStubState = {
  exchanges: 0,
  refreshes: 0,
  nextRefresh: 'ok',
  rotate: true,
  accessTtlSeconds: 3600,
  lastAuthorizeUrl: null,
};

export function stubOAuthControl() {
  return {
    counts: () => ({ exchanges: oauthState.exchanges, refreshes: oauthState.refreshes }),
    lastAuthorizeUrl: () => oauthState.lastAuthorizeUrl,
    /** 'ok' rotates and succeeds; 'needs-consent' throws OAuthConsentRequired. */
    nextRefresh(kind: 'ok' | 'needs-consent' | 'transient') {
      oauthState.nextRefresh = kind;
    },
    setRotate(on: boolean) {
      oauthState.rotate = on;
    },
    /** undefined means the far end reported no expiry. */
    setAccessTtl(seconds: number | undefined) {
      oauthState.accessTtlSeconds = seconds;
    },
    reset() {
      oauthState.exchanges = 0;
      oauthState.refreshes = 0;
      oauthState.nextRefresh = 'ok';
      oauthState.rotate = true;
      oauthState.accessTtlSeconds = 3600;
      oauthState.lastAuthorizeUrl = null;
    },
  };
}

export const stubOAuthAdapter: AccountingAdapter = {
  slug: 'stub-oauth',
  name: 'Stub ledger via authorisation (testing)',
  description:
    'A fake ledger that connects by redirect instead of by pasted key. Available ' +
    'only when INTEGRATIONS_ENABLE_STUB is set; never in a deployed environment.',
  auth: 'OAUTH2',
  // No capabilities: this double exists to exercise AUTHENTICATION. Posting is
  // already covered by `stub-ledger`, and declaring a capability here would make
  // `resolveCapability` able to choose it over the one that records posts.
  capabilities: [],
  configFields: [],
  available: () => process.env.INTEGRATIONS_ENABLE_STUB === '1',

  authorizeUrl({ state, redirectUri }) {
    const url = `https://stub.invalid/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    oauthState.lastAuthorizeUrl = url;
    return url;
  },

  async exchangeCode({ code, callbackParams }) {
    oauthState.exchanges += 1;
    if (code === 'BAD') throw new Error('the stub refused this code');
    return {
      accessToken: `access-1`,
      refreshToken: `refresh-1`,
      expiresInSeconds: oauthState.accessTtlSeconds,
      refreshExpiresInSeconds: 8640000,
      externalAccountId: callbackParams.realmId ?? 'stub-company',
      scope: 'stub.accounting',
    };
  },

  async refreshTokens({ refreshToken }) {
    oauthState.refreshes += 1;
    if (oauthState.nextRefresh === 'needs-consent') {
      oauthState.nextRefresh = 'ok';
      throw new OAuthConsentRequired('the stub says this connection was revoked');
    }
    if (oauthState.nextRefresh === 'transient') {
      oauthState.nextRefresh = 'ok';
      throw new Error('the stub could not be reached');
    }
    const n = oauthState.refreshes + 1;
    return {
      accessToken: `access-${n}`,
      refreshToken: oauthState.rotate ? `refresh-${n}` : undefined,
      expiresInSeconds: oauthState.accessTtlSeconds,
      // Deliberately absent, so the COALESCE that keeps the previous refresh
      // expiry is exercised rather than assumed.
      refreshExpiresInSeconds: undefined,
      scope: 'stub.accounting',
    };
  },

  async testConnection(config: AdapterConfig): Promise<TestResult> {
    return config.oauthAccessToken
      ? { ok: true, detail: `Stub authorised, holding ${config.oauthAccessToken}.` }
      : { ok: false, detail: 'Not authorised yet.' };
  },
};
