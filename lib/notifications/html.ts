/**
 * VX4-3 part 3 — HTML escaping, as a LEAF module.
 *
 * This lived in `dispatch.ts` and moved here for one reason: `email-shell.ts` needs
 * it, `dispatch.ts` imports `email-shell.ts`, and importing it back the other way
 * is a cycle. Exactly the cycle `lib/integrations/errors.ts` was extracted to break
 * (VX3-6) and the one `lib/integrations/conflicts.ts` was placed as a leaf to
 * avoid (AC-22). Third time, same shape, same answer — a shared helper belongs
 * below both users, not inside one of them.
 *
 * The escaping itself is unchanged, and the omission is deliberate: `'` is NOT
 * escaped, because every attribute this is interpolated into is double-quoted.
 * That was true in `dispatch.ts` and is true in `email-shell.ts`; a single-quoted
 * attribute anywhere would make it wrong, which is the thing to remember rather
 * than the four replacements.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
