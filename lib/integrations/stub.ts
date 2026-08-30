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
import type {
  AccountingAdapter,
  AdapterConfig,
  PostResult,
  PostableReport,
  RemoteAccount,
  TestResult,
} from '@/lib/integrations/contract';

interface StubState {
  posted: Array<{ report: PostableReport; externalId: string }>;
  accounts: RemoteAccount[];
  /** Set to make the next call fail, so a failure path can be tested. */
  failWith: string | null;
  paid: Set<string>;
}

const state: StubState = { posted: [], accounts: [], failWith: null, paid: new Set() };

/** Test seam. Returns a restore function, same shape as `setEmailTransport`. */
export function stubControl() {
  return {
    posted: () => [...state.posted],
    setAccounts(accounts: RemoteAccount[]) {
      state.accounts = accounts;
    },
    failNext(message: string | null) {
      state.failWith = message;
    },
    markPaid(externalId: string) {
      state.paid.add(externalId);
    },
    reset() {
      state.posted = [];
      state.accounts = [];
      state.failWith = null;
      state.paid = new Set();
    },
  };
}

function consumeFailure(): void {
  if (state.failWith === null) return;
  const message = state.failWith;
  // One-shot: a test that wants two failures says so twice, and a test that
  // forgets to reset does not poison the next one silently.
  state.failWith = null;
  throw new Error(message);
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
