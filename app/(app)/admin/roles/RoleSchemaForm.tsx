'use client';

/**
 * Schema + custom widgets for the RoleBuilder edit drawer.
 *
 * Three pieces:
 *
 *   - `buildRoleSchema()` — returns the `{ schema, uiSchema }` pair
 *     driving the SchemaForm. The simple fields (labelEn/Fr,
 *     descriptionEn/Fr, active) use the default templates; the two
 *     complex fields use custom widgets.
 *
 *   - `PermissionsWidget` — custom RJSF widget for the role's
 *     `permissions: string[]` field. Renders one <Fieldset> per
 *     module (kebab-prefix grouping of the catalog), each with a
 *     grid of `[Checkbox] code` rows plus Select-all / Clear actions
 *     in the legend. The catalog is passed via `ui:options.catalog`
 *     so the widget doesn't reach into app state.
 *
 *   - `externalIds` rides on the design-system's `ExternalIdsWidget`
 *     (`'ui:widget': 'externalIds'`) — no per-role custom code needed.
 *
 * The code field (auto-derived from labelEn) and the system-role
 * notice stay OUTSIDE SchemaForm — they're conditional / read-only
 * markers, not editable fields.
 *
 * Ported from ExpenseOS (1e682dd6), w4-10c. VeloExpense: the French name and description are
 * not asked for while French is switched off (`ENABLED_LOCALES`, 7 Oct), as on the lookup
 * screens (components/admin/AdminLookupForm.tsx). A French name already saved is carried
 * through the form data untouched.
 */

import { Button, Checkbox, type ExternalIdSourceOption, Fieldset } from '@expenseos/design-system';
import { ENABLED_LOCALES } from '@expenseos/i18n/locales';
import type { RJSFSchema, UiSchema, WidgetProps } from '@rjsf/utils';

/** Bucket a permission code into a module label (split on `.`). */
export function moduleOf(perm: string): string {
  const i = perm.indexOf('.');
  return i < 0 ? perm : perm.slice(0, i);
}

/** Form-data shape RJSF round-trips. Matches the wire shape used by
 *  the create/update tRPC mutations, so the save handler can pass it
 *  through with minimal massaging. */
export interface RoleFormData {
  labelEn: string;
  labelFr: string;
  descriptionEn: string;
  descriptionFr: string;
  permissions: string[];
  externalIds: Record<string, string>;
  active: boolean;
}

export const EMPTY_ROLE_FORM: RoleFormData = {
  labelEn: '',
  labelFr: '',
  descriptionEn: '',
  descriptionFr: '',
  permissions: [],
  externalIds: {},
  active: true,
};

export interface RoleSchemaLabels {
  labelEn: string;
  labelFr: string;
  descriptionEn: string;
  descriptionFr: string;
  permissionsTitle: string;
  permissionsHelp: string;
  externalIds: string;
  externalIdsHelp: string;
  active: string;
  selectAll: string;
  clearAll: string;
  editor: { key: string; value: string; addRow: string; removeRow: string };
}

export interface BuildRoleSchemaOpts {
  /** Full list of permission codes (from `roles.permissionCatalog`). */
  catalog: readonly string[];
  /** When true (system roles), the `active` field is rendered read-only. */
  lockActive?: boolean;
  labels: RoleSchemaLabels;
  /** The tenant's active `ExternalIdSource` rows, for the external-IDs sub-form. */
  sources?: readonly ExternalIdSourceOption[];
}

export function buildRoleSchema({
  catalog,
  lockActive,
  labels,
  sources = [],
}: BuildRoleSchemaOpts): {
  schema: RJSFSchema;
  uiSchema: UiSchema;
} {
  // VeloExpense: French only while it is switched on (see the header).
  const frenchOn = ENABLED_LOCALES.includes('fr-CA');
  const schema: RJSFSchema = {
    type: 'object',
    required: frenchOn ? ['labelEn', 'labelFr'] : ['labelEn'],
    properties: {
      labelEn: { type: 'string', title: labels.labelEn, minLength: 1 },
      ...(frenchOn ? { labelFr: { type: 'string', title: labels.labelFr, minLength: 1 } } : {}),
      descriptionEn: { type: 'string', title: labels.descriptionEn },
      ...(frenchOn ? { descriptionFr: { type: 'string', title: labels.descriptionFr } } : {}),
      // Permissions: typed as a `string[]` of permission codes drawn
      // from the catalog. The custom widget below renders the picker
      // chrome — RJSF's default array template would be wrong here.
      permissions: {
        type: 'array',
        title: labels.permissionsTitle,
        items: { type: 'string', enum: [...catalog] },
        uniqueItems: true,
      },
      // externalIds: free-form `Record<string, string>`. The DS
      // ExternalIdsWidget handles the row editor + quick-add chips.
      externalIds: {
        type: 'object',
        title: labels.externalIds,
        additionalProperties: { type: 'string' },
      },
      active: { type: 'boolean', title: labels.active, default: true },
    },
  };

  const uiSchema: UiSchema = {
    'ui:order': [
      'labelEn',
      // VeloExpense: French only while it is switched on.
      ...(frenchOn ? ['labelFr'] : []),
      'descriptionEn',
      ...(frenchOn ? ['descriptionFr'] : []),
      'permissions',
      'externalIds',
      'active',
    ],
    descriptionEn: { 'ui:placeholder': '—' },
    ...(frenchOn ? { descriptionFr: { 'ui:placeholder': '—' } } : {}),
    permissions: {
      'ui:widget': 'permissions',
      'ui:options': {
        catalog,
        help: labels.permissionsHelp,
        selectAllLabel: labels.selectAll,
        clearAllLabel: labels.clearAll,
      },
    },
    externalIds: {
      'ui:widget': 'externalIds',
      'ui:options': {
        // The tenant's OWN systems, passed in by the caller. It used to be a hardcoded
        // list of four names, which offered systems a tenant does not use and could not
        // offer one they had added.
        sources,
        labels: { ...labels.editor, help: labels.externalIdsHelp },
      },
    },
    active: {
      'ui:disabled': Boolean(lockActive),
    },
    // The drawer footer owns the Save button; suppress RJSF's own.
    'ui:submitButtonOptions': { norender: true, submitText: '', props: {} },
  };

  return { schema, uiSchema };
}

// ── PermissionsWidget ────────────────────────────────────────────────

/**
 * Picker for `permissions: string[]`. Buckets the catalog by kebab-
 * prefix module, renders each module as a <Fieldset> with a
 * 2-column grid of `[Checkbox] code` rows + Select-all / Clear
 * actions in the legend.
 *
 * Catalog flows in via `uiSchema['ui:options'].catalog`; selection
 * flows via the standard RJSF `value` / `onChange` props.
 */
export function PermissionsWidget(props: WidgetProps) {
  const { value, disabled, readonly, onChange, options } = props;
  const catalog = (options?.catalog ?? []) as readonly string[];
  const helpText = options?.help as string | undefined;
  const selectAllLabel = (options?.selectAllLabel as string | undefined) ?? 'Select all';
  const clearAllLabel = (options?.clearAllLabel as string | undefined) ?? 'Clear';
  const selected = new Set<string>(Array.isArray(value) ? (value as string[]) : []);
  const isDisabled = Boolean(disabled || readonly);

  // Group the catalog by module — the result is sorted alphabetically
  // by module name; within each group the codes are sorted too.
  const grouped: Array<[string, string[]]> = (() => {
    const map = new Map<string, string[]>();
    for (const code of catalog) {
      const mod = moduleOf(code);
      if (!map.has(mod)) map.set(mod, []);
      map.get(mod)?.push(code);
    }
    for (const list of map.values()) list.sort();
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  })();

  const togglePerm = (code: string) => {
    const next = new Set(selected);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange(Array.from(next).sort());
  };
  const setModulePerms = (mod: string, on: boolean) => {
    const next = new Set(selected);
    for (const code of grouped.find(([m]) => m === mod)?.[1] ?? []) {
      if (on) next.add(code);
      else next.delete(code);
    }
    onChange(Array.from(next).sort());
  };

  return (
    <div className="space-y-3">
      {helpText && <p className="text-muted-foreground text-xs">{helpText}</p>}
      <p className="text-muted-foreground text-xs">
        {selected.size} / {catalog.length}
      </p>
      <div className="space-y-4">
        {grouped.map(([mod, perms]) => {
          const granted = perms.filter((p) => selected.has(p)).length;
          const allGranted = granted === perms.length;
          const noneGranted = granted === 0;
          return (
            <Fieldset
              key={mod}
              title={
                <span>
                  {mod}{' '}
                  <span className="ml-1 font-normal text-muted-foreground text-xs">
                    ({granted} / {perms.length})
                  </span>
                </span>
              }
              actions={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isDisabled || allGranted}
                    onClick={() => setModulePerms(mod, true)}
                  >
                    {selectAllLabel}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isDisabled || noneGranted}
                    onClick={() => setModulePerms(mod, false)}
                  >
                    {clearAllLabel}
                  </Button>
                </>
              }
            >
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {perms.map((p) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox component which renders the input
                  <label
                    key={p}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted"
                  >
                    {/* VeloExpense: named by aria-label — Base UI's checkbox is a span the
                        wrapping <label> does not name, so the box had no accessible name. */}
                    <Checkbox
                      checked={selected.has(p)}
                      disabled={isDisabled}
                      onCheckedChange={() => togglePerm(p)}
                      aria-label={p}
                    />
                    <code className="text-foreground">{p}</code>
                  </label>
                ))}
              </div>
            </Fieldset>
          );
        })}
      </div>
    </div>
  );
}

// biome-ignore lint/suspicious/noExplicitAny: bridge the loose RJSF widget registry to our narrow props
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense: the same exemption for ESLint
export const roleWidgets = { permissions: PermissionsWidget as any };
