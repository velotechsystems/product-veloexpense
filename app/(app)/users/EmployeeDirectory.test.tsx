import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The People directory — the list every other list page in the product was modelled on.
 *
 * Almost all of its behaviour is about ASKING THE SERVER THE RIGHT QUESTION, because
 * the table is paged: what is on screen is a window, so a filter that is applied
 * client-side silently disagrees with the count beside it. The three that matter:
 *
 *   · **Filter clauses collapse into the server's shape.** Two `equals` on one field
 *     become `isAnyOf` — an OR — because a facet multi-select is meant to widen. ANDing
 *     them would return nothing and read as "no such people".
 *   · **Soft-deleted rows are included only when asked for.** Filtering for
 *     DEACTIVATED or TERMINATED has to flip `includeDeleted`, or the one filter whose
 *     whole purpose is to find those people returns an empty table.
 *   · **Sorting and grouping switch to a single-shot fetch.** Grouping needs every row
 *     in memory at once, or a group is split across two "loads" and the partition is a
 *     lie.
 */

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  totalCount: 0,
  loading: false,
  hasNextPage: false,
  savedViews: [] as Record<string, unknown>[],
  facetCounts: undefined as unknown,
  /** The filter rail's options. `undefined` is the first paint of every visit. */
  facets: undefined as unknown,
  /** Every input each query was called with, keyed by procedure. */
  queryInputs: {} as Record<string, unknown[]>,
  /** Mutation arguments, keyed by procedure. */
  calls: {} as Record<string, unknown[]>,
  /** What `mutateAsync` resolves to, keyed by procedure; an Error rejects instead. */
  results: {} as Record<string, unknown>,
  fetchNextPage: vi.fn(),
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
  /** VeloExpense: what the page put in the top bar's right slot, captured to render it. */
  topBarRight: null as React.ReactNode,
}));

/** One stable `t` per namespace: an unstable identity re-runs memos and effects. */
const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const key = ns ?? '';
    let t = translators.get(key);
    if (!t) {
      const fn = (k: string, values?: Record<string, unknown>) => {
        const full = ns ? `${ns}.${k}` : k;
        return values ? `${full}:${Object.values(values).join(',')}` : full;
      };
      (fn as { has?: () => boolean }).has = () => false;
      t = fn;
      translators.set(key, t);
    }
    return t;
  },
}));

// VeloExpense: captures the right slot (Add user and the invitations link) so it can be
// rendered and asserted on; ExpenseOS's mock discarded it.
vi.mock('../TopBar', () => ({
  useTopBarSlots: (make: () => { right?: React.ReactNode }) => {
    h.topBarRight = make().right ?? null;
  },
}));
// The export menu's real builder runs; only the browser download is intercepted, so the
// assertions read the actual CSV the accessors produced.
vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
}));
vi.mock('@/lib/useDebouncedValue', () => ({ useDebouncedValue: (v: unknown) => v }));
vi.mock('./UserDetailDrawer', () => ({
  UserDetailDrawer: ({ userId }: { userId: string | null }) =>
    userId ? <div data-testid="detail">{userId}</div> : null,
}));
// VeloExpense: no ResetPasswordDrawer (Google sign-in only).
vi.mock('./SetRoleDrawer', () => ({
  SetRoleDrawer: ({ user }: { user: { id: string } | null }) =>
    user ? <div data-testid="role">{user.id}</div> : null,
}));
vi.mock('./EditEmployeeDrawer', () => ({
  EditEmployeeDrawer: ({ user }: { user: { id: string } | null }) =>
    user ? <div data-testid="edit">{user.id}</div> : null,
}));

vi.mock('@/lib/trpc/client', () => {
  const record = (name: string, input: unknown) => {
    h.queryInputs[name] ??= [];
    h.queryInputs[name].push(input);
  };
  const procedure = (name: string) => ({
    useQuery: (input?: unknown) => {
      record(name, input);
      if (name === 'listFilterFacets') {
        return { data: h.facets, isLoading: h.facets === undefined, refetch: vi.fn() };
      }
      if (name === 'facetCounts') return { data: h.facetCounts, isLoading: false };
      if (name === 'listDirectory')
        return {
          data: { items: h.rows, totalCount: h.totalCount },
          isLoading: h.loading,
          refetch: vi.fn(),
        };
      if (name === 'list') return { data: h.savedViews, isLoading: false };
      return {
        data: undefined,
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      };
    },
    useInfiniteQuery: (input?: unknown) => {
      record(`${name}.infinite`, input);
      return {
        data: { pages: [{ items: h.rows, totalCount: h.totalCount, nextCursor: null }] },
        isLoading: h.loading,
        isFetchingNextPage: false,
        hasNextPage: h.hasNextPage,
        fetchNextPage: h.fetchNextPage,
      };
    },
    useMutation: (opts?: { onSuccess?: (d?: unknown) => void }) => ({
      isPending: false,
      mutate: (vars: unknown) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        opts?.onSuccess?.({ id: 'v-new' });
      },
      mutateAsync: async (vars: unknown) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        const result = h.results[name];
        if (result instanceof Error) throw result;
        return result ?? { id: 'v-new' };
      },
    }),
  });
  const deep = (): unknown =>
    new Proxy(() => Promise.resolve(), { get: () => deep(), apply: () => Promise.resolve() });
  const router = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => procedure(key),
  });
  return {
    trpc: {
      useUtils: () => deep(),
      users: router,
      savedViews: router,
    },
  };
});

import { EmployeeDirectory } from './EmployeeDirectory';

const FACETS = {
  businessUnits: [
    { id: 'bu-1', label: { en: 'Atlantic' } },
    { id: 'bu-2', label: { en: 'Pacific' } },
  ],
  departments: [{ id: 'dep-1', label: { en: 'Engineering' } }],
  entities: [{ id: 'le-1', label: { en: 'EBlock Canada' } }],
};

const person = (over: Record<string, unknown> = {}) => ({
  syncDiscrepancies: [],
  id: 'u-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@e.inc',
  avatarUrl: null,
  employeeStatus: 'ACTIVE',
  externalIds: {},
  entity: { id: 'le-1', label: { en: 'EBlock Canada' } },
  businessUnit: { id: 'bu-1', label: { en: 'Atlantic' } },
  department: { id: 'dep-1', label: { en: 'Engineering' } },
  nsClass: null,
  manager: null,
  // VeloExpense: no `mfaEnrolled`; access is `hasAccess`.
  hasAccess: true,
  deletedAt: null,
  role: { id: 'role-employee', label: { en: 'Employee' } },
  ...over,
});

const PROPS = {
  availableScopes: ['self', 'direct', 'chain', 'all'] as never,
  defaultScope: 'all' as never,
  isAdmin: true,
  canSetRole: true,
  canEdit: true,
  accountingClassActive: false,
  vccActive: false,
  canInvite: true,
};

type DirectoryProps = React.ComponentProps<typeof EmployeeDirectory>;

/**
 * Take the default filter off, so a test about filter MECHANICS starts from nothing.
 *
 * The directory opens on "Current employees", which is two `status equals` clauses — real
 * pills, deliberately visible. That is the product behaviour and it has its own tests
 * below; here it is just a starting position that would otherwise be folded into every
 * assertion about what clicking a facet produces.
 */
async function clearDefaultFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /table.misc.clearFilters/ }));
}

function show(rows = [person()], props: Partial<DirectoryProps> = {}) {
  h.rows = rows;
  h.totalCount = rows.length;
  return render(<EmployeeDirectory {...PROPS} {...props} />);
}

/** The most recent input the directory query was called with. */
const lastInput = (name = 'listDirectory.infinite') =>
  (h.queryInputs[name] ?? []).at(-1) as Record<string, unknown> | undefined;

/**
 * Add a clause through the pill bar's own form.
 *
 * The facet rail only ever emits `equals`, so it cannot express an exclusion — the pill
 * bar is the only surface that can, and the collapse rules have to hold for what it emits.
 */
async function addPill(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  op: string,
  value: string,
) {
  await user.click(screen.getByText(/(?:Add filter|filters\.addFilter)/));
  const combos = screen.getAllByRole('combobox');
  await user.selectOptions(combos[0], field);
  await user.selectOptions(combos[1], op);
  await user.selectOptions(screen.getAllByRole('combobox')[2], value);
  await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
}

/** The facet-rail option with this label (a status badge in the table reads the same). */
function facetOption(label: string): HTMLElement {
  const el = screen
    .getAllByText(label)
    .map((n) => n.closest('label'))
    .find((n): n is HTMLLabelElement => !!n?.querySelector('input[type="checkbox"]'));
  if (!el) throw new Error(`no facet option "${label}"`);
  return el;
}

beforeEach(() => {
  h.rows = [];
  h.totalCount = 0;
  h.loading = false;
  h.hasNextPage = false;
  h.savedViews = [];
  h.facetCounts = undefined;
  h.queryInputs = {};
  h.results = {};
  h.calls = {};
  h.fetchNextPage = vi.fn();
  h.downloads = [];
  h.facets = FACETS;
});

afterEach(() => vi.restoreAllMocks());

// ── What renders ──────────────────────────────────────────────────────────────

describe('the directory', () => {
  it('lists people with their department and state', () => {
    show();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@e.inc')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    // Twice on screen now: the default filter's pill and the row's own badge. This
    // assertion is about the ROW.
    expect(screen.getAllByText('people.status.ACTIVE').length).toBeGreaterThan(0);
  });

  it('says the list is empty rather than showing a bare table', () => {
    show([]);
    expect(screen.getByText('people.empty.title')).toBeInTheDocument();
    expect(screen.getByText('people.empty.body')).toBeInTheDocument();
  });

  it('hides the NetSuite class column until the integration is on', () => {
    /**
     * A column of empty cells is worse than no column: it implies the data exists and
     * has not been filled in.
     */
    show([person()]);
    expect(screen.queryByText('people.columns.nsClass')).not.toBeInTheDocument();

    cleanup();
    show([person()], { accountingClassActive: true });
    expect(screen.getByText('people.columns.nsClass')).toBeInTheDocument();
  });

  it('opens somebody’s detail drawer on a row click', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByText('Ada Lovelace'));
    expect(await screen.findByTestId('detail')).toHaveTextContent('u-1');
  });

  it('offers row selection only to an admin', () => {
    // The only bulk action is deactivation, which is an admin's to take.
    show();
    expect(screen.getByLabelText('people.selectAll')).toBeInTheDocument();

    cleanup();
    show([person()], { isAdmin: false });
    expect(screen.queryByLabelText('people.selectAll')).not.toBeInTheDocument();
  });
});

// ── Row actions ───────────────────────────────────────────────────────────────

describe('row actions', () => {
  const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getAllByRole('button', { name: 'people.actions.menu' })[0]);
  };

  it('opens the change-role and edit drawers, and offers no password reset', async () => {
    // VeloExpense: no Reset password — Google sign-in only.
    const user = userEvent.setup();
    show();
    await openMenu(user);
    expect(screen.queryByText('people.actions.resetPassword')).not.toBeInTheDocument();
    await user.click(await screen.findByText('people.actions.setRole'));
    expect(await screen.findByTestId('role')).toHaveTextContent('u-1');

    await openMenu(user);
    await user.click(await screen.findByText('people.actions.edit'));
    expect(await screen.findByTestId('edit')).toHaveTextContent('u-1');
  });

  it('withholds each action from somebody without the permission for it', async () => {
    /**
     * Cosmetic — every procedure re-checks — but offering "change role" to somebody who
     * cannot is offering an error message.
     */
    const user = userEvent.setup();
    show([person()], { isAdmin: false, canSetRole: false, canEdit: false });
    await openMenu(user);
    expect(await screen.findByText('people.actions.view')).toBeInTheDocument();
    expect(screen.queryByText('people.actions.setRole')).not.toBeInTheDocument();
    expect(screen.queryByText('people.actions.edit')).not.toBeInTheDocument();
    expect(screen.queryByText('people.actions.resetPassword')).not.toBeInTheDocument();
    expect(screen.queryByText('people.actions.grantAccess')).not.toBeInTheDocument();
    expect(screen.queryByText('people.actions.revokeAccess')).not.toBeInTheDocument();
  });

  it('grants sign-in to somebody without it', async () => {
    const user = userEvent.setup();
    show([person({ hasAccess: false })]);
    await openMenu(user);
    // Only the way the person is not: the Access column already says which they are.
    expect(screen.queryByText('people.actions.revokeAccess')).not.toBeInTheDocument();
    await user.click(await screen.findByText('people.actions.grantAccess'));
    expect(h.calls.setAccess).toEqual([{ id: 'u-1', hasAccess: true }]);
  });

  it('revokes it from somebody who has it', async () => {
    const user = userEvent.setup();
    show([person({ hasAccess: true })]);
    await openMenu(user);
    expect(screen.queryByText('people.actions.grantAccess')).not.toBeInTheDocument();
    await user.click(await screen.findByText('people.actions.revokeAccess'));
    expect(h.calls.setAccess).toEqual([{ id: 'u-1', hasAccess: false }]);
  });
});

// ── What the server is asked ──────────────────────────────────────────────────

describe('the query the table sends', () => {
  it('starts paged, at the default scope', () => {
    /**
     * Paged by default because the directory is the biggest list in the product; the
     * single-shot path is reserved for the two things that genuinely need every row.
     */
    show();
    expect(lastInput()).toMatchObject({ scope: 'all', take: 50, includeDeleted: false });
  });

  it('collapses two facet selections on one field into an OR', async () => {
    /**
     * The rule the whole facet rail rests on. `isAnyOf` widens; two ANDed `equals`
     * clauses match nobody, and an empty table reads as "no such people" rather than as
     * an impossible filter.
     */
    const user = userEvent.setup();
    show();
    await clearDefaultFilters(user);
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    await user.click(facetOption('people.status.ACTIVE'));
    await user.click(facetOption('people.status.ON_LEAVE'));
    expect(lastInput()?.status).toEqual({ op: 'isAnyOf', values: ['ACTIVE', 'ON_LEAVE'] });
  });

  it('sends a single clause as itself, not as a one-element OR', async () => {
    const user = userEvent.setup();
    show();
    await clearDefaultFilters(user);
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    await user.click(facetOption('people.status.ACTIVE'));
    expect(lastInput()?.status).toEqual({ op: 'equals', value: 'ACTIVE' });
  });

  it('includes soft-deleted people exactly when they are being looked for', async () => {
    /**
     * The filter whose entire purpose is finding leavers would otherwise return
     * nothing, because the query excludes them by default.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    await user.click(facetOption('people.status.TERMINATED'));
    expect(lastInput()?.includeDeleted).toBe(true);
  });

  it('keeps them out for any other status', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    await user.click(facetOption('people.status.ON_LEAVE'));
    expect(lastInput()?.includeDeleted).toBe(false);
  });

  it('switches to a single-shot fetch for grouping', async () => {
    /**
     * Grouping needs every row at once. Partitioning a page would split a group across
     * two loads, and the group's count would be the count of what happened to be
     * fetched.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: 'table.settings.trigger' }));
    const all = screen.getAllByText('people.columns.department');
    await user.click(all[all.length - 1]);
    expect(lastInput('listDirectory')).toMatchObject({ take: 1000 });
  });

  it('collapses two exclusions into a single NONE-OF', async () => {
    /**
     * The mirror of the OR. Two `doesNotEqual` clauses ANDed would be correct but the
     * server takes one predicate per field, so the pair has to arrive as `isNoneOf` —
     * sent as two separate clauses the second silently replaces the first, and one of
     * the two statuses somebody excluded comes back.
     */
    const user = userEvent.setup();
    show();
    await clearDefaultFilters(user);
    await addPill(user, 'status', 'doesNotEqual', 'ACTIVE');
    await addPill(user, 'status', 'doesNotEqual', 'ON_LEAVE');
    expect(lastInput()?.status).toEqual({ op: 'isNoneOf', values: ['ACTIVE', 'ON_LEAVE'] });
  });

  it('sends a mixed pair as a list rather than guessing which one wins', async () => {
    /**
     * "is X" and "is not Y" on one field is not an OR and not a NONE-OF. Forcing it into
     * either shape would answer a question nobody asked; the list lets the server AND
     * them, which is what the reader wrote.
     */
    const user = userEvent.setup();
    show();
    await clearDefaultFilters(user);
    await addPill(user, 'status', 'equals', 'ACTIVE');
    await addPill(user, 'status', 'doesNotEqual', 'ON_LEAVE');
    expect(lastInput()?.status).toEqual([
      { op: 'equals', value: 'ACTIVE' },
      { op: 'doesNotEqual', value: 'ON_LEAVE' },
    ]);
  });

  it('asks for counts on the three faceted fields only', () => {
    // Entity, email and external ids are high-cardinality; counting them would be a
    // full scan for a list nobody reads.
    show();
    expect(lastInput('facetCounts')).toMatchObject({
      fields: ['status', 'businessUnit', 'department'],
    });
  });
});

// ── Facet counts ──────────────────────────────────────────────────────────────

describe('the facet rail', () => {
  it('shows a count beside each option once they arrive', async () => {
    const user = userEvent.setup();
    h.facetCounts = { counts: { status: [{ value: 'ACTIVE', count: 12 }] } };
    show();
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    const option = facetOption('people.status.ACTIVE');
    expect(option).toHaveTextContent('12');
  });

  it('shows zero for an option the count response did not mention', async () => {
    /**
     * Absent from the response means none matched — not "unknown". Leaving it blank
     * would make an option look unavailable rather than empty.
     */
    const user = userEvent.setup();
    h.facetCounts = { counts: { status: [{ value: 'ACTIVE', count: 12 }] } };
    show();
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    const option = facetOption('people.status.ON_LEAVE');
    expect(option).toHaveTextContent('0');
  });

  it('shows no counts at all until the query answers', async () => {
    // A zero everywhere while loading reads as an empty directory.
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    const option = facetOption('people.status.ACTIVE');
    expect(option.textContent).toBe('people.status.ACTIVE');
  });

  it('toggles a value off on a second click', async () => {
    const user = userEvent.setup();
    show();
    await clearDefaultFilters(user);
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    await user.click(facetOption('people.status.ACTIVE'));
    expect(lastInput()?.status).toBeTruthy();
    await user.click(facetOption('people.status.ACTIVE'));
    expect(lastInput()?.status).toBeUndefined();
  });

  it('hides again', async () => {
    const user = userEvent.setup();
    show();
    await clearDefaultFilters(user);
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    await user.click(screen.getByRole('button', { name: /table.misc.hideFilters/ }));
    expect(screen.queryByText('people.status.ON_LEAVE')).not.toBeInTheDocument();
  });
});

// ── Saved views ───────────────────────────────────────────────────────────────

describe('saved views', () => {
  it('offers the system views alongside anything saved', async () => {
    const user = userEvent.setup();
    h.savedViews = [{ id: 'v1', name: 'My team, active', pinned: false, state: { filters: [] } }];
    show();
    await user.click(screen.getByRole('button', { name: /Current employees/ }));
    expect(await screen.findByText('Active managers')).toBeInTheDocument();
    expect(screen.getByText('No manager (needs HR)')).toBeInTheDocument();
    expect(screen.getByText('My team, active')).toBeInTheDocument();
  });

  it('applies a system view’s filters and scope', async () => {
    /**
     * "My team" is a SCOPE change, not a filter — the difference matters because scope
     * is what the server walks the reporting chain for.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /Current employees/ }));
    await user.click(await screen.findByText('My team'));
    expect(lastInput()?.scope).toBe('chain');
  });

  it('applies the data-health view that finds people with no manager', async () => {
    /**
     * Not a convenience view: an approval routed to "the requester's manager" cannot
     * resolve one for these people, so their reports fall through to the approver pool.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /Current employees/ }));
    await user.click(await screen.findByText('No manager (needs HR)'));
    expect(lastInput()).toMatchObject({
      status: { op: 'equals', value: 'ACTIVE' },
      manager: { op: 'isEmpty' },
    });
  });

  it('sends the access filter to the server instead of dropping it', async () => {
    /**
     * The regression this exists for: the pill bar built the clause, the pill rendered
     * `Access equals "Can sign in"`, and the query input did not carry it — so the table
     * went on showing all 873 people while claiming to be filtered. `baseInput` listed
     * every other field and omitted this one, exactly as it once omitted `manager` and
     * turned the "No manager (needs HR)" view into a list of every active employee.
     *
     * Unit tests passed either way before this: the filter translator was right and the
     * pill bar was right, and nothing asserted that the two were joined up. It was found
     * in a browser.
     */
    const user = userEvent.setup();
    show();
    await addPill(user, 'access', 'equals', 'granted');
    expect(lastInput()).toMatchObject({ access: { op: 'equals', value: 'granted' } });
  });

  it('saves the current state as a new view', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Atlantic actives');
    show();
    await user.click(screen.getByRole('button', { name: /Current employees/ }));
    await user.click(await screen.findByText('Save current as new view'));
    expect((h.calls.create ?? [])[0]).toMatchObject({
      resource: 'people',
      name: 'Atlantic actives',
    });
  });

  it('writes nothing when the name prompt is cancelled', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    show();
    await user.click(screen.getByRole('button', { name: /Current employees/ }));
    await user.click(await screen.findByText('Save current as new view'));
    expect(h.calls.create).toBeUndefined();
  });

  it('applies a pinned view once, as the person’s own default', async () => {
    /**
     * Once: switching back to "All employees" afterwards has to stick, so the effect is
     * guarded rather than re-running whenever the saved-view query refetches.
     */
    h.savedViews = [
      {
        id: 'v1',
        name: 'Pinned',
        pinned: true,
        state: { filters: [{ id: 'f1', field: 'status', op: 'equals', value: 'ON_LEAVE' }] },
      },
    ];
    show();
    expect(lastInput()?.status).toEqual({ op: 'equals', value: 'ON_LEAVE' });
  });
});

// ── Bulk deactivation ─────────────────────────────────────────────────────────

describe('bulk deactivation', () => {
  it('deactivates every selected person, one at a time', async () => {
    /**
     * Sequential and soft-failing per row: deactivating twelve people must not stop at
     * the first one whose row is locked, and there is no bulk endpoint to fan out to.
     */
    const user = userEvent.setup();
    show([person({ id: 'u-1' }), person({ id: 'u-2', firstName: 'Grace', lastName: 'Hopper' })]);
    await user.click(screen.getByLabelText('people.selectAll'));
    await user.click(screen.getByRole('button', { name: /table.misc.selected:2|selected/ }));
    await user.click(await screen.findByText('people.actions.deactivate'));
    expect(h.calls.deactivate).toEqual([{ id: 'u-1' }, { id: 'u-2' }]);
  });

  it('offers no bulk action until something is selected', () => {
    // (Grant and revoke access, below, follow the same rule.)
    // A permanently greyed button is noise on every list you open.
    show();
    expect(screen.queryByText('people.actions.deactivate')).not.toBeInTheDocument();
  });
});

// ── Bulk access ───────────────────────────────────────────────────────────────

describe('bulk grant and revoke', () => {
  const two = () => [
    person({ id: 'u-1', hasAccess: false }),
    person({ id: 'u-2', firstName: 'Grace', lastName: 'Hopper', hasAccess: true }),
  ];
  const openBulk = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByLabelText('people.selectAll'));
    await user.click(screen.getByRole('button', { name: /table.misc.selected:2|selected/ }));
  };

  it('grants the selection in one call and says what happened', async () => {
    /**
     * One request, not one per row: the server decides who actually changes (skipping the
     * ones who already can) and the sentence repeats its count rather than the selection's.
     */
    h.results.setAccessMany = { changed: 1, unchanged: 1, skippedSelf: 0, notFound: 0 };
    const user = userEvent.setup();
    show(two());
    await openBulk(user);
    await user.click(await screen.findByText('people.actions.grantAccess'));
    expect(h.calls.setAccessMany).toEqual([{ ids: ['u-1', 'u-2'], hasAccess: true }]);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('people.accessBulk.granted:1');
    expect(status).toHaveTextContent('people.accessBulk.alreadyGranted:1');
  });

  it('says when the caller’s own access was kept on a revoke', async () => {
    h.results.setAccessMany = { changed: 0, unchanged: 1, skippedSelf: 1, notFound: 0 };
    const user = userEvent.setup();
    show(two());
    await openBulk(user);
    await user.click(await screen.findByText('people.actions.revokeAccess'));
    expect(h.calls.setAccessMany).toEqual([{ ids: ['u-1', 'u-2'], hasAccess: false }]);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('people.accessBulk.noneChanged');
    expect(status).toHaveTextContent('people.accessBulk.alreadyRevoked:1');
    expect(status).toHaveTextContent('people.accessBulk.skippedSelf');
  });

  it('says so when the call fails, and keeps the selection to try again', async () => {
    h.results.setAccessMany = new Error('boom');
    const user = userEvent.setup();
    show(two());
    await openBulk(user);
    await user.click(await screen.findByText('people.actions.grantAccess'));
    expect(await screen.findByRole('status')).toHaveTextContent('people.accessBulk.failed');
    expect(screen.getByRole('button', { name: /table.misc.selected:2|selected/ })).toBeVisible();
  });

  it('goes away when dismissed', async () => {
    h.results.setAccessMany = { changed: 2, unchanged: 0, skippedSelf: 0, notFound: 0 };
    const user = userEvent.setup();
    show(two());
    await openBulk(user);
    await user.click(await screen.findByText('people.actions.grantAccess'));
    await user.click(await screen.findByRole('button', { name: 'people.accessBulk.dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('is not offered to somebody who may not change a role', async () => {
    // Same gate as Change role, and the same gate the server applies.
    const user = userEvent.setup();
    show(two(), { canSetRole: false });
    await openBulk(user);
    expect(await screen.findByText('people.actions.deactivate')).toBeInTheDocument();
    expect(screen.queryByText('people.actions.grantAccess')).not.toBeInTheDocument();
    expect(screen.queryByText('people.actions.revokeAccess')).not.toBeInTheDocument();
  });
});

// ── Grouping, sorting and export, which all need every row at once ────

/**
 * The three things that only work in single-shot mode, and the accessors behind them.
 *
 * Each of `groupKeyForRow`, `sortedRows` and the export table has to read the SAME value
 * the cell renders. A grouper that read the raw column would partition by uuid — a rail of
 * groups labelled with identifiers; a sort that read the object would compare
 * `[object Object]` against itself and leave the order untouched while the header claims it
 * sorted; an export that read the object would put `[object Object]` in a spreadsheet
 * somebody sends to Finance. Three different symptoms of the same mistake, none of which
 * throws.
 */

/**
 * Group the table by a column, through the settings panel — the only way in.
 *
 * Escape at the end is not optional: the settings popover is a base-ui dialog, and while
 * it is open the rest of the page carries `data-base-ui-inert`. Queries still find those
 * nodes, so the failure is not "element missing" but assertions against a table that has
 * not re-rendered behind the overlay.
 */
async function groupBy(user: ReturnType<typeof userEvent.setup>, columnLabel: string) {
  await user.click(screen.getByRole('button', { name: 'table.settings.trigger' }));
  const all = screen.getAllByText(columnLabel);
  await user.click(all[all.length - 1]);
  await user.keyboard('{Escape}');
}

/**
 * Actually GROUP the table.
 *
 * The popover carries two lists that read alike: the column-visibility toggles, labelled
 * `people.columns.*`, and the group-by options, labelled `people.groupBy.*`. Clicking the
 * first hides a column and leaves `state.groupBy` null — so `groupKeyFor` is never called
 * and the partitioning under test never happens.
 */
async function groupTableBy(user: ReturnType<typeof userEvent.setup>, field: string) {
  await user.click(screen.getByRole('button', { name: 'table.settings.trigger' }));
  const all = await screen.findAllByText(`people.groupBy.${field}`);
  await user.click(all[all.length - 1]);
  await user.keyboard('{Escape}');
}

describe('grouping', () => {
  /**
   * `groupKeyForRow` runs once per row to partition the table, and every relation it
   * reads is nullable — the CEO has no manager, a contractor may have no business unit,
   * and somebody created by SSO has neither until the directory sync fills them in. One
   * exception in the grouper empties the whole table.
   *
   * The group HEADER is queryable: it renders the label in a disclosure button. So each
   * case asserts the label the grouper produced, not merely that the rows survived — the
   * previous version of this suite clicked the column-VISIBILITY toggle rather than the
   * group-by option, so `state.groupBy` stayed null and none of this ran.
   */
  const groupsBy = async (field: string, rows: ReturnType<typeof person>[]) => {
    const user = userEvent.setup();
    show(rows);
    // Off first: a status group header and the default status pill are both buttons named
    // `people.status.ACTIVE`, and `groupHeader` below resolves a button BY NAME.
    await clearDefaultFilters(user);
    await groupTableBy(user, field);
    return user;
  };

  /** The disclosure button a group header renders, by the label the grouper returned. */
  const groupHeader = (label: string) => screen.getByRole('button', { name: label });

  it('groups by status, under the localized name rather than the enum', async () => {
    await groupsBy('status', [person({ employeeStatus: 'ACTIVE' })]);
    expect(groupHeader('people.status.ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('ada@e.inc')).toBeInTheDocument();
  });

  it('groups by business unit, under its label', async () => {
    await groupsBy('businessUnit', [person()]);
    expect(groupHeader('Atlantic')).toBeInTheDocument();
  });

  it('groups by department, under its label', async () => {
    await groupsBy('department', [person()]);
    expect(groupHeader('Engineering')).toBeInTheDocument();
  });

  it('groups by manager, under the manager’s display name', async () => {
    await groupsBy('manager', [
      person({ manager: { id: 'm-1', firstName: 'Grace', lastName: 'Hopper' } }),
    ]);
    expect(groupHeader('Grace Hopper')).toBeInTheDocument();
  });

  it('gathers the people with no value under one placeholder', async () => {
    /**
     * Returning null hands the placeholder decision to the DataTable, which has one.
     * Throwing — or inventing a label — is how a table empties itself over somebody whose
     * profile the directory sync has not filled in yet.
     */
    await groupsBy('manager', [
      person({ id: 'u-1', manager: null }),
      person({ id: 'u-2', email: 'bob@e.inc', manager: null }),
    ]);
    expect(groupHeader('people.groupBy.unassigned')).toBeInTheDocument();
    expect(screen.getByText('ada@e.inc')).toBeInTheDocument();
    expect(screen.getByText('bob@e.inc')).toBeInTheDocument();
  });

  it('reads a manager record with no name as no manager', async () => {
    /** Both name fields empty joins to '', which has to read as "no manager" rather than
     *  as a group whose label is blank. */
    await groupsBy('manager', [
      person({ manager: { id: 'm-1', firstName: null, lastName: null } }),
    ]);
    expect(groupHeader('people.groupBy.unassigned')).toBeInTheDocument();
  });

  it('places somebody with a partial name under the half they have', async () => {
    await groupsBy('manager', [
      person({ manager: { id: 'm-1', firstName: 'Grace', lastName: null } }),
    ]);
    expect(groupHeader('Grace')).toBeInTheDocument();
  });

  it('gathers the people with no business unit under the placeholder', async () => {
    await groupsBy('businessUnit', [
      person({ id: 'u-1' }),
      person({ id: 'u-2', email: 'contractor@e.inc', businessUnit: null }),
    ]);
    expect(groupHeader('Atlantic')).toBeInTheDocument();
    expect(groupHeader('people.groupBy.unassigned')).toBeInTheDocument();
  });

  it('gathers the people with no department under the placeholder', async () => {
    await groupsBy('department', [person({ department: null })]);
    expect(groupHeader('people.groupBy.unassigned')).toBeInTheDocument();
  });

  it('loads every row at once, so a group is not split across pages', async () => {
    /** A group split mid-page reports the count of whichever page happened to be
     *  loaded — a number that changes as the reader scrolls. */
    await groupsBy('department', [person()]);
    expect(lastInput('listDirectory')).toMatchObject({ take: 1000 });
  });

  it('does not group when a column is merely hidden', async () => {
    /**
     * The settings popover carries two lists that read alike: the column-visibility
     * toggles (`people.columns.*`) and the group-by options (`people.groupBy.*`). Hiding
     * a column is not grouping by it, and clicking the wrong one is exactly how this
     * suite used to pass without grouping anything.
     */
    const user = userEvent.setup();
    show([person()]);
    await groupBy(user, 'people.columns.department');
    expect(screen.queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
  });
});

describe('client-side sorting, once every row is loaded', () => {
  const people = [
    person({ id: 'u-1', firstName: 'Ada', email: 'ada@e.inc' }),
    person({ id: 'u-2', firstName: 'Zoe', email: 'zoe@e.inc' }),
    person({ id: 'u-3', firstName: null, email: 'none@e.inc' }),
  ];

  /** Sorting is only client-side in single-shot mode, which grouping turns on. */
  const sortWithin = async (user: ReturnType<typeof userEvent.setup>, column: string) => {
    await groupBy(user, 'people.columns.department');
    const header = screen.getByText(column).closest('th') as HTMLElement;
    const buttons = header.querySelectorAll('button');
    await user.click(buttons[buttons.length - 1]);
    const asc = await screen.findByText('table.colMenu.sortAsc');
    await user.click(asc);
  };

  it('orders the loaded rows without asking the server again', async () => {
    const user = userEvent.setup();
    show(people);
    await sortWithin(user, 'people.columns.name');
    const emails = screen.getAllByText(/@e\.inc$/).map((n) => n.textContent);
    expect(emails.length).toBeGreaterThan(0);
  });

  it('sorts a missing value as empty rather than crashing on it', async () => {
    /** A person with no first name is ordinary — SSO creates them before the directory
     *  sync fills the profile — and `localeCompare` on null throws. */
    const user = userEvent.setup();
    show(people);
    await sortWithin(user, 'people.columns.name');
    expect(screen.getByText('none@e.inc')).toBeInTheDocument();
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * What a downloaded directory actually contains.
 *
 * Every column renders JSX, which cannot be stringified — so each one carries a separate
 * plain-text accessor, and those accessors are a second implementation of the same reading.
 * When they drift, the export is wrong in a file somebody opens in a spreadsheet a week
 * later, with nothing on screen having looked wrong.
 */
describe('exporting the directory', () => {
  const exportCsv = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /people.actions.export/ }));
    await user.click(await screen.findByText('CSV'));
    return h.downloads.at(-1);
  };

  it('writes the same values the table shows', async () => {
    const user = userEvent.setup();
    show([
      person({
        manager: { id: 'm-1', firstName: 'Grace', lastName: 'Hopper' },
        externalIds: { netsuite: '4242' },
      }),
    ]);
    const out = await exportCsv(user);
    expect(out?.filename).toBe('employees');
    expect(out?.csv).toContain('Ada Lovelace');
    expect(out?.csv).toContain('ada@e.inc');
    expect(out?.csv).toContain('EBlock Canada');
    expect(out?.csv).toContain('Atlantic');
    expect(out?.csv).toContain('Engineering');
    expect(out?.csv).toContain('Grace Hopper');
    expect(out?.csv).toContain('netsuite: 4242');
  });

  it('falls back to the email for somebody with no name on file', async () => {
    /** A row of blank cells in a spreadsheet is indistinguishable from a broken export;
     *  the email at least identifies the person. */
    const user = userEvent.setup();
    show([person({ firstName: null, lastName: null })]);
    expect((await exportCsv(user))?.csv).toContain('ada@e.inc');
  });

  it('leaves an unassigned relation empty rather than writing "null"', async () => {
    const user = userEvent.setup();
    show([
      person({ entity: null, businessUnit: null, department: null, manager: null, nsClass: null }),
    ]);
    const csv = (await exportCsv(user))?.csv ?? '';
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });

  it('writes access as words, not a raw boolean', async () => {
    // VeloExpense: ExpenseOS's case here is the MFA column, which is not ported; access is
    // the other boolean the export turns into words.
    const user = userEvent.setup();
    show([person({ hasAccess: false })]);
    expect((await exportCsv(user))?.csv).toContain('people.access.denied');
  });

  it('writes the localized status rather than the enum', async () => {
    const user = userEvent.setup();
    show([person({ employeeStatus: 'ON_LEAVE' })]);
    const csv = (await exportCsv(user))?.csv ?? '';
    expect(csv).toContain('people.status.ON_LEAVE');
  });

  it('joins several external ids into one readable cell', async () => {
    const user = userEvent.setup();
    show([person({ externalIds: { netsuite: '1', concur: '2' } })]);
    const csv = (await exportCsv(user))?.csv ?? '';
    expect(csv).toContain('netsuite: 1');
    expect(csv).toContain('concur: 2');
  });

  it('exports the rows on screen, in the order they are shown', async () => {
    const user = userEvent.setup();
    show([
      person({ id: 'u-1', firstName: 'Ada', email: 'ada@e.inc' }),
      person({ id: 'u-2', firstName: 'Bob', email: 'bob@e.inc' }),
    ]);
    const csv = (await exportCsv(user))?.csv ?? '';
    expect(csv.indexOf('ada@e.inc')).toBeLessThan(csv.indexOf('bob@e.inc'));
  });
});

// ── Managing a saved view ─────────────────────────────────────────────────────

describe('renaming and deleting a saved view', () => {
  const openViews = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /Current employees/ }));
  };

  beforeEach(() => {
    h.savedViews = [{ id: 'v1', name: 'Atlantic actives', pinned: false, state: { filters: [] } }];
  });

  it('renames a view to what was typed', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Atlantic — active only');
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: /Rename/ }));
    expect((h.calls.update ?? [])[0]).toMatchObject({ id: 'v1', name: 'Atlantic — active only' });
  });

  it('writes nothing when the rename prompt is cancelled', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: /Rename/ }));
    expect(h.calls.update).toBeUndefined();
  });

  it('writes nothing when the name comes back unchanged', async () => {
    /** A no-op write still invalidates the query and repaints the bar, which reads as
     *  something having happened. */
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Atlantic actives');
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: /Rename/ }));
    expect(h.calls.update).toBeUndefined();
  });

  it('writes nothing for a blank name', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('   ');
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: /Rename/ }));
    expect(h.calls.update).toBeUndefined();
  });

  it('asks before deleting, and names the view', async () => {
    /** A saved view is somebody's own configuration and there is no undo. */
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: /Delete/ }));
    expect(String(confirm.mock.calls[0][0])).toContain('Atlantic actives');
    expect((h.calls.delete ?? [])[0]).toMatchObject({ id: 'v1' });
  });

  it('keeps the view when the confirm is dismissed', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: /Delete/ }));
    expect(h.calls.delete).toBeUndefined();
  });
});

// ── Editing a filter after it is on the bar ───────────────────────────────────

/**
 * A pill is not write-once. Changing its operator or value has to update THAT clause and
 * leave the others alone — a reader narrowing one facet must not lose the three they set
 * before it.
 */
describe('editing the pills', () => {
  /** Open the facet rail and tick two facets on different fields. */
  const twoFacets = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    await user.click(facetOption('people.status.ACTIVE'));
    await user.click(facetOption('Atlantic'));
    await waitFor(() => expect(lastInput()?.businessUnit).toBeTruthy());
  };

  it('drops one pill and keeps the rest', async () => {
    /** A reader narrowing one facet must not lose the others they set before it. */
    const user = userEvent.setup();
    show();
    await twoFacets(user);
    await user.click(
      screen.getAllByRole('button', { name: /(?:Remove condition|filters\.removeCondition)/ })[0],
    );
    await waitFor(() => expect(lastInput()?.status).toBeUndefined());
    expect(lastInput()?.businessUnit).toEqual({ op: 'equals', value: 'bu-1' });
  });

  it('clears every pill at once', async () => {
    const user = userEvent.setup();
    show();
    await twoFacets(user);
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    await waitFor(() => expect(lastInput()?.status).toBeUndefined());
    expect(lastInput()?.businessUnit).toBeUndefined();
  });

  it('unticking a facet takes its clause off the query', async () => {
    /** The rail and the pill bar are two views of one filter set; unticking has to reach
     *  the query, or the count beside the table disagrees with what is shown. */
    const user = userEvent.setup();
    show();
    await clearDefaultFilters(user);
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    await user.click(facetOption('people.status.ACTIVE'));
    await waitFor(() => expect(lastInput()?.status).toBeTruthy());
    await user.click(facetOption('people.status.ACTIVE'));
    await waitFor(() => expect(lastInput()?.status).toBeUndefined());
  });
});

// ── Before the facets arrive ──────────────────────────────────────────────────

describe('the rail on the first paint of a visit', () => {
  /**
   * The rows and the facet OPTIONS are separate queries, and the options one reads three
   * lookup tables. So there is a real window where the directory is on screen and the
   * rail knows no business units, no departments and no entities.
   *
   * The rail still has to open — the status and MFA facets are built from constants and
   * are useful immediately, and a rail that refused to open until three lookups landed
   * would be a button that does nothing for the first second of every visit.
   */
  const withoutFacets = () => {
    h.facets = undefined;
    return show();
  };

  it('still lists the people', () => {
    withoutFacets();
    expect(screen.getByText('ada@e.inc')).toBeInTheDocument();
  });

  it('opens with the facets it can build from constants', async () => {
    const user = userEvent.setup();
    withoutFacets();
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    expect(facetOption('people.status.ACTIVE')).toBeInTheDocument();
    expect(facetOption('people.status.ON_LEAVE')).toBeInTheDocument();
  });

  it('offers no business unit or department to pick from yet', async () => {
    /** An empty list is honest; inventing an option is not. */
    const user = userEvent.setup();
    withoutFacets();
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    // The row's own cells still name its unit — the assertion is about the RAIL, which
    // is the only place those strings appear as a tickable option.
    expect(() => facetOption('Atlantic')).toThrow();
    expect(() => facetOption('Engineering')).toThrow();
  });

  it('names a unit by its id rather than dropping it when the label is missing', async () => {
    /**
     * `label` is a locale map and can be `{}` on a row a migration wrote. Dropping the
     * option would make the unit unfilterable; the id is at least selectable and matches
     * what the query sends.
     */
    const user = userEvent.setup();
    h.facets = { businessUnits: [{ id: 'bu-9', label: {} }], departments: [], entities: [] };
    show();
    await user.click(screen.getByRole('button', { name: /table.misc.showFilters/ }));
    expect(facetOption('bu-9')).toBeInTheDocument();
  });
});

/**
 * The directory opens on CURRENT employees.
 *
 * "All employees" showed leavers beside current staff in the directory, in My reports and
 * in My direct reports, with nothing on screen saying so — a manager's report count
 * included people who had left. The filter is deliberately a real pill rather than a hidden
 * server-side default: somebody looking for a leaver can see why they are not there.
 */
describe('the default view hides leavers', () => {
  it('opens with a status filter, not with everybody', () => {
    show();
    expect(lastInput()?.status).toEqual({ op: 'isAnyOf', values: ['ACTIVE', 'ON_LEAVE'] });
  });

  it('leaves the terminated and the deactivated out of it', () => {
    show();
    const status = lastInput()?.status as { values: string[] };
    expect(status.values).not.toContain('TERMINATED');
    expect(status.values).not.toContain('DEACTIVATED');
  });

  it('does not ask the server for soft-deleted rows either', () => {
    // `includeDeleted` turns on only when somebody filters FOR leavers.
    expect(show() && lastInput()?.includeDeleted).toBe(false);
  });

  it('is a visible pill, so it can be taken off', async () => {
    /**
     * The whole argument for a filter over a hidden default. Clearing it has to return the
     * unfiltered list — otherwise the leaver a person is looking for is unreachable.
     */
    const user = userEvent.setup();
    show();
    await clearDefaultFilters(user);
    expect(lastInput()?.status).toBeUndefined();
  });

  it('still offers "All employees" as its own view', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: /Current employees/ }));
    expect(await screen.findByText('All employees')).toBeInTheDocument();
  });
});

describe('People ↔ NetSuite badge', () => {
  it('shows a quiet badge only for a person NetSuite disagrees about', () => {
    show([
      person({ syncDiscrepancies: [{ field: 'DEPARTMENT', divergesFromDirectory: false }] }),
      person({ id: 'u-2', firstName: 'Grace', lastName: 'Hopper', email: 'grace@e.inc' }),
    ]);
    const badges = screen.getAllByTestId('people-sync-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('people.sync.badge');
    // It says "look", not what: the ruling lives on /netsuite/people.
    expect(badges[0].getAttribute('title')).toContain('people.sync.badgeTitle');
  });

  it('shows nothing when the two systems agree', () => {
    show([person()]);
    expect(screen.queryByTestId('people-sync-badge')).not.toBeInTheDocument();
  });
});

// ── VeloExpense: Add user and the invitations link ────────────────────────────

/**
 * Decided 17 Oct 2026: Add user opens the invite form at /users/invite (role, manager and the
 * rest set before the person arrives) instead of ExpenseOS's email-only dialog, and the
 * invitations still waiting are one click away beside it.
 */
describe('Add user and pending invitations (VeloExpense)', () => {
  const topBar = () => render(<>{h.topBarRight}</>);

  it('sends an admin to the invite form', () => {
    show();
    cleanup();
    topBar();
    expect(screen.getByRole('link', { name: 'people.addUser' }).getAttribute('href')).toBe('/users/invite');
  });

  it('links to the invitations still waiting, with their count', () => {
    show([person()], { pendingInviteCount: 3 });
    cleanup();
    topBar();
    expect(screen.getByRole('link', { name: 'people.pendingInvites:3' }).getAttribute('href')).toBe(
      '/users/invitations',
    );
  });

  it('offers no invitations link when none are waiting', () => {
    show([person()], { pendingInviteCount: 0 });
    cleanup();
    topBar();
    expect(screen.queryByRole('link', { name: /pendingInvites/ })).not.toBeInTheDocument();
  });

  it('offers neither to somebody who may not invite, even one who reads everybody', () => {
    show([person()], { isAdmin: true, canInvite: false, pendingInviteCount: 3 });
    expect(h.topBarRight).toBeNull();
  });
});
