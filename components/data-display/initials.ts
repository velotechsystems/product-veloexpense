/**
 * Pure-utility helper extracted from `Avatar.tsx` so it can be
 * called from Server Components. The Avatar component itself stays
 * a client component (`'use client'`), but its initials math has no
 * React or DOM dependencies — sharing it via the same file would
 * have transitively marked it client-only.
 */

/** Derive a 2-character upper-case initials string from first/last
 *  name with email as a final fallback. */
export function initialsFrom(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  email: string,
): string {
  const f = firstName?.[0] ?? '';
  const l = lastName?.[0] ?? '';
  return `${f}${l}`.toUpperCase() || email[0]?.toUpperCase() || '?';
}

/**
 * Initials when all the caller has is ONE display-name string, which is the shape a
 * session carries.
 *
 * Splits on whitespace and takes the first and last part, so "Ada Lovelace" and "Ada
 * Byron King Lovelace" both give AL, and a single token gives one letter.
 *
 * IT LIVES HERE BECAUSE IT HAS TWO CALLERS, and it arrived with the second one. It was a
 * private function in `dashboard/page.tsx`, written when the dashboard's face moved above
 * every boundary: an avatar drawn from the session has to derive its fallback text without
 * a fetch, and the session holds a composed name rather than `firstName` / `lastName`.
 * `/profile`'s employment record draws its face from the session for the same reason, so
 * the alternative was a second copy in a second route folder — the exact drift the
 * `IdentityBanner` extraction was authorized to remove one file over ("two byte-identical
 * copies of the chip class string, which is precisely the kind of thing that drifts").
 *
 * The slicing itself stays in `initialsFrom`, which takes the first UTF-16 code unit of
 * each part. That mis-handles an astral-plane first character (an emoji, a handful of
 * historic scripts) — a pre-existing limitation of the shared helper that every avatar in
 * the app shares, and not something to fork a second implementation over.
 */
export function initialsFromDisplayName(name: string, email: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return initialsFrom(
    parts[0] ?? null,
    parts.length > 1 ? (parts[parts.length - 1] ?? null) : null,
    email || name,
  );
}
