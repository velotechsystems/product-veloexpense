'use client';

import { cn } from '@expenseos/design-system';
import { IconDeviceDesktop } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';

/**
 * The per-region `limited` notice — what a REGION a route suppresses below `lg` shows in
 * place of its editing controls.
 *
 * Sibling of `DesktopOnlyNotice`, and it inherits that file's reasoning about the mechanism
 * wholesale: both subtrees stay in the DOM and CSS decides which one has a box
 * (`lg:hidden` on the notice, `hidden lg:contents` on the controls). Read its header for
 * the `contents`-not-`block` argument, which applies here for the same reason and with one
 * extra edge — these regions are flex children of `ExpenseEditor`'s `flex flex-col gap-3`,
 * so a `block` wrapper would insert a box between them and their flex parent and every
 * `flex-1`, `min-h-0` and `gap` inside would resolve against the wrapper.
 *
 * ─── WHY CSS HERE, WHEN THE REPORT CHROME NEXT DOOR IS SELECTED IN JS ────────────────────
 *
 * The two answers are different on purpose, and the rule that tells them apart is
 * duplication of an accessible name or of a source of truth — not the mechanism's fashion.
 *
 * The chrome RELOCATES, so two subtrees would define the report's action set twice. This
 * SUPPRESSES, so there is one definition and the question is only which box it gets. And
 * CSS is strictly better here for a reason it is not there: the editing controls are the
 * heavy, STATEFUL part of the page. A JS branch would *unmount* `AllocationEditor`,
 * `ExpenseTaxPanel`'s editor, `LineItemRow` and `AttendeesEditor` on a desktop resize
 * across 1024px — discarding the local `useState` each of them holds, which means a
 * half-typed allocation percentage or tax figure is gone with no recovery path, for a
 * desktop user who did nothing but drag a window.
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
 * `e2e/support/workbench.ts:81`'s `getByLabel('Vendor')` is unscoped and strict and is used
 * by every spec that adds an expense — a second labelled Vendor input anywhere on this page
 * breaks all of them at 1280 in `chromium`, a width at which none of this is even supposed
 * to be visible. Same for Date, Location, Currency, Amount, GST/HST, QST, PST and Distance.
 *
 * NOT A PERMISSION. `CLAUDE.md`: the server is authoritative and UI gating is cosmetic.
 * Hiding a control changes nothing about what the server will accept — `editable` still
 * means exactly "the server will accept a mutation on this report", and the server
 * re-derives that same predicate from `EDITABLE_REPORT_STATUSES` on every write.
 *
 * ─── THE TESTID, AND WHY IT IS NOT THE SIBLING'S ─────────────────────────────────────────
 *
 * `e2e/crawl-mobile.spec.ts:559-570` enforces EXACTLY ONE node carrying the desktop-only
 * notice's own testid per route, and requires that node to be VISIBLE. Sharing that id
 * would turn a green crawl red with a message counting notices — a failure that looks
 * nothing like its cause — and it would do so even now that a route renders one of these
 * at a time, because this one is hidden at `lg` and up and the crawl's requirement is
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
 * One pair of strings, and it says what you *can* do: these regions are current and can be
 * read here; changing them needs a larger screen. It names the regions it covers rather
 * than saying "everything", so it stays true as regions gain a phone editor. A notice that
 * says only "not available on mobile" makes the page read as broken rather than as scoped.
 *
 * ONCE PER PANE, NOT ONCE PER REGION. This shipped as five placements inside
 * `/expenses/[reportId]` — allocations, tax, line items, attendees, and the expenses card
 * — each accurate and each in the right place. On a 664px screen they read as five copies
 * of one sentence, and the reader who skips the third is skipping a box that is trying to
 * tell them something. It is now rendered once, directly above the first region it names
 * (on `/expenses/[reportId]`, the cost allocation), where it speaks for every region it
 * names. A caller adding a second one to the same scroll is almost certainly answering
 * "which region" — a question the surrounding card headings already answer — rather than
 * "why can I not change this".
 *
 * The lead sentence is emphasised prose rather than a heading, on purpose: a heading here
 * would add an entry to the document outline and to a screen reader's heading list that
 * says nothing the surrounding card's own heading does not already say.
 */
export function SectionNotice({
  className,
  namespace = 'expenses.workbench',
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
   * The default is `expenses.workbench`, so the workbench call site — the only one that
   * existed before `/analytics` — changes by exactly nothing.
   */
  namespace?: string;
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
