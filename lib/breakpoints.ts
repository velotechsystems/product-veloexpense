/**
 * Compact-viewport breakpoint — the single source of truth for "is this a
 * phone-width screen?", shared by the JS side (`useIsCompact`) and the CSS
 * side (the cloak classes below).
 *
 * ── Why 767.98 and not 768 ──────────────────────────────────────────
 *
 * Tailwind's `md` variant is `min-width: 768px`, and this package does not
 * override `--breakpoint-md` in the `@theme` block of `globals.css`, so the
 * default holds. `COMPACT_QUERY` has to be the exact complement of that: at
 * every viewport width, exactly one of the two must match.
 *
 * `(max-width: 768px)` would NOT be a complement — at exactly 768px both it
 * and `min-width: 768px` match, and the page would render the compact tree
 * while CSS un-cloaks the table one. `(max-width: 767px)` fails the other
 * way: on a fractional viewport (browser zoom, a 767.5px device-pixel-ratio
 * window) neither matches and the row disappears entirely. 767.98px is the
 * standard sub-pixel-safe complement — the same value Bootstrap has shipped
 * for the same reason — chosen because it is above every width a browser can
 * report below 768 and below 768 itself.
 *
 * ── Polarity is load-bearing ────────────────────────────────────────
 *
 * The query is deliberately phrased so `matches === true` MEANS compact.
 * Inverting it to `min-width: 768px` would silently flip which tree mounts:
 * the root Vitest `matchMedia` polyfill answers `matches: false` to every
 * query, so under an inverted query every existing DataTable test would
 * mount the card tree and fail. `tests/tokens/breakpoints.test.ts` pins the
 * literal for exactly that reason — if you are here to change this string,
 * that test is the conversation you need to have first.
 */

/** Tailwind's `md` breakpoint, in px. Mirrors the framework default. */
export const MD_BREAKPOINT_PX = 768;

/**
 * Upper bound of the compact range, in px. `MD_BREAKPOINT_PX` minus the
 * sub-pixel epsilon — see the note above.
 */
export const COMPACT_MAX_WIDTH_PX = 767.98;

/**
 * The compact media query. `matches === true` means compact (cards);
 * `false` means regular (table).
 *
 * The `satisfies` clause is the COMPILE-time half of the polarity pin, and
 * it lives here rather than in the test because this package's
 * `tsconfig.json` excludes test files from the program — a type-level guard
 * written in a test would never be checked by `npm run typecheck` or by CI.
 * `satisfies`, rather than a type annotation, keeps the exact literal type
 * intact while still rejecting a `min-width:` rewrite at build time. The
 * exact VALUE is pinned at runtime by `tests/tokens/breakpoints.test.ts`.
 */
export const COMPACT_QUERY = '(max-width: 767.98px)' satisfies `(max-width: ${number}px)`;

/**
 * Cloak class for the compact tree: visible below `md`, hidden at and above.
 *
 * The cloaks exist ONLY to suppress the pre-hydration flash. The server has
 * no viewport, so SSR always emits the regular tree (`useIsCompact` returns
 * `false` from its server snapshot); on a phone, CSS hides that markup until
 * hydration swaps in the compact tree. After hydration exactly one tree is
 * mounted and the cloak on it is a no-op. Tests must not assert on these
 * classes — in jsdom only one tree ever exists.
 */
export const CARDS_ONLY = 'md:hidden';

/**
 * Cloak class for the regular (table) tree: hidden below `md`, visible above.
 *
 * `md:block`, not `md:flex` — the element this lands on is `<Scroll2D>`,
 * whose root is a plain block-level `<div className={cls('relative', …)}>`.
 * Restoring it to `flex` would change its layout the moment the cloak was
 * applied.
 */
export const TABLE_ONLY = 'hidden md:block';
