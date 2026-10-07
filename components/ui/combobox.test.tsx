import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
 * The fix is a `selectedItem` fallback, the same escape hatch AsyncCombobox already has
 * for exactly this reason.
 */

const ITEMS = [
  { value: 'dept-1', label: 'Finance' },
  { value: 'dept-2', label: 'Operations' },
];

const input = () => screen.getByRole('combobox') as HTMLInputElement;

describe('Combobox', () => {
  it('shows the selected label when the item is in items', () => {
    render(<Combobox items={ITEMS} value="dept-2" onValueChange={() => {}} />);
    expect(input().value).toBe('Operations');
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
    expect(input().value).toBe('Operations');
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
    expect(input().value).toBe('Operations (renamed)');
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
    expect(input().value).toBe('');
  });

  it('recovers when the option list arrives after the first render', () => {
    // The actual runtime shape: one query feeds every lookup, so the panel mounts with
    // items=[] and fills in a moment later. If Base UI only re-seeds its input text on
    // focus/blur, this is the case that leaves a field looking empty.
    const { rerender } = render(<Combobox items={[]} value="dept-2" onValueChange={() => {}} />);
    expect(input().value).toBe('');
    rerender(<Combobox items={ITEMS} value="dept-2" onValueChange={() => {}} />);
    expect(input().value).toBe('Operations');
  });

  it('shows nothing for no value', () => {
    render(<Combobox items={ITEMS} value={null} onValueChange={() => {}} />);
    expect(input().value).toBe('');
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
  const asyncInput = () => screen.getByRole('combobox') as HTMLInputElement;

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
    expect(asyncInput().value).toBe('620103 · Mileage');
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
    expect(asyncInput().value).toBe('');
    rerender(
      <AsyncCombobox
        items={[]}
        value="gl-1"
        selectedItem={{ value: 'gl-1', label: '620103 · Mileage' }}
        onValueChange={() => {}}
        onSearchChange={() => {}}
      />,
    );
    expect(asyncInput().value).toBe('620103 · Mileage');
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
 * Open the popup and hand back the popup + option class strings.
 *
 * ArrowDown on the input, not a click on the chevron: Base UI's trigger is `tabindex="-1"`
 * and a synthetic click on it leaves `aria-expanded="false"` in jsdom, which would make
 * every assertion below silently vacuous. The popup is found as the listbox's parent —
 * structure, not class name, so a renamed utility cannot disguise itself as a pass.
 */
async function openAndRead(): Promise<{ popup: string; item: string }> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox'));
  await user.keyboard('{ArrowDown}');
  const listbox = screen.getByRole('listbox');
  const popup = listbox.parentElement;
  expect(popup, 'the popup did not open — nothing was measured').not.toBeNull();
  return {
    popup: (popup as HTMLElement).className,
    item: screen.getByRole('option', { name: UNBREAKABLE }).className,
  };
}

/** Asserted identically for both twins: the AsyncCombobox popup is the easy one to miss. */
function assertPopupCanGrow(cls: string): void {
  // The bug: pinned to the trigger, so a long option had nowhere to go.
  expect(cls).not.toMatch(/(^|\s)w-\[var\(--anchor-width\)\]/);
  expect(cls).toContain('w-auto');
  expect(cls).toContain('min-w-[max(8rem,var(--anchor-width))]');
  // …but never past the screen, or a fixed-position overlay walks off a 375px viewport
  // where nothing can scroll it back.
  expect(cls).toContain('max-w-[min(92vw,32rem)]');
  // Deliberately NOT select.tsx's max-h-96 — the combobox panel keeps its shorter height.
  expect(cls).toContain('max-h-72');
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
    assertPopupCanGrow((await openAndRead()).popup);
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
    assertPopupCanGrow((await openAndRead()).popup);
  });

  it('wraps long option text rather than clipping it', async () => {
    renderAsync();
    assertItemWraps((await openAndRead()).item);
  });
});
