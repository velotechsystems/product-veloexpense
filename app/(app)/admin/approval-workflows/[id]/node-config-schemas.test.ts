import type { WorkflowNode } from '@expenseos/approvals';
import type { RJSFSchema } from '@rjsf/utils';
import { describe, expect, it } from 'vitest';
import { buildNodeConfig, mergeConfig, pickConfig } from './node-config-schemas';
import type { EditorOptions } from './options';

/**
 * The per-node config registry: what each node type lets you edit, how the node is
 * read into the form, and how the form is written back.
 *
 * The write-back is where the danger is. The graph is validated against a schema on
 * save, and a discriminated union with a leftover key from the branch you switched
 * AWAY from fails that validation — after the author has laid the whole graph out.
 * Three cases carry that risk and all three are pinned:
 *
 *   · an **approval** whose deadline was left on "Default" must send NO `onExpire`,
 *     not an empty string, or the engine has nothing to fall back to;
 *   · a **notify** switched off "A role" must not keep the role it used to point at;
 *   · an **action** is edited as a flat form and stored as an array, so the flat keys
 *     have to be stripped as the array is rebuilt.
 */

const OPTIONS = {
  jobLevels: [],
  departments: [],
  legalEntities: [],
  businessUnits: [],
  currencies: [],
  vendors: [],
  workflows: [
    { key: 'vcc-standard', name: 'Card requests' },
    { key: 'exp-standard', name: 'Expense reports' },
  ],
  roles: [
    { id: 'role-1', label: { en: 'Controller', 'fr-CA': 'Contrôleur' } },
    { id: 'role-2', label: { en: 'Approver' } },
  ],
  categories: [],
} as unknown as EditorOptions;

const props = (s: RJSFSchema | undefined) =>
  (s?.properties ?? {}) as Record<string, Record<string, unknown>>;

// ── buildNodeConfig ───────────────────────────────────────────────────────────

describe('buildNodeConfig', () => {
  it('gives structural nodes no config panel at all', () => {
    // An empty form reads as a panel that failed to load; null renders nothing.
    for (const type of ['start', 'approved', 'rejected'] as const) {
      expect(buildNodeConfig(type as WorkflowNode['type'], OPTIONS)).toBeNull();
    }
  });

  it('routes the IF predicate through the custom field, with Always disallowed', () => {
    /**
     * An IF whose condition is "always" routes every subject down one side, which is
     * not a branch — it is a straight line with an extra box.
     */
    const cfg = buildNodeConfig('if', OPTIONS);
    expect(cfg?.uiSchema.predicate).toMatchObject({
      'ui:field': 'predicate',
      'ui:options': { allowAlways: false },
    });
  });

  it('hands the switch case list to its own field rather than a generic array', () => {
    // The case list mints the stable routing ids the edges point at.
    expect(buildNodeConfig('switch', OPTIONS)?.uiSchema.cases).toMatchObject({
      'ui:field': 'cases',
    });
  });

  it('bounds an approval deadline to a workable range', () => {
    const p = props(buildNodeConfig('approval', OPTIONS)?.schema).ttlBusinessDays;
    expect(p).toMatchObject({ type: 'integer', minimum: 1, maximum: 60 });
  });

  it('offers a blank expiry choice, so “the engine decides” is selectable', () => {
    /**
     * Without the empty option the author can only pick a concrete outcome, and the
     * "manager approvals escalate, everything else rejects" default becomes
     * unreachable from the editor.
     */
    const p = props(buildNodeConfig('approval', OPTIONS)?.schema).onExpire;
    expect(p.enum).toEqual(['', 'ESCALATE', 'REJECT', 'APPROVE']);
    expect((p.enumNames as string[])[0]).toMatch(/Default/);
  });

  it('puts the approver before its deadline in the form', () => {
    // Who decides comes before how long they have.
    expect(buildNodeConfig('approval', OPTIONS)?.uiSchema['ui:order']).toEqual([
      'approver',
      'ttlBusinessDays',
      'onExpire',
    ]);
  });

  it('gives an acknowledgement an approver and no deadline', () => {
    // Nothing is waiting on it, so there is nothing for a deadline to release.
    const cfg = buildNodeConfig('acknowledge', OPTIONS);
    expect(Object.keys(props(cfg?.schema))).toEqual(['approver']);
  });

  it('builds the notify role list from the live options, localized', () => {
    const target = props(buildNodeConfig('notify', OPTIONS)?.schema).target as RJSFSchema & {
      dependencies: { kind: { oneOf: RJSFSchema[] } };
    };
    const roleBranch = target.dependencies.kind.oneOf[2];
    const roleId = props(roleBranch).roleId;
    expect(roleId.enum).toEqual(['role-1', 'role-2']);
    expect(roleId.enumNames).toEqual(['Controller', 'Approver']);
    expect(roleBranch.required).toEqual(['roleId']);
  });

  it('survives options that have not loaded yet', () => {
    // The panel opens before the option query resolves; an empty list is not a crash.
    const target = props(buildNodeConfig('notify', undefined)?.schema).target as RJSFSchema & {
      dependencies: { kind: { oneOf: RJSFSchema[] } };
    };
    expect(props(target.dependencies.kind.oneOf[2]).roleId.enum).toEqual([]);
    expect(props(buildNodeConfig('callWorkflow', undefined)?.schema).workflowKey.enum).toEqual([]);
  });

  it('offers the two action modes and the registered hooks', () => {
    const cfg = buildNodeConfig('action', OPTIONS);
    expect(props(cfg?.schema).mode.enum).toEqual(['setField', 'integration']);
    const oneOf = (cfg?.schema as { dependencies: { mode: { oneOf: RJSFSchema[] } } }).dependencies
      .mode.oneOf;
    expect(props(oneOf[0]).key).toMatchObject({ maxLength: 64 });
    expect(oneOf[0].required).toEqual(['key']);
    expect(props(oneOf[1]).hook.enum).toEqual(['audit.log']);
    expect(oneOf[1].required).toEqual(['hook']);
  });

  it('requires a quorum size only for a quorum join', () => {
    /**
     * "k of N" is meaningless without k, and demanding it for `all` / `any` would
     * block a save on a field the author never sees.
     */
    const join = props(buildNodeConfig('parallel', OPTIONS)?.schema).join as RJSFSchema & {
      dependencies: { kind: { oneOf: RJSFSchema[] } };
    };
    const [all, any, quorum] = join.dependencies.kind.oneOf;
    expect(all.required).toBeUndefined();
    expect(any.required).toBeUndefined();
    expect(quorum.required).toEqual(['k']);
    expect(props(quorum).k).toMatchObject({ minimum: 1, default: 2 });
  });

  it('names a sub-workflow by both its label and its key', () => {
    // Two workflows can carry the same name; the key is what the graph stores.
    const p = props(buildNodeConfig('callWorkflow', OPTIONS)?.schema).workflowKey;
    expect(p.enum).toEqual(['vcc-standard', 'exp-standard']);
    expect(p.enumNames).toEqual(['Card requests (vcc-standard)', 'Expense reports (exp-standard)']);
  });
});

// ── pickConfig ────────────────────────────────────────────────────────────────

describe('pickConfig', () => {
  it('reads each node type’s own config out', () => {
    expect(
      pickConfig({ id: 'n', type: 'if', predicate: { always: true } } as WorkflowNode),
    ).toEqual({ predicate: { always: true } });
    expect(
      pickConfig({ id: 'n', type: 'switch', cases: [{ id: 'c1' }] } as unknown as WorkflowNode),
    ).toEqual({ cases: [{ id: 'c1' }] });
    expect(
      pickConfig({ id: 'n', type: 'parallel', join: { kind: 'any' } } as WorkflowNode),
    ).toEqual({ join: { kind: 'any' } });
    expect(pickConfig({ id: 'n', type: 'callWorkflow', workflowKey: 'k' } as WorkflowNode)).toEqual(
      { workflowKey: 'k' },
    );
    expect(
      pickConfig({ id: 'n', type: 'notify', target: { kind: 'requester' } } as WorkflowNode),
    ).toEqual({ target: { kind: 'requester' } });
  });

  it('presents an unset expiry as the blank “default” choice', () => {
    // `undefined` would leave the select with nothing selected at all.
    expect(
      pickConfig({ id: 'n', type: 'approval', approver: { kind: 'manager' } } as WorkflowNode),
    ).toEqual({ approver: { kind: 'manager' }, ttlBusinessDays: undefined, onExpire: '' });
  });

  it('flattens an integration action into the form’s shape', () => {
    expect(
      pickConfig({
        id: 'n',
        type: 'action',
        actions: [{ kind: 'integration', hook: 'audit.log' }],
      } as WorkflowNode),
    ).toEqual({ mode: 'integration', hook: 'audit.log' });
  });

  it('flattens a metadata action, defaulting a non-boolean value to true', () => {
    expect(
      pickConfig({
        id: 'n',
        type: 'action',
        actions: [{ kind: 'setField', key: 'auditSelected', value: 'yes' }],
      } as unknown as WorkflowNode),
    ).toEqual({ mode: 'setField', key: 'auditSelected', value: true });
  });

  it('opens an action node with no actions on a blank metadata write', () => {
    // Rather than a form with no mode selected, which cannot be submitted.
    expect(pickConfig({ id: 'n', type: 'action', actions: [] } as WorkflowNode)).toEqual({
      mode: 'setField',
      key: '',
      value: true,
    });
  });

  it('reads nothing out of a structural node', () => {
    expect(pickConfig({ id: 'n', type: 'start' } as WorkflowNode)).toEqual({});
  });
});

// ── mergeConfig ───────────────────────────────────────────────────────────────

describe('mergeConfig', () => {
  it('keeps identity and layout while replacing config', () => {
    const node = {
      id: 'n1',
      type: 'if',
      position: { x: 5, y: 6 },
      predicate: { always: true },
    } as unknown as WorkflowNode;
    expect(mergeConfig(node, { predicate: { field: 'amount', op: 'gte', value: 1 } })).toEqual({
      id: 'n1',
      type: 'if',
      position: { x: 5, y: 6 },
      predicate: { field: 'amount', op: 'gte', value: 1 },
    });
  });

  it('drops a “default” expiry rather than storing an empty string', async () => {
    /**
     * `onExpire: ''` is not a valid member of the union, so the graph would fail
     * validation on save — and if it did save, the engine would have no default to
     * fall back to.
     */
    const merged = mergeConfig(
      { id: 'n', type: 'approval', approver: { kind: 'manager' } } as WorkflowNode,
      { approver: { kind: 'manager' }, onExpire: '', ttlBusinessDays: undefined },
    );
    expect(merged).not.toHaveProperty('onExpire');
    expect(merged).not.toHaveProperty('ttlBusinessDays');
  });

  it('keeps a real deadline and a real expiry action', () => {
    const merged = mergeConfig(
      { id: 'n', type: 'approval', approver: { kind: 'manager' } } as WorkflowNode,
      { approver: { kind: 'manager' }, onExpire: 'REJECT', ttlBusinessDays: 3 },
    );
    expect(merged).toMatchObject({ onExpire: 'REJECT', ttlBusinessDays: 3 });
  });

  it('drops a deadline that is not a usable number', () => {
    // A blank number input hands back '' or 0; either would expire immediately.
    for (const ttl of ['', 0, -1, Number.NaN, null]) {
      const merged = mergeConfig(
        { id: 'n', type: 'approval', approver: { kind: 'manager' } } as WorkflowNode,
        { approver: { kind: 'manager' }, ttlBusinessDays: ttl },
      );
      expect(merged).not.toHaveProperty('ttlBusinessDays');
    }
  });

  it('drops a role left behind by switching the notify target away from it', async () => {
    /**
     * The stale key makes the target match no branch of the union, so the save is
     * rejected with an error about a node the author has already finished editing.
     */
    const merged = mergeConfig(
      { id: 'n', type: 'notify', target: { kind: 'role', roleId: 'role-1' } } as WorkflowNode,
      { target: { kind: 'manager', roleId: 'role-1' } },
    );
    expect(merged.type === 'notify' && merged.target).toEqual({ kind: 'manager' });
  });

  it('keeps the role when the target really is a role', () => {
    const merged = mergeConfig(
      { id: 'n', type: 'notify', target: { kind: 'requester' } } as WorkflowNode,
      { target: { kind: 'role', roleId: 'role-2' } },
    );
    expect(merged.type === 'notify' && merged.target).toEqual({ kind: 'role', roleId: 'role-2' });
  });

  it('rebuilds an action array from the flat form, leaving no form keys behind', () => {
    const merged = mergeConfig({ id: 'n', type: 'action', actions: [] } as WorkflowNode, {
      mode: 'setField',
      key: 'auditSelected',
      value: false,
    });
    expect(merged).toEqual({
      id: 'n',
      type: 'action',
      actions: [{ kind: 'setField', key: 'auditSelected', value: false }],
    });
  });

  it('rebuilds an integration action, and forgets the metadata keys', () => {
    // Switching mode must not leave `key` on a node that now runs a hook.
    const merged = mergeConfig(
      {
        id: 'n',
        type: 'action',
        actions: [{ kind: 'setField', key: 'auditSelected', value: true }],
      } as WorkflowNode,
      { mode: 'integration', hook: 'audit.log', key: 'auditSelected', value: true },
    );
    expect(merged).toEqual({
      id: 'n',
      type: 'action',
      actions: [{ kind: 'integration', hook: 'audit.log' }],
    });
  });

  it('defaults a half-filled action rather than writing undefined into the graph', () => {
    expect(
      mergeConfig({ id: 'n', type: 'action', actions: [] } as WorkflowNode, {
        mode: 'integration',
      }),
    ).toMatchObject({ actions: [{ kind: 'integration', hook: '' }] });
    expect(
      mergeConfig({ id: 'n', type: 'action', actions: [] } as WorkflowNode, { mode: 'setField' }),
    ).toMatchObject({ actions: [{ kind: 'setField', key: '', value: true }] });
  });
});
