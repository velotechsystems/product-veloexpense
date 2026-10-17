'use client';

/*
 * The People directory (/users). Ported from ExpenseOS (1e682dd6), People 3; each change is
 * marked "VeloExpense:". In short: no MFA column and no Reset password (Google sign-in only),
 * access is `hasAccess`, and Add user opens the invite form (decided 17 Oct 2026).
 */

import {
  Button,
  type ColumnFilter,
  DataTableToolbar,
  type Density,
  externalIdEntries,
  TableSettingsButton,
} from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import { IconLock, IconLockOpen } from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDataTableState,
  DataTable,
  type DataTableState,
  FacetRail,
  type FilterClause,
  type FilterOp,
  newClauseId,
  type PersistedViewState,
  type SystemView,
  TableExportMenu,
  useDebouncedValue,
  useSavedViews,
  useTableLabels,
  useToolbarLabels,
  VALUELESS_OPS,
  ViewsBar,
} from '@/components/data-view';
import { EMPLOYEE_STATUSES, type EmployeeStatus } from '@/lib/employeeStatus';
import { Link as LocaleLink } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc/client';
import type { DirectoryScope } from '@/server/lib/userScope';
import { useTopBarSlots } from '../TopBar';
import { EditEmployeeDrawer } from './EditEmployeeDrawer';
import { buildPeopleColumns, type PeopleColumnId, type PeopleRow } from './EmployeeDirectory.cells';
// VeloExpense: no ResetPasswordDrawer — people sign in with Google only.
import { SetRoleDrawer } from './SetRoleDrawer';
import { UserDetailDrawer } from './UserDetailDrawer';

interface EmployeeDirectoryProps {
  availableScopes: DirectoryScope[];
  defaultScope: DirectoryScope;
  isAdmin: boolean;
  /** Whether the viewer holds P.user.setRole (enables the Change-role action). */
  canSetRole: boolean;
  /** Whether the viewer holds P.user.update (enables the Edit action). */
  canEdit: boolean;
  /**
   * The accounting integration's class dimension is on — gates the Class column (ExpenseOS:
   * `accountingClassActive`, the NetSuite Class). VeloExpense: named for what it gates, not the vendor
   * (scripts/check-vendor-neutral.mjs).
   */
  accountingClassActive: boolean;
  /** Virtual-cards module active — gates the VCC section in the detail drawer. */
  vccActive: boolean;
  /**
   * Where the integration's People review lives (ExpenseOS: `/netsuite/people`), for a viewer
   * who may rule on a People ↔ integration disagreement; absent, there is no review link.
   * VeloExpense: a path handed in rather than a vendor route written here
   * (scripts/check-vendor-neutral.mjs) — Wave 5's integration supplies it.
   */
  syncReviewPath?: string;
  /**
   * VeloExpense: invitations sent and not yet accepted, shown beside Add user as a link to
   * /users/invitations. Counted for admins only; 0 hides it.
   */
  pendingInviteCount?: number;
  /**
   * VeloExpense: may send and withdraw invitations — VeloExpense's admin permission, which
   * the invite form's server actions require (`asAdmin`). Gates Add user and the link.
   */
  canInvite?: boolean;
}

/**
 * The statuses a directory shows unless somebody asks otherwise.
 *
 * ACTIVE and ON_LEAVE are the people you can still act on — assign work to, route an
 * approval through, put on a card. DEACTIVATED and TERMINATED are history: they have to
 * stay reachable (an expense report from six months ago still names its approver) but
 * they are not who you are looking for when you open a directory, and on a list of 965
 * people they are most of the noise.
 *
 * The full list it is a subset of now lives in `@/lib/employeeStatus` — this stays local
 * because it is a DIRECTORY default, not a fact about the enum.
 */
const CURRENT_STATUSES: EmployeeStatus[] = ['ACTIVE', 'ON_LEAVE'];

/** Hardcoded system saved views — always available alongside any
 *  user-saved views in the dropdown. */
const SYSTEM_VIEWS: SystemView<PeopleColumnId>[] = [
  /**
   * The DEFAULT view now carries a filter, and it is the one view that did not.
   *
   * "All employees" showed leavers beside current staff in the directory, in My reports
   * and in My direct reports, with nothing on screen saying so — a manager's report count
   * included people who left. The filter is a real pill, visible and removable, rather
   * than a hidden server-side default: somebody who wants a leaver can see why they are
   * not there and take it off. "All employees" is still one click away, below.
   */
  {
    kind: 'system',
    id: 'sys:default',
    name: 'Current employees',
    /**
     * One `equals` clause per status, not one `isAnyOf`.
     *
     * `isAnyOf` is a SERVER op — `clausesToServerInput` synthesises it from same-field
     * `equals` clauses — and is not in the client's `FilterOp` union at all. Writing the
     * pair keeps this a filter the pill bar can render, explain and let somebody remove
     * one half of, and it collapses to exactly `isAnyOf: [ACTIVE, ON_LEAVE]` on the way
     * out.
     */
    filters: CURRENT_STATUSES.map((status, i) => ({
      id: `sv-cur-${i}`,
      field: 'status' as const,
      op: 'equals' as const,
      value: status,
    })),
  },
  { kind: 'system', id: 'sys:all', name: 'All employees' },
  {
    kind: 'system',
    id: 'sys:active-managers',
    name: 'Active managers',
    filters: [{ id: 'sv-1', field: 'status', op: 'equals', value: 'ACTIVE' }],
  },
  { kind: 'system', id: 'sys:my-team', name: 'My team', scope: 'chain' },
  /**
   * Active employees with no reporting line — a data-health view, not a
   * convenience one. An approval that routes to "the requester's manager" cannot
   * resolve one for these people, so their reports fall through to the
   * approver-pool fallback instead of to a person. This is the list to hand HR.
   */
  {
    kind: 'system',
    id: 'sys:no-manager',
    name: 'No manager (needs HR)',
    filters: [
      { id: 'sv-nm-1', field: 'status', op: 'equals', value: 'ACTIVE' },
      { id: 'sv-nm-2', field: 'manager', op: 'isEmpty', value: '' },
    ],
  },
];

/**
 * The rail's facets — deliberately not `access`, though it is filterable everywhere else.
 *
 * Every card here shows a COUNT beside each value, and those come from `users.facetCounts`,
 * which groups by a physical column and returns the raw value as the key. `status` and the
 * two org columns work because their stored values ARE the option values. `hasExpenseOSAccess`
 * is a boolean, so it would come back as `true`/`false` against options keyed
 * `granted`/`denied` and every count would render blank — one uncounted card beside three
 * counted ones, which reads as "still loading" rather than as a design.
 *
 * So it lives in the pill bar's addable fields and on the column header instead, where it
 * filters correctly and the pill reads properly. Wiring counts for a boolean facet means
 * casting in the shared count query, and that is its own change.
 */
const FACET_FIELDS: PeopleColumnId[] = ['status', 'businessUnit', 'department'];

/** The most ids `users.setAccessMany` takes in one call. */
const ACCESS_BATCH = 500;

type AccessOutcome =
  | { kind: 'done'; hasAccess: boolean; changed: number; unchanged: number; skippedSelf: number }
  | { kind: 'failed' };

/**
 * What a bulk Grant / Revoke did, in words, above the table until dismissed.
 *
 * `role="status"` so it is announced: the bulk menu closes on select, and without this a
 * screen-reader user would hear nothing come back from the action.
 */
function AccessOutcomeLine({
  outcome,
  onDismiss,
}: {
  outcome: AccessOutcome;
  onDismiss: () => void;
}) {
  const t = useTranslations('people.accessBulk');
  let sentence: string;
  if (outcome.kind === 'failed') {
    sentence = t('failed');
  } else {
    const parts = [
      outcome.changed === 0
        ? t('noneChanged')
        : t(outcome.hasAccess ? 'granted' : 'revoked', { count: outcome.changed }),
    ];
    if (outcome.unchanged > 0) {
      parts.push(
        t(outcome.hasAccess ? 'alreadyGranted' : 'alreadyRevoked', { count: outcome.unchanged }),
      );
    }
    if (outcome.skippedSelf > 0) parts.push(t('skippedSelf'));
    sentence = parts.join(' ');
  }
  return (
    <div
      role="status"
      className={`flex items-center justify-between gap-3 border-border border-b px-3 py-2 text-sm ${
        outcome.kind === 'failed'
          ? 'bg-destructive/5 text-destructive'
          : 'bg-muted/40 text-foreground'
      }`}
    >
      <span>{sentence}</span>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {t('dismiss')}
      </Button>
    </div>
  );
}

export function EmployeeDirectory({
  availableScopes,
  defaultScope,
  isAdmin,
  canSetRole,
  canEdit,
  accountingClassActive,
  vccActive,
  syncReviewPath,
  pendingInviteCount = 0,
  canInvite = false,
}: EmployeeDirectoryProps) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('people');
  const tTable = useTranslations('table');
  const tStatus = useTranslations('people.status');
  const tFilters = useTranslations('people.filters');
  const tCols = useTranslations('people.columns');
  const tActions = useTranslations('people.actions');
  const tEmpty = useTranslations('people.empty');
  const tGroupBy = useTranslations('people.groupBy');
  const tScope = useTranslations('people.scope');
  const tAccess = useTranslations('people.access');
  const tSync = useTranslations('people.sync');
  const locale = useLocale() as Locale;
  const tableLabels = useTableLabels();

  // ─── DataTable labels bag — shared table chrome + People's own
  //     "select all visible rows" phrasing. ───────────────────────
  const labels = useMemo(() => ({ ...tableLabels, selectAll: t('selectAll') }), [tableLabels, t]);

  // ─── State ─────────────────────────────────────────────────────
  const [scope, setScope] = useState<DirectoryScope>(defaultScope);
  const [showRail, setShowRail] = useState(false);
  const [activeViewId, setActiveViewId] = useState<string>('sys:default');
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const [roleUser, setRoleUser] = useState<PeopleRow | null>(null);
  const [editUser, setEditUser] = useState<PeopleRow | null>(null);
  const utils = trpc.useUtils();

  // Grant / revoke sign-in from a row's menu. `mutate` is stable, so the column memo below
  // does not rebuild on every render for it.
  const { mutate: setAccessOne } = trpc.users.setAccess.useMutation({
    onSuccess: () =>
      Promise.all([utils.users.listDirectory.invalidate(), utils.users.get.invalidate()]),
  });

  // Facet query (option labels — counts come later via facetCounts)
  const facetsQuery = trpc.users.listFilterFacets.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Base option lists (label + value). Counts get merged in
  // separately via `optionsWithCounts` below once facetCountsQuery
  // has data — keeps the column-header filter editor and the
  // facet rail sharing the same `{value, label, count?}` shape.
  const statusOptions = useMemo(
    () => EMPLOYEE_STATUSES.map((s) => ({ value: s as string, label: tStatus(s) })),
    [tStatus],
  );
  const businessUnitOptions = useMemo(
    () =>
      (facetsQuery.data?.businessUnits ?? []).map((bu) => ({
        value: bu.id,
        label: getLocalized(bu.label, locale) ?? bu.id,
      })),
    [facetsQuery.data?.businessUnits, locale],
  );
  const departmentOptions = useMemo(
    () =>
      (facetsQuery.data?.departments ?? []).map((d) => ({
        value: d.id,
        label: getLocalized(d.label, locale) ?? d.id,
      })),
    [facetsQuery.data?.departments, locale],
  );
  const accessOptions = useMemo(
    () => [
      { value: 'granted', label: tAccess('granted') },
      { value: 'denied', label: tAccess('denied') },
    ],
    [tAccess],
  );

  // Columns the user can group the table by. `none` is the always-
  // present first entry that resets back to a flat list. Status /
  // business-unit / department / manager are the natural high-
  // cardinality-but-bounded facets — same fields the FacetRail
  // exposes as filter pills.
  const groupOptions = useMemo<Array<{ value: 'none' | PeopleColumnId; label: string }>>(
    () => [
      { value: 'none', label: tGroupBy('none') },
      { value: 'status', label: tGroupBy('status') },
      { value: 'businessUnit', label: tGroupBy('businessUnit') },
      { value: 'department', label: tGroupBy('department') },
      { value: 'manager', label: tGroupBy('manager') },
    ],
    [tGroupBy],
  );

  // ─── Column defs ──────────────────────────────────────────────
  const columns = useMemo(() => {
    const cols = buildPeopleColumns({
      tSync,
      locale,
      tCols,
      tActions,
      tStatus,
      tAccess,
      statusOptions,
      businessUnitOptions,
      departmentOptions,
      accessOptions,
      canSetRole,
      onSetRole: setRoleUser,
      onSetAccess: (u, hasAccess) => setAccessOne({ id: u.id, hasAccess }),
      canEdit,
      onEdit: setEditUser,
      // 'View' was enabled and inert; the drawer it should open already existed (F40).
      onView: (u) => setDetailUserId(u.id),
      accountingClassActive,
    });
    // Plain-text export accessors, mirroring each column's rendered
    // `cell`. Kept here (not in the cells file) so the whole export
    // wiring lives beside the <TableExportMenu>. Pure action / kebab
    // markup has no data value, so no column is export-only chrome.
    const exportValues: Partial<Record<PeopleColumnId, (row: PeopleRow) => string>> = {
      name: (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
      externalIds: (u) =>
        externalIdEntries(u.externalIds)
          .map(([system, id]) => `${system}: ${id}`)
          .join(', '),
      email: (u) => u.email,
      entity: (u) => (u.entity ? (getLocalized(u.entity.label, locale) ?? '') : ''),
      businessUnit: (u) =>
        u.businessUnit ? (getLocalized(u.businessUnit.label, locale) ?? '') : '',
      department: (u) => (u.department ? (getLocalized(u.department.label, locale) ?? '') : ''),
      nsClass: (u) => u.nsClass?.name ?? '',
      manager: (u) => {
        const m = u.manager;
        return m ? [m.firstName, m.lastName].filter(Boolean).join(' ') : '';
      },
      // Exported as words, not a boolean: a CSV column of true/false says nothing about
      // which way round it reads.
      access: (u) => (u.hasAccess ? tAccess('granted') : tAccess('denied')),
      status: (u) => tStatus(u.employeeStatus as EmployeeStatus),
    };
    return cols.map((c) => {
      const exportValue = exportValues[c.id];
      return exportValue ? { ...c, exportValue } : c;
    });
  }, [
    locale,
    tCols,
    tActions,
    tStatus,
    tAccess,
    statusOptions,
    businessUnitOptions,
    departmentOptions,
    accessOptions,
    canSetRole,
    setAccessOne,
    canEdit,
    accountingClassActive,
    tSync,
  ]);

  // ─── DataTable state ─────────────────────────────────────────
  // Initial: Name pinned-left, no other pins, default order, and `sys:default`'s own
  // filter already applied.
  //
  // The system views are data, not behaviour: nothing applies the active view's filters on
  // mount — the one-shot effect below only loads a PINNED user view. So a `sys:default`
  // carrying a filter would have shown its pill in the dropdown and filtered nothing, which
  // is worse than not filtering at all. Seeding from the same constant keeps the two in
  // step, and switching views still works exactly as it did.
  const [tableState, setTableState] = useState<DataTableState<PeopleColumnId>>(() =>
    createDataTableState(columns as never, {
      pinnedColumns: { left: ['name'], right: [] },
      filters: (SYSTEM_VIEWS.find((v) => v.id === 'sys:default')?.filters ??
        []) as DataTableState<PeopleColumnId>['filters'],
    }),
  );

  // ─── Server filter input — derive from clauses ────────────────
  const serverFilters = useMemo(
    () => clausesToServerInput(tableState.filters),
    [tableState.filters],
  );

  // ─── Facet counts ────────────────────────────────────────────
  // Debounce the filter state by 300ms so rapid pill edits don't
  // hammer the count query. Discrete actions (checkbox toggles)
  // still feel snappy because they don't generate keystroke
  // bursts. `placeholderData: keepPreviousData` keeps the previous
  // counts visible while the new ones load (stale-while-revalidate
  // from the user's POV).
  const debouncedServerFilters = useDebouncedValue(serverFilters, 300);
  const facetCountsQuery = trpc.users.facetCounts.useQuery(
    {
      scope,
      name: debouncedServerFilters.name,
      status: debouncedServerFilters.status,
      businessUnit: debouncedServerFilters.businessUnit,
      department: debouncedServerFilters.department,
      entity: debouncedServerFilters.entity,
      email: debouncedServerFilters.email,
      externalIds: debouncedServerFilters.externalIds,
      includeDeleted: false,
      fields: ['status', 'businessUnit', 'department'],
    },
    {
      placeholderData: (prev) => prev, // SWR: hold previous counts
      staleTime: 30_000,
    },
  );

  // Status filter peek to decide whether to include soft-deleted rows.
  const includeDeleted = useMemo(() => {
    const s = serverFilters.status;
    const list = !s ? [] : Array.isArray(s) ? s : [s];
    return list.some(
      (f) =>
        (f.op === 'isAnyOf' &&
          (f.values.includes('DEACTIVATED') || f.values.includes('TERMINATED'))) ||
        (f.op === 'equals' && (f.value === 'DEACTIVATED' || f.value === 'TERMINATED')),
    );
  }, [serverFilters.status]);

  // Single-shot fetch when (a) sort is anything other than the default
  // name-asc, OR (b) group-by is active — grouping needs every row in
  // memory at once so the partitioning is complete (paging mid-group
  // would split a group across "loads").
  const needsSingleShot =
    (tableState.sort !== null &&
      !(tableState.sort.field === 'name' && tableState.sort.dir === 'asc')) ||
    Boolean(tableState.groupBy);

  // ─── Data query ──────────────────────────────────────────────
  const baseInput = {
    scope,
    search: undefined,
    name: serverFilters.name,
    status: serverFilters.status,
    businessUnit: serverFilters.businessUnit,
    department: serverFilters.department,
    entity: serverFilters.entity,
    email: serverFilters.email,
    externalIds: serverFilters.externalIds,
    /**
     * Access, which this input dropped on the floor exactly the way `manager` below once
     * did — the pill bar built the clause, the pill rendered `Access equals "Can sign in"`,
     * and the table went on showing all 873 people. Caught in the browser; every unit test
     * passed, because both halves were right on their own and nothing joined them up.
     */
    access: serverFilters.access,
    /**
     * The manager PRESENCE filter (isEmpty / isNotEmpty), which the router has always
     * accepted and this input used to drop on the floor — so the "No manager (needs
     * HR)" system view narrowed to `status = ACTIVE` and returned every active
     * employee. The one view whose entire purpose is finding the gap showed no gap.
     */
    manager: serverFilters.manager,
    includeDeleted,
  };
  const paged = trpc.users.listDirectory.useInfiniteQuery(
    { ...baseInput, take: 50 },
    {
      enabled: !needsSingleShot,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    },
  );
  const single = trpc.users.listDirectory.useQuery(
    { ...baseInput, take: 1000 },
    { enabled: needsSingleShot },
  );

  const rows: PeopleRow[] = !needsSingleShot
    ? (paged.data?.pages.flatMap((p) => p.items) ?? [])
    : (single.data?.items ?? []);
  const totalCount = !needsSingleShot
    ? (paged.data?.pages[0]?.totalCount ?? 0)
    : (single.data?.totalCount ?? 0);
  const isLoading = !needsSingleShot ? paged.isLoading : single.isLoading;
  const isFetchingNextPage = !needsSingleShot ? paged.isFetchingNextPage : false;
  const hasNextPage = !needsSingleShot ? (paged.hasNextPage ?? false) : false;

  // Sort the loaded rows client-side when single-shot. (For paged
  // mode, the server returns rows in `firstName, lastName, id` order
  // since that's the tuple cursor; sort UI is disabled for those
  // columns. Future work: server-side sort.)
  const sortedRows = useMemo(() => {
    if (!needsSingleShot || !tableState.sort) return rows;
    const field = tableState.sort.field as keyof PeopleRow;
    const dir = tableState.sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a[field] as unknown;
      const bv = b[field] as unknown;
      const aStr = av == null ? '' : String(av);
      const bStr = bv == null ? '' : String(bv);
      return aStr.localeCompare(bStr) * dir;
    });
  }, [rows, tableState.sort, needsSingleShot]);

  // Row-to-group-key resolver: maps a row + the chosen group column
  // to the displayed group label (status renders as the localized
  // status name; manager as the manager's display name). Returns
  // null for missing values — DataTable substitutes the
  // "Unassigned" placeholder.
  const groupKeyForRow = (row: PeopleRow, col: PeopleColumnId): string | null => {
    switch (col) {
      case 'status':
        return tStatus(row.employeeStatus);
      case 'businessUnit':
        return row.businessUnit ? getLocalized(row.businessUnit.label, locale) : null;
      case 'department':
        return row.department ? getLocalized(row.department.label, locale) : null;
      case 'manager': {
        const m = row.manager;
        if (!m) return null;
        const name = [m.firstName, m.lastName].filter(Boolean).join(' ');
        return name || null;
      }
      default:
        return null;
    }
  };

  // ─── Saved views ─────────────────────────────────────────────
  const {
    allViews,
    createView,
    renameView,
    deleteView: deleteSavedView,
    togglePinnedView,
  } = useSavedViews<PeopleColumnId>({
    resource: 'people',
    systemViews: SYSTEM_VIEWS,
    onAfterCreate: (id) => setActiveViewId(id),
    onAfterDelete: () => setActiveViewId('sys:default'),
  });

  const loadView = (id: string) => {
    const target = allViews.find((v) => v.id === id);
    if (!target) return;
    setActiveViewId(id);
    if (target.kind === 'system') {
      setScope(target.scope ?? defaultScope);
      setTableState((s) => ({
        ...s,
        filters: target.filters?.map((f) => ({ ...f, id: newClauseId() })) ?? [],
        sort: null,
      }));
    } else {
      const v = target.state;
      const visible = v.visibleColumns;
      setScope(v.scope ?? defaultScope);
      setTableState((s) => ({
        ...s,
        filters: v.filters.map((f) => ({ ...f, id: newClauseId() })),
        sort: v.sort ?? null,
        density: v.density ?? s.density,
        // `groupBy` is part of the persisted shape — restore it here so
        // a view saved with "Group by department" reads back the same.
        groupBy: v.groupBy ?? null,
        columnVisibility: visible
          ? Object.fromEntries(columns.map((c) => [c.id, visible.includes(c.id)]))
          : s.columnVisibility,
      }));
    }
  };
  // On first load, if the user has a pinned saved view, treat it as
  // their personal default and apply it instead of `sys:default`. We
  // only fire this once — subsequent manual switches to `sys:default`
  // must stick. `didApplyDefaultRef` guards against the effect re-
  // running when `allViews` updates (e.g. after a savedViews refetch).
  const didApplyDefaultRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot — see comment above
  useEffect(() => {
    if (didApplyDefaultRef.current) return;
    if (allViews.length === 0) return;
    const pinned = allViews.find((v) => v.kind === 'user' && v.pinned);
    didApplyDefaultRef.current = true;
    if (pinned) loadView(pinned.id);
  }, [allViews]);

  const captureViewState = (): PersistedViewState<PeopleColumnId> => ({
    scope,
    filters: tableState.filters,
    visibleColumns: tableState.columnOrder.filter(
      (id) => tableState.columnVisibility[id] !== false,
    ),
    sort: tableState.sort ?? undefined,
    density: tableState.density,
    // Only the four groupable columns reach the persisted shape;
    // every other ColumnId would have been rejected by the
    // TableSettingsButton dropdown above.
    groupBy: (tableState.groupBy as PersistedViewState<PeopleColumnId>['groupBy']) ?? null,
  });
  const saveCurrentAsNew = () => {
    const name = window.prompt('Name this view:', 'My view');
    if (!name?.trim()) return;
    createView(name.trim(), captureViewState(), false);
  };
  const renameUserView = (id: string, currentName: string) => {
    const name = window.prompt('Rename view:', currentName);
    if (!name?.trim() || name.trim() === currentName) return;
    renameView(id, name.trim());
  };
  const deleteUserView = (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    deleteSavedView(id);
  };

  // ─── ViewsBar / FacetRail wiring helpers ─────────────────────
  const updateClauseOp = (id: string, op: FilterOp) => {
    setTableState((s) => ({
      ...s,
      filters: s.filters.map((c) =>
        c.id === id ? { ...c, op, value: VALUELESS_OPS.has(op) ? '' : c.value } : c,
      ),
    }));
  };
  const updateClauseValue = (id: string, value: string) => {
    setTableState((s) => ({
      ...s,
      filters: s.filters.map((c) => (c.id === id ? { ...c, value } : c)),
    }));
  };
  const removeClause = (id: string) => {
    setTableState((s) => ({ ...s, filters: s.filters.filter((c) => c.id !== id) }));
  };
  const addClause = (field: PeopleColumnId, op: FilterOp, value: string) => {
    setTableState((s) => ({
      ...s,
      filters: [...s.filters, { id: newClauseId(), field, op, value }],
    }));
  };
  const clearClauses = () => setTableState((s) => ({ ...s, filters: [], sort: null }));

  // ─── Facet card adapters ──────────────────────────────────────
  const selectedForFacet = (field: PeopleColumnId) =>
    tableState.filters.filter((c) => c.field === field && c.op === 'equals').map((c) => c.value);
  const toggleFacetValue = (field: PeopleColumnId, value: string) => {
    setTableState((s) => {
      const existing = s.filters.find(
        (c) => c.field === field && c.op === 'equals' && c.value === value,
      );
      if (existing) return { ...s, filters: s.filters.filter((c) => c.id !== existing.id) };
      return {
        ...s,
        filters: [...s.filters, { id: newClauseId(), field, op: 'equals' as const, value }],
      };
    });
  };

  // ─── Facet labels / options for the rail ──────────────────────
  const facetLabels: Record<PeopleColumnId, string> = {
    name: tCols('name'),
    status: tFilters('status'),
    access: tCols('access'),
    businessUnit: tFilters('businessUnit'),
    department: tFilters('department'),
    entity: tCols('entity'),
    email: tCols('email'),
    externalIds: tCols('externalIds'),
    nsClass: tCols('nsClass'),
    manager: tCols('manager'),
  };
  // Merge facet counts (if loaded) into the base option lists.
  // Counts come from facetCountsQuery — server returns `{value,
  // count}` pairs per requested field. Options for facets we don't
  // request counts for (entity, email, externalIds, manager) stay
  // count-less. Options whose values aren't in the counts response
  // (e.g. trimmed by the top-N cap) get count = 0.
  const mergeCounts = (
    base: Array<{ value: string; label: string }>,
    field: 'status' | 'businessUnit' | 'department',
  ) => {
    const map = new Map<string, number>();
    for (const r of facetCountsQuery.data?.counts?.[field] ?? []) {
      map.set(r.value, r.count);
    }
    return base.map((o) => ({
      ...o,
      count: facetCountsQuery.data ? (map.get(o.value) ?? 0) : undefined,
    }));
  };
  const facetOptions: Record<
    PeopleColumnId,
    Array<{ value: string; label: string; count?: number }>
  > = {
    name: [],
    status: mergeCounts(statusOptions, 'status'),
    access: accessOptions,
    businessUnit: mergeCounts(businessUnitOptions, 'businessUnit'),
    department: mergeCounts(departmentOptions, 'department'),
    entity: [],
    email: [],
    externalIds: [],
    nsClass: [],
    manager: [],
  };
  const fieldKinds: Record<PeopleColumnId, 'enum' | 'text'> = {
    name: 'text',
    status: 'enum',
    businessUnit: 'text',
    department: 'text',
    entity: 'text',
    email: 'text',
    externalIds: 'text',
    nsClass: 'text',
    manager: 'text',
    access: 'enum',
  };

  // ─── Bulk actions ─────────────────────────────────────────────
  const deactivateMut = trpc.users.deactivate.useMutation();
  const clearSelection = () => setTableState((s) => ({ ...s, selectedIds: new Set() }));
  const bulkDeactivate = async () => {
    const ids = Array.from(tableState.selectedIds);
    for (const id of ids) {
      try {
        await deactivateMut.mutateAsync({ id });
      } catch {
        /* soft-fail per row */
      }
    }
    clearSelection();
    await utils.users.listDirectory.invalidate();
  };

  // Grant / revoke sign-in for the selection. The server skips anybody already in that
  // state and never revokes the caller's own access, so the outcome is said in a sentence
  // rather than assumed: "Granted access to 12 people. 3 already had access."
  const setAccessManyMut = trpc.users.setAccessMany.useMutation();
  const [accessOutcome, setAccessOutcome] = useState<AccessOutcome | null>(null);
  const bulkSetAccess = async (hasAccess: boolean) => {
    const ids = Array.from(tableState.selectedIds);
    setAccessOutcome(null);
    const total = { changed: 0, unchanged: 0, skippedSelf: 0 };
    try {
      // The mutation takes at most 500 ids; a larger selection goes in slices.
      for (let i = 0; i < ids.length; i += ACCESS_BATCH) {
        const out = await setAccessManyMut.mutateAsync({
          ids: ids.slice(i, i + ACCESS_BATCH),
          hasAccess,
        });
        total.changed += out.changed;
        total.unchanged += out.unchanged;
        total.skippedSelf += out.skippedSelf;
      }
      setAccessOutcome({ kind: 'done', hasAccess, ...total });
      clearSelection();
    } catch {
      // Each person is saved on its own, so a failure part-way leaves the earlier ones
      // changed. The refreshed list below shows who.
      setAccessOutcome({ kind: 'failed' });
    }
    await Promise.all([utils.users.listDirectory.invalidate(), utils.users.get.invalidate()]);
  };

  // ─── TopBar ───────────────────────────────────────────────────
  useTopBarSlots(
    () => ({
      // VeloExpense: Add user opens the invite form (/users/invite), which sets the person's
      // role and manager before they arrive, where ExpenseOS opens an email-only dialog
      // (decided 17 Oct 2026). Beside it, the invitations still waiting, when there are any.
      // Shown to whoever may invite (`canInvite`) rather than to every `readAll` holder, since
      // the invite form refuses anybody else.
      right: canInvite ? (
        <div className="flex items-center gap-2">
          {pendingInviteCount > 0 && (
            <Button asChild variant="outline" size="sm">
              <LocaleLink href="/users/invitations">
                {t('pendingInvites', { count: pendingInviteCount })}
              </LocaleLink>
            </Button>
          )}
          <Button asChild variant="default" size="sm">
            <LocaleLink href="/users/invite">{t('addUser')}</LocaleLink>
          </Button>
        </div>
      ) : null,
    }),
    [canInvite, pendingInviteCount, t],
  );

  // ─── Reset for ColumnsGear ────────────────────────────────────
  const resetTable = () =>
    setTableState((s) => ({
      ...s,
      columnOrder: columns.map((c) => c.id),
      columnVisibility: {},
      columnWidths: {},
      density: 'normal' as Density,
    }));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Block 1: ViewsBar + collapsible FacetRail */}
      <div className="rounded-md border border-border bg-card">
        <ViewsBar
          views={allViews}
          activeViewId={activeViewId}
          onSelectView={loadView}
          onSaveAsNew={saveCurrentAsNew}
          onRenameView={renameUserView}
          onDeleteView={deleteUserView}
          onTogglePinned={togglePinnedView}
          filters={tableState.filters}
          fields={[
            'name',
            'status',
            'businessUnit',
            'department',
            'entity',
            'email',
            'externalIds',
            'access',
          ]}
          fieldKinds={fieldKinds}
          facetLabels={facetLabels}
          facetOptions={facetOptions}
          onUpdateOp={updateClauseOp}
          onUpdateValue={updateClauseValue}
          onRemoveClause={removeClause}
          onAddClause={addClause}
          onClearAll={clearClauses}
          railOpen={showRail}
          onToggleRail={() => setShowRail((v) => !v)}
          availableScopes={availableScopes}
          scope={scope}
          onScopeChange={setScope}
          scopeLabel={(s) => tScope(s)}
          labels={{
            clearFilters: tTable('misc.clearFilters'),

            showFilters: tTable('misc.showFilters'),

            hideFilters: tTable('misc.hideFilters'),

            untitledView: tTable('misc.untitledView'),
          }}
        />
        {showRail && (
          <>
            <div className="h-px bg-border" />
            <FacetRail
              fields={FACET_FIELDS}
              labels={facetLabels}
              options={facetOptions}
              selectedFor={selectedForFacet}
              onToggleValue={toggleFacetValue}
            />
          </>
        )}
      </div>

      {/* Block 2: Toolbar + DataTable */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTableToolbar
          {...toolbarLabels}
          selectedCount={tableState.selectedIds.size}
          resultCount={sortedRows.length}
          loading={isLoading}
          bulkActionsDisabled={deactivateMut.isPending || setAccessManyMut.isPending}
          bulkActions={[
            ...(canSetRole
              ? [
                  {
                    id: 'grant-access',
                    label: tActions('grantAccess'),
                    icon: <IconLockOpen size={14} />,
                    onSelect: () => void bulkSetAccess(true),
                  },
                  {
                    id: 'revoke-access',
                    label: tActions('revokeAccess'),
                    icon: <IconLock size={14} />,
                    onSelect: () => void bulkSetAccess(false),
                  },
                  { divider: true as const },
                ]
              : []),
            {
              id: 'deactivate',
              label: tActions('deactivate'),
              destructive: true,
              onSelect: bulkDeactivate,
            },
          ]}
          rightSlot={
            <>
              <TableExportMenu<PeopleRow, PeopleColumnId>
                columns={columns}
                rows={sortedRows}
                state={tableState}
                filename="employees"
                label={tActions('export')}
                disabledLabel={t('comingSoon')}
              />
              <TableSettingsButton<PeopleColumnId, 'none' | PeopleColumnId>
                columnOrder={columns.map((c) => c.id)}
                columnVisibility={tableState.columnVisibility as Record<PeopleColumnId, boolean>}
                onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
                columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
                groupBy={tableState.groupBy ?? 'none'}
                onGroupChange={(g) =>
                  setTableState((s) => ({
                    ...s,
                    groupBy: g === 'none' ? null : (g as PeopleColumnId),
                  }))
                }
                groupOptions={groupOptions}
                density={tableState.density}
                onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
                onReset={resetTable}
                labels={labels.settings}
              />
            </>
          }
        />
        {accessOutcome && (
          <AccessOutcomeLine outcome={accessOutcome} onDismiss={() => setAccessOutcome(null)} />
        )}
        {/* Orders its own rows — the table must not re-sort them. */}
        <DataTable<PeopleRow, PeopleColumnId>
          sortMode="external"
          columns={columns}
          rows={sortedRows}
          rowKey={(u) => u.id}
          loading={isLoading}
          totalCount={totalCount}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={(u) => setDetailUserId(u.id)}
          activeRowId={detailUserId}
          selectable={isAdmin}
          labels={labels}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={paged.fetchNextPage}
          disableInfiniteScroll={needsSingleShot}
          groupKeyFor={(row, col) => groupKeyForRow(row, col) ?? tGroupBy('unassigned')}
          groupLabelFor={(key) => key}
          groupCountLabel={(n) => tGroupBy('rowCount', { count: n })}
          renderEmpty={() => (
            <>
              <div className="font-medium text-foreground">{tEmpty('title')}</div>
              <div className="mt-1 text-muted-foreground text-sm">{tEmpty('body')}</div>
            </>
          )}
        />
      </div>

      <UserDetailDrawer
        userId={detailUserId}
        onClose={() => setDetailUserId(null)}
        onOpenUser={(id) => setDetailUserId(id)}
        locale={locale}
        vccActive={vccActive}
        canSetAccess={canSetRole}
        syncReviewPath={syncReviewPath}
      />

      <SetRoleDrawer user={roleUser} onClose={() => setRoleUser(null)} />
      <EditEmployeeDrawer
        user={editUser}
        onClose={() => setEditUser(null)}
        syncReviewPath={syncReviewPath}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
//  Helpers + chrome bits — kept inline for now. Move to a shared
//  /components/data-view/chrome module when the next directory
//  page adopts them.
// ────────────────────────────────────────────────────────────────

/** Collapse `FilterClause[]` into the per-column shape the server
 *  router (`users.listDirectory`) accepts. Same-field same-op
 *  clauses collapse to `isAnyOf` / `isNoneOf`; everything else
 *  emits an array of filters which the server OR-s at SQL level. */
function clausesToServerInput(
  clauses: FilterClause<PeopleColumnId>[],
): Partial<Record<PeopleColumnId, ColumnFilter | ColumnFilter[]>> {
  const byField = new Map<PeopleColumnId, FilterClause<PeopleColumnId>[]>();
  for (const c of clauses) {
    if (!byField.has(c.field)) byField.set(c.field, []);
    byField.get(c.field)?.push(c);
  }
  const toOne = (c: FilterClause<PeopleColumnId>): ColumnFilter => {
    if (c.op === 'isEmpty' || c.op === 'isNotEmpty') return { op: c.op };
    return {
      op: c.op as Exclude<ColumnFilter['op'], 'isEmpty' | 'isNotEmpty' | 'isAnyOf' | 'isNoneOf'>,
      value: c.value,
    };
  };
  const out: Partial<Record<PeopleColumnId, ColumnFilter | ColumnFilter[]>> = {};
  for (const [field, list] of byField) {
    const single = list[0];
    if (list.length === 1 && single) {
      out[field] = toOne(single);
      continue;
    }
    const allEquals = list.every((c) => c.op === 'equals');
    const allNotEquals = list.every((c) => c.op === 'doesNotEqual');
    if (allEquals) {
      out[field] = { op: 'isAnyOf', values: list.map((c) => c.value) };
    } else if (allNotEquals) {
      out[field] = { op: 'isNoneOf', values: list.map((c) => c.value) };
    } else {
      out[field] = list.map(toOne);
    }
  }
  return out;
}

// Bespoke ActionsDropdown / ColumnsGear / ExportDropdown removed —
// the directory now composes its toolbar from the design-system
// primitives (DataTableToolbar, BulkActionsMenu, SelectionCounter,
// ExportMenu, TableSettingsButton). See `Block 2: Toolbar` above.
