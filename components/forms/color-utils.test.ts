import { describe, expect, it } from 'vitest';
import { type ColorFormat, detectFormat, formatColor, parseColor, type RGBA } from './color-utils';

/**
 * Colour parsing and formatting for `ColorInput`.
 *
 * This backs the category / class colour pickers, so what actually goes wrong here is
 * quiet rather than loud: a value that fails to parse falls back to black, and a colour
 * that does not survive a parse→format round trip DRIFTS every time the picker re-renders
 * it. Nobody reports "my green got slightly greener"; they just end up with two categories
 * that used to be distinguishable and no longer are.
 *
 * So the round trips are the centre of this file, not the individual conversions. A test
 * per function would confirm each half in isolation and still let the pair disagree.
 */

const rgba = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });

describe('parseColor — hex', () => {
  it('reads 6-digit hex, case-insensitively', () => {
    expect(parseColor('#4A90D9')).toEqual(rgba(74, 144, 217));
    expect(parseColor('#4a90d9')).toEqual(rgba(74, 144, 217));
  });

  it('expands 3-digit hex by DOUBLING each digit, not by padding', () => {
    // `#f00` is `#ff0000`, not `#f00000`. Padding instead of doubling is the classic
    // error, and it is invisible on greys (`#888` → `#888888` either way) which is why
    // this asserts a saturated colour.
    expect(parseColor('#f00')).toEqual(rgba(255, 0, 0));
    expect(parseColor('#abc')).toEqual(rgba(170, 187, 204));
  });

  it('reads the alpha nibble of a 4-digit hex', () => {
    expect(parseColor('#f008')).toEqual(rgba(255, 0, 0, 136 / 255));
  });

  it('reads 8-digit hex alpha as a fraction of 255', () => {
    expect(parseColor('#4a90d9ff')).toEqual(rgba(74, 144, 217, 1));
    expect(parseColor('#4a90d900')).toEqual(rgba(74, 144, 217, 0));
    expect(parseColor('#4a90d980')).toEqual(rgba(74, 144, 217, 128 / 255));
  });

  it('tolerates surrounding whitespace', () => {
    // Values arrive from a text field, so a stray space is a paste artefact rather than
    // an invalid colour.
    expect(parseColor('  #f00  ')).toEqual(rgba(255, 0, 0));
  });

  it('rejects hex of the wrong length or with non-hex digits', () => {
    // Each of these would otherwise be a partial match — the anchors are what stop
    // `#ff00zz` from parsing as `#ff00`.
    for (const bad of ['#', '#ff', '#fffff', '#fffffff', '#ff00zz', '#gg0000', 'ff0000']) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });
});

describe('parseColor — rgb / rgba', () => {
  it('reads comma-separated rgb', () => {
    expect(parseColor('rgb(74, 144, 217)')).toEqual(rgba(74, 144, 217));
  });

  it('reads space-separated modern syntax with a slash alpha', () => {
    // `rgb(74 144 217 / 0.5)` is the current CSS form; a picker that only understood the
    // legacy comma syntax would black out a value the browser itself produced.
    expect(parseColor('rgb(74 144 217 / 0.5)')).toEqual(rgba(74, 144, 217, 0.5));
  });

  it('reads rgba with a decimal alpha', () => {
    expect(parseColor('rgba(0, 0, 0, 0.25)')).toEqual(rgba(0, 0, 0, 0.25));
  });

  it('reads a percentage alpha', () => {
    expect(parseColor('rgba(0, 0, 0, 50%)')).toEqual(rgba(0, 0, 0, 0.5));
  });

  it('defaults a missing alpha to opaque, not to zero', () => {
    // The failure this pins is a colour that silently becomes invisible.
    expect(parseColor('rgb(1, 2, 3)')?.a).toBe(1);
  });

  it('clamps channels ABOVE range rather than rejecting them', () => {
    // `rgb(300, ...)` is what a bad interpolation produces. Clamping keeps the picker
    // usable; rejecting would drop the user back to black.
    expect(parseColor('rgb(300, 400, 999)')).toEqual(rgba(255, 255, 255));
  });

  it('clamps alpha above 1', () => {
    expect(parseColor('rgba(0,0,0,2)')?.a).toBe(1);
  });

  it('rejects NEGATIVE numbers outright — they do not clamp to zero', () => {
    /**
     * An asymmetry worth knowing about, asserted as it behaves rather than as it
     * "should": above-range values clamp, but a single negative number makes the WHOLE
     * colour unparseable, so the caller falls back to black.
     *
     * The cause is the number pattern (`[\d.]+`), which has no sign. CSS would clamp
     * `rgb(-20, 50, 50)` to `rgb(0, 50, 50)`, so this is a real divergence — left alone
     * deliberately: nothing in the UI produces a negative channel (the sliders are
     * bounded and `getComputedStyle` never returns one), and widening the pattern to
     * accept signs would also make it accept `1-2` and other nonsense. Pinned so the
     * divergence is a known choice rather than a surprise.
     */
    expect(parseColor('rgb(300, -20, 999)')).toBeNull();
    expect(parseColor('rgba(0,0,0,-1)')).toBeNull();
    expect(parseColor('hsl(-60, 100%, 50%)')).toBeNull();
  });
});

describe('parseColor — hsl / hsla', () => {
  it('converts the primary hues correctly', () => {
    // One per 60° sector, because `hslToRgb` is a six-branch conditional and a
    // misordered branch swaps two hues while leaving the rest right.
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual(rgba(255, 0, 0));
    expect(parseColor('hsl(60, 100%, 50%)')).toEqual(rgba(255, 255, 0));
    expect(parseColor('hsl(120, 100%, 50%)')).toEqual(rgba(0, 255, 0));
    expect(parseColor('hsl(180, 100%, 50%)')).toEqual(rgba(0, 255, 255));
    expect(parseColor('hsl(240, 100%, 50%)')).toEqual(rgba(0, 0, 255));
    expect(parseColor('hsl(300, 100%, 50%)')).toEqual(rgba(255, 0, 255));
  });

  it('treats zero saturation as grey at any hue', () => {
    expect(parseColor('hsl(0, 0%, 50%)')).toEqual(rgba(128, 128, 128));
    expect(parseColor('hsl(200, 0%, 50%)')).toEqual(rgba(128, 128, 128));
  });

  it('handles the lightness extremes', () => {
    expect(parseColor('hsl(120, 100%, 0%)')).toEqual(rgba(0, 0, 0));
    expect(parseColor('hsl(120, 100%, 100%)')).toEqual(rgba(255, 255, 255));
  });

  it('wraps hue modulo 360, so 360 and 0 agree', () => {
    // A hue slider that reaches 360 must not fall through to the final `else` branch and
    // emit magenta where red belongs.
    expect(parseColor('hsl(360, 100%, 50%)')).toEqual(parseColor('hsl(0, 100%, 50%)'));
    expect(parseColor('hsl(480, 100%, 50%)')).toEqual(parseColor('hsl(120, 100%, 50%)'));
  });

  it('accepts a deg suffix and the space/slash syntax', () => {
    expect(parseColor('hsl(120deg 100% 50%)')).toEqual(rgba(0, 255, 0));
    expect(parseColor('hsl(120deg 100% 50% / 0.5)')).toEqual(rgba(0, 255, 0, 0.5));
  });

  it('reads hsla alpha', () => {
    expect(parseColor('hsla(120, 100%, 50%, 0.5)')).toEqual(rgba(0, 255, 0, 0.5));
  });
});

describe('parseColor — rejections', () => {
  it('returns null rather than a default for anything unparseable', () => {
    // Null is what lets the caller distinguish "not a colour yet" from black. A silent
    // `#000000` here is how a half-typed value becomes a saved black.
    for (const bad of ['', '   ', 'red', 'blue', 'not a color', 'rgb()', 'hsl(1)', '#']) {
      expect(parseColor(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('formatColor', () => {
  it('emits 6-digit hex when opaque and 8-digit when not', () => {
    expect(formatColor(rgba(74, 144, 217), 'hex')).toBe('#4a90d9');
    expect(formatColor(rgba(74, 144, 217, 0.5), 'hex')).toBe('#4a90d980');
  });

  it('zero-pads each hex channel', () => {
    // `#f0000` — a channel that dropped its leading zero — is a value nothing can parse.
    expect(formatColor(rgba(15, 0, 0), 'hex')).toBe('#0f0000');
  });

  it('emits rgb() when opaque and rgba() when not', () => {
    expect(formatColor(rgba(1, 2, 3), 'rgb')).toBe('rgb(1, 2, 3)');
    expect(formatColor(rgba(1, 2, 3, 0.5), 'rgb')).toBe('rgba(1, 2, 3, 0.5)');
  });

  it('emits hsl() when opaque and hsla() when not', () => {
    expect(formatColor(rgba(255, 0, 0), 'hsl')).toBe('hsl(0, 100%, 50%)');
    expect(formatColor(rgba(255, 0, 0, 0.5), 'hsl')).toBe('hsla(0, 100%, 50%, 0.5)');
  });

  it('trims trailing zeros off the alpha', () => {
    // `rgba(0, 0, 0, 0.50)` is valid CSS but reads as machine output in a text field the
    // user is expected to edit.
    expect(formatColor(rgba(0, 0, 0, 0.5), 'rgb')).toContain('0.5)');
    expect(formatColor(rgba(0, 0, 0, 0.25), 'rgb')).toContain('0.25)');
  });

  it('rounds fractional channels, and clamps out-of-range ones', () => {
    // `parseColor` does not round rgb channels, so fractional values genuinely reach here.
    expect(formatColor(rgba(1.6, 2.4, 3.5), 'rgb')).toBe('rgb(2, 2, 4)');
    expect(formatColor(rgba(-5, 300, 0), 'hex')).toBe('#00ff00');
  });
});

describe('round trips — the property the picker depends on', () => {
  const SAMPLES = [
    '#000000',
    '#ffffff',
    '#4a90d9',
    '#0f0000',
    '#123456',
    '#abcdef',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#808080',
  ];

  it('hex survives parse → format → parse unchanged', () => {
    // The picker formats what it parsed on every render, so a lossy round trip is a
    // colour that walks away from the one that was chosen.
    for (const hex of SAMPLES) {
      expect(formatColor(parseColor(hex) as RGBA, 'hex'), hex).toBe(hex);
    }
  });

  it('hex and rgb re-parse EXACTLY; hsl is allowed to lose up to 2/255', () => {
    /**
     * hex and rgb are lossless and held to it. hsl is not: `rgbToHsl` rounds h, s and l
     * to integers, and integer hsl cannot address every one of the 16.7M rgb triples.
     * Measured worst case across these samples is 2/255 on one channel (`#123456` →
     * `#123354`), which is imperceptible.
     *
     * The bound is asserted rather than waved through, because a hue landing in the wrong
     * 60° sector — the failure that actually matters — would blow past it immediately.
     */
    for (const hex of SAMPLES) {
      const original = parseColor(hex) as RGBA;
      for (const format of ['hex', 'rgb', 'hsl'] as ColorFormat[]) {
        const reparsed = parseColor(formatColor(original, format));
        expect(reparsed, `${hex} via ${format}`).not.toBeNull();
        const tolerance = format === 'hsl' ? 2 : 0;
        for (const ch of ['r', 'g', 'b'] as const) {
          expect(
            Math.abs((reparsed as RGBA)[ch] - original[ch]),
            `${hex} ${ch} via ${format}`,
          ).toBeLessThanOrEqual(tolerance);
        }
        // Alpha is exact in every format — it is stored as a fraction and formatted to
        // two places, so there is no rounding to absorb.
        expect((reparsed as RGBA).a, `${hex} a via ${format}`).toBe(original.a);
      }
    }
  });

  it('the hsl loss CONVERGES — it does not compound on every re-render', () => {
    /**
     * The property that makes the 2/255 above acceptable, and the one that would make it
     * unacceptable if it failed.
     *
     * `ColorInput` formats what it parsed on every render. If each hsl round trip nudged
     * the colour again, a picker left open would walk a category's colour away from the
     * one that was chosen — slowly, invisibly, and without anything to point at. It does
     * not: the value reaches a fixed point after ONE round trip and then stops moving.
     * Twenty-five iterations is far more than any render loop, so a drift that compounded
     * even slightly would show here.
     */
    for (const hex of SAMPLES) {
      const first = formatColor(parseColor(hex) as RGBA, 'hsl');
      const afterOne = formatColor(parseColor(first) as RGBA, 'hex');

      let current = first;
      for (let i = 0; i < 25; i++) {
        current = formatColor(parseColor(current) as RGBA, 'hsl');
      }
      const afterMany = formatColor(parseColor(current) as RGBA, 'hex');

      expect(afterMany, `${hex} drifted between round trip 1 and 26`).toBe(afterOne);
    }
  });

  it('alpha survives every format', () => {
    for (const a of [0, 0.25, 0.5, 0.75, 1]) {
      for (const format of ['rgb', 'hsl'] as ColorFormat[]) {
        const out = parseColor(formatColor(rgba(74, 144, 217, a), format));
        expect(out?.a, `a=${a} via ${format}`).toBeCloseTo(a, 2);
      }
    }
  });

  it('a full hue sweep stays in its sector through hsl', () => {
    // Guards the six-branch conditional across every boundary rather than at six points.
    // A branch whose bound is off by one degree survives sampling the sector midpoints
    // and fails here.
    for (let h = 0; h < 360; h += 5) {
      const viaHsl = parseColor(`hsl(${h}, 100%, 50%)`) as RGBA;
      const again = parseColor(formatColor(viaHsl, 'hsl')) as RGBA;
      for (const ch of ['r', 'g', 'b'] as const) {
        expect(Math.abs(again[ch] - viaHsl[ch]), `h=${h} ${ch}`).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('detectFormat', () => {
  it('recognises each family', () => {
    expect(detectFormat('#fff')).toBe('hex');
    expect(detectFormat('rgb(1,2,3)')).toBe('rgb');
    expect(detectFormat('rgba(1,2,3,1)')).toBe('rgb');
    expect(detectFormat('hsl(1,2%,3%)')).toBe('hsl');
    expect(detectFormat('hsla(1,2%,3%,1)')).toBe('hsl');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(detectFormat('  RGB(1,2,3)  ')).toBe('rgb');
    expect(detectFormat('HSLA(1,2%,3%,1)')).toBe('hsl');
  });

  it('defaults to hex for nothing and for anything unrecognised', () => {
    // The default decides which control the picker shows first, so it has to be the one
    // that can represent any colour.
    expect(detectFormat(null)).toBe('hex');
    expect(detectFormat(undefined)).toBe('hex');
    expect(detectFormat('')).toBe('hex');
    expect(detectFormat('goldenrod')).toBe('hex');
  });

  it('round-trips with formatColor: what it detects is what was emitted', () => {
    // Otherwise the picker re-opens in a different mode than the value was written in,
    // and editing it silently rewrites the format.
    for (const format of ['hex', 'rgb', 'hsl'] as ColorFormat[]) {
      expect(detectFormat(formatColor(rgba(74, 144, 217), format)), format).toBe(format);
      expect(detectFormat(formatColor(rgba(74, 144, 217, 0.5), format)), `${format} alpha`).toBe(
        format,
      );
    }
  });
});
