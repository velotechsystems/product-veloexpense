// biome-ignore-all lint/correctness/useExhaustiveDependencies: admin row handlers are component-scoped; t()/helper closures are render-stable.
/* eslint-disable react-hooks/exhaustive-deps -- VeloExpense: the same exemption as the Biome line above, for ESLint. */
'use client';

/**
 * /admin/policy-rules — the policy-engine v2 Rule Builder. Admins author rule
 * INSTANCES (kind + severity + condition + scope + effective window) as data —
 * no deploy. The condition editor is a flat all/any list of leaf comparisons
 * over the selected kind's fact set (LINE or REPORT); AGGREGATE kinds (e.g.
 * per-diem) run their own built-in check and take no condition. Toolbar +
 * FilterPillBar + DataTable + create/edit drawer, per the listing UX standard.
 *
 * Ported from ExpenseOS (550b2945) with the `policyRule` router (w4-02b, d63). VeloExpense:
 * the shell's path; and the Enabled checkbox's accessible name (f10). The role picker is
 * ExpenseOS's again since the role builder (w4-10c, d64): every tenant has roles. Nothing
 * enforced these rules until the cutover (w4-02d); since then they are what submit checks.
 */
import {
  Button,
  Checkbox,
  Combobox,
  DataTableToolbar,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  FilterPillBar,
  Field as FormField,
  Input,
  MultiSelectDropdown,
  RowActionsMenu,
  TableSettingsButton,
} from '@expenseos/design-system';
import type { Locale } from '@expenseos/i18n/locales';
import type { Predicate, PredicateOp } from '@expenseos/predicate';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { pickLabel } from '@/components/admin/AdminLookupPage';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { useTableLabels, useToolbarLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
import { setTopBarSlot } from '@/app/(app)/TopBar';
import {
  formToParams,
  type ParamFormValue,
  type ParamSpecField,
  paramsComplete,
  paramsToForm,
} from './params';

type PolicyRuleRouter = inferRouterOutputs<AppRouter>['policies']['policyRule'];

type ColumnId = 'kind' | 'scope' | 'severity' | 'condition' | 'category' | 'validity' | 'status';
type Severity = 'INFO' | 'WARNING' | 'BLOCK';

/** One leaf comparison in the flat condition editor. `value` is held as text
 *  and coerced to the wire type (number / string[] / string) on save. */
interface Clause {
  field: string;
  op: PredicateOp;
  value: string;
}

interface FormData {
  kindCode: string;
  /**
   * Editable rule params, keyed by the `paramsSpec` field name.
   *
   * Held as strings (money / number) and booleans — the shape the inputs produce —
   * and converted to the schema's shape once, on save. Money is entered in MAJOR
   * units and stored as a minor-unit digit string.
   */
  params: Record<string, ParamFormValue>;
  severity: Severity;
  match: 'all' | 'any';
  clauses: Clause[];
  messageKey: string;
  enabled: boolean;
  categoryId: string | null;
  jobLevelId: string | null;
  legalEntityId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  roleId: string | null;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string;
}

const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_FORM = (): FormData => ({
  kindCode: '',
  params: {},
  severity: 'WARNING',
  match: 'all',
  clauses: [],
  messageKey: '',
  enabled: true,
  categoryId: null,
  jobLevelId: null,
  legalEntityId: null,
  businessUnitId: null,
  departmentId: null,
  roleId: null,
  effectiveFrom: today(),
  effectiveTo: '',
});

const NUMERIC_OPS = new Set<PredicateOp>(['lt', 'lte', 'gt', 'gte']);
const SET_OPS = new Set<PredicateOp>(['in', 'nin']);

/** Coerce a text value to the Predicate wire type given the operator. */
function coerceValue(op: PredicateOp, raw: string): number | string | string[] {
  if (SET_OPS.has(op))
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (NUMERIC_OPS.has(op)) return Number(raw);
  // eq / neq — numeric-looking text becomes a number (strict-equality semantics).
  return /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
}

function leafToClause(leaf: { field: string; op: PredicateOp; value: unknown }): Clause {
  return {
    field: leaf.field,
    op: leaf.op,
    value: Array.isArray(leaf.value) ? leaf.value.join(', ') : String(leaf.value ?? ''),
  };
}

/** Parse a stored condition back into the flat editor model. Nested composites
 *  aren't surfaced by the flat editor — only the top-level leaves are shown. */
function parseCondition(cond: unknown): { match: 'all' | 'any'; clauses: Clause[] } {
  if (cond && typeof cond === 'object') {
    const c = cond as Record<string, unknown>;
    for (const match of ['all', 'any'] as const) {
      if (Array.isArray(c[match])) {
        const clauses = (c[match] as unknown[])
          .filter((n): n is { field: string; op: PredicateOp; value: unknown } =>
            Boolean(n && typeof n === 'object' && 'field' in (n as object)),
          )
          .map(leafToClause);
        return { match, clauses };
      }
    }
    if ('field' in c) return { match: 'all', clauses: [leafToClause(c as never)] };
  }
  return { match: 'all', clauses: [] };
}

export function PolicyRulesAdmin({ canManage }: { canManage: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('policyRules');
  const locale = useLocale() as Locale;
  const tableLabels = useTableLabels();
  const utils = trpc.useUtils();

  const list = trpc.policies.policyRule.list.useQuery();
  const kindsQ = trpc.policies.policyRule.kinds.useQuery();
  const options = trpc.policies.policyRule.scopeOptions.useQuery();
  const rows = useMemo(() => list.data ?? [], [list.data]);

  const [editing, setEditing] = useState<{ id: string | null; form: FormData } | null>(null);

  const invalidate = () => utils.policies.policyRule.list.invalidate();
  const create = trpc.policies.policyRule.create.useMutation({ onSuccess: invalidate });
  const update = trpc.policies.policyRule.update.useMutation({ onSuccess: invalidate });
  const remove = trpc.policies.policyRule.delete.useMutation({ onSuccess: invalidate });

  // Label maps for resolving ids in the table.
  const categoryLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of options.data?.categories ?? []) m.set(c.id, pickLabel(c.label, locale));
    return m;
  }, [options.data, locale]);

  useEffect(() => {
    setTopBarSlot(
      'right',
      canManage ? (
        <Button size="sm" onClick={() => setEditing({ id: null, form: EMPTY_FORM() })}>
          <IconPlus size={15} className="mr-1.5" />
          {t('add')}
        </Button>
      ) : null,
    );
    return () => setTopBarSlot('right', null);
  }, [t, canManage]);

  const fmtDate = (d: string | Date | null): string =>
    d
      ? new Date(d).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';

  /**
   * What the rule actually tests.
   *
   * This read "—" for all eleven seeded rules, because most of them are AGGREGATE kinds
   * with a built-in check and no predicate — their behaviour lives in `params`, which the
   * column never showed. So the two `RECEIPT_THRESHOLD` rows were identical on screen
   * despite tripping at different amounts (GA readiness report F26). A parameterised rule
   * now shows its parameters.
   */
  const paramSummary = (params: unknown): string => {
    if (!params || typeof params !== 'object') return '';
    const entries = Object.entries(params as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== undefined && v !== '',
    );
    if (!entries.length) return '';
    return entries
      .map(([k, v]) => {
        // Money params are stored in MINOR units; showing 5000 for a $50 threshold is how
        // the number on screen stops matching the number an admin typed.
        const shown = /Minor$/.test(k) ? (Number(v) / 100).toFixed(2) : String(v);
        return `${t.has(`params.${k}`) ? t(`params.${k}`) : k} ${shown}`;
      })
      .join(' · ');
  };

  const conditionSummary = (cond: unknown, params?: unknown): string => {
    const { match, clauses } = parseCondition(cond);
    if (!clauses.length) return paramSummary(params) || '—';
    const sep = match === 'all' ? ' · ' : ' | ';
    return clauses.map((c) => `${c.field} ${t(`op.${c.op}`)} ${c.value}`).join(sep);
  };

  const columns = useMemo<ColumnDef<(typeof rows)[number], ColumnId>[]>(
    () => [
      {
        id: 'kind',
        label: t('col.kind'),
        defaultWidth: 180,
        hideable: false,
        filterable: { kind: 'text' },
        /**
         * The rule's NAME, not its enum. This rendered `TIP_PERCENTAGE` and
         * `RECEIPT_THRESHOLD` verbatim, which reads as debug output — and with two
         * `RECEIPT_THRESHOLD` rules configured at different amounts, made two different
         * rules indistinguishable in the list (GA readiness report F26).
         */
        cell: (r) => (
          <span className="font-medium text-foreground text-sm">
            {t.has(`kind.${r.kindCode}`) ? t(`kind.${r.kindCode}`) : r.kindCode}
          </span>
        ),
      },
      {
        id: 'scope',
        label: t('col.scope'),
        defaultWidth: 110,
        cell: (r) => <span className="text-muted-foreground text-sm">{t(`scope.${r.scope}`)}</span>,
      },
      {
        id: 'severity',
        label: t('col.severity'),
        defaultWidth: 110,
        cell: (r) => {
          const cls =
            r.severity === 'BLOCK'
              ? 'text-destructive'
              : r.severity === 'WARNING'
                ? 'text-amber-600'
                : 'text-muted-foreground';
          return (
            <span className={`font-medium text-sm ${cls}`}>{t(`severity.${r.severity}`)}</span>
          );
        },
      },
      {
        id: 'condition',
        label: t('col.condition'),
        defaultWidth: 300,
        cell: (r) => (
          <span className="truncate text-muted-foreground text-xs">
            {conditionSummary(r.condition, r.params)}
          </span>
        ),
      },
      {
        id: 'category',
        label: t('col.category'),
        defaultWidth: 150,
        cell: (r) => (
          <span className="text-muted-foreground text-sm">
            {r.categoryId ? (categoryLabel.get(r.categoryId) ?? '—') : t('scope.all')}
          </span>
        ),
      },
      {
        id: 'validity',
        label: t('col.validity'),
        defaultWidth: 190,
        cell: (r) => (
          <span className="text-muted-foreground text-xs">
            {fmtDate(r.effectiveFrom)}
            {r.effectiveTo ? ` – ${fmtDate(r.effectiveTo)}` : ` – ${t('ongoing')}`}
          </span>
        ),
      },
      {
        id: 'status',
        label: t('col.status'),
        defaultWidth: 100,
        cell: (r) => (
          <span className={`text-sm ${r.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
            {r.enabled ? t('status.enabled') : t('status.disabled')}
          </span>
        ),
      },
    ],
    [t, categoryLabel, locale],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    // The actions column has to be in the seeded column order or the table never
    // renders it — and the row kebab is the ONLY way to delete a rule.
    createDataTableState([...columns, { id: 'actions' }] as never, {}),
  );

  const filteredRows = useMemo(() => {
    let out = rows;
    for (const c of tableState.filters) {
      if (c.field === 'kind' && c.op === 'contains') {
        const n = c.value.toLowerCase();
        out = out.filter((r) => r.kindCode.toLowerCase().includes(n));
      }
    }
    return out;
  }, [rows, tableState.filters]);

  const pillBar = useFilterPillBarWiring<(typeof rows)[number], ColumnId>(
    columns,
    tableState,
    setTableState,
  );

  const openEdit = (r: (typeof rows)[number]) => {
    const parsed = parseCondition(r.condition);
    setEditing({
      id: r.id,
      form: {
        kindCode: r.kindCode,
        params: paramsToForm(
          (kindsQ.data?.kinds.find((k) => k.code === r.kindCode)?.paramsSpec ??
            []) as ParamSpecField[],
          r.params,
          kindsQ.data?.policyCurrency ?? 'CAD',
        ),
        severity: r.severity as Severity,
        match: parsed.match,
        clauses: parsed.clauses,
        messageKey: r.messageKey,
        enabled: r.enabled,
        categoryId: r.categoryId,
        jobLevelId: r.jobLevelId,
        legalEntityId: r.legalEntityId,
        businessUnitId: r.businessUnitId,
        departmentId: r.departmentId,
        roleId: r.roleId,
        effectiveFrom: new Date(r.effectiveFrom).toISOString().slice(0, 10),
        effectiveTo: r.effectiveTo ? new Date(r.effectiveTo).toISOString().slice(0, 10) : '',
      },
    });
  };

  const rowActions = (r: (typeof rows)[number]) =>
    canManage
      ? [
          {
            id: 'edit',
            icon: <IconPencil size={14} />,
            label: t('edit'),
            onClick: () => openEdit(r),
          },
          { divider: true as const },
          {
            id: 'delete',
            icon: <IconTrash size={14} />,
            label: t('delete'),
            destructive: true,
            onClick: () => remove.mutate({ id: r.id }),
          },
        ]
      : [];

  const columnsWithActions = useMemo<ColumnDef<(typeof rows)[number], ColumnId | 'actions'>[]>(
    () => [
      ...(columns as ColumnDef<(typeof rows)[number], ColumnId | 'actions'>[]),
      {
        id: 'actions',
        label: '',
        defaultWidth: 60,
        hideable: false,
        draggable: false,
        resizable: false,
        pinnable: false,
        cell: (r) =>
          canManage ? (
            <div className="flex justify-end">
              <RowActionsMenu ariaLabel={t('actions')} actions={rowActions(r)} />
            </div>
          ) : null,
      },
    ],
    [columns, canManage, t],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="rounded-md border border-border bg-card">
        <FilterPillBar<ColumnId>
          labels={pillBar.chromeLabels}
          filters={pillBar.filters}
          fields={pillBar.filterFields}
          fieldLabels={pillBar.filterLabels}
          fieldKinds={pillBar.filterKinds}
          options={pillBar.filterOptions}
          onUpdateOp={pillBar.updateClauseOp}
          onUpdateValue={pillBar.updateClauseValue}
          onRemoveClause={pillBar.removeClause}
          onAddClause={pillBar.addClause}
          onClearAll={pillBar.clearClauses}
          clearLabel={pillBar.clearLabel}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTableToolbar
          {...toolbarLabels}
          resultCount={filteredRows.length}
          loading={list.isLoading}
          rightSlot={
            <TableSettingsButton<ColumnId | 'actions', string>
              columnOrder={columnsWithActions.map((c) => c.id)}
              columnVisibility={
                tableState.columnVisibility as Record<ColumnId | 'actions', boolean>
              }
              onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
              columnLabelFor={(c) => columnsWithActions.find((col) => col.id === c)?.label ?? c}
              density={tableState.density}
              onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
              onReset={() =>
                setTableState((s) => ({
                  ...s,
                  columnVisibility: {},
                  columnWidths: {},
                  density: 'normal',
                }))
              }
              labels={tableLabels.settings}
            />
          }
        />
        <DataTable<(typeof rows)[number], ColumnId | 'actions'>
          columns={columnsWithActions}
          rows={filteredRows}
          rowKey={(r) => r.id}
          totalCount={filteredRows.length}
          state={tableState as DataTableState<ColumnId | 'actions'>}
          onStateChange={setTableState as never}
          onRowClick={(r) => canManage && openEdit(r)}
          loading={list.isLoading}
          labels={tableLabels}
          selectable={false}
          renderEmpty={() => (
            <div>
              <div className="font-medium text-foreground">{t('emptyTitle')}</div>
              <div className="mt-1 text-muted-foreground text-sm">{t('emptyBody')}</div>
            </div>
          )}
        />
      </div>

      {editing && kindsQ.data && (
        <RuleDrawer
          initial={editing.form}
          isNew={editing.id === null}
          pending={create.isPending || update.isPending}
          registry={kindsQ.data}
          options={options.data}
          onClose={() => setEditing(null)}
          onSave={(form) => {
            const kind = kindsQ.data.kinds.find((k) => k.code === form.kindCode);
            const condition =
              kind?.requiresCondition && form.clauses.length
                ? ({
                    [form.match]: form.clauses.map((c) => ({
                      field: c.field,
                      op: c.op,
                      value: coerceValue(c.op, c.value),
                    })),
                  } as Predicate)
                : null;
            const patch = {
              kindCode: form.kindCode,
              severity: form.severity,
              condition,
              params: formToParams(
                (kind?.paramsSpec ?? []) as ParamSpecField[],
                form.params,
                kindsQ.data.policyCurrency,
                locale,
              ),
              messageKey: form.messageKey.trim(),
              enabled: form.enabled,
              categoryId: form.categoryId,
              jobLevelId: form.jobLevelId,
              legalEntityId: form.legalEntityId,
              businessUnitId: form.businessUnitId,
              departmentId: form.departmentId,
              roleId: form.roleId,
              effectiveFrom: new Date(form.effectiveFrom),
              effectiveTo: form.effectiveTo ? new Date(form.effectiveTo) : null,
            };
            const done = () => setEditing(null);
            if (editing.id) update.mutate({ id: editing.id, patch }, { onSuccess: done });
            else create.mutate(patch, { onSuccess: done });
          }}
        />
      )}
    </div>
  );
}

type Item = { value: string; label: string };
type Registry = PolicyRuleRouter['kinds'];
type ScopeOptions = PolicyRuleRouter['scopeOptions'] | undefined;

function RuleDrawer({
  initial,
  isNew,
  pending,
  registry,
  options,
  onClose,
  onSave,
}: {
  initial: FormData;
  isNew: boolean;
  pending: boolean;
  registry: Registry;
  options: ScopeOptions;
  onClose: () => void;
  onSave: (form: FormData) => void;
}) {
  const t = useTranslations('policyRules');
  const locale = useLocale() as Locale;
  const [form, setForm] = useState<FormData>(initial);
  const set = <K extends keyof FormData>(k: K, v: FormData[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const kind = registry.kinds.find((k) => k.code === form.kindCode);
  const requiresCondition = Boolean(kind?.requiresCondition);
  const fields = kind?.scope === 'REPORT' ? registry.reportFields : registry.lineFields;

  const kindItems: Item[] = registry.kinds.map((k) => ({ value: k.code, label: k.code }));
  const severityItems: Item[] = (['INFO', 'WARNING', 'BLOCK'] as const).map((s) => ({
    value: s,
    label: t(`severity.${s}`),
  }));
  const matchItems: Item[] = (['all', 'any'] as const).map((m) => ({
    value: m,
    label: t(`match.${m}`),
  }));
  const fieldItems: Item[] = (fields ?? []).map((f) => ({ value: f, label: f }));
  const opItems: Item[] = registry.ops.map((o) => ({ value: o, label: t(`op.${o}`) }));

  const catItems: Item[] = (options?.categories ?? []).map((c) => ({
    value: c.id,
    label: pickLabel(c.label, locale),
  }));
  const jobLevelItems: Item[] = (options?.jobLevels ?? []).map((j) => ({
    value: j.id,
    label: `${j.code} — ${pickLabel(j.label, locale)}`,
  }));
  const leItems: Item[] = (options?.legalEntities ?? []).map((l) => ({
    value: l.id,
    label: pickLabel(l.label, locale),
  }));
  const buItems: Item[] = (options?.businessUnits ?? []).map((b) => ({
    value: b.id,
    label: pickLabel(b.label, locale),
  }));
  const deptItems: Item[] = (options?.departments ?? []).map((d) => ({
    value: d.id,
    label: pickLabel(d.label, locale),
  }));
  const roleItems: Item[] = (options?.roles ?? []).map((r) => ({
    value: r.id,
    label: pickLabel(r.label, locale),
  }));

  /** When the kind changes, adopt its default severity + message key and drop
   *  a now-inapplicable condition. */
  const onKindChange = (code: string | null) => {
    const k = registry.kinds.find((x) => x.code === code);
    setForm((f) => ({
      ...f,
      kindCode: code ?? '',
      severity: (k?.defaultSeverity as Severity) ?? f.severity,
      messageKey: f.messageKey || k?.messageKey || '',
      clauses: k?.requiresCondition ? f.clauses : [],
      // A different kind has different params; carrying the old ones over would post
      // fields the new schema rejects. Booleans start at their documented default.
      params: paramsToForm((k?.paramsSpec ?? []) as ParamSpecField[], {}, registry.policyCurrency),
    }));
  };

  const addClause = () =>
    set('clauses', [...form.clauses, { field: fields?.[0] ?? '', op: 'eq', value: '' }]);
  const setClause = (i: number, patch: Partial<Clause>) =>
    set(
      'clauses',
      form.clauses.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    );
  const removeClause = (i: number) =>
    set(
      'clauses',
      form.clauses.filter((_, j) => j !== i),
    );

  const paramSpec = (kind?.paramsSpec ?? []) as ParamSpecField[];
  /**
   * WHY Save is disabled, in the reader's words.
   *
   * Every condition below was already enforced — clearing a required "Threshold (CAD)"
   * left the button dead — but the form said nothing about it, so the experience was a
   * control that had simply stopped working: no inline error, no toast, and a drawer that
   * never closed (GA readiness report F25). The refusal is right; the silence was not.
   *
   * Built as a LIST rather than a boolean so the reason is stated, and derived from the
   * same expressions that gate the button — there is no second source of truth to drift.
   */
  const blockers: string[] = [];
  if (form.kindCode === '') blockers.push(t('field.kind'));
  if (form.messageKey.trim() === '') blockers.push(t('field.messageKey'));
  if (form.effectiveFrom === '') blockers.push(t('field.effectiveFrom'));
  // A rule missing its threshold saves happily and then does nothing, so the form
  // refuses it rather than letting an admin create an inert rule.
  if (!paramsComplete(paramSpec, kind?.paramsAtLeastOneOf ?? [], form.params)) {
    blockers.push(t('field.params'));
  }
  if (
    requiresCondition &&
    !(form.clauses.length > 0 && form.clauses.every((c) => c.field !== '' && c.value.trim() !== ''))
  ) {
    blockers.push(t('field.condition'));
  }
  const valid = blockers.length === 0;

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerContent width={560}>
        <DrawerHeader>
          <DrawerTitle>{isNew ? t('add') : t('edit')}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <FormField htmlFor="pr-kind" label={t('field.kind')} required>
              <Combobox
                id="pr-kind"
                items={kindItems}
                value={form.kindCode || null}
                onValueChange={onKindChange}
              />
            </FormField>
            <FormField htmlFor="pr-severity" label={t('field.severity')} required>
              <Combobox
                id="pr-severity"
                items={severityItems}
                value={form.severity}
                onValueChange={(v) => v && set('severity', v as Severity)}
              />
            </FormField>
          </div>

          {paramSpec.length > 0 && (
            <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
              <p className="font-medium text-muted-foreground text-xs">
                {t('params.title', { kind: form.kindCode })}
              </p>
              {paramSpec.map((f) =>
                f.kind === 'lookupIds' ? (
                  <FormField
                    key={f.name}
                    htmlFor={`pr-param-${f.name}`}
                    label={t(`params.${f.name}`)}
                    description={t(`params.hint.${f.name}`)}
                  >
                    <MultiSelectDropdown
                      id={`pr-param-${f.name}`}
                      items={jobLevelItems}
                      value={
                        Array.isArray(form.params[f.name]) ? (form.params[f.name] as string[]) : []
                      }
                      onValueChange={(next) => set('params', { ...form.params, [f.name]: next })}
                      placeholder={t('params.noneSelected')}
                    />
                  </FormField>
                ) : f.kind === 'enum' ? (
                  <FormField
                    key={f.name}
                    htmlFor={`pr-param-${f.name}`}
                    label={t(`params.${f.name}`)}
                    required={Boolean(f.required)}
                  >
                    <Combobox
                      id={`pr-param-${f.name}`}
                      items={(f.options ?? []).map((o) => ({
                        value: o,
                        // Labelled, not raw: an admin picks "Business", not "BUSINESS".
                        label: t(`params.option.${f.name}.${o}` as never),
                      }))}
                      value={
                        typeof form.params[f.name] === 'string'
                          ? (form.params[f.name] as string)
                          : null
                      }
                      onValueChange={(v) => set('params', { ...form.params, [f.name]: v ?? '' })}
                    />
                  </FormField>
                ) : f.kind === 'boolean' ? (
                  <label
                    key={f.name}
                    className="flex items-center gap-2 text-foreground text-sm"
                    htmlFor={`pr-param-${f.name}`}
                  >
                    <input
                      id={`pr-param-${f.name}`}
                      type="checkbox"
                      className="size-4"
                      checked={Boolean(form.params[f.name])}
                      onChange={(e) =>
                        set('params', { ...form.params, [f.name]: e.target.checked })
                      }
                    />
                    {t(`params.${f.name}`)}
                  </label>
                ) : (
                  <FormField
                    key={f.name}
                    htmlFor={`pr-param-${f.name}`}
                    // Money fields name their currency in the label: the value is stored
                    // in minor units, so an unlabelled box invites typing 1000 for a
                    // thousand dollars and getting a rule that fires at ten.
                    label={
                      f.kind === 'moneyMinor'
                        ? `${t(`params.${f.name}`)} (${registry.policyCurrency})`
                        : t(`params.${f.name}`)
                    }
                    required={Boolean(f.required)}
                  >
                    <Input
                      id={`pr-param-${f.name}`}
                      inputMode="decimal"
                      placeholder={f.kind === 'moneyMinor' ? '0.00' : ''}
                      value={
                        typeof form.params[f.name] === 'string'
                          ? (form.params[f.name] as string)
                          : ''
                      }
                      onChange={(e) => set('params', { ...form.params, [f.name]: e.target.value })}
                    />
                  </FormField>
                ),
              )}
              {(kind?.paramsAtLeastOneOf?.length ?? 0) > 0 && (
                <p className="text-[11px] text-muted-foreground">{t('params.atLeastOne')}</p>
              )}
            </div>
          )}

          <FormField htmlFor="pr-msg" label={t('field.messageKey')} required>
            <Input
              id="pr-msg"
              value={form.messageKey}
              placeholder="policy.generic"
              onChange={(e) => set('messageKey', e.target.value)}
            />
          </FormField>
          <p className="-mt-2 text-[11px] text-muted-foreground">{t('messageHint')}</p>

          {/* Condition editor — only for kinds that take a Predicate. */}
          {requiresCondition ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <p className="font-medium text-foreground text-xs">{t('conditionTitle')}</p>
                <div className="w-40">
                  <Combobox
                    id="pr-match"
                    items={matchItems}
                    value={form.match}
                    onValueChange={(v) => v && set('match', v as 'all' | 'any')}
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">{t('conditionHint')}</p>
              {form.clauses.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: clauses have no stable id; position is the identity in this small editable list.
                <div key={i} className="flex items-end gap-2">
                  <div className="flex-1">
                    <Combobox
                      items={fieldItems}
                      value={c.field || null}
                      onValueChange={(v) => setClause(i, { field: v ?? '' })}
                      placeholder={t('fieldPlaceholder')}
                    />
                  </div>
                  <div className="w-32">
                    <Combobox
                      items={opItems}
                      value={c.op}
                      onValueChange={(v) => v && setClause(i, { op: v as PredicateOp })}
                    />
                  </div>
                  <div className="flex-1">
                    <Input
                      value={c.value}
                      placeholder={t('valuePlaceholder')}
                      onChange={(e) => setClause(i, { value: e.target.value })}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeClause(i)}
                    aria-label={t('removeClause')}
                  >
                    <IconTrash size={14} />
                  </Button>
                </div>
              ))}
              <Button variant="secondary" size="sm" onClick={addClause}>
                <IconPlus size={14} className="mr-1.5" />
                {t('addClause')}
              </Button>
            </div>
          ) : (
            <p className="rounded-md border border-border bg-muted/30 p-3 text-muted-foreground text-xs">
              {t('kindNoCondition')}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField htmlFor="pr-from" label={t('field.effectiveFrom')} required>
              <Input
                id="pr-from"
                type="date"
                value={form.effectiveFrom}
                onChange={(e) => set('effectiveFrom', e.target.value)}
              />
            </FormField>
            <FormField htmlFor="pr-to" label={t('field.effectiveTo')} optional>
              <Input
                id="pr-to"
                type="date"
                value={form.effectiveTo}
                onChange={(e) => set('effectiveTo', e.target.value)}
              />
            </FormField>
          </div>

          {/* biome-ignore lint/a11y/noLabelWithoutControl: the control (Checkbox) is nested as children */}
          <label className="flex items-center gap-2 text-foreground text-sm">
            {/* VeloExpense: named by aria-label — Base UI's checkbox is a span its <label> does not name (f10). */}
            <Checkbox
              aria-label={t('field.enabled')}
              checked={form.enabled}
              onCheckedChange={(c) => set('enabled', c === true)}
            />
            {t('field.enabled')}
          </label>

          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="font-medium text-foreground text-xs">{t('scopeTitle')}</p>
            <p className="text-[11px] text-muted-foreground">{t('scopeHint')}</p>
            <FormField htmlFor="pr-cat" label={t('field.category')} optional>
              <Combobox
                id="pr-cat"
                items={catItems}
                value={form.categoryId}
                onValueChange={(v) => set('categoryId', v)}
                placeholder={t('scope.any')}
              />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField htmlFor="pr-jl" label={t('field.jobLevel')} optional>
                <Combobox
                  id="pr-jl"
                  items={jobLevelItems}
                  value={form.jobLevelId}
                  onValueChange={(v) => set('jobLevelId', v)}
                  placeholder={t('scope.anyLevel')}
                />
              </FormField>
              <FormField htmlFor="pr-dept" label={t('field.department')} optional>
                <Combobox
                  id="pr-dept"
                  items={deptItems}
                  value={form.departmentId}
                  onValueChange={(v) => set('departmentId', v)}
                  placeholder={t('scope.any')}
                />
              </FormField>
              <FormField htmlFor="pr-le" label={t('field.legalEntity')} optional>
                <Combobox
                  id="pr-le"
                  items={leItems}
                  value={form.legalEntityId}
                  onValueChange={(v) => set('legalEntityId', v)}
                  placeholder={t('scope.any')}
                />
              </FormField>
              <FormField htmlFor="pr-bu" label={t('field.businessUnit')} optional>
                <Combobox
                  id="pr-bu"
                  items={buItems}
                  value={form.businessUnitId}
                  onValueChange={(v) => set('businessUnitId', v)}
                  placeholder={t('scope.any')}
                />
              </FormField>
              <FormField htmlFor="pr-role" label={t('field.role')} optional>
                <Combobox
                  id="pr-role"
                  items={roleItems}
                  value={form.roleId}
                  onValueChange={(v) => set('roleId', v)}
                  placeholder={t('scope.any')}
                />
              </FormField>
            </div>
          </div>
        </DrawerBody>
        <DrawerFooter>
          {/* The reason, beside the control it disables — not in a toast that has to be
              caught, and not left to be inferred from a button that stopped responding. */}
          {!valid && (
            <p className="mr-auto max-w-[24rem] text-left text-warning text-xs">
              {t('blocked', { fields: blockers.join(', ') })}
            </p>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!valid || pending}
            title={valid ? undefined : t('blocked', { fields: blockers.join(', ') })}
            onClick={() => onSave(form)}
          >
            {pending ? t('saving') : t('save')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
