/**
 * The approver's own words on a return or a rejection, when they gave any.
 *
 * "Your expense report was returned for edits" says that something must change and not
 * what. The approver's note rides on the event as `payload.note`; this is the only place
 * it is read, so a payload field named `note` on any other event is never quoted.
 *
 * Ported from ExpenseOS 67db2e33 (#578: `approverNote` in its notification dispatcher and
 * `approverNoteOf` in its bell). VeloExpense: one module shared by the email and the Slack
 * message; VeloExpense records an empty `note` when none was given (`reportNotify.ts`), which
 * this reads as none.
 */
export function approverNote(activity: { type: string; payload: unknown }): string | null {
  if (activity.type !== 'RETURNED' && activity.type !== 'REJECTED') return null;
  const note = (activity.payload as { note?: unknown } | null | undefined)?.note;
  return typeof note === 'string' && note.trim() ? note.trim() : null;
}
