import type { CallerCapabilities, ToolSpec } from '@expenseos/mcp-server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { suggestedCapabilities } from './catalog';

const tool = (name: string, over: Partial<ToolSpec> = {}): ToolSpec => ({
  name,
  description: name,
  input: z.object({}),
  path: `x.${name}`,
  kind: 'read',
  scope: 'expense_management.expense_report',
  access: 'read',
  ...over,
});

const SPECS: ToolSpec[] = [
  tool('list_my_expense_reports', { permission: 'expense.report.readOwn' }),
  tool('explain_expense_tax'),
  tool('list_budgets', { permission: 'budget.read', moduleSlug: 'finance-reporting' }),
  tool('list_virtual_cards', { moduleSlug: 'virtual-credit-cards' }),
];

const caps = (over: Partial<CallerCapabilities> = {}): CallerCapabilities => ({
  permissions: [],
  activeModules: [],
  ...over,
});

describe('suggestedCapabilities', () => {
  it('offers only what this person can actually do', () => {
    // A suggestion that comes back refused reads as the product being broken rather than as
    // a permission they do not hold.
    const out = suggestedCapabilities(SPECS, caps({ permissions: ['expense.report.readOwn'] }));
    expect(out).toContain('list_my_expense_reports');
    expect(out).not.toContain('list_budgets');
  });

  it('hides a capability whose module is switched off', () => {
    // The fastest way to make a help system untrustworthy is to have it explain a page that
    // is not there.
    const off = suggestedCapabilities(SPECS, caps({ permissions: ['budget.read'] }));
    const on = suggestedCapabilities(
      SPECS,
      caps({ permissions: ['budget.read'], activeModules: ['finance-reporting'] }),
    );
    expect(off).not.toContain('list_budgets');
    expect(on).toContain('list_budgets');
  });

  it('keeps the list short enough to read', () => {
    const out = suggestedCapabilities(
      SPECS,
      caps({
        permissions: ['expense.report.readOwn', 'budget.read'],
        activeModules: ['finance-reporting', 'virtual-credit-cards'],
      }),
      2,
    );
    expect(out).toHaveLength(2);
  });

  it('suggests nothing it cannot deliver', () => {
    expect(suggestedCapabilities(SPECS, caps())).toEqual(['explain_expense_tax']);
  });
});
