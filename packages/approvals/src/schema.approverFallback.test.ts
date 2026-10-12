import { describe, expect, it } from 'vitest';
import { approverSpecSchema, graphSchema } from './schema';

/**
 * The shape of a no-manager fallback approver.
 *
 * The graph is a JSON column, so this schema is the ONLY thing standing between a
 * hand-edited or half-configured node and the interpreter. Two properties matter
 * enough to pin:
 *
 *   · a fallback is offered on the RELATIVE kinds and on neither of the others —
 *     `filter` is a pool by design and is never "unresolved", so a fallback there
 *     would be a second, quieter pool with different rules;
 *   · the id has to be a uuid. The editor writes `{ kind: 'user', userId: '' }` the
 *     moment somebody picks "a specific person" and before they say who, and that
 *     half-state must fail validation — publishing it would produce a node that
 *     claims to route somewhere and assigns to a user id that cannot exist.
 */
describe('approver fallback schema', () => {
  const USER = '019e4000-0000-7000-8000-000000000008';
  const ROLE = '019e3000-0000-7000-8000-000000000003';

  it('accepts a user fallback on a direct-manager approver', () => {
    const r = approverSpecSchema.safeParse({
      kind: 'manager',
      fallback: { kind: 'user', userId: USER },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a role fallback on a manager-chain approver', () => {
    const r = approverSpecSchema.safeParse({
      kind: 'managerChain',
      minJobLevelId: null,
      fallback: { kind: 'role', roleId: ROLE },
    });
    expect(r.success).toBe(true);
  });

  it('keeps the fallback OPTIONAL', () => {
    // Every workflow published before this feature existed has to keep parsing.
    expect(approverSpecSchema.safeParse({ kind: 'manager' }).success).toBe(true);
  });

  it('strips a fallback smuggled onto a filter approver', () => {
    // Zod objects are non-strict, so this parses — what matters is that the
    // fallback does not SURVIVE into the graph the interpreter reads. A filter
    // approver that carried one would be a pool with a second, quieter pool
    // behind it, and `canClaimUnresolvedApproval` would never consult it anyway.
    const r = approverSpecSchema.parse({
      kind: 'filter',
      match: { always: true },
      fallback: { kind: 'user', userId: USER },
    });
    expect(r).not.toHaveProperty('fallback');
  });

  it('refuses the editor’s half-configured user fallback', () => {
    const r = approverSpecSchema.safeParse({
      kind: 'manager',
      fallback: { kind: 'user', userId: '' },
    });
    expect(r.success).toBe(false);
  });

  it('refuses a fallback kind the engine cannot resolve', () => {
    // `notifyTargetSchema` also has `requester` and `manager`; neither can mean
    // anything here — `manager` is what just failed, `requester` is self-approval.
    for (const kind of ['requester', 'manager']) {
      expect(approverSpecSchema.safeParse({ kind: 'manager', fallback: { kind } }).success).toBe(
        false,
      );
    }
  });

  it('rejects a whole graph whose fallback is malformed', () => {
    // The publish path parses the GRAPH, not the approver in isolation; a fallback
    // that only fails at the leaf must still stop the publish.
    const graph = {
      nodes: [
        { id: 'start', type: 'start' },
        {
          id: 'mgr',
          type: 'approval',
          approver: { kind: 'manager', fallback: { kind: 'user', userId: 'not-a-uuid' } },
        },
        { id: 'approved', type: 'approved' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'mgr' },
        { id: 'e2', source: 'mgr', target: 'approved' },
      ],
    };
    expect(graphSchema.safeParse(graph).success).toBe(false);
  });
});
