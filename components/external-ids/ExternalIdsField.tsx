'use client';

/**
 * The one external-IDs control in the product.
 *
 * Every entity that federates to an outside system carries a `Record<string, string>`
 * of `{ systemCode: externalId }`, and the product used to offer that map two different
 * ways. Admin lookups had a sub-form. The People drawer had a FIELD PER SYSTEM, rendered
 * whether or not the person had an id in it — so a directory with four sources put four
 * permanently-empty boxes in front of anybody editing a name, and adding a fifth source
 * silently changed every profile form in the app.
 *
 * This is the sub-form, wired once: it fetches the tenant's own `ExternalIdSource` rows
 * and hands the editor its localized labels, so a call site is one component and no
 * repeated plumbing. The shape is the repeating-row idiom the rest of the product already
 * uses — pick a system, type the id, trash it at the end of the row, "Add an external ID"
 * underneath.
 */

import {
  type ExternalIdEntry,
  type ExternalIdSourceOption,
  ExternalIdsEditor,
} from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { trpc } from '@/lib/trpc/client';

/**
 * The systems a tenant federates to, localized.
 *
 * Cached generously: it is a handful of rows that change when somebody installs an
 * integration, and every sub-form on a page would otherwise ask for it again.
 */
export function useExternalIdSources(): ExternalIdSourceOption[] {
  const locale = useLocale() as Locale;
  const q = trpc.pickers.externalIdSources.useQuery(undefined, { staleTime: 5 * 60_000 });
  return useMemo(
    () =>
      (q.data ?? []).map((s) => ({
        code: s.code,
        // A source whose label was never translated still has to read as something; its
        // code is the honest fallback and is what the seed writes anyway.
        label: (getLocalized(s.label, locale) as string) || s.code,
      })),
    [q.data, locale],
  );
}

export function ExternalIdsField({
  entries,
  onChange,
}: {
  entries: ExternalIdEntry[];
  onChange: (next: ExternalIdEntry[]) => void;
}) {
  const tc = useTranslations('admin.common');
  const sources = useExternalIdSources();
  return (
    <ExternalIdsEditor
      entries={entries}
      onChange={onChange}
      sources={sources}
      labels={{
        key: tc('system'),
        value: tc('value'),
        addRow: tc('addId'),
        removeRow: tc('remove'),
        help: '',
        other: tc('externalIdOther'),
      }}
    />
  );
}
