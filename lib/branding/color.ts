/**
 * VX4-3 — the colour maths behind per-tenant branding. PURE: no `pg`, no env,
 * no imports. Everything a tenant sees is DERIVED from one hex, here.
 *
 * ── WHY THIS FILE EXISTS AT ALL (GAP-AUDIT BR-3) ────────────────────────────
 *
 * ExpenseOS can be retinted at the top — Tailwind 4 `@theme` declares
 * `--color-primary: #f76b15` and components read the custom property at runtime,
 * so a server-injected `:root` block moves the product. What it cannot move is
 * every shade DERIVED from that primary, because those are hardcoded hexes:
 * `--color-row-selected: #fff8f3`, `--color-row-active: #fee9dc`, and a set of
 * WCAG-tuned white-on-navy alphas. A tenant who picks blue gets orange-tinted
 * row highlights.
 *
 * VeloExpense starts in a better place and a worse one. Better: our token sheet
 * is already indirected — every shadcn variable references a `--vl-*` primitive,
 * so overriding the primitives moves the sidebar, the ring, the charts and dark
 * mode together, which is a structural advantage over their flat hexes. Worse:
 * there are EIGHT hardcoded sky steps (`--vl-brand-50 … -900`) plus five chart
 * colours pointing at them, so a tenant who overrides only `--vl-brand` gets a
 * green button on sky-blue accents. Deriving the ramp IS the ticket.
 *
 * (2026 kit: the names are now `--brand-50 … -950` bound through `data-app`,
 * eleven steps instead of seven; the reasoning is unchanged. See css.ts.)
 *
 * ── THE TRAP THEIR CODE ALREADY PAID FOR: DERIVED SHADES MUST BE SOLID ──────
 *
 * The obvious implementation is alpha — `bg-primary/15` and be done. Their
 * `rowState.ts` is the recorded reason not to: "MUST be a solid color, not
 * `bg-primary/15`: translucent alpha layers compound between the <tr> and any
 * sticky <td>, making the leading cell visibly darker. Solid layers don't
 * compound." So every value this module emits is an opaque `#rrggbb`. (Their two
 * comments disagree about whether `row-selected` is primary-at-5% or at-15% —
 * globals.css says 5%, rowState.ts says 15%, and the hex is 5%. Two places
 * documenting one derived value, drifting: the argument for deriving it.)
 *
 * ── WHY COMPUTE IN TYPESCRIPT RATHER THAN EMIT `color-mix()` ────────────────
 *
 * `color-mix(in oklab, …)` would produce solid colours, cost no maths, and get
 * dark mode free by mixing against a token that flips. It was rejected for one
 * reason: a test over a CSS string containing `color-mix(...)` asserts nothing
 * about the resulting colour. That is this project's recurring lesson wearing a
 * new hat — a check that cannot see one of the two outcomes hides every bug in
 * the outcome it cannot see. Computed hexes can be asserted: monotonic in
 * lightness, contrast floors met, round-trip stable. So we compute.
 *
 * ── AND WHY OKLAB RATHER THAN sRGB ──────────────────────────────────────────
 *
 * Mixing in sRGB toward white desaturates into chalk and toward black into mud,
 * unevenly per hue — a yellow tenant and a blue tenant would get ramps of
 * visibly different quality. OKLab is perceptually uniform, so one set of
 * lightness targets behaves the same for every hue, and the ramp is monotonic in
 * lightness BY CONSTRUCTION rather than by luck. Ottosson's coefficients, and
 * `test/branding-color.test.ts` pins the sRGB→OKLab→sRGB round trip to ±1/255
 * because a transposed coefficient is otherwise invisible: it still yields a
 * plausible-looking colour.
 */

/* ── hex ─────────────────────────────────────────────────────────────────── */

/**
 * `#rrggbb`, lowercase, or null. Accepts 3- and 6-digit input with or without
 * the hash, because an admin pasting from a brand guide types all four.
 *
 * ONE SPELLING REACHES THE DATABASE. `0023`'s CHECK is deliberately strict
 * (`^#[0-9a-f]{6}$`) rather than forgiving, and this is the normaliser that
 * makes strictness usable: a permissive column plus a normalising writer means
 * the SECOND writer decides the format, and there is always a second writer.
 */
export function normaliseHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  return null;
}

function toRgb(hex: string): [number, number, number] {
  const h = normaliseHex(hex);
  if (h === null) throw new Error(`not a hex colour: ${JSON.stringify(hex)}`);
  return [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function toHex([r, g, b]: [number, number, number]): string {
  const byte = (x: number) =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/* ── sRGB transfer function ──────────────────────────────────────────────── */
//
// Used by BOTH the WCAG luminance below and the OKLab conversion, and they need
// the same curve for the same reason: sRGB values are gamma-encoded, so
// averaging or weighting them directly is arithmetic on the wrong quantity.

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(clamp01(c), 1 / 2.4) - 0.055;

/* ── WCAG contrast ──────────────────────────────────────────────────────── */

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1..21, order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/* ── OKLab ──────────────────────────────────────────────────────────────── */

export interface Oklab {
  L: number;
  a: number;
  b: number;
}

export function hexToOklab(hex: string): Oklab {
  const [r, g, b] = toRgb(hex).map(toLinear) as [number, number, number];
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

export function oklabToHex({ L, a, b }: Oklab): string {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return toHex([
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]);
}

/**
 * `oklch(L C h)` (h in degrees) as `#rrggbb`, GAMUT-MAPPED the way CSS Color 4
 * describes: when the colour is outside sRGB, chroma is reduced at constant
 * lightness until it fits, rather than clipping each channel.
 *
 * The difference is not cosmetic. VeloExpense's primary, oklch(0.55 0.15 222),
 * is outside sRGB; clipped per channel it is #0082af, 4.36:1 against white —
 * under AA. Chroma-reduced it is #037e9c, 4.70:1. The brand guidelines' "every
 * product passes at L 0.55" holds only for the second. Email needs a hex, so this
 * is the one that is written down; see email-shell.ts.
 */
export function oklchToHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const linear = (c: number): [number, number, number] => {
    const a = c * Math.cos(h);
    const b = c * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  };
  const inGamut = (c: number) => linear(c).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let lo = 0;
  let hi = C;
  if (!inGamut(C)) {
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
  } else {
    lo = C;
  }
  return oklabToHex({ L, a: lo * Math.cos(h), b: lo * Math.sin(h) });
}

/* ── the derived ramp ───────────────────────────────────────────────────── */

/**
 * The eleven `--brand-*` steps of the 2026 kit (`app/velotech-tokens.css`), keyed
 * exactly as the CSS names them so the injector cannot drift from the sheet.
 *
 * 2026 brand edition: every product owns an 11-stop ramp (`--<app>-50 … -950`)
 * and the shell binds it to `--brand-*` through `data-app`. A branded tenant
 * re-binds the same eleven names. Before the 2026 kit this was seven `--vl-brand-*`
 * steps; 300, 500, 800 and 950 are new because the kit's roles read them
 * (button hover = 300, button ink and accent text = 800).
 *
 * The numbers are lightness-ordered, light to dark, like the kit's ramps.
 */
export interface BrandRamp {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
  950: string;
}

/** The ramp's steps, light to dark. */
export const RAMP_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/**
 * Lightness targets in OKLab, plus a chroma multiplier per step.
 *
 * THE CHROMA TAPER IS THE PART THAT IS NOT OBVIOUS. Holding chroma constant while
 * pushing L to 0.97 produces a fluorescent pastel, and at L 0.32 a black-mud
 * navy that has lost the hue entirely. Tapering it at both ends is what makes a
 * generated ramp look chosen rather than computed — and it is the same shape
 * Tailwind's own scales have when you measure them.
 *
 * The seven original steps are unchanged (VX4-3); 300, 500, 800 and 950 sit
 * between their neighbours on the same taper. Dark mode needs no separate tints
 * any more: the 2026 kit never flips the ramp, it only picks a lighter step for
 * each role (`test/branding-color.test.ts` asserts the contrast of every pair).
 */
const LIGHT_STEPS: Record<keyof BrandRamp, { L: number; c: number }> = {
  50: { L: 0.977, c: 0.16 },
  100: { L: 0.949, c: 0.3 },
  200: { L: 0.888, c: 0.55 },
  300: { L: 0.835, c: 0.75 },
  400: { L: 0.783, c: 0.92 },
  500: { L: 0.66, c: 0.97 },
  600: { L: 0.552, c: 1.0 },
  700: { L: 0.463, c: 0.94 },
  800: { L: 0.39, c: 0.82 },
  900: { L: 0.323, c: 0.7 },
  950: { L: 0.245, c: 0.5 },
};

function atLightness(base: Oklab, L: number, chromaScale: number): string {
  return oklabToHex({ L, a: base.a * chromaScale, b: base.b * chromaScale });
}

/** The eleven steps, derived from one brand hex. */
export function brandRamp(brand: string): BrandRamp {
  const base = hexToOklab(brand);
  const ramp = {} as BrandRamp;
  for (const step of RAMP_STEPS) ramp[step] = atLightness(base, LIGHT_STEPS[step].L, LIGHT_STEPS[step].c);
  return ramp;
}

/* ── the readable foreground ─────────────────────────────────────────────── */

/**
 * `--primary-foreground` is `--vl-white` in the shipped sheet, which is correct
 * for our sky and wrong for a tenant who picks yellow: white on `#ffff00` is
 * 1.07:1. So the foreground is CHOSEN per tenant, not fixed.
 *
 * John's call, 1 Sep: pick whichever of white and ink reads, and refuse only a
 * colour where NEITHER does. The alternatives were both worse — refusing
 * everything that fails against white rejects most yellows, light greens and
 * cyans and gives the admin no way to comply, and silently darkening the colour
 * until it passes renders a brand the tenant did not choose with nothing on
 * screen saying so, which is exactly the silent-default class PE-8 just cost us.
 */
export const FOREGROUND_WHITE = '#ffffff';
/** `--vl-ink-900` from the token sheet — the same ink body text uses. */
export const FOREGROUND_INK = '#0f172a';

/** WCAG AA for normal text. Buttons carry labels, so AA-large is not enough. */
export const CONTRAST_FLOOR = 4.5;

export interface ForegroundChoice {
  hex: string;
  ratio: number;
  /** The ratio the rejected candidate would have given — for the admin screen. */
  alternativeRatio: number;
}

/**
 * The readable foreground for a brand colour, or null when neither candidate
 * reaches {@link CONTRAST_FLOOR}. Null is a REFUSAL, and the service turns it
 * into one — a caller that treats it as "use white then" has reintroduced the
 * bug this function exists to prevent.
 */
export function readableForeground(brand: string): ForegroundChoice | null {
  const white = contrastRatio(brand, FOREGROUND_WHITE);
  const ink = contrastRatio(brand, FOREGROUND_INK);
  const [hex, ratio, alternativeRatio] =
    white >= ink ? [FOREGROUND_WHITE, white, ink] : [FOREGROUND_INK, ink, white];
  if (ratio < CONTRAST_FLOOR) return null;
  return { hex, ratio, alternativeRatio };
}
