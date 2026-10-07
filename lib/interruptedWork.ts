/**
 * What a session expiry interrupted, kept across the re-authentication it forces.
 *
 * THE DEFECT THIS ADDRESSES. `IdleTimeout` was taught to drain in-flight writes before the
 * CLIENT's own countdown signs somebody out (#329), which fixed the case where our timer was
 * the one that fired. It did not fix the dominant case: the server's Redis idle window lapses
 * first — routine, because the heartbeat is throttled to one call per 30s and a click inside
 * that window only moves the LOCAL deadline — the mutation comes back UNAUTHORIZED, and the
 * tRPC client hard-navigates to /login. The Approve click never landed and the typed
 * justification went with it, silently (GA readiness report F16, blocker B7).
 *
 * IT DISCLOSES, IT DOES NOT REPLAY. Re-issuing a mutation after re-auth is how a claim gets
 * approved twice or a card gets issued twice; "we kept your work" must not mean "we did it
 * again while you were away". So the interrupted call is described back to the person, with
 * any text they had typed, and acting on it again is their decision.
 *
 * `sessionStorage`, not `localStorage`: this belongs to one tab and one interruption, and must
 * not outlive the tab or leak into another one. Only the most recent interruption is kept —
 * a second expiry means the first message was already shown or already stale.
 */
const KEY = 'expenseos.interruptedWork';

export interface InterruptedWork {
  /** The tRPC procedure path, e.g. `expenseApprovals.decide`. */
  path: string;
  /** Free text the person had typed — the part that is genuinely unrecoverable. */
  typedText?: string;
  /** Where they were, so the message can say what they were doing. */
  url: string;
  /** Epoch ms, so a stale record can be discarded rather than shown days later. */
  at: number;
}

/** Anything older than this is not worth showing — they have moved on. */
const MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The free-text field out of a mutation's variables, if it has one.
 *
 * These are the keys the app actually uses for a person's own words — a rejection reason, an
 * explanation of a charge, a comment. Structured values are deliberately NOT kept: they are
 * reconstructible from the screen, and stashing arbitrary payloads in web storage would put
 * amounts and ids somewhere they do not belong.
 */
const TEXT_KEYS = ['note', 'justification', 'explanation', 'reason', 'comment', 'body'] as const;

export function typedTextOf(variables: unknown): string | undefined {
  if (typeof variables !== 'object' || variables === null) return undefined;
  const v = variables as Record<string, unknown>;
  for (const k of TEXT_KEYS) {
    const value = v[k];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

export function rememberInterruptedWork(work: Omit<InterruptedWork, 'at'>): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...work, at: Date.now() }));
  } catch {
    // Private mode, blocked storage, quota. Losing the message is not worth failing the
    // redirect that is already happening.
  }
}

/** Read and CLEAR — the message is shown once. */
export function takeInterruptedWork(): InterruptedWork | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as InterruptedWork;
    if (typeof parsed?.path !== 'string' || typeof parsed?.at !== 'number') return null;
    if (Date.now() - parsed.at > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}
