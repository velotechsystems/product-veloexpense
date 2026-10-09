import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * VeloExpense: /admin/fiscal-years as VeloExpense ships it, with French switched OFF
 * (`ENABLED_LOCALES`, 7 Oct). Not in ExpenseOS. `FiscalYearsAdmin.test.tsx` is ExpenseOS's
 * own test, run with French on; this covers the difference:
 *
 *   · no French label is asked for or shown;
 *   · the English label alone saves, and an empty French one is not sent;
 *   · a French label already on a row survives an edit untouched;
 *   · a missing English label is reported as such, not as "both labels".
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown, topBar: {} as Record<string, ReactNode> }));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const fn = (k: string, values?: Record<string, unknown>) => {
      const full = ns ? `${ns}.${k}` : k;
      return values ? `${full}:${Object.values(values).join(',')}` : full;
    };
    (fn as { has?: () => boolean }).has = () => false;
    return fn;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => Record<string, ReactNode>) => {
    h.topBar = builder();
  },
}));

import { FiscalYearsAdmin } from './FiscalYearsAdmin';

const iso = (d: string) => new Date(`${d}T00:00:00Z`);
const fy = (over: Record<string, unknown> = {}) => ({
  id: 'fy-2026',
  label: { en: 'FY2026', 'fr-CA': 'AF2026' },
  startDate: iso('2026-01-01'),
  endDate: iso('2026-12-31'),
  isCurrent: true,
  closed: false,
  externalIds: {},
  createdAt: iso('2026-01-01'),
  updatedAt: iso('2026-01-01'),
  ...over,
});

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'appSettings.fiscalYears.list': { data: [fy()] }, ...over.queries },
  });
}

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  render(<FiscalYearsAdmin canEdit />);
  render(<div>{h.topBar.right}</div>);
  await user.click(screen.getByRole('button', { name: /admin.fiscalYears.addFiscalYear/ }));
  await screen.findByLabelText(/admin\.common\.labelEn/);
}

beforeEach(() => {
  h.topBar = {};
});
afterEach(() => {
  h.trpc = undefined;
});

describe('French switched off', () => {
  it('neither asks for nor shows a French label', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<FiscalYearsAdmin canEdit />);
    await user.click(screen.getByText('FY2026'));
    expect(await screen.findByText('admin.common.labelEn')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.labelFr')).not.toBeInTheDocument();
    expect(screen.queryByText('AF2026')).not.toBeInTheDocument();
  });

  it('saves on the English label alone, sending no empty French one', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'appSettings.fiscalYears.list': { data: [] } },
      mutations: { 'appSettings.fiscalYears.create': { onCall } },
    });
    await openCreate(user);
    expect(screen.queryByLabelText(/admin\.common\.labelFr/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/admin\.common\.labelEn/), '  FY2030  ');
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onCall.mock.calls[0]?.[0].label).toEqual({ en: 'FY2030' });
  });

  it('reports a missing English label as such', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'appSettings.fiscalYears.list': { data: [] } },
      mutations: { 'appSettings.fiscalYears.create': { onCall } },
    });
    await openCreate(user);
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));
    expect(await screen.findByText('admin.common.labelEnRequired')).toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('keeps a French label already on the row through an edit', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'appSettings.fiscalYears.update': { onCall } } });
    render(<FiscalYearsAdmin canEdit />);
    await user.click(screen.getByText('FY2026'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.saveChanges' }));
    expect(onCall.mock.calls[0]?.[0].patch.label).toEqual({ en: 'FY2026', 'fr-CA': 'AF2026' });
  });
});
