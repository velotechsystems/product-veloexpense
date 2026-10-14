import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IdentityBanner, IdentityBannerChip } from './IdentityBanner'; // VeloExpense: vendored from the kit as `data-display/IdentityBanner` (ExpenseOS: `ui/identity-banner`).

/** The chrome the callers pass for the action, kept in one place here so the test is the
 *  copy source for the call sites. `border-white/40`, never `/20`: 3.66:1 against
 *  `--color-brand-navy` rather than 1.88:1, per SC 1.4.11.
 *
 *  There is deliberately no `CHIP_CLASS` beside it any more: the chip's chrome moved into
 *  `IdentityBannerChip`, precisely so that neither this file nor the two call sites keeps
 *  its own copy of the string. */
const ACTION_CLASS =
  'rounded-md border border-white/40 px-3 py-1.5 font-semibold text-white text-xs transition hover:bg-white/10';

/**
 * The navy identity band shared by `/dashboard` and `/profile`.
 *
 * What is asserted here is, almost entirely, the set of reasons the component exists as
 * one component instead of two copies: a slot the caller omits must draw nothing at all,
 * the heading level must be the caller's choice, the role must appear once, the band must
 * not close a box the caller has to put a grid inside, and the text column must be allowed
 * to shrink.
 */
describe('<IdentityBanner>', () => {
  it('draws the name, the avatar, the chips, the status badge and the action', () => {
    const { container } = render(
      <IdentityBanner
        name="Ada Lovelace"
        initials="AL"
        nameAs="h1"
        statusBadge={<span>Active</span>}
        action={
          <a className={ACTION_CLASS} href="/profile">
            My Profile
          </a>
        }
      >
        <IdentityBannerChip>Accountant</IdentityBannerChip>
        <IdentityBannerChip>Finance</IdentityBannerChip>
      </IdentityBanner>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeInTheDocument();
    // No `imageUrl`, so the avatar paints its initials face — visible, and deliberately
    // not in the accessibility tree. See the FIX 3 case below.
    expect(container).toHaveTextContent('AL');
    expect(screen.getByText('Accountant')).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My Profile' })).toBeInTheDocument();
  });

  /**
   * THE BAND IS NOT A BOX — the correction that keeps `/profile` to ONE card.
   *
   * `/my-info` rendered one card holding the navy band AND the seven-field record beneath
   * it (that page is now deleted and `/profile` inherited the composition), and the
   * operator asked for that box on `/profile`: "the full box carrying the
   * user … and the rest", singular. If this component closed its own `Card`, the grid
   * composed beneath it would land in a SECOND card and `/profile` would show two stacked
   * boxes — the lower one a heading-less card under a labelled one, when the ruling is
   * that the reader's name is the box's heading. So the band carries no border, no radius
   * and no shadow, and the caller's `<Card className="overflow-hidden p-0">` supplies all
   * three. This is the assertion that fails if someone puts the card back.
   */
  it('draws no box of its own, so the caller owns the card', () => {
    const { container } = render(<IdentityBanner name="Ada Lovelace" initials="AL" />);
    const root = container.firstElementChild;
    expect(root).toHaveClass('bg-[color:var(--color-brand-navy)]', 'px-7');
    expect(root).not.toHaveClass('rounded-lg');
    expect(root).not.toHaveClass('border');
    expect(root).not.toHaveClass('shadow-sm');
    expect(root).not.toHaveClass('overflow-hidden');
  });

  /**
   * FIX 3 — THE FACE IS DECORATIVE, on BOTH avatar paths.
   *
   * The origin passed `alt={fullName}`, which announces the reader's name twice: from the
   * avatar and again from the heading beside it. `alt=""` fixes only the photo path — on
   * the initials path `Avatar` renders `role="img" aria-label={alt}`, and an empty label
   * there is an image role with no accessible name (SC 4.1.2), which is a worse defect
   * than the noise it replaces. The `aria-hidden` wrapper covers both paths, which is what
   * these two assertions are for: no image role either way, and the initials still paint.
   */
  it('keeps the face out of the accessibility tree on both avatar paths', () => {
    const initialsOnly = render(<IdentityBanner name="Ada Lovelace" initials="AL" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(initialsOnly.container).toHaveTextContent('AL');
    initialsOnly.unmount();

    const withPhoto = render(
      <IdentityBanner name="Ada Lovelace" initials="AL" avatarUrl="https://example.test/a.png" />,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // The photo is still rendered — hidden from the tree, not dropped from the page.
    expect(withPhoto.container.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.test/a.png',
    );
  });

  /**
   * THE POINT OF THREE OPTIONAL NODES RATHER THAN THREE BOOLEANS.
   *
   * The dashboard shows no employee-status badge, and `/profile` shows no "My Profile"
   * link into the page the reader is already on. Both omissions are decisions. A slot the
   * caller never constructs cannot be flipped on by accident — but only if an omitted slot
   * renders literally nothing, which is what this asserts.
   */
  it('renders nothing for a slot the caller omits', () => {
    render(
      <IdentityBanner name="Ada Lovelace" initials="AL">
        <IdentityBannerChip>Accountant</IdentityBannerChip>
      </IdentityBanner>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  /**
   * THE DOUBLED ROLE, WHICH IS NOT COMING BACK.
   *
   * The origin file printed the role label twice — once as a `text-white/70` sub-line
   * under the name and again as a chip directly beneath it. The extraction kept the chip
   * and dropped the sub-line, and the way it stays dropped is that there is no `subtitle`
   * prop to put it back through. If one is ever added, this assertion fails.
   */
  it('prints a chip label exactly once', () => {
    render(
      <IdentityBanner name="Ada Lovelace" initials="AL">
        <IdentityBannerChip>Accountant</IdentityBannerChip>
      </IdentityBanner>,
    );
    expect(screen.getAllByText('Accountant')).toHaveLength(1);
  });

  it('draws no chip row at all when there are no chips', () => {
    /** Not an empty row: an empty `flex` row still carries the name's `mt-2` under it,
     *  which reads as a rendering that did not finish. */
    render(<IdentityBanner name="Ada Lovelace" initials="AL" />);
    const heading = screen.getByRole('heading', { name: 'Ada Lovelace' });
    expect(heading.parentElement?.childElementCount).toBe(1);
  });

  it('draws the chip row for a status badge with no other chips', () => {
    /** `/profile` may end up passing the badge and nothing else; the row must appear for
     *  either source of chips, not only for `children`. */
    render(<IdentityBanner name="Ada Lovelace" initials="AL" statusBadge={<span>Active</span>} />);
    const heading = screen.getByRole('heading', { name: 'Ada Lovelace' });
    expect(heading.parentElement?.childElementCount).toBe(2);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('names at h2 by default and at h1 when the page asks for it', () => {
    /** `/dashboard` passes `h1`: inside `<main>` the reader's name is the top-level
     *  heading. `/profile` takes the default `h2`, because there the band is one section
     *  of a page that has a title already. The banner must not force one outline on both. */
    const { rerender } = render(<IdentityBanner name="Ada Lovelace" initials="AL" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Ada Lovelace' })).toBeInTheDocument();
    rerender(<IdentityBanner name="Ada Lovelace" initials="AL" nameAs="h1" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeInTheDocument();
  });

  /**
   * REFLOW — SC 1.4.10 (AA).
   *
   * jsdom does no layout, so this cannot assert an absent scrollbar; it asserts the three
   * classes that are the whole mechanism, on the element that has to shrink. At 320px the
   * padding, the 72px avatar, the gap and a `shrink-0` action leave the text column
   * roughly 82px, and `min-w-0` is the only reason a flex child will go below its content
   * width. The chips are customer-authored labels of unbounded length, so the column has
   * to give way rather than push the page sideways — and `break-words` is what makes a
   * long unbroken name wrap instead of overflow.
   *
   * If someone deletes `min-w-0` because it looks redundant next to `flex-1`, this is the
   * test that says why it is not.
   */
  it('lets the text column shrink and wrap, and keeps the action from shrinking', () => {
    render(
      <IdentityBanner
        name="Ada Lovelace"
        initials="AL"
        action={
          <a className={ACTION_CLASS} href="/profile">
            My Profile
          </a>
        }
      >
        <IdentityBannerChip>Accountant</IdentityBannerChip>
      </IdentityBanner>,
    );
    const column = screen.getByRole('heading', { name: 'Ada Lovelace' }).parentElement;
    expect(column).toHaveClass('min-w-0', 'flex-1', 'break-words');
    const action = screen.getByRole('link', { name: 'My Profile' }).parentElement;
    expect(action).toHaveClass('shrink-0', 'self-start');
  });
});

/**
 * The chip exists so that the class string exists ONCE. The arbitration that created the
 * banner named this string as the reason to extract at all — "two byte-identical copies of
 * the chip class string, which is precisely the kind of thing that drifts" — and chips
 * arrive as `children`, so without a primitive both call sites would have re-typed it.
 * This is the assertion that catches a call site that goes back to hand-writing the pill.
 */
describe('<IdentityBannerChip>', () => {
  it('carries the whole chip chrome, so no call site writes bg-white/15 itself', () => {
    render(<IdentityBannerChip>Accountant</IdentityBannerChip>);
    expect(screen.getByText('Accountant')).toHaveClass(
      'rounded-full',
      'bg-white/15',
      'px-3',
      'py-0.5',
      'font-semibold',
      'text-white',
      'text-xs',
    );
  });

  it('does not pin itself to one line', () => {
    /** SC 1.4.10 again, one level down: these labels are unbounded customer-authored
     *  strings, and a `whitespace-nowrap` pill inside the wrapping row would hand the
     *  horizontal scrollbar straight back. `break-words` is inherited from the column. */
    render(<IdentityBannerChip>Accountant</IdentityBannerChip>);
    expect(screen.getByText('Accountant')).not.toHaveClass('whitespace-nowrap');
  });
});
