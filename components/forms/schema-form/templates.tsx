'use client';

/**
 * RJSF templates that lay out fields with design-system styling.
 *
 * Anatomy contract:
 *   - Every non-object field (text/number/boolean/array/etc.) renders
 *     inside <Field>. Field owns the label, required marker, tooltip
 *     "?", description, errors, and hints — one canonical anatomy
 *     across the entire form layer.
 *   - Objects render inside <Fieldset> (semantic group with title,
 *     description, tooltip, group-level errors, optional collapse).
 *   - Array items render inline (no per-item Field/Fieldset wrap from
 *     these templates); array-of-object items get wrapped by
 *     ArrayFieldTemplate itself so it can pass `actions={removeX}` into
 *     Fieldset's legend slot.
 *   - Boolean controls use Field's `controlPosition='inline-leading'`
 *     so the checkbox renders BEFORE the label text on a shared row
 *     while still inheriting the full Field anatomy (description /
 *     tooltip / errors below).
 */

import {
  type ArrayFieldTemplateProps,
  type BaseInputTemplateProps,
  type DescriptionFieldProps,
  type FieldTemplateProps,
  getInputProps,
  getSubmitButtonOptions,
  type ObjectFieldTemplateProps,
  type SubmitButtonProps,
} from '@rjsf/utils';
import { createContext, Fragment, type ReactNode, useContext } from 'react';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { DescriptionText } from '@/components/ui/description-text';
import { Input } from '@/components/ui/input';
import { Fieldset } from '../Fieldset';
import { AlignedFields, Field } from '../field/Field';
import { NumberStepper } from '../NumberStepper';
import { useSchemaFormConfig } from './context';

/**
 * Set by ArrayFieldTemplate around each rendered item, so the inner
 * ObjectFieldTemplate knows to render its properties flat (no <Fieldset>
 * wrap of its own) — the array template owns the Fieldset wrap so it
 * can plumb the remove "X" through `actions`.
 */
const ArrayItemContext = createContext(false);

/**
 * The single entry point every text-family widget (text/email/url/tel/number/
 * password) renders through. Theming it once styles them all via the
 * design-system Input. Number/integer values are coerced so form data stays
 * numeric.
 */
export function BaseInputTemplate(props: BaseInputTemplateProps) {
  const {
    id,
    value,
    required,
    disabled,
    readonly,
    onChange,
    onBlur,
    onFocus,
    options,
    schema,
    placeholder,
    type,
  } = props;
  const inputProps = getInputProps(schema, type, options);
  const isNumber =
    inputProps.type === 'number' || schema.type === 'number' || schema.type === 'integer';

  // Auto-promote bounded numbers to NumberStepper: when the schema
  // declares either `minimum` or `maximum`, the field reads as a
  // bounded quantity, and the ±buttons give a faster affordance than
  // free-typing. Callers can opt out by setting `'ui:widget'` to
  // anything else — that path routes through the widget registry
  // before reaching here, so this template never runs for it.
  if (isNumber && (typeof schema.minimum === 'number' || typeof schema.maximum === 'number')) {
    const num =
      typeof value === 'number' ? value : value === '' || value == null ? undefined : Number(value);
    return (
      <NumberStepper
        id={id}
        value={num}
        onValueChange={(v) => onChange(v ?? undefined)}
        min={typeof schema.minimum === 'number' ? schema.minimum : undefined}
        max={typeof schema.maximum === 'number' ? schema.maximum : undefined}
        step={typeof schema.multipleOf === 'number' ? schema.multipleOf : 1}
        disabled={disabled || readonly}
        required={required}
      />
    );
  }

  return (
    <Input
      id={id}
      {...inputProps}
      value={value ?? ''}
      required={required}
      disabled={disabled || readonly}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(options.emptyValue ?? undefined);
        if (isNumber) {
          const n = Number(raw);
          return onChange(Number.isNaN(n) ? raw : n);
        }
        onChange(raw);
      }}
      onBlur={(e) => onBlur(id, e.target.value)}
      onFocus={(e) => onFocus(id, e.target.value)}
    />
  );
}

export function DescriptionFieldTemplate({ description }: DescriptionFieldProps) {
  if (!description) return null;
  return <DescriptionText>{description}</DescriptionText>;
}

export function FieldTemplate(props: FieldTemplateProps) {
  const { id, label, required, description, rawErrors, children, hidden, displayLabel, schema } =
    props;
  const { inline: formInline } = useSchemaFormConfig();
  if (hidden) return <div className="hidden">{children}</div>;

  // Objects own their own chrome (Fieldset, rendered by
  // ObjectFieldTemplate). FieldTemplate stays out of their way to avoid
  // a Field+Fieldset double-wrap.
  if (schema.type === 'object') return <>{children}</>;

  const isBoolean = schema.type === 'boolean';
  const isArray = schema.type === 'array';
  // Array items get ids like `root_allowedDomains_0`. They render
  // without a per-item label — the surrounding array's Field already
  // provides the group label, and array items are anonymous.
  const isArrayItem = /_\d+$/.test(id);
  // Booleans and arrays always show their label here: RJSF defaults
  // `displayLabel` to false for both (legacy: the checkbox widget
  // owned its own label inline, and the array template rendered its
  // own title). Now that Field renders the label for all leaf and
  // array fields, suppressing it would strip the question text /
  // group title. Plain primitives (string/number/etc.) still respect
  // `displayLabel` so `'ui:options': { label: false }` continues to
  // work for them.
  const hideLabel = isArrayItem || !label || (!isBoolean && !isArray && displayLabel === false);

  // RJSF delegates to the canonical Field anatomy — the same one
  // hand-built forms use. The `ui:help` directive surfaces as Field's
  // tooltip ("?" icon).
  const tooltip = props.uiSchema?.['ui:help'] as ReactNode | undefined;

  // Prefix the field label to ajv messages so errors read as full
  // sentences ("Email must be a valid email address" vs "must be a
  // valid email address").
  const errors =
    rawErrors && typeof label === 'string' && label
      ? rawErrors.map((e) => (e.startsWith(label) ? e : `${label} ${e}`))
      : (rawErrors ?? undefined);

  // Inline-form mode applies to every primitive leaf field — arrays
  // stay stacked because their body (rows + Add button) doesn't fit a
  // label/control split. Booleans DO participate in inline mode: their
  // label lands in the shared label column and the checkbox lands in
  // the control column, just like any other field. Only the stacked
  // boolean falls back to the leading-control layout (`[box] label`).
  const inline = formInline && !isArray;
  const controlPosition: 'block' | 'inline-leading' =
    !inline && isBoolean ? 'inline-leading' : 'block';

  return (
    <Field
      htmlFor={id}
      label={label}
      required={required}
      hideLabel={hideLabel}
      description={!isArrayItem ? description : undefined}
      tooltip={tooltip}
      errors={errors}
      inline={inline}
      controlPosition={controlPosition}
    >
      {children}
    </Field>
  );
}

export function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const { title, description, properties, idSchema, uiSchema } = props;
  const isRoot = idSchema?.$id === 'root';
  // Hooks must be called unconditionally — read the form config once at
  // the top, then branch on `inline` only inside the root path that uses it.
  const { inline: formInline } = useSchemaFormConfig();
  // Set by ArrayFieldTemplate around each rendered item (see below).
  const inArrayItem = useContext(ArrayItemContext);

  // Per-schema controls (read from `ui:options`):
  //   fieldset?: boolean       — when `false`, render the group as a
  //                              plain <div> with NO fieldset semantics
  //                              and NO border. Use for groupings that
  //                              exist only for schema validation
  //                              purposes (no semantic group meaning).
  //   variant?: 'card'|'flat'  — when fieldset is on, controls the
  //                              visual chrome. 'card' (default) has
  //                              border+padding; 'flat' is borderless
  //                              but still emits <fieldset>/<legend>.
  //   collapsible?: boolean    — title row becomes a chevron toggle.
  //   defaultCollapsed?: bool  — initial collapsed state when collapsible.
  //   hideDescriptionWhenCollapsed?: boolean — hide description in the
  //                              collapsed state (default: keep it).
  const uiOpts = (uiSchema?.['ui:options'] ?? {}) as {
    fieldset?: boolean;
    variant?: 'card' | 'flat';
    collapsible?: boolean;
    defaultCollapsed?: boolean;
    hideDescriptionWhenCollapsed?: boolean;
  };
  const tooltip = uiSchema?.['ui:help'] as ReactNode | undefined;
  // RJSF surfaces object-level validation in __errors. Map onto
  // Fieldset.errors so the group's problems read the same as a leaf
  // field's problems.
  const rawErrors = (props as { errorSchema?: { __errors?: string[] } }).errorSchema?.__errors;
  const groupErrors = Array.isArray(rawErrors) && rawErrors.length > 0 ? rawErrors : undefined;

  // Array items render their object body flat — ArrayFieldTemplate has
  // already wrapped each item in its own Fieldset so it could attach
  // the remove "X" via `actions`. Rendering another Fieldset here would
  // double the chrome.
  if (inArrayItem) {
    return (
      <div className="space-y-4">
        {properties.map((p) => (
          <div key={p.name}>{p.content}</div>
        ))}
      </div>
    );
  }

  // Schemas can opt OUT of fieldset semantics entirely (no <fieldset>
  // tag, no border, no chrome) when a nested object is purely a
  // structural grouping (e.g. JSON Schema `dependencies` artifacts).
  if (uiOpts.fieldset === false) {
    return (
      <div className="space-y-4">
        {title && <div className="font-semibold text-foreground text-sm">{title}</div>}
        {description ? <DescriptionText>{description}</DescriptionText> : null}
        {properties.map((p) => (
          <div key={p.name}>{p.content}</div>
        ))}
      </div>
    );
  }

  // Root object stays flat — its title acts as the form heading, not a
  // group legend, and a card-in-card at the top level reads as visual
  // weight without purpose. When the form is in inline mode, wrap the
  // properties in <AlignedFields> so every primitive Field's label
  // lands in the same shared column.
  if (isRoot) {
    // In inline mode the properties render directly into <AlignedFields>'
    // CSS grid as cell fragments (label cell + control cell per row), so
    // wrapping each one in a <div> would break the grid contract. Use
    // Fragment to keep the keyed render without inserting block boxes.
    const body = properties.map((p) => <Fragment key={p.name}>{p.content}</Fragment>);
    // Uniform `space-y-4` (16px) between siblings at every level —
    // root, inside Fieldset bodies, between array items. Consistent
    // rhythm across the form. `mx-0` on Fieldset (rather than `m-0`)
    // ensures the parent's margin is actually applied to fieldset
    // siblings — earlier the reset zeroed it and cards glued.
    return (
      <div className="space-y-4">
        {title && <div className="font-semibold text-foreground text-sm">{title}</div>}
        {description ? <DescriptionText>{description}</DescriptionText> : null}
        {formInline ? <AlignedFields>{body}</AlignedFields> : body}
      </div>
    );
  }

  return (
    <Fieldset
      title={title}
      description={description}
      tooltip={tooltip}
      errors={groupErrors}
      variant={uiOpts.variant === 'flat' ? 'flat' : 'card'}
      collapsible={uiOpts.collapsible === true}
      defaultCollapsed={uiOpts.defaultCollapsed === true}
      hideDescriptionWhenCollapsed={uiOpts.hideDescriptionWhenCollapsed === true}
    >
      {properties.map((p) => (
        <div key={p.name}>{p.content}</div>
      ))}
    </Fieldset>
  );
}

export function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { items, canAdd, onAddClick } = props;
  // Field (rendered by the wrapping FieldTemplate) already owns the
  // title, required marker, description, and array-level errors.
  // ArrayFieldTemplate is just the body: a list of rows + an Add
  // button. Remove buttons across BOTH primitive items and object
  // items use the same `ghost + trash icon` affordance — same control
  // surface as Fieldset's `actions` slot. This keeps "remove" reading
  // identically whether the item is a single field or a card.
  // Use the tightest `icon-xs` (24px) for the in-legend / inline-row
  // trash action — the affordance reads as a marginal control, not a
  // primary action, so it should sit out of the way of field content.
  // Same icon-ghost recipe across primitive items and object items.
  const removeBtn = (onClick: () => void) => (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={onClick}
      aria-label="Remove"
      title="Remove"
    >
      <IconTrash size={14} />
    </Button>
  );

  // Tighter rhythm between primitive items (single-row inputs) than
  // between object items (Fieldset cards): primitive arrays read as a
  // dense list (8px between rows), while cards need 16px breathing
  // room so their borders don't glue together. The Add button always
  // sits 8px below the last item — a tight visual anchor to the list,
  // not a sibling field competing for space.
  const allPrimitive = items.length > 0 && items.every((el) => el.schema?.type !== 'object');
  const itemSpacing = allPrimitive ? 'space-y-2' : 'space-y-4';
  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <div className={itemSpacing}>
          {items.map((el) => {
            const isObjectItem = el.schema?.type === 'object';
            // Object items render as a bordered Fieldset card with the
            // remove "trash" pinned into Fieldset's legend `actions` slot.
            // ArrayItemContext tells the inner ObjectFieldTemplate to
            // render flat (no nested Fieldset).
            if (isObjectItem) {
              return (
                <ArrayItemContext.Provider key={el.key} value={true}>
                  <Fieldset
                    variant="card"
                    actions={el.hasRemove ? removeBtn(el.onDropIndexClick(el.index)) : null}
                  >
                    {el.children}
                  </Fieldset>
                </ArrayItemContext.Provider>
              );
            }
            // Primitive items render inline next to the same trash button.
            return (
              <div key={el.key} className="flex items-center gap-2">
                <div className="flex-1">{el.children}</div>
                {el.hasRemove && removeBtn(el.onDropIndexClick(el.index))}
              </div>
            );
          })}
        </div>
      )}
      {canAdd && (
        <Button type="button" variant="outline" onClick={onAddClick} className="w-full">
          <IconPlus size={14} className="mr-1" />
          Add
        </Button>
      )}
    </div>
  );
}

function SubmitButton(props: SubmitButtonProps) {
  const { norender, submitText } = getSubmitButtonOptions(props.uiSchema);
  if (norender) return null;
  return <Button type="submit">{submitText}</Button>;
}

export const templates = {
  BaseInputTemplate,
  FieldTemplate,
  ObjectFieldTemplate,
  ArrayFieldTemplate,
  DescriptionFieldTemplate,
  ButtonTemplates: { SubmitButton },
};
