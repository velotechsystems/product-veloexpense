'use client';

import { cn } from '@expenseos/design-system';
import { IconDeviceDesktop } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';

/**
 * The per-region `limited` notice — what a REGION a route suppresses on a small screen
 * shows in place of the controls it removed.
 *
 * Sibling of `DesktopOnlyNotice`. Which of the two subtrees renders — this notice or the
 * controls it stands in for — is the CALLER's decision, and so is the mechanism (`/analytics`
 * selects in JS with `useIsCompact()`); this component only renders the notice.
 *
 * ─── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────
 *
 * NOT A SMALLER EDITOR. It renders prose and at most one link. It never renders an `Input`,
 * a `Combobox`, a `MoneyInput`, a `Textarea`, a `Checkbox`, a `<select>`, or anything
 * carrying a `<Field label>`. What is suppressed is suppressed; nothing is re-offered in a
 * smaller form, and there is no "continue anyway" — a "show me the controls anyway" toggle
 * would hand the reader three 60px comboboxes and call it a feature.
 *
 * NO LABELLED FIELD, AND THAT IS A TEST CONTRACT RATHER THAN TASTE. Playwright's label
 * engine has NO visibility filter, so a CSS-hidden twin of a labelled field IS a strict
 * match where a CSS-hidden twin of a ROLE is not (`getByRole` skips ARIA-hidden nodes).
 *
 * NOT A PERMISSION. `CLAUDE.md`: the server is authoritative and UI gating is cosmetic.
 * Hiding a control changes nothing about what the server will accept.
 *
 * ─── THE TESTID, AND WHY IT IS NOT THE SIBLING'S ─────────────────────────────────────────
 *
 * `e2e/crawl-mobile.spec.ts:559-570` enforces EXACTLY ONE node carrying the desktop-only
 * notice's own testid per route, and requires that node to be VISIBLE. Sharing that id
 * would turn a green crawl red with a message counting notices — a failure that looks
 * nothing like its cause — and it would do so even now that a route renders one of these
 * at a time, because a caller hides this one on a desktop and the crawl's requirement is
 * visibility, not presence. So `section-limited-notice` is deliberately a different
 * string; the crawl's locator is an exact attribute match, so the two never collide, and
 * nothing in `e2e/` addresses this one at all.
 *
 * The contract itself is documented in exactly one place — `DesktopOnlyNotice.tsx`, whose
 * own test pins that single-source property by walking the app source. Read it there; this
 * comment deliberately does not restate the literal id, because restating it is what that
 * guard exists to catch.
 *
 * `scripts/check-e2e-ids.mjs` reads `#id` selectors only and has nothing to say about
 * `data-testid`, so there is no registry to add this to.
 *
 * ─── THE COPY SAYS WHAT YOU *CAN* DO, AND IT IS SAID ONCE ────────────────────────────────
 *
 * One pair of strings, and it says what you *can* do here and what needs a larger screen.
 * It names what it covers rather than saying "everything", so it stays true as a region
 * gains a phone version. A notice that says only "not available on mobile" makes the page
 * read as broken rather than as scoped.
 *
 * ONCE PER PANE, NOT ONCE PER REGION. This shipped as five placements inside
 * `/expenses/[reportId]` — allocations, tax, line items, attendees, and the expenses card
 * — each accurate and each in the right place. On a 664px screen they read as five copies
 * of one sentence, and the reader who skips the third is skipping a box that is trying to
 * tell them something. Render it once per pane, above the first region it names, where it
 * speaks for every region it names. (That route has none any more: P13 gave its last
 * suppressed regions an editor at every width.) A caller adding a second one to the same
 * scroll is almost certainly answering "which region" — a question the surrounding card
 * headings already answer — rather than "why can I not change this".
 *
 * The lead sentence is emphasised prose rather than a heading, on purpose: a heading here
 * would add an entry to the document outline and to a screen reader's heading list that
 * says nothing the surrounding card's own heading does not already say.
 */
export function SectionNotice({
  className,
  namespace,
}: {
  className?: string;
  /**
   * The catalog block the two strings come from. It must define
   * `sectionLimitedTitle` and `sectionLimitedBody` and nothing else is read.
   *
   * WHY A NAMESPACE AND NOT `children`, OR A SECOND COMPONENT. The one-title-one-body
   * shape above is this component's whole invariant, and a `children` prop would move
   * the enforcement of it from here to caller discipline — the first caller to pass two
   * paragraphs, or a paragraph and a link, would have re-invented the five-placement
   * sprawl the header records. Requiring every namespace to spell the SAME two key names
   * keeps the invariant where it can be enforced: a block missing one of them is a
   * `MISSING_MESSAGE` at render, not a differently shaped notice.
   *
   * REQUIRED, with no default. The default used to be `expenses.workbench`, whose two keys
   * were deleted with that route's last notice; a default would now point at a missing
   * block, and nothing would say so before render (`check-used-keys` cannot resolve a
   * variable namespace). Required, a caller that forgets it is a type error instead.
   */
  namespace: string;
}) {
  const t = useTranslations(namespace);
  return (
    <div
      data-testid="section-limited-notice"
      className={cn(
        'flex items-start gap-2 rounded-md border border-border border-dashed bg-muted/40 p-2.5 text-muted-foreground text-xs',
        className,
      )}
    >
      <IconDeviceDesktop size={14} className="mt-0.5 shrink-0" aria-hidden />
      <p>
        <span className="font-medium text-foreground">{t('sectionLimitedTitle')}</span>{' '}
        {t('sectionLimitedBody')}
      </p>
    </div>
  );
}
