/**
 * The expense line-item KIND registry.
 *
 * A line is a category and an amount, plus whatever its kind needs. Mileage
 * already proved how that goes wrong when each kind adds its own columns: six
 * nullable fields that mean nothing on a meal, and the next kind would add more.
 * So a kind declares its payload here, as a zod schema, and the row carries one
 * `payload` Json column validated against it.
 *
 * The shape mirrors the policy-rule kind registry that already works in this
 * codebase: engineers add a kind in one place, and every consumer — the tRPC
 * writes, the worker's extraction prefill, the tax base, the NetSuite payload —
 * reads it through the same accessors rather than reaching into the Json.
 *
 * MILEAGE is registered but keeps its dedicated columns for now; it moves in here
 * when mileage is next revisited, and this comment is the reminder.
 */

import { z } from 'zod';

export const EXPENSE_LINE_KINDS = ['STANDARD', 'STANDARD_WITH_TIP', 'MILEAGE'] as const;
export type ExpenseLineKind = (typeof EXPENSE_LINE_KINDS)[number];

/** Minor units on the wire: BigInt doesn't survive JSON, so payloads carry digit
 *  strings and the accessors below hand back BigInt. */
const minorString = z.string().regex(/^\d+$/, 'minor units must be a non-negative integer string');

/** Nothing kind-specific: a category and an amount. */
const standardPayload = z.object({}).strict();

/**
 * A line that includes a voluntary tip. `tipMinor` is the untaxed part of the
 * line's own `amountMinor` — NOT an addition to it, so "expense = sum of lines"
 * still holds and the receipt total still reconciles.
 *
 * An embedded service gratuity is deliberately NOT this kind: it's taxable, so it
 * is simply part of a STANDARD amount with no tip recorded.
 */
const standardWithTipPayload = z.object({ tipMinor: minorString }).strict();

/** Mileage's fields still live in dedicated columns. */
const mileagePayload = z.object({}).strict();

const PAYLOAD_SCHEMAS = {
  STANDARD: standardPayload,
  STANDARD_WITH_TIP: standardWithTipPayload,
  MILEAGE: mileagePayload,
} satisfies Record<ExpenseLineKind, z.ZodTypeAny>;

export function payloadSchemaFor(kind: ExpenseLineKind): z.ZodTypeAny {
  return PAYLOAD_SCHEMAS[kind];
}

/**
 * Validate a payload for its kind. Throws on mismatch — a line whose payload
 * doesn't fit its kind is a bug, not user input to be salvaged.
 */
export function parseLinePayload(kind: ExpenseLineKind, payload: unknown): unknown {
  return payloadSchemaFor(kind).parse(payload ?? {});
}

/** Whether a kind's payload could carry a tip at all. */
export function kindCarriesTip(kind: ExpenseLineKind): boolean {
  return kind === 'STANDARD_WITH_TIP';
}

/**
 * The untaxed tip inside a line, or 0. Tolerant on read: a malformed payload
 * yields no tip rather than throwing, because a display path must not break on
 * one bad row — the write path is where a payload is rejected.
 */
export function tipMinorOf(line: { kind: string; payload?: unknown }): bigint {
  if (line.kind !== 'STANDARD_WITH_TIP') return 0n;
  const parsed = standardWithTipPayload.safeParse(line.payload ?? {});
  return parsed.success ? BigInt(parsed.data.tipMinor) : 0n;
}

/**
 * Total untaxed tip across a set of lines — what leaves the taxable base of the
 * expense they belong to.
 */
export function totalTipMinor(lines: readonly { kind: string; payload?: unknown }[]): bigint {
  return lines.reduce((sum, l) => sum + tipMinorOf(l), 0n);
}

/** Build a payload for a tip line. `0n` yields a STANDARD line instead, so a
 *  cleared tip doesn't leave a tip-kind line claiming nothing. */
export function tipPayload(tipMinor: bigint): {
  kind: ExpenseLineKind;
  payload: { tipMinor: string } | null;
} {
  if (tipMinor <= 0n) return { kind: 'STANDARD', payload: null };
  return { kind: 'STANDARD_WITH_TIP', payload: { tipMinor: tipMinor.toString() } };
}
