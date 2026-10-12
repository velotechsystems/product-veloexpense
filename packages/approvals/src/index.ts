/**
 * Approval-workflow shared kernel (pure, browser-safe): graph + predicate
 * schema, the predicate evaluator, and structural graph validation. The
 * server interpreter lives in `@/server/approvals`; the editor + publish path
 * import from here.
 *
 * VeloExpense: ExpenseOS's `packages/approvals` (550b2945), Wave 4 (w4-00, d50). The pure
 * kernel arrives first (w4-00a): the schema, graph validation, the stepping core, sub-flow
 * inlining, the predicate facts, business days and per-diem. The interpreter (`./engine`,
 * imported as `@expenseos/approvals/engine`, since it takes a Prisma client) follows in
 * w4-00b, adapted to tenant-scoped tables.
 */

// VeloExpense: `./budgets` — ExpenseOS's budget facts for the engine — is not ported with the
// engine (w4-00b): it reads ExpenseOS's own budget tables, and VeloExpense's budgets are a
// different design (0024; `resolveBudget` is already ported in lib/budgets/scope.ts). Budget
// checks inside approvals (w4-04) decide which numbers the `overBudget` fact reads; until
// then it reads "not over".
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
