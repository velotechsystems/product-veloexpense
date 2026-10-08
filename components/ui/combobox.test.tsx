import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AsyncCombobox, Combobox } from '@/components/ui/combobox';

/**
 * A selected value must display even when its option list has not arrived yet.
 *
 * The reported symptom was a transaction's coding fields rendering BLANK, then showing
 * the right value after clicking in and out. `selected` was derived only from `items`:
 *
 *   const selected = items.find((i) => i.value === value) ?? null;
 *
 * Every small lookup on that panel comes from one tRPC query, so the first render has
 * `value` set and `items` empty — `selected` is null, the field shows '', and Base UI
 * seeds its internal input text from that. It re-syncs on focus/blur, which is why
 * clicking in and out "fixed" it.
 *
 * Oct 2026: the combobox moved from Base UI to Radix Popover + cmdk (the kit standard).
 * The field is now a button showing the selected label, not a text input, so these read
 * its text rather than an input value; the cases are unchanged.
 *
 * The fix is a `selectedItem` fallback, the same escape hatch AsyncCombobox already has
 * for exactly this reason.
 */

const ITEMS = [
  { value: 'dept-1', label: 'Finance' },
  { value: 'dept-2', label: 'Operations' },
];

/** What the field shows — the selected label, or the placeholder. */
const shown = () => screen.getByRole('combobox').textContent ?? '';

describe('Combobox', () => {
  it('shows the selected label when the item is in items', () => {
    render(<Combobox items={ITEMS} value="dept-2" onValueChange={() => {}} />);
    expect(shown()).toBe('Operations');
  });

  it('shows the selected label from selectedItem when items are still empty', () => {
    // The reported bug: the list has not loaded, but the value is known.
    render(
      <Combobox
        items={[]}
        value="dept-2"
        selectedItem={{ value: 'dept-2', label: 'Operations' }}
        onValueChange={() => {}}
      />,
    );
    expect(shown()).toBe('Operations');
  });

  it('prefers the real item over the fallback once the list arrives', () => {
    // The fallback is a stand-in, not an override — if the loaded option's label
    // differs (renamed, re-localized), the loaded one wins.
    render(
      <Combobox
        items={[{ value: 'dept-2', label: 'Operations (renamed)' }]}
        value="dept-2"
        selectedItem={{ value: 'dept-2', label: 'Operations' }}
        onValueChange={() => {}}
      />,
    );
    expect(shown()).toBe('Operations (renamed)');
  });

  it('ignores a stale fallback that no longer matches the value', () => {
    // Guards the obvious way this could lie: a leftover selectedItem from a previous
    // row must never label a different value.
    render(
      <Combobox
        items={[]}
        value="dept-1"
        selectedItem={{ value: 'dept-2', label: 'Operations' }}
        onValueChange={() => {}}
      />,
    );
    expect(shown()).toBe('');
  });

  it('recovers when the option list arrives after the first render', () => {
    // The actual runtime shape: one query feeds every lookup, so the panel mounts with
    // items=[] and fills in a moment later. If Base UI only re-seeds its input text on
    // focus/blur, this is the case that leaves a field looking empty.
    const { rerender } = render(<Combobox items={[]} value="dept-2" onValueChange={() => {}} />);
    expect(shown()).toBe('');
    rerender(<Combobox items={ITEMS} value="dept-2" onValueChange={() => {}} />);
    expect(shown()).toBe('Operations');
  });

  it('shows nothing for no value', () => {
    render(<Combobox items={ITEMS} value={null} onValueChange={() => {}} />);
    expect(shown()).toBe('');
  });

  it('takes an accessible name', () => {
    // Most call sites label the field with a plain <span> beside it, which names
    // nothing: the control is announced as an unnamed "combobox", so a screen
    // reader user is told a chooser exists but not what it chooses.
    render(
      <Combobox items={ITEMS} value={null} onValueChange={() => {}} aria-label="Department" />,
    );
    expect(screen.getByRole('combobox', { name: 'Department' })).toBeInTheDocument();
  });
});

/**
 * AsyncCombobox resolves a selected value's LABEL separately from its options: the
 * caller either hands one over (`initialItem`) or the picker fetches it by id. Either
 * way it can arrive after the first render — the entity pickers' `byId` query is
 * `enabled: !!value && !initialItem`, so a transaction whose payload omits the resolved
 * relation mounts with `selectedItem = null`.
 *
 * `items` stays empty the whole time here, which is the real shape: results only exist
 * once someone types past the min-chars threshold. So unlike the plain Combobox, there
 * is no second source for the label to recover from.
 */
describe('AsyncCombobox', () => {

  it('shows the label when selectedItem is known up front', () => {
    render(
      <AsyncCombobox
        items={[]}
        value="gl-1"
        selectedItem={{ value: 'gl-1', label: '620103 · Mileage' }}
        onValueChange={() => {}}
        onSearchChange={() => {}}
      />,
    );
    expect(shown()).toBe('620103 · Mileage');
  });

  it('takes an accessible name, like the plain variant', () => {
    render(
      <AsyncCombobox
        items={[]}
        value={null}
        onValueChange={() => {}}
        onSearchChange={() => {}}
        aria-label="GL account"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'GL account' })).toBeInTheDocument();
  });

  it('shows the label when selectedItem arrives LATE', () => {
    // The reported bug: blank on open, right after clicking in and out.
    const { rerender } = render(
      <AsyncCombobox
        items={[]}
        value="gl-1"
        selectedItem={null}
        onValueChange={() => {}}
        onSearchChange={() => {}}
      />,
    );
    expect(shown()).toBe('');
    rerender(
      <AsyncCombobox
        items={[]}
        value="gl-1"
        selectedItem={{ value: 'gl-1', label: '620103 · Mileage' }}
        onValueChange={() => {}}
        onSearchChange={() => {}}
      />,
    );
    expect(shown()).toBe('620103 · Mileage');
  });
});

/**
 * The popup must be allowed to grow to its widest option, and its options must be allowed
 * to wrap — the same "fields cut off in the dropdown because of screen size" fix
 * `select.test.tsx` guards for the other dropdown family, carried to both combobox twins.
 *
 * Pinned to the trigger (`w-[var(--anchor-width)] min-w-[8rem]`) with items that could not
 * wrap, an option label had to fit the trigger's width minus 48px of chrome. The expense
 * categories cannot: they are slash-joined (`Courier/Shipping/Freight/Postage`,
 * `Messagerie/Expédition/Fret/Affranchissement`) and CSS does not break after a slash, so
 * `whitespace-normal` alone does nothing — `break-words` is what breaks the run once the
 * popup meets its cap. Measured overflow was +22.5px (en) and +101.8px (fr-CA) at 1280x800.
 *
 * Classes, not geometry, because jsdom has no layout engine — the same division of labour
 * `select.test.tsx` states. `e2e/combobox-popup-width.spec.ts` measures the real boxes in a
 * browser, in both locales, at 1280x800 and 375x667. These pins exist because that spec is
 * NOT a PR gate (`e2e-nightly.yml` is schedule / workflow_dispatch only), so they are the
 * part of the fix a pull request actually blocks on.
 */

/** The one label this is about. Unbreakable by design — no space, no hyphen. */
const UNBREAKABLE = 'Courier/Shipping/Freight/Postage';

/**
 * Open the popup and hand back the popup, list and option class strings.
 *
 * The popup is the Radix popover content that holds the listbox, found by its
 * `data-slot` (the kit's popover sets it) from the listbox upwards — so an assertion
 * cannot pass against some other element. `aria-expanded` is checked first, or every
 * assertion below would be silently vacuous.
 */
async function openAndRead(): Promise<{ popup: string; list: string; item: string }> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox'));
  expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
  const listbox = screen.getByRole('listbox');
  const popup = listbox.closest('[data-slot="popover-content"]');
  expect(popup, 'the popup did not open — nothing was measured').not.toBeNull();
  return {
    popup: (popup as HTMLElement).className,
    // cmdk's list is the scroll container, so the height cap lives on it.
    list: (listbox.closest('[cmdk-list]') as HTMLElement).className,
    item: screen.getByRole('option', { name: UNBREAKABLE }).className,
  };
}

/** Asserted identically for both twins: the AsyncCombobox popup is the easy one to miss. */
function assertPopupCanGrow({ popup, list }: { popup: string; list: string }): void {
  // The bug: pinned to the trigger, so a long option had nowhere to go.
  expect(popup).not.toMatch(/(^|\s)w-\[var\(--radix-popover-trigger-width\)\]/);
  expect(popup).not.toMatch(/(^|\s)w-72(\s|$)/); // the kit popover's default width
  expect(popup).toContain('w-auto');
  expect(popup).toContain('min-w-[max(8rem,var(--radix-popover-trigger-width))]');
  // …but never past the screen, or the overlay walks off a 375px viewport where
  // nothing can scroll it back.
  expect(popup).toContain('max-w-[min(92vw,32rem)]');
  // Deliberately NOT select.tsx's max-h-96 — the combobox panel keeps its shorter height.
  expect(list).toContain('max-h-72');
}

function assertItemWraps(cls: string): void {
  expect(cls).toContain('whitespace-normal');
  // Load-bearing on its own: a slash-joined label has no soft break point, so
  // `whitespace-normal` without this still overflows the item's content box.
  expect(cls).toContain('break-words');
  // A wrapped option is multi-line, so the check pins to the top of a tall row
  // instead of floating in its vertical middle.
  expect(cls).toContain('items-start');
  expect(cls).not.toMatch(/(^|\s)items-center(\s|$)/);
}

describe('<Combobox> popup overflow behaviour', () => {
  const renderCombobox = (value: string | null = null) =>
    render(
      <Combobox
        items={[{ value: 'a', label: UNBREAKABLE }]}
        value={value}
        onValueChange={() => {}}
        aria-label="Category"
      />,
    );

  it('sizes the popup to at least the trigger, free to grow, capped to the viewport', async () => {
    renderCombobox();
    assertPopupCanGrow(await openAndRead());
  });

  it('wraps long option text rather than clipping it', async () => {
    renderCombobox();
    assertItemWraps((await openAndRead()).item);
  });

  it('pins the check indicator to the top of a wrapped row', async () => {
    renderCombobox('a');
    await openAndRead();
    const indicator = screen
      .getByRole('option', { name: UNBREAKABLE })
      .querySelector('span.absolute');
    expect(indicator, 'the option has no absolutely-positioned indicator slot').not.toBeNull();
    expect((indicator as HTMLElement).className).toContain('top-2');
  });

  it('still renders the option text', async () => {
    renderCombobox();
    await openAndRead();
    expect(screen.getByRole('option', { name: UNBREAKABLE })).toBeInTheDocument();
  });
});

describe('<AsyncCombobox> popup overflow behaviour', () => {
  // The twin. Its popup and item classes are a second copy of the same strings, which is
  // exactly why a fix applied once looks complete and is not.
  const renderAsync = () =>
    render(
      <AsyncCombobox
        items={[{ value: 'a', label: UNBREAKABLE }]}
        value={null}
        onValueChange={() => {}}
        onSearchChange={() => {}}
        aria-label="GL account"
      />,
    );

  it('sizes the popup to at least the trigger, free to grow, capped to the viewport', async () => {
    renderAsync();
    assertPopupCanGrow(await openAndRead());
  });

  it('wraps long option text rather than clipping it', async () => {
    renderAsync();
    assertItemWraps((await openAndRead()).item);
  });
});

/**
 * Behaviour of the Radix + cmdk implementation (Oct 2026) — what a user does with it.
 * jsdom stands in for the browser here; the dialog / drawer cases (wheel scrolling,
 * focus) were checked in a real browser, since jsdom has no scroll lock or layout.
 */
describe('Combobox behaviour', () => {
  const MANY = [
    { value: 'a', label: 'Courier/Shipping/Freight/Postage' },
    { value: 'b', label: 'Meals and entertainment' },
    { value: 'c', label: 'Office supplies' },
    // Same label, different value: must stay two separate rows.
    { value: 'd', label: 'Travel' },
    { value: 'e', label: 'Travel' },
  ];

  it('filters on every typed word and picks with the keyboard', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Combobox items={MANY} value={null} onValueChange={onValueChange} aria-label="Category" />);
    await user.click(screen.getByRole('combobox'));
    // Focus lands in the search box, so typing filters straight away.
    await user.keyboard('ent meals');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Meals and entertainment']);
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps same-labelled items apart, keyed by value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Combobox items={MANY} value={null} onValueChange={onValueChange} />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('travel');
    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(2);
    await user.click(rows[1]);
    expect(onValueChange).toHaveBeenCalledWith('e');
  });

  it('shows the empty text when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Combobox items={MANY} value={null} onValueChange={() => {}} emptyText="Nothing here" />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('zzz');
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('marks the selected row', async () => {
    const user = userEvent.setup();
    render(<Combobox items={MANY} value="c" onValueChange={() => {}} />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Office supplies' })).toHaveAttribute('data-checked', 'true');
    expect(screen.getByRole('option', { name: 'Meals and entertainment' })).toHaveAttribute('data-checked', 'false');
  });

  it('closes on Escape without changing the value, and clears the search', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Combobox items={MANY} value="c" onValueChange={onValueChange} />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('meal{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(shown()).toBe('Office supplies');
    await user.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option')).toHaveLength(MANY.length);
  });

  it('cannot be opened when disabled', async () => {
    const user = userEvent.setup();
    render(<Combobox items={MANY} value={null} onValueChange={() => {}} disabled />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the icon with the label in the field and the row', async () => {
    const user = userEvent.setup();
    render(
      <Combobox items={[{ value: 'f', label: 'Fuel', icon: '⛽' }]} value="f" onValueChange={() => {}} />,
    );
    expect(shown()).toBe('⛽ Fuel');
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option')).toHaveTextContent('⛽Fuel');
  });
});

describe('AsyncCombobox behaviour', () => {
  it('asks the parent to search only past minChars, debounced and trimmed', async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    render(
      <AsyncCombobox
        items={[]}
        value={null}
        onValueChange={() => {}}
        onSearchChange={onSearchChange}
        minChars={3}
        debounceMs={20}
      />,
    );
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('status')).toHaveTextContent('Type 3 or more characters to search');
    await user.keyboard('62');
    expect(onSearchChange).not.toHaveBeenCalledWith('62');
    await user.keyboard('0 ');
    await act(() => new Promise((r) => setTimeout(r, 60)));
    expect(onSearchChange).toHaveBeenLastCalledWith('620');
  });

  it('shows loading, then results, and Enter picks the first result', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const props = {
      value: null,
      onValueChange,
      onSearchChange: () => {},
      minChars: 1,
      debounceMs: 0,
    };
    const { rerender } = render(<AsyncCombobox {...props} items={[]} loading />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('62');
    expect(screen.getByRole('status')).toHaveTextContent('Searching…');
    // Results replace the list; Enter takes the first of the new results.
    rerender(
      <AsyncCombobox
        {...props}
        items={[
          { value: 'gl-2', label: '620200 · Parking' },
          { value: 'gl-1', label: '620103 · Mileage' },
        ]}
      />,
    );
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('gl-2', { value: 'gl-2', label: '620200 · Parking' });
  });

  it('says so when a search finds nothing', async () => {
    const user = userEvent.setup();
    render(
      <AsyncCombobox items={[]} value={null} onValueChange={() => {}} onSearchChange={() => {}} minChars={1} emptyText="No accounts" />,
    );
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('x');
    expect(screen.getByRole('status')).toHaveTextContent('No accounts');
  });

  it('lists the current selection before anything is typed', async () => {
    const user = userEvent.setup();
    render(
      <AsyncCombobox
        items={[]}
        value="gl-1"
        selectedItem={{ value: 'gl-1', label: '620103 · Mileage' }}
        onValueChange={() => {}}
        onSearchChange={() => {}}
      />,
    );
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: '620103 · Mileage' })).toHaveAttribute('data-checked', 'true');
  });

  it('autoFocus opens it; onClose fires on Escape but not on selection (inline editors)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onValueChange = vi.fn();
    const items = [{ value: 'gl-1', label: '620103 · Mileage' }];
    const { unmount } = render(
      <AsyncCombobox items={items} value={null} onValueChange={onValueChange} onSearchChange={() => {}} autoFocus onClose={onClose} minChars={0} />,
    );
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '620103 · Mileage' }));
    expect(onValueChange).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    unmount();

    render(
      <AsyncCombobox items={items} value={null} onValueChange={() => {}} onSearchChange={() => {}} autoFocus onClose={onClose} />,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AsyncCombobox keeps the picked label', () => {
  it('after the parent clears its results (no selectedItem passed)', async () => {
    // Closing clears the query; the parent resets `items` to []. The field must still
    // name what was picked.
    const user = userEvent.setup();
    let value: string | null = null;
    const results = [{ value: 'gl-1', label: '620103 · Mileage' }];
    const props = { onSearchChange: () => {}, minChars: 0 };
    const { rerender } = render(
      <AsyncCombobox {...props} items={results} value={value} onValueChange={(v) => (value = v)} />,
    );
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: '620103 · Mileage' }));
    rerender(<AsyncCombobox {...props} items={[]} value={value} onValueChange={() => {}} />);
    expect(shown()).toBe('620103 · Mileage');
    // …and a later, different value is not mislabelled by the remembered pick.
    rerender(<AsyncCombobox {...props} items={[]} value="gl-9" onValueChange={() => {}} />);
    expect(shown()).toBe('');
  });
});

/** Optional props added for VeloCRM's and VeloLedger's pickers (Oct 2026). */
describe('description, keywords, clearable, searchPlaceholder, hasMore', () => {
  const PEOPLE = [
    { value: 'c1', label: 'Jane Smith', description: 'jane@acme.com', keywords: ['Acme Corp'] },
    { value: 'c2', label: 'Jane Smith', description: 'jane2@globex.com', keywords: ['Globex'] },
  ];

  it('shows the description in the row but not in the field, and searches it and the keywords', async () => {
    const user = userEvent.setup();
    render(<Combobox items={PEOPLE} value="c2" onValueChange={() => {}} searchPlaceholder="Search name, email or company…" />);
    expect(shown()).toBe('Jane Smith');
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByPlaceholderText('Search name, email or company…')).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Jane Smith · jane@acme.com',
      'Jane Smith · jane2@globex.com',
    ]);
    await user.keyboard('globex');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.clear(screen.getByPlaceholderText('Search name, email or company…'));
    await user.keyboard('jane acme');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Jane Smith · jane@acme.com']);
  });

  it('clearable: a first row clears the value, hidden while searching', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Combobox items={PEOPLE} value="c1" onValueChange={onValueChange} placeholder="Select a contact" clearable />);
    await user.click(screen.getByRole('combobox'));
    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveTextContent('Select a contact');
    expect(rows[0]).toHaveAttribute('data-checked', 'false');
    await user.keyboard('jane');
    expect(screen.queryByRole('option', { name: 'Select a contact' })).toBeNull();
    await user.clear(screen.getByPlaceholderText('Search…'));
    await user.click(screen.getByRole('option', { name: 'Select a contact' }));
    expect(onValueChange).toHaveBeenCalledWith(null);
  });

  it('not clearable by default', async () => {
    const user = userEvent.setup();
    render(<Combobox items={PEOPLE} value="c1" onValueChange={() => {}} placeholder="Select a contact" />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('AsyncCombobox: clear row, hasMore hint, description rows', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <AsyncCombobox
        items={PEOPLE}
        value="c1"
        onValueChange={onValueChange}
        onSearchChange={() => {}}
        minChars={0}
        placeholder="Select a contact"
        clearable
        hasMore
      />,
    );
    await user.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Select a contact',
      'Jane Smith · jane@acme.com',
      'Jane Smith · jane2@globex.com',
    ]);
    expect(screen.getByText('More matches — keep typing to narrow the list.')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Select a contact' }));
    expect(onValueChange).toHaveBeenCalledWith(null, null);
  });
});
