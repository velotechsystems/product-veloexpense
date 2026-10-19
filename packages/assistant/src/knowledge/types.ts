/**
 * What an article is, once compiled.
 *
 * English only, by design: answers are translated on the fly into whatever language the person
 * wrote in, so there is one body of prose rather than one per locale. That single decision is
 * what keeps the search index monolingual — see `search.ts`.
 */
export interface Article {
  /** Kebab-case, unique, stable. What the assistant cites. */
  readonly slug: string;
  readonly title: string;
  /**
   * Platform module slugs. An article is invisible to a workspace with none of them active —
   * a virtual-card article must not answer a workspace that has no cards. `[]` means it
   * applies everywhere.
   */
  readonly modules: readonly string[];
  readonly updated: string;
  /** Markdown, English. */
  readonly body: string;
}

/** One search hit. `score` is comparable within a result set and meaningless across sets. */
export interface ArticleHit {
  readonly slug: string;
  readonly title: string;
  readonly score: number;
}
