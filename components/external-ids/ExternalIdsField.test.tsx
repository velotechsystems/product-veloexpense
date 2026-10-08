import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * The one external-IDs control, wired to the tenant's own systems.
 *
 * The picker used to offer a hardcoded list of four names — wrong in both directions: it
 * offered systems a tenant does not use, and could not offer one they had added. What
 * matters here is what it does when the list is EMPTY or PARTIAL, because both are normal:
 * the list is fetched, so it is empty on first paint, and a source seeded by a sync has
 * only its code for a label.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown, locale: 'en' }));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useLocale: () => h.locale,
  useTranslations: (ns?: string) => (k: string) => (ns ? `${ns}.${k}` : k),
}));

const { ExternalIdsField } = await import('./ExternalIdsField');

function setTrpc(sources: unknown, over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'pickers.externalIdSources': { data: sources }, ...over.queries },
  });
}

/** The field is controlled, so the host owns the rows the way a real form does. */
function Host({ initial = [] as { rowId: string; key: string; value: string }[] }) {
  const [entries, setEntries] = useState(initial);
  return <ExternalIdsField entries={entries} onChange={setEntries} />;
}

const show = (entries: { rowId: string; key: string; value: string }[] = []) =>
  render(<Host initial={entries} />);

afterEach(() => {
  h.trpc = undefined;
  h.locale = 'en';
  vi.restoreAllMocks();
});

describe('ExternalIdsField', () => {
  it('names each system the way the tenant does', async () => {
    setTrpc([{ code: 'netsuite', label: { en: 'NetSuite', 'fr-CA': 'NetSuite' } }]);
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: 'admin.common.addId' }));
    expect(screen.getByRole('option', { name: 'NetSuite' })).toBeInTheDocument();
  });

  it('reads the label in the READER’s language', async () => {
    h.locale = 'fr-CA';
    setTrpc([{ code: 'google', label: { en: 'Google Workspace', 'fr-CA': 'Google Agenda' } }]);
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: 'admin.common.addId' }));
    expect(screen.getByRole('option', { name: 'Google Agenda' })).toBeInTheDocument();
  });

  it('falls back to the code for a source nobody has translated', async () => {
    /**
     * Sources are upserted by a sync with `{ en: code, 'fr-CA': code }`, and a newer one
     * can arrive with a label the reader's locale does not carry. A blank option is a
     * system nobody can pick.
     */
    h.locale = 'fr-CA';
    setTrpc([{ code: 'homegrown', label: {} }]);
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: 'admin.common.addId' }));
    expect(screen.getByRole('option', { name: 'homegrown' })).toBeInTheDocument();
  });

  it('still lets a row be typed while the list has not arrived', async () => {
    /**
     * The query is in flight on first paint. With no list there is nothing to put in a
     * dropdown, so the row falls back to free text rather than to a picker with no
     * options — which would be a control that cannot be used at all.
     */
    setTrpc(undefined);
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: 'admin.common.addId' }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('admin.common.system')).toBeInTheDocument();
  });

  it('renders a stored id even before the systems load', () => {
    // The value is the point; the picker is how it is changed.
    setTrpc(undefined);
    show([{ rowId: 'r1', key: 'netsuite', value: '10096345' }]);
    expect(screen.getByDisplayValue('10096345')).toBeInTheDocument();
  });
});
