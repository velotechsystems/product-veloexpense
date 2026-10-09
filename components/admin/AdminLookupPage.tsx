'use client';

/**
 * `<AdminLookupPage>` — generic management page for the four admin
 * "lookup table" entities (BusinessUnit / LegalEntity / Department /
 * Account). Each entity provides a config descriptor that wires up:
 *
 *   - tRPC procedures (list / create / update / setActive)
 *   - Per-entity extra columns (e.g. LegalEntity's country / currency)
 *   - Per-entity extra form fields (rendered inside the drawer)
 *   - Per-entity view-mode renderer (extra sections in read-mode)
 *
 * Layout mirrors the People directory:
 *   - Page header with title + "+ Add" button
 *   - Action bar with refresh + columns gear + export
 *   - DataTable below, RowActionsMenu in the trailing column
 *   - Right-side Drawer for view/edit/create — same component for all
 *     three modes, just different state
 *
 * Role Builder is NOT routed through this shell — its permission
 * picker is too entity-specific. See RoleBuilderPage.
 *
 * Ported from ExpenseOS `apps/web/src/components/admin/AdminLookupPage.tsx` (550b2945)
 * with business units (Wave 1). VeloExpense differences, each marked below:
 *   · no saved views: the dropdown and `useSavedViews` arrive with the saved-views port
 *     in Wave 4 (decided 8 Oct, d15). The filter pills, columns, export and bulk actions
 *     are unchanged;
 *   · the French name and description are not asked for or shown while French is
 *     switched off (`ENABLED_LOCALES`, 7 Oct), as on the categories screen.
 */
import {
  Badge,
  Button,
  cls,
  DataTableToolbar,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  FilterPillBar,
  IconEdit,
  IconPlus,
  RowActionsMenu,
  SchemaForm,
  type SchemaFormHandle,
  TableSettingsButton,
} from '@expenseos/design-system';
import { ENABLED_LOCALES, type Locale } from '@expenseos/i18n/locales';
import {
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconRestore,
  IconUserOff,
} from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { useTopBarSlots } from '@/app/(app)/TopBar';
import {
  type FieldKind as DataViewFieldKind,
  type FacetOption,
  type FilterOp,
  newClauseId,
  TableExportMenu,
  useFilterChromeLabels,
  useTableLabels,
  useToolbarLabels,
  VALUELESS_OPS,
} from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { ADMIN_PICKER_WIDGETS } from '@/components/pickers/CountryDisplay';
import {
  adminToRjsf,
  buildLookupSchema,
  type LookupFormData,
  lookupFields,
  rjsfToAdmin,
} from './AdminLookupForm';
import { useRefusalText } from '@/lib/trpc/refusal';
import { ExternalIdsBlock, ExternalIdsCell } from './ExternalIds';
import { type ExternalIdEntry, entriesFromMap, mapFromEntries } from './ExternalIdsEditor';

/** VeloExpense: whether admins are asked for (and shown) French text (`ENABLED_LOCALES`). */
const FRENCH_ON = ENABLED_LOCALES.includes('fr-CA');

/** VeloExpense: ExpenseOS's `SavedViewResource` (a key of its saved-views router) arrives
 *  with saved views in Wave 4. Until then the config keeps the field, unused. */
type SavedViewResource = string;

// ── Lookup-row shape — every entity returns at least these fields ──

export interface BaseLookupRow {
  id: string;
  label: { en: string; 'fr-CA': string } | unknown;
  description?: { en?: string; 'fr-CA'?: string } | null | unknown;
  externalIds: Record<string, string> | unknown;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type LocalizedString = { en: string; 'fr-CA': string };

/** Render a locale-keyed label JSON value; gracefully degrades. */
export function pickLabel(value: unknown, locale: Locale): string {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const candidate = v[locale] ?? v.en ?? v['fr-CA'];
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}

/**
 * Slugify a human label into a kebab-case `code`. Lowercases, strips
 * diacritics, replaces non-alphanumerics with hyphens, collapses
 * runs, trims hyphens. Identical in spirit to the BU/LE/Department
 * seed-data generator so the runtime UI produces the same shape as
 * the committed seed JSONs.
 *
 *   "EBlock Atlantic"     → "eblock-atlantic"
 *   "General & Admin"     → "general-admin"
 *   "Accounts Payable!!"  → "accounts-payable"
 *   "  trailing  spaces " → "trailing-spaces"
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Extra-field descriptor (rendered inside drawer in edit mode) ──

export type ExtraFieldKind =
  | { kind: 'text'; placeholder?: string; help?: string; maxLength?: number; uppercase?: boolean }
  /** A closed list. Unless `required`, an empty branch is prepended and is what a new
   *  row starts on — see `buildLookupSchema`. */
  | {
      kind: 'select';
      options: Array<{ value: string; label: string }>;
      help?: string;
      /** Label for the empty branch. Defaults to an em dash. */
      placeholder?: string;
    }
  /** A searchable picker rendered by a registered RJSF widget (see
   *  `ADMIN_PICKER_WIDGETS`). `country` and `currency` are the two that exist —
   *  both are closed vocabularies with ~250 and ~50 members, where a text box
   *  invites codes nothing downstream recognises. */
  | {
      kind: 'picker';
      /** `currency` emits an ISO code; `currencyId` emits the Currency row's id —
       *  pick the one that matches what the column actually stores. */
      widget: 'country' | 'currency' | 'currencyId';
      help?: string;
      placeholder?: string;
    }
  /** A yes/no flag. Carried through the form state as `'true'` / `'false'`
   *  because `AdminFormState.extras` is a string map; the entity wrapper turns it
   *  back into a boolean in its buildCreate/UpdatePayload. */
  | {
      kind: 'boolean';
      help?: string;
      /**
       * What a NEW row's box starts as. Defaults to unticked.
       *
       * Set it to match the column's own default, or the create form quietly
       * contradicts the schema: `LegalEntity.itcRecoverable` is `@default(true)`,
       * the box started unticked, and the payload sent an explicit `false` — so
       * every entity created through the UI began unable to reclaim input tax,
       * silently, with the effect only visible later as zero recoverable GST on
       * every expense booked to it.
       */
      defaultValue?: boolean;
    };

export interface ExtraFieldDef {
  name: string;
  label: string;
  required?: boolean;
  nullable?: boolean;
  kind: ExtraFieldKind;
}

// ── Page config ───────────────────────────────────────────────────

export interface AdminLookupPageConfig<Row extends BaseLookupRow, ColumnId extends string> {
  /** i18n namespace key for the entity (e.g. "businessUnits"). */
  entityKey: string;
  /** SavedView resource key. Must be one of the keys in
   *  `SavedViewResource`. */
  savedViewsResource: SavedViewResource;
  /** When provided, rows are rendered as a hierarchical tree.
   *  Rows are sorted in DFS order (each parent immediately
   *  followed by its descendants) and the label cell gains an
   *  expand/collapse chevron + depth-based indentation. The
   *  `parentIdField` is the row property holding the parent's
   *  id; pass `"parentId"` for the canonical Department case. */
  treeOptions?: {
    parentIdField: keyof Row;
    /** Initial expanded state. Defaults to `true` (everything
     *  open) so admins see the full org structure on first load. */
    defaultExpanded?: boolean;
  };
  /** Permissions — when false, the shell hides the Add / Edit / Toggle UI. */
  canWrite: boolean;
  /** Result of `trpc.<entity>.list.useQuery`. */
  query: {
    data?: { items: Row[] };
    isLoading: boolean;
    refetch: () => void;
  };
  /** Extra column definitions appended after the default columns. */
  extraColumns?: ColumnDef<Row, ColumnId>[];
  /** Extra form fields rendered in the drawer (edit + create modes). */
  extraFields?: ExtraFieldDef[];
  /** Optional renderer for extra sections in VIEW mode. Receives the
   *  row; returns Section/Field JSX (use the exported `Section` and
   *  `Field` helpers below). */
  renderViewExtras?: (row: Row) => ReactNode;
  /** Build the create payload from form state. */
  buildCreatePayload: (form: AdminFormState) => Record<string, unknown>;
  /** Build the update patch from form state. */
  buildUpdatePayload: (form: AdminFormState, original: Row) => Record<string, unknown>;
  /** Mutation handles. */
  createMutation: {
    mutateAsync: (input: Record<string, unknown>) => Promise<unknown>;
    isPending: boolean;
  };
  updateMutation: {
    mutateAsync: (input: { id: string; patch: Record<string, unknown> }) => Promise<unknown>;
    isPending: boolean;
  };
  setActiveMutation: {
    mutateAsync: (input: { id: string; active: boolean }) => Promise<unknown>;
    isPending: boolean;
  };
  /** Column ids that should appear as group-by options in the
   *  TableSettingsButton dropdown. Defaults to `[]` (flat list,
   *  no group-by knob shown). Common picks:
   *   - LE: ['country', 'currency']
   *   - Roles: ['kind']
   *  Each column must exist in `extraColumns` or the base column
   *  set. Group keys are derived from the row's matching property
   *  (the column id must match a property name on Row). */
  groupableColumns?: ColumnId[];
}

// ── Form state shape — covers all entities ────────────────────────

export interface AdminFormState {
  labelEn: string;
  labelFr: string;
  descriptionEn: string;
  descriptionFr: string;
  externalIds: ExternalIdEntry[];
  active: boolean;
  extras: Record<string, string>;
}

/** Sentinel option value for the "no grouping" radio choice in
 *  TableSettingsButton's group-by section. The actual state stored
 *  on DataTable is `groupBy: null` — this value only exists so the
 *  radio group has a non-null id to bind to. */
const NONE_GROUP = '__none__' as const;

const EMPTY_FORM: AdminFormState = {
  labelEn: '',
  labelFr: '',
  descriptionEn: '',
  descriptionFr: '',
  externalIds: [],
  active: true,
  extras: {},
};

type DrawerMode = 'closed' | 'view' | 'edit' | 'create';

// ── The page component ────────────────────────────────────────────

export function AdminLookupPage<Row extends BaseLookupRow, ColumnId extends string>({
  config,
}: {
  config: AdminLookupPageConfig<Row, ColumnId>;
}) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations(`admin.${config.entityKey}`);
  // Filter-pill chrome copy: this package's pills take no next-intl dependency.
  const chromeLabels = useFilterChromeLabels();
  const tTable = useTranslations('table');
  const tc = useTranslations('admin.common');
  const refusalText = useRefusalText(); // VeloExpense: see the two catch blocks below.
  const locale = useLocale() as Locale;
  const tableLabels = useTableLabels();

  // ── State ────────────────────────────────────────────────────
  const [drawerMode, setDrawerMode] = useState<DrawerMode>('closed');
  const [selectedRow, setSelectedRow] = useState<Row | null>(null);
  const [form, setForm] = useState<AdminFormState>(EMPTY_FORM);
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * A failure from a ROW action, which has no drawer to report into.
   *
   * `saveError` renders inside the drawer body, so it can only ever explain a failed
   * SAVE. Deactivating happens from the row kebab with no drawer open, so a refusal had
   * nowhere at all to appear: the confirm was accepted, the request failed, and the only
   * visible consequence was the row not changing — indistinguishable from a click that
   * missed.
   */
  const [rowActionError, setRowActionError] = useState<string | null>(null);
  const formRef = useRef<SchemaFormHandle>(null);
  // VeloExpense: ExpenseOS's saved views (the `activeViewId` state and `useSavedViews`)
  // are not here until Wave 4 — see the header.

  // ── Tree-mode expand/collapse state ─────────────────────────
  // Stores ids that are *collapsed*; everything else is expanded by
  // default. Storing the negation keeps "newly-fetched rows are
  // expanded" automatic — no need to seed the set on each refetch.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const toggleCollapse = useCallback(
    (id: string) =>
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  // Row action handlers — declared ahead of the column definitions
  // (baseColumns) that reference them in their dependency list, and
  // wrapped in useCallback so the memoised columns stay stable.
  const openView = useCallback((row: Row) => {
    setSelectedRow(row);
    setSaveError(null);
    setDrawerMode('view');
  }, []);

  const openEdit = useCallback(
    (row: Row) => {
      setSelectedRow(row);
      setSaveError(null);
      setForm(rowToForm(row, config.extraFields));
      setDrawerMode('edit');
    },
    [config.extraFields],
  );

  const toggleActive = useCallback(
    async (row: Row) => {
      const msgKey = row.active ? 'confirmDeactivate' : 'confirmReactivate';
      if (!window.confirm(tc(msgKey, { name: pickLabel(row.label, locale) || row.id }))) return;
      setRowActionError(null);
      try {
        await config.setActiveMutation.mutateAsync({ id: row.id, active: !row.active });
        await config.query.refetch();
      } catch (err) {
        // Reported where somebody will see it — above the table, since there is no drawer
        // open. Silently swallowing this left the row unchanged and the reader with no way
        // to tell a refusal from a mis-click.
        // VeloExpense: through `useRefusalText` (lib/trpc/refusal.ts) — a catalogued refusal
        // in the reader's language, else the error's own sentence, else the generic one —
        // never `String(err)` of whatever was thrown (check:i18n, flag f11).
        setRowActionError(refusalText(err, tc('unknownError')));
      }
    },
    [tc, locale, config.setActiveMutation, config.query, refusalText],
  );

  // Per-row metadata produced by the tree sorter: id → { depth,
  // hasChildren }. Only populated when treeOptions is set.
  type TreeMeta = { depth: number; hasChildren: boolean };
  const treeMeta = useRef<Map<string, TreeMeta>>(new Map());

  // ── Columns ─────────────────────────────────────────────────
  //
  // Layout mirrors EmployeeDirectory: the primary identifier column
  // (here `label`) carries the row kebab menu INSIDE its cell, exactly
  // the way NameCell embeds RowActionsMenu next to the name. Code is
  // shown as a secondary line under the label — code-as-second-line
  // saves a whole column without losing the machine identifier.
  //
  // No standalone "actions" column. The label column is pinned left
  // so the kebab stays anchored during horizontal scroll.
  const baseColumns: ColumnDef<Row, ColumnId>[] = useMemo(() => {
    const cols: ColumnDef<Row, string>[] = [
      {
        id: 'label',
        label: tc('label'),
        defaultWidth: 320,
        filterable: { kind: 'text' },
        exportValue: (row: Row) => pickLabel(row.label, locale) || row.id,
        cell: (row: Row) => {
          // Tree-mode decoration: depth-based left padding + chevron
          // for nodes with children. Looked up from `treeMeta` populated
          // by the rows sorter. `treeMeta` is missing the row when
          // `treeOptions` is unset → falls through to the flat layout.
          const meta = config.treeOptions ? treeMeta.current.get(row.id) : undefined;
          const depth = meta?.depth ?? 0;
          const hasChildren = meta?.hasChildren ?? false;
          const isCollapsed = collapsedIds.has(row.id);
          return (
            <div
              className="flex items-center gap-2"
              style={depth > 0 ? { paddingLeft: depth * 20 } : undefined}
            >
              {config.treeOptions && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasChildren) toggleCollapse(row.id);
                  }}
                  aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                  className={cls(
                    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground',
                    !hasChildren && 'invisible',
                  )}
                >
                  {isCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
                </button>
              )}
              <div className="min-w-0 flex-1">
                <div className="whitespace-normal break-words font-medium text-foreground text-sm">
                  {pickLabel(row.label, locale) || row.id}
                </div>
              </div>
              <RowActionsMenu
                ariaLabel={tc('actions')}
                actions={[
                  {
                    id: 'view',
                    icon: <IconEye size={14} />,
                    label: tc('view'),
                    onClick: () => openView(row),
                  },
                  ...(config.canWrite
                    ? [
                        {
                          id: 'edit',
                          icon: <IconEdit size={14} />,
                          label: tc('edit'),
                          onClick: () => openEdit(row),
                        },
                        { divider: true as const },
                        {
                          id: 'toggleActive',
                          icon: row.active ? <IconUserOff size={14} /> : <IconRestore size={14} />,
                          label: row.active ? tc('deactivate') : tc('reactivate'),
                          onClick: () => toggleActive(row),
                          destructive: row.active,
                          disabled: config.setActiveMutation.isPending,
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          );
        },
      },
      {
        id: 'externalIds',
        label: tc('externalIds'),
        defaultWidth: 280,
        filterable: { kind: 'text' },
        exportValue: (row: Row) =>
          row.externalIds && typeof row.externalIds === 'object'
            ? Object.entries(row.externalIds as Record<string, string>)
                .map(([k, v]) => `${k}=${v}`)
                .join('; ')
            : '',
        cell: (row: Row) => <ExternalIdsCell value={row.externalIds} />,
      },
      {
        id: 'status',
        label: tc('status'),
        defaultWidth: 120,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: [
            { value: 'active', label: tc('active') },
            { value: 'inactive', label: tc('inactive') },
          ],
        },
        exportValue: (row: Row) => (row.active ? tc('active') : tc('inactive')),
        cell: (row: Row) => (
          <Badge variant={row.active ? 'success' : 'secondary'}>
            {row.active ? tc('active') : tc('inactive')}
          </Badge>
        ),
      },
    ];
    return cols as ColumnDef<Row, ColumnId>[];
  }, [
    tc,
    locale,
    config.canWrite,
    config.setActiveMutation.isPending,
    config.treeOptions,
    collapsedIds,
    toggleCollapse,
    openView,
    toggleActive,
    openEdit,
  ]);

  const columns: ColumnDef<Row, ColumnId>[] = useMemo(
    () => [...baseColumns, ...(config.extraColumns ?? [])],
    [baseColumns, config.extraColumns],
  );

  // ── DataTable state ─────────────────────────────────────────
  // Pin `label` left so the kebab stays anchored when the user scrolls
  // sideways through extra columns. Seed with a Status=Active filter
  // so the default view hides inactive rows — the old "Include
  // inactive" checkbox is just this filter expressed in the pill bar,
  // and removing or editing the pill is the same affordance.
  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {
      pinnedColumns: { left: ['label' as ColumnId], right: [] },
      filters: [
        {
          id: newClauseId(),
          field: 'status' as ColumnId,
          op: 'equals',
          value: 'active',
        },
      ],
    }),
  );

  // Client-side filter for the active flag — derived from the Status
  // pill clauses in `tableState.filters`. The pill bar is the only
  // affordance now (the old `Include inactive` checkbox is gone); the
  // default view seeds a `status=active` clause so inactive rows are
  // hidden unless the user removes / edits / negates the pill.
  //
  // Semantics:
  //   - no status clause            → all rows
  //   - status=active               → only active
  //   - status=inactive             → only inactive
  //   - status equals "active" AND
  //     status equals "inactive"    → all (admins compose OR via the
  //                                       "Add filter" "or" pill)
  const statusFilter = useMemo<'active' | 'inactive' | 'both'>(() => {
    const clauses = tableState.filters.filter((c) => c.field === 'status');
    if (clauses.length === 0) return 'both';
    let wantActive = false;
    let wantInactive = false;
    for (const c of clauses) {
      if (c.op === 'equals') {
        if (c.value === 'active') wantActive = true;
        else if (c.value === 'inactive') wantInactive = true;
      } else if (c.op === 'doesNotEqual') {
        if (c.value === 'active') wantInactive = true;
        else if (c.value === 'inactive') wantActive = true;
      } else {
        // Other ops (contains/startsWith/…) don't apply to a boolean
        // surface — treat as "show all" to avoid surprising empties.
        return 'both';
      }
    }
    if (wantActive && wantInactive) return 'both';
    if (wantActive) return 'active';
    if (wantInactive) return 'inactive';
    return 'both';
  }, [tableState.filters]);

  // Row list — applies the Status pill predicate, then sorts in DFS
  // order when treeOptions is configured (Departments' parent
  // hierarchy). `treeMeta` is rebuilt on every recompute so cell
  // renderers can look up depth + hasChildren without scanning.
  const rows = useMemo(() => {
    const all = config.query.data?.items ?? [];
    const filtered =
      statusFilter === 'both'
        ? all
        : all.filter((r) => (statusFilter === 'active' ? r.active : !r.active));
    if (!config.treeOptions) {
      treeMeta.current = new Map();
      return filtered;
    }

    const parentField = config.treeOptions.parentIdField;
    const childrenByParent = new Map<string | null, Row[]>();
    const byId = new Map<string, Row>();
    for (const r of filtered) {
      byId.set(r.id, r);
      const pid =
        ((r as unknown as Record<string, unknown>)[parentField as string] as
          | string
          | null
          | undefined) ?? null;
      const effectiveParent = pid && byId.has(pid) ? pid : null;
      const list = childrenByParent.get(effectiveParent);
      if (list) list.push(r);
      else childrenByParent.set(effectiveParent, [r]);
    }
    const roots: Row[] = [];
    const remap = new Map<string | null, Row[]>();
    for (const r of filtered) {
      const pid =
        ((r as unknown as Record<string, unknown>)[parentField as string] as
          | string
          | null
          | undefined) ?? null;
      const effectiveParent = pid && byId.has(pid) ? pid : null;
      const list = remap.get(effectiveParent);
      if (list) list.push(r);
      else remap.set(effectiveParent, [r]);
    }
    for (const r of remap.get(null) ?? []) roots.push(r);

    const meta = new Map<string, TreeMeta>();
    const ordered: Row[] = [];
    const visit = (row: Row, depth: number) => {
      const children = remap.get(row.id) ?? [];
      meta.set(row.id, { depth, hasChildren: children.length > 0 });
      ordered.push(row);
      if (collapsedIds.has(row.id)) return;
      for (const child of children) visit(child, depth + 1);
    };
    for (const root of roots) visit(root, 0);
    treeMeta.current = meta;
    return ordered;
  }, [config.query.data, config.treeOptions, statusFilter, collapsedIds]);

  /**
   * A blank form, with each boolean extra at the default its column declares.
   *
   * `EMPTY_FORM.extras` is `{}`, and an absent key reads as unticked all the way
   * through to the payload — which is an explicit `false`, not "leave it to the
   * database". See `ExtraFieldKind`'s `defaultValue`.
   */
  const emptyFormWithDefaults = (): AdminFormState => {
    const extras: Record<string, string> = {};
    for (const f of config.extraFields ?? []) {
      if (f.kind.kind === 'boolean' && f.kind.defaultValue) extras[f.name] = 'true';
    }
    return { ...EMPTY_FORM, extras };
  };

  // ── Drawer open/close transitions ───────────────────────────
  const openCreate = () => {
    setSelectedRow(null);
    setSaveError(null);
    setForm(emptyFormWithDefaults());
    setDrawerMode('create');
  };

  const closeDrawer = () => {
    setDrawerMode('closed');
    setSelectedRow(null);
    setSaveError(null);
  };

  const switchToEdit = () => {
    if (!selectedRow) return;
    setForm(rowToForm(selectedRow, config.extraFields));
    setSaveError(null);
    setDrawerMode('edit');
  };

  // ── Drawer form schema (RJSF) ───────────────────────────────
  const formMode: 'create' | 'edit' = drawerMode === 'edit' ? 'edit' : 'create';
  const lookupSchema = useMemo(
    () =>
      buildLookupSchema({
        mode: formMode,
        extraFields: config.extraFields,
        labels: {
          labelEn: tc('labelEn'),
          labelFr: tc('labelFr'),
          descriptionEn: tc('descriptionEn'),
          descriptionFr: tc('descriptionFr'),
          externalIds: tc('externalIds'),
          externalIdsHelp: tc('externalIdsHelp'),
          active: tc('active'),
          editor: {
            key: tc('key'),
            value: tc('value'),
            addRow: tc('addRow'),
            removeRow: tc('removeRow'),
            help: tc('externalIdsHelp'),
          },
        },
      }),
    [formMode, config.extraFields, tc],
  );

  // ── Mutations ───────────────────────────────────────────────
  // `submitted` comes from SchemaForm's onSubmit (already validated by
  // ajv), converted back to AdminFormState so the entity wrappers'
  // buildCreate/UpdatePayload keep their existing contract.
  const save = async (submitted: AdminFormState) => {
    setSaveError(null);
    try {
      if (drawerMode === 'edit' && selectedRow) {
        await config.updateMutation.mutateAsync({
          id: selectedRow.id,
          patch: config.buildUpdatePayload(submitted, selectedRow),
        });
      } else if (drawerMode === 'create') {
        await config.createMutation.mutateAsync(config.buildCreatePayload(submitted));
      }
      config.query.refetch();
      closeDrawer();
    } catch (err) {
      // VeloExpense: through `useRefusalText`, as the row action above (flag f11).
      setSaveError(refusalText(err, tc('errorSave', { message: tc('unknownError') })));
    }
  };

  // ── Reset for ColumnsGear ───────────────────────────────────
  const resetTable = () =>
    setTableState((s) => ({
      ...s,
      columnOrder: columns.map((c) => c.id),
      columnVisibility: {},
      columnWidths: {},
      density: 'normal',
    }));

  // ── Render ──────────────────────────────────────────────────
  const drawerOpen = drawerMode !== 'closed';

  // ── TopBar: push the "Add" button into the global top bar so every
  //    admin page surfaces its primary action in the same spot the
  //    People directory does. The page title comes from the route
  //    mapping in TopBar.tsx — no in-page <h1> needed.
  useTopBarSlots(
    () => ({
      right: config.canWrite ? (
        <Button onClick={openCreate} size="sm">
          <IconPlus size={14} className="mr-1" />
          {t('addNew')}
        </Button>
      ) : null,
    }),
    [config.canWrite, t],
  );

  // ── Filter-pill bar wiring ──────────────────────────────────
  // Pills bind to DataTable's `state.filters`. Reading: derive the
  // displayed pills from the same array column-header filters write
  // to. Writing: the four handlers update the same array, so adding
  // a pill via "+ Add filter" is identical to clicking the column-
  // header filter editor.
  const filterableColumns = useMemo(
    () => columns.filter((c) => c.filterable !== undefined),
    [columns],
  );
  const filterFields = useMemo(() => filterableColumns.map((c) => c.id), [filterableColumns]);
  const filterLabels = useMemo(
    () =>
      Object.fromEntries(filterableColumns.map((c) => [c.id, c.label])) as Record<ColumnId, string>,
    [filterableColumns],
  );
  const filterKinds = useMemo(
    () =>
      Object.fromEntries(
        filterableColumns.map((c) => [c.id, c.filterable?.kind ?? 'text']),
      ) as Record<ColumnId, DataViewFieldKind>,
    [filterableColumns],
  );
  const filterOptions = useMemo(
    () =>
      Object.fromEntries(
        filterableColumns.map((c) => [c.id, c.filterable?.options ?? []]),
      ) as Record<ColumnId, FacetOption[]>,
    [filterableColumns],
  );

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
  const addClause = (field: ColumnId, op: FilterOp, value: string) => {
    setTableState((s) => ({
      ...s,
      filters: [...s.filters, { id: newClauseId(), field, op, value }],
    }));
  };
  const clearClauses = () => setTableState((s) => ({ ...s, filters: [] }));

  // VeloExpense: ExpenseOS's saved-view load / save / rename / delete handlers arrive with
  // saved views in Wave 4 (see the header).

  // ── Bulk actions ─────────────────────────────────────────────
  // Multi-select drives a BulkActionsMenu in the toolbar. The action
  // surface today: Deactivate / Reactivate the selected rows in one
  // shot. We fan out the setActiveMutation per id rather than adding
  // a bulk endpoint — at admin-table scale (≤ a few hundred rows) the
  // serial round-trip is fine and we avoid a router change.
  const selectedRows = useMemo(() => {
    const ids = tableState.selectedIds;
    if (ids.size === 0) return [] as Row[];
    return rows.filter((r) => ids.has(r.id));
  }, [rows, tableState.selectedIds]);
  const allSelectedActive = selectedRows.every((r) => r.active);
  const allSelectedInactive = selectedRows.every((r) => !r.active);
  const clearSelection = () => setTableState((s) => ({ ...s, selectedIds: new Set<string>() }));
  const bulkSetActive = async (active: boolean) => {
    const ids = Array.from(tableState.selectedIds);
    for (const id of ids) {
      try {
        await config.setActiveMutation.mutateAsync({ id, active });
      } catch {
        /* soft-fail per row — the surviving rows still flip */
      }
    }
    clearSelection();
    config.query.refetch();
  };
  // Action list is computed each render — cheap, and the BulkActionsMenu
  // is internally memoised on its own props. Keeping this inline keeps
  // the dep graph honest without a useCallback ladder.
  const bulkActions: Array<{
    id: string;
    label: string;
    onSelect: () => void;
    destructive?: boolean;
    icon?: ReactNode;
  }> = [];
  if (allSelectedActive) {
    bulkActions.push({
      id: 'deactivate',
      label: tc('deactivate'),
      onSelect: () => void bulkSetActive(false),
      icon: <IconUserOff size={14} className="text-destructive/80" />,
      destructive: true,
    });
  }
  if (allSelectedInactive) {
    bulkActions.push({
      id: 'reactivate',
      label: tc('reactivate'),
      onSelect: () => void bulkSetActive(true),
      icon: <IconRestore size={14} className="text-muted-foreground" />,
    });
  }

  // ── Group-by knob ────────────────────────────────────────────
  // Builds the option list TableSettingsButton renders. `(none)` is
  // always present; entity-specific options come from
  // `config.groupableColumns`. The "(none)" sentinel maps to a null
  // groupBy state — DataTable reads null as "flat".
  const groupOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [
      { value: NONE_GROUP, label: tc('noParent') /* reused: "(none)" */ },
    ];
    if (config.groupableColumns) {
      for (const id of config.groupableColumns) {
        const col = columns.find((c) => c.id === id);
        if (col) opts.push({ value: id, label: col.label });
      }
    }
    return opts;
  }, [columns, config.groupableColumns, tc]);
  const groupByValue = (tableState.groupBy ?? NONE_GROUP) as string;
  const onGroupChange = (g: string) => {
    setTableState((s) => ({
      ...s,
      groupBy: (g === NONE_GROUP ? null : (g as ColumnId)) as ColumnId | null,
    }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {rowActionError && (
        <div className="shrink-0 rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive text-sm">
          {rowActionError}
        </div>
      )}
      {/* Filter-pill bar — mirrors EmployeeDirectory's ViewsBar but
          without the saved-views dropdown / scope chip. */}
      <div className="rounded-md border border-border bg-card">
        <FilterPillBar<ColumnId>
          labels={chromeLabels}
          filters={tableState.filters}
          fields={filterFields}
          fieldLabels={filterLabels}
          fieldKinds={filterKinds}
          options={filterOptions}
          onUpdateOp={updateClauseOp}
          onUpdateValue={updateClauseValue}
          onRemoveClause={removeClause}
          onAddClause={addClause}
          onClearAll={clearClauses}
          clearLabel={tTable('misc.clearFilters')}
          // VeloExpense: no `savedViews` until Wave 4 (see the header).
        />
      </div>

      {/* Table card */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        {/* `bulkActions` flips between Deactivate / Reactivate based on the
            selected rows' current state, so we never have to ask the user
            "did you mean…". */}
        <DataTableToolbar
          {...toolbarLabels}
          selectedCount={tableState.selectedIds.size}
          resultCount={rows.length}
          loading={config.query.isLoading}
          bulkActions={config.canWrite ? bulkActions : []}
          bulkActionsDisabled={config.setActiveMutation.isPending}
          rightSlot={
            <>
              <TableExportMenu<Row, ColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename={config.entityKey}
              />
              <TableSettingsButton<ColumnId, string>
                columnOrder={columns.map((c) => c.id)}
                columnVisibility={tableState.columnVisibility as Record<ColumnId, boolean>}
                onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
                columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
                density={tableState.density}
                onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
                groupBy={groupByValue}
                onGroupChange={
                  config.groupableColumns && config.groupableColumns.length > 0
                    ? onGroupChange
                    : undefined
                }
                groupOptions={
                  config.groupableColumns && config.groupableColumns.length > 0
                    ? groupOptions
                    : undefined
                }
                onReset={resetTable}
                labels={tableLabels.settings}
              />
            </>
          }
        />

        {/* Orders its own rows — the table must not re-sort them. */}
        <DataTable<Row, ColumnId>
          sortMode="external"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={config.query.isLoading}
          totalCount={rows.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={(row) => openView(row)}
          activeRowId={selectedRow?.id ?? null}
          labels={tableLabels}
          renderEmpty={() => <div className="font-medium text-foreground">{t('empty')}</div>}
          selectable={config.canWrite}
          // Default group-key reader: column id is assumed to match the
          // row property of the same name. Consumers whose data model
          // diverges (e.g. column `currency` backed by `homeCurrency`)
          // align by renaming the column id.
          groupKeyFor={(row, groupBy) => {
            const v = (row as unknown as Record<string, unknown>)[groupBy as string];
            return v == null || v === '' ? '—' : String(v);
          }}
        />
      </div>

      {/* Right drawer — view / edit / create */}
      <Drawer
        open={drawerOpen}
        onOpenChange={(next) => {
          if (!next) closeDrawer();
        }}
      >
        <DrawerContent width={520} resizable storageKey={`admin.${config.entityKey}`}>
          <DrawerHeader>
            <div className="min-w-0 flex-1">
              <DrawerTitle className="truncate">
                {drawerMode === 'create'
                  ? t('createTitle')
                  : drawerMode === 'edit'
                    ? t('editTitle')
                    : selectedRow
                      ? pickLabel(selectedRow.label, locale) || selectedRow.id
                      : ''}
              </DrawerTitle>
              {selectedRow && (
                <div className="mt-0.5 flex items-center gap-2">
                  <Badge variant={selectedRow.active ? 'success' : 'secondary'}>
                    {selectedRow.active ? tc('active') : tc('inactive')}
                  </Badge>
                </div>
              )}
            </div>
            {drawerMode === 'view' && config.canWrite && (
              <Button variant="outline" size="sm" onClick={switchToEdit}>
                <IconEdit size={14} className="mr-1" />
                {tc('edit')}
              </Button>
            )}
          </DrawerHeader>

          {drawerMode === 'view' && selectedRow ? (
            <DrawerBody className="space-y-6">
              <Section title={tc('identity')}>
                <Field label={tc('labelEn')}>
                  {(selectedRow.label as Record<string, string> | undefined)?.en ?? '—'}
                </Field>
                {/* VeloExpense: French is shown only while it is switched on. */}
                {FRENCH_ON && (
                  <Field label={tc('labelFr')}>
                    {(selectedRow.label as Record<string, string> | undefined)?.['fr-CA'] ?? '—'}
                  </Field>
                )}
                {(selectedRow.description as { en?: string } | undefined)?.en && (
                  <Field label={tc('descriptionEn')}>
                    {(selectedRow.description as Record<string, string>).en}
                  </Field>
                )}
                {FRENCH_ON &&
                  (selectedRow.description as { 'fr-CA'?: string } | undefined)?.['fr-CA'] && (
                  <Field label={tc('descriptionFr')}>
                    {(selectedRow.description as Record<string, string>)['fr-CA']}
                  </Field>
                )}
              </Section>

              {config.renderViewExtras && (
                <Section title={tc('details')}>{config.renderViewExtras(selectedRow)}</Section>
              )}

              <Section title={tc('externalIds')}>
                <ExternalIdsBlock value={selectedRow.externalIds} />
              </Section>

              <Section title={tc('audit')}>
                <Field label={tc('createdAt')}>
                  {new Date(selectedRow.createdAt).toLocaleString(locale)}
                </Field>
                <Field label={tc('updatedAt')}>
                  {new Date(selectedRow.updatedAt).toLocaleString(locale)}
                </Field>
              </Section>
            </DrawerBody>
          ) : (
            // Edit + Create modes share the same RJSF form body. The
            // schema (built above) decides whether the code field is
            // shown / required / disabled. Submission is driven from the
            // footer via the SchemaForm ref so it sits in the Drawer's
            // sticky footer rather than inside the scrolling body.
            <>
              <DrawerBody className="space-y-4">
                <SchemaForm<LookupFormData>
                  ref={formRef}
                  schema={lookupSchema.schema}
                  uiSchema={lookupSchema.uiSchema}
                  fields={lookupFields}
                  widgets={ADMIN_PICKER_WIDGETS}
                  formData={adminToRjsf(form, config.extraFields)}
                  onChange={(data) => setForm(rjsfToAdmin(data, config.extraFields))}
                  onSubmit={(data) => save(rjsfToAdmin(data, config.extraFields))}
                />

                {saveError && (
                  <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive text-sm">
                    {saveError}
                  </div>
                )}
              </DrawerBody>

              <DrawerFooter className="flex justify-end gap-2 border-border border-t px-5 py-3">
                <Button variant="secondary" onClick={closeDrawer}>
                  {tc('cancel')}
                </Button>
                <Button
                  onClick={() => formRef.current?.submit()}
                  disabled={config.createMutation.isPending || config.updateMutation.isPending}
                >
                  {tc('save')}
                </Button>
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function rowToForm<Row extends BaseLookupRow>(
  row: Row,
  extraFields: ExtraFieldDef[] | undefined,
): AdminFormState {
  const label = (row.label ?? {}) as Record<string, string>;
  const desc = (row.description ?? {}) as Record<string, string>;
  const ext = (row.externalIds ?? {}) as Record<string, string>;
  const extras: Record<string, string> = {};
  for (const f of extraFields ?? []) {
    const v = (row as unknown as Record<string, unknown>)[f.name];
    extras[f.name] = v == null ? '' : String(v);
  }
  return {
    labelEn: label.en ?? '',
    labelFr: label['fr-CA'] ?? '',
    descriptionEn: desc.en ?? '',
    descriptionFr: desc['fr-CA'] ?? '',
    externalIds: entriesFromMap(ext),
    active: row.active,
    extras,
  };
}

// ── Layout helpers (exported so entity pages can use them inside
//    renderViewExtras) ─────────────────────────────────────────────

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold text-foreground text-xs uppercase tracking-wide">{title}</h3>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-2 text-sm">
      <dt className="pt-0.5 font-medium text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

// Bespoke ActionsDropdown / ExportDropdown / ColumnsGear helpers
// removed — the toolbar above now composes from the design-system
// primitives (DataTableToolbar + ExportMenu + TableSettingsButton +
// inline include-inactive Checkbox + SelectionCounter).

export type { ColumnDef };
// ── Re-exports for entity wrappers ────────────────────────────────
export { mapFromEntries };
