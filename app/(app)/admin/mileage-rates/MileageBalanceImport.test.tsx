import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * Carrying Concur's year-to-date mileage into ExpenseOS.
 *
 * Nothing here is reversible in a way anybody would notice: a balance on the wrong person
 * changes what two people are paid, and a person left out of a new file silently loses
 * their carried-over distance. So what is pinned is that commit stays off until every row
 * has an answer, that the answer sent is exactly the one on screen, and that "dropped" is
 * said before the button rather than after.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  parsed: {
    rows: [] as unknown[],
    periodEnd: null as string | null,
    error: null as string | null,
  },
  throwOnParse: false,
}));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (k: string, v?: Record<string, unknown>) => {
    const full = ns ? `${ns}.${k}` : k;
    return v ? `${full}:${Object.values(v).join(',')}` : full;
  },
  useLocale: () => 'en',
}));
vi.mock('@/lib/mileageBalanceImport', () => ({
  parseMileageBalances: () => {
    if (h.throwOnParse) throw new Error('boom');
    return h.parsed;
  },
}));
// The picker is its own tested component; here it only has to hand back a choice.
vi.mock('@/components/pickers/EntityPickers', () => ({
  UserCombobox: ({
    onValueChange,
    placeholder,
  }: {
    onValueChange: (id: string | null, item: { value: string; label: string } | null) => void;
    placeholder?: string;
  }) => (
    <span>
      <button
        type="button"
        onClick={() => onValueChange('u-picked', { value: 'u-picked', label: 'Picked Person' })}
      >
        {placeholder}
      </button>
      <button type="button" onClick={() => onValueChange(null, null)}>
        clear-pick
      </button>
    </span>
  ),
}));

import {
  type Decision,
  MileageBalanceImportDrawer,
  seedDecisions,
  summarize,
} from './MileageBalanceImport';

const NS = 'admin.mileageBalances';

const ROWS = [
  {
    name: 'Doe, Jane',
    distance: '6000.00',
    paidRate: '0.67',
    amount: '4100.00',
    claimDate: '2026-10-14',
  },
  { name: 'Roe, Rick', distance: '1200.00', paidRate: '0.55', amount: '660.00', claimDate: null },
  { name: 'Poe, Ed', distance: '300.00', paidRate: null, amount: null, claimDate: null },
  { name: 'Moe, Mo', distance: '50.00', paidRate: '0.73', amount: '36.50', claimDate: null },
];

const PREVIEW = {
  rows: [
    {
      ...ROWS[0],
      match: { status: 'remembered', userId: 'u-jane' },
      carAllowance: false,
      previousDistance: '5000',
      flags: [],
    },
    {
      ...ROWS[1],
      match: { status: 'matched', userId: 'u-rick' },
      carAllowance: true,
      previousDistance: null,
      flags: ['rateBand', 'amount'],
    },
    {
      ...ROWS[2],
      match: { status: 'ambiguous', candidateIds: ['u-ed1', 'u-ed2'] },
      carAllowance: false,
      previousDistance: null,
      flags: [],
    },
    {
      ...ROWS[3],
      match: { status: 'unmatched' },
      carAllowance: false,
      previousDistance: null,
      flags: [],
    },
  ],
  people: [
    { id: 'u-jane', name: 'Jane Doe', email: 'jane@e.inc', deactivated: false },
    { id: 'u-rick', name: 'Rick Roe', email: 'rick@e.inc', deactivated: false },
    { id: 'u-ed1', name: 'Ed Poe', email: 'ed1@e.inc', deactivated: false },
    { id: 'u-ed2', name: 'Edgar Poe', email: 'ed2@e.inc', deactivated: false },
    { id: 'u-gone', name: 'Gone Person', email: 'gone@e.inc', deactivated: true },
  ],
  current: {
    id: 'imp-0',
    asOf: new Date('2026-09-30T00:00:00.000Z'),
    balances: [
      { userId: 'u-jane', distance: '5000' },
      { userId: 'u-gone', distance: '800' },
    ],
  },
  stale: false,
};

const RESULT = {
  id: 'imp-1',
  people: 3,
  moved: 3,
  dropped: 1,
  repricedLines: 2,
  carAllowances: [
    { rateMinor: 55, people: 1, action: 'created' },
    { rateMinor: 60, people: 0, action: 'closed' },
  ],
};

const IMPORTS = [
  {
    id: 'imp-1',
    asOf: new Date('2026-10-15T00:00:00.000Z'),
    filename: 'ytd-oct.xlsx',
    importedAt: new Date('2026-10-15T10:00:00.000Z'),
    inForce: true,
    supersededAt: null,
    importedBy: 'Admin One',
    people: 3,
  },
  {
    id: 'imp-0',
    asOf: new Date('2026-09-30T00:00:00.000Z'),
    filename: 'ytd-sep.xlsx',
    importedAt: new Date('2026-09-30T10:00:00.000Z'),
    inForce: false,
    supersededAt: new Date('2026-10-15T10:00:00.000Z'),
    importedBy: 'Admin One',
    people: 2,
  },
];

const DETAIL = [
  {
    id: 'b-1',
    sourceName: 'Doe, Jane',
    distance: '5000',
    unit: 'KM',
    paidRate: '0.67',
    user: { id: 'u-jane', name: 'Jane Doe', email: 'jane@e.inc' },
  },
  {
    id: 'b-2',
    sourceName: 'Gone, Person',
    distance: '800',
    unit: 'KM',
    paidRate: null,
    user: { id: 'u-gone', name: 'Gone Person', email: 'gone@e.inc' },
  },
];

function setTrpc(over: { preview?: unknown; commitData?: unknown } & TrpcMockConfig = {}) {
  const calls = { preview: [] as unknown[], commit: [] as unknown[], imports: [] as unknown[] };
  h.trpc = createTrpcMock({
    queries: {
      'mileageBalances.imports': { data: IMPORTS, onCall: (i) => calls.imports.push(i) },
      'mileageBalances.importDetail': { data: DETAIL },
      ...over.queries,
    },
    mutations: {
      'mileageBalances.preview': {
        outcome: 'success',
        data: over.preview === undefined ? PREVIEW : over.preview,
        onCall: (i) => calls.preview.push(i),
      },
      'mileageBalances.commit': {
        outcome: 'success',
        data: over.commitData ?? RESULT,
        onCall: (i) => calls.commit.push(i),
      },
      ...over.mutations,
    },
  });
  return calls;
}

const show = () => render(<MileageBalanceImportDrawer open onOpenChange={vi.fn()} />);

const chooseFile = async (name = 'ytd.xlsx') => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], name)] } });
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
};

const commitButton = () =>
  screen.getByRole('button', { name: new RegExp(`^${NS}\\.(commit|committing)`) });

/** The table row whose file name is `name`. */
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

afterEach(() => {
  h.trpc = undefined;
  h.parsed = { rows: [], periodEnd: null, error: null };
  h.throwOnParse = false;
  vi.restoreAllMocks();
});

describe('choosing a file', () => {
  it('previews the parsed rows for the year of the period end, without the claim dates', async () => {
    const calls = setTrpc();
    h.parsed = { rows: ROWS, periodEnd: '2026-10-15', error: null };
    show();
    await chooseFile();
    expect(calls.preview).toEqual([
      {
        source: 'concur',
        year: 2026,
        asOf: '2026-10-15',
        filename: 'ytd.xlsx',
        rows: ROWS.map(({ claimDate: _c, ...r }) => r),
      },
    ]);
    expect(screen.getByLabelText(`${NS}.periodEnd`)).toHaveValue('2026-10-15');
  });

  it('asks for the period end when the file does not say, and previews once it is given', async () => {
    const calls = setTrpc();
    h.parsed = { rows: ROWS, periodEnd: null, error: null };
    show();
    await chooseFile();
    expect(calls.preview).toHaveLength(0);
    expect(screen.getByText(`${NS}.periodEndMissing`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(`${NS}.periodEnd`), { target: { value: '2026-10-01' } });
    expect(calls.preview).toHaveLength(1);
    expect((calls.preview[0] as { asOf: string }).asOf).toBe('2026-10-01');
  });

  it('says why a file could not be read', async () => {
    setTrpc({ preview: null });
    h.parsed = { rows: [], periodEnd: null, error: 'noHeader' };
    show();
    await chooseFile();
    expect(screen.getByText(`${NS}.parseError.noHeader`)).toBeInTheDocument();
  });

  it('reports an unreadable workbook', async () => {
    setTrpc({ preview: null });
    h.throwOnParse = true;
    show();
    await chooseFile();
    expect(screen.getByText(`${NS}.parseError.unreadable`)).toBeInTheDocument();
  });

  it('ignores a cleared file input', () => {
    const calls = setTrpc({ preview: null });
    show();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    expect(calls.preview).toHaveLength(0);
  });

  it('shows a refused preview', () => {
    setTrpc({
      preview: null,
      mutations: { 'mileageBalances.preview': { error: { message: 'nope' }, isPending: true } },
    });
    show();
    expect(screen.getByText('nope')).toBeInTheDocument();
    expect(screen.getByText(`${NS}.matching`)).toBeInTheDocument();
  });
});

describe('reviewing the match', () => {
  const ready = async () => {
    const calls = setTrpc();
    h.parsed = { rows: ROWS, periodEnd: '2026-10-15', error: null };
    show();
    await chooseFile();
    return calls;
  };

  it('pre-fills confident matches and leaves the rest to a person', async () => {
    await ready();
    expect(within(rowOf('Doe, Jane')).getByText('Jane Doe')).toBeInTheDocument();
    expect(within(rowOf('Doe, Jane')).getByText(`${NS}.status.remembered`)).toBeInTheDocument();
    expect(within(rowOf('Roe, Rick')).getByText('Rick Roe')).toBeInTheDocument();
    // Ambiguous: its candidates are offered first.
    expect(within(rowOf('Poe, Ed')).getByRole('button', { name: 'Ed Poe' })).toBeInTheDocument();
    expect(within(rowOf('Poe, Ed')).getByRole('button', { name: 'Edgar Poe' })).toBeInTheDocument();
    expect(within(rowOf('Moe, Mo')).getByText(`${NS}.status.unmatched`)).toBeInTheDocument();
  });

  it('compares with the upload in force and lists who would be dropped', async () => {
    await ready();
    expect(within(rowOf('Doe, Jane')).getByText('+1,000')).toBeInTheDocument();
    expect(within(rowOf('Roe, Rick')).getByText(`${NS}.isNew`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.droppedHelp:1`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.droppedItem:Gone Person,800`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.supersedes:2026-09-30`)).toBeInTheDocument();
  });

  it('marks a car allowance and explains the checks', async () => {
    await ready();
    const rick = rowOf('Roe, Rick');
    expect(within(rick).getByText(`${NS}.carAllowance`)).toHaveAttribute(
      'title',
      `${NS}.carAllowanceHelp`,
    );
    expect(within(rick).getByText(`${NS}.flag.rateBand`)).toHaveAttribute(
      'title',
      `${NS}.flagHelp.rateBand`,
    );
    expect(within(rick).getByText(`${NS}.flag.amount`)).toBeInTheDocument();
  });

  it('keeps commit off until every row has a person or is skipped, then sends only those', async () => {
    const calls = await ready();
    expect(commitButton()).toBeDisabled();
    expect(screen.getByText(`${NS}.blockUnresolved:2`)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(rowOf('Poe, Ed')).getByRole('button', { name: 'Edgar Poe' }));
    expect(within(rowOf('Poe, Ed')).getByText(`${NS}.status.chosen`)).toBeInTheDocument();
    await user.click(within(rowOf('Moe, Mo')).getByRole('button', { name: `${NS}.skip` }));
    expect(within(rowOf('Moe, Mo')).getByText(`${NS}.status.skipped`)).toBeInTheDocument();

    expect(commitButton()).toBeEnabled();
    await user.click(commitButton());
    expect(calls.commit).toEqual([
      {
        source: 'concur',
        year: 2026,
        asOf: '2026-10-15',
        filename: 'ytd.xlsx',
        rows: [
          { name: 'Doe, Jane', userId: 'u-jane', distance: '6000.00', paidRate: '0.67' },
          { name: 'Roe, Rick', userId: 'u-rick', distance: '1200.00', paidRate: '0.55' },
          { name: 'Poe, Ed', userId: 'u-ed2', distance: '300.00', paidRate: null },
        ],
      },
    ]);
    // The outcome, including what happened to the car-allowance rules.
    expect(screen.getByText(`${NS}.committed:3,3,1,2`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.allowance.created:0.55,1`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.allowance.closed:0.60,0`)).toBeInTheDocument();
  });

  it('refuses the same person on two rows', async () => {
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf('Moe, Mo')).getByRole('button', { name: `${NS}.pickPerson` }));
    await user.click(within(rowOf('Poe, Ed')).getByRole('button', { name: `${NS}.pickPerson` }));
    expect(screen.getByText(`${NS}.blockDuplicate:1`)).toBeInTheDocument();
    expect(within(rowOf('Moe, Mo')).getByText(`${NS}.status.duplicate`)).toBeInTheDocument();
    expect(within(rowOf('Moe, Mo')).getByText('Picked Person')).toBeInTheDocument();
    expect(commitButton()).toBeDisabled();
  });

  it('lets a confident match be changed, a skip undone, and ignores a cleared pick', async () => {
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf('Doe, Jane')).getByRole('button', { name: `${NS}.change` }));
    await user.click(within(rowOf('Doe, Jane')).getByRole('button', { name: 'clear-pick' }));
    // Still choosing — clearing the picker is not a decision.
    expect(
      within(rowOf('Doe, Jane')).getByRole('button', { name: `${NS}.skip` }),
    ).toBeInTheDocument();
    await user.click(within(rowOf('Doe, Jane')).getByRole('button', { name: `${NS}.skip` }));
    await user.click(within(rowOf('Doe, Jane')).getByRole('button', { name: `${NS}.undoSkip` }));
    expect(within(rowOf('Doe, Jane')).getByText('Jane Doe')).toBeInTheDocument();
  });

  it('refuses a file older than the upload in force', async () => {
    setTrpc({ preview: { ...PREVIEW, stale: true } });
    h.parsed = { rows: ROWS, periodEnd: '2026-09-01', error: null };
    show();
    await chooseFile();
    expect(screen.getByText(`${NS}.staleHelp:2026-09-30`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.blockStale:2026-09-30`)).toBeInTheDocument();
    expect(commitButton()).toBeDisabled();
  });

  it('needs a period end to commit, and a row to commit', async () => {
    setTrpc({
      preview: {
        ...PREVIEW,
        rows: [PREVIEW.rows[3]],
        current: null,
      },
    });
    h.parsed = { rows: [ROWS[3]], periodEnd: '2026-10-15', error: null };
    show();
    await chooseFile();
    expect(screen.getByText(`${NS}.firstUpload`)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(rowOf('Moe, Mo')).getByRole('button', { name: `${NS}.skip` }));
    expect(screen.getByText(`${NS}.blockEmpty`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(`${NS}.periodEnd`), { target: { value: '' } });
    expect(screen.getByText(`${NS}.blockDate`)).toBeInTheDocument();
  });

  it('shows a commit in flight and a refused commit', () => {
    setTrpc({
      mutations: {
        'mileageBalances.commit': { isPending: true, error: { message: 'commit refused' } },
      },
    });
    show();
    expect(screen.getByText('commit refused')).toBeInTheDocument();
    expect(commitButton()).toHaveTextContent(`${NS}.committing`);
  });
});

describe('import history', () => {
  it('lists the uploads with the one in force, and opens one', async () => {
    const calls = setTrpc({ preview: null });
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: `${NS}.tabHistory` }));
    expect(screen.getByText('ytd-oct.xlsx')).toBeInTheDocument();
    expect(screen.getByText(`${NS}.inForce`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.supersededOn:2026-10-15`)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(`${NS}.year`), { target: { value: '2025' } });
    expect(calls.imports.at(-1)).toEqual({ source: 'concur', year: 2025 });
    // Out of range is ignored rather than queried.
    fireEvent.change(screen.getByLabelText(`${NS}.year`), { target: { value: '99' } });
    expect(calls.imports.at(-1)).toEqual({ source: 'concur', year: 2025 });

    await user.click(screen.getByText('ytd-oct.xlsx'));
    expect(screen.getByText('Gone, Person')).toBeInTheDocument();
    expect(screen.getByText(`${NS}.detailMeta:2026-10-15,3`)).toBeInTheDocument();
    expect(screen.getByText('5,000 km')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: new RegExp(`${NS}.back`) }));
    expect(screen.getByText('ytd-sep.xlsx')).toBeInTheDocument();
  });

  it('says when a year has no uploads', async () => {
    setTrpc({ preview: null, queries: { 'mileageBalances.imports': { data: [] } } });
    show();
    await userEvent.setup().click(screen.getByRole('tab', { name: `${NS}.tabHistory` }));
    expect(screen.getByText(new RegExp(`${NS}.noImports`))).toBeInTheDocument();
  });
});

describe('decisions', () => {
  it('keeps a hand-made choice when the file is re-checked', () => {
    const manual: Decision = {
      userId: 'u-x',
      label: 'X',
      skip: false,
      manual: true,
      editing: false,
    };
    const seeded = seedDecisions(PREVIEW as never, { 3: manual });
    expect(seeded[3]).toBe(manual);
    expect(seeded[0]).toMatchObject({ userId: 'u-jane', label: 'Jane Doe', manual: false });
    expect(seeded[2]).toMatchObject({ userId: null });
  });

  it('counts a changed distance, not an unchanged one', () => {
    const preview = {
      ...PREVIEW,
      rows: [{ ...PREVIEW.rows[0], distance: '5000.00' }],
      current: { ...PREVIEW.current, balances: [{ userId: 'u-jane', distance: '5000' }] },
    };
    const s = summarize(preview as never, {
      0: { userId: 'u-jane', label: null, skip: false, manual: false, editing: false },
    });
    expect(s).toMatchObject({ added: 0, changed: 0, unresolved: 0, dropped: [] });
  });
});
