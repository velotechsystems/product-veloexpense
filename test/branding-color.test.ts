/**
 * VX4-3 — the branding colour maths. No database: this file is all arithmetic,
 * and the arithmetic is the part of the ticket that can be silently wrong.
 *
 * THE SHAPE OF THESE TESTS IS DELIBERATE. A transposed OKLab coefficient still
 * produces a plausible-looking colour, and a foreground chooser that always
 * answers white passes any test built from three hand-picked examples. So the
 * two things that could hide a real defect are asserted as PROPERTIES OVER A
 * SWEEP rather than as examples: the sRGB→OKLab→sRGB round trip, and the claim
 * that every foreground this module returns actually meets the floor while every
 * refusal genuinely has no readable option. That is the recurring lesson of this
 * port stated for colour — a check that cannot see one of the two outcomes hides
 * every bug in the outcome it cannot see.
 */
import { describe, it, expect } from 'vitest';
import {
  brandCss,
  DARK_INK,
} from '@/lib/branding/css';
import {
  brandRamp,
  RAMP_STEPS,
  CONTRAST_FLOOR,
  contrastRatio,
  FOREGROUND_INK,
  FOREGROUND_WHITE,
  hexToOklab,
  normaliseHex,
  oklabToHex,
  readableForeground,
  relativeLuminance,
} from '@/lib/branding/color';

/** Every third value per channel — 5,832 colours, enough to be a sweep and fast. */
function* sweep(stepSize = 51): Generator<string> {
  for (let r = 0; r < 256; r += stepSize)
    for (let g = 0; g < 256; g += stepSize)
      for (let b = 0; b < 256; b += stepSize)
        yield `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

const byteOf = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);

describe('normaliseHex (VX4-3)', () => {
  it('accepts the four spellings an admin actually types', () => {
    expect(normaliseHex('#0F766E')).toBe('#0f766e');
    expect(normaliseHex('0F766E')).toBe('#0f766e');
    expect(normaliseHex('#abc')).toBe('#aabbcc');
    expect(normaliseHex('  #0f766e  ')).toBe('#0f766e');
  });

  it('refuses everything else, including the near-misses', () => {
    // 8-digit is the dangerous one: `#0f766eff` is a real CSS colour, so a
    // permissive parser would take it and the column's CHECK would then reject
    // the row at the very bottom of the stack with a constraint name.
    for (const bad of ['#0f766eff', '#0f76', '#0f766', 'teal', '#gggggg', '', '#', '   ']) {
      expect(normaliseHex(bad), bad).toBeNull();
    }
  });
});

describe('OKLab conversion (VX4-3)', () => {
  it('round-trips every colour in the sweep to within one byte per channel', () => {
    let worst = 0;
    let worstHex = '';
    for (const hex of sweep()) {
      const back = oklabToHex(hexToOklab(hex));
      const err = Math.max(...[1, 3, 5].map((i) => Math.abs(byteOf(hex, i) - byteOf(back, i))));
      if (err > worst) {
        worst = err;
        worstHex = `${hex} -> ${back}`;
      }
    }
    // Measured 0 on Node 22 / arm64 and x86_64. The assertion allows 1 for
    // cbrt/pow rounding on another platform; a transposed coefficient produces
    // errors in the tens, which is what this is really watching for.
    expect(worst, worstHex).toBeLessThanOrEqual(1);
  });

  it('agrees with the two anchors everyone knows', () => {
    expect(hexToOklab('#ffffff').L).toBeCloseTo(1, 3);
    expect(hexToOklab('#000000').L).toBeCloseTo(0, 3);
    expect(oklabToHex({ L: 1, a: 0, b: 0 })).toBe('#ffffff');
  });
});

describe('WCAG contrast (VX4-3)', () => {
  it('matches the values the spec fixes', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2);
    expect(contrastRatio('#0f766e', '#0f766e')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#0284c7', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#0284c7'),
      9,
    );
  });

  /**
   * PINS A KNOWN DEFECT IN THE SHIPPED PALETTE, on purpose, so the number exists
   * somewhere a person will read. `--primary` is #0284c7 and `--primary-foreground`
   * is `--vl-white`, which is 4.10:1 — below AA's 4.5 for the label on every
   * primary button in the product. Ink would be 4.36:1, so the shipped pairing is
   * the WORSE of the two available and both are short.
   *
   * If somebody fixes the token sheet, THIS TEST FAILS, and that failure is the
   * intended signal: come back and delete it.
   */
  it('records that the DEFAULT palette fails AA on both foregrounds (BR-3 finding)', () => {
    expect(contrastRatio('#0284c7', FOREGROUND_WHITE)).toBeCloseTo(4.1, 1);
    expect(contrastRatio('#0284c7', FOREGROUND_INK)).toBeCloseTo(4.36, 1);
    expect(readableForeground('#0284c7')).toBeNull();
  });

  /**
   * The second shipped defect: dark mode replaces the accent SURFACE
   * (`--vl-brand-50` → #0b2236) and leaves the text on it (`--accent-foreground`
   * → `--vl-brand-700`, #075985). 7.09:1 in light, 2.14:1 in dark.
   */
  it('records that the DEFAULT dark-mode accent pairing is unreadable (BR-3 finding)', () => {
    expect(contrastRatio('#f0f9ff', '#075985')).toBeGreaterThan(CONTRAST_FLOOR);
    expect(contrastRatio('#0b2236', '#075985')).toBeLessThan(CONTRAST_FLOOR);
    expect(contrastRatio('#0b2236', '#075985')).toBeCloseTo(2.14, 1);
  });
});

describe('readableForeground (VX4-3)', () => {
  it('chooses per colour rather than always answering white', () => {
    // The whole point of the choice: yellow needs dark text, navy needs white,
    // and a chooser that always says white gets the first one catastrophically
    // wrong (1.07:1).
    expect(readableForeground('#ffff00')?.hex).toBe(FOREGROUND_INK);
    expect(readableForeground('#0c2340')?.hex).toBe(FOREGROUND_WHITE);
    expect(readableForeground('#16a34a')?.hex).toBe(FOREGROUND_INK);
    expect(readableForeground('#7c3aed')?.hex).toBe(FOREGROUND_WHITE);
  });

  it('reports the rejected candidate too, so an admin can see the trade', () => {
    const yellow = readableForeground('#ffff00');
    expect(yellow?.ratio).toBeGreaterThan(CONTRAST_FLOOR);
    expect(yellow?.alternativeRatio).toBeLessThan(1.2);
  });

  /**
   * THE PROPERTY, and the reason the examples above are not enough: over the whole
   * sweep, every answer must actually meet the floor, and every refusal must
   * actually have no option that does. A stub returning white always would fail
   * the first half; a stub returning null always would fail the second.
   */
  it('never returns a foreground below the floor, and never refuses a usable colour', () => {
    let chosen = 0;
    let refused = 0;
    for (const hex of sweep(17)) {
      const white = contrastRatio(hex, FOREGROUND_WHITE);
      const ink = contrastRatio(hex, FOREGROUND_INK);
      const best = Math.max(white, ink);
      const answer = readableForeground(hex);
      if (answer === null) {
        refused++;
        expect(best, `${hex} was refused but reaches ${best.toFixed(2)}:1`).toBeLessThan(
          CONTRAST_FLOOR,
        );
      } else {
        chosen++;
        expect(answer.ratio, hex).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
        expect(answer.ratio, hex).toBeCloseTo(best, 6);
        expect(contrastRatio(hex, answer.hex), hex).toBeCloseTo(answer.ratio, 6);
      }
    }
    // Both branches must be exercised, or this test is only half a test.
    expect(chosen).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    // ~6% of the 24-bit space is unusable. A wildly different number means the
    // floor or the ink anchor moved without anyone re-reading the decision.
    expect(refused / (chosen + refused)).toBeLessThan(0.12);
  });
});

describe('brandRamp (VX4-3, 2026 kit: eleven steps)', () => {
  const BRANDS = ['#0284c7', '#dc2626', '#16a34a', '#ffff00', '#7c3aed', '#111827', '#0f766e'];

  it('emits eleven valid hex steps for every brand', () => {
    for (const brand of BRANDS) {
      const ramp = brandRamp(brand);
      expect(Object.keys(ramp).map(Number).sort((a, b) => a - b)).toEqual([...RAMP_STEPS]);
      for (const step of RAMP_STEPS) {
        expect(ramp[step], `${brand} @ ${step}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('is strictly monotonic in lightness, 50 → 950', () => {
    for (const brand of BRANDS) {
      const ramp = brandRamp(brand);
      const ls = RAMP_STEPS.map((step) => hexToOklab(ramp[step]).L);
      for (let i = 1; i < ls.length; i++) {
        expect(ls[i], `${brand}: step ${RAMP_STEPS[i]} is not darker than ${RAMP_STEPS[i - 1]}`).toBeLessThan(
          ls[i - 1],
        );
      }
    }
  });

  it('keeps the brand hue rather than drifting to a neutral', () => {
    // A saturated brand must not produce a grey ramp: the a/b direction is
    // preserved by construction (chroma is SCALED, never rotated), and this is
    // the assertion that would catch someone "simplifying" it into an sRGB mix
    // toward white, which desaturates unevenly per hue.
    for (const brand of ['#dc2626', '#16a34a', '#7c3aed', '#0284c7']) {
      const base = hexToOklab(brand);
      for (const step of RAMP_STEPS) {
        const s = hexToOklab(brandRamp(brand)[step]);
        expect(Math.sign(s.a) === Math.sign(base.a) || Math.abs(s.a) < 0.02, `${brand} a @ ${step}`).toBe(true);
        expect(Math.sign(s.b) === Math.sign(base.b) || Math.abs(s.b) < 0.02, `${brand} b @ ${step}`).toBe(true);
      }
    }
  });

  it('keeps the seven VX4-3 steps where they were (a sky ramp close to the hand-tuned one)', () => {
    // The 2026 kit added 300/500/800/950; the original seven must not have moved,
    // or every branded tenant's product would shift colour in this release.
    const TAILWIND_SKY = { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 400: '#38bdf8', 600: '#0369a1', 700: '#075985', 900: '#082f49' } as const;
    const derived = brandRamp('#0284c7');
    for (const step of [50, 100, 200, 400, 600, 700, 900] as const) {
      const delta = Math.abs(hexToOklab(TAILWIND_SKY[step]).L - hexToOklab(derived[step]).L);
      expect(delta, `step ${step}`).toBeLessThan(0.06);
    }
  });
});

describe('brandCss (VX4-3, on the 2026 kit)', () => {
  /** `--name:#hex` out of one block of the emitted CSS. */
  const read = (block: string, name: string) =>
    new RegExp(`${name.replace(/-/g, '\\-')}:(#[0-9a-f]{6})(?:;|\\})`).exec(block)?.[1];
  const blocks = (css: string) => {
    const light = css.slice(0, css.indexOf(':root[data-theme="dark"]'));
    const dark = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('@media'));
    const media = css.slice(css.indexOf('@media'));
    return { light, dark, media };
  };

  it('emits nothing at all when the tenant has no brand colour', () => {
    // Absence means untouched: no existing tenant's product changes appearance
    // because this ticket shipped.
    expect(brandCss(null)).toBeNull();
  });

  it('re-binds the eleven --brand-* steps and every role the kit binds to the product', () => {
    const { light, dark } = blocks(brandCss('#0f766e')!.css);
    expect(read(light, '--brand-primary')).toBe('#0f766e');
    for (const step of RAMP_STEPS) expect(read(light, `--brand-${step}`), `step ${step}`).toBeDefined();
    for (const role of ['primary', 'on-primary', 'button', 'on-button', 'button-hover', 'link']) {
      expect(read(light, `--brand-${role}`), `light ${role}`).toBeDefined();
      expect(read(dark, `--brand-${role}`), `dark ${role}`).toBeDefined();
    }
  });

  it('never touches the VeloExpense logo colours, the page surfaces or the old --vl-* names', () => {
    const css = brandCss('#0f766e')!.css;
    expect(css).not.toContain('--brand-wordmark');
    expect(css).not.toContain('--brand-halo');
    expect(css).not.toContain('--vl-');
    expect(css).not.toMatch(/--(background|card|popover):/);
  });

  it('out-ranks the kit\'s [data-app] binding, and mirrors both of its dark-mode selectors', () => {
    // (0,2,0) beats the kit's [data-app='expense'] (0,1,0) on <html> regardless of
    // which stylesheet the browser sees last.
    const css = brandCss('#0f766e')!.css;
    expect(css.startsWith(':root[data-app]{')).toBe(true);
    expect(css).toContain(':root[data-theme="dark"][data-app]{');
    expect(css).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme])[data-app]{');
    // The two dark blocks must carry the same declarations.
    const { dark, media } = blocks(css);
    expect(media.slice(media.indexOf('{', media.indexOf('[data-app]')) + 1, -2)).toBe(
      dark.slice(dark.indexOf('{') + 1, -1),
    );
  });

  /**
   * Every pair a tenant colour now paints, asserted as a RATIO over a sweep —
   * "the declaration is present" would pass with an unreadable button.
   */
  it('keeps every text-on-fill pair at or above 4.5:1, light and dark, across a colour sweep', () => {
    let checked = 0;
    for (const hex of sweep(51)) {
      if (readableForeground(hex) === null) continue; // refused at the write
      const { light, dark } = blocks(brandCss(hex)!.css);
      const ramp = brandRamp(hex);
      const pairs: Array<[string, string, string]> = [
        ['light primary', read(light, '--brand-primary')!, read(light, '--brand-on-primary')!],
        ['light button', read(light, '--brand-button')!, read(light, '--brand-on-button')!],
        ['light link on white', '#ffffff', read(light, '--brand-link')!],
        ['light accent text (800 on 50)', ramp[50], ramp[800]],
        ['dark primary', read(dark, '--brand-primary')!, DARK_INK],
        ['dark button', read(dark, '--brand-button')!, read(dark, '--brand-on-button')!],
      ];
      for (const [label, bg, fg] of pairs) {
        expect(contrastRatio(bg, fg), `${hex} ${label}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('uses the tenant colour for links only where it reads on white', () => {
    // #0f766e is 5.05:1 on white — kept. #ffff88 is legal (ink reads on it) but a
    // yellow link on a white page is not, so the link drops to ramp 700.
    expect(read(blocks(brandCss('#0f766e')!.css).light, '--brand-link')).toBe('#0f766e');
    const pale = brandCss('#ffff88')!.css;
    expect(read(blocks(pale).light, '--brand-link')).toBe(brandRamp('#ffff88')[700]);
  });

  it('is nothing but custom properties — no selector, string or tag can appear', () => {
    // The guard in `token()` is what enforces this; this is the assertion that
    // proves the guard is wired to every value. A future edit interpolating a
    // tenant NAME here would be a `</style>` away from an XSS and would fail.
    const css = brandCss('#0f766e')!.css;
    const decls = '(?:--[a-z0-9-]+:#[0-9a-f]{6};)*--[a-z0-9-]+:#[0-9a-f]{6}';
    expect(css).toMatch(
      new RegExp(
        `^:root\\[data-app\\]\\{${decls}\\}` +
          `:root\\[data-theme="dark"\\]\\[data-app\\]\\{${decls}\\}` +
          `@media \\(prefers-color-scheme:dark\\)\\{:root:not\\(\\[data-theme\\]\\)\\[data-app\\]\\{${decls}\\}\\}$`,
      ),
    );
  });

  it('refuses to render a colour with no readable foreground', () => {
    // A tenant whose colour was accepted at the form and silently ignored by the
    // renderer is the worst of the three outcomes, so this throws rather than
    // returning null and letting the caller fall back to the default palette.
    //
    // `#7f7f7f` is mid-grey: 4.00:1 against white and 4.46:1 against ink, so it
    // fails BOTH — which is the only way to reach this branch. The genuinely
    // unusable band is the MIDDLE of the luminance range.
    expect(() => brandCss('#7f7f7f')).toThrow(/no readable foreground/);
    expect(() => brandCss('#0284c7')).toThrow(/no readable foreground/);
    // Pale colours are the easy case (10:1 against ink), asserted so it stays one.
    expect(brandCss('#ffff88')).not.toBeNull();
  });
});
