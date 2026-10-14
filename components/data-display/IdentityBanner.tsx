import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Avatar } from './Avatar';

/**
 * `IdentityBanner` — the navy band that says who the reader is: face, name, chips, and
 * an optional action on the right.
 *
 * IT WAS EXTRACTED, NOT DESIGNED. It is `/my-info`'s hero header (the navy `div`, the
 * 72px avatar, the name, the chip row, the outlined link) moved here so the dashboard's
 * landing band and `/profile`'s employment record are one component rather than two
 * copies of ~26 lines. Three things were fixed in the move rather than carried forward;
 * all three are called out below, because they change how the header looks and reads.
 *
 * `/my-info` NO LONGER EXISTS — it was deleted once its record moved to `/profile`, so
 * every mention of it below is an account of where this markup came from, not a live
 * caller. The two live callers are `/dashboard` and `/profile`, and it is those two that
 * keep this component honest: two consumers drawing one chrome is the argument that put
 * it here, and unlike `SectionCard` (see its docstring) that argument still holds.
 *
 * IT DOES NOT OWN A CARD, AND THE CALLER MUST WRAP IT IN ONE. This band is a full-bleed
 * navy region, not a box: it has no border, no radius and no shadow of its own, so it is
 * unfinished until a card clips it. Every caller wraps it thus, verbatim —
 *
 *   <Card className="overflow-hidden p-0">
 *     <IdentityBanner ...>{chips}</IdentityBanner>
 *     <EmploymentFields ... />   ← `/profile` only, INSIDE THIS SAME CARD
 *   </Card>
 *
 * — and `overflow-hidden` is the load-bearing half: it is what clips the navy against the
 * card's `rounded-lg`, and without it the band paints square corners over a rounded box.
 *
 * WHY THE CARD IS THE CALLER'S AND NOT THIS COMPONENT'S. `/my-info` rendered ONE card
 * containing the navy band and the seven-field record beneath it, and the operator's
 * request for `/profile` was that box — "**the full box** carrying the user, whether they
 * are active, email, legal entity and the rest" — singular. A banner that closed its own
 * card would put the grid in a second card, and `/profile` would render two stacked boxes
 * where the origin page rendered one. That is not only a different picture from the one asked
 * for; the second box would be a heading-less card hanging under a labelled one, when the
 * ruling for `/profile` is that *the reader's name is the box's heading*. So the card
 * belongs to whoever knows what else is going in it, which is never this file.
 *
 * THE GRID IS STILL NOT THE BANNER'S BUSINESS. `/profile`'s seven-field record
 * (`EmploymentFields`, which arrived from `/my-info`) sits *beneath* this band, as the
 * caller's sibling inside the caller's card. Do not add a slot
 * for it, and do not add a `subtitle`, an `href`, a `showStatus` or a `count`: the last of
 * those mirrors the rule `section-card.tsx` already states in its own voice — a
 * convenience prop is how the second caller inherits the first one's defect.
 *
 * IT TAKES RESOLVED DATA AND NOTHING ELSE. No fetching, no `catch`, no translation. That
 * is what lets the two callers keep opposite error strategies at a cost of zero props:
 * `/dashboard` catches its profile read and degrades to the session, `/profile` lets the
 * throw reach a boundary and shows its failure — the banner never learns which. This
 * package has no `next`, no `next-intl` and no tRPC, so every string arriving here is
 * already translated and every node is already built.
 *
 * WHY `statusBadge` IS A NODE AND NOT A BOOLEAN. The dashboard deliberately shows no
 * employee-status badge; `/profile` does (ADR-0002 D6). A `showStatus` boolean is a
 * foot-gun, because someone flips it. A node the dashboard call site simply never
 * constructs cannot be flipped, only added — which is the deliberate act the decision
 * asks for. Same reasoning as `action`, and the same reasoning that makes `footer` a node
 * on `SectionCard`.
 *
 * FIX 1 — THE ROLE IS PRINTED ONCE. `my-info/page.tsx` rendered `roleLabel` twice: as a
 * `text-white/70` sub-line under the name and again as a `bg-white/15` chip immediately
 * below it. That was a defect in the origin file, not a property of the layout, so the
 * chip stayed and the sub-line went. There is no `subtitle` prop here at all, which is
 * what keeps it gone.
 *
 * FIX 2 — REFLOW, SC 1.4.10 (AA). At a 320px viewport `px-7` takes 56px of the 320,
 * a 72px avatar and `gap-5` take another 92, and a `shrink-0` action takes ~90 — leaving
 * roughly 82px for the name and the chips. Without `min-w-0` the flex child refuses to
 * shrink below its content width and the whole page scrolls sideways. The chips are
 * customer-authored per-workspace labels of unbounded length, so this is not
 * hypothetical. `min-w-0 flex-1 break-words` is the same fix, for the same reason, that
 * the dashboard's chips component carries; nothing here truncates, because a half-printed
 * name is worse than a two-line one.
 *
 * FIX 3 — THE FACE IS DECORATIVE, SC 4.1.2 / SC 1.1.1. The origin passed `alt={fullName}`,
 * which announces the reader's name twice: once from the avatar and once from the heading
 * sitting immediately to its right. The picture carries nothing the adjacent text does
 * not, so it leaves the accessibility tree entirely — see the `aria-hidden` wrapper below
 * for why the wrapper, and not `alt=""`, is what does that.
 *
 * CONTRAST, MEASURED AGAINST `--color-brand-navy: #0c2340`. The name and the chip text at
 * white are 15.8:1; `bg-white/15` chips are 9.9:1 against the band. Both pass SC 1.4.3 at
 * AAA. The one figure that did not pass was the action's border: `border-white/20`
 * measures 1.88:1, under SC 1.4.11's 3:1. `border-white/40` is 3.66:1 — see the `action`
 * prop for the chrome the caller is expected to pass, and use that token, not `/20`.
 */
export interface IdentityBannerProps {
  /**
   * The reader's display name, already resolved by the caller down to a single string it
   * is willing to print — including whatever name-of-last-resort it falls back to. The
   * banner prints what it is given; it has no opinion about empty.
   */
  name: string;
  /** Pre-computed initials for the avatar's fallback face — `initialsFrom(...)`. */
  initials?: string;
  /** Photo URL when there is one. Absent → the initials paint instead. */
  avatarUrl?: string | null;
  /**
   * The heading element for `name`. `h2` by default — the weaker claim, which is right
   * for a banner that sits inside a page that already has a title. `/dashboard` passes
   * `h1`, because there the reader's name *is* the top-level heading inside `<main>`.
   *
   * A LITERAL UNION, NOT `React.ElementType`. `NavLink` in this package is polymorphic
   * that way, and it is right there because a nav item genuinely renders as a button, an
   * anchor or a link component. Here the two accepted values are the only two that are
   * ever correct, and `ElementType` would additionally accept `'div'` or `'span'` — which
   * would silently drop the reader's name out of the heading outline. That is the same
   * class of foot-gun `statusBadge` is a node to avoid, so the type says what it means.
   * `SectionCard`'s `headingLevel?: 2 | 3` is the same decision spelled with numbers; this
   * prop is named for the tag because the tag is what the arbitration named.
   */
  nameAs?: 'h1' | 'h2';
  /**
   * The employee-status badge, at the end of the chip row. A NODE the caller builds —
   * see the note above on why this is not a boolean. The dashboard passes nothing.
   *
   * This is `Badge variant={EMPLOYEE_STATUS_VARIANT[...]}`, NOT `IdentityBannerChip`: the
   * status is colour-coded by value and the neutral chips are not, and collapsing the two
   * would throw away the only distinction the row draws.
   */
  statusBadge?: React.ReactNode;
  /**
   * The right-hand action — on `/dashboard`, the outlined "My Profile" link. A node,
   * because this package has no `next` dependency and so cannot navigate; and optional,
   * because on `/profile` the link would point at the page the reader is standing on,
   * where absence is the honest treatment.
   *
   * The banner owns the slot's GEOMETRY (`shrink-0 self-start`) — the reflow fix above
   * depends on the action not shrinking — and the caller owns its chrome. Pass:
   *
   *   `rounded-md border border-white/40 px-3 py-1.5 font-semibold text-white text-xs
   *    transition hover:bg-white/10`
   *
   * `border-white/40` and not `/20`: 3.66:1 against the band rather than 1.88:1.
   */
  action?: React.ReactNode;
  /**
   * The chip row: role, department, whatever else the caller has resolved. Chip TEXT is
   * the caller's, because it is DB-authored and locale-resolved and neither of those can
   * happen in this package — but chip CHROME is not, so wrap each label in
   * `IdentityBannerChip` rather than re-typing its classes. An omitted chip row draws no
   * row at all, rather than an empty one with the row's top margin still in it.
   */
  children?: React.ReactNode;
  className?: string;
}

export interface IdentityBannerChipProps {
  /** The chip's label — already translated, already locale-resolved by the caller. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * `IdentityBannerChip` — one neutral pill on the navy band: a role, a department, a
 * customer-authored label.
 *
 * IT EXISTS BECAUSE THE CLASS STRING WAS THE REASON FOR THE EXTRACTION. The arbitration
 * that created `IdentityBanner` named the chip explicitly — "the duplicated region is ~26
 * lines containing two byte-identical copies of the chip class string, which is precisely
 * the kind of thing that drifts". Chips are `children`, so leaving the string uncaptured
 * would have had `/dashboard` and `/profile` each re-type it and reproduce, one file over,
 * the exact defect the extraction was authorized to fix. Both call sites use this; neither
 * writes `bg-white/15` itself.
 *
 * WHY NOT A `Badge` VARIANT. `Badge`'s variants are all app-surface semantics (primary,
 * destructive, success...) resolved against theme tokens; this pill is white-on-navy and
 * is correct *only* inside this band. A `variant="onNavy"` would put a band-specific
 * colour pair into the system's shared status vocabulary, where the next caller would
 * reach for it on a white card at 1.2:1. The name says where it works. And `ScopeChip` —
 * the only other thing in this package called a chip — is an interactive scope dropdown,
 * so nothing here duplicates it.
 *
 * NO `whitespace-nowrap`, EVER. The instinct with a pill is to keep it on one line. These
 * labels are `getLocalized(...)` strings of unbounded customer-authored length, and the
 * band's reflow fix (SC 1.4.10) depends on this row being allowed to wrap and, inside a
 * chip, to break: `break-words` is inherited from the text column above, and pinning the
 * chip would hand the horizontal scrollbar straight back.
 *
 * CONTRAST. `bg-white/15` behind white text is 9.9:1 against `--color-brand-navy`.
 */
export function IdentityBannerChip({ children, className }: IdentityBannerChipProps) {
  return (
    <span
      className={cn(
        'rounded-full bg-white/15 px-3 py-0.5 font-semibold text-white text-xs',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function IdentityBanner({
  name,
  initials,
  avatarUrl,
  nameAs = 'h2',
  statusBadge,
  action,
  children,
  className,
}: IdentityBannerProps) {
  const Name = nameAs;
  /** Nothing in the row → no row, and no `mt-2` hanging under the name. */
  const hasChips = Boolean(children) || Boolean(statusBadge);
  return (
    /* The band, and only the band — no border, no radius, no shadow. The caller's
       `<Card className="overflow-hidden p-0">` supplies all three and clips this navy
       against them; see the header note on why the card is not ours to draw. */
    <div
      className={cn(
        'flex items-center gap-5 bg-[color:var(--color-brand-navy)] px-7 pt-7 pb-5',
        className,
      )}
    >
      {/* `xl` (72px) with its white ring — the size drawn for exactly this band.
          `aria-hidden` ON A WRAPPER, which is FIX 3. The name is printed as a heading
          immediately to the right, so the face is decorative and belongs out of the
          accessibility tree — but `alt=""` alone only achieves that on the photo path.
          On the initials path `Avatar` renders `role="img" aria-label={alt}`, so an empty
          `alt` yields an image role with no accessible name (SC 4.1.2), and that path is
          the common one: most readers have no photo. Hiding the subtree covers both, and
          does it without changing `Avatar` for the table rows and drawers that legitimately
          need a named face. Nothing in here is focusable, so nothing is hidden from a
          keyboard while staying reachable by tab. */}
      <span aria-hidden="true">
        <Avatar imageUrl={avatarUrl} initials={initials} alt="" size="xl" />
      </span>
      {/* The reflow fix. See FIX 2 in the header: `min-w-0` is what lets this child
          shrink below its content width, and `break-words` is what makes it wrap
          instead of overflow. Removing either one puts a horizontal scrollbar on the
          first screen of every authenticated session. */}
      <div className="min-w-0 flex-1 break-words">
        <Name className="m-0 font-bold text-2xl text-white">{name}</Name>
        {hasChips && (
          <div className="mt-2 flex flex-wrap gap-2">
            {children}
            {statusBadge}
          </div>
        )}
      </div>
      {/* `shrink-0` so the action keeps its width and the text column gives way
          instead; `self-start` so it sits level with the name rather than centring
          against a chip row of unknown height. */}
      {action && <div className="shrink-0 self-start">{action}</div>}
    </div>
  );
}
