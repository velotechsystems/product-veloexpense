/**
 * Pure workflow interpreter (no DB, no I/O — fully unit-testable).
 *
 * Token model: a token flows from Start toward a terminal. Routing nodes
 * (if/switch/parallel) are processed inline; approval nodes "park" their token
 * and emit a createTask effect until a decision arrives. A `parallel` node
 * forks one token per branch (tagged with the parallel's id); the branches
 * re-synchronize at their convergence node under the node's join policy:
 *   - all:        every branch must approve.
 *   - any:        the first approval fires the join; siblings are skipped.
 *   - quorum(k):  k approvals fire the join; siblings are skipped.
 * A branch "fails" when its token reaches `rejected` (or its task is rejected);
 * the parallel fails only when the policy becomes impossible (all → 1 reject;
 * any → all reject; quorum → fewer than k branches can still approve). A
 * parallel failure, or any reject outside a parallel, fails the instance.
 *
 * The DB layer (server/approvals) owns persistence + approver resolution; it
 * feeds this core the facts + the set of nodes that already have an open task,
 * and applies the returned effects (createTasks / skipTasks / completion).
 */
import { evaluatePredicate, type SubjectFacts } from './predicate';
import type { JoinPolicy, WorkflowGraph, WorkflowNode } from './schema';

export interface Token {
  id: string;
  /** Node the token is currently at / about to enter. */
  at: string;
  /** Innermost enclosing parallel (for join synchronization), if any. */
  parallelId?: string;
}

/** Per-parallel branch accounting. */
export interface GroupState {
  expected: number;
  approved: number;
  rejected: number;
  done: boolean;
}

export interface EngineState {
  tokens: Token[];
  groups: Record<string, GroupState>;
  /** Monotonic counter for fresh token ids. */
  seq: number;
}

export type EngineStatus = 'RUNNING' | 'APPROVED' | 'REJECTED';

export interface AdvanceResult {
  state: EngineState;
  /** Approval nodes that need a task created now (newly parked). */
  createTasks: string[];
  /** Approval nodes whose open task should be cancelled (join already fired). */
  skipTasks: string[];
  /** Pass-through side-effect nodes (notify / action) the token entered this
   *  step — the DB layer executes them (fan-out / integrations). Each is entered
   *  at most once (acyclic graph), so an effect fires exactly once. */
  firedEffects: string[];
  status: EngineStatus;
}

// ── Join policy helpers ─────────────────────────────────────────────────────

function satisfied(join: JoinPolicy, approved: number, expected: number): boolean {
  if (join.kind === 'all') return approved >= expected;
  if (join.kind === 'any') return approved >= 1;
  return approved >= join.k;
}
function impossible(join: JoinPolicy, rejected: number, expected: number): boolean {
  if (join.kind === 'all') return rejected >= 1;
  if (join.kind === 'any') return rejected >= expected;
  return expected - rejected < join.k;
}

// ── Precomputed graph indices ───────────────────────────────────────────────

interface GraphIndex {
  nodeById: Map<string, WorkflowNode>;
  out: Map<string, { target: string; handle?: string }[]>;
  branchCount: Map<string, number>;
  joinOf: Map<string, string>;
}

function forwardReachable(start: string, out: GraphIndex['out']): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const e of out.get(id) ?? []) stack.push(e.target);
  }
  return seen;
}

function distances(from: string, out: GraphIndex['out']): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const d = dist.get(id) ?? 0;
    for (const e of out.get(id) ?? []) {
      if (!dist.has(e.target)) {
        dist.set(e.target, d + 1);
        queue.push(e.target);
      }
    }
  }
  return dist;
}

export function indexGraph(graph: WorkflowGraph): GraphIndex {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, { target: string; handle?: string }[]>();
  for (const e of graph.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)?.push({ target: e.target, handle: e.sourceHandle });
  }
  const branchCount = new Map<string, number>();
  const joinOf = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.type !== 'parallel') continue;
    const branches = out.get(n.id) ?? [];
    branchCount.set(n.id, branches.length);
    if (branches.length < 2) continue;
    const reach = branches.map((b) => forwardReachable(b.target, out));
    const common = [...reach[0]].filter((node) => reach.every((r) => r.has(node)));
    if (common.length > 0) {
      const dist = distances(n.id, out);
      common.sort(
        (a, b) =>
          (dist.get(a) ?? Number.POSITIVE_INFINITY) - (dist.get(b) ?? Number.POSITIVE_INFINITY),
      );
      joinOf.set(n.id, common[0]);
    }
  }
  return { nodeById, out, branchCount, joinOf };
}

// ── State construction ──────────────────────────────────────────────────────

export function createInitialState(graph: WorkflowGraph): EngineState {
  const start = graph.nodes.find((n) => n.type === 'start');
  if (!start) throw new Error('engine: graph has no start node');
  return { tokens: [{ id: 't0', at: start.id }], groups: {}, seq: 1 };
}

function clone(prev: EngineState): EngineState {
  return {
    tokens: prev.tokens.map((t) => ({ ...t })),
    groups: Object.fromEntries(Object.entries(prev.groups ?? {}).map(([k, v]) => [k, { ...v }])),
    seq: prev.seq,
  };
}

function successors(idx: GraphIndex, nodeId: string, handle?: string): string[] {
  const edges = idx.out.get(nodeId) ?? [];
  const matched = handle === undefined ? edges : edges.filter((e) => e.handle === handle);
  return matched.map((e) => e.target);
}

/** Decision routing for approval nodes (two named exits). Edges on the named
 *  handle win; the `approve` path falls back to unlabeled edges so legacy
 *  single-output approval graphs keep working. An unwired `reject` returns []
 *  (the caller then applies the default reject behavior). */
function routeSuccessors(idx: GraphIndex, nodeId: string, handle: 'approve' | 'reject'): string[] {
  const edges = idx.out.get(nodeId) ?? [];
  const onHandle = edges.filter((e) => e.handle === handle);
  if (onHandle.length > 0) return onHandle.map((e) => e.target);
  if (handle === 'approve') return edges.filter((e) => e.handle === undefined).map((e) => e.target);
  return [];
}

const APPROVAL_TYPES = new Set(['approval', 'acknowledge']);

function joinPolicyOf(idx: GraphIndex, parallelId: string): JoinPolicy {
  const n = idx.nodeById.get(parallelId);
  return n && n.type === 'parallel' ? n.join : { kind: 'all' };
}

/** Remove every still-live token of a fired group, collecting parked
 *  approval nodes whose tasks should be skipped. */
function skipGroupSiblings(state: EngineState, idx: GraphIndex, parallelId: string): string[] {
  const skipped: string[] = [];
  state.tokens = state.tokens.filter((t) => {
    if (t.parallelId !== parallelId) return true;
    if (APPROVAL_TYPES.has(idx.nodeById.get(t.at)?.type ?? '')) skipped.push(t.at);
    return false;
  });
  return skipped;
}

// ── Advance ─────────────────────────────────────────────────────────────────

export function advance(
  graph: WorkflowGraph,
  prev: EngineState,
  facts: SubjectFacts,
  openTaskNodes: ReadonlySet<string>,
): AdvanceResult {
  const idx = indexGraph(graph);
  const state = clone(prev);
  const createTasks: string[] = [];
  const skipTasks: string[] = [];
  const firedEffects: string[] = [];
  const parked = new Set(openTaskNodes);

  const fresh = (at: string, parallelId?: string): Token => ({
    id: `t${state.seq++}`,
    at,
    ...(parallelId ? { parallelId } : {}),
  });

  let guard = 0;
  const MAX_STEPS = 10_000;
  while (guard++ < MAX_STEPS) {
    const i = state.tokens.findIndex(
      (t) => !parked.has(t.at) || !APPROVAL_TYPES.has(idx.nodeById.get(t.at)?.type ?? ''),
    );
    if (i === -1) break;
    const token = state.tokens[i];
    const node = idx.nodeById.get(token.at);
    if (!node) {
      state.tokens.splice(i, 1);
      continue;
    }

    // Parallel join synchronization (a branch successfully reached the join).
    if (token.parallelId && idx.joinOf.get(token.parallelId) === token.at) {
      const p = token.parallelId;
      const group = state.groups[p];
      state.tokens.splice(i, 1);
      if (!group || group.done) continue; // late arrival after firing
      group.approved += 1;
      if (satisfied(joinPolicyOf(idx, p), group.approved, group.expected)) {
        group.done = true;
        skipTasks.push(...skipGroupSiblings(state, idx, p));
        state.tokens.push(fresh(token.at));
      }
      continue;
    }

    switch (node.type) {
      case 'start': {
        state.tokens.splice(i, 1);
        for (const t of successors(idx, node.id)) state.tokens.push(fresh(t, token.parallelId));
        break;
      }
      case 'approved': {
        state.tokens.splice(i, 1);
        break;
      }
      case 'rejected': {
        const res = rejectToken(state, idx, token, i);
        if (res === 'INSTANCE')
          return { state, createTasks, skipTasks, firedEffects, status: 'REJECTED' };
        break;
      }
      case 'if': {
        const handle = evaluatePredicate(node.predicate, facts) ? 'true' : 'false';
        state.tokens.splice(i, 1);
        for (const t of successors(idx, node.id, handle))
          state.tokens.push(fresh(t, token.parallelId));
        break;
      }
      case 'switch': {
        const hit = node.cases.find((c) => evaluatePredicate(c.predicate, facts));
        const handle = hit ? hit.id : 'default';
        state.tokens.splice(i, 1);
        for (const t of successors(idx, node.id, handle))
          state.tokens.push(fresh(t, token.parallelId));
        break;
      }
      case 'parallel': {
        state.tokens.splice(i, 1);
        const targets = successors(idx, node.id);
        state.groups[node.id] = {
          expected: targets.length,
          approved: 0,
          rejected: 0,
          done: false,
        };
        for (const t of targets) state.tokens.push(fresh(t, node.id));
        break;
      }
      case 'callWorkflow': {
        // Phase D — transparent pass-through for now.
        state.tokens.splice(i, 1);
        for (const t of successors(idx, node.id)) state.tokens.push(fresh(t, token.parallelId));
        break;
      }
      case 'notify':
      case 'action': {
        // Side-effect nodes: record the effect for the DB layer to execute, then
        // pass the token straight through (non-blocking).
        firedEffects.push(node.id);
        state.tokens.splice(i, 1);
        for (const t of successors(idx, node.id)) state.tokens.push(fresh(t, token.parallelId));
        break;
      }
      default: {
        if (!parked.has(node.id)) {
          createTasks.push(node.id);
          parked.add(node.id);
        }
        break;
      }
    }
  }
  if (guard >= MAX_STEPS) throw new Error('engine: step limit exceeded (cyclic graph?)');

  const status: EngineStatus = state.tokens.length === 0 ? 'APPROVED' : 'RUNNING';
  return { state, createTasks, skipTasks, firedEffects, status };
}

/** Record a token reaching a `rejected` node. Returns 'INSTANCE' when it fails
 *  the whole instance, or 'BRANCH' when a parallel branch failed (tolerated
 *  unless the join policy becomes impossible — which escalates to 'INSTANCE').
 *  Mutates `state` (removes the token; bumps the group). */
function rejectToken(
  state: EngineState,
  idx: GraphIndex,
  token: Token,
  i: number,
): 'INSTANCE' | 'BRANCH' {
  state.tokens.splice(i, 1);
  if (!token.parallelId) return 'INSTANCE';
  const group = state.groups[token.parallelId];
  if (!group || group.done) return 'BRANCH';
  group.rejected += 1;
  if (impossible(joinPolicyOf(idx, token.parallelId), group.rejected, group.expected)) {
    return 'INSTANCE';
  }
  return 'BRANCH';
}

// ── Decisions ───────────────────────────────────────────────────────────────

export function applyApproval(
  graph: WorkflowGraph,
  prev: EngineState,
  nodeId: string,
): EngineState {
  const idx = indexGraph(graph);
  const state = clone(prev);
  const i = state.tokens.findIndex((t) => t.at === nodeId);
  if (i === -1) return state;
  const token = state.tokens[i];
  state.tokens.splice(i, 1);
  for (const t of routeSuccessors(idx, nodeId, 'approve')) {
    state.tokens.push({
      id: `t${state.seq++}`,
      at: t,
      ...(token.parallelId ? { parallelId: token.parallelId } : {}),
    });
  }
  return state;
}

/** Reject the task parked at `nodeId`.
 *   - If the node has a wired `reject` exit, route the token down it and keep
 *     running (status RUNNING) — the author chose an explicit rejection path.
 *   - Otherwise apply the default: the token flows to an implicit `rejected`,
 *     failing the whole instance — unless it's inside a parallel, where it's a
 *     tolerated branch failure (escalating only when the join is impossible). */
export function applyRejection(
  graph: WorkflowGraph,
  prev: EngineState,
  nodeId: string,
): { state: EngineState; status: 'RUNNING' | 'REJECTED' } {
  const idx = indexGraph(graph);
  const state = clone(prev);
  const i = state.tokens.findIndex((t) => t.at === nodeId);
  if (i === -1) return { state, status: 'RUNNING' };
  const token = state.tokens[i];

  const rejectTargets = routeSuccessors(idx, nodeId, 'reject');
  if (rejectTargets.length > 0) {
    state.tokens.splice(i, 1);
    for (const t of rejectTargets) {
      state.tokens.push({
        id: `t${state.seq++}`,
        at: t,
        ...(token.parallelId ? { parallelId: token.parallelId } : {}),
      });
    }
    return { state, status: 'RUNNING' };
  }

  const outcome = rejectToken(state, idx, token, i);
  return { state, status: outcome === 'INSTANCE' ? 'REJECTED' : 'RUNNING' };
}
