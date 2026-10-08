import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * Business units — the thinnest of the four lookup pages, and the one that pins the
 * contract the other three inherit.
 *
 * The shell (`AdminLookupPage`) is tested on its own. What is only testable HERE is the
 * wiring: which procedures this page talks to, and the exact shape of the payloads its
 * two builders produce. Those builders are the reason the same shell can serve four
 * entities, and a mistake in one is invisible — the drawer closes, the list refetches,
 * and the wrong thing was written.
 *
 * Two shapes carry real weight:
 *
 *   · **A description nobody typed is `null`, not an empty locale map.** `{en:'',fr:''}`
 *     is a description that exists and says nothing, which then renders as an empty
 *     block on every surface that shows one.
 *   · **External ids go over as a MAP**, converted from the editor's entry rows. Sending
 *     the rows would write an array into a Json column every reader treats as an object.
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
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
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

import { BusinessUnitsAdmin } from './BusinessUnitsAdmin';

const AT = new Date('2026-08-01T12:00:00Z');

const unit = (over: Record<string, unknown> = {}) => ({
  id: 'bu-1',
  code: 'atlantic',
  label: { en: 'Atlantic', 'fr-CA': 'Atlantique' },
  description: null,
  externalIds: {},
  active: true,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

function setTrpc(items: unknown[] = [unit()], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'businessUnits.list': { data: { items }, ...over.queries?.['businessUnits.list'] },
      'savedViews.list': { data: [] },
      ...over.queries,
    },
  });
}

const show = (canWrite = true) => render(<BusinessUnitsAdmin canWrite={canWrite} />);
/** The page's primary action lives in the global top bar. */
const showTopBar = () => render(<div>{h.topBarRight}</div>);

const openCreate = async (user: ReturnType<typeof userEvent.setup>) => {
  showTopBar();
  await user.click(screen.getByRole('button', { name: /admin.businessUnits.addNew/ }));
};
const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'admin.common.save' }));
const type = (user: ReturnType<typeof userEvent.setup>, label: string, value: string) =>
  user.type(screen.getByLabelText(new RegExp(label)), value);

beforeEach(() => {
  h.topBarRight = null;
  setTrpc();
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('the list', () => {
  it('asks for the inactive rows too, and hides them behind the status pill', () => {
    /**
     * The page has to LOAD them — a deactivated unit is still findable by clearing the
     * pill, and a request that filtered them out server-side would make that impossible.
     */
    const onCall = vi.fn();
    setTrpc([unit()], { queries: { 'businessUnits.list': { data: { items: [unit()] }, onCall } } });
    show();
    expect(onCall).toHaveBeenCalledWith({ includeInactive: true });
  });

  it('shows a unit by its label in the reader’s language', () => {
    show();
    expect(screen.getByText('Atlantic')).toBeInTheDocument();
  });

  it('hides a deactivated unit until the pill is cleared', async () => {
    const user = userEvent.setup();
    setTrpc([unit(), unit({ id: 'bu-2', label: { en: 'Retired West' }, active: false })]);
    show();
    expect(screen.queryByText('Retired West')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    expect(await screen.findByText('Retired West')).toBeInTheDocument();
  });

  it('offers Add only to somebody who may write', () => {
    show(false);
    expect(h.topBarRight).toBeNull();
  });
});

describe('creating one', () => {
  it('sends both labels as a locale map', async () => {
    /**
     * Both languages at once, because the row is read in both — a unit created with
     * only English shows an id to every French reader.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([unit()], { mutations: { 'businessUnits.create': { onCall } } });
    show();
    await openCreate(user);
    await type(user, 'admin.common.labelEn', 'Pacific');
    await type(user, 'admin.common.labelFr', 'Pacifique');
    await save(user);
    expect(onCall).toHaveBeenCalledWith(
      expect.objectContaining({ label: { en: 'Pacific', 'fr-CA': 'Pacifique' } }),
    );
  });

  it('sends no description at all when neither was typed', async () => {
    // `{en:'',fr-CA:''}` is a description that exists and says nothing.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([unit()], { mutations: { 'businessUnits.create': { onCall } } });
    show();
    await openCreate(user);
    await type(user, 'admin.common.labelEn', 'Pacific');
    await type(user, 'admin.common.labelFr', 'Pacifique');
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({ description: null });
  });

  it('sends a description as a locale map when one was typed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([unit()], { mutations: { 'businessUnits.create': { onCall } } });
    show();
    await openCreate(user);
    await type(user, 'admin.common.labelEn', 'Pacific');
    await type(user, 'admin.common.labelFr', 'Pacifique');
    await type(user, 'admin.common.descriptionEn', 'West coast');
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({
      description: { en: 'West coast', 'fr-CA': '' },
    });
  });

  it('creates the unit active', async () => {
    // A unit created inactive would be invisible in every picker that uses it.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([unit()], { mutations: { 'businessUnits.create': { onCall } } });
    show();
    await openCreate(user);
    await type(user, 'admin.common.labelEn', 'Pacific');
    await type(user, 'admin.common.labelFr', 'Pacifique');
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({ active: true });
  });

  it('sends external ids as a map rather than the editor’s rows', async () => {
    /**
     * The column is a Json object keyed by system. An array would be written happily
     * and read as empty by everything that looks up `externalIds.netsuite`.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([unit()], { mutations: { 'businessUnits.create': { onCall } } });
    show();
    await openCreate(user);
    await type(user, 'admin.common.labelEn', 'Pacific');
    await type(user, 'admin.common.labelFr', 'Pacifique');
    await save(user);
    expect(onCall.mock.calls[0][0].externalIds).toEqual({});
  });

  it('will not save without both labels', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([unit()], { mutations: { 'businessUnits.create': { onCall } } });
    show();
    await openCreate(user);
    await type(user, 'admin.common.labelEn', 'Pacific');
    await save(user);
    expect(onCall).not.toHaveBeenCalled();
  });
});

describe('editing one', () => {
  it('patches the row it opened, carrying its existing ids', async () => {
    /**
     * The patch is built from the FORM, so anything the form failed to load would be
     * written back as empty — which is how an external id mapping disappears.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([unit({ externalIds: { netsuite: 'NS-4' } })], {
      mutations: { 'businessUnits.update': { onCall } },
    });
    show();
    await user.click(screen.getByText('Atlantic'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await save(user);
    expect(onCall).toHaveBeenCalledWith({
      id: 'bu-1',
      patch: expect.objectContaining({
        label: { en: 'Atlantic', 'fr-CA': 'Atlantique' },
        externalIds: { netsuite: 'NS-4' },
      }),
    });
  });

  it('keeps a description that was already there', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([unit({ description: { en: 'East coast', 'fr-CA': 'Côte est' } })], {
      mutations: { 'businessUnits.update': { onCall } },
    });
    show();
    await user.click(screen.getByText('Atlantic'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await save(user);
    expect(onCall.mock.calls[0][0].patch).toMatchObject({
      description: { en: 'East coast', 'fr-CA': 'Côte est' },
    });
  });
});

describe('deactivating one', () => {
  it('flips the row rather than deleting it', async () => {
    /**
     * Expenses and cards reference a unit; deleting it would orphan them. Deactivating
     * keeps the history readable and takes it out of the pickers.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([unit()], { mutations: { 'businessUnits.setActive': { onCall } } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    show();
    const cell = screen.getByText('Atlantic').closest('div.flex') as HTMLElement;
    await user.click(within(cell).getByRole('button', { name: 'admin.common.actions' }));
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(onCall).toHaveBeenCalledWith({ id: 'bu-1', active: false });
  });
});
