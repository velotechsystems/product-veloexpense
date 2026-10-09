/**
 * Why the recoverable ITC on an expense is what it is.
 *
 * `explainTax` explains the tax SPLIT. It does not explain the credit, because in this
 * product the credit is not computed there: the engine is asked for the split with a neutral
 * category, and the recoverable slice is then allocated across the expense's line items by
 * `allocateRecoverable`, each at its own category rate, behind a legal-entity gate.
 *
 * That gate is the reason this file exists. The two most common causes of a zero credit —
 * an entity that is not a registrant, and an expense with no lines yet — happen entirely
 * inside the allocator and are invisible to a tax-split trace. An explanation built only from
 * the split would confidently answer "that category doesn't recover tax" to somebody whose
 * real problem is that their legal entity cannot reclaim anything at all. Fluent, specific,
 * and wrong, which is the failure mode the explainability work exists to prevent.
 *
 * As with `explainTax`, this re-runs the real allocator and returns its numbers untouched.
 */

import type { AllocateRecoverableParams, RecoverableResult } from './recoverable';
import { allocateRecoverable } from './recoverable';

/**
 * Why a recoverable figure came out at zero.
 *
 * Closed, and ordered by which cause the reader should hear about first when several are
 * true at once. See `zeroReason` below for why that order is what it is.
 */
export type RecoverableZeroReason =
  /** No tax of this kind was charged, so there is nothing to recover. Ask `explainTax` why. */
  | 'NO_TAX_CHARGED'
  /** The claimant's legal entity cannot reclaim input tax credits at all. */
  | 'ENTITY_NOT_REGISTERED'
  /** The expense has no line items yet, so there is nothing to allocate the tax across. */
  | 'NO_LINES'
  /** Tax was charged and the entity can reclaim, but every line's category recovers 0%. */
  | 'CATEGORIES_NOT_RECOVERABLE'
  /** Some of it is recoverable, but the amount rounded away. Trivially small expenses only. */
  | 'ROUNDS_TO_ZERO';

export interface LineRecovery {
  readonly amountMinor: bigint;
  readonly itcGstHstRate: number;
  readonly itcQstRate: number;
}

export interface CreditExplanation {
  readonly amountMinor: bigint;
  /** Null when the amount is non-zero — there is nothing to explain. */
  readonly zeroReason: RecoverableZeroReason | null;
  /** The tax this credit is a percentage of. */
  readonly taxBaseMinor: bigint;
}

export interface RecoverableTrace {
  /** `LegalEntity.itcRecoverable` — false forces both figures to zero whatever else is true. */
  readonly entityRecovers: boolean;
  readonly lines: readonly LineRecovery[];
  readonly gstHst: CreditExplanation;
  readonly qst: CreditExplanation;
}

/**
 * Work out why one credit is zero.
 *
 * The order is the order somebody would ask in, and each step exists to stop a true-but-
 * useless answer:
 *
 *   1. **No tax charged** first, because every later reason is a statement about recovering
 *      tax that was never paid. Telling somebody to recode a category over a tax nobody
 *      charged sends them to fix the wrong thing — the same precedence `explainTax` uses.
 *   2. **The entity gate** next, because when it is shut nothing downstream can open it.
 *      Adding lines or recoding categories changes nothing, so naming those would be advice
 *      that cannot work.
 *   3. **No lines**, which is the one the claimant can actually fix themselves.
 *   4. **Categories**, once there are lines to blame.
 *   5. **Rounding**, which is what is left.
 */
function zeroReason(
  amountMinor: bigint,
  taxBaseMinor: bigint,
  params: AllocateRecoverableParams,
  rateOf: (line: AllocateRecoverableParams['lines'][number]) => number,
): RecoverableZeroReason | null {
  if (amountMinor !== 0n) return null;
  if (taxBaseMinor === 0n) return 'NO_TAX_CHARGED';
  if (!params.entityRecovers) return 'ENTITY_NOT_REGISTERED';
  if (params.lines.length === 0) return 'NO_LINES';
  if (params.lines.every((line) => rateOf(line) <= 0)) return 'CATEGORIES_NOT_RECOVERABLE';
  return 'ROUNDS_TO_ZERO';
}

/** Allocate the credit, and explain the result. */
export function explainRecoverable(
  params: AllocateRecoverableParams,
): RecoverableResult & { trace: RecoverableTrace } {
  const result = allocateRecoverable(params);
  return {
    ...result,
    trace: {
      entityRecovers: params.entityRecovers,
      lines: params.lines.map((line) => ({
        amountMinor: line.amountMinor,
        itcGstHstRate: line.itcGstHstRate,
        itcQstRate: line.itcQstRate,
      })),
      gstHst: {
        amountMinor: result.recoverableGstHstMinor,
        taxBaseMinor: params.gstHstMinor,
        zeroReason: zeroReason(
          result.recoverableGstHstMinor,
          params.gstHstMinor,
          params,
          (line) => line.itcGstHstRate,
        ),
      },
      qst: {
        amountMinor: result.recoverableQstMinor,
        taxBaseMinor: params.qstMinor,
        zeroReason: zeroReason(
          result.recoverableQstMinor,
          params.qstMinor,
          params,
          (line) => line.itcQstRate,
        ),
      },
    },
  };
}
