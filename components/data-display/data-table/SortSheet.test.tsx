import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SortSheet, type SortSheetOption } from './SortSheet';
import type { SortState } from './types';

/**
 * The sort affordance for a list with no header row.
 *
 * The dead-arrow guarantee — that no field is offered which cannot actually
 * reorder anything — is NOT enforced here and cannot be: whether a column
 * sorts depends on the rows, which this component never sees. It is enforced
 * by `resolveSortField` / `sortSheetOptions` in the web app, which the table
 * header calls too, and which have their own tests. What is pinned here is
 * everything downstream of that: that the sheet renders exactly the options
 * it was handed, that every row is a real tap target, and that the four
 * controls ruled out for touch never appear.
 */

const OPTIONS: SortSheetOption[] = [
  { field: 'name', label: 'Name' },
  { field: 'amount', label: 'Amount' },
  { field: 'submittedAt', label: 'Submitted' },
];

function renderSheet(value: SortState | null, options = OPTIONS) {
  const onChange = vi.fn();
  const utils = render(<SortSheet options={options} value={value} onChange={onChange} />);
  return { ...utils, onChange };
}

const openSheet = async () => {
  await userEvent.click(screen.getByRole('button', { name: /^Sort/ }));
  return screen.getByRole('dialog');
};

describe('the trigger', () => {
  it('reads "Sort" when nothing is sorted', () => {
    renderSheet(null);
    expect(screen.getByRole('button', { name: 'Sort' })).toBeInTheDocument();
  });

  it('names the active field, by LABEL', () => {
    // The person picked "Submitted", not `submittedAt`. Echoing the field id
    // back at them describes a column they have never seen named that way.
    renderSheet({ field: 'submittedAt', dir: 'desc' });
    expect(screen.getByRole('button', { name: 'Sort · Submitted' })).toBeInTheDocument();
  });

  it('falls back to "Sort" for a field that is not on offer', () => {
    // A saved view can carry a sort on a column this table no longer has.
    // Naming it would promise a row the sheet does not contain.
    renderSheet({ field: 'ghost', dir: 'asc' });
    expect(screen.getByRole('button', { name: 'Sort' })).toBeInTheDocument();
  });

  it('is a 44px target', () => {
    renderSheet(null);
    expect(screen.getByRole('button', { name: 'Sort' })).toHaveClass('h-11');
  });
});

describe('the field list', () => {
  it('offers exactly the options it was handed, in order', async () => {
    renderSheet(null);
    const sheet = await openSheet();
    const radios = within(sheet).getAllByRole('radio', { checked: false });
    // Three fields + two directions, all unchecked while nothing is sorted.
    expect(radios.map((r) => r.textContent)).toEqual([
      'Name',
      'Amount',
      'Submitted',
      'Ascending',
      'Descending',
    ]);
  });

  it('marks the active field checked, and only it', async () => {
    renderSheet({ field: 'amount', dir: 'asc' });
    const sheet = await openSheet();
    expect(within(sheet).getByRole('radio', { name: 'Amount' })).toBeChecked();
    expect(within(sheet).getByRole('radio', { name: 'Name' })).not.toBeChecked();
  });

  it('every row is a 44px target', async () => {
    // A list of choices where some are reachable and some are fiddly is
    // worse than one where they are all the same size.
    renderSheet(null);
    const sheet = await openSheet();
    for (const row of within(sheet).getAllByRole('radio')) {
      expect(row).toHaveClass('min-h-11');
    }
  });

  it('picking a field KEEPS the direction already chosen', async () => {
    // They asked to re-sort, not to start over.
    const { onChange } = renderSheet({ field: 'name', dir: 'desc' });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Amount' }));
    expect(onChange).toHaveBeenCalledWith({ field: 'amount', dir: 'desc' });
  });

  it('defaults to ascending from unsorted', async () => {
    const { onChange } = renderSheet(null);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Name' }));
    expect(onChange).toHaveBeenCalledWith({ field: 'name', dir: 'asc' });
  });

  it('says so plainly when nothing on the list can be sorted', async () => {
    renderSheet(null, []);
    const sheet = await openSheet();
    expect(within(sheet).getByText('Nothing on this list can be sorted.')).toBeInTheDocument();
    expect(within(sheet).queryAllByRole('radio')).toHaveLength(0);
  });
});

describe('direction', () => {
  it('is inert until there is a field to apply it to', async () => {
    // Enabling it would either do nothing or silently sort by whichever
    // field happened to be first.
    const { onChange } = renderSheet(null);
    const sheet = await openSheet();
    const desc = within(sheet).getByRole('radio', { name: 'Descending' });
    expect(desc).toBeDisabled();
    await userEvent.click(desc);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('flips the active field without changing it', async () => {
    const { onChange } = renderSheet({ field: 'amount', dir: 'asc' });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Descending' }));
    expect(onChange).toHaveBeenCalledWith({ field: 'amount', dir: 'desc' });
  });

  it('shows which way it is currently pointing', async () => {
    renderSheet({ field: 'amount', dir: 'desc' });
    const sheet = await openSheet();
    expect(within(sheet).getByRole('radio', { name: 'Descending' })).toBeChecked();
    expect(within(sheet).getByRole('radio', { name: 'Ascending' })).not.toBeChecked();
  });
});

describe('what is ruled out for touch, and stays out', () => {
  it('offers no resize, pin, reorder, density or row-drag control', async () => {
    // Not behind a flag — absent. Resize, pin and reorder are meaningless
    // without a header row; density maps three settings onto card padding
    // that has its own rhythm; native HTML5 row drag does not fire on touch
    // at all.
    renderSheet({ field: 'amount', dir: 'asc' });
    const sheet = await openSheet();
    for (const banned of [/resize/i, /pin/i, /reorder/i, /density/i, /drag/i, /compact/i]) {
      expect(within(sheet).queryByText(banned)).toBeNull();
    }
  });
});

describe('the footer', () => {
  it('clears the sort', async () => {
    const { onChange } = renderSheet({ field: 'amount', dir: 'asc' });
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Clear sort' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('has nothing to clear when unsorted', async () => {
    renderSheet(null);
    const sheet = await openSheet();
    expect(within(sheet).getByRole('button', { name: 'Clear sort' })).toBeDisabled();
  });

  it('has 44px buttons and Done closes', async () => {
    renderSheet(null);
    const sheet = await openSheet();
    const done = within(sheet).getByRole('button', { name: 'Done' });
    expect(done).toHaveClass('h-11');
    expect(within(sheet).getByRole('button', { name: 'Clear sort' })).toHaveClass('h-11');
    await userEvent.click(done);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('copy', () => {
  it('takes every string as a prop — the design system has no catalog', async () => {
    render(
      <SortSheet
        options={OPTIONS}
        value={{ field: 'amount', dir: 'asc' }}
        onChange={vi.fn()}
        labels={{
          trigger: 'Trier',
          triggerWithField: (l) => `Trier · ${l}`,
          title: 'Trier par',
          field: 'Champ',
          direction: 'Sens',
          ascending: 'Croissant',
          descending: 'Décroissant',
          empty: 'Rien à trier.',
          clearSort: 'Effacer le tri',
          done: 'Terminé',
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Trier · Amount' }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('radiogroup', { name: 'Champ' })).toBeInTheDocument();
    expect(within(sheet).getByRole('radio', { name: 'Croissant' })).toBeChecked();
  });
});
