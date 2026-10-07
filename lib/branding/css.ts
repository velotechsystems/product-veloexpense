/**
 * VX4-3 — turning a tenant's brand colour into the CSS that retints the product.
 * PURE: takes a hex, returns a string. No `pg`, no React, no env.
 *
 * ── WHAT IS BEING OVERRIDDEN (2026 KIT) ─────────────────────────────────────
 *
 * The shell sets `data-app="expense"`, and the kit (`app/velotech-tokens.css`)
 * binds `--brand-50 … -950` and the roles `--brand-primary`, `-on-primary`,
 * `-button`, `-on-button`, `-button-hover` and `-link` to VeloExpense's teal.
 * Every shadcn variable reads those (`--primary`, `--ring`, `--accent`, the
 * sidebar, the charts), so a branded tenant re-binds the same names and the
 * product follows without any component being named.
 *
 * The ROLES are re-bound as well as the ramp because the kit binds each role to
 * the product's own token (`--brand-button: var(--expense-button)`), not to
 * `--brand-200`; overriding the ramp alone would leave teal buttons on a
 * tenant's green.
 *
 * NOT overridden: `--brand-wordmark` and `--brand-halo`. Those colour the
 * VeloExpense logo, which stays VeloExpense's whichever tenant is signed in.
 *
 * ── SELECTORS ───────────────────────────────────────────────────────────────
 *
 * `:root[data-app]` (0,2,0) so the tenant block beats the kit's
 * `[data-app='expense']` (0,1,0) on the same element whatever order the two
 * stylesheets load in. Dark mode mirrors the kit: `data-theme="dark"`, or the OS
 * setting when the app sets no `data-theme`. The kit never flips the ramp in
 * dark mode; it moves each role to a lighter step with dark ink, and this does
 * the same with the tenant's ramp.
 *
 * ── LIGHT-MODE ROLES, AND WHY EACH IS SAFE ──────────────────────────────────
 *
 *   primary       the tenant's own colour, with the foreground `readableForeground`
 *                 chose (white or ink) — unchanged from VX4-3.
 *   button        ramp 200 fill, ramp 800 ink, hover 300: the kit's soft-strong
 *                 shape. The test asserts >= 4.5:1 across a hue x lightness sweep.
 *   link          the tenant colour when it reads on white (>= 4.5:1), else ramp
 *                 700. A pale brand (#ffff88 is legal: ink reads on it) would
 *                 otherwise be a yellow link on a white page.
 *
 * Dark: primary/button = ramp 400 with the kit's dark ink #211c2b, hover 300,
 * link 400 — the kit's own dark rule, asserted the same way.
 */
import {
  brandRamp,
  contrastRatio,
  CONTRAST_FLOOR,
  normaliseHex,
  RAMP_STEPS,
  readableForeground,
  type BrandRamp,
} from '@/lib/branding/color';

/** The kit's dark-mode ink on brand fills (`velo-ink`, guidelines p.8). */
export const DARK_INK = '#211c2b';

const HEX = /^#[0-9a-f]{6}$/;

/**
 * Every value that reaches the stylesheet goes through here first.
 *
 * The interpolated values are all `#rrggbb` computed by `color.ts` from a column
 * with a `^#[0-9a-f]{6}$` CHECK, so there is no live injection path — this is the
 * assertion that keeps it that way. A future edit that interpolates a tenant NAME
 * or a font stack into this block would be a `</style>` away from being an XSS,
 * and it would fail here instead of shipping.
 */
function token(name: string, value: string): string {
  if (!HEX.test(value)) {
    throw new Error(`branding css: ${name} is not a #rrggbb value: ${JSON.stringify(value)}`);
  }
  return `${name}:${value}`;
}

function rampTokens(ramp: BrandRamp): string[] {
  return RAMP_STEPS.map((step) => token(`--brand-${step}`, ramp[step]));
}

export interface BrandCssResult {
  css: string;
  /** The chosen foreground and its ratio — the admin screen shows both. */
  foreground: { hex: string; ratio: number };
}

/**
 * The `<style>` body for a tenant, or null when there is nothing to override.
 *
 * Throws on a colour whose contrast is unusable, rather than falling back to the
 * default palette: a tenant whose colour was accepted by the form and silently
 * ignored by the renderer is the worst of the three outcomes. `setBrandColor`
 * refuses at the write, so reaching this throw means a row got past it.
 */
export function brandCss(brandColor: string | null): BrandCssResult | null {
  if (brandColor === null) return null;
  const brand = normaliseHex(brandColor);
  if (brand === null) throw new Error(`branding css: not a hex colour: ${JSON.stringify(brandColor)}`);
  const fg = readableForeground(brand);
  if (fg === null) {
    throw new Error(
      `branding css: ${brand} has no readable foreground — neither white nor ink reaches 4.5:1`,
    );
  }
  const ramp = brandRamp(brand);
  const link = contrastRatio(brand, '#ffffff') >= CONTRAST_FLOOR ? brand : ramp[700];

  const light = [
    ...rampTokens(ramp),
    token('--brand-primary', brand),
    token('--brand-on-primary', fg.hex),
    token('--brand-button', ramp[200]),
    token('--brand-on-button', ramp[800]),
    token('--brand-button-hover', ramp[300]),
    token('--brand-link', link),
  ].join(';');

  const dark = [
    token('--brand-primary', ramp[400]),
    token('--brand-on-primary', DARK_INK),
    token('--brand-button', ramp[400]),
    token('--brand-on-button', DARK_INK),
    token('--brand-button-hover', ramp[300]),
    token('--brand-link', ramp[400]),
  ].join(';');

  const css =
    `:root[data-app]{${light}}` +
    `:root[data-theme="dark"][data-app]{${dark}}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme])[data-app]{${dark}}}`;

  return { css, foreground: { hex: fg.hex, ratio: fg.ratio } };
}
