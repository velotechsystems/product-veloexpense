/**
 * Per-node config registry — the single place that declares a node type's
 * editable config as a JSON Schema + UI Schema. The config panel renders these
 * through the design-system <SchemaForm>; genuinely-custom controls (predicate,
 * approver, switch cases) are wired as `ui:field`s (see schema-fields). Adding a
 * node type means adding one entry here — no edits across the UI.
 */

import type { NodeType, WorkflowNode } from '@expenseos/approvals';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { ACTION_HOOKS } from '@/lib/workflowActionHooks';
import type { EditorOptions } from './options';

export interface NodeConfig {
  schema: RJSFSchema;
  uiSchema: UiSchema;
}

const wrap = (key: string, prop: RJSFSchema): RJSFSchema => ({
  type: 'object',
  properties: { [key]: prop },
});

/** Build the config schema for a node type, or null when it has no config
 *  (start / approved / rejected). Some schemas depend on live `options`
 *  (e.g. the CallWorkflow target list). */
export function buildNodeConfig(
  type: NodeType,
  options: EditorOptions | undefined,
  locale: Locale = 'en',
): NodeConfig | null {
  switch (type) {
    case 'if':
      return {
        schema: wrap('predicate', { type: 'object' }),
        uiSchema: { predicate: { 'ui:field': 'predicate', 'ui:options': { allowAlways: false } } },
      };
    case 'switch':
      // Custom field — the case list mints stable routing ids and renders the
      // recursive predicate; standard JSON-Schema array can't do either well.
      return {
        schema: wrap('cases', { type: 'array' }),
        uiSchema: { cases: { 'ui:field': 'cases' } },
      };
    case 'approval':
      return {
        schema: {
          type: 'object',
          properties: {
            approver: { type: 'object' },
            ttlBusinessDays: {
              type: 'integer',
              title: 'Decision deadline (business days)',
              // VeloExpense (d56): a blank deadline is no deadline (ExpenseOS: the default, 5).
              description: 'Blank = no deadline. Weekends are skipped.',
              minimum: 1,
              maximum: 60,
            },
            onExpire: {
              type: 'string',
              title: 'When the deadline passes',
              enum: ['', 'ESCALATE', 'REJECT', 'APPROVE'],
              enumNames: [
                'Default (manager approvals escalate up the chain, else reject)',
                'Escalate up the manager chain (auto-reject at the top)',
                'Reject the request',
                'Approve the request',
              ],
            },
          },
        } as RJSFSchema,
        uiSchema: {
          'ui:order': ['approver', 'ttlBusinessDays', 'onExpire'],
          approver: { 'ui:field': 'approver' },
        },
      };
    case 'acknowledge':
      return {
        schema: { type: 'object', properties: { approver: { type: 'object' } } } as RJSFSchema,
        uiSchema: { approver: { 'ui:field': 'approver' } },
      };
    case 'notify': {
      const roles = options?.roles ?? [];
      return {
        schema: wrap('target', {
          type: 'object',
          title: 'Recipient',
          required: ['kind'],
          properties: {
            kind: {
              type: 'string',
              title: 'Notify',
              enum: ['requester', 'manager', 'role'],
              enumNames: ['The requester', "The requester's manager", 'A role'],
            },
          },
          dependencies: {
            kind: {
              oneOf: [
                { properties: { kind: { enum: ['requester'] } } },
                { properties: { kind: { enum: ['manager'] } } },
                {
                  properties: {
                    kind: { enum: ['role'] },
                    roleId: {
                      type: 'string',
                      title: 'Role',
                      enum: roles.map((r) => r.id),
                      enumNames: roles.map((r) => String(getLocalized(r.label, locale) ?? r.id)),
                    },
                  },
                  required: ['roleId'],
                },
              ],
            },
          },
        } as RJSFSchema),
        uiSchema: {},
      };
    }
    case 'action':
      // v1 config edits a single action: either write a metadata flag, or run a
      // registered integration hook.
      return {
        schema: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: {
              type: 'string',
              title: 'Action',
              enum: ['setField', 'integration'],
              enumNames: ['Set a metadata field', 'Run an integration'],
            },
          },
          dependencies: {
            mode: {
              oneOf: [
                {
                  properties: {
                    mode: { enum: ['setField'] },
                    key: {
                      type: 'string',
                      title: 'Metadata field',
                      description:
                        "Sets subject.metadata[key] on this step (e.g. 'auditSelected').",
                      maxLength: 64,
                    },
                    value: { type: 'boolean', title: 'Value', default: true },
                  },
                  required: ['key'],
                },
                {
                  properties: {
                    mode: { enum: ['integration'] },
                    hook: {
                      type: 'string',
                      title: 'Integration',
                      enum: ACTION_HOOKS.map((h) => h.value),
                      enumNames: ACTION_HOOKS.map((h) => h.label),
                    },
                  },
                  required: ['hook'],
                },
              ],
            },
          },
        } as RJSFSchema,
        uiSchema: {},
      };
    case 'parallel':
      return {
        schema: wrap('join', {
          type: 'object',
          title: 'Join policy',
          required: ['kind'],
          properties: {
            kind: {
              type: 'string',
              title: 'When',
              enum: ['all', 'any', 'quorum'],
              enumNames: ['All must approve', 'Any one approves', 'Quorum (k of N)'],
            },
          },
          dependencies: {
            kind: {
              oneOf: [
                { properties: { kind: { enum: ['all'] } } },
                { properties: { kind: { enum: ['any'] } } },
                {
                  properties: {
                    kind: { enum: ['quorum'] },
                    k: { type: 'integer', title: 'Quorum (k)', minimum: 1, default: 2 },
                  },
                  required: ['k'],
                },
              ],
            },
          },
        } as RJSFSchema),
        uiSchema: {},
      };
    case 'callWorkflow': {
      const wfs = options?.workflows ?? [];
      return {
        schema: wrap('workflowKey', {
          type: 'string',
          title: 'Sub-workflow',
          description: 'Inlined at start time. A self-/cyclic reference is skipped.',
          enum: wfs.map((w) => w.key),
          enumNames: wfs.map((w) => `${w.name} (${w.key})`),
        } as RJSFSchema),
        uiSchema: { workflowKey: { 'ui:placeholder': 'Select a workflow…' } },
      };
    }
    default:
      return null;
  }
}

/** Extract the editable config subset (the SchemaForm `formData`) from a node. */
export function pickConfig(node: WorkflowNode): Record<string, unknown> {
  switch (node.type) {
    case 'if':
      return { predicate: node.predicate };
    case 'switch':
      return { cases: node.cases };
    case 'approval':
      return {
        approver: node.approver,
        ttlBusinessDays: node.ttlBusinessDays,
        onExpire: node.onExpire ?? '',
      };
    case 'parallel':
      return { join: node.join };
    case 'callWorkflow':
      return { workflowKey: node.workflowKey };
    case 'acknowledge':
      return { approver: node.approver };
    case 'notify':
      return { target: node.target };
    case 'action': {
      const first = node.actions[0];
      if (first?.kind === 'integration') return { mode: 'integration', hook: first.hook };
      if (first?.kind === 'setField') {
        return {
          mode: 'setField',
          key: first.key,
          value: typeof first.value === 'boolean' ? first.value : true,
        };
      }
      return { mode: 'setField', key: '', value: true };
    }
    default:
      return {};
  }
}

/** Merge edited config back onto the node, preserving id/type/position. */
export function mergeConfig(node: WorkflowNode, data: Record<string, unknown>): WorkflowNode {
  const merged = { ...node, ...data } as WorkflowNode;
  if (merged.type === 'approval') {
    // "Default" (empty) onExpire and a blank TTL must stay UNSET so the engine
    // applies its defaults and the graph passes schema validation.
    const m = merged as { onExpire?: unknown; ttlBusinessDays?: unknown };
    if (!m.onExpire) delete m.onExpire;
    if (typeof m.ttlBusinessDays !== 'number' || !(m.ttlBusinessDays > 0)) {
      delete m.ttlBusinessDays;
    }
  }
  if (merged.type === 'notify') {
    // Drop a stale roleId left over from switching away from the 'role' kind, so
    // the discriminated union stays valid.
    const tgt = merged.target as { kind: string; roleId?: unknown };
    if (tgt.kind !== 'role') delete tgt.roleId;
  }
  if (merged.type === 'action') {
    // The form edits a flat { mode, key, value | hook }; rebuild the actions array.
    const m = merged as unknown as {
      mode?: string;
      key?: string;
      value?: boolean;
      hook?: string;
    };
    merged.actions =
      m.mode === 'integration'
        ? [{ kind: 'integration', hook: m.hook ?? '' }]
        : [{ kind: 'setField', key: m.key ?? '', value: m.value ?? true }];
    delete m.mode;
    delete m.key;
    delete m.value;
    delete m.hook;
  }
  return merged;
}
