/**
 * Barrel only. The implementation lives in `predicate.ts`.
 *
 * It used to live here, and that made the package invisible to the coverage floor:
 * `vitest.config.ts` excludes `**​/index.ts` because a barrel is pure re-exports with
 * nothing to cover, so a package whose logic sits in its index reports no files at all
 * — not 0%, absent. `scripts/coverage-floor.mjs` then had nothing to enforce, and
 * `predicate` (7 importers, the condition engine behind both approvals routing and the
 * policy engine) sat at zero tests while the floor reported every package green.
 *
 * VeloExpense: ExpenseOS's `packages/predicate` (550b2945), Wave 4 (w4-00a), verbatim with its
 * tests — the condition language of the approval workflows.
 */
export {
  evaluatePredicate,
  type FactValue,
  makePredicateSchema,
  PREDICATE_OPS,
  type Predicate,
  type PredicateOp,
} from './predicate';
