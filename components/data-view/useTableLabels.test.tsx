import '@testing-library/jest-dom/vitest';
import en from '@expenseos/i18n/catalogs/en/table';
import frCA from '@expenseos/i18n/catalogs/fr-CA/table';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TABLE_LABELS } from '@/components/admin/defaultTableLabels';

/**
 * The shared table-chrome label bag, and the one string it was missing.
 *
 * `DataTable` renders the header's select-all checkbox as
 * `aria-label={labels.selectAll}`. `selectAll` was OPTIONAL on `DataTableLabels`, and
 * neither of the two bags the app actually builds supplied it — so on every list page
 * except People (which passes its own) the attribute rendered as `undefined`, i.e. not at
 * all. axe reports it as `aria-toggle-field-name`: a focusable control that a screen
 * reader announces as "checkbox", with no way to know it selects every row.
 *
 * Confirmed on dev at /admin/business-units: every ROW checkbox carried
 * `aria-label="Select row"`, and the header's carried nothing.
 *
 * Nothing caught it because the DataTable test's own `LABELS` fixture DOES set
 * `selectAll` — the fixture was more complete than production, so the component test
 * exercised a bag no page ever passed. These assertions are against the real bags.
 */

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));

const CATALOGS = { en, 'fr-CA': frCA } as const;

describe('the shared table label bag', () => {
  it('names the select-all checkbox', async () => {
    const { useTableLabels } = await import('./useTableLabels');
    const { result } = renderHook(() => useTableLabels());
    expect(result.current.selectAll).toBeTruthy();
  });

  it('names it in the fallback bag too', () => {
    // AdminLookupPage and friends fall back to this one when no hook is in play.
    expect(DEFAULT_TABLE_LABELS.selectAll).toBeTruthy();
  });

  it.each(Object.keys(CATALOGS))('has a %s catalog entry for it', (loc) => {
    const table = (CATALOGS as Record<string, { misc?: Record<string, string> }>)[loc];
    expect(table.misc?.selectAll).toBeTruthy();
  });
});
