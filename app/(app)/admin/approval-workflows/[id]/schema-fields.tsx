'use client';

import type {
  ApproverFallback,
  ApproverSpec,
  Predicate,
  PredicateField,
} from '@expenseos/approvals';
/**
 * Custom RJSF fields for the schema-driven node config. The genuinely-custom
 * controls — the recursive Predicate condition builder, the ApproverSpec
 * discriminated union, and the Switch `cases` array (whose items carry a stable
 * routing id) — can't be expressed as plain JSON-schema widgets, so they're
 * registered as `ui:field`s and read their option data from NodeConfigContext.
 */
import {
  Button,
  Combobox,
  Field as FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import type { FieldProps } from '@rjsf/utils';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { displayName } from '@/lib/format';
import { ConditionBar } from './ConditionBar';
import { useNodeConfig } from './node-config-context';
// VeloExpense kit: APPROVER_KIND_LABEL fed the Base UI render-fn the Radix SelectValue replaces.
import { APPROVER_FILTER_FIELDS, type EditorOptions } from './options';

type ComboItem = { value: string; label: string };

const jobLevelItemsOf = (options: EditorOptions | undefined, locale: Locale): ComboItem[] =>
  (options?.jobLevels ?? []).map((j) => ({
    value: j.id,
    label: `${j.code} — ${getLocalized(j.label, locale) ?? j.code}`,
  }));

const userItemsOf = (options: EditorOptions | undefined): ComboItem[] =>
  (options?.users ?? []).map((u) => ({ value: u.id, label: displayName(u) }));

const roleItemsOf = (options: EditorOptions | undefined, locale: Locale): ComboItem[] =>
  (options?.roles ?? []).map((r) => ({
    value: r.id,
    label: String(getLocalized(r.label, locale) ?? r.id),
  }));

// ── Predicate field ──────────────────────────────────────────────────────────

/** `ui:field: 'predicate'` — the condition builder. `ui:options` may carry
 *  `{ allowAlways, fields }` to tune it per use site. */
function PredicateConditionField(props: FieldProps) {
  const { options, fields: subjectFields, locale } = useNodeConfig();
  const uiOpts = (props.uiSchema?.['ui:options'] ?? {}) as {
    allowAlways?: boolean;
    fields?: PredicateField[];
  };
  // A node may narrow the field set (ui:options.fields); intersect it with the
  // subject's available fields so an expense-report condition never offers
  // VCC-only fields (vendor / interval).
  const fields = uiOpts.fields
    ? uiOpts.fields.filter((f) => subjectFields.includes(f))
    : subjectFields;
  return (
    <ConditionBar
      value={(props.formData ?? { always: true }) as Predicate}
      onChange={(p) => props.onChange(p)}
      options={options}
      locale={locale}
      allowAlways={uiOpts.allowAlways ?? false}
      fields={fields}
    />
  );
}

// ── Approver field ─────────────────────────────────────────────────────────

/** `ui:field: 'approver'` — the unified approver editor. */
function ApproverField(props: FieldProps) {
  const { options, locale } = useNodeConfig();
  return (
    <ApproverConfig
      approver={(props.formData ?? { kind: 'manager' }) as ApproverSpec}
      jobLevelItems={jobLevelItemsOf(options, locale)}
      options={options}
      locale={locale}
      onChange={(a) => props.onChange(a)}
    />
  );
}

/**
 * The no-manager fallback control, shown for the two RELATIVE approver kinds.
 *
 * Without it the editor could describe every routing rule EXCEPT the one for the
 * person at the top of the org chart, whose task parks unassigned and is then
 * claimable by anyone holding the subject's approve permission — for an expense
 * report, every line manager in the company. "Leave it to the approver pool" is
 * still offered, and still the default, because that is what existing published
 * workflows do; it is now a choice somebody makes rather than the only outcome.
 */
function FallbackFields({
  fallback,
  options,
  locale,
  onChange,
}: {
  fallback: ApproverFallback | undefined;
  options: EditorOptions | undefined;
  locale: Locale;
  onChange: (f: ApproverFallback | undefined) => void;
}) {
  const t = useTranslations('workflows.approver');
  const kind = fallback?.kind ?? 'none';
  const label = { none: t('fallbackNone'), user: t('fallbackUser'), role: t('fallbackRole') };
  return (
    <>
      <FormField label={t('fallbackLabel')} description={t('fallbackHint')}>
        <Select
          value={kind}
          onValueChange={(v) => {
            if (v === 'user') onChange({ kind: 'user', userId: '' });
            else if (v === 'role') onChange({ kind: 'role', roleId: '' });
            else onChange(undefined);
          }}
        >
          <SelectTrigger className="h-8">
            {/* VeloExpense kit: Radix's <SelectValue> renders the chosen item's own label (see
                  components/forms/ColorInput.tsx); ExpenseOS's Base UI render-fn is not needed. */}
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{label.none}</SelectItem>
            <SelectItem value="user">{label.user}</SelectItem>
            <SelectItem value="role">{label.role}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {fallback?.kind === 'user' && (
        <FormField label={t('fallbackUserLabel')}>
          <Combobox
            items={userItemsOf(options)}
            value={fallback.userId || null}
            onValueChange={(v) => onChange(v ? { kind: 'user', userId: v } : undefined)}
            placeholder={t('fallbackUserPlaceholder')}
          />
        </FormField>
      )}

      {fallback?.kind === 'role' && (
        <FormField label={t('fallbackRoleLabel')} description={t('fallbackRoleHint')}>
          <Combobox
            items={roleItemsOf(options, locale)}
            value={fallback.roleId || null}
            onValueChange={(v) => onChange(v ? { kind: 'role', roleId: v } : undefined)}
            placeholder={t('fallbackRolePlaceholder')}
          />
        </FormField>
      )}
    </>
  );
}

/** Approver editor: a preset selector plus, for the filter approver, a min-level
 *  picker and a ConditionBar over user attributes. Split into prop-typed
 *  sub-components so the discriminated approver narrows inside the callbacks. */
function ApproverConfig({
  approver,
  jobLevelItems,
  options,
  locale,
  onChange,
}: {
  approver: ApproverSpec;
  jobLevelItems: ComboItem[];
  options: EditorOptions | undefined;
  locale: Locale;
  onChange: (a: ApproverSpec) => void;
}) {
  const t = useTranslations('workflows');
  // Carried across manager ↔ managerChain: both are relative approvers with the
  // same blind spot, so re-picking the tier must not silently drop who decides
  // for the person at the top. Switching to `filter` drops it, because a filter
  // approver is a pool by design and takes no fallback.
  const fallback = approver.kind === 'filter' ? undefined : approver.fallback;
  return (
    <div className="space-y-3">
      <FormField label="Approver">
        <Select
          value={approver.kind}
          onValueChange={(v) => {
            const kind = (v as ApproverSpec['kind']) ?? 'manager';
            onChange(
              kind === 'manager'
                ? { kind: 'manager', ...(fallback ? { fallback } : {}) }
                : kind === 'managerChain'
                  ? { kind: 'managerChain', minJobLevelId: null, ...(fallback ? { fallback } : {}) }
                  : { kind: 'filter', minJobLevelId: null, match: { always: true } },
            );
          }}
        >
          <SelectTrigger className="h-8">
            {/* VeloExpense kit: Radix's <SelectValue> renders the chosen item's own label (see
                components/forms/ColorInput.tsx); ExpenseOS's Base UI render-fn is not needed. */}
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manager">Direct manager</SelectItem>
            <SelectItem value="managerChain">Manager ancestor</SelectItem>
            <SelectItem value="filter">Custom filter</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {approver.kind === 'managerChain' && (
        <FormField label="Minimum job level" description="Empty = the requester's direct manager.">
          <Combobox
            items={jobLevelItems}
            value={approver.minJobLevelId ?? null}
            onValueChange={(v) =>
              onChange({
                kind: 'managerChain',
                minJobLevelId: v,
                ...(fallback ? { fallback } : {}),
              })
            }
            placeholder={t('directManager')}
          />
        </FormField>
      )}

      {approver.kind !== 'filter' && (
        <FallbackFields
          fallback={fallback}
          options={options}
          locale={locale}
          onChange={(f) =>
            onChange(
              approver.kind === 'manager'
                ? { kind: 'manager', ...(f ? { fallback: f } : {}) }
                : {
                    kind: 'managerChain',
                    minJobLevelId: approver.minJobLevelId ?? null,
                    ...(f ? { fallback: f } : {}),
                  },
            )
          }
        />
      )}

      {approver.kind === 'filter' && (
        <FilterApproverFields
          approver={approver}
          jobLevelItems={jobLevelItems}
          options={options}
          locale={locale}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function FilterApproverFields({
  approver,
  jobLevelItems,
  options,
  locale,
  onChange,
}: {
  approver: Extract<ApproverSpec, { kind: 'filter' }>;
  jobLevelItems: ComboItem[];
  options: EditorOptions | undefined;
  locale: Locale;
  onChange: (a: ApproverSpec) => void;
}) {
  const t = useTranslations('workflows');
  return (
    <>
      <FormField label="Minimum job level" optional>
        <Combobox
          items={jobLevelItems}
          value={approver.minJobLevelId ?? null}
          onValueChange={(v) =>
            onChange({ kind: 'filter', minJobLevelId: v, match: approver.match })
          }
          placeholder={t('anyLevel')}
        />
      </FormField>
      <FormField
        label="Who can approve"
        description="Any active user matching can claim & approve."
      >
        <ConditionBar
          value={approver.match}
          onChange={(match) =>
            onChange({ kind: 'filter', minJobLevelId: approver.minJobLevelId ?? null, match })
          }
          options={options}
          locale={locale}
          fields={APPROVER_FILTER_FIELDS}
        />
      </FormField>
    </>
  );
}

// ── Switch cases field ───────────────────────────────────────────────────────

type SwitchCase = { id: string; label?: string; predicate: Predicate };

/** `ui:field: 'cases'` — the Switch case list. Mints stable `case-N` routing
 *  ids and renders each case's Label + Conditions as FormField-labelled
 *  controls (consistent with the rest of the config). */
function CasesField(props: FieldProps) {
  const { options, locale } = useNodeConfig();
  const cases = (props.formData ?? []) as SwitchCase[];
  const set = (next: SwitchCase[]) => props.onChange(next);
  const addCase = () => {
    let maxN = 0;
    for (const c of cases) {
      const m = /^case-(\d+)$/.exec(c.id ?? '');
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    set([
      ...cases,
      { id: `case-${maxN + 1}`, predicate: { field: 'amount', op: 'gte', value: 0 } },
    ]);
  };

  return (
    <div className="space-y-3">
      {cases.map((c, i) => (
        <div key={c.id} className="space-y-2 rounded-md border border-border p-2">
          <div className="flex items-center gap-2">
            <Input
              className="h-7 flex-1 font-medium"
              value={c.label ?? ''}
              placeholder={`Case ${i + 1}`}
              onChange={(e) => {
                const next = [...cases];
                next[i] = { ...c, label: e.target.value || undefined };
                set(next);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Remove case"
              className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => set(cases.filter((_, j) => j !== i))}
            >
              <IconX size={13} />
            </Button>
          </div>
          <ConditionBar
            value={c.predicate}
            onChange={(predicate) => {
              const next = [...cases];
              next[i] = { ...c, predicate };
              set(next);
            }}
            options={options}
            locale={locale}
            allowAlways={false}
          />
        </div>
      ))}
      <Button size="sm" variant="outline" className="w-full" onClick={addCase}>
        <IconPlus size={13} className="mr-1" />
        Case
      </Button>
    </div>
  );
}

export const NODE_CONFIG_FIELDS = {
  predicate: PredicateConditionField,
  approver: ApproverField,
  cases: CasesField,
};
