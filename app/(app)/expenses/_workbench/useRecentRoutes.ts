'use client';

/**
 * The person's previous routes (FR-1): one shared `mileageRoute.recentRoutes` read for the
 * line's dropdown and the workspace's.
 *
 * Never served from a cached answer (`staleTime: 0`): a line added a moment ago is the
 * likeliest route to reuse, and it is not in a list read before it was saved. Rows mounted
 * together still share one request. The answer is held only a minute after its last
 * reader goes (`gcTime`), not the default five.
 *
 * A failed read is an empty list: the dropdown offers New route alone, which is the
 * primary path anyway, and a convenience list is not worth an error.
 */

import { trpc } from '@/lib/trpc/client';
import type { PreviousRoute } from './routeWorkspace';

export function useRecentRoutes(enabled = true): PreviousRoute[] {
  const recent = trpc.mileageRoute.recentRoutes.useQuery(undefined, {
    enabled,
    staleTime: 0,
    gcTime: 60_000,
  });
  return (recent.data?.routes ?? []) as PreviousRoute[];
}
