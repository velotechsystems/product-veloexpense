'use client';

import {
  AdminLookupPage,
  type BaseLookupRow,
  mapFromEntries,
} from '@/components/admin/AdminLookupPage';
import { trpc } from '@/lib/trpc/client';

type BusinessUnitColumnId = 'code' | 'label' | 'externalIds' | 'status' | 'actions';

type BusinessUnitRow = BaseLookupRow;

export function BusinessUnitsAdmin({ canWrite }: { canWrite: boolean }) {
  const query = trpc.businessUnits.list.useQuery({ includeInactive: true });
  const createMutation = trpc.businessUnits.create.useMutation();
  const updateMutation = trpc.businessUnits.update.useMutation();
  const setActiveMutation = trpc.businessUnits.setActive.useMutation();

  return (
    <AdminLookupPage<BusinessUnitRow, BusinessUnitColumnId>
      config={{
        entityKey: 'businessUnits',
        savedViewsResource: 'businessUnits',
        canWrite,
        query: {
          data: query.data as { items: BusinessUnitRow[] } | undefined,
          isLoading: query.isLoading,
          refetch: () => {
            void query.refetch();
          },
        },
        buildCreatePayload: (form) => ({
          label: { en: form.labelEn, 'fr-CA': form.labelFr },
          description:
            form.descriptionEn || form.descriptionFr
              ? { en: form.descriptionEn, 'fr-CA': form.descriptionFr }
              : null,
          externalIds: mapFromEntries(form.externalIds),
          active: form.active,
        }),
        buildUpdatePayload: (form) => ({
          label: { en: form.labelEn, 'fr-CA': form.labelFr },
          description:
            form.descriptionEn || form.descriptionFr
              ? { en: form.descriptionEn, 'fr-CA': form.descriptionFr }
              : null,
          externalIds: mapFromEntries(form.externalIds),
          active: form.active,
        }),
        createMutation: {
          mutateAsync: (input) =>
            createMutation.mutateAsync(input as Parameters<typeof createMutation.mutateAsync>[0]),
          isPending: createMutation.isPending,
        },
        updateMutation: {
          mutateAsync: (input) =>
            updateMutation.mutateAsync(input as Parameters<typeof updateMutation.mutateAsync>[0]),
          isPending: updateMutation.isPending,
        },
        setActiveMutation: {
          mutateAsync: (input) => setActiveMutation.mutateAsync(input),
          isPending: setActiveMutation.isPending,
        },
      }}
    />
  );
}
