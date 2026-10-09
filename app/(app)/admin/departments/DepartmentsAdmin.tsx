'use client';

import type { Locale } from '@expenseos/i18n/locales';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import {
  AdminLookupPage,
  type BaseLookupRow,
  Field,
  mapFromEntries,
  pickLabel,
} from '@/components/admin/AdminLookupPage';
import { trpc } from '@/lib/trpc/client';

// Departments default to a FLAT list sorted by label. The parent /
// child relationship is still visible in the detail drawer — the
// prior "tree DFS by parent" default obscured the alphabetical
// lookup admins actually want. Tree grouping will return later as
// an opt-in group-by option, once AdminLookupPage gains a group-by
// knob.
type DepartmentColumnId = 'label' | 'externalIds' | 'status' | 'actions';

type DepartmentRow = BaseLookupRow & { parentId: string | null };

export function DepartmentsAdmin({ canWrite }: { canWrite: boolean }) {
  const tc = useTranslations('admin.common');
  const tAdmin = useTranslations('admin.departments');
  const locale = useLocale() as Locale;

  const query = trpc.departments.list.useQuery({ includeInactive: true });
  const createMutation = trpc.departments.create.useMutation();
  const updateMutation = trpc.departments.update.useMutation();
  const setActiveMutation = trpc.departments.setActive.useMutation();

  // Id → label lookup for the parent picker dropdown + the "Parent"
  // row inside the detail drawer.
  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of (query.data?.items ?? []) as unknown as DepartmentRow[]) {
      map.set(r.id, pickLabel(r.label, locale) || r.id);
    }
    return map;
  }, [query.data, locale]);

  // Flat-by-label default sort. The server returns rows in id order;
  // resolve the locale-specific label and sort here so the default
  // view reads as A→Z by display name.
  const sortedItems = useMemo<DepartmentRow[] | undefined>(() => {
    const items = (query.data?.items ?? []) as unknown as DepartmentRow[];
    if (items.length === 0) return items;
    return [...items].sort((a, b) =>
      (pickLabel(a.label, locale) || a.id).localeCompare(pickLabel(b.label, locale) || b.id),
    );
  }, [query.data, locale]);

  // Parent picker options. Departments at depth 0 (top-level) can be
  // chosen as a parent for any other department. Listing every
  // department is fine — the server's `preWrite` cycle-detection
  // refuses moves that would create a loop.
  const parentOptions = useMemo(() => {
    const items = (query.data?.items ?? []) as unknown as DepartmentRow[];
    return items
      .map((r) => ({
        value: r.id,
        label: pickLabel(r.label, locale) || r.id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [query.data, locale]);

  return (
    <AdminLookupPage<DepartmentRow, DepartmentColumnId>
      config={{
        entityKey: 'departments',
        savedViewsResource: 'departments',
        canWrite,
        query: {
          // Hand AdminLookupPage the locale-sorted list so the flat
          // default view reads A→Z. Loading / refetch stay wired to
          // the underlying tRPC query.
          data: sortedItems ? { items: sortedItems } : undefined,
          isLoading: query.isLoading,
          refetch: () => {
            void query.refetch();
          },
        },
        renderViewExtras: (row) => (
          <Field label={tc('parent')}>
            {row.parentId ? (
              (labelById.get(row.parentId) ?? row.parentId.slice(0, 8))
            ) : (
              <span className="text-muted-foreground">{tc('noParent')}</span>
            )}
          </Field>
        ),
        extraFields: [
          {
            name: 'parentId',
            label: tc('parent'),
            kind: {
              kind: 'select' as const,
              options: parentOptions,
              help: tAdmin('parentHelp'),
            },
          },
        ],
        buildCreatePayload: (form) => ({
          label: { en: form.labelEn, 'fr-CA': form.labelFr },
          description:
            form.descriptionEn || form.descriptionFr
              ? { en: form.descriptionEn, 'fr-CA': form.descriptionFr }
              : null,
          parentId: form.extras.parentId || null,
          externalIds: mapFromEntries(form.externalIds),
          active: form.active,
        }),
        buildUpdatePayload: (form) => ({
          label: { en: form.labelEn, 'fr-CA': form.labelFr },
          description:
            form.descriptionEn || form.descriptionFr
              ? { en: form.descriptionEn, 'fr-CA': form.descriptionFr }
              : null,
          parentId: form.extras.parentId || null,
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
