import { describe, expect, it } from 'vitest';
import {
  buildNameMatcher,
  type MatchCandidate,
  nameTokens,
  splitFileName,
} from './mileageBalanceMatch';

/**
 * Matching a Concur year-to-date file's names ("Last, First Middle") to ExpenseOS people.
 *
 * The property that matters most is the negative one: a balance on the wrong person changes
 * what two people are paid, so anything that is not a single, clear match must come back
 * ambiguous or unmatched — never a guess.
 */

let seq = 0;
const person = (
  firstName: string | null,
  lastName: string | null,
  overrides: Partial<MatchCandidate> = {},
): MatchCandidate => {
  seq += 1;
  return {
    id: `user-${seq}`,
    firstName,
    lastName,
    email: `p${seq}@e.inc`,
    deactivated: false,
    ...overrides,
  };
};

const matcher = (people: MatchCandidate[], remembered: Record<string, string> = {}) =>
  buildNameMatcher(people, new Map(Object.entries(remembered)));

describe('nameTokens', () => {
  it('lowercases, strips accents and splits on anything that is not a letter', () => {
    expect(nameTokens('Côté, Hélène')).toEqual(['cote', 'helene']);
    expect(nameTokens("  O'Brien-Smith  ")).toEqual(['o', 'brien', 'smith']);
    expect(nameTokens('JEAN-FRANÇOIS')).toEqual(['jean', 'francois']);
    expect(nameTokens('Smith 3rd.')).toEqual(['smith', 'rd']);
  });

  it('returns nothing for null, undefined, blank or punctuation-only input', () => {
    expect(nameTokens(null)).toEqual([]);
    expect(nameTokens(undefined)).toEqual([]);
    expect(nameTokens('')).toEqual([]);
    expect(nameTokens('   ')).toEqual([]);
    expect(nameTokens('-- , .')).toEqual([]);
  });
});

describe('splitFileName', () => {
  it('splits "Last, First Middle" at the first comma', () => {
    expect(splitFileName('Smith, John Paul')).toEqual({
      last: ['smith'],
      given: ['john', 'paul'],
    });
    expect(splitFileName('Garcia Lopez, María')).toEqual({
      last: ['garcia', 'lopez'],
      given: ['maria'],
    });
  });

  it('only the first comma separates; later ones are punctuation', () => {
    expect(splitFileName('Smith, John, Jr')).toEqual({
      last: ['smith'],
      given: ['john', 'jr'],
    });
  });

  it('treats a name with no comma as all given names', () => {
    expect(splitFileName('John Smith')).toEqual({ last: [], given: ['john', 'smith'] });
  });

  it('copes with an empty side of the comma', () => {
    expect(splitFileName(', John')).toEqual({ last: [], given: ['john'] });
    expect(splitFileName('Smith,')).toEqual({ last: ['smith'], given: [] });
  });
});

describe('buildNameMatcher', () => {
  describe('remembered', () => {
    it('reuses the person a name was matched to before, ahead of any name match', () => {
      const bob = person('Robert', 'Unrelated');
      const exact = person('Bob', 'Zed');
      const match = matcher([bob, exact], { 'Zed, Bob': bob.id });
      expect(match('Zed, Bob')).toEqual({ status: 'remembered', userId: bob.id });
    });

    it('trims the file name before looking it up', () => {
      const bob = person('Robert', 'Unrelated');
      const match = matcher([bob], { 'Zed, Bob': bob.id });
      expect(match('  Zed, Bob  ')).toEqual({ status: 'remembered', userId: bob.id });
    });

    it('is case- and spelling-exact: a different spelling goes through the name passes', () => {
      const bob = person('Robert', 'Unrelated');
      const match = matcher([bob], { 'Zed, Bob': bob.id });
      expect(match('ZED, BOB')).toEqual({ status: 'unmatched' });
    });

    it('ignores a remembered person who is no longer among the candidates', () => {
      const bob = person('Bob', 'Zed');
      const match = matcher([bob], { 'Zed, Bob': 'user-gone' });
      // Falls through to the surname + first-name pass.
      expect(match('Zed, Bob')).toEqual({ status: 'matched', userId: bob.id });
      const nobody = matcher([], { 'Zed, Bob': 'user-gone' });
      expect(nobody('Zed, Bob')).toEqual({ status: 'unmatched' });
    });
  });

  describe('surname + first given name', () => {
    it('matches exactly, ignoring case', () => {
      const john = person('John', 'Smith');
      const match = matcher([john, person('Jane', 'Smith')]);
      expect(match('SMITH, JOHN')).toEqual({ status: 'matched', userId: john.id });
    });

    it('matches across accents and punctuation', () => {
      const helene = person('Hélène', 'Côté');
      const mk = person('Mary-Kate', "O'Neil");
      const match = matcher([helene, mk]);
      expect(match('Côté, Hélène')).toEqual({ status: 'matched', userId: helene.id });
      expect(match('Cote, Helene')).toEqual({ status: 'matched', userId: helene.id });
      expect(match('ONeil, Mary Kate')).toEqual({ status: 'unmatched' });
      expect(match("O'Neil, Mary-Kate")).toEqual({ status: 'matched', userId: mk.id });
      expect(match('O Neil, Mary')).toEqual({ status: 'matched', userId: mk.id });
    });

    it('ignores middle names in the file: only the FIRST given name is keyed', () => {
      const john = person('John', 'Smith');
      const match = matcher([john]);
      expect(match('Smith, John Paul')).toEqual({ status: 'matched', userId: john.id });
    });

    it('matches only the first word of a multi-word first name here', () => {
      const helene = person('Hélène Marie', 'Côté');
      const match = matcher([helene]);
      expect(match('Côté, Hélène')).toEqual({ status: 'matched', userId: helene.id });
    });

    it('matches a compound surname written in full', () => {
      const maria = person('Maria', 'Garcia Lopez');
      const match = matcher([maria]);
      expect(match('Garcia Lopez, Maria')).toEqual({ status: 'matched', userId: maria.id });
    });

    it('is ambiguous — never a guess — when two people share surname and first name', () => {
      const a = person('John', 'Smith');
      const b = person('John', 'Smith', { deactivated: true });
      const match = matcher([a, b, person('Jane', 'Smith')]);
      expect(match('Smith, John')).toEqual({ status: 'ambiguous', candidateIds: [a.id, b.id] });
    });

    it('collapses the same person listed twice into one match', () => {
      const a = person('John', 'Smith');
      const match = matcher([a, { ...a }]);
      expect(match('Smith, John')).toEqual({ status: 'matched', userId: a.id });
    });

    it('matches deactivated people too (the caller shows the flag)', () => {
      const gone = person('Old', 'Timer', { deactivated: true });
      expect(matcher([gone])('Timer, Old')).toEqual({ status: 'matched', userId: gone.id });
    });

    it('skips people with no first or no last name in this pass', () => {
      const noFirst = person(null, 'Smith');
      const noLast = person('John', null);
      const match = matcher([noFirst, noLast]);
      // Neither has a surname|first key, and neither has two usable words for the loose pass.
      expect(match('Smith, John')).toEqual({ status: 'unmatched' });
    });
  });

  describe('token set (loose)', () => {
    it('matches a file name with fewer words than a compound surname', () => {
      const maria = person('Maria', 'Garcia Lopez');
      const match = matcher([maria]);
      expect(match('Garcia, Maria')).toEqual({ status: 'matched', userId: maria.id });
    });

    it('matches a name written without a comma, in either order', () => {
      const john = person('John', 'Smith');
      const match = matcher([john]);
      expect(match('John Smith')).toEqual({ status: 'matched', userId: john.id });
      expect(match('Smith John')).toEqual({ status: 'matched', userId: john.id });
    });

    it('ignores initials on the person when comparing words', () => {
      // "J. Robert" keys as `doe|j` for the exact pass, so "Doe, Robert" only meets it here.
      const robert = person('J. Robert', 'Doe');
      const match = matcher([robert]);
      expect(match('Doe, Robert')).toEqual({ status: 'matched', userId: robert.id });
    });

    it('ignores initials in the file when comparing words', () => {
      const robert = person('Robert', 'Doe');
      const match = matcher([robert]);
      expect(match('Doe, J Robert')).toEqual({ status: 'matched', userId: robert.id });
      expect(match('J. Robert Doe')).toEqual({ status: 'matched', userId: robert.id });
    });

    it('matches when the file carries a middle name the person does not', () => {
      // Exact pass misses on purpose (first given name is "Ann", person's first name is "Mary").
      const mary = person('Mary', 'Jones');
      const match = matcher([mary]);
      expect(match('Jones, Ann Mary')).toEqual({ status: 'matched', userId: mary.id });
    });

    it('is ambiguous when the words fit more than one person', () => {
      const a = person('Maria', 'Garcia Lopez');
      const b = person('Maria', 'Garcia Perez');
      const match = matcher([a, b]);
      expect(match('Garcia, Maria')).toEqual({ status: 'ambiguous', candidateIds: [a.id, b.id] });
    });

    it('never loosely matches a person with fewer than two usable words', () => {
      const cher = person(null, 'Cher');
      const initialled = person('J', 'Doe');
      const match = matcher([cher, initialled]);
      expect(match('Cher Bono')).toEqual({ status: 'unmatched' });
      expect(match('Doe John')).toEqual({ status: 'unmatched' });
    });
  });

  describe('one-word names', () => {
    it('never matches a single word, even when only one person could fit', () => {
      const john = person('John', 'Smith');
      const match = matcher([john]);
      expect(match('Smith')).toEqual({ status: 'unmatched' });
      expect(match('Smith,')).toEqual({ status: 'unmatched' });
      expect(match(', John')).toEqual({ status: 'unmatched' });
    });

    it('a surname plus an initial still matches exactly, but never loosely', () => {
      const j = person('J', 'Smith');
      const john = person('John', 'Smith');
      expect(matcher([j])('Smith, J')).toEqual({ status: 'matched', userId: j.id });
      // "j" ≠ "john" for the exact key, and one usable word is too few for the loose pass.
      expect(matcher([john])('Smith, J')).toEqual({ status: 'unmatched' });
    });
  });

  it('is unmatched when nobody fits', () => {
    const match = matcher([person('John', 'Smith'), person('Hélène', 'Côté')]);
    expect(match('Nguyen, Thi')).toEqual({ status: 'unmatched' });
    expect(match('Smith, Jane Doe')).toEqual({ status: 'unmatched' });
  });

  it('with no candidates at all, everything is unmatched', () => {
    const match = matcher([]);
    expect(match('Smith, John')).toEqual({ status: 'unmatched' });
  });
});
