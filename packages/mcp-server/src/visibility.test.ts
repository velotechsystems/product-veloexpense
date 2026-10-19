import { permissions as P } from '@expenseos/rbac';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS } from './tools';
import type { CallerCapabilities, ToolSpec } from './types';
import {
  forSurface,
  isVisible,
  onSurface,
  toolDefinitionsFor,
  toToolDefinition,
  unavailableReason,
  visibleTools,
} from './visibility';

const spec = (over: Partial<ToolSpec> = {}): ToolSpec => ({
  name: 'do_thing',
  description: 'x'.repeat(90),
  input: z.object({ id: z.string().uuid() }),
  path: 'things.do',
  kind: 'read',
  scope: 'expense_management.expense_report',
  access: 'read',
  ...over,
});

const caps = (over: Partial<CallerCapabilities> = {}): CallerCapabilities => ({
  permissions: [],
  activeModules: [],
  ...over,
});

describe('tool visibility', () => {
  it('hides a tool whose permission the caller lacks', () => {
    const t = spec({ permission: P.budget.read });
    expect(unavailableReason(t, caps())).toEqual({
      kind: 'permission',
      permission: 'budget.read',
    });
    expect(isVisible(t, caps({ permissions: ['budget.read'] }))).toBe(true);
  });

  it('hides a tool whose module is not active', () => {
    const t = spec({ moduleSlug: 'virtual-credit-cards' });
    expect(unavailableReason(t, caps())).toEqual({
      kind: 'module',
      moduleSlug: 'virtual-credit-cards',
    });
    expect(isVisible(t, caps({ activeModules: ['virtual-credit-cards'] }))).toBe(true);
  });

  it('reports the permission first when both are missing', () => {
    // The answer should name the thing the person can act on. "Ask for budget.read" is
    // actionable; "the module is off" sends them to the wrong admin page.
    const t = spec({ permission: P.budget.read, moduleSlug: 'finance-reporting' });
    expect(unavailableReason(t, caps())).toEqual({
      kind: 'permission',
      permission: 'budget.read',
    });
  });

  it('shows an unrestricted tool to anyone authenticated', () => {
    expect(isVisible(spec(), caps())).toBe(true);
  });

  it('filters the registry down for a caller with nothing granted', () => {
    const visible = visibleTools(TOOLS, caps(), 'chat');
    const names = visible.map((t) => t.name);
    // Card status and budgets are both out of reach — one by permission, one by module.
    expect(names).not.toContain('set_virtual_card_status');
    expect(names).not.toContain('list_budgets');
    // A per-record-gated read is still offered; the procedure decides on the record.
    expect(names).toContain('get_expense_report');
  });

  /**
   * VeloExpense (w6-03): ExpenseOS proves these two on its card tools, which VeloExpense does
   * not have (d50), and no tool left in the registry is both module-gated and permissioned.
   * The same pair, on a stand-in registry shaped like the card tools were.
   */
  const gatedRead = spec({ name: 'list_gated_things', moduleSlug: 'travel' });
  const gatedWrite = spec({
    name: 'close_gated_thing',
    kind: 'mutate',
    access: 'write',
    permission: P.travel.request.approve,
    moduleSlug: 'travel',
  });

  it('offers a card administrator the card tools once the module is on', () => {
    const admin = caps({
      permissions: [P.travel.request.approve],
      activeModules: ['travel'],
    });
    const names = visibleTools([gatedRead, gatedWrite], admin, 'chat').map((t) => t.name);
    expect(names).toContain('close_gated_thing');
    expect(names).toContain('list_gated_things');
  });

  it('module activity alone does not grant the permissioned card tool', () => {
    // The pair matters: turning a module on must not hand out its privileged actions.
    const moduleOnly = caps({ activeModules: ['travel'] });
    const names = visibleTools([gatedRead, gatedWrite], moduleOnly, 'chat').map((t) => t.name);
    expect(names).toContain('list_gated_things');
    expect(names).not.toContain('close_gated_thing');
  });

  it('treats an undeclared surface list as both surfaces', () => {
    // The default has to be permissive, or every tool added without thinking about surfaces
    // would vanish from both of them.
    expect(onSurface(spec(), 'chat')).toBe(true);
    expect(onSurface(spec(), 'mcp')).toBe(true);
  });

  it('offers a surface-restricted tool only where it is declared', () => {
    const t = spec({ surfaces: ['mcp'] });
    expect(onSurface(t, 'mcp')).toBe(true);
    expect(onSurface(t, 'chat')).toBe(false);
    // Restriction is about the surface, not the person: a caller holding everything still
    // does not see it on the wrong one.
    expect(visibleTools([t], caps(), 'chat')).toEqual([]);
    expect(visibleTools([t], caps(), 'mcp')).toEqual([t]);
  });

  it('keeps the receipt-registration tool out of the chat and in MCP', () => {
    // The panel PUTs and registers over tRPC the moment the press lands, so the chat model
    // has no business carrying an S3 key across a turn boundary.
    const chat = forSurface(TOOLS, 'chat').map((t) => t.name);
    const mcp = forSurface(TOOLS, 'mcp').map((t) => t.name);
    expect(chat).not.toContain('register_uploaded_receipt');
    expect(mcp).toContain('register_uploaded_receipt');
    // The two tools that START the flow are on both — filing a receipt from an MCP client is
    // a first-class path, not a degraded one.
    for (const name of ['start_expense_report_from_receipts', 'add_receipts_to_expense_report']) {
      expect(chat, name).toContain(name);
      expect(mcp, name).toContain(name);
    }
  });

  it('emits JSON Schema from the same Zod schema that validates the call', () => {
    const def = toToolDefinition(spec());
    expect(def.name).toBe('do_thing');
    expect(def.input_schema).toMatchObject({
      type: 'object',
      properties: { id: expect.objectContaining({ type: 'string' }) },
      required: ['id'],
    });
  });

  it('produces wire definitions only for visible tools', () => {
    const defs = toolDefinitionsFor(TOOLS, caps(), 'chat');
    expect(defs.map((d) => d.name)).not.toContain('list_budgets');
    for (const def of defs) {
      expect(def.input_schema).toHaveProperty('type', 'object');
    }
  });
});
