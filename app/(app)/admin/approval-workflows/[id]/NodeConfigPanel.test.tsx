// VeloExpense: the registry's default, not a bare tag (scripts/check-i18n.mjs, IL-1).
import { DEFAULT_LOCALE } from '@expenseos/i18n/locales';
import '@testing-library/jest-dom/vitest';
import type { WorkflowNode } from '@expenseos/approvals';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The per-node config panel, which is a router rather than a form.
 *
 * Each node type declares its config as a JSON Schema + UI Schema, and this hands that to
 * the design-system `<SchemaForm>`. Two things it owns, and both are the kind that fail
 * quietly:
 *
 *   · **A node type with no config says so.** Rendering an empty form instead reads as a
 *     form that failed to load, and an admin waits for fields that are not coming.
 *   · **Edits apply live.** There is no submit button — `onChange` merges into the node —
 *     so a panel that dropped the merge would look like it was accepting input while
 *     silently discarding every keystroke.
 */

const h = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));

vi.mock('@expenseos/design-system', () => ({
  SchemaForm: (props: Record<string, unknown>) => {
    h.props = props;
    return <div data-testid="schema-form" />;
  },
}));

import { NodeConfigPanel } from './NodeConfigPanel';

const node = (over: Record<string, unknown> = {}): WorkflowNode =>
  ({ id: 'n-1', type: 'if', ...over }) as WorkflowNode;

const show = (n: WorkflowNode, onChange = vi.fn()) => {
  render(
    <NodeConfigPanel node={n} options={undefined} fields={[]} locale={DEFAULT_LOCALE} onChange={onChange} />,
  );
  return onChange;
};

afterEach(() => {
  h.props = {};
  vi.restoreAllMocks();
});

describe('a node type that has configuration', () => {
  it('renders the schema form', () => {
    show(node({ type: 'if' }));
    expect(screen.getByTestId('schema-form')).toBeInTheDocument();
  });

  it('hands over the node’s own schema and its current config', () => {
    /** The config lives on the node itself (`node.predicate`), not in a nested bag —
     *  `pickConfig` is what flattens each node type into form data. */
    show(node({ type: 'if', predicate: { field: 'amount', op: 'gt', value: '5000' } } as never));
    expect(h.props.schema).toBeTruthy();
    expect(h.props.formData).toMatchObject({ predicate: { field: 'amount' } });
  });

  it('hides the submit button, because edits are live', () => {
    /** A submit button on a panel that already applied the change invites somebody to
     *  press it and wonder whether the first edit counted. */
    show(node({ type: 'if' }));
    const ui = h.props.uiSchema as Record<string, Record<string, unknown>>;
    expect(ui['ui:submitButtonOptions']).toMatchObject({ norender: true });
  });

  it('keeps the node’s own ui:field wiring alongside that', () => {
    /** The custom predicate control is a `ui:field`; overwriting the whole uiSchema to add
     *  the submit option would replace it with a plain object editor. */
    show(node({ type: 'if' }));
    const ui = h.props.uiSchema as Record<string, Record<string, unknown>>;
    expect(ui.predicate?.['ui:field']).toBe('predicate');
  });

  it('merges an edit back onto the node rather than replacing it', () => {
    /**
     * The panel receives only the config slice, so a merge that dropped the node's identity
     * would hand the editor a node with no id — which the graph then cannot place.
     */
    const onChange = show(node({ type: 'if', id: 'n-42' }));
    (h.props.onChange as (d: unknown) => void)({ predicate: { field: 'amount' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const updated = onChange.mock.calls[0][0] as WorkflowNode;
    expect(updated.id).toBe('n-42');
    expect(updated.type).toBe('if');
  });

  it('renders a form for every node type that declares one', () => {
    for (const type of ['if', 'switch', 'approval'] as const) {
      const { unmount } = render(
        <NodeConfigPanel
          node={node({ type })}
          options={undefined}
          fields={[]}
          locale={DEFAULT_LOCALE}
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByTestId('schema-form'), type).toBeInTheDocument();
      unmount();
    }
  });
});

describe('a node type that has none', () => {
  it('says there is no configuration instead of rendering an empty form', () => {
    /** A start node has nothing to set. An empty form reads as one that failed to load. */
    show(node({ type: 'start' }));
    expect(screen.getByText('No configuration.')).toBeInTheDocument();
    expect(screen.queryByTestId('schema-form')).not.toBeInTheDocument();
  });
});
