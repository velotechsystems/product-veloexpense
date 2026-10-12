/**
 * Routing's view of the shared predicate primitive. The AST + evaluator now live
 * in `@expenseos/predicate`; this module pins the fact record to routing's
 * `PredicateField` set and re-exports the evaluator. Browser-safe.
 */
import type { FactValue } from '@expenseos/predicate';
import type { PredicateField } from './schema';

export { evaluatePredicate, type FactValue } from '@expenseos/predicate';

/** Normalized subject attributes keyed by routing predicate field. `amount` is
 *  the FX-normalized minor amount (number); some report facts are SETS
 *  (`categoryIds`). Missing fields are treated as null. */
export type SubjectFacts = Partial<Record<PredicateField, FactValue>>;
