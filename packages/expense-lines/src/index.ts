/**
 * Barrel only. The implementation lives in `kinds.ts`.
 *
 * See `packages/predicate/src/index.ts` for why: coverage excludes `**​/index.ts` as a
 * re-export barrel, so a package whose logic lives in its index is not measured at all
 * and the per-package floor cannot see it.
 */
export {
  EXPENSE_LINE_KINDS,
  type ExpenseLineKind,
  kindCarriesTip,
  parseLinePayload,
  payloadSchemaFor,
  tipMinorOf,
  tipPayload,
  totalTipMinor,
} from './kinds';
