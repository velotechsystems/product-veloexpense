'use client';

/**
 * <SchemaForm> — the themed RJSF entry point. Renders a JSON Schema through
 * design-system widgets/templates and validates with the shared ajv validator.
 * Presentation-only: localize schema titles/descriptions upstream before
 * passing them in (this component stays app- and i18n-agnostic).
 *
 * Submission: pass `children` (e.g. a footer Save button of type="submit") to
 * replace the default button, or drive it imperatively via the ref's
 * `submit()` when the action lives outside the form (e.g. a Drawer footer).
 */

import { type IChangeEvent, withTheme } from '@rjsf/core';
import type { FieldProps, RJSFSchema, UiSchema, WidgetProps } from '@rjsf/utils';
import {
  type ComponentType,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { SchemaFormConfigContext } from './context';
import { templates } from './templates';
import { validator } from './validator';
import { widgets } from './widgets';

const ThemedForm = withTheme({ widgets, templates });

export interface SchemaFormHandle {
  /** Programmatically submit (runs validation, fires onSubmit on success). */
  submit: () => void;
}

export interface SchemaFormProps<T = unknown> {
  schema: RJSFSchema;
  uiSchema?: UiSchema;
  formData?: T;
  disabled?: boolean;
  idPrefix?: string;
  onChange?: (data: T) => void;
  onSubmit: (data: T) => void;
  /** Extra widgets merged over the design-system defaults (keyed by the
   *  name referenced in `ui:widget`). For app-specific controls. */
  // biome-ignore lint/suspicious/noExplicitAny: RJSF widget registry is loosely typed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense kit: the same exemption for ESLint
  widgets?: Record<string, ComponentType<WidgetProps<any>>>;
  /** Custom fields, referenced by `ui:field`. A custom field replaces the
   *  whole SchemaField rendering (including the field template) for that
   *  property — use it for controls that own their own label + layout. */
  // biome-ignore lint/suspicious/noExplicitAny: RJSF field registry is loosely typed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense kit: the same exemption for ESLint
  fields?: Record<string, ComponentType<FieldProps<any>>>;
  /**
   * Render every primitive Field in inline layout (label/control
   * side-by-side, shared label column) instead of the default stacked
   * layout. Containers (Fieldset / array body) still stack their
   * children — only leaf fields adopt the inline layout. Use for
   * dense "settings"-style forms with many short labels.
   */
  inline?: boolean;
  /** Replaces the default submit button. Omit to render RJSF's default. */
  children?: ReactNode;
}

function SchemaFormInner<T>(
  {
    schema,
    uiSchema,
    formData,
    disabled,
    idPrefix,
    onChange,
    onSubmit,
    widgets: extraWidgets,
    fields,
    inline,
    children,
  }: SchemaFormProps<T>,
  ref: React.Ref<SchemaFormHandle>,
) {
  // biome-ignore lint/suspicious/noExplicitAny: @rjsf Form instance type isn't exported cleanly
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense kit: the same exemption for ESLint
  const formRef = useRef<any>(null);
  useImperativeHandle(ref, () => ({
    submit: () => formRef.current?.submit(),
  }));
  const configValue = useMemo(() => ({ inline: Boolean(inline) }), [inline]);

  // ThemedForm defaults its generics to `any`; we keep the typed
  // surface on SchemaFormProps<T> and cast formData in/out at this
  // boundary only. The `inline` flag is exposed to templates via the
  // config context (read by FieldTemplate for per-field layout and by
  // ObjectFieldTemplate's root branch to wrap the form body in
  // <AlignedFields> so labels share a column).
  return (
    <SchemaFormConfigContext.Provider value={configValue}>
      <ThemedForm
        ref={formRef}
        className="space-y-6"
        schema={schema}
        uiSchema={uiSchema}
        formData={formData}
        disabled={disabled}
        idPrefix={idPrefix}
        widgets={extraWidgets}
        fields={fields}
        validator={validator}
        showErrorList={false}
        noHtml5Validate
        onChange={(e: IChangeEvent) => onChange?.(e.formData as T)}
        onSubmit={(e: IChangeEvent) => onSubmit(e.formData as T)}
        // Errors surface inline via the field template; suppress RJSF's
        // default onError, which console.errors on every failed submit
        // (noise + trips the Next.js dev error overlay).
        onError={() => {}}
      >
        {children}
      </ThemedForm>
    </SchemaFormConfigContext.Provider>
  );
}

export const SchemaForm = forwardRef(SchemaFormInner) as <T>(
  props: SchemaFormProps<T> & { ref?: React.Ref<SchemaFormHandle> },
) => React.ReactElement;
