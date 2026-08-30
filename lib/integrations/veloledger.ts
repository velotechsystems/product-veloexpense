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
import type {
  AccountingAdapter,
  AdapterConfig,
  PostResult,
  PostableReport,
  RemoteAccount,
  TestResult,
} from '@/lib/integrations/contract';

/** Seconds. A ledger that has not answered by now is not about to. */
const TIMEOUT_SECONDS = 20;

class LedgerError extends Error {
  constructor(
    message: string,
    /** True when the call certainly did NOT reach the ledger's handler. */
    readonly definitelyNotApplied: boolean,
  ) {
    super(message);
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

function isoDate(value: Date | null): string {
  return (value ?? new Date()).toISOString().slice(0, 10);
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
        detail:
          `Reached VeloLedger and found entity "${match.name ?? match.id}". ` +
          `This does not prove the key may DRAFT bills — that needs the ` +
          `system_integrator role, and the first posted report will tell you.`,
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },

  async postExpenseReport(
    config: AdapterConfig,
    report: PostableReport,
  ): Promise<PostResult> {
    const billDate = isoDate(report.approvedAt);
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

/** Exposed so a caller can tell a refused call from an ambiguous one. */
export function isDefinitelyNotApplied(err: unknown): boolean {
  return err instanceof LedgerError && err.definitelyNotApplied;
}
