import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MultiSelectDropdown } from './MultiSelectDropdown';

const ITEMS = [
  { value: 'eng', label: 'Engineering' },
  { value: 'sales', label: 'Sales' },
  { value: 'mkt', label: 'Marketing' },
  { value: 'fin', label: 'Finance' },
];

describe('<MultiSelectDropdown>', () => {
  it('renders the placeholder when nothing is selected', () => {
    render(
      <MultiSelectDropdown
        items={ITEMS}
        value={[]}
        onValueChange={() => {}}
        placeholder="Select departments"
      />,
    );
    expect(screen.getByText('Select departments')).toBeInTheDocument();
  });

  it('renders selected values as badge tags inside the trigger', () => {
    render(<MultiSelectDropdown items={ITEMS} value={['eng', 'sales']} onValueChange={() => {}} />);
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
  });

  it('opens the popover and shows all options on trigger click', async () => {
    render(<MultiSelectDropdown items={ITEMS} value={[]} onValueChange={() => {}} />);
    await userEvent.click(screen.getByRole('button'));
    // Both the trigger (when selected) and the popover would show labels; with
    // empty selection only the popover shows them, so a single match per item.
    expect(screen.getByText('Marketing')).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
  });

  it('toggles a value on item click', async () => {
    const onValueChange = vi.fn();
    render(<MultiSelectDropdown items={ITEMS} value={[]} onValueChange={onValueChange} />);
    await userEvent.click(screen.getByRole('button'));
    await userEvent.click(screen.getByText('Engineering'));
    expect(onValueChange).toHaveBeenCalledWith(['eng']);
  });

  it('Select-All selects every option', async () => {
    const onValueChange = vi.fn();
    render(<MultiSelectDropdown items={ITEMS} value={[]} onValueChange={onValueChange} />);
    await userEvent.click(screen.getByRole('button'));
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onValueChange).toHaveBeenCalledWith(['eng', 'sales', 'mkt', 'fin']);
  });

  it('Clear empties the selection', async () => {
    const onValueChange = vi.fn();
    render(<MultiSelectDropdown items={ITEMS} value={['eng']} onValueChange={onValueChange} />);
    // The trigger is the first button (open popover); All / Clear / Done are inside.
    const triggers = screen.getAllByRole('button');
    await userEvent.click(triggers[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onValueChange).toHaveBeenCalledWith([]);
  });

  it('shows the empty state when the search has no matches', async () => {
    render(
      <MultiSelectDropdown
        items={ITEMS}
        value={[]}
        onValueChange={() => {}}
        emptyText="No matches"
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    await userEvent.type(screen.getByPlaceholderText('Search…'), 'zzzzz');
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  /**
   * The third pinned popup, fixed alongside the two combobox twins.
   *
   * It was `w-[var(--anchor-width)] min-w-[12rem]` — exactly the trigger's width, so a long
   * option label (a GL account, a legal-entity name) had nowhere to go. Same shape of fix as
   * `select.tsx` and `combobox.tsx`: at least the trigger, free to grow, capped to the
   * viewport so a fixed-position overlay cannot walk off a 375px screen.
   *
   * Asserted on the rendered popup rather than on the literal `className` prop because
   * `PopoverContent` brings its own `w-72 p-4`, and it is `cn`/tailwind-merge that decides
   * which of the two survives. Reading the prop would pass on a string Tailwind then
   * discards.
   *
   * Classes, not geometry — jsdom has no layout engine. The browser-side proof for this
   * family of popups is `e2e/combobox-popup-width.spec.ts`.
   */
  it('lets the popover grow past the trigger, capped to the viewport', async () => {
    render(<MultiSelectDropdown items={ITEMS} value={[]} onValueChange={() => {}} />);
    await userEvent.click(screen.getAllByRole('button')[0]);
    const cls = screen.getByRole('dialog').className;
    // VeloExpense: the kit's popover is Radix, which names the trigger width
    // `--radix-popover-trigger-width` where Base UI says `--anchor-width`.
    expect(cls).not.toMatch(/(^|\s)w-\[var\(--radix-popover-trigger-width\)\]/);
    expect(cls).toContain('w-auto');
    expect(cls).toContain('min-w-[max(12rem,var(--radix-popover-trigger-width))]');
    expect(cls).toContain('max-w-[min(92vw,32rem)]');
    // PopoverContent's own defaults must have lost the merge, or the cap is decoration.
    expect(cls).not.toMatch(/(^|\s)w-72(\s|$)/);
  });

  /**
   * The other half of the same fix: the popup may now grow, but a label longer than the
   * `min(92vw,32rem)` cap still has to go somewhere. UX's ruling for this defect class is
   * "wrap. Not ellipsis, not horizontal scroll" — ellipsis makes the option
   * unpickable-by-reading, which is worst precisely where the disambiguating part of a GL
   * account or legal-entity name sits at the end.
   *
   * Widening alone did NOT deliver that here. `CommandItem`
   * (`packages/design-system/src/components/ui/command.tsx:102`) never received the
   * `whitespace-normal break-words` that both combobox twins and `select.tsx` got, and the
   * row sits inside three nested clipping ancestors (`CommandGroup` and `Command` are
   * `overflow-hidden`, `CommandList` is `overflow-x-hidden`), so a label past the cap was
   * cut off with no ellipsis and no scrollbar.
   *
   * Three classes are pinned, and each one is load-bearing on its own — measured in
   * Chromium at 375x667 (cap 345px) with a 76-char slash-joined label:
   *
   *   - `break-words`: a slash-joined label has no soft break point, so `white-space`
   *     (already `normal` by default here) achieves nothing without it.
   *   - `min-w-0` on the label's own box: the load-bearing one, and the reason the class
   *     pair alone is not enough. The label is a flex item of the row, so its
   *     `min-width: auto` resolves to its min-content size — and per css-text-3
   *     `overflow-wrap: break-word` deliberately does NOT reduce min-content. Row with
   *     `break-words` but no `min-w-0`: 557px of content in a 335px box, 222px clipped.
   *     With `min-w-0`: 335px, wrapped to two lines, nothing clipped.
   *   - `items-start` + the checkbox's `mt-0.5`: the same single decision `combobox.tsx`
   *     records, not a second one. On a 52px two-line row the base `items-center` parks
   *     the checkbox 18px down — floating in the middle of the block instead of marking
   *     the line it belongs to. `items-start` puts it at 6px, and `mt-0.5` takes it to
   *     8px, which is `select.tsx:117`'s `top-2` exactly.
   *
   * Asserted on the RENDERED row for the same reason as the popup above: `CommandItem`'s
   * base ships `items-center`, so `items-start` only wins if tailwind-merge says so.
   */
  const UNBREAKABLE = 'Messagerie/Expédition/Fret/Affranchissement';

  /** Open the popover and hand back the one option row, or fail loudly. */
  async function openAndGetRow(): Promise<HTMLElement> {
    render(
      <MultiSelectDropdown
        items={[{ value: 'a', label: UNBREAKABLE }]}
        value={[]}
        onValueChange={() => {}}
      />,
    );
    await userEvent.click(screen.getAllByRole('button')[0]);
    const label = screen.getByText(UNBREAKABLE);
    const row = label.closest('[cmdk-item]') as HTMLElement | null;
    expect(row, 'the popover did not render an option row — nothing was measured').not.toBeNull();
    return row as HTMLElement;
  }

  it('wraps a long option label rather than clipping it', async () => {
    const cls = (await openAndGetRow()).className;
    expect(cls).toContain('whitespace-normal');
    // Load-bearing alone: a slash-joined label has no soft break point.
    expect(cls).toContain('break-words');
  });

  it('gives the label a shrinkable box, or the wrap classes are decoration', async () => {
    const row = await openAndGetRow();
    const labelBox = row.querySelector('span.min-w-0');
    expect(
      labelBox,
      'the label has no min-w-0 box, so its flex min-content keeps the row wider than the popup',
    ).not.toBeNull();
    expect(labelBox).toHaveTextContent(UNBREAKABLE);
  });

  it('top-aligns the checkbox so it marks the first line of a wrapped row', async () => {
    const row = await openAndGetRow();
    // The row must top-align, beating CommandItem's base `items-center` through the merge.
    expect(row.className).toContain('items-start');
    expect(row.className).not.toMatch(/(^|\s)items-center(\s|$)/);
    // …and the checkbox nudged to select.tsx's `top-2` equivalent within the row's py-1.5.
    const checkbox = row.querySelector('[role="checkbox"]');
    expect(checkbox, 'the option row has no checkbox').not.toBeNull();
    expect((checkbox as HTMLElement).className).toContain('mt-0.5');
  });

  it('still selects the option once its label is wrapped in its own box', async () => {
    // The wrapper span means the click target is no longer the row itself. Guards the
    // obvious way the wrap fix could quietly break selection.
    const onValueChange = vi.fn();
    render(
      <MultiSelectDropdown
        items={[{ value: 'a', label: UNBREAKABLE }]}
        value={[]}
        onValueChange={onValueChange}
      />,
    );
    await userEvent.click(screen.getAllByRole('button')[0]);
    await userEvent.click(screen.getByText(UNBREAKABLE));
    expect(onValueChange).toHaveBeenCalledWith(['a']);
  });
});
