/**
 * The determination record: what a pass concluded, and what a human changed
 * afterwards.
 *
 * Two readers need the same representation, which is why this is here rather
 * than in either of them: the WORKER writes a determination and must be told
 * which fields a person has already corrected, and the WEB records those
 * corrections as they happen. If each owned its own shape, an override written
 * by one would be invisible to the other, and the next re-scan would quietly
 * discard a human's work — the exact failure the overrides column exists to
 * prevent.
 *
 * `overrides` is a flat `{ field: renderedValue }` map, deliberately:
 *
 *   - It goes into a PROMPT, so it has to be human-readable text; a typed union
 *     of every correctable field would have to be re-rendered anyway.
 *   - The set of correctable fields is the UI's business and will grow. A schema
 *     here would have to change every time a field became editable, and an
 *     unrecognised key is harmless — it's one more sentence of context.
 *
 * A field appears once, with the latest value. A person who corrects the total
 * twice has one opinion about the total, not two.
 *
 * Ported from ExpenseOS's `packages/db/src/determination.ts` (550b2945) with Wave 3 (w3-02a),
 * verbatim but for the generated client's import path. The table is 0057's.
 */

import type { Prisma, PrismaClient } from '@/lib/generated/prisma/client';

/** Fields the UI records corrections for. Not exhaustive by design — the writer
 *  accepts any key — but naming the common ones keeps call sites honest and
 *  greppable. */
export type OverrideField =
  | 'merchant'
  | 'location'
  | 'date'
  | 'currency'
  | 'total'
  | 'subtotal'
  | 'taxGstHst'
  | 'taxQst'
  | 'taxPst'
  | 'fxRate'
  | 'lineItems'
  | (string & {});

export type OverrideMap = Record<string, string>;

/** A determination as the rest of the system reads it. */
export interface CurrentDetermination {
  id: string;
  receiptIds: string[];
  proposed: Prisma.JsonValue;
  overrides: OverrideMap;
  model: string | null;
  confidence: number | null;
  createdAt: Date;
}

/** Coerce the Json column to the map shape. A non-object (or null) reads as
 *  empty rather than throwing — a display path must not break on one odd row. */
export function overridesOf(value: Prisma.JsonValue | null | undefined): OverrideMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: OverrideMap = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v == null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/** The expense's live determination — the newest one not yet superseded. */
export async function currentDetermination(
  db: Pick<PrismaClient, 'expenseDetermination'>,
  expenseId: string,
): Promise<CurrentDetermination | null> {
  const row = await db.expenseDetermination.findFirst({
    where: { expenseId, supersededById: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      receiptIds: true,
      proposed: true,
      overrides: true,
      model: true,
      confidence: true,
      createdAt: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    receiptIds: row.receiptIds,
    proposed: row.proposed,
    overrides: overridesOf(row.overrides),
    model: row.model,
    confidence: row.confidence === null ? null : Number(row.confidence),
    createdAt: row.createdAt,
  };
}

/**
 * Record human corrections onto the expense's current determination.
 *
 * A no-op when there is no determination — nothing has been proposed, so nothing
 * is being overridden; the person is simply entering their expense. That
 * distinction matters: treating every manual entry as an override would send a
 * wall of "corrections" into a first determination that never proposed anything.
 *
 * Values are merged, not replaced, so recording `total` doesn't forget an earlier
 * `merchant`. Passing `null` for a field CLEARS the override — a person who
 * reverts to what was proposed no longer disagrees with it.
 */
export async function recordOverrides(
  db: Pick<PrismaClient, 'expenseDetermination'>,
  expenseId: string,
  patch: Record<string, string | null | undefined>,
): Promise<void> {
  // `undefined` means "not touched"; `null` means "reverted". Only the latter is
  // an instruction, so the filter narrows the type as well as the work.
  const entries = Object.entries(patch).filter(
    (e): e is [string, string | null] => e[1] !== undefined,
  );
  if (entries.length === 0) return;
  const current = await db.expenseDetermination.findFirst({
    where: { expenseId, supersededById: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, overrides: true },
  });
  if (!current) return;
  const merged = overridesOf(current.overrides);
  for (const [field, value] of entries) {
    if (value === null) delete merged[field];
    else merged[field] = value;
  }
  await db.expenseDetermination.update({
    where: { id: current.id },
    data: { overrides: merged as Prisma.InputJsonValue },
  });
}

/** The prompt-shaped list the determination pass consumes. */
export function overridesForPrompt(overrides: OverrideMap): { field: string; value: string }[] {
  return Object.entries(overrides).map(([field, value]) => ({ field, value }));
}

/**
 * Persist a new determination and retire the one it replaces.
 *
 * The old row is kept and pointed at the new one rather than being overwritten,
 * because "why does this claim say $130" is a question asked months later, and
 * the answer is the chain. Overrides carry forward: a correction survives every
 * rebuild until the person who made it changes their mind.
 *
 * Takes the narrowest client its body needs — the same shape `resolveExpenseFx`
 * accepts — so the determination can be written INSIDE a caller's transaction. The
 * joint rebuild does exactly that: the determination is the record of the figures
 * written alongside it, and a chain that commits when those figures did not would
 * explain a claim that says something else.
 */
export async function supersedeDetermination(
  db: Pick<Prisma.TransactionClient, 'expenseDetermination'>,
  params: {
    expenseId: string;
    receiptIds: string[];
    proposed: Prisma.InputJsonValue;
    /** Carried from the retired determination unless the caller overrides. */
    overrides?: OverrideMap;
    model?: string | null;
    modelVersion?: string | null;
    confidence?: number | null;
  },
): Promise<{ id: string }> {
  const prior = await db.expenseDetermination.findFirst({
    where: { expenseId: params.expenseId, supersededById: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, overrides: true },
  });
  const overrides = params.overrides ?? overridesOf(prior?.overrides);
  const created = await db.expenseDetermination.create({
    data: {
      expenseId: params.expenseId,
      receiptIds: params.receiptIds,
      proposed: params.proposed,
      overrides: overrides as Prisma.InputJsonValue,
      model: params.model ?? null,
      modelVersion: params.modelVersion ?? null,
      confidence: params.confidence ?? null,
    },
    select: { id: true },
  });
  if (prior) {
    await db.expenseDetermination.update({
      where: { id: prior.id },
      data: { supersededById: created.id },
    });
  }
  return created;
}
