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
