/**
 * VX3-4 — the VeloLedger adapter. The reference implementation of the contract.
 *
 * ── The transport is HTTP, not MCP, and the Plan's wording is misleading ─────
 *
 * The Plan says "build the VeloLedger MCP adapter". The TOOLS are MCP tools; the
 * transport cannot be. `product-veloledger/lib/mcp/server.ts` says so in its own
 * header — "Transport: stdio (standard MCP local-server pattern). Phase 3 adds
 * SSE/HTTP" — and that is VeloLedger's Phase 3, not ours. A Next.js server action
 * cannot speak stdio to another product across a network.
 *
 * What IS reachable is their REST v1 route, over the SAME registry:
 *
 *   POST /api/v1/<tool_name>   Authorization: Bearer <api_key>
 *
 *   "Tool surface is the same registry the stdio MCP server uses (S37). Adding a
 *    new MCP tool automatically exposes it at /api/v1/<name>; no separate HTTP
 *    wrapper code per tool."
 *
 * So this adapter calls the tools by name over HTTP. When VeloLedger adds an HTTP
 * MCP transport, the tool names and payloads here are already the right ones.
 *
 * ── An approved report becomes a DRAFT BILL, and it is right that it drafts ──
 *
 * `draft_bill`'s own banner: "agents draft AP vendor bills; humans post via UI."
 * VeloExpense therefore PROPOSES a payable and a person in VeloLedger posts it.
 * That is a control boundary worth keeping rather than working around — a
 * mis-configured expense system cannot corrupt somebody's general ledger — and it
 * is why VX3-4 does not touch `REIMBURSED` (GAP-AUDIT AC-11): there is no payment
 * to observe, because nothing has been posted yet. Reimbursement stays the human
 * action VX2-9 built, with its self-payment control intact.
 *
 * A BILL rather than a journal, because RB-6 is right about what an approved
 * report is: "an approved report is a liability". The company owes the employee,
 * which is accounts payable, and VeloLedger has an AP subledger with aging.
 *
 * ── The role matters ────────────────────────────────────────────────────────
 *
 * Their route gates draft tools on `ai_drafter` or `system_integrator`. An
 * integration is the latter. `testConnection` calls `list_entities`, a READ tool
 * open to every role — so a key with too few permissions passes the connection
 * test and fails on the first real post. `testConnection` therefore checks the
 * configured entity is REACHABLE and says plainly that it has not proven the key
 * can draft.
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

/** Seconds. A ledger that has not answered by now is not about to. */
const TIMEOUT_SECONDS = 20;

/**
 * VX3-7: now an `AdapterError` from the contract rather than a bare `Error` with
 * its own classifier. The classifier used to live here and `dispatch.ts` imported
 * it, which made this adapter the only one able to report a refusal — see the
 * note on `AdapterError`. The subclass survives for its NAME, which shows up in
 * logs and in `last_error`, and because `callTool` builds VeloLedger-shaped
 * messages that are worth keeping distinct from another vendor's.
 */
class LedgerError extends AdapterError {
  constructor(message: string, definitelyNotApplied: boolean) {
    super(message, definitelyNotApplied);
    this.name = 'LedgerError';
  }
}

/**
 * One tool call.
 *
 * `definitelyNotApplied` is the load-bearing output. A 401/403/404/422 was refused
 * before anything happened; a timeout or a 5xx might have applied. VX3-4's caller
 * uses that distinction to choose between a retryable FAILED and a NEEDS_REVIEW
 * that no automatic path will touch (AC-8).
 */
async function callTool<T>(
  config: AdapterConfig,
  tool: string,
  body: Record<string, unknown>,
): Promise<T> {
  const base = (config.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new LedgerError('no VeloLedger URL is configured', true);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
  let response: Response;
  try {
    response = await fetch(`${base}/api/v1/${tool}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    // A network failure or an abort. We do NOT know whether the far end applied
    // it, so this is deliberately not "definitely not applied".
    throw new LedgerError(
      err instanceof Error && err.name === 'AbortError'
        ? `VeloLedger did not answer within ${TIMEOUT_SECONDS} seconds`
        : `could not reach VeloLedger: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    // Their documented error shape: { error: { code, message } }.
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed.error?.message) {
        detail = `${parsed.error.code ?? response.status}: ${parsed.error.message}`;
      }
    } catch {
      // Not JSON. The raw body is more useful than a parse complaint.
    }
    // 401 no/invalid token, 403 role, 404 unknown tool, 422 body validation — all
    // refused before the handler ran. A 5xx means the handler threw, which may have
    // applied part of its work.
    const refused = [401, 403, 404, 422].includes(response.status);
    throw new LedgerError(detail, refused);
  }
  return JSON.parse(text) as T;
}

export const veloLedgerAdapter: AccountingAdapter = {
  slug: 'veloledger',
  name: 'VeloLedger',
  description:
    'Drafts an accounts-payable bill in VeloLedger for every approved expense ' +
    'report. Somebody in VeloLedger reviews and posts it — this never posts to a ' +
    'ledger directly.',
  capabilities: ['POST_EXPENSE_REPORT', 'PULL_CHART_OF_ACCOUNTS'],
  configFields: [
    {
      name: 'baseUrl',
      label: 'VeloLedger URL',
      type: 'url',
      required: true,
      placeholder: 'https://ledger.yourcompany.com',
    },
    {
      name: 'apiKey',
      label: 'API key',
      type: 'secret',
      required: true,
      help: "Needs the 'system_integrator' role. Stored encrypted; never shown again.",
    },
    {
      name: 'entityId',
      label: 'Entity',
      type: 'text',
      required: true,
      help: 'The VeloLedger entity (legal entity) these bills belong to.',
    },
    {
      name: 'vendorRef',
      label: 'Reimbursements vendor',
      type: 'text',
      required: true,
      help:
        'The vendor every reimbursement is billed to — typically one called ' +
        '"Employee expense reimbursements". Its vendor number or id.',
    },
  ],
  setupSteps: [
    'Create an API key with the system_integrator role.',
    'Create (or choose) a vendor for employee reimbursements, and note its vendor number.',
    'Note the entity id these bills should belong to.',
  ],

  async testConnection(config: AdapterConfig): Promise<TestResult> {
    try {
      const result = await callTool<{ entities?: Array<{ id: string; name?: string }> }>(
        config,
        'list_entities',
        {},
      );
      const entities = result.entities ?? [];
      const match = entities.find((e) => e.id === config.entityId);
      if (!match) {
        return {
          ok: false,
          detail:
            `Connected, but entity ${config.entityId} is not one this key can see ` +
            `(${entities.length} available). Check the entity id.`,
        };
      }
      return {
        ok: true,
        // Said out loud, because `list_entities` is a READ tool open to every role:
        // a key that cannot draft passes this test and fails on the first report.
        //
        // VX3-7 added the second half. A drafted bill is not a posted one, and two
        // of the three ways their post can refuse it are INVISIBLE over this
        // contract — there is no tool that reports whether an account is a rollup
        // (`list_accounts` returns number, name, type, normalBalance, isActive and
        // subLedger, and no postability) and none that reports whether the company
        // runs segment tracking in `required` mode. The third — an account number
        // their chart does not have — IS checkable, and `postExpenseReport`
        // pre-flights it. Saying which is which beats a green tick that means less
        // than an admin will assume.
        detail:
          `Reached VeloLedger and found entity "${match.name ?? match.id}". ` +
          `This does not prove the key may DRAFT bills — that needs the ` +
          `system_integrator role, and the first posted report will tell you. ` +
          `It also proves nothing about POSTING: VeloExpense drafts, a person in ` +
          `VeloLedger posts, and their post can still refuse a draft if an account ` +
          `is a rollup there, or if the company requires a business unit and ` +
          `department that no default supplies. Neither is visible from here.`,
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },

  async postExpenseReport(
    config: AdapterConfig,
    report: PostableReport,
  ): Promise<PostResult> {
    // The tenant's day, computed by the dispatcher. This line was
    // `approvedAt.toISOString().slice(0, 10)` — the UTC day — and booked every
    // evening approval in Toronto on the next day, and the next period at
    // month-end. See `PostableReport.postingDate`.
    const billDate = report.postingDate;
    // Their `draft_bill` needs a periodId, and `resolve_period` is the tool that
    // turns a date into one — configuring it would go stale every month.
    const period = await callTool<{ periodId?: string; id?: string }>(
      config,
      'resolve_period',
      { entityId: config.entityId, date: billDate },
    );
    const periodId = period.periodId ?? period.id;
    if (!periodId) {
      throw new LedgerError(
        `VeloLedger could not resolve an accounting period for ${billDate} — ` +
          `it may be closed, or not open yet`,
        true,
      );
    }

    // A line with no GL account is not guessed at. VX3-1's snapshot is nullable on
    // purpose — "a category with no account is a configuration gap, and the
    // employee filing the expense is not who fixes it" — but a bill line has to
    // name an account, so this is where the gap has to be reported instead.
    const unmapped = report.lines.filter((l) => !l.glAccountNumber);
    if (unmapped.length > 0) {
      const names = [...new Set(unmapped.map((l) => l.categoryLabel))].join(', ');
      throw new LedgerError(
        `these categories have no GL account, so the bill cannot be drafted: ${names}. ` +
          `Map them on the chart-of-accounts screen and retry.`,
        true,
      );
    }

    // ── PRE-FLIGHT: does their chart actually contain these numbers? (VX3-7) ──
    //
    // `draft_bill` does NOT validate account numbers. `createBill` stores
    // `expense_account_number` as PLAIN TEXT on `bill_line`, with no foreign key
    // and no existence check; the numbers are resolved in
    // `buildAndPostBillJournal` — which runs when a HUMAN POSTS the bill, not when
    // we draft it. So a number that is not in their chart drafts perfectly, and
    // fails later with "bill post requires account number N which is not in the
    // chart of accounts", in their UI, to somebody who did not file the expense.
    //
    // Nothing on our side would ever learn of it. We would show "drafted in the
    // ledger" for a bill that cannot be posted, permanently.
    //
    // This is not a remote possibility. VX3-1 ships a starter template whose 28
    // numbers come from VeloLedger's own starter chart, but VX3-5's pull is
    // OPTIONAL — a tenant that picked the template and never connected-then-pulled
    // is sending numbers its ledger may never have had. `activeOnly: false`
    // deliberately: an INACTIVE account still posts at their end (their post-time
    // lookup filters on entity and number only), so treating it as missing would
    // refuse a bill that would in fact have gone through.
    //
    // Costs one extra read per post. Worth it — the alternative is a queue that
    // reports success and a ledger that quietly cannot accept any of it.
    const chart = await callTool<{ accounts?: Array<{ number?: string }> }>(
      config,
      'list_accounts',
      { entityId: config.entityId, activeOnly: false },
    );
    const theirNumbers = new Set(
      (chart.accounts ?? []).map((a) => a.number).filter((n): n is string => !!n),
    );
    // An EMPTY chart is not evidence of absence — a tool that returned nothing,
    // a shape we mis-read, a permission that hides accounts. Refusing every post
    // on a bad read would be worse than the defect this guards.
    if (theirNumbers.size > 0) {
      const absent = [
        ...new Set(report.lines.map((l) => l.glAccountNumber!).filter((n) => !theirNumbers.has(n))),
      ].sort();
      if (absent.length > 0) {
        throw new LedgerError(
          `these account numbers are not in VeloLedger's chart for this entity: ` +
            `${absent.join(', ')}. The bill was NOT drafted — VeloLedger would have ` +
            `accepted the draft and refused it when somebody tried to post it. ` +
            `Pull the chart of accounts on the integrations screen so the two agree, ` +
            `then retry.`,
          // Refused locally, nothing sent: safe to retry once the charts agree.
          true,
        );
      }
    }

    const result = await callTool<{ billId: string; humanReviewUrl?: string; created?: boolean }>(
      config,
      'draft_bill',
      {
        entityId: config.entityId,
        vendorRef: config.vendorRef,
        billDate,
        currency: report.currencyCode,
        description: `${report.number ?? 'Expense report'} — ${report.title} (${report.submitterName})`,
        vendorInvoiceRef: report.number ?? undefined,
        periodId,
        // Stable for the life of the row. VeloLedger namespaces it per API key and
        // refuses a second bill carrying the same one, so a retry after an
        // ambiguous failure cannot double-post at the far end.
        idempotencyKey: `veloexpense-report-${report.reportId}`,
        lines: report.lines.map((line) => ({
          description:
            line.description?.trim() ||
            `${line.categoryLabel}${line.merchant ? ` — ${line.merchant}` : ''}`,
          unitPriceMinor: line.amountMinor,
          expenseAccountNumber: line.glAccountNumber!,
          // Tax is passed through but NOT given a recoverable account: which
          // account an input tax credit posts to is a tax-engine decision this
          // product has not made yet, and inventing one here would put ITCs in the
          // wrong place quietly. Their schema makes the account optional.
          ...(line.taxMinor !== '0' ? { taxAmountMinor: line.taxMinor } : {}),
        })),
      },
    );

    return {
      externalId: result.billId,
      detail: result.humanReviewUrl
        ? `Drafted in VeloLedger — review it at ${result.humanReviewUrl}`
        : `Drafted in VeloLedger as bill ${result.billId}.`,
    };
  },

  async pullChartOfAccounts(config: AdapterConfig): Promise<RemoteAccount[]> {
    const result = await callTool<{
      accounts?: Array<{
        id: string;
        number: string;
        name: string;
        type: string;
        subType?: string | null;
        parentNumber?: string | null;
        isActive?: boolean;
      }>;
    }>(config, 'list_accounts', { entityId: config.entityId });
    const accounts = result.accounts ?? [];
    return accounts
      .filter((a) =>
        ['asset', 'liability', 'equity', 'revenue', 'expense'].includes(a.type),
      )
      .map((a) => ({
        externalId: a.id,
        number: a.number,
        name: a.name,
        type: a.type as RemoteAccount['type'],
        subType: a.subType ?? null,
        parentNumber: a.parentNumber ?? null,
        active: a.isActive ?? true,
      }));
  },
};

// `isDefinitelyNotApplied` USED TO LIVE HERE and was imported by
// `lib/integrations/dispatch.ts`. VX3-7 moved it to the contract: a classifier
// that only one adapter can satisfy is not a contract, and core importing an
// adapter by name is the leak the vendor-neutrality guard now fails the build on.
// Nothing replaces it here — `LedgerError extends AdapterError`, so the contract's
// classifier answers correctly for this adapter with no help from it.
