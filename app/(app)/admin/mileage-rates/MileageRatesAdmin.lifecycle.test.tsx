import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * A mileage rule's life: read it, replace it, retire it, delete it.
 *
 * The rule that governs the whole page is that **a rule in force is never edited**. Every
 * filed claim derived its amount from the rule that was in force on its date, so editing
 * one re-prices history. A change is therefore a NEW rule (superseding), an end is a
 * retirement with a date, and deleting is only for a rule nothing has used.
 *
 * The consequences the tests pin:
 *
 *   · **Supersede pre-fills from the rule it replaces** — same scope, same bands, new
 *     numbers from a new date. Retyping five bands to change one number is how a band
 *     gets dropped.
 *   · **Neither supersede nor retire is offered twice.** A rule already superseded, or
 *     already closed out, has nothing left to end.
 *   · **Retire asks for the DATE**, because "as of when" is the whole content of a
 *     retirement, and delete asks for confirmation because it is the one irreversible
 *     action here.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key;
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));
const slots = vi.hoisted(() => ({ right: null as unknown }));
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => { right?: unknown }) => {
    slots.right = builder().right ?? null;
  },
}));

import { MileageRatesAdmin } from './MileageRatesAdmin';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const rate = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  country: 'CA',
  unit: 'KM' as const,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  supersededById: null,
  glAccountId: null,
  tiers: [{ id: 't1', fromDistance: '0', rateMinor: '72' }],
  subjects: [],
  ...over,
});

const TIERED = rate({
  id: 'r2',
  tiers: [
    { id: 't1', fromDistance: '0', rateMinor: '75' },
    { id: 't2', fromDistance: '5000', rateMinor: '73' },
  ],
});

const PERSONAL = rate({
  id: 'r3',
  country: 'US',
  unit: 'MI' as const,
  subjects: [
    { userId: 'u-1', user: { firstName: 'Dana', lastName: 'Patel', email: 'dana@e.inc' } },
    { userId: 'u-2', user: { firstName: 'Sam', lastName: 'Ito', email: 'sam@e.inc' } },
  ],
});

function setTrpc(rows: unknown[], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'policies.mileageRate.list': { data: rows }, ...over.queries },
  });
}

/** Render the page plus whatever it published to the top bar. */
function show(props: { canEdit?: boolean } = {}) {
  const p = { canEdit: true, ...props };
  const result = render(<MileageRatesAdmin {...p} />);
  result.rerender(
    <>
      <MileageRatesAdmin {...p} />
      {slots.right as React.ReactNode}
    </>,
  );
  return result;
}

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter((s) => s.length > 0);

async function rowMenu(user: ReturnType<typeof userEvent.setup>, country: string) {
  const cell = screen.getByText(country).closest('td') as HTMLElement;
  await user.click(within(cell).getByRole('button', { name: 'rowActions' }));
}

/** Add a filter clause through the pill bar's own form. */
async function addFilter(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  op: string,
  value: string,
) {
  await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
  await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), field);
  await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), op);
  const control = screen.getByLabelText(/(?:^Value$|filters\.value$)/);
  if (control.tagName === 'SELECT') await user.selectOptions(control, value);
  else await user.type(control, value);
  await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
}

beforeEach(() => {
  slots.right = null;
  vi.restoreAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'prompt').mockReturnValue('2026-06-30');
});
afterEach(() => {
  h.trpc = undefined;
});

// ── Reading one ───────────────────────────────────────────────────────────────

describe('reading a rule', () => {
  it('opens the rule on a row click, with its dates and state', async () => {
    const user = userEvent.setup();
    setTrpc([rate()]);
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('view'));
    expect(await screen.findByText('bandsTitle')).toBeInTheDocument();
    expect(screen.getAllByText('current').length).toBeGreaterThan(0);
  });

  it('spells out each band’s range, and leaves the last one open', async () => {
    /**
     * Where a band CHANGES is the rule. A list of rates with no distances says the
     * numbers and not the rule.
     */
    const user = userEvent.setup();
    setTrpc([TIERED]);
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('view'));
    expect(await screen.findByText('bandRange:0,5000,unitShort.KM')).toBeInTheDocument();
    expect(screen.getByText('bandOpen:5000,unitShort.KM')).toBeInTheDocument();
  });

  it('shows each band’s rate as the quoted decimal', async () => {
    // Stored in minor units; nobody quotes a mileage rate as "72".
    const user = userEvent.setup();
    setTrpc([TIERED]);
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('view'));
    expect(await screen.findByText('0.75')).toBeInTheDocument();
    expect(screen.getByText('0.73')).toBeInTheDocument();
  });

  it('says a rule with no subjects is the country default', async () => {
    const user = userEvent.setup();
    setTrpc([rate()]);
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('view'));
    expect(await screen.findByText('scopeDefaultHelp')).toBeInTheDocument();
  });

  it('names every person a car-allowance rule covers', async () => {
    /**
     * A per-person rule is an allowance somebody negotiated. "2 people" in the cell is
     * enough to scan; the drawer has to name them.
     */
    const user = userEvent.setup();
    setTrpc([PERSONAL]);
    show();
    await rowMenu(user, 'US');
    await user.click(await screen.findByText('view'));
    expect(await screen.findByText('Dana Patel')).toBeInTheDocument();
    expect(screen.getByText('Sam Ito')).toBeInTheDocument();
  });

  it('says a superseded rule has been replaced', async () => {
    // Otherwise it reads as merely "not current", which does not say what happened.
    const user = userEvent.setup();
    setTrpc([rate({ supersededById: 'r9' })]);
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('view'));
    expect(await screen.findByText('supersededYes')).toBeInTheDocument();
  });

  it('offers supersede from the drawer, but not for a rule already replaced', async () => {
    const user = userEvent.setup();
    setTrpc([rate()]);
    const view = show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('view'));
    expect(screen.getAllByText('supersede').length).toBeGreaterThan(0);
    view.unmount();

    setTrpc([rate({ supersededById: 'r9' })]);
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('view'));
    await screen.findByText('bandsTitle');
    expect(screen.queryByRole('button', { name: /supersede/ })).not.toBeInTheDocument();
  });
});

// ── Superseding ───────────────────────────────────────────────────────────────

describe('replacing a rule', () => {
  it('pre-fills the new rule from the one it replaces', async () => {
    /**
     * The usual change is "same scope, same bands, new numbers from January". Retyping
     * five bands to change one number is how a band gets dropped.
     */
    const user = userEvent.setup();
    setTrpc([TIERED]);
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('supersede'));
    await screen.findByText('addTitle');
    expect(screen.getAllByDisplayValue('0.75').length).toBe(1);
    expect(screen.getAllByDisplayValue('0.73').length).toBe(1);
    expect(screen.getAllByDisplayValue('5000').length).toBe(1);
  });

  it('carries the people the old rule covered, by name', async () => {
    /**
     * A replacement that silently became the country default would re-price two people —
     * and the picker only resolves names it was handed in-session, so a pre-filled form
     * has to bring the names with it or the scope reads as two uuids.
     */
    const user = userEvent.setup();
    setTrpc([PERSONAL]);
    show();
    await rowMenu(user, 'US');
    await user.click(await screen.findByText('supersede'));
    await screen.findByText('addTitle');
    expect(screen.getByText('Dana Patel')).toBeInTheDocument();
    expect(screen.getByText('Sam Ito')).toBeInTheDocument();
  });

  it('starts the replacement TODAY, not on the old rule’s date', async () => {
    /**
     * Two rules with the same start date is an ambiguity the resolver cannot settle —
     * and the point of a replacement is that it starts later.
     */
    const user = userEvent.setup();
    setTrpc([rate()]);
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('supersede'));
    const from = (await screen.findByLabelText(/colFrom/)) as HTMLInputElement;
    expect(from.value).toBe(new Date().toISOString().slice(0, 10));
    expect(from.value).not.toBe('2026-01-01');
  });

  it('does not offer supersede on a rule already replaced', async () => {
    const user = userEvent.setup();
    setTrpc([rate({ supersededById: 'r9' })]);
    show();
    await rowMenu(user, 'CA');
    expect(await screen.findByRole('button', { name: 'supersede' })).toBeDisabled();
  });
});

// ── Retiring and deleting ─────────────────────────────────────────────────────

describe('ending a rule', () => {
  it('asks for the date it stops applying', async () => {
    /**
     * "As of when" IS the retirement — a rule closed on the wrong date re-prices every
     * claim in between.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([rate()], { mutations: { 'policies.mileageRate.retire': { onCall } } });
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('retire'));
    expect(window.prompt).toHaveBeenCalled();
    expect(onCall).toHaveBeenCalledWith({ id: 'r1', effectiveTo: '2026-06-30' });
  });

  it('retires nothing when the date is dismissed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    setTrpc([rate()], { mutations: { 'policies.mileageRate.retire': { onCall } } });
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('retire'));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('offers no retirement for a rule already closed out', async () => {
    const user = userEvent.setup();
    setTrpc([rate({ effectiveTo: '2026-03-31T00:00:00.000Z' })]);
    show();
    await rowMenu(user, 'CA');
    expect(await screen.findByRole('button', { name: 'retire' })).toBeDisabled();
  });

  it('asks before deleting, naming the country', async () => {
    // The one irreversible action here: a deleted rule takes its history with it.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([rate()], { mutations: { 'policies.mileageRate.delete': { onCall } } });
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('delete'));
    expect(window.confirm).toHaveBeenCalledWith('confirmDelete:CA');
    expect(onCall).toHaveBeenCalledWith({ id: 'r1' });
  });

  it('deletes nothing when the question is declined', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    setTrpc([rate()], { mutations: { 'policies.mileageRate.delete': { onCall } } });
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('delete'));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('reports a refused deletion on the page, not in a lost toast', async () => {
    /**
     * The refusal is the useful part — usually "claims already used this rule", which
     * is the answer to why it cannot go.
     */
    const user = userEvent.setup();
    setTrpc([rate()], {
      mutations: {
        'policies.mileageRate.delete': {
          outcome: 'error',
          error: { message: 'Claims have already been priced from this rule' },
        },
      },
    });
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('delete'));
    expect(
      await screen.findByText('Claims have already been priced from this rule'),
    ).toBeInTheDocument();
  });

  it('reports a refused retirement too', async () => {
    const user = userEvent.setup();
    setTrpc([rate()], {
      mutations: {
        'policies.mileageRate.retire': {
          outcome: 'error',
          error: { message: 'That date is before the rule started' },
        },
      },
    });
    show();
    await rowMenu(user, 'CA');
    await user.click(await screen.findByText('retire'));
    expect(await screen.findByText('That date is before the rule started')).toBeInTheDocument();
  });
});

// ── Narrowing the list ────────────────────────────────────────────────────────

describe('finding a rule', () => {
  it('narrows by country code', async () => {
    const user = userEvent.setup();
    setTrpc([rate(), PERSONAL]);
    show();
    await addFilter(user, 'country', 'contains', 'us');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('US')).toBeInTheDocument();
  });

  it('narrows by unit, which is the difference between two rules of the same country', async () => {
    /**
     * A country can carry both a per-km and a per-mile rule; the unit is what tells
     * them apart, and picking the wrong one prices a claim in the wrong measure.
     */
    const user = userEvent.setup();
    setTrpc([rate(), rate({ id: 'r9', country: 'CA', unit: 'MI' })]);
    show();
    await addFilter(user, 'unit', 'equals', 'MI');
    expect(rowTexts()).toHaveLength(1);
  });

  it('narrows to the rules actually in force', async () => {
    /**
     * The list is a history, so "what applies today" is the common question — and a
     * superseded rule beside a live one is how the wrong rate gets quoted.
     */
    const user = userEvent.setup();
    setTrpc([rate(), rate({ id: 'r9', country: 'FR', effectiveTo: '2026-03-31T00:00:00.000Z' })]);
    show();
    await addFilter(user, 'status', 'equals', 'current');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('CA')).toBeInTheDocument();
  });

  it('narrows to the ones that no longer apply', async () => {
    const user = userEvent.setup();
    setTrpc([rate(), rate({ id: 'r9', country: 'FR', effectiveTo: '2026-03-31T00:00:00.000Z' })]);
    show();
    await addFilter(user, 'status', 'equals', 'inactive');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('FR')).toBeInTheDocument();
  });

  it('shows the country default and the person-scoped rule differently in the cell', () => {
    setTrpc([rate(), PERSONAL]);
    show();
    expect(screen.getByText('scopeDefault')).toBeInTheDocument();
    expect(screen.getByText('scopePeople:2')).toBeInTheDocument();
  });

  it('names the single person on a one-person rule rather than counting to one', () => {
    // "1 person" is a worse label than the person's name.
    setTrpc([
      rate({
        subjects: [
          { userId: 'u-1', user: { firstName: 'Dana', lastName: 'Patel', email: 'dana@e.inc' } },
        ],
      }),
    ]);
    show();
    expect(screen.getByText('Dana Patel')).toBeInTheDocument();
  });

  it('says an open-ended rule has no end date', () => {
    setTrpc([rate()]);
    show();
    expect(screen.getByText('openEnded')).toBeInTheDocument();
  });
});
