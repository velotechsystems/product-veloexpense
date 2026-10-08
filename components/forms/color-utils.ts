/**
 * Tiny color-conversion utility used by ColorInput.
 *
 * Parses any of: `#RGB`, `#RRGGBB`, `#RRGGBBAA`, `rgb(...)`, `rgba(...)`,
 * `hsl(...)`, `hsla(...)` into a normalized `{ r, g, b, a }` shape, and
 * formats back into any of the same forms. Intentionally NOT a general
 * color library — covers exactly what the form picker needs.
 *
 * Each channel: r, g, b in [0,255]; a in [0,1].
 */

export type ColorFormat = 'hex' | 'rgb' | 'hsl';

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX_3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_4 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX_8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FN =
  /^rgba?\(\s*([\d.]+)\s*[ ,]\s*([\d.]+)\s*[ ,]\s*([\d.]+)\s*(?:[ ,/]\s*([\d.]+%?))?\s*\)$/i;
const HSL_FN =
  /^hsla?\(\s*([\d.]+)(?:deg)?\s*[ ,]\s*([\d.]+)%?\s*[ ,]\s*([\d.]+)%?\s*(?:[ ,/]\s*([\d.]+%?))?\s*\)$/i;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n);

/** Parse any supported CSS color string. Returns null if unparseable. */
export function parseColor(value: string): RGBA | null {
  if (!value) return null;
  const v = value.trim();

  // Hex
  let m = HEX_8.exec(v);
  if (m)
    return {
      r: parseInt(m[1], 16),
      g: parseInt(m[2], 16),
      b: parseInt(m[3], 16),
      a: parseInt(m[4], 16) / 255,
    };
  m = HEX_6.exec(v);
  if (m)
    return {
      r: parseInt(m[1], 16),
      g: parseInt(m[2], 16),
      b: parseInt(m[3], 16),
      a: 1,
    };
  m = HEX_4.exec(v);
  if (m)
    return {
      r: parseInt(m[1] + m[1], 16),
      g: parseInt(m[2] + m[2], 16),
      b: parseInt(m[3] + m[3], 16),
      a: parseInt(m[4] + m[4], 16) / 255,
    };
  m = HEX_3.exec(v);
  if (m)
    return {
      r: parseInt(m[1] + m[1], 16),
      g: parseInt(m[2] + m[2], 16),
      b: parseInt(m[3] + m[3], 16),
      a: 1,
    };

  // rgb / rgba
  m = RGB_FN.exec(v);
  if (m) {
    return {
      r: clamp(Number(m[1]), 0, 255),
      g: clamp(Number(m[2]), 0, 255),
      b: clamp(Number(m[3]), 0, 255),
      a: parseAlphaFragment(m[4]),
    };
  }

  // hsl / hsla
  m = HSL_FN.exec(v);
  if (m) {
    const h = ((Number(m[1]) % 360) + 360) % 360;
    const s = clamp(Number(m[2]), 0, 100) / 100;
    const l = clamp(Number(m[3]), 0, 100) / 100;
    const { r, g, b } = hslToRgb(h, s, l);
    return { r, g, b, a: parseAlphaFragment(m[4]) };
  }

  return null;
}

function parseAlphaFragment(raw: string | undefined): number {
  if (raw == null) return 1;
  if (raw.endsWith('%')) return clamp(Number(raw.slice(0, -1)), 0, 100) / 100;
  return clamp(Number(raw), 0, 1);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  // Standard CSS conversion. Inputs: h ∈ [0,360), s ∈ [0,1], l ∈ [0,1].
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  return { r: round((r1 + m) * 255), g: round((g1 + m) * 255), b: round((b1 + m) * 255) };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h: round(h), s: round(s * 100), l: round(l * 100) };
}

/** Format a normalized RGBA in the requested format. */
export function formatColor(rgba: RGBA, format: ColorFormat): string {
  const { r, g, b, a } = rgba;
  const hasAlpha = a < 1;
  if (format === 'hex') {
    const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    return hasAlpha ? `${hex}${toHex(Math.round(a * 255))}` : hex;
  }
  if (format === 'rgb') {
    return hasAlpha
      ? `rgba(${round(r)}, ${round(g)}, ${round(b)}, ${trimAlpha(a)})`
      : `rgb(${round(r)}, ${round(g)}, ${round(b)})`;
  }
  const { h, s, l } = rgbToHsl(r, g, b);
  return hasAlpha ? `hsla(${h}, ${s}%, ${l}%, ${trimAlpha(a)})` : `hsl(${h}, ${s}%, ${l}%)`;
}

function toHex(n: number): string {
  return clamp(round(n), 0, 255).toString(16).padStart(2, '0');
}
function trimAlpha(a: number): string {
  // Two decimal places is more than enough for color alpha.
  return Number(a.toFixed(2)).toString();
}

/** Detect which CSS color format a string is using. Defaults to `hex`. */
export function detectFormat(value: string | null | undefined): ColorFormat {
  if (!value) return 'hex';
  const v = value.trim().toLowerCase();
  if (v.startsWith('rgb')) return 'rgb';
  if (v.startsWith('hsl')) return 'hsl';
  return 'hex';
}

/** Just the swatch-friendly 6-digit hex (alpha dropped) — what the
 *  native `<input type="color">` accepts. Black fallback for parse
 *  failures so the swatch never renders the browser default. */
export function toSwatchHex(value: string | null | undefined): string {
  const rgba = value ? parseColor(value) : null;
  if (!rgba) return '#000000';
  return `#${toHex(rgba.r)}${toHex(rgba.g)}${toHex(rgba.b)}`;
}
