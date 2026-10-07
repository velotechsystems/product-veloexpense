/**
 * The sidebar's menu, as data — ExpenseOS's `Sidebar.nav.test.ts`, ported.
 *
 * Their GA readiness F01 found four menu items parked on `/dashboard`: "a menu
 * entry that lies about what exists". So every `href` here must resolve to a real
 * `app/**\/page.tsx`, every label to a catalogue sentence, and every gate must hide
 * what the page itself would refuse.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_COPY } from '@/lib/i18n/catalog/ui';
import { SECTIONS, isActive, shellFree, visibleSections } from '@/lib/nav/sections';

const ROOT = join(__dirname, '..');
const items = SECTIONS.flatMap((s) => s.items);
const pageFor = (href: string) => join(ROOT, 'app', href === '/' ? '' : href.slice(1), 'page.tsx');

const NONE = new Set<string>();
const ALL_MODULES = new Set(['analytics', 'budgets', 'compliance']);

describe('nav sections — every entry is real', () => {
  it.each(items.map((i) => [i.href]))('%s is a page in app/', (href) => {
    expect(existsSync(pageFor(href)), `no app${href}/page.tsx`).toBe(true);
  });

  it('no two entries share a destination', () => {
    const hrefs = items.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('every label and section heading is a catalogue key', () => {
    const keys = [...items.map((i) => i.label), ...SECTIONS.map((s) => s.label).filter(Boolean)];
    for (const k of keys) expect(UI_COPY, k as string).toHaveProperty([k as string]);
  });

  it('no two entries a reader can see at once share a label', () => {
    const labels = visibleSections({ isAdmin: true, enabledModules: ALL_MODULES })
      .flatMap((s) => s.items)
      .map((i) => UI_COPY[i.label]['en-CA']);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('nav sections — the menu mirrors each page gate', () => {
  it('an admin item is exactly a page that gates on asAdminPage', () => {
    // `/` is the one page whose actions use BOTH gates: every member reads it, and
    // only its setup checklist is admin-gated (`app/actions.ts`).
    for (const item of items.filter((i) => i.href !== '/')) {
      const src = readFileSync(pageFor(item.href), 'utf8');
      // The page, or the actions module it reads through, is where the gate lives.
      const actions = join(pageFor(item.href), '..', 'actions.ts');
      const gated =
        /asAdminPage/.test(src) || (existsSync(actions) && /asAdminPage/.test(readFileSync(actions, 'utf8')));
      expect(gated, `${item.href}: admin flag ${item.admin === true}, page gate ${gated}`).toBe(
        item.admin === true,
      );
    }
  });

  it('an employee sees no admin item, whatever modules are on', () => {
    const seen = visibleSections({ isAdmin: false, enabledModules: ALL_MODULES }).flatMap((s) => s.items);
    expect(seen.some((i) => i.admin)).toBe(false);
    expect(seen.map((i) => i.href)).toEqual([
      '/',
      '/notifications',
      '/expenses',
      '/approvals',
      '/approvals/delegations',
      '/preferences',
      '/notifications/preferences',
    ]);
  });

  it('a module-gated item disappears with its module, and nothing else does', () => {
    const on = visibleSections({ isAdmin: true, enabledModules: ALL_MODULES }).flatMap((s) => s.items);
    const off = visibleSections({ isAdmin: true, enabledModules: NONE }).flatMap((s) => s.items);
    const gone = on.filter((i) => !off.includes(i)).map((i) => i.href);
    expect(gone.sort()).toEqual(['/admin/analytics', '/admin/budgets', '/admin/compliance']);
  });

  it('an emptied section is dropped rather than drawn as a bare heading', () => {
    const labels = visibleSections({ isAdmin: false, enabledModules: NONE }).map((s) => s.label);
    expect(labels).not.toContain('nav.sidebar.section.finance');
    expect(labels).not.toContain('nav.sidebar.section.administration');
    expect(labels).not.toContain('nav.sidebar.section.compliance');
  });

  it('only Approvals carries the pending count', () => {
    expect(items.filter((i) => i.badge).map((i) => i.href)).toEqual(['/approvals']);
  });
});

describe('isActive — exactly one row lights up', () => {
  it.each([
    ['/', '/', true],
    ['/expenses', '/', false],
    ['/approvals', '/approvals', true],
    ['/approvals/delegations', '/approvals', false],
    ['/approvals/delegations', '/approvals/delegations', true],
    ['/expenses/abc/edit', '/expenses', true],
    ['/expensesxyz', '/expenses', false],
    ['/notifications/preferences', '/notifications', false],
    ['/notifications/preferences', '/notifications/preferences', true],
    ['/admin/employees/invite', '/admin/employees', true],
  ])('on %s, %s is %s', (pathname, href, want) => {
    const item = items.find((i) => i.href === href)!;
    expect(isActive(href, item.exact === true, pathname)).toBe(want);
  });

  it('every page in the menu lights exactly its own row', () => {
    for (const page of items) {
      const lit = items.filter((i) => isActive(i.href, i.exact === true, page.href));
      expect(lit.map((i) => i.href), page.href).toEqual([page.href]);
    }
  });
});

describe('shellFree', () => {
  it.each([
    ['/login', true],
    ['/login/verify', true],
    ['/signup', true],
    ['/approve/tok123', true],
    ['/invite/abc', true],
    ['/', false],
    ['/loginx', false],
    ['/expenses', false],
    ['/admin/employees/invite', false],
  ])('%s → %s', (path, want) => {
    expect(shellFree(path)).toBe(want);
  });
});
