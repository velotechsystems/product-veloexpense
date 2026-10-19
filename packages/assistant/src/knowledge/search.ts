/**
 * Finding candidate articles, in memory.
 *
 * **Why not Postgres FTS.** The corpus is committed Markdown: English, read-only at runtime, tens
 * of files, source of truth in git. A database index of that is derived data needing a migration,
 * a rebuild step and an answer to "what rebuilds it after a deploy" — for a table that could
 * never disagree with the files without being a bug. Compiled into the bundle, it is simply
 * always correct. Postgres `to_tsvector` + `ts_rank_cd` is the documented upgrade past a few
 * hundred articles, and needs a schema proposal then.
 *
 * **Why the index is monolingual.** The corpus is English and the caller supplies English terms —
 * the model restates a French question in English before searching, because it is the thing
 * writing the query. So there is no French analyzer here, no `unaccent`, and no index-time
 * translation. That is not a simplification of the bilingual problem; it is the problem not
 * arising.
 *
 * **Why recall matters more than precision.** Every candidate is read afterwards by a per-article
 * extraction pass that discards what does not answer the question. Returning eight where three
 * matter costs a little; missing the one that mattered costs the answer. So the scorer is tuned
 * to be generous and the caller asks for up to ten.
 */

import { ARTICLES } from './generated';
import type { Article, ArticleHit } from './types';

/** BM25 saturation and length-normalisation constants — the conventional defaults. */
const K1 = 1.2;
const B = 0.75;

/** Title matches count for more than body matches: a title is what the article is ABOUT. */
const TITLE_WEIGHT = 3;

/**
 * Words carrying no retrieval signal. Short, and English-only like the corpus.
 *
 * Kept deliberately small. A long stop list starts removing words that matter in this domain —
 * "own", "not", "own expenses", "no tax" — and the model supplying the query already avoids
 * padding it with filler.
 */
const STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'with',
]);

/**
 * Normalise text to comparable tokens.
 *
 * Accents are stripped even though the corpus is English, because English prose about Canadian
 * tax carries loanwords — "café", "per-diem" — and a query that spells one without its accent
 * should still match. `NFD` + combining-mark removal is the whole of it.
 */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

interface Indexed {
  readonly article: Article;
  /** token → weighted frequency (title occurrences counted TITLE_WEIGHT times). */
  readonly freq: Map<string, number>;
  readonly length: number;
}

function indexArticle(article: Article): Indexed {
  const freq = new Map<string, number>();
  const add = (token: string, weight: number) => freq.set(token, (freq.get(token) ?? 0) + weight);
  for (const token of tokenize(article.title)) add(token, TITLE_WEIGHT);
  for (const token of tokenize(article.body)) add(token, 1);
  let length = 0;
  for (const n of freq.values()) length += n;
  return { article, freq, length };
}

/**
 * The index, built once per process.
 *
 * Lazy rather than at module load: importing this file must not do work, so a test can build its
 * own index over fixtures without the real corpus being touched.
 */
let cached: Indexed[] | null = null;
function corpus(): Indexed[] {
  if (!cached) cached = ARTICLES.map(indexArticle);
  return cached;
}

export interface SearchOptions {
  /** Module slugs active for this workspace. An article naming none of them is not a candidate. */
  readonly activeModules: readonly string[];
  readonly limit?: number;
}

/** Search a supplied corpus — the testable core. */
export function searchIndexed(
  indexed: readonly Indexed[],
  terms: readonly string[],
  options: SearchOptions,
): ArticleHit[] {
  const visible = indexed.filter(
    (i) =>
      i.article.modules.length === 0 ||
      i.article.modules.some((m) => options.activeModules.includes(m)),
  );
  if (visible.length === 0) return [];

  const queryTokens = [...new Set(terms.flatMap(tokenize))];
  if (queryTokens.length === 0) return [];

  const avgLength = visible.reduce((sum, i) => sum + i.length, 0) / visible.length;
  const hits: ArticleHit[] = [];

  for (const entry of visible) {
    let score = 0;
    for (const token of queryTokens) {
      const tf = entry.freq.get(token);
      if (!tf) continue;
      const df = visible.reduce((n, i) => n + (i.freq.has(token) ? 1 : 0), 0);
      // Standard BM25 idf, floored at zero. On a corpus of tens of documents a term present in
      // most of them goes NEGATIVE, which would penalise an article for containing the word
      // being searched for — nonsense at this scale even though it is textbook at web scale.
      const idf = Math.max(0, Math.log(1 + (visible.length - df + 0.5) / (df + 0.5)));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (entry.length / avgLength))));
    }
    if (score > 0) hits.push({ slug: entry.article.slug, title: entry.article.title, score });
  }

  // Slug as the tiebreak, so an identical query returns an identical order run to run.
  hits.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return hits.slice(0, options.limit ?? 10);
}

/** Search the compiled corpus. */
export function searchArticles(terms: readonly string[], options: SearchOptions): ArticleHit[] {
  return searchIndexed(corpus(), terms, options);
}

/** Build an index over supplied articles — for tests, and for anything holding its own corpus. */
export function buildIndex(articles: readonly Article[]): Indexed[] {
  return articles.map(indexArticle);
}

/** One article by slug, module-gated. Null when it does not exist or is not visible here. */
export function articleBySlug(slug: string, activeModules: readonly string[]): Article | null {
  const found = ARTICLES.find((a) => a.slug === slug);
  if (!found) return null;
  if (found.modules.length > 0 && !found.modules.some((m) => activeModules.includes(m)))
    return null;
  return found;
}
