'use client';

import { Badge } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import {
  AdminLookupPage,
  type BaseLookupRow,
  type ColumnDef,
  Field,
  mapFromEntries,
} from '@/components/admin/AdminLookupPage';
import { CountryLabel } from '@/components/pickers/CountryDisplay';
import { trpc } from '@/lib/trpc/client';

type LegalEntityColumnId =
  | 'code'
  | 'label'
  | 'externalIds'
  | 'status'
  | 'country'
  | 'homeCurrency'
  | 'itcRecoverable'
  | 'actions';

type LegalEntityRow = BaseLookupRow & {
  country: string | null;
  /** Projected through the FK — the server selects the currency's code. */
  homeCurrency: { code: string } | null;
  homeCurrencyId: string | null;
  itcRecoverable: boolean;
};

export function LegalEntitiesAdmin({ canWrite }: { canWrite: boolean }) {
  const tc = useTranslations('admin.common');
  const tAdmin = useTranslations('admin.legalEntities');
  const query = trpc.legalEntities.list.useQuery({ includeInactive: true });
  const createMutation = trpc.legalEntities.create.useMutation();
  const updateMutation = trpc.legalEntities.update.useMutation();
  const setActiveMutation = trpc.legalEntities.setActive.useMutation();

  const extraColumns = useMemo<ColumnDef<LegalEntityRow, LegalEntityColumnId>[]>(
    () => [
      {
        id: 'country' as LegalEntityColumnId,
        label: tc('country'),
        defaultWidth: 190,
        cell: (row) => <CountryLabel code={row.country} />,
      },
      {
        id: 'homeCurrency' as LegalEntityColumnId,
        label: tc('currency'),
        defaultWidth: 130,
        cell: (row) =>
          row.homeCurrency ? (
            <span className="font-mono text-foreground text-sm">{row.homeCurrency.code}</span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          ),
      },
      {
        id: 'itcRecoverable' as LegalEntityColumnId,
        label: tAdmin('itcRecoverable'),
        defaultWidth: 150,
        cell: (row) => (
          <Badge variant={row.itcRecoverable ? 'success' : 'secondary'}>
            {row.itcRecoverable ? tAdmin('itcYes') : tAdmin('itcNo')}
          </Badge>
        ),
      },
    ],
    [tc, tAdmin],
  );

  return (
    <AdminLookupPage<LegalEntityRow, LegalEntityColumnId>
      config={{
        entityKey: 'legalEntities',
        savedViewsResource: 'legalEntities',
        canWrite,
        groupableColumns: ['country', 'homeCurrency'],
        query: {
          data: query.data as { items: LegalEntityRow[] } | undefined,
          isLoading: query.isLoading,
          refetch: () => {
            void query.refetch();
          },
        },
        extraColumns,
        renderViewExtras: (row) => (
          <>
            <Field label={tc('country')}>
              <CountryLabel code={row.country} />
            </Field>
            <Field label={tc('currency')}>
              {row.homeCurrency ? <span className="font-mono">{row.homeCurrency.code}</span> : '—'}
            </Field>
            <Field label={tAdmin('itcRecoverable')}>
              <Badge variant={row.itcRecoverable ? 'success' : 'secondary'}>
                {row.itcRecoverable ? tAdmin('itcYes') : tAdmin('itcNo')}
              </Badge>
            </Field>
          </>
        ),
        extraFields: [
          {
            name: 'country',
            label: tc('country'),
            kind: {
              kind: 'picker' as const,
              widget: 'country' as const,
              placeholder: tAdmin('countryPlaceholder'),
              help: tAdmin('countryHelp'),
            },
          },
          {
            name: 'homeCurrencyId',
            label: tc('currency'),
            // Picked from the active Currency rows, and now by ID: the column is a
            // foreign key, so a code would be written to something that no longer
            // exists. (It was already a picker — only the value it hands back
            // changed.)
            kind: {
              kind: 'picker' as const,
              widget: 'currencyId' as const,
              placeholder: tAdmin('currencyPlaceholder'),
              help: tAdmin('currencyHelp'),
            },
          },
          {
            name: 'itcRecoverable',
            label: tAdmin('itcRecoverable'),
            // Matches `LegalEntity.itcRecoverable`'s own `@default(true)`. Without
            // it a new entity was created unable to reclaim input tax.
            kind: {
              kind: 'boolean' as const,
              help: tAdmin('itcRecoverableHelp'),
              defaultValue: true,
            },
          },
        ],
        buildCreatePayload: (form) => ({
          label: { en: form.labelEn, 'fr-CA': form.labelFr },
          description:
            form.descriptionEn || form.descriptionFr
              ? { en: form.descriptionEn, 'fr-CA': form.descriptionFr }
              : null,
          country: form.extras.country?.trim() || null,
          homeCurrencyId: form.extras.homeCurrencyId?.trim() || null,
          itcRecoverable: form.extras.itcRecoverable !== 'false',
          externalIds: mapFromEntries(form.externalIds),
          active: form.active,
        }),
        buildUpdatePayload: (form) => ({
          label: { en: form.labelEn, 'fr-CA': form.labelFr },
          description:
            form.descriptionEn || form.descriptionFr
              ? { en: form.descriptionEn, 'fr-CA': form.descriptionFr }
              : null,
          country: form.extras.country?.trim() || null,
          homeCurrencyId: form.extras.homeCurrencyId?.trim() || null,
          itcRecoverable: form.extras.itcRecoverable !== 'false',
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
