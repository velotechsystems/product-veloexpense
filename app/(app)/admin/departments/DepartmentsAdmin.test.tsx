import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * Departments — the lookup with a parent, and the one that is deliberately NOT a tree.
 *
 * The server returns rows in id order and the page re-sorts them A→Z by the label in the
 * reader's own language. That is the whole reason this file exists rather than reusing
 * the shell's default: a tree DFS by parent obscured the alphabetical lookup admins
 * actually want, and id order is not an order anybody can scan. The hierarchy is still
 * there — it lives in the drawer, and in the parent picker.
 *
 * Two consequences the tests pin:
 *
 *   · **Sorting is per-locale.** "Ingénierie" and "Engineering" sort to different places,
 *     so sorting on the English label and rendering the French one would produce a list
 *     that is alphabetical in neither.
 *   · **A parent is shown by NAME.** The row stores an id; printing it would make the
 *     one field that expresses the hierarchy unreadable.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown, topBarRight: null as ReactNode }));

// VeloExpense: ExpenseOS's tests are bilingual, so they run with French switched ON here
// (VeloExpense ships with it off, `ENABLED_LOCALES`); the French-off screen is covered by
// components/admin/AdminLookupPage.veloexpense.test.tsx.
vi.mock('@expenseos/i18n/locales', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ENABLED_LOCALES: ['en', 'fr-CA'],
}));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', () => ({
  useLocale: () => locale.current,
  useTranslations: (ns?: string) => {
    const t = (key: string, values?: Record<string, unknown>) => {
      const full = ns ? `${ns}.${key}` : key;
      return values ? `${full}:${Object.values(values).join(',')}` : full;
    };
    t.has = () => false;
    return t;
  },
}));
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => { right?: ReactNode }) => {
    h.topBarRight = builder().right ?? null;
  },
}));

import { DepartmentsAdmin } from './DepartmentsAdmin';

const AT = new Date('2026-08-01T12:00:00Z');

const dept = (id: string, en: string, over: Record<string, unknown> = {}) => ({
  id,
  code: id,
  label: { en, 'fr-CA': `${en}-fr` },
  description: null,
  externalIds: {},
  active: true,
  createdAt: AT,
  updatedAt: AT,
  parentId: null,
  ...over,
});

function setTrpc(items: unknown[] = [dept('eng', 'Engineering')], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'departments.list': { data: { items }, ...over.queries?.['departments.list'] },
      'savedViews.list': { data: [] },
      ...over.queries,
    },
  });
}

const show = (canWrite = true) => render(<DepartmentsAdmin canWrite={canWrite} />);
const showTopBar = () => render(<div>{h.topBarRight}</div>);

const openCreate = async (user: ReturnType<typeof userEvent.setup>) => {
  showTopBar();
  await user.click(screen.getByRole('button', { name: /admin.departments.addNew/ }));
};
const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'admin.common.save' }));
const type = (user: ReturnType<typeof userEvent.setup>, label: string, value: string) =>
  user.type(screen.getByLabelText(new RegExp(label)), value);
const nameIt = async (user: ReturnType<typeof userEvent.setup>) => {
  await type(user, 'admin.common.labelEn', 'Payroll');
  await type(user, 'admin.common.labelFr', 'Paie');
};

/**
 * Pick a parent through the real control.
 *
 * The schema-driven select renders the design system's Combobox from INSIDE the
 * package, so a mock of the package entry point never intercepts it — the listbox has
 * to be opened for real.
 */
const pickParent = async (user: ReturnType<typeof userEvent.setup>, optionLabel: string) => {
  await user.click(screen.getByLabelText(/admin.common.parent/));
  await user.click(await screen.findByRole('option', { name: optionLabel }));
};

/** Every option the parent picker offers, in order. */
const parentOptions = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByLabelText(/admin.common.parent/));
  return (await screen.findAllByRole('option')).map((o) => o.textContent);
};

/** The order the labels actually appear in the table. */
const order = (labels: string[]) => {
  const nodes = labels.map((l) => screen.getByText(l));
  return labels.filter(
    (_, i) =>
      i === 0 ||
      (nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
};

beforeEach(() => {
  locale.current = 'en';
  h.topBarRight = null;
  setTrpc();
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('the order of the list', () => {
  it('sorts A→Z by name, not by the id order the server returns', () => {
    /**
     * The rows arrive in id order, which is not an order anybody can scan — and a
     * lookup is scanned far more often than it is edited.
     */
    setTrpc([
      dept('z-first', 'Zoology'),
      dept('a-second', 'Accounting'),
      dept('m-third', 'Marketing'),
    ]);
    show();
    expect(order(['Accounting', 'Marketing', 'Zoology'])).toEqual([
      'Accounting',
      'Marketing',
      'Zoology',
    ]);
  });

  it('sorts on the label the reader actually sees', () => {
    /**
     * Sorting on English while rendering French produces a list alphabetical in
     * neither language.
     */
    locale.current = 'fr-CA';
    setTrpc([
      dept('b', 'Beta', { label: { en: 'Beta', 'fr-CA': 'Alpha-fr' } }),
      dept('a', 'Alpha', { label: { en: 'Alpha', 'fr-CA': 'Beta-fr' } }),
    ]);
    show();
    expect(order(['Alpha-fr', 'Beta-fr'])).toEqual(['Alpha-fr', 'Beta-fr']);
  });

  it('falls back to the id for a row with no usable label', () => {
    // Ugly, but findable — a blank cell is neither.
    setTrpc([dept('orphan-id', 'x', { label: {} })]);
    show();
    expect(screen.getByText('orphan-id')).toBeInTheDocument();
  });

  it('leaves an empty list empty rather than sorting nothing into something', () => {
    setTrpc([]);
    show();
    expect(screen.queryByRole('row', { name: /Engineering/ })).not.toBeInTheDocument();
  });

  it('asks for the inactive rows too', () => {
    const onCall = vi.fn();
    setTrpc([dept('eng', 'Engineering')], {
      queries: { 'departments.list': { data: { items: [dept('eng', 'Engineering')] }, onCall } },
    });
    show();
    expect(onCall).toHaveBeenCalledWith({ includeInactive: true });
  });
});

describe('the parent, in the drawer', () => {
  it('names the parent rather than printing its id', async () => {
    const user = userEvent.setup();
    setTrpc([dept('eng', 'Engineering'), dept('plat', 'Platform', { parentId: 'eng' })]);
    show();
    await user.click(screen.getByText('Platform'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('admin.common.parent')).toBeInTheDocument();
    expect(within(dialog).getByText('Engineering')).toBeInTheDocument();
  });

  it('says a top-level department has no parent', async () => {
    /**
     * A blank here reads as "we lost it"; most departments legitimately sit at the
     * top of the tree.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByText('Engineering'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('admin.common.noParent')).toBeInTheDocument();
  });

  it('shows a truncated id when the parent is not in the list', async () => {
    /**
     * A parent that was deactivated is filtered out of the row set, so its label is
     * unknown — a short id is still enough to look it up, where a blank is not.
     */
    const user = userEvent.setup();
    setTrpc([dept('plat', 'Platform', { parentId: 'abcdef01-2345-6789' })]);
    show();
    await user.click(screen.getByText('Platform'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('abcdef01')).toBeInTheDocument();
  });
});

describe('choosing a parent', () => {
  it('offers every department, sorted by name', async () => {
    /**
     * Every one, not just the top level: the server refuses a move that would create a
     * loop, so the picker does not need to pre-guess which ones are legal.
     */
    const user = userEvent.setup();
    setTrpc([dept('z', 'Zoology'), dept('a', 'Accounting')]);
    show();
    await openCreate(user);
    expect(await parentOptions(user)).toEqual(['—', 'Accounting', 'Zoology']);
  });

  it('sends the chosen parent', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([dept('eng', 'Engineering')], { mutations: { 'departments.create': { onCall } } });
    show();
    await openCreate(user);
    await nameIt(user);
    await pickParent(user, 'Engineering');
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({ parentId: 'eng' });
  });

  it('sends no parent rather than an empty string for a top-level department', async () => {
    /**
     * `parentId: ''` is not a null foreign key — it is a reference to a department
     * whose id is the empty string, and the write fails or dangles.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([dept('eng', 'Engineering')], { mutations: { 'departments.create': { onCall } } });
    show();
    await openCreate(user);
    await nameIt(user);
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({ parentId: null });
  });

  it('carries the existing parent through an edit', async () => {
    // The patch is built from the form, so a parent the form dropped would be unset.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([dept('eng', 'Engineering'), dept('plat', 'Platform', { parentId: 'eng' })], {
      mutations: { 'departments.update': { onCall } },
    });
    show();
    await user.click(screen.getByText('Platform'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await save(user);
    expect(onCall).toHaveBeenCalledWith({
      id: 'plat',
      patch: expect.objectContaining({ parentId: 'eng' }),
    });
  });

  it('can promote a department to the top level', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([dept('eng', 'Engineering'), dept('plat', 'Platform', { parentId: 'eng' })], {
      mutations: { 'departments.update': { onCall } },
    });
    show();
    await user.click(screen.getByText('Platform'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await pickParent(user, '—');
    await save(user);
    expect(onCall.mock.calls[0][0].patch).toMatchObject({ parentId: null });
  });
});

describe('the rest of the payload', () => {
  it('sends both labels and no description when none was typed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([dept('eng', 'Engineering')], { mutations: { 'departments.create': { onCall } } });
    show();
    await openCreate(user);
    await nameIt(user);
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({
      label: { en: 'Payroll', 'fr-CA': 'Paie' },
      description: null,
      active: true,
      externalIds: {},
    });
  });
});
