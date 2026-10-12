/**
 * Approval-workflow shared kernel (pure, browser-safe): graph + predicate
 * schema, the predicate evaluator, and structural graph validation. The
 * server interpreter lives in `@/server/approvals`; the editor + publish path
 * import from here.
 *
 * VeloExpense: ExpenseOS's `packages/approvals` (550b2945), Wave 4 (w4-00, d50). The pure
 * kernel arrives first (w4-00a): the schema, graph validation, the stepping core, sub-flow
 * inlining, the predicate facts, business days and per-diem. The interpreter (`./engine`)
 * and its budget facts follow in w4-00b, adapted to tenant-scoped tables.
 */

// VeloExpense (w4-00a): `./budgets` — ExpenseOS's budget facts for the engine — arrives with the
// engine itself (w4-00b); VeloExpense's own budgets are a different design (0024), and
// `resolveBudget` is already ported there (lib/budgets/scope.ts).
export { type GraphIssue, validateGraph } from './graph';
export {
  type PerDiemGroup,
  type PerDiemRateRow,
  type PerDiemTier,
  pickPerDiemRate,
} from './perdiem';
export {
  type CandidateVerdict,
  explainPerDiemRate,
  type PerDiemTrace,
  type RateRejection,
} from './perdiem-explain';
export {
  computePerDiemOverageMinor,
  explainPerDiemOverage,
  type PerDiemGroupExplanation,
  type PerDiemOverageInput,
  perDiemOverageBaseMinor,
} from './perdiem-overage';
export { evaluatePredicate, type SubjectFacts } from './predicate';
export {
  type ActionSpec,
  APPROVAL_NODE_TYPES,
  type ApproverFallback,
  type ApproverSpec,
  actionSpecSchema,
  approverFallbackSchema,
  approverSpecSchema,
  edgeSchema,
  graphSchema,
  type JoinPolicy,
  joinPolicySchema,
  matchConditionSchema,
  type NodeType,
  type NotifyTarget,
  nodeSchema,
  notifyTargetSchema,
  PREDICATE_FIELDS,
  PREDICATE_OPS,
  type Predicate,
  type PredicateField,
  type PredicateOp,
  predicateSchema,
  TERMINAL_NODE_TYPES,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from './schema';
