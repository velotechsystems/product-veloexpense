/**
 * VX3-7 — the VeloLedger adapter's FIRST tests.
 *
 * Worth saying plainly: until now this adapter had none. Every posting test drives
 * the stub, which proves the contract, the queue and the state machine and nothing
 * about the one adapter that ships. The tracker has carried "the VeloLedger adapter
 * has never met a real VeloLedger" as an open item since VX3-4, and it still has —
 * `fetch` is stubbed here, so this is not that. What it does cover is the part that
 * is ours rather than theirs: which calls we make, in which order, and what we
 * refuse to send.
 *
 * ── What is being tested, and why it is worth a file ────────────────────────
 *
 * `draft_bill` DOES NOT VALIDATE ACCOUNT NUMBERS. Their `createBill` stores
 * `expense_account_number` as plain text on `bill_line` with no foreign key and no
 * existence check; the numbers are resolved in `buildAndPostBillJournal`, which
 * runs when a HUMAN POSTS the bill. So a number their chart does not have drafts
 * perfectly and then fails, in their UI, with "bill post requires account number N
 * which is not in the chart of accounts" — and VeloExpense would show "drafted in
 * the ledger" for a bill nobody can ever post, forever, with no feedback path.
 *
 * That is not hypothetical. VX3-1 ships a starter template numbered from
 * VeloLedger's own starter chart, but VX3-5's pull is OPTIONAL: a tenant that took
 * the template and never pulled is sending numbers on faith.
 *
 * So `postExpenseReport` pre-flights the numbers against `list_accounts` and
 * refuses locally. These tests pin the three behaviours that matter — it refuses
 * when a number is absent, it does NOT refuse on a chart it could not read, and it
 * still posts when everything lines up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { veloLedgerAdapter } from '@/lib/integrations/veloledger';
import { AdapterError, type PostableReport } from '@/lib/integrations/contract';

const CONFIG = {
  baseUrl: 'https://ledger.test',
  apiKey: 'k',
  entityId: '11111111-1111-4111-8111-111111111111',
  vendorRef: 'V-1',
} as Record<string, string>;

function report(numbers: Array<string | null>): PostableReport {
  return {
    reportId: '22222222-2222-4222-8222-222222222222',
    number: 'EXP-000001',
    title: 'Toronto trip',
    submitterName: 'Ada Admin',
    submitterEmail: 'ada@x.com',
    currencyCode: 'CAD',
    totalMinor: '10000',
    approvedAt: new Date('2026-08-20T12:00:00Z'),
    lines: numbers.map((n, i) => ({
      lineItemId: `line-${i}`,
      description: 'Taxi',
      categoryCode: 'travel',
      categoryLabel: 'Travel',
      glAccountNumber: n,
      glAccountName: 'Travel',
      amountMinor: '10000',
      taxMinor: '0',
      txnDate: new Date('2026-08-19T00:00:00Z'),
      merchant: 'Beck',
    })),
  };
}

/** Tool name -> response body. A tool with no entry returns `{}`. */
type Responses = Record<string, unknown>;

let calls: string[] = [];

function stubLedger(responses: Responses, status = 200) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const tool = String(url).split('/api/v1/')[1];
      calls.push(tool);
      return {
        ok: status < 400,
        status,
        text: async () => JSON.stringify(responses[tool] ?? {}),
      } as unknown as Response;
    }),
  );
}

const PERIOD = { periodId: '33333333-3333-4333-8333-333333333333' };

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postExpenseReport pre-flights account numbers', () => {
  it('REFUSES before drafting when a number is not in their chart', async () => {
    stubLedger({
      resolve_period: PERIOD,
      list_accounts: { accounts: [{ number: '68100' }, { number: '68200' }] },
      draft_bill: { billId: 'b-1' },
    });

    await expect(
      veloLedgerAdapter.postExpenseReport!(CONFIG, report(['68100', '99999'])),
    ).rejects.toThrow(/99999/);

    // THE assertion. Not "it threw" — that a refusal happened without the bill
    // being drafted. If `draft_bill` were in this list the guard would be
    // decoration: the unpostable draft would already exist at the far end.
    expect(calls).toEqual(['resolve_period', 'list_accounts']);
    expect(calls).not.toContain('draft_bill');
  });

  it('classifies that refusal as DEFINITELY NOT APPLIED, so it stays retryable', async () => {
    // It has to be an AdapterError with the flag set, or `dispatch.ts` routes it
    // to NEEDS_REVIEW — a state no automatic path retries — for a call that never
    // left this process. Pulling the chart and retrying then fixes nothing,
    // because a human has to clear the row first.
    stubLedger({
      resolve_period: PERIOD,
      list_accounts: { accounts: [{ number: '68100' }] },
    });
    const err = await veloLedgerAdapter
      .postExpenseReport!(CONFIG, report(['77777']))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).definitelyNotApplied).toBe(true);
    // And the message tells the admin what to do, not just what went wrong.
    expect((err as AdapterError).message).toMatch(/Pull the chart of accounts/);
    expect((err as AdapterError).message).toMatch(/was NOT drafted/);
  });

  it('names EVERY absent number once, sorted', async () => {
    // Two lines can share a bad account, and a tenant fixing a mapping wants the
    // whole list rather than one number per retry.
    stubLedger({
      resolve_period: PERIOD,
      list_accounts: { accounts: [{ number: '68100' }] },
    });
    const err = await veloLedgerAdapter
      .postExpenseReport!(CONFIG, report(['68300', '68200', '68300', '68100']))
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('68200, 68300');
  });

  it('does NOT refuse when the chart came back EMPTY', async () => {
    // Fail-open, deliberately. An empty list is not evidence of absence — it can
    // be a tool that answered oddly, a shape we mis-read, or a permission that
    // hides accounts. Refusing every post in this product because of a bad read
    // at the far end would be a worse outage than the defect being guarded.
    stubLedger({
      resolve_period: PERIOD,
      list_accounts: { accounts: [] },
      draft_bill: { billId: 'b-2', humanReviewUrl: 'https://ledger.test/bills/b-2' },
    });
    const result = await veloLedgerAdapter.postExpenseReport!(CONFIG, report(['99999']));
    expect(result.externalId).toBe('b-2');
    expect(calls).toEqual(['resolve_period', 'list_accounts', 'draft_bill']);
  });

  it('drafts normally when every number is present', async () => {
    stubLedger({
      resolve_period: PERIOD,
      list_accounts: { accounts: [{ number: '68100' }, { number: '68200' }] },
      draft_bill: { billId: 'b-3', humanReviewUrl: 'https://ledger.test/bills/b-3' },
    });
    const result = await veloLedgerAdapter.postExpenseReport!(CONFIG, report(['68100', '68200']));
    expect(result.externalId).toBe('b-3');
    expect(result.detail).toContain('https://ledger.test/bills/b-3');
    expect(calls).toEqual(['resolve_period', 'list_accounts', 'draft_bill']);
  });

  it('still refuses an UNMAPPED line before it reaches the chart check', async () => {
    // VX3-4's own guard, and the order matters: a line with no account at all is a
    // configuration gap on THIS side and needs no round trip to establish.
    stubLedger({ resolve_period: PERIOD });
    await expect(
      veloLedgerAdapter.postExpenseReport!(CONFIG, report([null])),
    ).rejects.toThrow(/no GL account/);
    expect(calls).toEqual(['resolve_period']);
  });
});

describe('the adapter classifies transport failures', () => {
  it('treats 401/403/404/422 as refused, and 5xx as ambiguous', async () => {
    for (const [status, refused] of [
      [401, true],
      [403, true],
      [404, true],
      [422, true],
      [500, false],
      [503, false],
    ] as const) {
      stubLedger({ resolve_period: PERIOD }, status);
      const err = await veloLedgerAdapter
        .postExpenseReport!(CONFIG, report(['68100']))
        .catch((e: unknown) => e);
      expect(err, `status ${status}`).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).definitelyNotApplied, `status ${status}`).toBe(refused);
    }
  });

  it('says what testConnection has NOT proven', async () => {
    stubLedger({ list_entities: { entities: [{ id: CONFIG.entityId, name: 'Acme Inc' }] } });
    const result = await veloLedgerAdapter.testConnection(CONFIG);
    expect(result.ok).toBe(true);
    // Three separate claims it must decline to make. A green tick that an admin
    // reads as "posting works" is worse than no test at all.
    expect(result.detail).toMatch(/does not prove the key may DRAFT/i);
    expect(result.detail).toMatch(/rollup/i);
    expect(result.detail).toMatch(/business unit and\s+department/i);
  });
});
