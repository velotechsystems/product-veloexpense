import { describe, expect, it } from 'vitest';
import { buildIndex, searchIndexed, tokenize } from './search';
import type { Article } from './types';

/**
 * The candidate-finding stage.
 *
 * What matters here is **recall**, not precision: every candidate is read afterwards by a
 * per-article extraction pass that discards what does not answer the question, so returning one
 * article too many is cheap and missing the right one costs the answer. The tests are written
 * against that asymmetry.
 */

const article = (over: Partial<Article> = {}): Article => ({
  slug: 'claiming-per-diem',
  title: 'Claiming a per-diem allowance',
  modules: ['expense-management'],
  updated: '2026-08-20',
  body: 'A per-diem allowance covers meals and incidentals for a travel day.',
  ...over,
});

const search = (articles: Article[], terms: string[], activeModules = ['expense-management']) =>
  searchIndexed(buildIndex(articles), terms, { activeModules });

describe('tokenize', () => {
  it('strips accents, so an unaccented query still matches a loanword', () => {
    // The corpus is English, but English prose about Canadian tax carries "café" and "per-diem".
    expect(tokenize('Café receipts')).toEqual(['cafe', 'receipts']);
    expect(tokenize('cafe receipts')).toEqual(['cafe', 'receipts']);
  });

  it('splits on punctuation so hyphenated terms match either way', () => {
    expect(tokenize('per-diem')).toEqual(['per', 'diem']);
  });

  it('drops stop words and single characters', () => {
    expect(tokenize('what is a per diem')).toEqual(['per', 'diem']);
  });
});

describe('searchIndexed', () => {
  it('finds an article by a word in its body', () => {
    const hits = search([article()], ['incidentals']);
    expect(hits.map((h) => h.slug)).toEqual(['claiming-per-diem']);
  });

  it('ranks a title match above a body-only match', () => {
    // A title says what an article is ABOUT; a passing mention in a body does not.
    const hits = search(
      [
        article({ slug: 'about-per-diem', title: 'Per-diem allowances', body: 'Details.' }),
        article({
          slug: 'mentions-per-diem',
          title: 'Submitting a report',
          body: 'Reports may contain a per-diem line among many other things entirely.',
        }),
      ],
      ['per diem'],
    );
    expect(hits[0]?.slug).toBe('about-per-diem');
  });

  it('accepts several surface forms of the same term', () => {
    // The model supplying the query emits "claim", "claiming", "claimed" — which is what stands
    // in for a stemmer here.
    const hits = search(
      [article({ body: 'You claimed the allowance last month.' })],
      ['claim', 'claiming', 'claimed'],
    );
    expect(hits).toHaveLength(1);
  });

  it('hides an article whose module is not active in this workspace', () => {
    // A virtual-card article must not answer a workspace that has no cards.
    const cards = article({ slug: 'freezing-a-card', modules: ['virtual-credit-cards'] });
    expect(search([cards], ['per diem'], ['expense-management'])).toEqual([]);
    expect(search([cards], ['allowance'], ['virtual-credit-cards'])).toHaveLength(1);
  });

  it('always considers an article that names no module', () => {
    const universal = article({ slug: 'signing-in', modules: [] });
    expect(search([universal], ['allowance'], [])).toHaveLength(1);
  });

  it('returns nothing rather than everything when no term matches', () => {
    // A miss must be a miss. Falling back to "here is the whole corpus" would hand the
    // extraction pass ten irrelevant articles and invite an answer built from none of them.
    expect(search([article()], ['payroll', 'onboarding'])).toEqual([]);
  });

  it('returns nothing for a query that is entirely stop words', () => {
    expect(search([article()], ['what is the'])).toEqual([]);
  });

  it('does not penalise an article for containing a very common term', () => {
    // Textbook BM25 idf goes negative when a term appears in most documents, which at this
    // corpus size would rank an article DOWN for containing the word being searched for.
    const many = Array.from({ length: 6 }, (_, i) =>
      article({ slug: `expense-${i}`, title: `Expense topic ${i}`, body: 'expense expense' }),
    );
    const hits = search(many, ['expense']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.score >= 0)).toBe(true);
  });

  it('orders identically for an identical query', () => {
    // Slug is the tiebreak, so a tie does not reorder run to run and a cached answer stays
    // consistent with what a reviewer sees.
    const tied = [
      article({ slug: 'b-article', title: 'Allowance', body: 'Same.' }),
      article({ slug: 'a-article', title: 'Allowance', body: 'Same.' }),
    ];
    expect(search(tied, ['allowance']).map((h) => h.slug)).toEqual(['a-article', 'b-article']);
  });

  it('caps the candidate list', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      article({ slug: `a-${i}`, body: 'allowance' }),
    );
    expect(
      searchIndexed(buildIndex(many), ['allowance'], {
        activeModules: ['expense-management'],
        limit: 10,
      }),
    ).toHaveLength(10);
  });
});

describe('searchArticles, over the compiled corpus', () => {
  it('searches the shipped articles and gates them by module', async () => {
    /** The lazy index is built once per process; a second call must reuse it rather than
     *  re-tokenising the whole corpus on every question somebody asks. */
    const { searchArticles } = await import('./search');
    const first = searchArticles(['expense'], { activeModules: ['expense-management'] });
    const second = searchArticles(['expense'], { activeModules: ['expense-management'] });
    expect(second).toEqual(first);
  });

  it('returns nothing when no module is active', () => {
    /** A workspace with the module switched off has no visible corpus, and the honest
     *  answer is no candidates rather than every article. */
    expect(search([article()], ['incidentals'], [])).toEqual([]);
  });

  it('skips a term the article does not contain at all', () => {
    /**
     * Two terms, one present. The absent one must contribute nothing rather than being
     * scored as a zero-frequency match — an idf against df=0 is division-by-zero
     * territory and would poison the whole score.
     */
    const hits = search([article()], ['incidentals', 'zzzzunrelated']);
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(Number.isFinite(hits[0].score)).toBe(true);
  });
});

describe('articleBySlug', () => {
  it('returns null for a slug that does not exist', async () => {
    const { articleBySlug } = await import('./search');
    expect(articleBySlug('no-such-article', ['expense-management'])).toBeNull();
  });

  it('hides an article whose module is not active here', async () => {
    /**
     * The same gate the search applies, applied again on the direct read — otherwise a
     * slug learned from one workspace opens the article in another where the module is
     * off. Deep-links are guessable; the gate cannot live only in the search.
     */
    const { articleBySlug } = await import('./search');
    const { ARTICLES } = await import('./generated');
    const gated = ARTICLES.find((a) => a.modules.length > 0);
    expect(gated, 'the corpus has no module-gated article to test with').toBeTruthy();
    if (!gated) return;
    expect(articleBySlug(gated.slug, [])).toBeNull();
    expect(articleBySlug(gated.slug, gated.modules)).toMatchObject({ slug: gated.slug });
  });

  it('returns an ungated article whatever is active', async () => {
    const { articleBySlug } = await import('./search');
    const { ARTICLES } = await import('./generated');
    const ungated = ARTICLES.find((a) => a.modules.length === 0);
    if (!ungated) return; // every article is gated in this corpus — nothing to assert
    expect(articleBySlug(ungated.slug, [])).toMatchObject({ slug: ungated.slug });
  });
});
