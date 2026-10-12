/**
 * Approval-workflow graph schema (pure — no DB, browser-safe).
 *
 * The single source of truth for the shape of an `ApprovalWorkflowVersion.graph`
 * and `.matchCondition`. Shared by the server interpreter (walks the graph),
 * the publish path (validates), and the visual editor (authoring + live
 * validation). Keep this module free of `@expenseos/db` / Node imports so the
 * React Flow editor can import it client-side.
 */
import {
  type Predicate as BasePredicate,
  makePredicateSchema,
  PREDICATE_OPS,
  type PredicateOp,
} from '@expenseos/predicate';
import { z } from 'zod';

// ── Predicate AST ───────────────────────────────────────────────────────────
//
// The AST + evaluator + schema factory live in the shared `@expenseos/predicate`
// leaf (also used by the policy engine). Routing supplies its own field enum.

/** Subject attributes a routing predicate can test. `amount` is FX-normalized to
 *  the base currency before evaluation (see the engine); the rest are ids/enums. */
export const PREDICATE_FIELDS = [
  'amount',
  'currency',
  'interval',
  'vendorId',
  'departmentId',
  'jobLevelId',
  'legalEntityId',
  'businessUnitId',
  'glAccountId',
  'employeeStatus',
  'userId',
  // Expense-report-only facts (derived from the report's line items + policy).
  // `categoryIds` is a SET — `in`/`nin` test set overlap (see the evaluator).
  'categoryIds',
  'requiresApproval',
  'hasPolicyViolation',
  'lineCount',
  'maxLineAmount',
  'overPerDiem',
  'perDiemOverageMinor',
  // Budgets (Module 10). Same shape as the per-diem pair above, and for the same
  // reason: an admin authors "route to Finance when over budget" as a condition
  // rather than the behaviour being hard-coded, so a deployment that does not
  // want it simply never writes the workflow.
  'overBudget',
  'budgetOverageMinor',
] as const;
export type PredicateField = (typeof PREDICATE_FIELDS)[number];

export { PREDICATE_OPS, type PredicateOp };

/** A routing predicate — the shared AST specialized to `PredicateField`. */
export type Predicate = BasePredicate<PredicateField>;

export const predicateSchema: z.ZodType<Predicate> = makePredicateSchema(PREDICATE_FIELDS);

// ── Nodes ─────────────────────────────────────────────────────────────────

/** Editor canvas coordinates (ignored by the interpreter). Nodes auto-size to
 *  their content — no persisted width/height. */
const positionSchema = z.object({ x: z.number(), y: z.number() }).optional();
const baseNode = { id: z.string().min(1), position: positionSchema };

/** Parallel join policy: all must approve, any one suffices, or k of N. */
export const joinPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('any') }),
  z.object({ kind: z.literal('quorum'), k: z.number().int().min(1) }),
]);
export type JoinPolicy = z.infer<typeof joinPolicySchema>;

/**
 * Who decides when a RELATIVE approver resolves to nobody — the requester is at
 * the top of the org chart (the CEO has no manager), or the HR feed has not
 * given them one yet.
 *
 * The vocabulary is deliberately `notifyTargetSchema`'s, minus the two members
 * that cannot mean anything here: `manager` is the thing that just failed to
 * resolve, and `requester` would be self-approval. What is left is the same
 * `{ kind: 'user' | 'role' }` shape an author already knows from a Notify node.
 *
 * Without one, such a task parks unassigned and falls through to
 * `canClaimUnresolvedApproval` — claimable by ANY holder of the subject's
 * approve permission, which for an expense report is every line manager in the
 * company. Naming a fallback is how an author says who actually decides, and it
 * takes the pool path out of play entirely (see the engine).
 */
export const approverFallbackSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().uuid() }),
  z.object({ kind: z.literal('role'), roleId: z.string().uuid() }),
]);
export type ApproverFallback = z.infer<typeof approverFallbackSchema>;

/** Who approves an Approval node:
 *   - `manager`      — the requester's direct manager.
 *   - `managerChain` — nearest ancestor manager at/above `minJobLevelId`.
 *   - `filter`       — any *active* user matching `match` (a predicate over the
 *                      candidate's own attributes) at/above `minJobLevelId`;
 *                      any match can claim & decide the task.
 *  Job-level ordering rides on the dedicated `minJobLevelId` (ids aren't
 *  ordered), mirroring the rest of the app.
 *
 *  `fallback` is offered on the two RELATIVE kinds and on neither of the
 *  others. `managerChain` needs it as much as `manager` does: it returns the
 *  most senior ancestor it found and null only when the requester has no
 *  manager at all, so the same person falls through both — and the seeded
 *  expense workflow routes anything over $5k through `managerChain`, so a
 *  fallback on `manager` alone would cover the CEO's lunch and strand their
 *  offsite. A `filter` approver takes none: it is a pool BY DESIGN and is never
 *  "unresolved", so a fallback there would just be a second, quieter pool. */
export const approverSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manager'), fallback: approverFallbackSchema.optional() }),
  z.object({
    kind: z.literal('managerChain'),
    minJobLevelId: z.string().uuid().nullable().optional(),
    fallback: approverFallbackSchema.optional(),
  }),
  z.object({
    kind: z.literal('filter'),
    minJobLevelId: z.string().uuid().nullable().optional(),
    match: predicateSchema,
  }),
]);
export type ApproverSpec = z.infer<typeof approverSpecSchema>;

/** Who a Notify node pings (resolved server-side, then delivered through the
 *  activity stream → in-app / email / Slack). A non-blocking FYI:
 *   - `requester` — the subject owner (submitter / card requester).
 *   - `manager`   — the requester's direct manager.
 *   - `user`      — a specific person.
 *   - `role`      — everyone holding a role (e.g. the AP team). */
export const notifyTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requester') }),
  z.object({ kind: z.literal('manager') }),
  z.object({ kind: z.literal('user'), userId: z.string().uuid() }),
  z.object({ kind: z.literal('role'), roleId: z.string().uuid() }),
]);
export type NotifyTarget = z.infer<typeof notifyTargetSchema>;

/** A side-effect an Action node performs:
 *   - `setField`    — write `value` under `key` in the subject's `metadata` map
 *                     (e.g. flag { auditSelected: true }); never a core column.
 *   - `integration` — fire a named server hook (e.g. post to NetSuite on
 *                     approval). The hook registry is wired alongside the
 *                     Phase-4 posting work; unknown hooks are a no-op.
 *  The interpreter treats an Action node as a pass-through and hands these specs
 *  to the DB layer to execute. */
export const actionSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('setField'),
    key: z.string().min(1).max(64),
    value: z.union([z.string(), z.boolean(), z.null()]),
  }),
  z.object({ kind: z.literal('integration'), hook: z.string().min(1) }),
]);
export type ActionSpec = z.infer<typeof actionSpecSchema>;

export const nodeSchema = z.discriminatedUnion('type', [
  // Terminals + entry.
  z.object({ ...baseNode, type: z.literal('start') }),
  z.object({ ...baseNode, type: z.literal('approved') }),
  z.object({ ...baseNode, type: z.literal('rejected') }),
  // Routing.
  z.object({ ...baseNode, type: z.literal('if'), predicate: predicateSchema }),
  z.object({
    ...baseNode,
    type: z.literal('switch'),
    // Ordered first-match cases; the `default` output handle catches the rest.
    cases: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().optional(),
          predicate: predicateSchema,
        }),
      )
      .min(1),
  }),
  z.object({ ...baseNode, type: z.literal('parallel'), join: joinPolicySchema }),
  z.object({ ...baseNode, type: z.literal('callWorkflow'), workflowKey: z.string().min(1) }),
  // The single human-approval node; its approver is defined by the spec.
  // Optional deadline: `ttlBusinessDays` stamps the task's expiry; `onExpire`
  // decides what happens when it lapses (default REJECT). ESCALATE climbs the
  // requester's manager chain one level per lapse, auto-rejecting at the top.
  z.object({
    ...baseNode,
    type: z.literal('approval'),
    approver: approverSpecSchema,
    ttlBusinessDays: z.number().int().positive().max(60).optional(),
    onExpire: z.enum(['REJECT', 'APPROVE', 'ESCALATE']).optional(),
  }),
  // Non-blocking FYI: pings `target`, then passes the token straight through.
  z.object({ ...baseNode, type: z.literal('notify'), target: notifyTargetSchema }),
  // Blocking human acknowledgment — a single outcome (acknowledge → continue);
  // no reject path. Its acknowledger is resolved like an approver.
  z.object({ ...baseNode, type: z.literal('acknowledge'), approver: approverSpecSchema }),
  // Automated side-effect(s); passes the token straight through (non-blocking).
  z.object({
    ...baseNode,
    type: z.literal('action'),
    actions: z.array(actionSpecSchema).min(1),
  }),
]);
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type NodeType = WorkflowNode['type'];

/** Node types that create a human task (vs. routing / terminal / pass-through).
 *  Acknowledge parks a task just like Approval — the difference (single outcome)
 *  is enforced at decision time, not in task creation. */
export const APPROVAL_NODE_TYPES = [
  'approval',
  'acknowledge',
] as const satisfies readonly NodeType[];

export const TERMINAL_NODE_TYPES = ['approved', 'rejected'] as const satisfies readonly NodeType[];

// ── Edges + graph ───────────────────────────────────────────────────────────

/** `sourceHandle` disambiguates multi-output nodes:
 *   - if:       'true' | 'false'
 *   - switch:   <case.id> | 'default'
 *   - parallel: any label (each outgoing edge is a branch)
 *   - others:   undefined (single output) */
export const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().optional(),
  target: z.string().min(1),
});
export type WorkflowEdge = z.infer<typeof edgeSchema>;

export const graphSchema = z.object({
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema),
});
export type WorkflowGraph = z.infer<typeof graphSchema>;

/** A workflow's applicability predicate (which subjects it governs). */
export const matchConditionSchema = predicateSchema;
