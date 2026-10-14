'use client';

import { useMemo } from 'react';
import { trpc } from '@/lib/trpc/client';
import type { DropdownView, PersistedViewState, SystemView, UserView } from './types';

/**
 * Encapsulates the saved-views API: fetches user-saved views for a
 * resource, merges with caller-supplied system defaults, and exposes
 * the mutation handlers the dropdown needs.
 */
export type SavedViewResource =
  | 'people'
  | 'expenses'
  | 'cards'
  | 'transactions'
  | 'businessUnits'
  | 'legalEntities'
  | 'departments'
  | 'roles'
  | 'approvals'
  | 'delegations'
  | 'budgets';

export function useSavedViews<F extends string>(opts: {
  resource: SavedViewResource;
  systemViews: SystemView<F>[];
  onAfterCreate?: (newId: string) => void;
  onAfterDelete?: () => void;
}) {
  const { resource, systemViews } = opts;
  const utils = trpc.useUtils();
  const listQuery = trpc.savedViews.list.useQuery({ resource }, { staleTime: 30_000 });

  const invalidate = () => utils.savedViews.list.invalidate({ resource });

  const create = trpc.savedViews.create.useMutation({
    onSuccess: (created) => {
      invalidate();
      opts.onAfterCreate?.(created.id);
    },
  });
  const update = trpc.savedViews.update.useMutation({ onSuccess: invalidate });
  const remove = trpc.savedViews.delete.useMutation({
    onSuccess: () => {
      invalidate();
      opts.onAfterDelete?.();
    },
  });
  const togglePinned = trpc.savedViews.togglePinned.useMutation({ onSuccess: invalidate });

  const userViews: UserView<F>[] = useMemo(() => {
    return (listQuery.data ?? []).map((v) => ({
      kind: 'user' as const,
      id: v.id,
      name: v.name,
      pinned: v.pinned,
      state: v.state as unknown as PersistedViewState<F>,
    }));
  }, [listQuery.data]);

  const allViews: DropdownView<F>[] = useMemo(
    () => [...systemViews, ...userViews],
    [systemViews, userViews],
  );

  return {
    allViews,
    isLoading: listQuery.isLoading,
    createView: (name: string, state: PersistedViewState<F>, pinned = false) =>
      create.mutate({ resource, name, state, pinned }),
    renameView: (id: string, name: string) => update.mutate({ id, name }),
    updateViewState: (id: string, state: PersistedViewState<F>) => update.mutate({ id, state }),
    deleteView: (id: string) => remove.mutate({ id }),
    togglePinnedView: (id: string) => togglePinned.mutate({ id }),
  };
}
