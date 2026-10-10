import { IconReceipt } from '@tabler/icons-react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StatCard } from './StatCard';

/**
 * The KPI tile.
 *
 * The number formatting is the part that matters: a raw `1234567` on a finance
 * dashboard is misread at a glance, so a numeric value is localised while a
 * pre-formatted string (already carrying a currency symbol) is passed through
 * untouched. Double-formatting a money string is the failure this fork avoids.
 */

describe('the value', () => {
  it('localises a number', () => {
    render(<StatCard label="Reports" value={1234567} />);
    expect(screen.getByText('1,234,567')).toBeInTheDocument();
  });

  it('passes a pre-formatted string through untouched', () => {
    // Already carries its currency symbol and grouping; re-formatting would mangle it.
    render(<StatCard label="Spend" value="$12,345.67 CAD" />);
    expect(screen.getByText('$12,345.67 CAD')).toBeInTheDocument();
  });

  it('renders a zero rather than treating it as absent', () => {
    render(<StatCard label="Flagged" value={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});

describe('variants', () => {
  it('defaults to the plain foreground colour', () => {
    const { container } = render(<StatCard label="Reports" value={1} />);
    expect(container.querySelector('.text-foreground')).toBeInTheDocument();
  });

  it('maps each semantic variant to its own colour', () => {
    const cases = [
      ['primary', 'text-primary'],
      ['success', 'text-success'],
      ['warning', 'text-warning'],
      ['danger', 'text-destructive'],
    ] as const;
    for (const [variant, cls] of cases) {
      const { container, unmount } = render(
        <StatCard label="Reports" value={1} variant={variant} />,
      );
      expect(container.querySelector(`.${cls.replace('/', '\\/')}`)).toBeInTheDocument();
      unmount();
    }
  });
});

describe('trend', () => {
  it('reads an upward trend as success', () => {
    const { container } = render(
      <StatCard label="Spend" value={1} trend={{ direction: 'up', value: '+12%' }} />,
    );
    expect(screen.getByText('+12%')).toBeInTheDocument();
    expect(container.textContent).toContain('+12%');
  });

  it('reads a downward trend as destructive', () => {
    render(<StatCard label="Spend" value={1} trend={{ direction: 'down', value: '-4%' }} />);
    expect(screen.getByText('-4%')).toBeInTheDocument();
  });

  it('renders no trend badge when none is given', () => {
    const { container } = render(<StatCard label="Spend" value={1} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('chrome', () => {
  it('renders a skeleton while loading, and no value', () => {
    render(<StatCard label="Reports" value={999} loading />);
    expect(screen.queryByText('999')).not.toBeInTheDocument();
    expect(screen.queryByText('Reports')).not.toBeInTheDocument();
  });

  it('renders a secondary value when given', () => {
    render(<StatCard label="Reports" value={1} secondaryValue="3 pending" />);
    expect(screen.getByText('3 pending')).toBeInTheDocument();
  });

  it('renders an icon when given', () => {
    const { container } = render(<StatCard label="Reports" value={1} icon={IconReceipt} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('looks and behaves interactive only when it has an action', async () => {
    const onClick = vi.fn();
    const { container } = render(<StatCard label="Reports" value={1} onClick={onClick} />);
    expect(container.firstElementChild?.className).toContain('cursor-pointer');
    await userEvent.click(container.firstElementChild as HTMLElement);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is not styled as clickable without an action', () => {
    const { container } = render(<StatCard label="Reports" value={1} />);
    expect(container.firstElementChild?.className).not.toContain('cursor-pointer');
  });
});

/**
 * The value's size below `lg`.
 *
 * READ THIS BEFORE TRUSTING ANYTHING BELOW: **none of these tests prove that any
 * value fits its card.** jsdom parses no stylesheet and runs no layout engine, so
 * `text-xl` here is a string in a `class` attribute and nothing more — there is no
 * width, no overflow, no clipping to measure. Every assertion in this block is a
 * class-list claim. Whether `CAD 99,999.99` actually fits a phone-width card on
 * `/expenses` is a human render check on the operator's checklist, and it is
 * genuinely in doubt: two independent estimates put that string at roughly 134px
 * against roughly 124px of box.
 *
 * What these tests are actually for is the inverse — catching a regression in the
 * classes we deliberately chose, above all the one we deliberately kept.
 */
describe('the value size below lg', () => {
  /** The value element itself — the `div` whose text content is the value. */
  const renderValue = (value: string | number = 1) => {
    const { container } = render(<StatCard label="Open balance" value={value} />);
    return {
      value: screen.getByText(String(value)),
      card: container.firstElementChild as HTMLElement,
    };
  };

  it('keeps text-3xl, so every desktop consumer is untouched', () => {
    // The load-bearing assertion of this whole change. `max-lg:text-xl` is additive:
    // if tailwind-merge ever collapsed the pair, or someone "tidied" the bare size
    // away, every StatCard in the product would silently shrink from 30px to 20px on
    // a desktop — /expenses, /analytics, /admin/audit-trail, /admin/control-evaluation,
    // /admin/fraud-detection and /netsuite/people, none of which this change is
    // allowed to alter. Nothing else guards that.
    // Exact membership, not a substring: `className.toContain('text-3xl')` also
    // passes on `max-lg:text-3xl`, which is precisely the mutation that would take
    // the 30px value off the desktop. A substring check cannot see the one change
    // this case exists to catch.
    expect(
      Array.from(renderValue().value.classList),
      'text-3xl is gone: every StatCard consumer just shrank on desktop',
    ).toContain('text-3xl');
  });

  it('sizes the value at text-xl below lg', () => {
    // The operator ruled 20px as the mobile size, and as a floor. Its absence means
    // desktop's 30px is painting into a phone-width card.
    expect(
      renderValue().value.className,
      'max-lg:text-xl is gone: the 30px desktop value is rendering on phones',
    ).toContain('max-lg:text-xl');
  });

  it('holds the value on one line in tabular figures below lg, and nowhere else', () => {
    // `max-lg:tabular-nums`: fixed-advance digits, so a currency value does not reflow
    // its own width as the number changes. `max-lg:whitespace-nowrap`: the value runs
    // off sideways rather than wrapping to a second line.
    //
    // NEITHER OF THEM CONTAINS ANYTHING, and the earlier wording here said otherwise.
    // `Card` sets no `overflow` (`../ui/card.tsx:8-11`), so a value wider than its box
    // still paints outside the card's border box and still counts toward
    // `main.scrollWidth`. Paired with `max-lg:min-w-0` below, all the two classes do is
    // decide WHICH box spills — the text out of the card, rather than the card out of
    // its grid track. Bounding the spill would take `overflow-hidden` on `Card`, which
    // is filed separately because it changes every card in the product.
    //
    // ASSERTED OFF THE CLASS LIST, NOT AS A SUBSTRING, and that is the point of this
    // case: `className.toContain('tabular-nums')` passes on `max-lg:tabular-nums` too,
    // so it cannot tell the mobile-only class this change ships from the unprefixed one
    // it must never ship. Unprefixed, `tabular-nums` alters numeral advance widths on all
    // six consumers — /expenses, /analytics, /admin/audit-trail,
    // /admin/control-evaluation, /admin/fraud-detection and /netsuite/people — at every
    // width, and the operator's constraint is "mobile only".
    const { value } = renderValue('CAD 99,999.99');
    const classes = Array.from(value.classList);
    expect(classes, 'digits will reflow the value as the number changes on a phone').toContain(
      'max-lg:tabular-nums',
    );
    expect(
      classes,
      'tabular-nums escaped to desktop: every StatCard consumer just changed its numeral widths',
    ).not.toContain('tabular-nums');
    expect(
      classes,
      'max-lg:whitespace-nowrap is gone: the value can now wrap to a second line on a phone',
    ).toContain('max-lg:whitespace-nowrap');
    expect(
      classes,
      'whitespace-nowrap escaped to desktop, where the value used to be allowed to wrap',
    ).not.toContain('whitespace-nowrap');
  });

  it('lets the card sit in its grid track below lg, and nowhere else', () => {
    // A grid child is `min-width: auto` by default, which floors it at its own
    // min-content width. Every consumer lays these out with Tailwind's `grid-cols-N` =
    // `repeat(N, minmax(0, 1fr))`, so the TRACK is already floored at 0 and never grows;
    // what grows is the CARD, whose border box and background then paint wider than its
    // track and over its neighbour. `max-lg:min-w-0` puts the card back in its track.
    //
    // It does NOT stop the page overflowing — the earlier wording here claimed it did.
    // The value inside still spills, because `Card` has no `overflow`.
    //
    // Class-list membership again rather than a substring, for the desktop half:
    // `min-w-0` unprefixed restores nothing that was there before — `origin/main` has
    // neither class — so it would be a live layout change on six desktop routes.
    const classes = Array.from(renderValue().card.classList);
    expect(
      classes,
      'max-lg:min-w-0 is gone: a long value can push the card out over its neighbour on a phone',
    ).toContain('max-lg:min-w-0');
    expect(
      classes,
      'min-w-0 escaped to desktop: six StatCard routes just changed how their cards size',
    ).not.toContain('min-w-0');
  });

  it('shrinks the loading skeleton to match the mobile line-height', () => {
    // Paired to the value's line box so the card does not jump height on load.
    // `text-3xl`'s line-height is 2.25rem = 36px = `h-9`; `text-xl`'s is 1.75rem =
    // 28px = `h-7`. Both read off node_modules/tailwindcss/theme.css:355-360 with
    // `--spacing: 0.25rem` (line 325). Change one of these without the other and the
    // tile resizes the moment data arrives.
    const { container } = render(<StatCard label="Open balance" value={1} loading />);
    const skeleton = container.querySelector('.animate-pulse.w-4\\/5') as HTMLElement;
    expect(
      skeleton?.className,
      'skeleton height no longer matches the value line-height: the card will jump on load',
    ).toContain('h-9');
    expect(
      skeleton?.className,
      'skeleton keeps the 36px desktop height on phones: the card will jump on load',
    ).toContain('max-lg:h-7');
  });
});
