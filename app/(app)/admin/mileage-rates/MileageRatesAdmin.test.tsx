import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import {
  isCurrent,
  MileageRatesAdmin,
  minorToRate,
  rateToMinor,
  summarizeTiers,
} from './MileageRatesAdmin';

/**
 * The page exists because the rate is invisible otherwise — a mileage expense in
 * an unseeded country just failed. So what's worth pinning is the money
 * conversion (the rate is stored in minor units but quoted as a decimal
 * everywhere), and that a bad rate can't be saved.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
  // The country cell + picker resolve names per-locale.
  useLocale: () => 'en',
}));
// The "Add rate" button is mounted into the TopBar slot, so the mock captures the
// node and the test renders it — otherwise there's no way to reach create mode.
const slots = vi.hoisted(() => ({ right: null as unknown }));
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => { right?: unknown }) => {
    slots.right = builder().right ?? null;
  },
}));

const RATE = {
  id: 'r1',
  country: 'CA',
  unit: 'KM' as const,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  supersededById: null,
  glAccountId: null,
  tiers: [{ id: 't1', fromDistance: '0', rateMinor: '72' }],
  subjects: [],
};

const TIERED = {
  ...RATE,
  id: 'r2',
  tiers: [
    { id: 't1', fromDistance: '0', rateMinor: '75' },
    { id: 't2', fromDistance: '5000', rateMinor: '73' },
    { id: 't3', fromDistance: '10000', rateMinor: '71' },
  ],
};

/** Choose a country in the picker: type enough to filter, then click the option.
 *  Typing alone only filters — the value is the selection. */
async function pickCountry(user: ReturnType<typeof userEvent.setup>, name = 'Canada') {
  await user.type(await screen.findByLabelText(/^colCountry/), name);
  await user.click(await screen.findByText(new RegExp(`${name} \\(`)));
}

function setTrpc(rows: unknown[], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'policies.mileageRate.list': { data: rows }, ...over.queries },
  });
}

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('rate conversion', () => {
  it('renders minor units as the quoted decimal', () => {
    expect(minorToRate('72')).toBe('0.72');
    expect(minorToRate('7')).toBe('0.07');
    expect(minorToRate('100')).toBe('1.00');
  });

  it('parses a typed rate back to minor units', () => {
    expect(rateToMinor('0.72')).toBe(72);
    // A comma decimal separator is what a French-Canadian keyboard produces.
    expect(rateToMinor('0,72')).toBe(72);
    expect(rateToMinor(' 1.5 ')).toBe(150);
  });

  it('rejects a rate that would price mileage at nothing', () => {
    expect(rateToMinor('0')).toBeNull();
    expect(rateToMinor('-1')).toBeNull();
    expect(rateToMinor('abc')).toBeNull();
  });
});

describe('in-force calculation', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('counts an open-ended rate that has started', () => {
    expect(isCurrent(RATE, now)).toBe(true);
  });

  it('excludes a rate that has not started yet', () => {
    expect(isCurrent({ ...RATE, effectiveFrom: '2026-09-01T00:00:00.000Z' }, now)).toBe(false);
  });

  it('excludes a rate that has been closed out', () => {
    expect(isCurrent({ ...RATE, effectiveTo: '2026-03-31T00:00:00.000Z' }, now)).toBe(false);
  });
});

/** Render the page plus whatever it published to the top bar. */
function renderPage(props: { canEdit: boolean }) {
  const result = render(<MileageRatesAdmin {...props} />);
  // Same React root, so the button's handlers drive the mounted page.
  result.rerender(
    <>
      <MileageRatesAdmin {...props} />
      {slots.right as React.ReactNode}
    </>,
  );
  return result;
}

describe('band summary', () => {
  it('reads as a single rate when there is one band', () => {
    expect(summarizeTiers(RATE.tiers)).toBe('0.72');
  });

  it('reads as a range when the rate steps down with distance', () => {
    expect(summarizeTiers(TIERED.tiers)).toBe('0.75 → 0.71');
  });

  it('survives a rule with no bands rather than throwing', () => {
    expect(summarizeTiers([])).toBe('—');
  });
});

describe('<MileageRatesAdmin>', () => {
  it('lists the rate as a decimal, not as stored minor units', () => {
    setTrpc([RATE]);
    render(<MileageRatesAdmin canEdit />);
    expect(screen.getByText('0.72/unitShort.KM')).toBeInTheDocument();
    expect(screen.queryByText('72')).not.toBeInTheDocument();
  });

  it('spells out every band on its own line, with where each one applies', () => {
    setTrpc([TIERED]);
    render(<MileageRatesAdmin canEdit />);
    // "0.75 → 0.71" said the numbers but not where either applied — and where the
    // band changes IS the rule. Each band is now its own line, and the last one is
    // open-ended rather than showing an invented ceiling.
    const lines = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(lines).toHaveLength(3);
    // Bounded bands say where they start AND stop; the top one says "and above".
    expect(lines[0]).toContain('bandRange');
    expect(lines[0]).toContain('0.75/');
    expect(lines[1]).toContain('bandRange');
    expect(lines[1]).toContain('0.73/');
    expect(lines[2]).toContain('bandAndAbove');
    expect(lines[2]).toContain('0.71/');
    // …and no band pretends to have a ceiling it doesn't have.
    expect(lines[2]).not.toContain('bandRange');
  });

  it('says a subject-less rule is the country default', () => {
    setTrpc([RATE]);
    render(<MileageRatesAdmin canEdit />);
    expect(screen.getAllByText('scopeDefault').length).toBeGreaterThan(0);
  });

  it('names the person a car-allowance rule covers', () => {
    setTrpc([
      {
        ...RATE,
        subjects: [
          { userId: 'u1', user: { firstName: 'Kati', lastName: 'Birmingham', email: 'k@e.inc' } },
        ],
      },
    ]);
    render(<MileageRatesAdmin canEdit />);
    expect(screen.getByText('Kati Birmingham')).toBeInTheDocument();
  });

  it('says plainly that an empty list breaks mileage expenses', () => {
    setTrpc([]);
    render(<MileageRatesAdmin canEdit />);
    expect(screen.getByText('empty')).toBeInTheDocument();
  });

  it('creates a one-band rule from the typed decimal', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc([], { mutations: { 'policies.mileageRate.create': { onCall, outcome: 'success' } } });
    renderPage({ canEdit: true });
    await user.click(screen.getByText('addRate'));
    await pickCountry(user);
    await user.type(screen.getByLabelText('rateLabel 1'), '0.72');
    await user.click(screen.getByText('create'));
    expect(onCall).toHaveBeenCalledWith(
      expect.objectContaining({
        country: 'CA',
        unit: 'KM',
        // The opening band is fixed at 0 and the rate converted to minor units.
        tiers: [{ fromDistance: 0, rateMinor: '72' }],
        subjectUserIds: [],
      }),
    );
  });

  it('creates a tiered rule with the bands in order', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc([], { mutations: { 'policies.mileageRate.create': { onCall, outcome: 'success' } } });
    renderPage({ canEdit: true });
    await user.click(screen.getByText('addRate'));
    await pickCountry(user);
    await user.type(screen.getByLabelText('rateLabel 1'), '0.75');
    await user.click(screen.getByText('addBand'));
    const bounds = screen.getAllByLabelText(/^bandFrom/);
    await user.type(bounds[1], '5000');
    await user.type(screen.getByLabelText('rateLabel 2'), '0.73');
    await user.click(screen.getByText('create'));
    expect(onCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tiers: [
          { fromDistance: 0, rateMinor: '75' },
          { fromDistance: 5000, rateMinor: '73' },
        ],
      }),
    );
  });

  it('refuses a band that starts before the one above it', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc([], { mutations: { 'policies.mileageRate.create': { onCall, outcome: 'success' } } });
    renderPage({ canEdit: true });
    await user.click(screen.getByText('addRate'));
    await pickCountry(user);
    await user.type(screen.getByLabelText('rateLabel 1'), '0.75');
    await user.click(screen.getByText('addBand'));
    // Second band at 0 too — the bands only mean anything read in order.
    await user.type(screen.getAllByLabelText(/^bandFrom/)[1], '0');
    await user.type(screen.getByLabelText('rateLabel 2'), '0.73');
    await user.click(screen.getByText('create'));
    expect(onCall).not.toHaveBeenCalled();
    expect(screen.getByText('bandOutOfOrder')).toBeInTheDocument();
  });

  it('will not let the opening band start anywhere but zero', async () => {
    const user = userEvent.setup();
    setTrpc([]);
    renderPage({ canEdit: true });
    await user.click(screen.getByText('addRate'));
    // Disabled rather than validated: leaving the opening distance unpriced
    // shouldn't be expressible.
    expect((await screen.findAllByLabelText(/^bandFrom/))[0]).toBeDisabled();
  });

  it('refuses to save without a country', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    setTrpc([], { mutations: { 'policies.mileageRate.create': { onCall, outcome: 'success' } } });
    renderPage({ canEdit: true });
    await user.click(screen.getByText('addRate'));
    // The country is a picker now, so a malformed code can no longer be typed —
    // what remains reachable is leaving it unset, and that still must not save.
    await user.type(screen.getByLabelText('rateLabel 1'), '0.72');
    await user.click(screen.getByText('create'));
    expect(onCall).not.toHaveBeenCalled();
    expect(screen.getByText('countryInvalid')).toBeInTheDocument();
  });

  it('offers supersede rather than edit, and not on an already-superseded rule', async () => {
    const user = userEvent.setup();
    setTrpc([{ ...RATE, supersededById: 'r9' }]);
    render(<MileageRatesAdmin canEdit />);
    await user.click(screen.getByLabelText('rowActions'));
    // A rule in force is replaced, never edited.
    expect(await screen.findByRole('button', { name: 'supersede' })).toBeDisabled();
    expect(screen.queryByText('edit')).not.toBeInTheDocument();
  });

  it('offers no editing affordances without the permission', async () => {
    const user = userEvent.setup();
    setTrpc([RATE]);
    render(<MileageRatesAdmin canEdit={false} />);
    await user.click(screen.getByLabelText('rowActions'));
    expect(await screen.findByText('view')).toBeInTheDocument();
    expect(screen.queryByText('supersede')).not.toBeInTheDocument();
    expect(screen.queryByText('delete')).not.toBeInTheDocument();
  });
});

describe('year-to-date mileage import', () => {
  it('opens the Concur import from the top bar for somebody who can edit mileage', async () => {
    const user = userEvent.setup();
    setTrpc([RATE]);
    renderPage({ canEdit: true });
    await user.click(screen.getByRole('button', { name: /importYtd/ }));
    // The drawer's own tabs: importing, and the history of uploads.
    expect(await screen.findByRole('tab', { name: 'tabImport' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'tabHistory' })).toBeInTheDocument();
  });

  it('offers no import without the permission', () => {
    setTrpc([RATE]);
    renderPage({ canEdit: false });
    expect(screen.queryByRole('button', { name: /importYtd/ })).not.toBeInTheDocument();
  });
});
