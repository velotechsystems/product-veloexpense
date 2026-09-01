/**
 * VX4-3 — turning a tenant's brand colour into the CSS that retints the product.
 * PURE: takes a hex, returns a string. No `pg`, no React, no env.
 *
 * ── WHAT IS BEING OVERRIDDEN, AND WHY IT IS SO FEW LINES ────────────────────
 *
 * `app/velotech-tokens.css` is indirected on purpose: every shadcn variable
 * references a `--vl-*` primitive ("change a --vl-* value and both the legacy vl-
 * UI and the shadcn components follow"). So overriding the eight brand primitives
 * moves `--primary`, `--ring`, `--accent`, the five `--chart-*` and the whole
 * sidebar without naming any of them. That indirection is the reason this is a
 * `:root` block and not the per-component surgery BR-3 describes on their side,
 * where the derived shades are flat hexes in the sheet.
 *
 * TWO THINGS DO NOT FOLLOW and must be named explicitly:
 *
 *   `--primary-foreground` / `--sidebar-primary-foreground` are `var(--vl-white)`,
 *   and white is not always readable on a tenant's colour. Overriding `--vl-white`
 *   instead would repaint every card and page background in the product, so the
 *   two foregrounds are set directly.
 *
 *   `--accent-foreground` is `var(--vl-brand-700)`, a DARK step, sitting on
 *   `--accent: var(--vl-brand-50)`. That reads in light mode and not in dark,
 *   where `--vl-brand-50` is itself a deep surface — see the a11y note below.
 *
 * ── ABSENT MEANS UNTOUCHED ──────────────────────────────────────────────────
 *
 * `brand_color IS NULL` emits NOTHING, so the hand-tuned VeloTech sky palette
 * renders exactly as it does today and no existing tenant's product changes
 * appearance because this ticket shipped. 0021's absence-means-off reasoning: an
 * absent brand colour and a brand colour that happens to equal our sky are not
 * the same fact, and only one of them should move when the default does.
 *
 * ── THE TWO ACCESSIBILITY DEFECTS THIS WORK FOUND IN THE SHIPPED PALETTE ────
 *
 * Both are in the default sheet, both are live today, and NEITHER is fixed here —
 * the sheet is shared VeloTech brand, so recolouring the product is not a call
 * this ticket gets to make. Reported so the numbers exist:
 *
 *   1. `--primary` #0284c7 with `--primary-foreground` white is **4.10:1**, below
 *      AA's 4.5 for the label on every primary button. Ink would be 4.36:1 — so
 *      the shipped pairing is the WORSE of the two available, and both are short.
 *      A consequence worth stating plainly: a tenant who types our own blue into
 *      the branding form is REFUSED by `readableForeground`, while a tenant who
 *      sets nothing is served that same blue. That is not special-cased. It is
 *      the rule reporting the defect.
 *
 *   2. In dark mode, `--accent-foreground` (`--vl-brand-700`, #075985) sits on
 *      `--accent` (`--vl-brand-50`, #0b2236) at **2.14:1** — the same pair is
 *      7.09:1 in light mode. Dark mode overrides the surface and not the text on
 *      it. A BRANDED tenant does not inherit this, because the dark block below
 *      also moves `--accent-foreground` to a light step (11.46:1 for sky), but an
 *      unbranded tenant still has it.
 */
import {
  brandDarkTints,
  brandRamp,
  normaliseHex,
  readableForeground,
  type BrandRamp,
} from '@/lib/branding/color';

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
  return (Object.keys(ramp) as unknown as (keyof BrandRamp)[]).map((step) =>
    token(`--vl-brand-${step}`, ramp[step]),
  );
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

  const light = brandRamp(brand);
  const dark = brandDarkTints(brand);

  const root = [
    token('--vl-brand', brand),
    ...rampTokens(light),
    // Chosen per tenant. `--vl-white` is deliberately NOT touched: it is the page
    // and card background too.
    token('--primary-foreground', fg.hex),
    token('--sidebar-primary-foreground', fg.hex),
  ].join(';');

  // Only the three deep surfaces the sheet itself replaces under dark mode, plus
  // the accent text that the sheet forgets to replace with them (defect 2 above).
  // The selector matches the sheet's exactly, including the `[data-theme='light']`
  // escape hatch — a narrower one would leave dark mode half-retinted, which is
  // the failure this block exists to prevent.
  const darkBody = [
    token('--vl-brand-50', dark[50]),
    token('--vl-brand-100', dark[100]),
    token('--vl-brand-200', dark[200]),
    token('--accent-foreground', light[200]),
    token('--sidebar-accent-foreground', light[200]),
  ].join(';');

  const css =
    `:root{${root}}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${darkBody}}}`;

  return { css, foreground: { hex: fg.hex, ratio: fg.ratio } };
}
