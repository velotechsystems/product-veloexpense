/**
 * VeloExpense's wordmark, as the sidebar draws it (2026 brand): the `-nohalo` file at a
 * given cap height with the CSS halo behind it, light and dark files switched by the
 * colour scheme (`.velo-on-light` / `.velo-on-dark`, app/tailwind-v4.css).
 *
 * Moved here from the retired #147 shell (components/app-shell) so the ported ExpenseOS
 * sidebar can carry VeloExpense's brand rather than E Inc.'s logo.
 */
const PRODUCT = 'VeloExpense';

/** viewBox is 1282 × 114 with a cap height of 100 units (the kit's `-nohalo` file). */
export function Wordmark({ capHeight }: { capHeight: number }) {
  const height = Math.round(capHeight * 1.14);
  const width = Math.round(height * (1282 / 114));
  return (
    <span
      className="velo-halo inline-flex shrink-0"
      style={{ ['--halo-size' as string]: `${Math.round(capHeight * 8.74)}px` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG; next/image adds nothing */}
      <img className="velo-on-light" src="/brand/veloexpense-nohalo.svg" alt={PRODUCT} width={width} height={height} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="velo-on-dark" src="/brand/veloexpense-nohalo-dark.svg" alt={PRODUCT} width={width} height={height} />
    </span>
  );
}
