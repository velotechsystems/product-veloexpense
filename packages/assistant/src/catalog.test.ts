import type { CallerCapabilities } from '@expenseos/mcp-server';
import { TOOLS } from '@expenseos/mcp-server';
import { permissions as P } from '@expenseos/rbac';
import { describe, expect, it } from 'vitest';
import {
  activeModuleSummary,
  capabilityCatalog,
  explainUnavailable,
  helpContext,
  type ModuleFact,
} from './catalog';

const MODULES: ModuleFact[] = [
  {
    slug: 'expense-management',
    name: { en: 'Expense Management', 'fr-CA': 'Gestion des dépenses' },
    description: { en: 'Claim and approve expenses.', 'fr-CA': 'Réclamer et approuver.' },
    active: true,
  },
  {
    slug: 'virtual-credit-cards',
    name: { en: 'Virtual Credit Cards', 'fr-CA': 'Cartes de crédit virtuelles' },
    description: { en: 'Issue and control cards.', 'fr-CA': 'Émettre et contrôler.' },
    active: false,
  },
];

const caps = (over: Partial<CallerCapabilities> = {}): CallerCapabilities => ({
  permissions: [],
  activeModules: ['expense-management'],
  ...over,
});

describe('capabilityCatalog', () => {
  it('splits what the caller can and cannot do', () => {
    const { available, unavailable } = capabilityCatalog(TOOLS, caps());
    expect(available.length + unavailable.length).toBe(TOOLS.length);
    // VeloExpense (w6-03): `create_travel_request` stands in for `list_budgets` (not ported).
    expect(unavailable.map((u) => u.name)).toContain('create_travel_request');
    expect(available.map((a) => a.name)).toContain('get_expense_report');
  });

  it('marks which available actions will ask for confirmation', () => {
    const { available } = capabilityCatalog(TOOLS, caps());
    const decide = available.find((a) => a.name === 'decide_expense_report');
    const read = available.find((a) => a.name === 'get_expense_report');
    expect(decide?.confirms).toBe(true);
    expect(read?.confirms).toBe(false);
  });
});

describe('explainUnavailable', () => {
  it('names the permission to ask for', () => {
    const msg = explainUnavailable({ kind: 'permission', permission: P.budget.read }, MODULES);
    expect(msg).toContain('budget.read');
    expect(msg).toContain('Roles');
  });

  it('names the module by its display name, not its slug', () => {
    // "virtual-credit-cards isn't active" is a developer's sentence; nobody sees that
    // string anywhere in the product.
    const msg = explainUnavailable({ kind: 'module', moduleSlug: 'virtual-credit-cards' }, MODULES);
    expect(msg).toContain('Virtual Credit Cards');
    expect(msg).not.toContain('virtual-credit-cards');
  });

  it('falls back to the slug for a module it has no facts for', () => {
    const msg = explainUnavailable({ kind: 'module', moduleSlug: 'unknown-mod' }, MODULES);
    expect(msg).toContain('unknown-mod');
  });

  it('answers in French when asked', () => {
    const msg = explainUnavailable(
      { kind: 'module', moduleSlug: 'virtual-credit-cards' },
      MODULES,
      'fr-CA',
    );
    expect(msg).toContain('Cartes de crédit virtuelles');
    expect(msg).toContain('administrateur');
  });
});

describe('activeModuleSummary', () => {
  it('lists only modules that are switched on', () => {
    // Describing a page that is not there is the fastest way to make help untrustworthy.
    const summary = activeModuleSummary(MODULES);
    expect(summary).toContain('Expense Management');
    expect(summary).not.toContain('Virtual Credit Cards');
  });

  it('renders French names from the same descriptors', () => {
    expect(activeModuleSummary(MODULES, 'fr-CA')).toContain('Gestion des dépenses');
  });

  it('is empty when nothing is active', () => {
    expect(activeModuleSummary([])).toBe('');
  });
});

describe('helpContext', () => {
  it('tells the model what the person cannot do, and why', () => {
    const ctx = helpContext(TOOLS, caps(), MODULES);
    expect(ctx).toContain('Modules active');
    // VeloExpense (w6-03): `create_travel_request` stands in for `list_budgets` (not ported).
    expect(ctx).toContain('create_travel_request');
    expect(ctx).toContain(P.travel.request.createOwn);
  });

  it('omits the cannot-do section for a caller who can do everything', () => {
    // Derived from the registry rather than hand-listed: a literal list silently stops
    // meaning "everything" the day a tool declares a permission nobody added here, and the
    // test then fails for a tool that is perfectly fine.
    const superuser = caps({
      permissions: [...new Set(TOOLS.map((t) => t.permission).filter(Boolean))] as string[],
      activeModules: [...new Set(TOOLS.map((t) => t.moduleSlug).filter(Boolean))] as string[],
    });
    const ctx = helpContext(TOOLS, superuser, MODULES);
    expect(ctx).not.toContain('CANNOT');
  });
});
