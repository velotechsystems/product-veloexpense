'use client';

/**
 * What the assistant is told about where somebody is standing.
 *
 * Route pattern and entity ids, and nothing else. Never the DOM, never pixels, never form
 * state — the route is a fact the server can check against its own router, while anything
 * richer is client-supplied content that would end up inside a prompt.
 *
 * The screen supplies the SUBJECT of a question that named none. Naming another record wins,
 * which is a rule in the system prompt rather than here; this side's job is only to say
 * truthfully where the person is.
 */

export interface ScreenContext {
  route: string;
  entityIds?: Record<string, string>;
}

/** Segments that are ids rather than route words. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which parameter an id in this position is called.
 *
 * Derived from the segment before it, which is how every route in this app is shaped
 * (`/expenses/<id>`, `/virtual-cards/<id>`). A name the model can use beats a positional
 * `id`, because the tools take named parameters and a mislabelled one is a lookup against
 * the wrong table.
 */
const ID_NAMES: Record<string, string> = {
  expenses: 'reportId',
  travel: 'travelRequestId',
  'virtual-cards': 'cardId',
  requests: 'requestId',
  transactions: 'transactionId',
  budgets: 'budgetId',
  users: 'userId',
};

/**
 * Turn a resolved pathname into a route pattern plus the ids it carried.
 *
 * The locale prefix is dropped: `/fr-CA/expenses/<id>` and `/en/expenses/<id>` are the same
 * screen, and telling the model otherwise would make half the routes unrecognisable to it.
 */
export function screenContextFrom(pathname: string, locales: readonly string[]): ScreenContext {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0 && locales.includes(segments[0])) segments.shift();

  const entityIds: Record<string, string> = {};
  const pattern = segments.map((segment, index) => {
    if (!UUID.test(segment)) return segment;
    const name = ID_NAMES[segments[index - 1] ?? ''] ?? 'id';
    entityIds[name] = segment;
    return `[${name}]`;
  });

  return {
    route: `/${pattern.join('/')}`,
    ...(Object.keys(entityIds).length > 0 ? { entityIds } : {}),
  };
}
