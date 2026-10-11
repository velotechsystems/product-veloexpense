'use client';

/**
 * "Did this report reach the ledger, and can I send it?" — answered on the report.
 *
 * Posting has worked since the poster landed: automatically when the approval
 * engine drives a report to APPROVED, and by hand from the posting dry-run. But
 * neither is visible from the report itself, so a posted report and a
 * silently-failed one looked identical here, and the only way to push one was to
 * open an admin page and find its row. During a close, that is the difference
 * between noticing a failure and reconciling it a month later.
 *
 * Deliberately narrow: this states the posting state and offers a push. Approving
 * or WITHHOLDING a payload — reading the composed GL lines and deciding — stays in
 * the dry-run, which is built to show that arithmetic. A button here that silently
 * cleared a colleague's deliberate denial would undo a decision without showing it.
 *
 * Ported from ExpenseOS's `NetSuitePush.tsx` (550b2945). VeloExpense (d38):
 *   · the state is VeloExpense's vendor-neutral `integration_post` row (`report.posting`,
 *     see `postingStateOf` in server/routers/expenses.ts), in its own vocabulary —
 *     PENDING (PROCESSING once claimed), POSTED, FAILED, DEAD, CANCELLED, NEEDS_REVIEW —
 *     where ExpenseOS reads its NetSuite sync row;
 *   · there is no push. VeloExpense queues the post when the approval engine approves
 *     the report, and retrying, releasing or cancelling it is /admin/ledger-queue's, which
 *     audits each (VX3-6). The push button becomes a LINK to that queue, offered on the
 *     same states ExpenseOS offered its push on, to whoever may retry a post;
 *   · ExpenseOS's posted-record link, paid/unpaid split and post warnings are NetSuite's
 *     and have no VeloExpense source, so the POSTED state is the badge alone;
 *   · the copy is ledger-neutral (`ledger.report`), not NetSuite's.
 */

import { Badge, Button } from '@expenseos/design-system';
import { IconExternalLink } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/** VeloExpense: `report.posting` — `integration_post`'s state for this report. */
export interface LedgerPostState {
  status: 'PENDING' | 'PROCESSING' | 'POSTED' | 'FAILED' | 'DEAD' | 'CANCELLED' | 'NEEDS_REVIEW';
  attempts: number;
  lastError: string | null;
  externalId: string | null;
  postedAt: Date | string | null;
}

/** Badge tone per posting state. CANCELLED is amber, not red: nothing broke — somebody
 *  decided this report should not post. NEEDS_REVIEW is amber too: the ledger accepted it
 *  and only the record of that is missing, which a person settles on the queue.
 *  VeloExpense: ExpenseOS's DENIED is VeloExpense's CANCELLED, its SYNCED is POSTED, and
 *  DEAD (retries exhausted) is a failure, as red as FAILED. */
const TONE = {
  POSTED: 'success',
  PENDING: 'secondary',
  // A claimed PENDING row (`postingStateOf`). Mapped, as ExpenseOS maps it: an unmapped
  // status renders `variant={undefined}`, which is the PRIMARY badge, so the one state
  // nobody thought about would come out as the loudest thing on the page.
  // VeloExpense: the kit Badge has no `info` tone (no `--color-info` token); `default`,
  // the brand tint, is the in-flight tone the kit has.
  PROCESSING: 'default',
  FAILED: 'destructive',
  DEAD: 'destructive',
  CANCELLED: 'warning',
  NEEDS_REVIEW: 'warning',
} as const;

export function LedgerPost({
  state,
  canOpenQueue,
  /** APPROVED / REIMBURSED. Anything earlier is not a liability and must not post. */
  postable,
}: {
  // VeloExpense: no `reportId` — it identified the report to ExpenseOS's push mutation.
  state: LedgerPostState | null;
  canOpenQueue: boolean;
  postable: boolean;
}) {
  const t = useTranslations('ledger.report');
  // Nothing to say about a report that isn't a liability yet. A DRAFT showing
  // "not posted" would be noise on every report anyone has ever started.
  if (!postable) return null;

  const status = state?.status ?? 'NOT_POSTED';
  // A withheld report is not re-pushed from here — see the note at the top. Nor is one
  // somebody has claimed is already in NetSuite: pushing would create the duplicate the
  // claim exists to prevent.
  // VeloExpense: the same refusals, for the queue link — not on a POSTED report, not on a
  // CANCELLED one (the withheld decision), and not on NEEDS_REVIEW (the ledger has it).
  const pushable =
    canOpenQueue && status !== 'POSTED' && status !== 'CANCELLED' && status !== 'NEEDS_REVIEW';
  const failed = status === 'FAILED' || status === 'DEAD';

  return (
    /*
     * `min-w-0 justify-end`, not `shrink-0`. `min-w-0` decides that this row is the one
     * that gives; `justify-end` decides which way it gives OUT when it has nothing left.
     * Both are load-bearing, and the second is a mis-click fix rather than a cosmetic one.
     *
     * This row used to be `shrink-0`, which meant it was laid out at its own max-content
     * width and overflowed its parent rather than compressing. That is what made the top
     * bar's right zone incompressible: `TopBar.tsx` bounds the right grid track so the
     * zone can never leave the header, and a bounded track can only work if something in
     * the row it holds is willing to give. Nothing was — every box the workbench mounts
     * there is `shrink-0`, this one included — so the zone's min-content equalled its
     * max-content (708px in EN, 853px in fr-CA, measured) and the content was painted
     * outside the zone, across the left zone's breadcrumb.
     *
     * With `min-w-0` this row is the yielder, and the thing that actually gives inside it
     * is the error span's `truncate` at the bottom. Measured at 1024px with the sidebar
     * pinned: nothing is painted outside the right zone in either locale, against 44px
     * (EN) / 189px (fr-CA) before.
     *
     * That was not the end of it, because the give RUNS OUT. Once the error span is at
     * zero — and with no error it does not exist at all — every child here is `shrink-0`,
     * so the shell's remaining squeeze cannot be absorbed and is painted outside this box.
     * Under the default `justify-content: flex-start` the negative free space overflows off
     * the END edge, onto `printButton` (`ExpenseReportWorkbench.tsx:803`, mounted in the
     * slot row at `:1090`), which is a LATER sibling in the same stacking context and
     * therefore paints on top. Measured at 1024px with the sidebar pinned in fr-CA: this
     * row is squeezed 13px with no error span and 19px once one exists, and 11.2px of it
     * lands over `printButton`. In the no-error state those 11.2px are the trailing edge of
     * the retry `Button` below — so a click there opened the print view instead of retrying
     * the post. A covered control that still looks clickable is worse than a clipped one.
     *
     * `justify-end` inverts the direction. CSS Flexbox §8.2 packs `flex-end` against the
     * end edge and overflows the START edge only. It is the same mechanism `TopBar.tsx`
     * already relies on one level up: `justify-end` on the right zone sends ITS overflow
     * leftward, away from the bell and the launcher (+350px of sibling overlap without it,
     * measured). So the TRAILING child stays flush inside this box — the retry `Button`
     * with no error, the error span once a retry has been refused — and the LEADING child,
     * the `Badge`, is what escapes. The retry control is then not merely painted under
     * `printButton`, it is nowhere near it: the slot row's `gap-2` leaves 8px of clearance
     * between this box's end edge and `printButton`'s start edge. PREDICTED from the
     * flexbox overflow rule plus the 13px / 19px squeeze recorded above — the geometry is
     * `e2e/topbar-overlap.spec.ts`'s to confirm, not this comment's to assert.
     *
     * The trade, written down so nobody has to re-derive it. The badge now paints leftward
     * over this row's EARLIER siblings, and — later sibling again — on top of them. At the
     * recorded magnitudes that reaches the slot row's `gap-2` (8px) plus the trailing edge
     * of `externalIds` (`ExpenseReportWorkbench.tsx:786`, a bare `<span>`) or, on a report
     * with no external ids, of `status` (`StatusBadge` — also a bare `<span>`, see
     * `packages/design-system/src/components/data-display/StatusBadge.tsx:56`). NEITHER is
     * a click target, so what the overlap costs is legibility, not a wrong action. It does
     * not reach `total` (`ExpenseReportWorkbench.tsx:700`), which IS interactive twice over
     * — a `currencyToggle` `<button>` (`:686`) and a `group-hover` FX panel (`:707`) — and
     * that is the number to watch: `total` sits behind a whole `status` pill and two `gap-2`
     * gaps, so the escape would have to grow by roughly an order of magnitude on the
     * recorded 13px before it became a mis-click again. If it ever does, the answer is less
     * content in the bar, not a third justification.
     *
     * Two costs `justify-end` deliberately does NOT carry. It moves nothing where there is
     * slack: this row is a `flex-shrink`-only item sized to its own content, so its free
     * space is never POSITIVE and `justify-content` has nothing to distribute — EN at 1024
     * pinned is unsqueezed and lays out identically with it and without it. And in the
     * SYNCED branch the leading child is an `<a>`; if that ever escapes it escapes as the
     * element on top, keeping its own hit area, over the same two non-interactive pills.
     *
     * Rejected, for reasons already on the record: `flex-wrap` (this row lives in an `h-8`
     * band, so a second line paints over the page body rather than making room) and
     * dropping the `Badge`'s `shrink-0 whitespace-nowrap` (218px on one line → 88px over
     * three). `relative z-*` on this row is not a fix either — it would leave the retry
     * button hit-testable while `printButton`'s icon was still drawn through it, and it
     * would take `printButton`'s own clicks instead. Moving the overlap is the whole job;
     * the only question is onto what, and the answer here is two pills nobody can click.
     *
     * The consequence is below at the `Badge`: now that this row can shrink those classes
     * are live rather than inert, and it is the child this row's overflow escapes through.
     */
    <span className="flex min-w-0 items-center justify-end gap-1.5">
      {/* VeloExpense: no posted-record link, paid split or warnings — see the header. */}
      {
            <Badge
              /**
               * Call-site scoped, and not pushed down into `badge.tsx`.
               *
               * This is the one multi-word posting state — `"NetSuite post failed"` /
               * `"Échec de publication NetSuite"`, plus a ` ×5` — so it is the only one whose
               * label has a soft-wrap opportunity at all; every other state is a single word.
               * The base component stays bare: well over a hundred call sites render it (135
               * `<Badge` occurrences across 53 files by direct grep; the "141" this comment
               * first cited is not reproducible), and some are flex children of a `<td>` with
               * nothing else in the row that can yield — `ApprovalWorkflowsAdmin.tsx:134` is
               * one — where a base `shrink-0` would pin the pill at `max-content` and spill
               * the cell instead.
               *
               * **These two classes are load-bearing. They were not, and the change that made
               * them live is `:160` above losing its `shrink-0`.** The reasoning that established
               * that is kept here rather than replaced, because it is what identifies the exact
               * hazard they now guard.
               *
               * The finding was: the flex-child rule's "safe iff a designated shrink victim"
               * does NOT describe this call site. An earlier version of this comment claimed the
               * error span below was that victim, and it is not — that span is fed only by the
               * mutation's `onError`, so it exists only after a retry has been refused. In the
               * state users normally see, this row is a badge plus a button and nothing in it
               * can yield. What made the classes harmless anyway sat one level up: the row at
               * `:160` was itself `shrink-0`, so it was laid out at its own max-content width and
               * overflowed its parent instead of compressing. Free space inside it was therefore
               * never negative — no child was ever asked to shrink, no text was ever asked to
               * wrap — and both classes measured as inert: on a reduction of this DOM in
               * Chromium, adding or removing them changed this pill's box by 0px, while dropping
               * the row's `shrink-0` collapsed a bare pill from 218px on one line to 88px over
               * three. They were kept as the insurance that would start working the moment `:160`
               * lost its `shrink-0`.
               *
               * That moment has arrived, deliberately: `:160` is now `min-w-0` so that the top
               * bar's right zone can be bounded without being painted outside itself (see the
               * note at `:160`, and `e2e/topbar-overlap.spec.ts`). So the 218px→88px number above
               * is no longer a hypothetical — it is what `shrink-0 whitespace-nowrap` is holding
               * off, in a `h-8` row where three lines of pill would not fit. Do not remove them.
               *
               * The prediction that the insurance would be needed only in the refused-retry
               * state was itself too optimistic, and the measurement is worth recording: at
               * 1024px with the sidebar pinned in fr-CA, this row is squeezed by 13px in the
               * NO-error state — badge plus button alone are already wider than the space the
               * shell can give them — and by 19px once the error span exists. In EN neither
               * state is squeezed at that width. So the pill is asked to shrink on a report
               * nobody has pressed anything on, in one of the two shipped locales.
               *
               * These classes are also what makes this pill the row's designated ESCAPEE.
               * `:160` is `justify-end`, so the squeeze above overflows off the row's start
               * edge and this — the leading child, pinned at `max-content` — is what is
               * painted outside it, leftward over two non-interactive pills. That is the
               * deliberate choice; the note at `:160` has the trade and the paint order.
               *
               * What bounds this row's max-content is still not a shrink victim: it is the error
               * span's `max-w-[28rem] truncate`, capping that span's contribution. For a call
               * site that genuinely instantiates the flex-child rule, see
               * `admin/expense-categories/ExpenseCategoriesAdmin.tsx:245`, whose row (`:232`)
               * has a real yielder at `:234` (`min-w-0 flex-1 truncate`).
               */
              className="shrink-0 whitespace-nowrap"
              // A stable handle for the geometry spec in `e2e/topbar-overlap.spec.ts`, which
              // has to prove it measured THIS badge — the long posting-state one — and not the
              // report's own short status pill beside it. Matching on the label alone would
              // pass on a report whose state happened to render something narrower.
              data-testid="ledger-report-state"
              variant={state ? TONE[state.status] : 'secondary'}
              title={state?.lastError ?? undefined}
            >
              {state
                ? t(`state.${state.status}`) + (state.attempts > 1 ? ` ×${state.attempts}` : '')
                : t('state.NOT_POSTED')}
            </Badge>
      }

      {pushable && (
        <Button
          asChild
          size="sm"
          variant="outline"
          /**
           * `button.tsx` carries `whitespace-nowrap` but NOT `shrink-0`, so this button was
           * squeezed below its own content width while its label refused to wrap — the
           * label painted straight out of the button and over whatever sat beside it. That
           * is the "Retry post" / "Réessayer la publication" spill under the bell.
           */
          className="shrink-0"
        >
          {/* VeloExpense (d38): the queue, where retrying, releasing and cancelling a post
              are audited, in place of ExpenseOS's push mutation. The word still changes with
              the state: a first send and a retry after a failure are the same place but not
              the same decision. */}
          <Link
            href="/admin/ledger-queue"
            title={failed ? t('retryHelp') : t('pushHelp')}
          >
            <IconExternalLink size={13} className="mr-1" />
            {failed ? t('retry') : t('push')}
          </Link>
        </Button>
      )}
    </span>
  );
}
