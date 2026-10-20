/**
 * ── The `lg` breakpoint (w6-04) ─────────────────────────────────────
 *
 * Ported from ExpenseOS `apps/web/src/lib/breakpoints.ts` (1e682dd6), which holds only these
 * two: the `lg` breakpoint as a number and as a media query, for the places that branch on
 * viewport width in JavaScript rather than in CSS. Its first consumer is the personal API
 * key box (`app/preferences/PersonalApiKey.tsx`), which gates its query on the viewport
 * having been MEASURED, not on it being at or above `lg`.
 *
 * VeloExpense: its own file, not appended to `lib/breakpoints.ts`. That file is vendored from
 * lib-ui-kit and `check:ui-kit` fails on any drift from the kit; if the kit ever gains these,
 * delete this file and import them from there.
 *
 * THIS IS A MIRROR, NOT THE SOURCE OF TRUTH: Tailwind's compiled-in `lg` default of `64rem`
 * is. If the theme's `lg` is ever overridden, change this too.
 */

/** Tailwind's `lg` breakpoint in CSS pixels (`64rem` at the default root size). */
export const LG_BREAKPOINT_PX = 1024;

/** `matchMedia` argument matching Tailwind's `lg:` variant — viewport at or above `lg`. */
export const LG_MEDIA_QUERY = `(min-width: ${LG_BREAKPOINT_PX}px)` as const;
