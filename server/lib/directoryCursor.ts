/**
 * Tuple cursor for the Employee Directory pagination.
 *
 * Order key: (firstName ASC NULLS LAST, lastName ASC NULLS LAST, id ASC).
 * The cursor is an opaque base64-encoded JSON of the LAST row's order
 * key. Next page is "everything strictly greater than this tuple."
 *
 * Why tuple cursor instead of `cursor: { id }`? Prisma's cursor API
 * walks the index in id order; we want alphabetical order with id as
 * the tie-breaker. Tuples preserve that ordering across pages.
 */

// Ported from ExpenseOS `server/lib/directoryCursor.ts` (1e682dd6) unchanged, People 1.

export interface DirectoryCursor {
  firstName: string | null;
  lastName: string | null;
  id: string;
}

export function encodeDirectoryCursor(c: DirectoryCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeDirectoryCursor(raw: string): DirectoryCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof (parsed as DirectoryCursor).id === 'string'
    ) {
      return parsed as DirectoryCursor;
    }
    return null;
  } catch {
    return null;
  }
}
