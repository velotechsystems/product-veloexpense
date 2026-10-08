'use client';

/**
 * RJSF schema generation + adapters for the AdminLookupPage drawer. The drawer
 * form is now a single <SchemaForm>: `buildLookupSchema` turns the per-entity
 * config into a JSON Schema + UI Schema, and the two adapters convert between
 * the RJSF formData shape and the existing `AdminFormState` so the entity
 * wrappers' `buildCreatePayload` / `buildUpdatePayload` stay untouched.
 *
 * `externalIds` is rendered by a custom RJSF field (`ui:field: 'externalIds'`)
 * that wraps the bespoke <ExternalIdsEditor> — RJSF's map widget can't express
 * its quick-add chips, per-system dropdown, dup detection, or custom-key
 * escape hatch.
 *
 * Ported from ExpenseOS (550b2945). VeloExpense: the French name and description are
 * not asked for while French is switched off (`ENABLED_LOCALES`, 7 Oct) — marked below.
 * A French name already saved is carried through the form data untouched.
 */

import { ENABLED_LOCALES } from '@expenseos/i18n/locales';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { ExternalIdsField as ExternalIdsSubform } from '@/components/external-ids/ExternalIdsField';
import type { AdminFormState, ExtraFieldDef } from './AdminLookupPage';
import type { ExternalIdEntry } from './ExternalIdsEditor';

// ── RJSF formData shape — flat, mirrors the schema ────────────────
// Extras live as top-level keys (by field name); externalIds stays an
// entries[] array owned by the custom field.
export type LookupFormData = {
  labelEn: string;
  labelFr: string;
  descriptionEn: string;
  descriptionFr: string;
  externalIds: ExternalIdEntry[];
  active: boolean;
} & Record<string, unknown>;

export interface LookupSchemaLabels {
  labelEn: string;
  labelFr: string;
  descriptionEn: string;
  descriptionFr: string;
  externalIds: string;
  externalIdsHelp: string;
  active: string;
  editor: { key: string; value: string; addRow: string; removeRow: string; help: string };
}

export interface BuildLookupSchemaOpts {
  mode: 'create' | 'edit';
  extraFields?: ExtraFieldDef[];
  labels: LookupSchemaLabels;
}

export function buildLookupSchema({ mode: _mode, extraFields, labels }: BuildLookupSchemaOpts): {
  schema: RJSFSchema;
  uiSchema: UiSchema;
} {
  const properties: NonNullable<RJSFSchema['properties']> = {};
  // VeloExpense: French only while it is switched on (see the header).
  const frenchOn = ENABLED_LOCALES.includes('fr-CA');
  const required: string[] = frenchOn ? ['labelEn', 'labelFr'] : ['labelEn'];
  const uiSchema: UiSchema = {};
  const order: string[] = [];

  properties.labelEn = { type: 'string', title: labels.labelEn, minLength: 1 };
  if (frenchOn) properties.labelFr = { type: 'string', title: labels.labelFr, minLength: 1 };
  properties.descriptionEn = { type: 'string', title: labels.descriptionEn };
  if (frenchOn) properties.descriptionFr = { type: 'string', title: labels.descriptionFr };
  uiSchema.descriptionEn = { 'ui:placeholder': '—' };
  if (frenchOn) uiSchema.descriptionFr = { 'ui:placeholder': '—' };
  if (frenchOn) order.push('labelEn', 'labelFr', 'descriptionEn', 'descriptionFr');
  else order.push('labelEn', 'descriptionEn');

  for (const f of extraFields ?? []) {
    order.push(f.name);
    if (f.required) required.push(f.name);
    if (f.kind.kind === 'boolean') {
      properties[f.name] = { type: 'boolean', title: f.label };
      if (f.kind.help) uiSchema[f.name] = { 'ui:help': f.kind.help };
    } else if (f.kind.kind === 'picker') {
      // A plain string in the schema; the registered widget owns the control.
      properties[f.name] = { type: 'string', title: f.label };
      uiSchema[f.name] = {
        'ui:widget': f.kind.widget,
        ...(f.kind.placeholder ? { 'ui:placeholder': f.kind.placeholder } : {}),
        ...(f.kind.help ? { 'ui:help': f.kind.help } : {}),
      };
    } else if (f.kind.kind === 'select') {
      /**
       * A non-required select carries an explicit EMPTY branch, first.
       *
       * Without one, RJSF selects the first branch for a field nobody touched, so a
       * new department was created parented to whichever department happened to sort
       * first — an org-tree change nobody asked for, on a field that decides approval
       * routing and budget scope. "Not set" has to be a visible, and the default,
       * choice.
       */
      const branches = f.kind.options.map((o) => ({ const: o.value, title: o.label }));
      properties[f.name] = {
        type: 'string',
        title: f.label,
        oneOf: f.required
          ? branches
          : [{ const: '', title: f.kind.placeholder ?? '—' }, ...branches],
      };
      if (f.kind.help) uiSchema[f.name] = { 'ui:help': f.kind.help };
    } else {
      properties[f.name] = {
        type: 'string',
        title: f.label,
        ...(f.required ? { minLength: 1 } : {}),
        ...(f.kind.maxLength ? { maxLength: f.kind.maxLength } : {}),
      };
      uiSchema[f.name] = {
        ...(f.kind.placeholder ? { 'ui:placeholder': f.kind.placeholder } : {}),
        ...(f.kind.help ? { 'ui:help': f.kind.help } : {}),
      };
    }
  }

  properties.externalIds = {
    type: 'array',
    title: labels.externalIds,
    items: { type: 'object', properties: {} },
  };
  uiSchema.externalIds = {
    'ui:field': 'externalIds',
    'ui:options': {
      help: labels.externalIdsHelp,
      editorLabels: labels.editor,
    },
  };
  order.push('externalIds');

  properties.active = { type: 'boolean', title: labels.active, default: true };
  order.push('active');

  uiSchema['ui:order'] = order;
  // The Drawer footer owns the Save button (drives submit via the ref);
  // suppress RJSF's own submit button.
  uiSchema['ui:submitButtonOptions'] = { norender: true, submitText: '', props: {} };

  return {
    schema: { type: 'object', properties, required },
    uiSchema,
  };
}

// ── Adapters ───────────────────────────────────────────────────────

export function adminToRjsf(form: AdminFormState, extraFields?: ExtraFieldDef[]): LookupFormData {
  const extras: Record<string, unknown> = { ...(form.extras ?? {}) };
  // `extras` is a string map, but a boolean field's schema is `type: 'boolean'` —
  // hand RJSF the real thing or it renders an unchecked box for the string
  // `'true'` and then writes `false` back on the first change.
  for (const f of extraFields ?? []) {
    if (f.kind.kind === 'boolean') extras[f.name] = form.extras?.[f.name] === 'true';
  }
  return {
    labelEn: form.labelEn,
    labelFr: form.labelFr,
    descriptionEn: form.descriptionEn,
    descriptionFr: form.descriptionFr,
    externalIds: form.externalIds,
    active: form.active,
    ...extras,
  };
}

export function rjsfToAdmin(
  data: LookupFormData,
  extraFields: ExtraFieldDef[] | undefined,
): AdminFormState {
  const extras: Record<string, string> = {};
  for (const f of extraFields ?? []) {
    const raw = data[f.name];
    // A boolean field arrives as a real boolean and an unchecked box arrives as
    // undefined — which has to read as `false`, not as "unset", or clearing the
    // box would silently keep the old value.
    if (f.kind.kind === 'boolean') {
      extras[f.name] = raw === true ? 'true' : 'false';
      continue;
    }
    const str = raw == null ? '' : String(raw);
    extras[f.name] =
      (f.kind.kind === 'text' && f.kind.uppercase) || f.kind.kind === 'picker'
        ? str.toUpperCase()
        : str;
  }
  return {
    labelEn: data.labelEn ?? '',
    labelFr: data.labelFr ?? '',
    descriptionEn: data.descriptionEn ?? '',
    descriptionFr: data.descriptionFr ?? '',
    externalIds: Array.isArray(data.externalIds) ? data.externalIds : [],
    active: data.active !== false,
    extras,
  };
}

// ── Custom RJSF field: External IDs ─────────────────────────────────
// A custom field replaces the whole SchemaField render for `externalIds`,
// so it owns its own Field label + the bespoke editor. Props are typed
// loosely to avoid a hard @rjsf/utils dependency in app code.

interface ExternalIdsFieldProps {
  formData?: ExternalIdEntry[];
  onChange: (value: ExternalIdEntry[]) => void;
  uiSchema?: {
    'ui:options'?: {
      help?: string;
      editorLabels?: {
        key: string;
        value: string;
        addRow: string;
        removeRow: string;
        help: string;
      };
    };
  };
  schema?: { title?: string };
}

export function ExternalIdsField(props: ExternalIdsFieldProps) {
  const { formData, onChange } = props;
  // No inner <Field> wrapper here — the surrounding FieldTemplate already renders the
  // schema-derived "External IDs" label. Adding another produced a visible duplicate.
  //
  // Labels and the system list come from the shared sub-form rather than from
  // `ui:options`, so every external-IDs control in the product reads the same and offers
  // the tenant's OWN sources instead of a hardcoded list of four names.
  return (
    <ExternalIdsSubform entries={Array.isArray(formData) ? formData : []} onChange={onChange} />
  );
}

// biome-ignore lint/suspicious/noExplicitAny: bridge the loose RJSF field registry to our narrow props
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense: the same exemption for ESLint
export const lookupFields = { externalIds: ExternalIdsField as any };
