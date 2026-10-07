import type { CSSProperties } from 'react';

/**
 * Category pill coloring. A category may define an explicit hex `color`; when it
 * doesn't, we derive a stable color from its id so pills are still distinct (and
 * consistent across renders/pages). Rendered as a soft tint — a low-alpha fill +
 * the accent as border and text — which stays legible in both light and dark.
 */

// Mid-tone accents (readable as text on their own tint in both themes).
const PALETTE = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
  '#4f46e5',
  '#0d9488',
  '#9333ea',
  '#be123c',
];

function hashIndex(id: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % mod;
}

/** Resolve a category's accent hex — its own `color`, or a stable fallback. */
export function categoryColor(cat: { id: string; color?: string | null }): string {
  return cat.color && /^#[0-9a-f]{6}$/i.test(cat.color)
    ? cat.color
    : PALETTE[hashIndex(cat.id, PALETTE.length)];
}

/** Inline style for a category pill: soft tinted fill + accent border/text. */
export function categoryPillStyle(cat: { id: string; color?: string | null }): CSSProperties {
  const c = categoryColor(cat);
  return { backgroundColor: `${c}1f`, color: c, borderColor: `${c}59` };
}
