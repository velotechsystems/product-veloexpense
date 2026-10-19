import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End to end: the bytes a model actually receives for `list_my_expense_reports`.
 *
 * VeloExpense (w6-03): ExpenseOS proves this on `list_virtual_cards`, which VeloExpense does not
 * have (d50). The same proof on a VeloExpense tool that returns money — a report list whose
 * total is a raw BigInt in a nested currency relation, the shape the card list had — with the
 * same $5,000.00 figure and the same assertions.
 *
 * `toolMoney.test.ts` proves the transform. This proves the WIRING, and it has to run all the
 * way through `runTurn` rather than stopping at the executor, because the last step is the one
 * that erased the evidence: `jsonSafe` turns `500000n` into the string `"500000"`, so by the
 * time the model sees it there is no type left to hint that it was cents. A test that asserted
 * on the executor's return value would miss that entirely — which is roughly how the bug
 * survived being looked at.
 *
 * Real `ToolSpec` from the registry, real path resolution, real serialization. The only fake
 * is the model.
 */

const h = vi.hoisted(() => ({ caller: {} as Record<string, unknown> }));

vi.mock('@/server/trpc', () => ({
  createCallerFactory: () => () => h.caller,
}));
vi.mock('@/server/routers/_app', () => ({ appRouter: {} }));

import type Anthropic from '@anthropic-ai/sdk';
import { type AssistantClient, runTurn } from '@expenseos/assistant';
import { toolByName } from '@expenseos/mcp-server';
import { makeExecutor } from './mcpExecutor';

const T0 = new Date('2026-08-19T12:00:00Z');

/** VeloExpense (w6-03): a report list: raw BigInt, currency as a nested relation. */
const REPORTS = {
  items: [
    {
      id: 'r-1',
      number: 'EXP-000042',
      status: 'SUBMITTED',
      totalMinor: 500_000n,
      currency: { code: 'USD', symbol: '$' },
    },
  ],
};

const listReports = toolByName('list_my_expense_reports');

/** A model that calls the tool once, then says nothing further. */
function scripted(): AssistantClient {
  const script: Anthropic.Message[] = [
    {
      content: [{ type: 'tool_use', id: 'tu-1', name: 'list_my_expense_reports', input: {} }],
      stop_reason: 'tool_use',
    } as Anthropic.Message,
    { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } as Anthropic.Message,
  ];
  return {
    stream() {
      const next = script.shift();
      if (!next) throw new Error('the loop asked for more turns than the script has');
      return {
        // Nothing streams here; the loop only needs `finalMessage`.
        async *[Symbol.asyncIterator]() {},
        finalMessage: async () => next,
      };
    },
  };
}

/** The `tool_result` text the loop hands back to the model. */
async function toolResultText(locale: 'en' | 'fr-CA'): Promise<string> {
  let text = '';
  for await (const event of runTurn({
    client: scripted(),
    model: 'claude-test',
    system: [],
    tools: [],
    specs: [listReports as never],
    history: [
      { id: 'u0', role: 'user', content: [{ type: 'text', text: 'my reports' }], createdAt: T0 },
    ],
    execute: makeExecutor({} as never, locale),
    now: () => T0,
  })) {
    if (event.type === 'message' && event.role === 'user') {
      const [result] = event.content as { content: string }[];
      text = result?.content ?? '';
    }
  }
  return text;
}

/** The one report, as the model would parse it back out of the tool result. */
async function report(locale: 'en' | 'fr-CA'): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await toolResultText(locale)) as {
    data: { items: Record<string, unknown>[] };
  };
  return parsed.data.items[0] as Record<string, unknown>;
}

beforeEach(() => {
  // Reset the implementation, not just the call history: `clearAllMocks` leaves the caller in
  // place, so a test that forgot this would be reading the previous test's payload.
  h.caller = { expenses: { list: async () => REPORTS } };
});

describe('what the model sees for list_my_expense_reports', () => {
  it('is a real tool whose path is the procedure this test drives', () => {
    // If the registry renamed either, everything below would be testing a fiction.
    expect(listReports?.path).toBe('expenses.list');
  });

  it('reads the total as five thousand dollars, not as five hundred thousand', async () => {
    /**
     * The reported bug, end to end. `"500000"` on its own is what the model used to get, and
     * it reported that figure — the right digits, wrong by two orders of magnitude.
     */
    expect(await report('en')).toMatchObject({ totalDisplay: '$5,000.00 USD' });
  });

  it('still carries the raw minor units, so the model can do arithmetic', async () => {
    /**
     * And as the STRING `jsonSafe` produced, not a JSON number: past 2^53 a number would
     * round silently, so the total would be off by cents with nothing to show it happened.
     */
    expect(await report('en')).toMatchObject({ totalMinor: '500000' });
  });

  it('renders it in French for a French-Canadian reader', async () => {
    /**
     * Both locales on the same amount, asserted to DIFFER — a test that only checked fr-CA
     * produced *something* would pass on a build that returned English to everyone.
     */
    const en = await toolResultText('en');
    const frCA = await toolResultText('fr-CA');
    expect(en).toContain('$5,000.00 USD');
    expect(frCA).not.toContain('$5,000.00 USD');
    expect(frCA).toMatch(/5[\u00A0\u202F]000,00/);
    // Not a plain ASCII space: Intl emits U+00A0 or U+202F here, so matching ' ' would be
    // asserting nothing at all about the separator.
    expect(frCA).not.toContain('5 000,00');
  });
});
