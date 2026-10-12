'use client';

import type { PredicateField, WorkflowNode } from '@expenseos/approvals';
/**
 * Per-node configuration panel — schema-driven. Each node type declares its
 * config as a JSON Schema + UI Schema (see node-config-schemas); this panel
 * renders that through the design-system <SchemaForm>, so the form inherits the
 * design system (inputs, selects, validation, layout). Custom controls
 * (predicate / approver / switch cases) are RJSF `ui:field`s (see schema-fields).
 * Edits apply live via onChange — there's no submit button.
 */
import { SchemaForm } from '@expenseos/design-system';
import type { Locale } from '@expenseos/i18n/locales';
import { NodeConfigProvider } from './node-config-context';
import { buildNodeConfig, mergeConfig, pickConfig } from './node-config-schemas';
import type { EditorOptions } from './options';
import { NODE_CONFIG_FIELDS } from './schema-fields';

export function NodeConfigPanel({
  node,
  options,
  fields,
  locale,
  onChange,
}: {
  node: WorkflowNode;
  options: EditorOptions | undefined;
  fields: PredicateField[];
  locale: Locale;
  onChange: (node: WorkflowNode) => void;
}) {
  const cfg = buildNodeConfig(node.type, options, locale);
  if (!cfg) {
    return <p className="text-muted-foreground text-xs">No configuration.</p>;
  }

  return (
    <NodeConfigProvider value={{ options, fields, locale }}>
      <SchemaForm<Record<string, unknown>>
        schema={cfg.schema}
        uiSchema={{
          ...cfg.uiSchema,
          'ui:submitButtonOptions': { norender: true, submitText: '', props: {} },
        }}
        // biome-ignore lint/suspicious/noExplicitAny: RJSF field registry is loosely typed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense: the same waiver for eslint.
        fields={NODE_CONFIG_FIELDS as any}
        formData={pickConfig(node)}
        onChange={(data) => onChange(mergeConfig(node, data))}
        onSubmit={() => {}}
      />
    </NodeConfigProvider>
  );
}
