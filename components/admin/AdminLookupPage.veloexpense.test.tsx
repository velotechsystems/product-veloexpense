import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock } from '@/test-utils/trpc';
import { buildLookupSchema, rjsfToAdmin } from './AdminLookupForm';
import { AdminLookupPage, type AdminLookupPageConfig, type BaseLookupRow } from './AdminLookupPage';

/**
 * VeloExpense: the ported admin-lookup shell as VeloExpense ships it. Not in ExpenseOS.
 * `AdminLookupPage.test.tsx` and `AdminLookupForm.test.ts` are ExpenseOS's own tests, run
 * with French switched on; this file covers the two VeloExpense differences:
 *
 *   · French is OFF (`ENABLED_LOCALES`, 7 Oct): no French name or description is asked
 *     for or shown, the English name alone saves, and a French name already on a row
 *     survives an edit untouched;
 *   · saved views since w4-08 (left out until then, d15): the page asks the server for its
 *     own list's views — ExpenseOS's own suite covers what the dropdown does with them.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown, topBarRight: null as ReactNode }));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) => {
    const full = ns ? `${ns}.${key}` : key;
    return values ? `${full}:${Object.values(values).join(',')}` : full;
  },
}));
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => { right?: ReactNode }) => {
    h.topBarRight = builder().right ?? null;
  },
}));

const AT = new Date('2026-08-01T12:00:00Z');
const unit = (id: string, label: Record<string, string>): BaseLookupRow => ({
  id,
  label,
  description: null,
  externalIds: {},
  active: true,
  createdAt: AT,
  updatedAt: AT,
});

function renderPage(items: BaseLookupRow[]) {
  const createMutateAsync = vi.fn().mockResolvedValue({});
  const updateMutateAsync = vi.fn().mockResolvedValue({});
  const config: AdminLookupPageConfig<BaseLookupRow, 'label' | 'externalIds' | 'status'> = {
    entityKey: 'businessUnits',
    savedViewsResource: 'businessUnits',
    canWrite: true,
    query: { data: { items }, isLoading: false, refetch: vi.fn() },
    // What BusinessUnitsAdmin sends: both keys, always.
    buildCreatePayload: (form) => ({ label: { en: form.labelEn, 'fr-CA': form.labelFr } }),
    buildUpdatePayload: (form) => ({ label: { en: form.labelEn, 'fr-CA': form.labelFr } }),
    createMutation: { mutateAsync: createMutateAsync, isPending: false },
    updateMutation: { mutateAsync: updateMutateAsync, isPending: false },
    setActiveMutation: { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false },
  };
  render(<AdminLookupPage config={config} />);
  return { createMutateAsync, updateMutateAsync };
}

async function openRow(user: ReturnType<typeof userEvent.setup>, label: string, action: string) {
  const cell = screen.getByText(label).closest('div.flex') as HTMLElement;
  await user.click(within(cell).getByRole('button', { name: 'admin.common.actions' }));
  await user.click(screen.getByText(action));
}

beforeEach(() => {
  h.trpc = createTrpcMock({ queries: { 'pickers.externalIdSources': { data: [] } } });
  h.topBarRight = null;
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('French switched off', () => {
  it('asks for the English name only, and requires only it', () => {
    const { schema, uiSchema } = buildLookupSchema({
      mode: 'create',
      labels: {
        labelEn: 'EN',
        labelFr: 'FR',
        descriptionEn: 'DEN',
        descriptionFr: 'DFR',
        externalIds: 'X',
        externalIdsHelp: '',
        active: 'A',
        editor: { key: '', value: '', addRow: '', removeRow: '', help: '' },
      },
    });
    expect(schema.required).toEqual(['labelEn']);
    expect(Object.keys(schema.properties ?? {})).not.toContain('labelFr');
    expect(Object.keys(schema.properties ?? {})).not.toContain('descriptionFr');
    expect(uiSchema['ui:order']).toEqual(['labelEn', 'descriptionEn', 'externalIds', 'active']);
  });

  it('carries a saved French name through the form untouched', () => {
    // The field is not rendered, but the row's French name is still in the form data.
    const form = rjsfToAdmin(
      {
        labelEn: 'Head Office',
        labelFr: 'Siège social',
        descriptionEn: '',
        descriptionFr: '',
        externalIds: [],
        active: true,
      },
      undefined,
    );
    expect(form.labelFr).toBe('Siège social');
  });

  it('creates from the English name alone', async () => {
    const user = userEvent.setup();
    const { createMutateAsync } = renderPage([]);
    render(<div>{h.topBarRight}</div>);
    await user.click(screen.getByText(/addNew/));
    expect(screen.queryByLabelText(/admin\.common\.labelFr/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/admin\.common\.descriptionFr/)).not.toBeInTheDocument();
    await user.type(await screen.findByLabelText(/admin\.common\.labelEn/), 'Atlantic');
    await user.click(screen.getByRole('button', { name: /admin\.common\.save/ }));
    // The empty French is sent as the wrapper builds it; the router leaves it out
    // (server/routers/adminLookup.ts `labelSchema`).
    expect(createMutateAsync).toHaveBeenCalledWith({ label: { en: 'Atlantic', 'fr-CA': '' } });
  });

  it('keeps an existing French name when only the English one is edited', async () => {
    const user = userEvent.setup();
    const { updateMutateAsync } = renderPage([
      unit('hq', { en: 'Head Office', 'fr-CA': 'Siège social' }),
    ]);
    await openRow(user, 'Head Office', 'admin.common.edit');
    const en = await screen.findByLabelText(/admin\.common\.labelEn/);
    await user.clear(en);
    await user.type(en, 'Head Office East');
    await user.click(screen.getByRole('button', { name: /admin\.common\.save/ }));
    expect(updateMutateAsync).toHaveBeenCalledWith({
      id: 'hq',
      patch: { label: { en: 'Head Office East', 'fr-CA': 'Siège social' } },
    });
  });

  it('does not show a French row in the detail drawer', async () => {
    const user = userEvent.setup();
    renderPage([unit('hq', { en: 'Head Office', 'fr-CA': 'Siège social' })]);
    await openRow(user, 'Head Office', 'admin.common.view');
    expect(await screen.findByText('admin.common.labelEn')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.labelFr')).not.toBeInTheDocument();
    expect(screen.queryByText('Siège social')).not.toBeInTheDocument();
  });
});

describe('saved views (w4-08)', () => {
  it("asks the server for this list's own saved views", () => {
    const savedViewsList = vi.fn();
    h.trpc = createTrpcMock({
      queries: {
        'pickers.externalIdSources': { data: [] },
        'savedViews.list': { data: [], onCall: savedViewsList },
      },
    });
    renderPage([unit('hq', { en: 'Head Office' })]);
    expect(savedViewsList).toHaveBeenCalledWith({ resource: 'businessUnits' }, expect.anything());
  });
});
