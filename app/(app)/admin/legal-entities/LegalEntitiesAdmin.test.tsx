import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * Legal entities — the lookup whose extra fields have teeth.
 *
 * Three columns beyond the shared shape, and each one decides something downstream:
 *
 *   · **`itcRecoverable`** decides whether an expense booked to this entity reclaims its
 *     GST/HST at all. The column is `@default(true)`, and the create form used to send
 *     an explicit `false` because its checkbox started unticked — so every entity made
 *     through the UI began unable to reclaim input tax, silently, surfacing later as
 *     zero recoverable tax on every expense and a missing column on the printed report.
 *     The box now starts at the column's own default.
 *   · **`homeCurrencyId` is a foreign key**, so the picker hands back an ID. It used to
 *     hand back a code, which wrote a value the column could not resolve.
 *   · **`country`** is a closed vocabulary, uppercased on the way in, because a lowercase
 *     code matches nothing in the tax-rate lookup.
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
/** The pickers are Base UI popovers; a native <select> is enough to drive them. */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Combobox: ({
      id,
      items,
      value,
      onValueChange,
      placeholder,
    }: {
      id?: string;
      items: { value: string; label: string }[];
      value: string | null;
      onValueChange: (v: string | null) => void;
      placeholder?: string;
    }) => (
      <select id={id} value={value ?? ''} onChange={(e) => onValueChange(e.target.value || null)}>
        <option value="">{placeholder ?? '—'}</option>
        {items.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
      </select>
    ),
  };
});

import { LegalEntitiesAdmin } from './LegalEntitiesAdmin';

const AT = new Date('2026-08-01T12:00:00Z');

const entity = (over: Record<string, unknown> = {}) => ({
  id: 'le-1',
  code: 'eblock-canada',
  label: { en: 'EBlock Canada', 'fr-CA': 'EBlock Canada' },
  description: null,
  externalIds: {},
  active: true,
  createdAt: AT,
  updatedAt: AT,
  country: 'CA',
  homeCurrency: { code: 'CAD' },
  homeCurrencyId: 'cur-cad',
  itcRecoverable: true,
  ...over,
});

const CURRENCIES = [
  { id: 'cur-cad', code: 'CAD', symbol: '$', label: { en: 'Canadian Dollar' } },
  { id: 'cur-usd', code: 'USD', symbol: 'US$', label: { en: 'US Dollar' } },
];

function setTrpc(items: unknown[] = [entity()], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'legalEntities.list': { data: { items }, ...over.queries?.['legalEntities.list'] },
      'appSettings.currencies.list': { data: CURRENCIES },
      'savedViews.list': { data: [] },
      ...over.queries,
    },
  });
}

const show = (canWrite = true) => render(<LegalEntitiesAdmin canWrite={canWrite} />);
const showTopBar = () => render(<div>{h.topBarRight}</div>);

const openCreate = async (user: ReturnType<typeof userEvent.setup>) => {
  showTopBar();
  await user.click(screen.getByRole('button', { name: /admin.legalEntities.addNew/ }));
};
const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'admin.common.save' }));
const type = (user: ReturnType<typeof userEvent.setup>, label: string, value: string) =>
  user.type(screen.getByLabelText(new RegExp(label)), value);
/** Fill the two required labels so Save is reachable. */
const nameIt = async (user: ReturnType<typeof userEvent.setup>) => {
  await type(user, 'admin.common.labelEn', 'EBlock US');
  await type(user, 'admin.common.labelFr', 'EBlock US');
};

const row = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

/**
 * The cell in a row that sits under a given column header.
 *
 * Several columns fall back to an em dash, so "the page shows a dash" says nothing —
 * WHICH column is dashed is the assertion.
 */
const cellUnder = (rowText: string, header: string) => {
  const headers = screen.getAllByRole('columnheader').map((th) => th.textContent ?? '');
  const index = headers.findIndex((h) => h.includes(header));
  const cells = within(row(rowText)).getAllByRole('cell');
  // The leading cells (selection, drag handle) have no header of their own.
  return cells[cells.length - (headers.length - index)];
};

beforeEach(() => {
  h.topBarRight = null;
  setTrpc();
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('the extra columns', () => {
  it('shows the country as a name and a code, not a bare code', () => {
    /**
     * One rendering of a country across the product — a raw `CA` in a grey chip read as
     * a different thing on every page that did it differently.
     */
    show();
    expect(within(row('EBlock Canada')).getByText('Canada')).toBeInTheDocument();
    expect(within(row('EBlock Canada')).getByText('CA')).toBeInTheDocument();
  });

  it('dashes the country on an entity that has none', () => {
    setTrpc([entity({ country: null })]);
    show();
    expect(cellUnder('EBlock Canada', 'admin.common.country')).toHaveTextContent('—');
  });

  it('shows the home currency by its code', () => {
    show();
    expect(within(row('EBlock Canada')).getByText('CAD')).toBeInTheDocument();
  });

  it('dashes a currency nobody set', () => {
    // Which is a real state, and the reason every money surface has a fallback.
    setTrpc([entity({ homeCurrency: null, homeCurrencyId: null })]);
    show();
    expect(cellUnder('EBlock Canada', 'admin.common.currency')).toHaveTextContent('—');
  });

  it('states whether input tax is recoverable, rather than leaving it implied', () => {
    show();
    expect(
      within(row('EBlock Canada')).getByText('admin.legalEntities.itcYes'),
    ).toBeInTheDocument();
  });

  it('states the negative just as plainly', () => {
    /**
     * A non-registrant or a US entity reclaims nothing, and that has to be readable at
     * a glance — it is what makes a report's recoverable column disappear.
     */
    setTrpc([entity({ itcRecoverable: false })]);
    show();
    expect(within(row('EBlock Canada')).getByText('admin.legalEntities.itcNo')).toBeInTheDocument();
  });
});

describe('the detail drawer', () => {
  it('repeats the three entity facts, so the row need not be decoded', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByText('EBlock Canada'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('admin.common.country')).toBeInTheDocument();
    expect(within(dialog).getByText('admin.common.currency')).toBeInTheDocument();
    expect(within(dialog).getByText('admin.legalEntities.itcRecoverable')).toBeInTheDocument();
  });

  it('dashes the currency in the drawer too', async () => {
    const user = userEvent.setup();
    setTrpc([entity({ homeCurrency: null })]);
    show();
    await user.click(screen.getByText('EBlock Canada'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('creating one', () => {
  it('starts able to reclaim input tax, matching the column’s own default', async () => {
    /**
     * The defect this pins: the box started unticked and the payload sent an explicit
     * `false`, overriding `@default(true)`. Every entity created through the UI began
     * non-recoverable, and nothing said so until an expense computed zero GST back.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([entity()], { mutations: { 'legalEntities.create': { onCall } } });
    show();
    await openCreate(user);
    await nameIt(user);
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({ itcRecoverable: true });
  });

  it('records a non-registrant when the box is cleared', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([entity()], { mutations: { 'legalEntities.create': { onCall } } });
    show();
    await openCreate(user);
    await nameIt(user);
    // VeloExpense: by role and name. The kit's checkbox now carries its own name (Base UI's
    // box is a <span role="checkbox"> the Field's <label for> never reached), so the label
    // text also matches Base UI's hidden input — two elements for one control.
    await user.click(screen.getByRole('checkbox', { name: /admin.legalEntities.itcRecoverable/ }));
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({ itcRecoverable: false });
  });

  it('sends the currency’s ID, because the column is a foreign key', async () => {
    // A code here would write something the relation cannot resolve.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([entity()], { mutations: { 'legalEntities.create': { onCall } } });
    show();
    await openCreate(user);
    await nameIt(user);
    await user.selectOptions(screen.getByLabelText(/admin.common.currency/), 'cur-usd');
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({ homeCurrencyId: 'CUR-USD' });
  });

  it('offers each currency by name and code, not by id', async () => {
    /**
     * The id is what gets stored and the code is what people recognise; showing the id
     * would make the picker unusable.
     */
    const user = userEvent.setup();
    show();
    await openCreate(user);
    expect(
      await screen.findByRole('option', { name: 'Canadian Dollar (CAD)' }),
    ).toBeInTheDocument();
  });

  it('sends the country uppercased', async () => {
    // The tax-rate lookup keys on the uppercase ISO code.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([entity()], { mutations: { 'legalEntities.create': { onCall } } });
    show();
    await openCreate(user);
    await nameIt(user);
    await user.selectOptions(screen.getByLabelText(/admin.common.country/), 'US');
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({ country: 'US' });
  });

  it('sends no country rather than an empty string when none was picked', async () => {
    /**
     * `''` is a country that exists and is blank; the column is nullable precisely so
     * "not stated" is expressible.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([entity()], { mutations: { 'legalEntities.create': { onCall } } });
    show();
    await openCreate(user);
    await nameIt(user);
    await save(user);
    expect(onCall.mock.calls[0][0]).toMatchObject({ country: null, homeCurrencyId: null });
  });
});

describe('editing one', () => {
  it('carries the entity’s three facts into the patch', async () => {
    /**
     * The patch is built from the form, so a fact the form failed to load is written
     * back as absent — which would quietly un-set an entity's currency.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([entity()], { mutations: { 'legalEntities.update': { onCall } } });
    show();
    await user.click(screen.getByText('EBlock Canada'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await save(user);
    expect(onCall).toHaveBeenCalledWith({
      id: 'le-1',
      patch: expect.objectContaining({
        country: 'CA',
        homeCurrencyId: 'CUR-CAD',
        itcRecoverable: true,
      }),
    });
  });

  it('keeps a non-registrant non-recoverable through an unrelated edit', async () => {
    // The one flag whose accidental flip changes what every past expense reclaims.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([entity({ itcRecoverable: false })], {
      mutations: { 'legalEntities.update': { onCall } },
    });
    show();
    await user.click(screen.getByText('EBlock Canada'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await save(user);
    expect(onCall.mock.calls[0][0].patch).toMatchObject({ itcRecoverable: false });
  });
});
