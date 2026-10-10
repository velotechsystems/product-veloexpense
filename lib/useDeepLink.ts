'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useRef } from 'react';

/**
 * Both halves of the "open this thing" deep link live here — the nonce the LINK
 * carries, and the hook the destination reads it with.
 *
 * The producer used to be module-private in `NotificationBell`, which meant the
 * only surface that could mint a nonce was the bell itself. It is exported here
 * instead, next to the hook that consumes it, because the two are one contract:
 * change the param name in one and the other stops opening anything.
 */

/** Monotonic per-session click counter — see `nextOpenNonce`. */
let openNonceSeq = 0;

/**
 * A fresh `n=` for a link that is being FOLLOWED, so following it is always an
 * instruction to open.
 *
 * Without it, the second notification about the SAME subject was a no-op: the
 * href was byte-identical to the one already in the router's history, so `push`
 * wasn't a navigation, the target page's search params never changed, and its
 * deep-open effect never re-ran. That is why the most recent notification —
 * usually about the thing you had just looked at — appeared to do nothing while
 * older ones worked.
 *
 * A counter, not a timestamp: two clicks can land in the same millisecond, and a
 * nonce that repeats is a nonce that doesn't work. It resets on reload, which is
 * exactly when the page's own "already opened" memory resets too.
 *
 * CALL IT FROM AN EVENT HANDLER, NEVER FROM A RENDER. It mutates module state, so
 * a component that computes an `href` with it during render mints a new nonce on
 * every re-render and hands React a different prop each time. A rendered `<a>`
 * needs no nonce anyway: `useDeepLink` treats a link with no `n` as a single
 * instruction to open, and clicking one is a real navigation in its own right.
 */
export const nextOpenNonce = () => String(++openNonceSeq);

/**
 * A canonical UUID, any version — the shape every id in this product has
 * (`@default(uuid(7))` on every model).
 *
 * Deliberately a regex rather than `z.string().uuid()`: this module is imported
 * by client components, and pulling zod into a page's bundle to test one string
 * is a cost with nothing to show for it. The check is the same one.
 *
 * Note what this is NOT for. UUIDv7 ids are time-sortable, so adjacent ids
 * created in the same millisecond differ only in a random tail — an id is never
 * a capability, and passing this test says only that the string is well formed,
 * never that the caller may read the record. Authorization stays on the server.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether a value is a well-formed UUID. */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Reading a "open this thing" deep link, e.g. `?request=<id>&n=<nonce>`.
 *
 * Every surface the notification bell links to had hand-rolled this, and all of
 * them had the same two faults:
 *
 *   · the once-only guard was the SUBJECT ID, so a second notification about the
 *     same subject was ignored for the life of the page;
 *   · the params were stripped with `history.replaceState`, which Next's router
 *     never learns about — so pushing the identical href again wasn't a
 *     navigation at all, the search params never changed, and the effect never
 *     re-ran.
 *
 * Together those made the most recent notification — the one about the thing you
 * had just been looking at — the one that appeared to do nothing, while older
 * ones worked. The bell now sends a fresh `n` per click; this keys the guard on
 * the (id, nonce) pair so each click is a distinct instruction to open.
 *
 * `clear()` tidies the address bar so a reload or a copied link isn't a re-open.
 * It is history-only on purpose: `router.replace` would re-render the route for a
 * purely cosmetic change, and it is safe here precisely because the guard no
 * longer depends on the URL still holding the params.
 *
 * `{ uuid: true }` VALIDATES BEFORE ANYTHING USES THE ID, and a value that fails
 * reads as ABSENT — the page renders its list and opens nothing, exactly as if no
 * link had been followed. Absent rather than rejected on purpose: an error face
 * for a malformed id is a reply to whoever typed it, and the honest reply to a
 * URL nobody meant to type is the page they asked for. The option is opt-in
 * because two of this hook's callers key on ids they do not own.
 */
export function useDeepLink(
  param: string,
  opts?: {
    /** Ignore an id that is not a well-formed UUID, as though the link were absent. */
    uuid?: boolean;
  },
): {
  /** The subject id, or null when the link isn't present (or fails `uuid`). */
  id: string | null;
  /** Identity of THIS click — pass to `seen`/`wasSeen`. Null when absent. */
  key: string | null;
  /** Has this exact click already been handled? */
  wasSeen: (key: string | null) => boolean;
  /** Mark this click handled, so re-renders don't re-open it. */
  markSeen: (key: string) => void;
  /** Drop the params from the address bar (history only, no navigation). */
  clear: () => void;
} {
  const searchParams = useSearchParams();
  const raw = searchParams?.get(param) ?? null;
  const id = raw === null || (opts?.uuid === true && !isUuid(raw)) ? null : raw;
  const nonce = searchParams?.get('n') ?? null;
  const key = id ? `${id}:${nonce ?? ''}` : null;
  const seenRef = useRef<string | null>(null);

  const wasSeen = useCallback((k: string | null) => k != null && seenRef.current === k, []);
  const markSeen = useCallback((k: string) => {
    seenRef.current = k;
  }, []);
  const clear = useCallback(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.delete(param);
    url.searchParams.delete('n');
    window.history.replaceState(null, '', url.toString());
  }, [param]);

  return { id, key, wasSeen, markSeen, clear };
}
