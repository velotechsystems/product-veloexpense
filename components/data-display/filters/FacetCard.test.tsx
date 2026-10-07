import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FacetCard, FacetRail } from './FacetCard';
import type { FacetOption } from './types';

/**
 * The facet card and the rail of them.
 *
 * A facet list is how somebody discovers what values exist, so the failures are about
 * things being unfindable rather than about anything breaking: a value that sorts into an
 * unexpected place, a search that filters on the stored code instead of the visible label,
 * or a zero-count option that disappears entirely so the user concludes the data is
 * missing rather than filtered out.
 */

const OPTIONS: FacetOption[] = [
  { value: 'SUBMITTED', label: 'Submitted', count: 12 },
  { value: 'APPROVED', label: 'Approved', count: 3 },
  { value: 'DRAFT', label: 'Draft', count: 0 },
];

const labelsInOrder = () =>
  screen.getAllByRole('checkbox').map((cb) => cb.closest('label')?.textContent?.trim() ?? '');

describe('FacetCard — listing values', () => {
  it('sorts alphabetically by LABEL, not by the incoming order', () => {
    /**
     * The list is read to find a value, and only alphabetical order makes that possible
     * without scanning. Sorting by the stored value would order by `APPROVED, DRAFT,
     * SUBMITTED` — coincidentally the same here, which is why the assertion is on the
     * visible labels.
     */
    render(<FacetCard title="Status" options={OPTIONS} selected={[]} onToggle={vi.fn()} />);
    expect(labelsInOrder().map((t) => t.replace(/\d.*$/, '').trim())).toEqual([
      'Approved',
      'Draft',
      'Submitted',
    ]);
  });

  it('keeps a zero-count option visible, just dimmed', () => {
    // Removing it would tell the user the value does not exist, when it exists and is
    // currently excluded by another filter — a materially different thing.
    render(<FacetCard title="Status" options={OPTIONS} selected={[]} onToggle={vi.fn()} />);
    const draft = screen.getByText('Draft').closest('label');
    expect(draft).toBeInTheDocument();
    expect(draft?.className).toContain('opacity-50');
  });

  it('does NOT dim a zero-count option that is selected', () => {
    // It is the active filter; greying out the thing the user just chose reads as disabled.
    render(<FacetCard title="Status" options={OPTIONS} selected={['DRAFT']} onToggle={vi.fn()} />);
    expect(screen.getByText('Draft').closest('label')?.className).not.toContain('opacity-50');
  });

  it('reflects the selection in the checkboxes', () => {
    render(
      <FacetCard title="Status" options={OPTIONS} selected={['SUBMITTED']} onToggle={vi.fn()} />,
    );
    const submitted = screen.getByText('Submitted').closest('label');
    expect(submitted?.querySelector('input')).toBeChecked();
  });

  it('toggles by VALUE, not by label', async () => {
    // The caller filters the query on the stored value; handing it "Submitted" would match
    // nothing.
    const onToggle = vi.fn();
    render(<FacetCard title="Status" options={OPTIONS} selected={[]} onToggle={onToggle} />);
    await userEvent.click(screen.getByText('Submitted'));
    expect(onToggle).toHaveBeenCalledWith('SUBMITTED');
  });

  it('says so when there is nothing to show', () => {
    // An empty card with no message looks like a rendering failure.
    render(<FacetCard title="Status" options={[]} selected={[]} onToggle={vi.fn()} />);
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });
});

describe('FacetCard — counts', () => {
  it('shows counts under 1000 in full, with thousands separators off the locale', () => {
    render(
      <FacetCard
        title="Status"
        options={[{ value: 'a', label: 'A', count: 999 }]}
        selected={[]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('999')).toBeInTheDocument();
  });

  it('abbreviates thousands, keeping one decimal below 10K', () => {
    // `1.2K` in a 40px-wide column where `1,234` would truncate to `1,2…`.
    render(
      <FacetCard
        title="Status"
        options={[{ value: 'a', label: 'A', count: 1234 }]}
        selected={[]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('1.2K')).toBeInTheDocument();
  });

  it('drops the decimal at 10K and above', () => {
    render(
      <FacetCard
        title="Status"
        options={[{ value: 'a', label: 'A', count: 12_345 }]}
        selected={[]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('12K')).toBeInTheDocument();
  });

  it('abbreviates millions', () => {
    render(
      <FacetCard
        title="Status"
        options={[{ value: 'a', label: 'A', count: 2_500_000 }]}
        selected={[]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('2.5M')).toBeInTheDocument();
  });

  it('renders a zero count rather than hiding it', () => {
    // `0` is information — the value exists and nothing currently matches it. A blank reads
    // as "count unknown".
    render(
      <FacetCard
        title="Status"
        options={[{ value: 'a', label: 'A', count: 0 }]}
        selected={[]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('shows no count column at all when counts are absent', () => {
    // `undefined` is not zero — a facet with no counts supplied must not claim every value
    // has none.
    render(
      <FacetCard
        title="Status"
        options={[{ value: 'a', label: 'A' }]}
        selected={[]}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});

describe('FacetCard — search', () => {
  it('is collapsed until asked for, so the title stays readable', () => {
    render(<FacetCard title="Status" options={OPTIONS} selected={[]} onToggle={vi.fn()} />);
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search values…')).not.toBeInTheDocument();
  });

  it('filters on the visible LABEL, case-insensitively', async () => {
    // Typing what is on screen has to work. Matching the stored value instead would mean
    // searching "Sub" finds nothing while "SUBM" does.
    render(<FacetCard title="Status" options={OPTIONS} selected={[]} onToggle={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Search values' }));
    await userEvent.type(screen.getByPlaceholderText('Search values…'), 'sub');

    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
  });

  it('matches anywhere in the label, not only the start', async () => {
    render(<FacetCard title="Status" options={OPTIONS} selected={[]} onToggle={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Search values' }));
    await userEvent.type(screen.getByPlaceholderText('Search values…'), 'prove');
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('reports no matches rather than showing an empty card', async () => {
    render(<FacetCard title="Status" options={OPTIONS} selected={[]} onToggle={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Search values' }));
    await userEvent.type(screen.getByPlaceholderText('Search values…'), 'zzz');
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('closing the search CLEARS it, restoring the full list', async () => {
    // Leaving the term applied while hiding the box that shows it is how a user concludes
    // values have gone missing.
    render(<FacetCard title="Status" options={OPTIONS} selected={[]} onToggle={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Search values' }));
    await userEvent.type(screen.getByPlaceholderText('Search values…'), 'sub');
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('ignores surrounding whitespace in the term', async () => {
    // A pasted value usually brings a space with it, and " sub" matching nothing looks like
    // the search is broken.
    render(<FacetCard title="Status" options={OPTIONS} selected={[]} onToggle={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Search values' }));
    await userEvent.type(screen.getByPlaceholderText('Search values…'), '  sub  ');
    expect(screen.getByText('Submitted')).toBeInTheDocument();
  });
});

describe('FacetRail', () => {
  it('renders a card per field, titled from the label map', () => {
    render(
      <FacetRail
        fields={['status', 'currency']}
        labels={{ status: 'Status', currency: 'Currency' }}
        options={{ status: OPTIONS, currency: [{ value: 'CAD', label: 'CAD' }] }}
        selectedFor={() => []}
        onToggleValue={vi.fn()}
      />,
    );
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Currency')).toBeInTheDocument();
  });

  it('routes a toggle back with the FIELD it came from', async () => {
    // Two cards, one handler: without the field, the caller cannot tell which facet was
    // clicked and would apply the value to the wrong column.
    const onToggleValue = vi.fn();
    render(
      <FacetRail
        fields={['status', 'currency']}
        labels={{ status: 'Status', currency: 'Currency' }}
        options={{ status: OPTIONS, currency: [{ value: 'CAD', label: 'CAD' }] }}
        selectedFor={() => []}
        onToggleValue={onToggleValue}
      />,
    );
    await userEvent.click(screen.getByText('CAD'));
    expect(onToggleValue).toHaveBeenCalledWith('currency', 'CAD');
  });

  it('renders an empty card for a field with no options supplied', () => {
    // A missing key in the options map must not throw — facet counts arrive asynchronously.
    render(
      <FacetRail
        fields={['status']}
        labels={{ status: 'Status' }}
        options={{} as Record<'status', FacetOption[]>}
        selectedFor={() => []}
        onToggleValue={vi.fn()}
      />,
    );
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('asks per field which values are selected', () => {
    const selectedFor = vi.fn(() => []);
    render(
      <FacetRail
        fields={['status', 'currency']}
        labels={{ status: 'Status', currency: 'Currency' }}
        options={{ status: OPTIONS, currency: [] }}
        selectedFor={selectedFor}
        onToggleValue={vi.fn()}
      />,
    );
    expect(selectedFor).toHaveBeenCalledWith('status');
    expect(selectedFor).toHaveBeenCalledWith('currency');
  });
});
