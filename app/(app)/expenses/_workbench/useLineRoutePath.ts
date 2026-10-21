'use client';

/**
 * A saved line's path, asked for once each time its small map is mounted (spec FR-3).
 *
 * Nothing Google draws is kept on the line. The writer's view asks
 * `mileageRoute.lineRoutePath({ lineItemId })` for the path; the server routes the line's
 * stored stops, through its stored pass-through place IDs, with one Google call and
 * writes nothing. The answer lives here, in this
 * mounted map's React state, and goes with it: no persisted cache, nothing reused by
 * another mount.
 *
 * Once per mount. The call is sent from a mount effect behind a ref, so a re-render — or
 * React's StrictMode running the effect twice in development — never sends a second one.
 * A changed route is a new mount (the caller keys the map by the route), so it asks once
 * more and never shows the old route's path.
 *
 * Never retried. Every call is one paid Google request counted against the per-person
 * limit, so a mutation (no prefetch, no cache, no refetch) with `retry: 0` — explicit, so
 * a default added to the query client later cannot double-bill. A failure is final for
 * this mount: the line shows its text summary, and the next view asks again.
 *
 *   · `pending` — asked, no answer yet (or not asked: `enabled` is false);
 *   · `ready`   — the path to draw;
 *   · `failed`  — the call failed (throttled, refused, network) or there is nothing to draw.
 */

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';

export type LineRoutePath =
  | { status: 'pending' }
  | { status: 'ready'; encodedPolyline: string }
  | { status: 'failed' };

/** What the mutation is created with: no cache to outlive the mount, and no retry. */
export const LINE_ROUTE_PATH_OPTIONS = { gcTime: 0, retry: 0 } as const;

export function useLineRoutePath({
  lineItemId,
  enabled,
}: {
  lineItemId: string;
  /** False holds the call back (a page whose map library already failed). */
  enabled: boolean;
}): LineRoutePath {
  const linePath = trpc.mileageRoute.lineRoutePath.useMutation(LINE_ROUTE_PATH_OPTIONS);
  const send = linePath.mutateAsync;
  const asked = useRef(false);
  const [state, setState] = useState<LineRoutePath>({ status: 'pending' });

  useEffect(() => {
    if (!enabled || asked.current) return;
    asked.current = true;
    send({ lineItemId })
      .then((res) => {
        setState(
          res.encodedPolyline
            ? { status: 'ready', encodedPolyline: res.encodedPolyline }
            : { status: 'failed' },
        );
      })
      .catch(() => setState({ status: 'failed' }));
  }, [enabled, lineItemId, send]);

  return state;
}
