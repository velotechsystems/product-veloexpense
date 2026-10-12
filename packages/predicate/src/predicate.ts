/**
 * The predicate primitive — a pure, browser-safe, field-agnostic condition AST +
 * evaluator + Zod schema factory. Shared by the approvals routing engine and the
 * policy engine: each supplies its own field enum via `makePredicateSchema` and
 * evaluates against its own fact record. Zero DB / framework deps so both a React
 * Flow editor and a server engine can import it.
 *
 * Compare semantics (invariants — do not change without updating both consumers):
 *  - numeric ops (`lt`/`lte`/`gt`/`gte`) require BOTH operands to be numbers;
 *  - `eq`/`neq` are strict equality;
 *  - booleans are encoded as the strings `'true'` / `'false'`;
 *  - a SET-valued fact (`string[]`) tests overlap for `in` / `nin`;
 *  - a missing fact is treated as `null`.
 */
import { z } from 'zod';

export const PREDICATE_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'nin'] as const;
export type PredicateOp = (typeof PREDICATE_OPS)[number];

/** A fact value: scalar, a set (for overlap tests), or absent. */
export type FactValue = string | number | string[] | null;

/** Recursive predicate over a field set `F`: a leaf comparison, an and/or
 *  composite, or the unconditional `always`. */
export type Predicate<F extends string = string> =
  | { field: F; op: PredicateOp; value: number | string | string[] | null }
  | { all: Predicate<F>[] }
  | { any: Predicate<F>[] }
  | { always: true };

type PredicateValue = number | string | string[] | null;

function compare(op: PredicateOp, fact: FactValue, value: PredicateValue): boolean {
  // Set-valued facts (e.g. categoryIds): `in` = the fact set overlaps the
  // selected values; `nin` = no overlap. Other ops don't apply to a set.
  if (Array.isArray(fact)) {
    const selected = Array.isArray(value) ? value : value != null ? [String(value)] : [];
    const overlaps = fact.some((f) => selected.includes(f));
    if (op === 'in') return overlaps;
    if (op === 'nin') return !overlaps;
    return false;
  }
  switch (op) {
    case 'eq':
      return fact === value;
    case 'neq':
      return fact !== value;
    case 'lt':
      return typeof fact === 'number' && typeof value === 'number' && fact < value;
    case 'lte':
      return typeof fact === 'number' && typeof value === 'number' && fact <= value;
    case 'gt':
      return typeof fact === 'number' && typeof value === 'number' && fact > value;
    case 'gte':
      return typeof fact === 'number' && typeof value === 'number' && fact >= value;
    case 'in':
      return Array.isArray(value) && fact !== null && value.includes(String(fact));
    case 'nin':
      return !(Array.isArray(value) && fact !== null && value.includes(String(fact)));
  }
}

/** Evaluate a predicate against a flat facts record. Missing fields → null. */
export function evaluatePredicate<F extends string>(
  pred: Predicate<F>,
  facts: Partial<Record<F, FactValue>>,
): boolean {
  if ('always' in pred) return true;
  if ('all' in pred) return pred.all.every((p) => evaluatePredicate(p, facts));
  if ('any' in pred) return pred.any.some((p) => evaluatePredicate(p, facts));
  const fact = facts[pred.field] ?? null;
  return compare(pred.op, fact, pred.value);
}

/** Build a Zod schema validating a `Predicate<F>` whose leaf `field` is one of
 *  `fields`. Each consumer passes its own field enum. */
export function makePredicateSchema<F extends string>(
  fields: readonly [F, ...F[]],
): z.ZodType<Predicate<F>> {
  const leaf = z.object({
    field: z.enum(fields),
    op: z.enum(PREDICATE_OPS),
    value: z.union([z.number(), z.string(), z.array(z.string()), z.null()]),
  });
  const schema: z.ZodType<Predicate<F>> = z.lazy(() =>
    z.union([
      leaf,
      z.object({ all: z.array(schema) }),
      z.object({ any: z.array(schema) }),
      z.object({ always: z.literal(true) }),
    ]),
  );
  return schema;
}
