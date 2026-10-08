import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The seed label a picker shows for its current selection.
 *
 * These are async autocompletes over high-cardinality sets — vendors, GL accounts, people —
 * so the label for an already-selected id has to come from somewhere other than the search
 * results. Two sources: `initialItem`, which the host already has because it rendered the
 * row, and a `byId` lookup as the fallback.
 *
 * The bug this pins was in choosing between them. Hosts derive `initialItem` from the SAVED
 * row (`txn.vendor`), so the moment somebody picks something else it describes the OLD
 * selection — and it was winning outright, while the `byId` query that would have resolved
 * the new label was disabled precisely because `initialItem` was set. The control therefore
 * displayed the previous vendor over the new value, which reads as the field refusing to
 * change: "when I attempt to change vendor it keeps reverting to previous value." Nothing
 * reverted — the write was fine and the label was stale.
 */

const h = vi.hoisted(() => ({
  /** Every `byId` call, so a test can assert the lookup was or was not enabled. */
  byIdCalls: [] as { input: unknown; enabled: boolean }[],
  selectedItems: [] as unknown[],
}));

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));

vi.mock('@/lib/trpc/client', () => {
  const query = (name: string) => ({
    useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
      if (name.endsWith('byId')) {
        h.byIdCalls.push({ input, enabled: opts?.enabled ?? true });
        // Resolves only when actually enabled, as react-query does.
        const id = (input as { id: string }).id;
        return opts?.enabled
          ? { data: { value: id, label: `resolved:${id}` }, isFetching: false }
          : { data: undefined, isFetching: false };
      }
      return { data: [], isFetching: false };
    },
  });
  return {
    trpc: {
      pickers: {
        vendors: { search: query('search'), byId: query('vendors.byId') },
        glAccounts: { search: query('search'), byId: query('glAccounts.byId') },
        users: { search: query('search'), byId: query('users.byId') },
      },
    },
  };
});

/** Records what the underlying combobox was told to display. */
vi.mock('@expenseos/design-system', () => ({
  AsyncCombobox: (props: { selectedItem: unknown }) => {
    h.selectedItems.push(props.selectedItem);
    return <div data-testid="combobox" />;
  },
}));

import { GlAccountCombobox, UserCombobox } from './EntityPickers';

const SAVED = { value: 'v-old', label: 'Acme Supplies' };
const shown = () => h.selectedItems.at(-1) as { value: string; label: string } | null;
const lastByIdEnabled = () => h.byIdCalls.at(-1)?.enabled;

afterEach(() => {
  h.byIdCalls = [];
  h.selectedItems = [];
  vi.clearAllMocks();
});

// VeloExpense: `VendorCombobox` is not ported (see EntityPickers.tsx).
describe.each([
  ['GlAccountCombobox', GlAccountCombobox],
  ['UserCombobox', UserCombobox],
] as const)('%s', (_name, Picker) => {
  const show = (value: string | null, initialItem: typeof SAVED | null) =>
    render(<Picker value={value} initialItem={initialItem} onValueChange={() => {}} />);

  it('uses the seed when it describes the current selection', () => {
    /** The point of the prop: no round trip for a label the host already has. */
    show('v-old', SAVED);
    expect(shown()).toEqual(SAVED);
    expect(lastByIdEnabled()).toBe(false);
  });

  it('drops the seed the moment the selection moves', () => {
    /**
     * The reported bug. With `value` on the new id and the seed still describing the old
     * one, the control showed the OLD label — so the field looked like it had reverted.
     */
    show('v-new', SAVED);
    expect(shown()).not.toEqual(SAVED);
    expect(shown()?.value).toBe('v-new');
  });

  it('resolves the new selection by id instead', () => {
    /** And the lookup has to be ENABLED to do it — it was disabled whenever a seed
     *  existed, which is why the stale label had nothing to replace it. */
    show('v-new', SAVED);
    expect(lastByIdEnabled()).toBe(true);
    expect(shown()?.label).toBe('resolved:v-new');
  });

  it('resolves by id when there is no seed at all', () => {
    show('v-new', null);
    expect(lastByIdEnabled()).toBe(true);
    expect(shown()?.value).toBe('v-new');
  });

  it('shows nothing, and looks nothing up, for an empty selection', () => {
    /** A cleared dimension is a real state; a leftover label would say it still had one. */
    show(null, SAVED);
    expect(shown()).toBeNull();
    expect(lastByIdEnabled()).toBe(false);
  });

  it('does not treat a seed for a different id as a match on label alone', () => {
    /** Two vendors can share a name across subsidiaries; the id is the identity. */
    show('v-new', { value: 'v-old', label: 'Acme Supplies' });
    expect(shown()?.value).toBe('v-new');
  });
});
