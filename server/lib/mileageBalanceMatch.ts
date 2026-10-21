/**
 * Matching the people in a year-to-date mileage file (Concur) to people in ExpenseOS.
 *
 * The file names people the way Concur prints them — "Last, First Middle" — and carries no
 * email or employee id, so the name is all there is. Three passes, strictest first:
 *
 *   1. REMEMBERED — the exact name string was matched to somebody in the upload in force.
 *      A name resolved by hand once is not asked about again.
 *   2. SURNAME + FIRST GIVEN NAME — accents, case and punctuation ignored.
 *   3. TOKEN SET — every word of one name appears in the other (a middle name in the file,
 *      a compound surname here).
 *
 * A pass that finds more than one person is AMBIGUOUS and stops: a mileage balance on the
 * wrong person changes what two people are paid. Nothing is ever guessed.
 */

export interface MatchCandidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  deactivated: boolean;
}

export type NameMatch =
  | { status: 'remembered' | 'matched'; userId: string }
  | { status: 'ambiguous'; candidateIds: string[] }
  | { status: 'unmatched' };

/** Lowercase, accents stripped, words of letters only. */
export function nameTokens(value: string | null | undefined): string[] {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** "Last, First Middle" → surname words and given-name words. No comma: all given. */
export function splitFileName(name: string): { last: string[]; given: string[] } {
  const comma = name.indexOf(',');
  if (comma < 0) return { last: [], given: nameTokens(name) };
  return { last: nameTokens(name.slice(0, comma)), given: nameTokens(name.slice(comma + 1)) };
}

const isSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size > 0 && [...a].every((t) => b.has(t));

export function buildNameMatcher(
  people: readonly MatchCandidate[],
  remembered: ReadonlyMap<string, string>,
): (fileName: string) => NameMatch {
  const known = new Set(people.map((p) => p.id));
  const byKey = new Map<string, string[]>();
  const sets = people.map((p) => {
    const last = nameTokens(p.lastName).join(' ');
    const first = nameTokens(p.firstName)[0] ?? '';
    if (last && first) {
      const key = `${last}|${first}`;
      byKey.set(key, [...(byKey.get(key) ?? []), p.id]);
    }
    // Initials are too weak to match on.
    const words = [...nameTokens(p.firstName), ...nameTokens(p.lastName)].filter(
      (t) => t.length > 1,
    );
    return { id: p.id, words: new Set(words) };
  });

  const decide = (ids: string[]): NameMatch | null => {
    const unique = [...new Set(ids)];
    if (unique.length === 1) return { status: 'matched', userId: unique[0] };
    if (unique.length > 1) return { status: 'ambiguous', candidateIds: unique };
    return null;
  };

  return (fileName: string): NameMatch => {
    const prior = remembered.get(fileName.trim());
    if (prior && known.has(prior)) return { status: 'remembered', userId: prior };

    const { last, given } = splitFileName(fileName);
    if (last.length > 0 && given.length > 0) {
      const exact = decide(byKey.get(`${last.join(' ')}|${given[0]}`) ?? []);
      if (exact) return exact;
    }

    const words = new Set([...last, ...given].filter((t) => t.length > 1));
    // One word ("Smith") is a subset of half the company: never matched loosely.
    if (words.size < 2) return { status: 'unmatched' };
    const loose = decide(
      sets
        .filter((s) => s.words.size >= 2 && (isSubset(s.words, words) || isSubset(words, s.words)))
        .map((s) => s.id),
    );
    return loose ?? { status: 'unmatched' };
  };
}
