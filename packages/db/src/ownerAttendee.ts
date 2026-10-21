/**
 * The claimant as the first attendee — one rule for the four paths that write expense lines.
 *
 * When a line write gives an expense its FIRST line in a category that requires attendees,
 * and the expense has no attendees yet, the expense owner is added as an internal attendee
 * in the same transaction. The person who files is usually at the meal; starting the list
 * with them saves the most common edit, and an empty list on a meal is what the submit gate
 * would otherwise stop on.
 *
 * Two calls, because the rule is about a TRANSITION and a transition needs a "before":
 *
 *   1. `lockClaimantSnapshot(tx, expenseId)` — first in the transaction. Takes the Expense
 *      row lock, then reads whether a requiring line already exists.
 *   2. the caller writes its line(s).
 *   3. `ensureClaimantAttendee(tx, snapshot)` — reads the "after" state and inserts the
 *      owner when the transition holds. Returns the new attendee id, or null.
 *
 * **The lock is `FOR NO KEY UPDATE`, not `FOR UPDATE`.** Two NO KEY UPDATE locks on one row
 * conflict, so two concurrent line writes on the same expense serialise and the second one
 * reads the first one's line as its "before" — exactly one claimant row. It does NOT conflict
 * with the `FOR KEY SHARE` that Postgres takes on the parent row when any other transaction
 * inserts a child of the expense (a line, a receipt, an attendee), so holding it does not
 * stall unrelated writes on the same expense.
 *
 * **No audit here**, same convention as `receiptIntake.ts`: `@expenseos/audit` depends on
 * this package, so the caller owns the transaction AND the audit row.
 *
 * VeloExpense (ExpenseOS 67db2e33, #588): ported as is. The row lock names VeloExpense's
 * `expense` table (ExpenseOS: `"Expense"`), and runs under the caller's tenant transaction,
 * so RLS confines it to the tenant's own expense.
 *
 * **No PII in logs.** Nothing here logs; a caller that does logs ids only — never the name
 * this writes or the email it may be derived from.
 */

import type { Prisma } from '@/lib/generated/prisma/client';

/** The `updateExpense` attendee bound (`name: z.string().trim().min(1).max(200)`). A longer
 *  name would be written here and then refused the first time the owner saved the list. */
const CLAIMANT_NAME_MAX = 200;

declare const claimantSnapshotBrand: unique symbol; // not exported — only this module mints one

/**
 * The "before" state of one expense, read under its row lock.
 *
 * Branded at the type level and tracked at runtime: `ensureClaimantAttendee` refuses any
 * object `lockClaimantSnapshot` did not issue, so a caller cannot hand-build
 * `{ hadRequiringLine: false }` and skip the lock that makes the rule race-free.
 */
export type ClaimantSnapshot = {
  readonly [claimantSnapshotBrand]: true;
  readonly expenseId: string;
  readonly hadRequiringLine: boolean;
};

/** Every snapshot this module has issued. Weak, so a finished transaction's snapshot goes. */
const issued = new WeakSet<object>();

/** The expense's lines in a category that requires attendees. */
const requiringLinesOf = (expenseId: string) =>
  ({ expenseId, category: { requiresAttendees: true } }) satisfies Prisma.ExpenseLineItemWhereInput;

/**
 * Take the Expense row lock, then read whether a requiring line already exists.
 *
 * Call it FIRST in the transaction, before the line write: the lock is what makes the read
 * that follows it a true "before". Throws when the expense does not exist — the line write
 * the caller is about to make would fail on its foreign key anyway.
 */
export async function lockClaimantSnapshot(
  tx: Prisma.TransactionClient,
  expenseId: string,
): Promise<ClaimantSnapshot> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM expense WHERE id = ${expenseId}::uuid FOR NO KEY UPDATE`;
  if (rows.length === 0) {
    throw new Error(`lockClaimantSnapshot: expense ${expenseId} not found`);
  }
  const hadRequiringLine =
    (await tx.expenseLineItem.count({ where: requiringLinesOf(expenseId) })) > 0;
  const snapshot = Object.freeze({ expenseId, hadRequiringLine }) as unknown as ClaimantSnapshot;
  issued.add(snapshot);
  return snapshot;
}

/**
 * Insert the expense owner as an internal attendee when the line write just made the
 * expense need attendees and nobody is listed yet.
 *
 * Takes nothing from the caller but the snapshot: the owner (`Expense.ownerId`, never the
 * person filing) and the categories' `requiresAttendees` flags are read here, through `tx`.
 * Returns the new `ExpenseAttendee.id`, or null when nothing was written.
 */
export async function ensureClaimantAttendee(
  tx: Prisma.TransactionClient,
  snapshot: ClaimantSnapshot,
): Promise<string | null> {
  if (!issued.has(snapshot)) {
    throw new Error('ensureClaimantAttendee: snapshot was not issued by lockClaimantSnapshot');
  }
  const { expenseId, hadRequiringLine } = snapshot;
  // Already required attendees before this write: whatever the list holds is the owner's
  // choice, including an empty one they emptied on purpose.
  if (hadRequiringLine) return null;

  const hasRequiringLine =
    (await tx.expenseLineItem.count({ where: requiringLinesOf(expenseId) })) > 0;
  if (!hasRequiringLine) return null;
  const attendeeCount = await tx.expenseAttendee.count({ where: { expenseId } });
  if (!shouldAddClaimant({ hadRequiringLine, hasRequiringLine, attendeeCount })) return null;

  const { owner } = await tx.expense.findUniqueOrThrow({
    where: { id: expenseId },
    select: { owner: { select: { firstName: true, lastName: true, email: true } } },
  });
  const { id } = await tx.expenseAttendee.create({
    data: { expenseId, name: claimantDisplayName(owner), company: null, isExternal: false },
    select: { id: true },
  });
  return id;
}

/**
 * The attendee name for the owner: `firstName lastName`, each part trimmed and empties
 * dropped; the trimmed email when neither part has text. Clamped to {@link CLAIMANT_NAME_MAX}
 * UTF-16 code units — the unit zod's `max` counts — without splitting a surrogate pair.
 * Characters are otherwise passed through untouched: no case folding, no transliteration.
 */
export function claimantDisplayName(owner: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const parts = [owner.firstName, owner.lastName]
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0);
  const name = parts.length > 0 ? parts.join(' ') : owner.email.trim();
  if (name.length <= CLAIMANT_NAME_MAX) return name;
  let clamped = name.slice(0, CLAIMANT_NAME_MAX);
  const last = clamped.charCodeAt(clamped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) clamped = clamped.slice(0, -1);
  return clamped.trimEnd();
}

/**
 * The transition rule. True only when the expense did not require attendees before the
 * write, does now, and lists nobody.
 */
export function shouldAddClaimant(s: {
  hadRequiringLine: boolean;
  hasRequiringLine: boolean;
  attendeeCount: number;
}): boolean {
  return !s.hadRequiringLine && s.hasRequiringLine && s.attendeeCount === 0;
}
