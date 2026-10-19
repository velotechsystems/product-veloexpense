import type { CallerCapabilities, ToolSpec } from '@expenseos/mcp-server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSystemPrompt } from './prompt';

const spec = (over: Partial<ToolSpec>): ToolSpec => ({
  name: 'get_expense_report',
  description: 'Read one expense report.',
  input: z.object({ reportId: z.string() }),
  path: 'expenses.report',
  kind: 'read',
  scope: 'expense_management.expense_report',
  access: 'read',
  ...over,
});

const modules = [
  {
    slug: 'budgets',
    name: { en: 'Budgets', 'fr-CA': 'Budgets' },
    description: { en: 'Track spend against plan.', 'fr-CA': 'Suivre les dépenses.' },
    active: false,
  },
];

const base = {
  specs: [spec({})],
  capabilities: { permissions: [], activeModules: [] } as CallerCapabilities,
  modules,
  locale: 'en' as const,
  actorName: 'Ana Silva',
  now: new Date('2026-08-18T12:00:00Z'),
};

describe('buildSystemPrompt', () => {
  it('caches the stable half and only the stable half', () => {
    // A breakpoint on the volatile block would cache a prefix that changes every turn —
    // more expensive than not caching, and invisible until the bill arrives.
    const [stable, volatile] = buildSystemPrompt(base);
    expect(stable.cache_control).toEqual({ type: 'ephemeral' });
    expect(volatile.cache_control).toBeUndefined();
  });

  it('puts what changes per turn in the volatile block, not the cached one', () => {
    const [stable, volatile] = buildSystemPrompt({
      ...base,
      screen: { route: '/expenses/[reportId]', entityIds: { reportId: 'r-1' } },
    });
    expect(volatile.text).toContain('Ana Silva');
    expect(volatile.text).toContain('2026-08-18');
    expect(volatile.text).toContain('/expenses/[reportId]');
    expect(stable.text).not.toContain('Ana Silva');
    expect(stable.text).not.toContain('r-1');
  });

  it('states the rule that stops the screen hijacking a question about another record', () => {
    // The failure this prevents is the convincing kind: right shape, right vocabulary,
    // wrong record.
    const [, volatile] = buildSystemPrompt({
      ...base,
      screen: { route: '/expenses/[reportId]', entityIds: { reportId: 'r-124' } },
    });
    expect(volatile.text).toMatch(/never silently substitute/i);
    expect(volatile.text).toMatch(/default subject/i);
  });

  it('omits the screen section entirely when there is no screen', () => {
    const [, volatile] = buildSystemPrompt(base);
    expect(volatile.text).not.toMatch(/currently on/i);
  });

  it('forbids computing a figure, in the cached rules', () => {
    // The single rule this whole design exists to enforce.
    const [stable] = buildSystemPrompt(base);
    expect(stable.text).toMatch(/never calculate, estimate or infer a financial figure/i);
  });

  it('carries the reason a capability is out of reach', () => {
    const [stable] = buildSystemPrompt({
      ...base,
      specs: [spec({ name: 'list_budgets', moduleSlug: 'budgets' })],
    });
    expect(stable.text).toContain('list_budgets');
    expect(stable.text).toMatch(/Budgets.*isn't active/i);
  });

  it('switches the whole rule set to French, not just the labels', () => {
    const [stable] = buildSystemPrompt({ ...base, locale: 'fr-CA' });
    // VeloExpense (w6-03): the product's own name.
    expect(stable.text).toMatch(/assistant VeloExpense/);
    expect(stable.text).not.toMatch(/Never calculate/);
  });

  it('leaves a seam for a knowledge base without one existing', () => {
    const without = buildSystemPrompt(base)[0].text;
    const withKb = buildSystemPrompt({ ...base, knowledge: 'How to add a tip: …' })[0].text;
    expect(without).not.toMatch(/Knowledge base/);
    expect(withKb).toContain('How to add a tip');
  });

  it('ignores empty knowledge rather than emitting a heading with nothing under it', () => {
    expect(buildSystemPrompt({ ...base, knowledge: '   ' })[0].text).not.toMatch(/Knowledge base/);
  });
});

describe('quoting authored guidance', () => {
  it('separates a documented rate from a figure about somebody’s record', () => {
    // Before this, the rule read "every number you state must have come back from a tool", which
    // made a corpus unusable: an article saying meals are 50% recoverable is not a tool, so the
    // assistant could retrieve correct guidance and then decline to state it.
    const en = buildSystemPrompt(base)[0].text;
    expect(en).toContain('ABOUT A SPECIFIC RECORD');
    expect(en).toMatch(/documented rule, and you may quote it as one/);
    // The half that must survive: it may quote a rate, never apply one.
    expect(en).toMatch(/never do is apply such a rate to somebody's numbers yourself/);
  });

  it('keeps the same distinction in French', () => {
    const fr = buildSystemPrompt({ ...base, locale: 'fr-CA' })[0].text;
    expect(fr).toContain("AU SUJET D'UN ENREGISTREMENT PRÉCIS");
    expect(fr).toMatch(/règle documentée/);
  });
});

describe('the FR-CA glossary', () => {
  it('is emitted only on a French turn', () => {
    // 200 tokens of French vocabulary in every English prefix would be 200 tokens of nothing.
    expect(buildSystemPrompt({ ...base, locale: 'fr-CA' })[0].text).toContain('CTI');
    expect(buildSystemPrompt(base)[0].text).not.toContain('crédit de taxe sur les intrants');
  });

  it('names the wrong translation explicitly, not just the right one', () => {
    // "Input tax credit" renders naturally as crédit d'impôt — an INCOME-tax credit. Somebody
    // reading that would be misinformed about their own tax position with no way to tell, so the
    // glossary has to rule the plausible answer out rather than only offer the correct one.
    const fr = buildSystemPrompt({ ...base, locale: 'fr-CA' })[0].text;
    expect(fr).toContain('crédit de taxe sur les intrants');
    expect(fr).toMatch(/NEVER "crédit d'impôt"/);
  });

  it('uses the wording the product already ships', () => {
    // Lifted from packages/i18n/src/catalogs/fr-CA — an answer that invents its own synonym for
    // a screen the person is looking at is an answer they cannot follow.
    const fr = buildSystemPrompt({ ...base, locale: 'fr-CA' })[0].text;
    for (const term of [
      'CTI récupérable',
      'TPS/TVH',
      'TVQ',
      'note de frais',
      'indemnité journalière',
    ]) {
      expect(fr, term).toContain(term);
    }
  });

  it('sits inside the cached block, since it never varies', () => {
    const blocks = buildSystemPrompt({ ...base, locale: 'fr-CA' });
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].text).not.toContain('CTI');
  });
});
