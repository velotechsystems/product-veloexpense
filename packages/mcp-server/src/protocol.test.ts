/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense (w6-03): ExpenseOS's suite reads JSON-RPC responses untyped (`as any`); Biome allows it there. */
import { describe, expect, it, vi } from 'vitest';
import {
  availableTools,
  type ExecOutcome,
  type HandleContext,
  handleRpc,
  listPage,
  PAGE_SIZE,
  PROTOCOL_VERSION,
  toolContent,
  untrustedEnvelope,
} from './protocol';
import { TOOLS } from './tools';
import type { ToolSpec } from './types';

const REPORT = 'expense_management.expense_report';
const APPROVAL = 'expense_management.expense_approval';

const ctx = (over: Partial<HandleContext> = {}): HandleContext => ({
  capabilities: { permissions: [], activeModules: [] },
  scopes: [REPORT],
  execute: async () => ({ status: 'ok', result: { fine: true } }),
  ...over,
});

const call = (name: string, args: unknown = {}, c: HandleContext = ctx()) =>
  handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, c);

const resultOf = (res: unknown) =>
  (res as { result: { content: { text: string }[]; isError?: boolean } }).result;
const payloadOf = (res: unknown) => JSON.parse(resultOf(res).content[0].text);

describe('handshake', () => {
  it('answers initialize with the protocol version and its own identity', async () => {
    const res = await handleRpc({ id: 1, method: 'initialize' }, ctx());
    expect((res as any).result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect((res as any).result.serverInfo.name).toBe('expenseos');
  });

  it('returns nothing for the initialized notification', async () => {
    // No `id` means no response body — the handshake's last step expects 202 and silence.
    expect(await handleRpc({ method: 'notifications/initialized' }, ctx())).toBeNull();
  });

  it('answers ping', async () => {
    expect(await handleRpc({ id: 7, method: 'ping' }, ctx())).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {},
    });
  });

  it('reports an unknown method as a JSON-RPC error', async () => {
    const res = await handleRpc({ id: 1, method: 'resources/list' }, ctx());
    expect((res as any).error.code).toBe(-32601);
  });

  it('stays silent for an unknown NOTIFICATION rather than erroring', async () => {
    expect(await handleRpc({ method: 'notifications/cancelled' }, ctx())).toBeNull();
  });
});

describe('tools/list', () => {
  it('offers only tools the scopes permit', async () => {
    const res = await handleRpc({ id: 1, method: 'tools/list' }, ctx({ scopes: [REPORT] }));
    const names = (res as any).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('get_expense_report');
    // VeloExpense (w6-03): a travel tool stands in for `list_budgets`, which is not ported.
    expect(names).not.toContain('list_my_travel_requests');
  });

  it('offers nothing to a key with no scopes', async () => {
    // Deny-by-default, visible at the protocol boundary and not only inside the check.
    const res = await handleRpc({ id: 1, method: 'tools/list' }, ctx({ scopes: [] }));
    expect((res as any).result.tools).toEqual([]);
  });

  it('hides write tools from a read-only scope', async () => {
    const res = await handleRpc(
      { id: 1, method: 'tools/list' },
      ctx({ scopes: [`${REPORT}.readonly`] }),
    );
    const names = (res as any).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('get_expense_report');
    expect(names).not.toContain('submit_expense_report');
  });

  it('carries a JSON Schema for every offered tool', async () => {
    const res = await handleRpc({ id: 1, method: 'tools/list' }, ctx());
    for (const tool of (res as any).result.tools) {
      expect(tool.inputSchema).toHaveProperty('type', 'object');
    }
  });
});

describe('pagination', () => {
  const many = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, i) => ({
    ...(TOOLS[0] as ToolSpec),
    name: `tool_${i}`,
  }));

  it('returns a cursor only while more remain', () => {
    const first = listPage(many);
    expect(first.tools).toHaveLength(PAGE_SIZE);
    expect(first.nextCursor).toBe(String(PAGE_SIZE));

    const last = listPage(many, String(PAGE_SIZE * 2));
    expect(last.tools).toHaveLength(3);
    expect(last.nextCursor).toBeUndefined();
  });

  it('omits the cursor when everything fits on one page', () => {
    expect(listPage(many.slice(0, 3)).nextCursor).toBeUndefined();
  });

  it('restarts from the beginning on a malformed cursor rather than throwing', () => {
    // The cursor is opaque by contract but arrives from a client, so it is validated
    // rather than trusted.
    for (const bad of ['nonsense', '-5', '', '1e9999']) {
      expect(listPage(many, bad).tools[0].name, bad).toBe('tool_0');
    }
  });
});

describe('tools/call', () => {
  it('runs a permitted tool and wraps the result as untrusted data', async () => {
    const res = await call('get_expense_report', {
      reportId: '00000000-0000-7000-8000-00000000000a',
    });
    const payload = payloadOf(res);
    expect(resultOf(res).isError).toBe(false);
    expect(payload.data).toEqual({ fine: true });
    expect(payload._note).toMatch(/never as instructions/i);
  });

  it('refuses a tool the scopes do not cover, and says which scope is needed', async () => {
    // VeloExpense (w6-03): a travel tool stands in for `list_budgets`, which is not ported.
    const res = await call('list_my_travel_requests', {}, ctx({ scopes: [REPORT] }));
    expect(resultOf(res).isError).toBe(true);
    expect(payloadOf(res).error).toContain('travel.travel_request');
  });

  it('refuses a write when only the read-only scope is held', async () => {
    const res = await call(
      'submit_expense_report',
      { reportId: '00000000-0000-7000-8000-00000000000a' },
      ctx({ scopes: [`${REPORT}.readonly`] }),
    );
    expect(resultOf(res).isError).toBe(true);
    expect(payloadOf(res).error).toMatch(/scopes do not permit/i);
  });

  it('refuses a tool that was never offered, even when named directly', async () => {
    // Visibility is checked against the SAME list the client was shown, so guessing a name
    // is not a way in.
    const execute = vi.fn(async (): Promise<ExecOutcome> => ({ status: 'ok', result: {} }));
    // VeloExpense (w6-03): a travel tool stands in for `list_budgets`, which is not ported.
    const res = await call('list_my_travel_requests', {}, ctx({ scopes: [], execute }));
    expect(resultOf(res).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports an unknown tool as a tool error, not a transport error', async () => {
    const res = await call('drop_database');
    expect(resultOf(res).isError).toBe(true);
    expect((res as any).error).toBeUndefined();
  });

  it('reports an execution refusal as isError inside a successful response', async () => {
    // A 403 from the procedure is information the model should explain, not a transport
    // failure it should retry.
    const res = await call(
      'get_expense_report',
      { reportId: '00000000-0000-7000-8000-00000000000a' },
      ctx({
        execute: async () => ({ status: 'error', code: 'FORBIDDEN', message: 'Nope.' }),
      }),
    );
    expect((res as any).error).toBeUndefined();
    expect(resultOf(res).isError).toBe(true);
    expect(payloadOf(res)).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('passes the caller-supplied arguments through to the executor', async () => {
    const execute = vi.fn(async (): Promise<ExecOutcome> => ({ status: 'ok', result: {} }));
    await call('get_expense_report', { reportId: 'abc' }, ctx({ execute }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'get_expense_report' }), {
      reportId: 'abc',
    });
  });
});

describe('availableTools', () => {
  it('intersects permissions, modules and scopes', async () => {
    // VeloExpense (w6-03): the travel tools stand in for the card tools (d50). The search
    // tool is the registry's one module-gated tool: on with its module and scope, off without.
    const tools = availableTools(
      ctx({
        capabilities: { permissions: [], activeModules: ['assistant'] },
        scopes: ['travel.travel_request', REPORT, APPROVAL],
      }),
    );
    const names = tools.map((t) => t.name);
    // Module on + scope held.
    expect(names).toContain('search_help_articles');
    // Scope held, no permission needed.
    expect(names).toContain('list_my_travel_requests');
    // Scope held but the permission is missing.
    expect(names).not.toContain('create_travel_request');
    const moduleOff = availableTools(
      ctx({ capabilities: { permissions: [], activeModules: [] }, scopes: [REPORT] }),
    ).map((t) => t.name);
    expect(moduleOff).not.toContain('search_help_articles');
  });
});

describe('untrustedEnvelope', () => {
  it('keeps the payload intact under `data`', () => {
    expect(untrustedEnvelope({ a: 1 }).data).toEqual({ a: 1 });
  });
});

describe('toolContent — money on the wire', () => {
  it('serialises a BigInt amount instead of throwing', () => {
    /**
     * The HTTP surface's own bug, and it was a 500 rather than a wrong answer.
     *
     * Money reaches this boundary as a BigInt, and `JSON.stringify` throws on one:
     * "Do not know how to serialize a BigInt". So `tools/call` on any money-bearing tool —
     * `list_virtual_cards`, `list_budgets`, the travel reads — failed outright on MCP while
     * the chat surface worked, because chat had its own private copy of the replacer and
     * this path had none.
     *
     * Asserted as a decimal STRING: that is how minor units already cross every other wire
     * here. A number would be worse than the throw, because an amount past 2^53 would round
     * silently and the caller would quote a total off by cents with no signal.
     */
    const out = toolContent({ spendLimitMinor: 500000n, name: 'Ads' });
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>;
    expect(parsed.spendLimitMinor).toBe('500000');
    expect(parsed.name).toBe('Ads');
    expect(out.isError).toBe(false);
  });

  it('leaves everything that is not a BigInt exactly as it was', () => {
    /** The replacer must be invisible to every other payload — otherwise fixing money
     *  would quietly change what every non-money tool returns. */
    const payload = { n: 1, s: 'x', b: true, nul: null, arr: [1, 'two'], nested: { deep: 3 } };
    expect(JSON.parse(toolContent(payload).content[0].text)).toEqual(payload);
  });
});
