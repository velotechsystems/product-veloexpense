'use client';

/**
 * Three-pane expense-report workbench (replaces the old review drawer). Opened
 * at /expenses/[reportId]:
 *   - LEFT  — the report's expenses as a selectable list + Upload receipt / Add
 *             expense. Keyboard nav (↑/↓ / j/k).
 *   - CENTER— the selected expense's editor.
 *   - RIGHT — the selected expense's single receipt.
 *
 * All report-level chrome (editable title, policy-violation indicator, total /
 * status / submit / recall / delete / approver decide flow) is projected into
 * the app-shell TopBar via `useTopBarSlots`. Reusable pane pieces live in
 * `../_workbench/parts`.
 *
 * BELOW `lg` THAT IS NO LONGER THE WHOLE STORY, and the exception is the point.
 * ADR-0002 rations the TopBar's right slot below `lg` to one icon-only control
 * or nothing, and it measured this row at 532.813px (EN) / 677.156px (fr-CA)
 * min-content against a shared 238px budget at 360 — so on a phone the chrome
 * cannot live there, and a page with no header bar of its own is a page with no
 * Submit button. Below `lg` the page grows one: `ReportSummary` and
 * `PhoneActionBar`, as the first child of the body. See the block above
 * `ExpenseReportWorkbench` for how one action set reaches two destinations.
 */
import {
  Button,
  buttonVariants,
  Checkbox,
  Combobox,
  type ComboboxItem,
  cn,
  DataTableToolbar,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ResizablePanels,
  StatusBadge,
  Textarea,
} from '@expenseos/design-system';
import {
  IconAlertTriangle,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconFileOff,
  IconInfoCircle,
  IconPaperclip,
  IconPencil,
  IconPlus,
  IconPrinter,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTopBarSlots } from '../../TopBar';
import { ReceiptFileInput } from '@/components/attachments/ReceiptFileInput';
import { CommentThread } from '@/components/comments/CommentThread';
import { useToolbarLabels } from '@/components/data-view';
import { UserCombobox } from '@/components/pickers/EntityPickers';
// `useRouter` MUST come from here and not from `next/navigation`. next-intl's router
// re-applies the active locale to a relative path; the bare one does not, so a
// `router.push('/expenses')` from a fr-CA reader lands on the unprefixed path and the
// middleware resolves it to the default locale — dropping them into English. The same
// bug was fixed in `ExpenseReportsList.tsx` (P05) and left live here; this is that fix.
// `useSearchParams` above stays on `next/navigation`: it reads the query string, which
// carries no locale segment, and next-intl publishes no wrapper for it.
import { Link, useRouter } from '@/i18n/navigation';
import { formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { useRefusalText } from '@/lib/trpc/refusal';
import { useCoarsePointer } from '@/lib/useCoarsePointer';
import { useDeepLink } from '@/lib/useDeepLink';
import { useIsBelowLg } from '@/lib/useIsBelowLg';
import {
  localeLabel,
  nextSelectedExpenseId,
  shouldPromptUpload,
  statusBadgeProps,
} from '../_shared';
import { GroupingResolver, suggestionKey } from '../_workbench/GroupingResolver';
import {
  ExpenseEditor,
  ExpenseListRow,
  hasPendingExtractionIn,
  ReceiptPane,
  type ReportDetail,
  receiptLockState,
  violationValues,
} from '../_workbench/parts';
import { LedgerPost, type LedgerPostState } from './LedgerPost';

/** Inline editable report title for the top bar: hover reveals a pencil,
 *  double-click (or the pencil) opens an input with save (✓) / cancel (✗);
 *  Enter saves, Escape cancels. Read-only reports show plain text. */
function EditableTitle({
  title,
  editable,
  onSave,
}: {
  title: string;
  editable: boolean;
  onSave: (next: string) => void;
}) {
  const t = useTranslations('expenses');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  if (!editable) {
    return <span className="truncate font-semibold text-base text-foreground">{title}</span>;
  }
  if (editing) {
    const commit = () => {
      const v = value.trim();
      if (v && v !== title) onSave(v);
      setEditing(false);
    };
    return (
      <div className="flex min-w-0 items-center gap-1">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="h-7 max-w-[16rem] font-medium"
        />
        <button
          type="button"
          aria-label={t('workbench.saveTitle')}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={commit}
        >
          <IconCheck size={15} />
        </button>
        <button
          type="button"
          aria-label={t('addLine.cancel')}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(false)}
        >
          <IconX size={15} />
        </button>
      </div>
    );
  }
  const open = () => {
    setValue(title);
    setEditing(true);
  };
  return (
    <div className="group flex min-w-0 items-center gap-1">
      <button
        type="button"
        onDoubleClick={open}
        className="truncate text-left font-semibold text-base text-foreground"
      >
        {title}
      </button>
      <button
        type="button"
        aria-label={t('workbench.editTitle')}
        onClick={open}
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        <IconPencil size={14} />
      </button>
    </div>
  );
}

/**
 * The two receipt-upload controls on this page, and the classes that make them
 * tappable. Sites 2 and 3 of P04's four; the other two are the reports list and
 * the receipt pane.
 *
 * ON A COARSE POINTER BOTH PAIRS ARE ICON-ONLY, as sites 1 and 4 already were.
 * That came from the operator's on-device review of this branch — beside "Add
 * expense" the labelled pair ran the drawer header past a phone's width — and
 * it overrides the earlier ruling that these two rows keep their words. All
 * four upload entry points now read the same way; the split, and the reasons
 * given for it, are gone. See
 * `docs/adr/0003-coarse-pointer-affordances-are-js-gated-css-sized.md`.
 *
 * The words move into an `sr-only` span at the call site, so every accessible
 * name — and voice control's "tap Take photo" — is exactly what it was.
 *
 * SIZE IS CSS at both treatments rather than a branch on the pointer hook; the
 * rule is stated in full at the top of `@/lib/useCoarsePointer`. There are two
 * targets now, because there are two treatments per site:
 *
 *   · The icon-only pair a coarse pointer actually gets is a real 44px SQUARE
 *     (`RECEIPT_TOUCH_SQUARE`). Its only laid-out child is an 18px icon —
 *     Tailwind's `sr-only` span is absolutely positioned at 1px square and
 *     contributes nothing to a flex box — so an unsized label there paints
 *     18x18, and `ReceiptFileInput`'s 6px ring would reach 30x30, 14px short of
 *     44. That is the arithmetic site 4 was corrected on; it applies here for
 *     the same reason.
 *   · The LABELLED treatment keeps `RECEIPT_TOUCH`, and it is not dead weight
 *     now that no coarse pointer settles on it: the icon-only pair is chosen in
 *     JS, so on a phone's FIRST paint — where `useCoarsePointer()` still answers
 *     `false` — the labelled library control is the only control on screen, and
 *     this is what makes it 44px in that frame instead of ~30px.
 *
 * Both sites still decline the hit-slop. Neither row is height-constrained, so a
 * genuine 44px box is available, and a 6px ring on top of one is a 56px tap area
 * poking outside a visible chip — which would also put the primitive's
 * neighbour-clearance condition on two rows that each sit beside a real button:
 * the hand-off's ghost dismiss and the drawer header's "Add expense".
 */
const RECEIPT_TOUCH = 'pointer-coarse:min-h-11 pointer-coarse:px-3';

/**
 * The 44px square the icon-only pair takes — the same call site 4 makes, by the
 * same arithmetic. `min-w-11` rather than `w-11`/`size-11` because a fixed width
 * still shrinks under flex and a minimum does not; `justify-center` lives in the
 * treatments below, which is where an icon with no padding round it needs it.
 */
const RECEIPT_TOUCH_SQUARE = 'pointer-coarse:min-h-11 pointer-coarse:min-w-11';

/**
 * Both labels of a pair, while an upload runs. Coarse pointer only — see
 * `captureBusy` below for why the condition lives at the call site.
 *
 * `disabled` on the inputs stops being enough once there are two controls: a
 * person who taps the one they did not start the upload with gets silence.
 * `pointer-events-none` is what actually swallows that tap, `opacity-50` is
 * what explains it, and `aria-disabled` on the label says the same thing to a
 * screen reader. No spinner: this codebase has no `animate-spin` and no
 * `prefers-reduced-motion` handling anywhere, so motion here would open a
 * reduced-motion obligation that P04 has no business paying.
 */
const RECEIPT_BUSY = 'pointer-events-none opacity-50';

/**
 * The hand-off banner's filled chip — today's treatment, character for
 * character, plus the first-paint touch target.
 *
 * The whole treatment a desktop ever sees, and what a phone paints in the one
 * frame before the icon-only pair below replaces it.
 */
const RECEIPT_CHIP_FILLED = `inline-flex cursor-pointer items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground text-sm hover:bg-primary/90 ${RECEIPT_TOUCH}`;

/** The drawer header's outline chip — the same thing one tier down: today's
 *  desktop treatment, character for character, plus the first-paint target. */
const RECEIPT_CHIP_OUTLINE = `inline-flex cursor-pointer items-center gap-1 rounded-md border border-input px-2.5 py-1.5 font-medium text-sm hover:bg-muted ${RECEIPT_TOUCH}`;

/**
 * The icon-only chip a coarse pointer gets — the drawer header's pair, and the
 * hand-off banner's picker.
 *
 * `gap-1`, `px-2.5 py-1.5`, `font-medium` and `text-sm` all come off, for the
 * reasons site 1's square lists: `sr-only` is absolutely positioned and so
 * contributes nothing to a flex gap, the square replaces the padding, and there
 * is no visible text left to weight or to size. `justify-center` goes on
 * because an 18px icon in a 44px box has to be told to centre.
 *
 * The drawer header's pair is TWO OF THESE, camera first. Its camera used to
 * carry `font-semibold` as its only hierarchy cue; with no visible text there is
 * nothing left for that to weight, so order is the cue — which is exactly the
 * shape site 1 has.
 */
const RECEIPT_CHIP_ICON = `inline-flex cursor-pointer items-center justify-center rounded-md border border-input hover:bg-muted ${RECEIPT_TOUCH_SQUARE}`;

/**
 * The same square, filled — the hand-off banner's camera only.
 *
 * The banner's emphasis survives the label going: it is a call to action, a
 * filled square still reads as one with no text in it, and the picker beside it
 * stays outline, so the banner still has exactly one primary. Losing the words
 * was the operator's instruction; losing the hierarchy was not.
 */
const RECEIPT_CHIP_ICON_FILLED = `inline-flex cursor-pointer items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 ${RECEIPT_TOUCH_SQUARE}`;

/** One control's full class list: its treatment (which carries its own touch
 *  target) plus the busy dimming. */
const receiptChip = (treatment: string, busy: boolean) =>
  busy ? `${treatment} ${RECEIPT_BUSY}` : treatment;

// ──────────────────────────────────────────────────────────────────────────────
// The report's action set, and its two destinations
//
// Below `lg` the report chrome cannot live in the app-shell TopBar. ADR-0002's
// "Below `lg`" section rations that slot to one icon-only control or nothing,
// and it measured THIS row at 532.813px (EN) / 677.156px (fr-CA) min-content
// against a shared 238px budget at 360. So the row has a second destination —
// and the moment it has two, the interesting question is how it stays ONE
// thing.
//
// It stays one thing by ceasing to be markup. A JSX row cannot be mounted in
// two places with two different layouts, so the action set is DATA: one ordered
// array of descriptors built from the state the page already owns, and two thin
// renderers that lay it out. Adding an action is one edit to the array and
// neither destination can be forgotten. The state machine is not forked either
// — `decideMode`, `decideNote`, `reassignTo`, `reassignItem` and `confirmDecide`
// all live in the page component, and the decide panel's markup has exactly one
// definition (`decidePanel`) that each container mounts in its own box. Same
// state, same mutation, two containers.
//
// WHICH TREE MOUNTS IS DECIDED IN JS, and that is the ruled mechanism for a
// RELOCATION (see the header of `@/lib/useIsBelowLg`). Two subtrees would mean
// the report's action set is defined twice, which is a second source of truth
// for "what can you do to this report". Suppression is the other half of that
// rule and goes the other way — both subtrees in the DOM, CSS selecting — and
// it is not what this file does.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The decide panel an approver action opens instead of firing immediately.
 *
 * Two of the three collect a note and one collects an approver, and the
 * renderers do not care which: what they branch on is "does pressing this open
 * a panel", so one field carries it rather than two.
 */
type DecidePanel = 'return' | 'reject' | 'reassign';

/** Every action this report offers, to whoever is looking at it. */
type WorkbenchActionId =
  | DecidePanel
  | 'approve'
  | 'acknowledge'
  | 'requestReceipts'
  | 'recall'
  | 'submit'
  | 'delete';

/**
 * The `Button` variants the action set uses, named rather than widened to the
 * whole variant union — a descriptor asking for `link` would be a design
 * question, not a typo, and it should have to be answered here first.
 */
type ActionVariant = 'default' | 'ghost' | 'destructive-outline' | 'success-outline';

/**
 * One thing this report can have done to it.
 *
 * Every field is here because BOTH destinations need it and neither may derive
 * it for itself — a renderer that recomputed `disabled` would be the second
 * source of truth this shape exists to prevent.
 */
type WorkbenchAction = {
  /** Stable identity. The glyph lookup and the tests both key on it. */
  id: WorkbenchActionId;
  /** Already translated. A renderer never reaches for a catalog key. */
  label: string;
  /**
   * What a press does. An action carrying `needsNote` is opened by its
   * container instead and commits from the panel's own confirm button, so this
   * opens that panel rather than firing anything.
   */
  onPress: () => void;
  variant: ActionVariant;
  /**
   * Whether the CONTROL is degraded. Never whether the CALL is: every one of
   * these mutations re-derives the actor and re-reads the row server-side, and
   * nothing here is a client-side authorisation decision.
   */
  disabled: boolean;
  /**
   * Why `disabled` is true, as a sentence a person can act on — set only for a
   * predictable block, not for "a request is in flight".
   *
   * The desktop row renders it as `title=`, which is a HOVER tooltip: on a
   * phone that is a greyed button and no sentence, which reads as a broken app.
   * The phone bar renders it as text under the button. One derivation, two
   * renderings — see `submitReason` in the page component.
   */
  disabledReason?: string;
  /**
   * At most one `primary` in the set. The phone bar gives it its own full-width
   * row and puts everything else on a separated row below, which is how
   * Approve ends up physically apart from Reject: two destructive-adjacent
   * controls flanking the affirmative one at 44px each in a 360px bar is how a
   * mis-tap approves a claim. It costs one row of height.
   */
  emphasis: 'primary' | 'secondary';
  /**
   * Where this action lives at `lg` and up. Absent is the TopBar row; `'strip'` is the
   * body-level `DesktopActionStrip` above the panes. Below `lg` it is ignored — the phone
   * bar holds every action.
   *
   * The strip exists because the TopBar has no width left for anything that is not a
   * decision. `e2e/topbar-overlap.spec.ts` measures the right zone at 853px of
   * unshrinkable content in fr-CA against a 720px header at 1024 pinned, and with the
   * NetSuite failure row Mark reimbursed pushed the title row 68px out of its zone at
   * 1280 collapsed; on the approver's page Request receipts squeezed the report title to zero
   * width at 1280 pinned in fr-CA. Whether a given row fits depends on the locale, the
   * sidebar, the NetSuite state and the title, so a breakpoint cannot say; and moving a
   * button between the bar and the body as the window resizes would put a different
   * control under the pointer. So the two actions that are not a decision on the task —
   * Request receipts and Mark reimbursed — have one fixed desktop home, in the body,
   * and the bar keeps exactly the row it had before they existed.
   */
  desktopPlacement?: 'strip';
  /** Pressing this opens a decide panel instead of firing. */
  needsNote?: DecidePanel;
  /** Destroys or refuses something; rendered in the destructive colour. */
  destructive?: boolean;
  /**
   * `window.confirm` copy. The renderer asks before calling `onPress`, so the
   * guard cannot be present in one destination and absent in the other —
   * which is the exact asymmetry that let report deletion fire straight from
   * the button while deleting SELECTED EXPENSES two panels away already asked.
   */
  confirm?: string;
};

/**
 * Glyphs, keyed by action id.
 *
 * Presentation, deliberately kept out of the descriptor: an icon is a thing a
 * container may or may not have room for, and the action SET is what the array
 * is a single source of truth for. Both renderers read this one table, so the
 * glyph cannot differ between them either.
 */
const ACTION_ICON: Partial<Record<WorkbenchActionId, ReactNode>> = {
  delete: <IconTrash size={14} className="mr-1" />,
};

/** Ask, if the descriptor says to ask, then fire. Shared by both renderers. */
function pressAction(action: WorkbenchAction) {
  if (action.confirm && !window.confirm(action.confirm)) return;
  action.onPress();
}

type ActionRendererProps = {
  /** The one ordered array. Both renderers consume it; neither filters it. */
  actions: WorkbenchAction[];
  /** Which decide panel is open — the page's own `decideMode`, unforked. */
  openPanel: DecidePanel | 'idle';
  onOpenPanel: (panel: DecidePanel, open: boolean) => void;
  /** The panel body, defined once in the page and mounted by whichever container asked. */
  renderPanel: (panel: DecidePanel) => ReactNode;
};

/**
 * The action row as the app-shell TopBar has always painted it — same order,
 * same variants, same popovers, same DOM.
 *
 * It is the DESKTOP destination and it mounts only at `lg` and up. The chrome
 * around it (total, status, external ids, the NetSuite state, print) stays in
 * the slot at every width and is CSS-cloaked below `lg` instead, because none
 * of it is relocated — nothing below `lg` renders a second copy of it, so
 * there is no second source of truth to keep honest and no reason to unmount.
 */
function TopBarActions({ actions, openPanel, onOpenPanel, renderPanel }: ActionRendererProps) {
  return (
    <>
      {actions.map((action) =>
        action.needsNote ? (
          <Popover
            key={action.id}
            open={openPanel === action.needsNote}
            onOpenChange={(o) => action.needsNote && onOpenPanel(action.needsNote, o)}
          >
            {/* VeloExpense: the kit's Popover is Radix (`asChild`) where ExpenseOS's is
                Base UI (`render`) — as data-display's BulkActionsMenu adapts it. */}
            <PopoverTrigger asChild>
              <Button size="sm" variant={action.variant} disabled={action.disabled}>
                {action.label}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
              {renderPanel(action.needsNote)}
            </PopoverContent>
          </Popover>
        ) : (
          <Button
            key={action.id}
            size="sm"
            variant={action.variant}
            className={action.destructive ? 'text-destructive' : undefined}
            disabled={action.disabled}
            title={action.disabledReason}
            onClick={() => pressAction(action)}
          >
            {ACTION_ICON[action.id]}
            {action.label}
          </Button>
        ),
      )}
    </>
  );
}

/**
 * The desktop home of the actions whose `desktopPlacement` is `'strip'` — a right-aligned
 * row above the panes, at `lg` and up only. See `WorkbenchAction.desktopPlacement` for why
 * these are not in the TopBar.
 *
 * Rendered by `TopBarActions`, so a control here is the same `size="sm"` button with the
 * same variant, confirm and disabled reason as it would be in the bar — only the box differs.
 * Labelled with the phone bar's name: the two never mount together (one is `isBelowLg`, the
 * other is not), so the page never has two landmarks called "Report actions".
 */
function DesktopActionStrip(props: ActionRendererProps) {
  const t = useTranslations('expenses');
  if (props.actions.length === 0) return null;
  return (
    <section
      aria-label={t('workbench.actionsLabel')}
      data-testid="desktop-action-strip"
      className="flex shrink-0 items-center justify-end gap-2 pb-3 max-lg:hidden"
    >
      <TopBarActions {...props} />
    </section>
  );
}

/** One action in the phone bar: the control, and the sentence under it. */
function PhoneActionButton({
  action,
  openPanel,
  onOpenPanel,
  full,
}: Omit<ActionRendererProps, 'actions' | 'renderPanel'> & {
  action: WorkbenchAction;
  /** The single `primary`, which takes a row of its own at full width. */
  full?: boolean;
}) {
  const panel = action.needsNote;
  return (
    <div className={full ? 'w-full' : undefined}>
      <Button
        size="sm"
        variant={action.variant}
        className={cn(full && 'w-full', action.destructive && 'text-destructive')}
        disabled={action.disabled}
        title={action.disabledReason}
        aria-expanded={panel ? openPanel === panel : undefined}
        onClick={() => (panel ? onOpenPanel(panel, openPanel !== panel) : pressAction(action))}
      >
        {ACTION_ICON[action.id]}
        {action.label}
      </Button>
      {action.disabledReason && (
        <p
          data-testid={`action-reason-${action.id}`}
          className="mt-1.5 text-muted-foreground text-sm"
        >
          {action.disabledReason}
        </p>
      )}
    </div>
  );
}

/**
 * The body-level action bar this route has never had — the phone destination
 * for the same array the TopBar row renders.
 *
 * Its layout is the one rule that is not tradeable: ONE primary, on its own
 * full-width row, with everything else on a separated row beneath it. In
 * approver mode the primary is Approve, which is what puts a row gap and a
 * rule between Approve and Reject rather than standing them side by side.
 *
 * The decide panel opens INLINE beneath the bar rather than in a popover. The
 * markup inside it is the same `renderPanel` the popover mounts; what differs
 * is the box, because a popover anchored to a full-width button at 360px is
 * positioning work with nothing to show for it.
 */
/**
 * The expense list's DOM id, so the pane header's disclosure button below `lg`
 * can point `aria-controls` at what it opens. A constant rather than a literal
 * at both sites, because the two have to agree and nothing else would say so.
 */
const EXPENSE_LIST_ID = 'workbench-expense-list';

function PhoneActionBar({ actions, openPanel, onOpenPanel, renderPanel }: ActionRendererProps) {
  const t = useTranslations('expenses');
  if (actions.length === 0) return null;
  const primary = actions.find((a) => a.emphasis === 'primary');
  const secondary = actions.filter((a) => a !== primary);
  return (
    <section
      aria-label={t('workbench.actionsLabel')}
      data-testid="phone-action-bar"
      className="rounded-md border border-border bg-card px-3 py-3"
    >
      {primary && (
        <PhoneActionButton action={primary} openPanel={openPanel} onOpenPanel={onOpenPanel} full />
      )}
      {secondary.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', primary && 'mt-3 border-border border-t pt-3')}>
          {secondary.map((action) => (
            <PhoneActionButton
              key={action.id}
              action={action}
              openPanel={openPanel}
              onOpenPanel={onOpenPanel}
            />
          ))}
        </div>
      )}
      {openPanel !== 'idle' && (
        <div className="mt-3 rounded-md border border-border bg-background p-3">
          {renderPanel(openPanel)}
        </div>
      )}
    </section>
  );
}

/**
 * Whether this page offers the FX override: a holder of `expense.report.fxOverride`,
 * on a mixed-currency report, while a decision is pending (the server refuses it
 * outside SUBMITTED, because the override restates the total the approver signs).
 *
 * RENDER-ONLY. One predicate drives both the cloaked control's mount and the phone's
 * plain sentence that names it, so the two can never disagree. It is pure and
 * synchronous, and its result is never passed to a mutation — the server re-derives
 * every term of it when the override is saved; this only decides what is drawn.
 * Exported for its truth-table test, as `_workbench/parts.tsx` exports its helpers.
 */
export function isFxOverrideOffered(
  canFxOverride: boolean,
  report: Pick<ReportDetail, 'status'> & { rollup: Pick<ReportDetail['rollup'], 'multiCurrency'> },
): boolean {
  return canFxOverride && report.status === 'SUBMITTED' && report.rollup.multiCurrency;
}

/**
 * The report's totals, in the body, below `lg`.
 *
 * A RE-PRESENTATION of data already on the client — the same
 * `trpc.expenses.report.useQuery` result the rest of the page reads. No new
 * procedure, no changed procedure, nothing promoted.
 *
 * WHAT IS RENDERED AND WHAT IS DISCLOSED. In the TopBar the composition sits
 * inline beside the total and the reconciliation sits in a `group-hover` panel
 * — and `hover` does not exist on a touch device, so on a phone both were
 * unreachable rather than merely inconvenient. Here:
 *
 *   · RENDERED, no tap: the total, the status, and — on a mixed-currency report —
 *     the by-currency composition (each currency's gross and the rate it was
 *     converted at). That is what an approver reads first, so it is never behind
 *     a control.
 *   · DISCLOSED, behind one closed-by-default "Conversion details" button, and
 *     only on a mixed-currency report: the reconciliation — each currency's
 *     converted amount in the report currency, a "Report total" row they add up
 *     to, recoverable VAT / ITC when it is not zero, and the missing-rate line.
 *     Gated on `rollup.multiCurrency` (operator decision, 2026-10-14), not on the
 *     TopBar's wider `hasFxDetail`, so a single-currency report's recoverable
 *     VAT / ITC stays hover-only on a phone — a recorded gap, not an oversight.
 *
 * The disclosure is local state and opening it sends nothing: every figure is
 * already on the query result. Its region stays MOUNTED under `hidden`, as the
 * expense-list disclosure does, so `aria-controls` always resolves. The rows are
 * deliberately not shared with the TopBar panel — that panel is budgeted to the
 * pixel by ADR-0002 and uses different markup, so sharing would move desktop.
 *
 * What it deliberately does NOT carry: a `<Field>`, an `<input>`, or an
 * `aria-label` matching any of the field names the E2E suite addresses
 * unscoped — `getByLabel` has no visibility filter, so a second labelled
 * "Vendor" anywhere on this page breaks every spec that adds an expense, at a
 * width where none of the phone work is supposed to be visible. The toggle's
 * name never contains "FX override" for the same reason: desktop specs press
 * that button by name, unscoped.
 *
 * THE FX OVERRIDE is not reachable here: its control keeps its desktop-only cloak in
 * the expense-list header, and this block holds no second mount of it.
 * `fxOverrideOffered` — `isFxOverrideOffered`'s result, the same boolean that mounts
 * the cloaked control — only adds one plain sentence at the end of the open region
 * telling a holder where the override is. Text, never a button or a link.
 */
function ReportSummary({
  report,
  fxOverrideOffered,
}: {
  report: ReportDetail;
  fxOverrideOffered: boolean;
}) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  const rollup = report.rollup;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  return (
    <section
      aria-label={t('workbench.summaryLabel')}
      data-testid="report-summary"
      className="rounded-md border border-border bg-card px-3 py-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {t('workbench.fxReportTotal')}
        </span>
        <StatusBadge
          {...statusBadgeProps(report.status, t)}
          appearance={report.status === 'DRAFT' ? 'outline' : 'solid'}
        />
      </div>
      <p className="mt-1 font-semibold text-foreground text-xl tabular-nums">
        <span className="mr-1 font-normal text-muted-foreground text-sm">
          {report.currency.code}
        </span>
        {formatMinor(Number(rollup.homeTotalMinor), report.currency, locale)}
      </p>
      {rollup.multiCurrency && (
        <div className="mt-2 border-border border-t pt-2">
          <p className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
            {t('workbench.fxByCurrency')}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {rollup.byCurrency.map((c) => {
              /**
               * The right-hand text, by predicate and IN THIS ORDER. `rate` is `null` in
               * three different cases (packages/money/src/reportRollup.ts): the report's own
               * currency, a currency converted at several snapshotted rates, and a currency
               * with no rate at all. Only the last is "No rate", so it is tested first — a
               * missing group's `rate` is null too. The home row says nothing: there is
               * nothing to convert. Keyed on `rollup.homeCurrency`, never a literal, so a
               * USD report with CAD lines reads the same way.
               */
              const missing = c.convertedMinor === null;
              const note = missing ? (
                <>
                  <IconAlertTriangle size={12} aria-hidden="true" className="shrink-0" />
                  {t('workbench.fxNoRate')}
                </>
              ) : c.code === rollup.homeCurrency ? null : c.rate ? (
                t('workbench.fxRate', { rate: c.rate })
              ) : (
                t('workbench.fxRatesVary')
              );
              return (
                <li
                  key={c.code}
                  className="flex items-baseline justify-between gap-2 text-sm tabular-nums"
                >
                  {/* A currency with no rate is flagged rather than dropped: a total
                      that is not the whole total has to say so where it is read — in
                      words and an icon, never in the warning colour alone. */}
                  <span className={missing ? 'text-warning' : 'text-foreground'}>
                    {c.code}{' '}
                    {formatMinor(Number(c.grossMinor), { code: c.code, symbol: '' }, locale)}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-xs',
                      missing
                        ? 'inline-flex items-center gap-1 text-warning'
                        : 'text-muted-foreground',
                    )}
                  >
                    {note}
                  </span>
                </li>
              );
            })}
          </ul>
          {/* The label is a constant and the state is `aria-expanded`'s, so the visible
              text is the whole accessible name (WCAG 2.5.3). `h-12` clears 44px with no
              hit slop, as the expense-list toggle does. */}
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
            className="mt-1 flex h-12 w-full items-center justify-between gap-2 text-left text-foreground text-sm"
          >
            <span className="min-w-0">{t('workbench.fxDetailsToggle')}</span>
            <IconChevronDown
              size={16}
              aria-hidden="true"
              className={cn(
                'shrink-0 transition-transform motion-reduce:transition-none',
                detailsOpen && 'rotate-180',
              )}
            />
          </button>
          {/* `hidden` rather than unmounted, so the button's `aria-controls` always
              points at something. */}
          <div id={detailsId} className={cn(!detailsOpen && 'hidden')}>
            <SummaryReconciliation report={report} />
            {fxOverrideOffered && (
              <p className="mt-1.5 text-muted-foreground text-xs">
                {t('workbench.fxOverridePhoneNote')}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The reconciliation behind `ReportSummary`'s "Conversion details" disclosure.
 *
 * Each currency's CONVERTED amount, in the report currency — the gross and rate are
 * already in the composition above, so they are not repeated. Then the "Report total"
 * row, which is `rollup.homeTotalMinor` rather than a client-side sum: the roll-up
 * builds that figure from exactly the non-null `convertedMinor` values
 * (packages/money/src/reportRollup.ts), so the rows above it add up to it by
 * construction. A currency with no rate is not in that sum, so its row says
 * "Not included" — in words and an icon, never in the warning colour alone, and never
 * a bare "—", which a screen reader cannot say — and the missing-rate line under the
 * total says the total is not the whole report.
 */
function SummaryReconciliation({ report }: { report: ReportDetail }) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  const rollup = report.rollup;
  return (
    <div className="border-border border-t pt-2 pb-1">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {t('workbench.fxConvertedTo', { home: rollup.homeCurrency })}
      </h3>
      <ul className="mt-1 flex flex-col gap-0.5">
        {rollup.byCurrency.map((c) => (
          <li
            key={c.code}
            className="flex items-baseline justify-between gap-2 text-sm tabular-nums"
          >
            <span className="min-w-0 text-foreground">{c.code}</span>
            {c.convertedMinor === null ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-warning text-xs">
                <IconAlertTriangle size={12} aria-hidden="true" className="shrink-0" />
                {t('workbench.fxNotIncluded')}
              </span>
            ) : (
              <span className="shrink-0 text-foreground">
                {formatMinor(Number(c.convertedMinor), report.currency, locale)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div
        data-testid="report-summary-sum"
        className="mt-1.5 flex items-baseline justify-between gap-2 border-border border-t pt-1.5 font-medium text-foreground text-sm tabular-nums"
      >
        <span>{t('workbench.fxReportTotal')}</span>
        <span className="shrink-0">
          {formatMinor(Number(rollup.homeTotalMinor), report.currency, locale)}
        </span>
      </div>
      {BigInt(rollup.recoverableTotalMinor) !== 0n && (
        <div className="mt-1 flex items-baseline justify-between gap-2 text-xs tabular-nums">
          <span className="min-w-0 text-muted-foreground">{t('workbench.fxRecoverable')}</span>
          <span className="shrink-0 text-foreground">
            {formatMinor(Number(rollup.recoverableTotalMinor), report.currency, locale)}
          </span>
        </div>
      )}
      {rollup.missingRates.length > 0 && (
        <div className="mt-1.5 flex items-start gap-1.5 text-warning text-xs">
          <IconAlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{t('workbench.fxMissingRate', { count: rollup.missingRates.length })}</span>
        </div>
      )}
    </div>
  );
}

export function ExpenseReportWorkbench({
  reportId,
  isSubmitter,
  canEdit,
  canDelete,
  canSubmit,
  canApprove,
  isAcknowledge,
  canReimburse,
  canChase,
  canFxOverride,
  canOpenLedgerQueue,
  taskId,
}: {
  reportId: string;
  /**
   * The viewer filed this report. `expenses.report` does not send `submitterId`, so the
   * page resolves it. Every reader `canViewReport` admits can open this page — a direct
   * manager, an approver, AP — and only the submitter is offered the write controls: the
   * page already folds this into `canEdit` / `canDelete` / `canSubmit`.
   */
  isSubmitter: boolean;
  /** `updateOwn`, for the submitter only (see `isSubmitter`). Cosmetic; the server re-checks. */
  canEdit: boolean;
  /** `deleteDraft`, for the submitter only. */
  canDelete: boolean;
  /** `submitOwn`, for the submitter only — also what offers Recall. */
  canSubmit: boolean;
  /** The caller is an eligible approver of this report (has a decidable task). */
  canApprove: boolean;
  /**
   * The caller's task is an Acknowledge node — one outcome, no reject / return / reassign.
   * The engine refuses anything but an approve on such a task, so offering the other three
   * would be four buttons, three of which fail. Read only in approver mode.
   */
  isAcknowledge: boolean;
  /** `expense.report.reimburse` — the AP clerk's Mark reimbursed. Held without any task on
   *  the report. Cosmetic; `markReimbursed` re-checks the permission and the status. */
  canReimburse: boolean;
  /**
   * The caller may ask the submitter for the missing receipts: not the submitter, and
   * `readAll`, `reimburse` or a decidable task — the check `chaseReceipts` runs, which
   * SKIPS (rather than refuses) a report the caller may not chase. Resolved by the page.
   */
  canChase: boolean;
  /** `expense.report.fxOverride` — gates the per-report FX override (A4). Held by the
   *  finance admins, not by AP: the role that pays and posts a report must not also
   *  restate its amounts. Cosmetic; the mutation re-checks. */
  canFxOverride: boolean;
  /** VeloExpense (d38): `ledger.sync.retry` — may open /admin/ledger-queue, where a post is
   *  retried, released or cancelled. Cosmetic — the queue page re-checks. ExpenseOS's
   *  `canPushNetsuite` (`netsuite.sync.push`) gated a push from here. */
  canOpenLedgerQueue: boolean;
  /** The caller's PENDING task on this report, when they can decide it. */
  taskId?: string;
}) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('expenses');
  const tc = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const utils = trpc.useUtils();

  const query = trpc.expenses.report.useQuery(
    { reportId },
    {
      // Keep polling while anything is being read — by the client's own reading of the
      // rows, or the server's (`extraction.inFlight`, the figure that holds Submit). The
      // second keeps the button from staying disabled after the reading has landed.
      refetchInterval: (q) =>
        hasPendingExtractionIn(q.state.data?.expenses) ||
        (q.state.data?.extraction.inFlight ?? 0) > 0
          ? 4000
          : false,
    },
  );
  const report = query.data;
  const catsQuery = trpc.expenses.categories.useQuery();
  const categoryItems = useMemo(
    () =>
      (catsQuery.data ?? []).map((c) => ({
        value: c.id,
        label: localeLabel(c.label, locale),
        // The category's own glyph, so a picked category looks like the one that
        // was picked rather than a plainer text-only entry.
        icon: c.icon ?? undefined,
        isMileage: c.isMileage,
        // Drives which line-kind STRATEGY a row uses (see _workbench/lineKinds.tsx).
        acceptsTip: c.acceptsTip,
      })),
    [catsQuery.data, locale],
  );

  const invalidate = useCallback(() => {
    utils.expenses.report.invalidate({ reportId });
    utils.expenses.list.invalidate();
    // VeloExpense (d37): the discussion carries the report's events and the reasons given
    // for them, so a submit, recall or decision made here shows in it without a reload.
    utils.comments.thread.invalidate({ subjectType: 'EXPENSE_REPORT', subjectId: reportId });
  }, [utils, reportId]);

  /**
   * Re-ask `expenses.report` — SEC-4's half of the receipt sheet.
   *
   * `refetch` rather than `invalidate` so it fires whatever `staleTime` says: the
   * 30s window and `refetchOnWindowFocus: false` were calibrated for a desktop tab,
   * and the case this exists for is an installed app returning from the background
   * after an hour with a sheet open over a presigned URL that has since expired.
   *
   * Stable, because `ReceiptPane` subscribes to `visibilitychange` on it — an identity
   * that changed every render would tear the listener down and set it up again on
   * every poll.
   */
  const refetchReport = useCallback(() => {
    void utils.expenses.report.refetch({ reportId });
  }, [utils, reportId]);

  const isDraft = report?.status === 'DRAFT';
  const isSubmitted = report?.status === 'SUBMITTED';
  const canEditStatus = isDraft || report?.status === 'RETURNED';
  const editable = canEdit && canEditStatus;

  const updateReport = trpc.expenses.updateReport.useMutation({ onSuccess: invalidate });
  const validate = trpc.expenses.validate.useMutation({ onSuccess: invalidate });
  // On-the-fly policy check: an edit recomputes violations server-side then
  // refetches. Falls back to a plain refetch once the report is not editable.
  const refusalText = useRefusalText();
  const receiptMove = trpc.expenses.receiptMove.useMutation();
  /**
   * Cross-expense document pairs that look like one charge. Derived server-side from
   * extractions already stored — no model call, so refetching is cheap and the answer
   * can never be stale.
   */
  const grouping = trpc.expenses.receiptGroupingSuggestions.useQuery(
    { reportId },
    { enabled: canEdit },
  );
  /**
   * Pairs answered "separate charges" during THIS submit attempt.
   *
   * Nothing is written, because nothing needs writing: the documents already sit on
   * separate expenses, which is exactly what the answer means. Held here so the
   * question stops blocking the submit in front of the user, and asked again after a
   * reload — a pre-flight check rather than a nag.
   */
  const [keptApart, setKeptApart] = useState<Set<string>>(new Set());
  const revalidate = useCallback(() => {
    if (canEdit && (report?.status === 'DRAFT' || report?.status === 'RETURNED')) {
      validate.mutate({ reportId });
    } else {
      invalidate();
    }
  }, [reportId, invalidate, validate, canEdit, report?.status]);
  /**
   * Move a receipt to another expense on this report — the one path behind both the
   * drag-and-drop and the per-row select.
   *
   * The selection follows the receipt. Moving the LAST document off an expense
   * deletes it server-side, so leaving `selectedId` pointing at it would blank the
   * editor; and even when it survives, the file the user just moved is now in the
   * other expense's pane, so following it is what they meant.
   */
  const moveReceipt = useCallback(
    (receiptId: string, toExpenseId: string) => {
      receiptMove.mutate(
        { id: receiptId, toExpenseId },
        {
          onSuccess: () => {
            setSelectedId(toExpenseId);
            revalidate();
          },
          onError: (e) => setSubmitError(refusalText(e, e.message)),
        },
      );
    },
    [receiptMove, revalidate, refusalText],
  );

  /**
   * After an approver's action has landed: back to the queue it came from.
   *
   * The report has nothing left for this person to do — the task is decided, handed on,
   * or the report is paid — so staying would leave them on an actionless page. The four
   * queue reads are the ones the approvals inbox refreshes after a drawer decision; the
   * report itself is marked stale too, so coming back to it reads the new status.
   *
   * `replace`, not `push`: Back from the queue must not land on the decided workbench.
   * The locale-aware router (see the import), so a fr-CA approver stays in fr-CA.
   *
   * Only ever wired to `onSuccess`. A refusal — the classic one is a pooled task another
   * approver decided first — leaves the person here with the reason on screen.
   */
  const returnToQueue = useCallback(() => {
    void utils.expenseApprovals.myTasks.invalidate();
    void utils.expenseApprovals.myDecided.invalidate();
    void utils.expenseApprovals.myTeam.invalidate();
    void utils.expenses.list.invalidate();
    void utils.expenses.report.invalidate({ reportId });
    router.replace('/expenses/approvals');
  }, [utils, reportId, router]);

  const submit = trpc.expenses.submit.useMutation();
  // Recall is the SUBMITTER's, and they stay on their own report: it refreshes in place.
  const recall = trpc.expenses.recall.useMutation({ onSuccess: invalidate });
  const decide = trpc.expenseApprovals.decide.useMutation({
    onSuccess: returnToQueue,
    onError: (e) => setSubmitError(refusalText(e, e.message)),
  });
  const returnForEdit = trpc.expenseApprovals.returnForEdit.useMutation({
    onSuccess: returnToQueue,
    onError: (e) => setSubmitError(refusalText(e, e.message)),
  });
  const reassign = trpc.expenseApprovals.reassign.useMutation({
    onSuccess: () => {
      setDecideMode('idle');
      setReassignTo(null);
      setReassignItem(null);
      // VeloExpense (d37): and the reason that went with it.
      setDecideNote('');
      returnToQueue();
    },
    onError: (e) => setSubmitError(refusalText(e, e.message)),
  });
  // VeloExpense: no `markReimbursed` (d71) — reimbursing is VeloExpense's reimbursement
  // screen's, as on the approver drawer.
  /**
   * Request receipts — the one approver action that does NOT leave the page. Asking for
   * the receipts is what an approver does BEFORE deciding, so they stay, and the outcome
   * is said where the errors are said (the top bar's centre). Same copy as the drawer:
   * `chaseNone` when the server chased nothing (every expense already had a receipt, or
   * the report was not one this caller may chase), `chaseSent` otherwise.
   */
  const [chaseNote, setChaseNote] = useState<string | null>(null);
  const chase = trpc.expenseApprovals.chaseReceipts.useMutation({
    onSuccess: (r) => {
      setSubmitError(null);
      setChaseNote(
        r.reports === 0 ? t('drawer.chaseNone') : t('drawer.chaseSent', { count: r.expenses }),
      );
    },
    onError: (e) => {
      setChaseNote(null);
      setSubmitError(refusalText(e, e.message));
    },
  });
  const remove = trpc.expenses.deleteReport.useMutation({
    onSuccess: () => {
      utils.expenses.list.invalidate();
      router.push('/expenses');
    },
  });
  const deleteExpenses = trpc.expenses.deleteExpenses.useMutation({
    onSuccess: () => {
      setChecked(new Set());
      revalidate();
    },
  });

  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * The REASON a submission was refused, as a string.
   *
   * Named `submitRefusal` because `submitBlocked` is already taken, by a boolean that
   * disables the button when the report is not submittable YET. The two are genuinely
   * different: that one is "you cannot press this", this one is "you pressed it and here
   * is what came back".
   *
   * Separate from `submitError` too, which is shared with the approver's own actions and
   * belongs in the top bar.
   *
   * Kept apart because the two need different treatment: an approver's "task already
   * decided" is a one-line correction, while a submitter needs the reason AND the list of
   * things to fix, and needs it where they cannot scroll past it.
   */
  const [submitRefusal, setSubmitRefusal] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** `?expense=<id>` — which line the caller wants open. See the effect below. */
  const requestedExpenseId = useSearchParams().get('expense');
  // Multi-select for the expense-list group action (bulk delete).
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Approver decide flow: 'idle', or a reject/return/reassign popover is open.
  const [decideMode, setDecideMode] = useState<'idle' | DecidePanel>('idle');
  const [decideNote, setDecideNote] = useState('');
  /**
   * Which currency the header total is READ in. Null = the report's own.
   *
   * Presentation only, and deliberately not persisted: a report is filed and posted in its
   * own currency, and a reader's viewing preference is not a property of the claim.
   */
  const [viewCurrency, setViewCurrency] = useState<string | null>(null);
  // Reassign flow: the picked target user (id + label item for the combobox).
  const [reassignTo, setReassignTo] = useState<string | null>(null);
  const [reassignItem, setReassignItem] = useState<ComboboxItem | null>(null);

  // VeloExpense: memoised, so the `[]` fallback is one array rather than a new one per render —
  // which every hook below that depends on `expenses` would otherwise see as a change
  // (react-hooks/exhaustive-deps; ExpenseOS's Biome does not check this).
  const expenses = useMemo(() => report?.expenses ?? [], [report?.expenses]);
  useEffect(() => {
    if (expenses.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((cur) =>
      nextSelectedExpenseId({
        current: cur,
        expenseIds: expenses.map((e) => e.id),
        requested: requestedExpenseId,
      }),
    );
  }, [expenses, requestedExpenseId]);
  // Drop checked ids that vanished (deleted/refetched) or clear when the report
  // is no longer editable (selection only makes sense while editing).
  useEffect(() => {
    setChecked((prev) => {
      if (!editable) return prev.size ? new Set() : prev;
      const next = new Set([...prev].filter((id) => expenses.some((e) => e.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [expenses, editable]);
  const toggleChecked = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const bulkDelete = () => {
    if (checked.size === 0) return;
    if (!window.confirm(t('drawer.confirmDeleteExpenses', { count: checked.size }))) return;
    deleteExpenses.mutate({ ids: [...checked] });
  };
  const bulkActions =
    checked.size > 0
      ? [
          {
            id: 'delete',
            label: t('drawer.deleteSelected', { count: checked.size }),
            onSelect: bulkDelete,
            icon: <IconTrash size={14} className="text-destructive/80" />,
            destructive: true,
          },
        ]
      : [];
  const selected = expenses.find((e) => e.id === selectedId) ?? null;
  /**
   * Where a receipt on the selected expense could go: every OTHER expense on the
   * report, labelled the way the left pane labels them so the two agree.
   *
   * Merchant first because that is what someone is matching against; the date
   * disambiguates two visits to the same place, which is exactly the case where
   * moving a receipt by hand is needed.
   */
  const moveTargets = useMemo(
    () =>
      expenses
        .filter((e) => e.id !== selected?.id)
        .map((e) => ({
          id: e.id,
          // VeloExpense: an expense may have no date yet — a dash, as /expenses/all shows it.
          label: `${e.merchant?.trim() || t('drawer.untitledExpense')} · ${
            e.date
              ? new Date(e.date).toLocaleDateString(locale, {
                  month: 'short',
                  day: 'numeric',
                  timeZone: 'UTC',
                })
              : '—'
          }`,
        })),
    [expenses, selected?.id, locale, t],
  );
  const { editorLocked, viewerLocked } = receiptLockState(selected, false);

  // Receipt-first capture directly on the report: new expense per file →
  // upload → attach → extract.
  const uploadUrl = trpc.expenses.receiptUploadUrl.useMutation();
  const receiptCreate = trpc.expenses.receiptCreate.useMutation();
  const startExtraction = trpc.expenses.startExtraction.useMutation();
  const [uploadBusy, setUploadBusy] = useState(false);

  /**
   * Is the primary pointer a finger? Read to decide what to RENDER — the second
   * control, and the wording that only makes sense once it exists.
   *
   * Both entry points on this page read the same hook, which is one shared
   * `MediaQueryList` and one `change` listener rather than one per call site;
   * that is what `@/lib/useCoarsePointer` is a module-level store for.
   */
  const coarsePointer = useCoarsePointer();
  /**
   * Below Tailwind's `lg` the report chrome relocates out of the rationed
   * TopBar slot and into the body. `false` on the server and on the hydration
   * render, which is today's DOM exactly as it stands.
   */
  const isBelowLg = useIsBelowLg();
  /**
   * Is the receipt sheet open? Below `lg` the receipt pane is a bottom sheet
   * (see `ReceiptPane`), opened from the paperclip on an expense row.
   *
   * The state lives here rather than in either component because the trigger and
   * the sheet are in two different panes, and because the keyboard handler below
   * has to know: ↓ / j with the sheet open would swap the sheet's contents out
   * from under whoever is reading it.
   */
  const [receiptSheetOpen, setReceiptSheetOpen] = useState(false);
  /**
   * Is the expense LIST expanded? Below `lg` only; above it the list is always
   * open and this value is never read.
   *
   * COLLAPSED BY DEFAULT, and that is the point of it. Below `lg` the three
   * panes stack, so the expense list sits between the reader and the editor of
   * the expense they just picked: choosing a row scrolled the thing they chose
   * off the bottom of a 664px screen, under a list they were done with. Closing
   * the list on selection makes the editor what the reader sees, and opening
   * the report shows the summary, the action bar and the blockers first —
   * which is the review order — with the list one tap away.
   *
   * WHY THE STATE IS HERE AND THE SUPPRESSION IS CSS. The header TOGGLE is a
   * relocation — below `lg` the pane's title becomes a disclosure control, and
   * both faces in the DOM would put "Expenses" in the accessibility tree twice
   * — so it is selected in JS, like the rest of the relocated chrome. The LIST
   * ITSELF is only suppressed, so it stays mounted and takes a `hidden` class:
   * unmounting it would drop the rows' checkboxes out of the tree on a desktop
   * resize across 1024px, and a reader who did nothing but widen a window would
   * find the pane's multi-select gone. `checked` lives in this component for
   * the same reason, so the two agree.
   */
  const [expensesListOpen, setExpensesListOpen] = useState(false);
  /**
   * Select an expense, and get out of the way.
   *
   * Every list-row tap goes through here rather than through `setSelectedId`
   * directly, so the collapse cannot be forgotten at one of the two row
   * affordances — and so does a created expense (`createExpense` below), since
   * a reader who opened the list and then tapped "+" wants the new row's editor,
   * not the list they were done with. Unconditional: above `lg`
   * `expensesListOpen` is not read at all, and a phone reader arriving from a
   * desktop resize finds the list in its default state rather than in a stale one.
   */
  const selectFromList = useCallback((id: string) => {
    setSelectedId(id);
    setExpensesListOpen(false);
  }, []);
  /**
   * Declared after `selectFromList` so that what it calls already exists when a
   * reader gets here. `onSuccess` fires for the receipt-upload path too (it creates
   * through `mutateAsync`, once per file); closing the list there is harmless and
   * the scroll below is NOT wired here, for exactly that reason.
   */
  const createExpense = trpc.expenses.createExpense.useMutation({
    onSuccess: (created) => {
      if (created && typeof created === 'object' && 'id' in created) {
        selectFromList((created as { id: string }).id);
      }
      invalidate();
    },
  });

  /**
   * "Add expense" on a phone lands the reader ON the new row's editor.
   *
   * Below `lg` the panes stack, and closing the list is not enough: the editor still
   * starts under the summary, the action bar and the blockers, so on a 664px screen
   * the thing the reader just created can be below the fold. After a successful add,
   * on a phone only, the centre pane is scrolled to the top of the viewport —
   * instantly, because a smooth scroll on a tap that already waited a round trip reads
   * as lag — and the focus moves to the pane itself (`preventScroll`, so the focus does
   * not scroll it a second time). NOT to the Vendor input: a programmatic focus after
   * an async response does not open the iOS keyboard, and a focused field that shows no
   * keyboard reads as broken.
   *
   * WHY A PENDING ID AND NOT A FLAG ON SELECTION. The new row is not in `expenses`
   * until the `invalidate()` refetch lands, so `selected` is `null` for a beat after
   * the select. The effect waits — returns early, keeps the id — until the row the add
   * returned is the one rendered, scrolls once, and clears it. No retry, no timer. If a
   * DIFFERENT expense ends up selected first (a reader tap, or an unrelated refetch that
   * reset the selection), the id is dropped instead: otherwise it would lie in wait and
   * scroll on some later tap of that row, which is not an add.
   *
   * WHY `scrollTick`. `createExpense` reuses a blank expense already on the report
   * (`expenses.ts`, "Don't pile up blank entries"), so a second "+" can return the id
   * that is ALREADY selected. Neither `selected?.id` nor the refetched list need change,
   * and an effect keyed on those alone would never fire. The tick is a state set, so
   * the effect runs on every successful add.
   *
   * WHY A REF FOR THE DEVICE. `isBelowLgRef` mirrors `isBelowLg` for the callbacks and
   * the effect to read — the returned tree reads nothing from it, so this is not a
   * render branch, and desktop renders exactly the boxes it always did. A ref rather
   * than the render-time value because the add's `onSuccess` runs a round trip after
   * the tap: a window widened in between should not be scrolled as a phone.
   *
   * Set at the button's own call site, never in the hook's `onSuccess`: the receipt
   * upload creates through the same mutation, and a reader who just filed a photo is
   * not asking to be moved.
   */
  const editorPaneRef = useRef<HTMLElement>(null);
  const pendingScrollId = useRef<string | null>(null);
  const isBelowLgRef = useRef(isBelowLg);
  const [scrollTick, setScrollTick] = useState(0);
  useLayoutEffect(() => {
    isBelowLgRef.current = isBelowLg;
  }, [isBelowLg]);
  const selectedIdForScroll = selected?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scrollTick` is the trigger, not a value read — see "WHY `scrollTick`" above.
  useLayoutEffect(() => {
    const id = pendingScrollId.current;
    if (!id) return;
    if (selectedIdForScroll !== id) {
      // `null` is "the refetch has not landed yet" — keep waiting. Anything else wins.
      if (selectedIdForScroll !== null) pendingScrollId.current = null;
      return;
    }
    pendingScrollId.current = null;
    if (!isBelowLgRef.current) return;
    const pane = editorPaneRef.current;
    if (!pane) return;
    pane.scrollIntoView({ block: 'start', behavior: 'auto' });
    pane.focus({ preventScroll: true });
  }, [selectedIdForScroll, scrollTick]);
  const addExpense = () =>
    createExpense.mutate(
      { reportId },
      {
        onSuccess: (created) => {
          if (!isBelowLgRef.current) return;
          if (!created || typeof created !== 'object' || !('id' in created)) return;
          pendingScrollId.current = (created as { id: string }).id;
          setScrollTick((n) => n + 1);
        },
      },
    );

  /**
   * An upload is running AND there are two controls to silence.
   *
   * Gated on the pointer, not on `uploadBusy` alone, and that is the whole
   * point: at a fine pointer the busy state stays exactly what it has always
   * been — `disabled` on the one input, the label untouched. The relabel and
   * the dimming exist to answer "why did nothing happen when I tapped the
   * other one", and on a desktop there is no other one.
   */
  const captureBusy = coarsePointer && uploadBusy;

  /**
   * What a picker control's label SAYS right now — visibly on a desktop, and
   * from an `sr-only` span on a phone, where the words are still the accessible
   * name but no longer on screen. Three states, and the middle one is the easy
   * one to miss.
   *
   * Alone (a desktop), it keeps the wording it has always had — a lone control
   * is not a choice between sources, and "Choose file" would be answering a
   * question nobody asked. Beside the camera it becomes `capture.chooseFile`,
   * so the pair reads as two SOURCES rather than one source and one outcome,
   * which is the iOS/Android convention and the only wording that makes the
   * camera's missing library choice legible. Busy, both controls read the
   * drawer's existing "Uploading…" rather than a third translation of it.
   *
   * `alone` arrives RESOLVED, never as a catalog key. `packages/i18n/scripts/
   * check-used-keys.mjs` reads string-literal translation calls only, so taking
   * a key here and resolving it from a variable would quietly drop
   * `handoff.action` and `inbox.uploadReceipt` out of the CI coverage gate. The
   * gate is literal enough that this paragraph cannot spell the pattern out in
   * real call syntax either — it did at first, and the scanner dutifully went
   * looking for a catalog key named `literal`.
   */
  function pickerLabel(alone: string): string {
    if (captureBusy) return t('drawer.uploading');
    if (coarsePointer) return t('capture.chooseFile');
    return alone;
  }

  /**
   * A picker control's children: its icon and its label.
   *
   * On a coarse pointer the label is still the label — it just stops being
   * visible. It moves into an `sr-only` span, which is where the control's
   * accessible name comes from and the only place it comes from: one string,
   * one translation, and voice control ("tap Choose file") matches what a
   * sighted user is told the icon means. NOT `aria-label` — on a `<label>`
   * element it does nothing useful, and on the input it would shadow the
   * visible text a desktop still has.
   *
   * `alone` arrives RESOLVED, as `pickerLabel` above requires and for the same
   * reason: a catalog key passed through a variable drops out of the CI
   * coverage gate.
   */
  const pickerChildren = (alone: string) =>
    coarsePointer ? (
      <>
        <IconPaperclip size={18} aria-hidden="true" />
        <span className="sr-only">{pickerLabel(alone)}</span>
      </>
    ) : (
      <>
        <IconPaperclip size={14} />
        {pickerLabel(alone)}
      </>
    );

  /**
   * The camera control, identical at both of this page's entry points bar its
   * treatment — and icon-only, because it only ever exists on a coarse pointer
   * and every coarse-pointer upload control on this page is now icon-only.
   */
  const cameraControl = (className: string) => ({
    className,
    'aria-disabled': captureBusy || undefined,
    children: (
      <>
        <IconCamera size={18} aria-hidden="true" />
        <span className="sr-only">
          {captureBusy ? t('drawer.uploading') : t('capture.takePhoto')}
        </span>
      </>
    ),
  });

  /**
   * Arrived from `?upload=1` — an MCP client created this report and could not upload the
   * files itself, so the person was handed a link instead.
   *
   * The banner exists because the page alone explains nothing: a report of blank expenses
   * looks like a bug rather than an invitation. It is dismissed by uploading, or by hand.
   *
   * **The file picker is deliberately NOT opened automatically.** `input.click()` from an
   * effect has no transient user activation, so Chrome and Safari block or warn — it would
   * work in dev and silently fail for somebody. The banner's own button IS the activation.
   */
  const uploadLink = useDeepLink('upload');
  const [showUploadPrompt, setShowUploadPrompt] = useState(false);
  useEffect(() => {
    if (!uploadLink.id || !uploadLink.key || uploadLink.wasSeen(uploadLink.key)) return;
    uploadLink.markSeen(uploadLink.key);
    setShowUploadPrompt(true);
    // Tidy the address bar, so a reload or a copied link is not a second prompt.
    uploadLink.clear();
  }, [uploadLink]);

  async function uploadReceipts(files: FileList) {
    setSubmitError(null);
    setUploadBusy(true);
    let lastId: string | null = null;
    try {
      for (const file of Array.from(files)) {
        const created = await createExpense.mutateAsync({ reportId });
        if (!created || !('id' in created)) continue;
        const expenseId = created.id;
        lastId = expenseId;
        const contentType = file.type || 'application/octet-stream';
        const { url, headers, key } = await uploadUrl.mutateAsync({
          expenseId,
          filename: file.name,
          contentType,
          // The link is bound to this exact length, so it must be the body PUT below.
          sizeBytes: file.size,
        });
        const put = await fetch(url, { method: 'PUT', headers, body: file });
        if (!put.ok) throw new Error(t('drawer.uploadFailed'));
        const { id } = await receiptCreate.mutateAsync({
          expenseId,
          key,
          filename: file.name,
          contentType,
          sizeBytes: file.size,
          deferExtraction: true,
        });
        await startExtraction.mutateAsync({ receiptIds: [id] });
      }
      invalidate();
      if (lastId) setSelectedId(lastId);
      // Answered: the receipts are filed, so the prompt has served its purpose.
      setShowUploadPrompt(false);
    } catch (err) {
      setSubmitError(refusalText(err, t('drawer.uploadFailed')));
      invalidate();
    } finally {
      setUploadBusy(false);
    }
  }

  /**
   * Keyboard nav over the expense list (↑/↓ or j/k), unless typing in a field.
   *
   * SUSPENDED WHILE THE RECEIPT SHEET IS OPEN, AND ONLY BELOW `lg`. The exemption
   * list below is about text entry — it asks "is this keystroke meant for a
   * field" — and it has no answer for "is this keystroke meant for the thing on
   * top". With the sheet open, its own body holds the focus and nothing in it is
   * an INPUT, so ↓ reached this handler, moved the selection, and changed the
   * receipt the reader was looking at without touching the sheet they thought
   * they were in. The sheet is modal; while it is up, the list underneath does
   * not take arrow keys. Esc still closes it, which is the primitive's own
   * behaviour.
   *
   * `isBelowLg &&` is load-bearing and its absence was a dead-keyboard bug. The
   * sheet only EXISTS below `lg`: at `lg` and up `ReceiptPane` renders the third
   * pane and the sheet is never mounted, so its Close never fires and nothing
   * else clears the flag. A reader who opened the sheet on a phone-width window
   * and then widened it past 1024px got a page with no sheet, no way to close
   * one, and ↑/↓/j/k dead for the rest of the session. Two halves fix it: this
   * condition, so a desktop never suspends on a flag it cannot clear, and the
   * effect below, so the flag does not survive the widening either. Either half
   * alone leaves a live wrong state behind.
   */
  useEffect(() => {
    if (expenses.length === 0) return;
    if (isBelowLg && receiptSheetOpen) return;
    function onKey(ev: KeyboardEvent) {
      const el = ev.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      const down = ev.key === 'ArrowDown' || ev.key === 'j';
      const up = ev.key === 'ArrowUp' || ev.key === 'k';
      if (!down && !up) return;
      ev.preventDefault();
      setSelectedId((cur) => {
        const idx = Math.max(
          0,
          expenses.findIndex((e) => e.id === cur),
        );
        const next = down ? Math.min(expenses.length - 1, idx + 1) : Math.max(0, idx - 1);
        return expenses[next].id;
      });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expenses, receiptSheetOpen, isBelowLg]);

  /**
   * A sheet that stopped existing is not a sheet that is open.
   *
   * `ReceiptPane` renders the bottom sheet below `lg` and the third pane above
   * it, so widening past 1024px unmounts the sheet without its `onOpenChange`
   * ever firing — leaving `receiptSheetOpen` true with nothing on screen to
   * close. The flag is read by the keyboard handler above and handed back to
   * `ReceiptPane` as `sheetOpen`, so a stale `true` would also re-open the sheet
   * the moment the window narrowed again, on an expense the reader may have
   * moved on from.
   */
  useEffect(() => {
    if (!isBelowLg) setReceiptSheetOpen(false);
  }, [isBelowLg]);

  // When a receipt's extraction settles (it just populated an expense's lines),
  // the report's violations are stale until the next manual edit — recompute
  // once automatically as extraction transitions pending → done.
  const prevPending = useRef(false);
  useEffect(() => {
    const pending = hasPendingExtractionIn(report?.expenses);
    if (
      prevPending.current &&
      !pending &&
      canEdit &&
      (report?.status === 'DRAFT' || report?.status === 'RETURNED')
    ) {
      validate.mutate({ reportId });
    }
    prevPending.current = pending;
  }, [report?.expenses, report?.status, canEdit, reportId, validate]);

  async function onSubmit() {
    setSubmitError(null);
    setSubmitRefusal(null);
    try {
      await submit.mutateAsync({ reportId });
      invalidate();
    } catch (err) {
      invalidate();
      const reason = refusalText(err, t('drawer.submitFailed'));
      setSubmitError(reason);
      setSubmitRefusal(reason);
    }
  }

  /**
   * Unresolved violations, DEDUPED by (expenseId, message): two line items in one expense
   * over the same limit read as one issue, not as a duplicate.
   *
   * EVERY count on this screen is derived from this one list, and that is the fix. There
   * used to be two rules for the same idea — the banner and the submit gate counted RAW
   * violations while the row badge and the hover list counted deduped ones — so the same
   * report said "×3" in one place and "2" in two others, on screen, at once (GA readiness
   * report F11). The engine is not producing duplicate rows: `validate` deletes every
   * violation for the report and re-inserts inside one transaction, locking the report
   * row first so two overlapping validates from this screen (one per edit, one when
   * extraction settles) cannot both insert. What differed was the arithmetic on top of it.
   */
  const unresolved = useMemo(() => {
    const seen = new Set<string>();
    const out: ReportDetail['violations'] = [];
    for (const v of report?.violations ?? []) {
      if (v.severity !== 'BLOCK' && !(v.severity === 'WARNING' && !v.resolvedAt)) continue;
      const key = `${v.expenseId ?? ''}|${v.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }, [report?.violations]);

  const blocking = unresolved.filter((v) => v.severity === 'BLOCK').length;
  const unjustifiedWarnings = unresolved.filter(
    (v) => v.severity === 'WARNING' && !v.resolvedAt,
  ).length;
  /** VeloExpense (d39): the unanswered warnings about the whole report (no expense). */
  const reportWarnings = unresolved.filter(
    (v) => v.severity === 'WARNING' && !v.resolvedAt && !v.expenseId,
  );
  // A report needs at least one expense to be submitted (server-enforced too).
  const hasNoExpenses = (report?.expenses ?? []).length === 0;
  // Unanswered pairs block submission. An unresolved pair is the same charge on two
  // expenses, each carrying the full total — an over-claim, and the one error the
  // approver has no way to spot: both entries look perfectly well-formed.
  const openSuggestions = (grouping.data?.items ?? []).filter(
    (s) => !keptApart.has(suggestionKey(s)),
  );
  /**
   * One blank expense is not a report. Having AN expense was the only quantity check, so
   * adding one and typing nothing enabled Submit at $0.00 — and it went the whole way:
   * EXP-000006 sits on DEV at $0.00 with status Approved (F08). Server-enforced too.
   */
  // Gated on the ROLL-UP total, which is the figure rendered in the top bar — so the
  // button agrees with the number the person is looking at. The server checks the stored
  // `totalMinor`, which `recomputeReportTotal` derives from the same roll-up.
  const hasNoValue = !hasNoExpenses && BigInt(report?.rollup?.homeTotalMinor ?? '0') <= 0n;
  /**
   * Expenses NetSuite would refuse for missing coding.
   *
   * The server has refused an uncoded report at submit since #390 — but only after the
   * press, and its sentence names the missing DIMENSIONS, not which expense to open. A
   * submitter with eleven lines was told "department, class" and left to find them.
   *
   * `report.coding` comes from `codingGaps`, the same function the refusal and the poster
   * use, so this cannot disagree with what happens on the press. It is empty when NetSuite
   * is not installed — the requirement is NetSuite's, and blocking a submission without it
   * would invent a rule out of an absent integration.
   */
  const uncodedIds = new Set(report?.coding?.uncodedExpenseIds ?? []);
  const uncodedExpenses = expenses.filter((e) => uncodedIds.has(e.id));
  /**
   * Categories NetSuite cannot resolve (`categoryGaps`, the rule `submit` refuses on).
   *
   * A separate list from `uncodedExpenses` on purpose: that one drives the dimensions
   * banner, whose fixer is the submitter. A category is fixed by an administrator, so it
   * gets its own banner and its own Submit reason, and a report with only a category
   * problem never tells the submitter to allocate. Absent-safe: an older payload without
   * the field blocks nothing.
   */
  const categoryProblems = report?.coding?.categoryProblems ?? [];
  const categoryAffectedCount = report?.coding?.categoryAffectedExpenseIds?.length ?? 0;
  /**
   * The name each problem category is shown under, in the READER's language.
   *
   * `categoryLabel` from the server is always English, and on purpose: the same value
   * feeds the English posting and submit refusals. Every problem category sits on one of
   * this report's line items, and those carry the bilingual label object, so the banner
   * reads it from there. `categoryLabel` stays the fallback for a category not found on
   * any line item.
   */
  const categoryLabelById = new Map<string, unknown>();
  for (const e of expenses) {
    for (const li of e.lineItems) {
      if (li.category) categoryLabelById.set(li.category.id, li.category.label);
    }
  }
  const problemCategoryName = (p: (typeof categoryProblems)[number]) =>
    localeLabel(categoryLabelById.get(p.categoryId), locale) || p.categoryLabel;
  const expenseById = new Map(expenses.map((e) => [e.id, e]));
  /**
   * Receipts still being read. A late reading rewrites the amounts, and it used to do so
   * on a report the approver had already seen; the submit now waits for it. The count is
   * the server's (`summarizeExtractionProgress`, the rule `submit` refuses on), so the
   * button and the refusal cannot disagree — the page polls every 4 s while it is non-zero,
   * so the button re-enables on its own. `stale` is the reading the worker abandoned: it no
   * longer holds the report, and the panel below says its amounts were never read.
   */
  const extractionInFlight = report?.extraction.inFlight ?? 0;
  const extractionStale = report?.extraction.stale ?? 0;
  const submitBlocked =
    blocking > 0 ||
    unjustifiedWarnings > 0 ||
    hasNoExpenses ||
    hasNoValue ||
    uncodedExpenses.length > 0 ||
    categoryAffectedCount > 0 ||
    openSuggestions.length > 0 ||
    extractionInFlight > 0;

  /**
   * Why Submit is disabled, as a sentence — ONE derivation, two renderings.
   *
   * It used to be a three-arm ternary inlined into the button's `title=`, which
   * is a hover tooltip: on a phone that is a greyed button and no sentence, and
   * a disabled control whose explanation exists only on hover reads as a broken
   * app. The desktop row still renders it as `title=`; the phone bar renders it
   * as text beneath the button.
   *
   * EVERY arm of `submitBlocked` has a sentence now — three of them did not,
   * so a report blocked only by violations, only by unjustified warnings, or
   * only by an unanswered duplicate pair produced no explanation at all, at any
   * width. The first three arms keep the order and the exact strings they had,
   * so the desktop tooltip answers today's cases with today's words.
   *
   * The extraction arm is `submitBlocked`'s seventh and it keeps the position and
   * the exact string the desktop tooltip gave it (#509): a receipt still being
   * read blocks Submit before coding does, so it answers before the coding arm.
   *
   * The violations arm NAMES the block rather than listing it. The list is a
   * fifth banner in the body's existing stack and it is a separate piece of
   * work; a sentence saying violations are what stands in the way is what this
   * change owes.
   */
  const submitReason = !submitBlocked
    ? undefined
    : hasNoExpenses
      ? t('drawer.expenseRequired')
      : hasNoValue
        ? t('drawer.amountRequired')
        : extractionInFlight > 0
          ? t('workbench.extractionPendingTitle', { count: extractionInFlight })
          : uncodedExpenses.length > 0
            ? t('workbench.codingRequiredTitle')
            : categoryAffectedCount > 0
              ? t('workbench.categoryProblemTitle')
              : blocking > 0
                ? t('workbench.submitBlockedViolations', { count: blocking })
                : unjustifiedWarnings > 0
                  ? t('workbench.submitBlockedWarnings', { count: unjustifiedWarnings })
                  : openSuggestions.length > 0
                    ? t('workbench.submitBlockedDuplicates', { count: openSuggestions.length })
                    : undefined;

  const approverMode = isSubmitted && canApprove && Boolean(taskId);
  const decidePending = decide.isPending || returnForEdit.isPending;
  /** The expenses with no receipt at all — what Request receipts asks for, all at once,
   *  exactly as the drawer does. */
  const receiptlessIds = expenses.filter((e) => e.receipts.length === 0).map((e) => e.id);

  // Deduped unresolved-violation count per expense — drives the list-row badge.
  const violationCountByExpense = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of unresolved) if (v.expenseId) m.set(v.expenseId, (m.get(v.expenseId) ?? 0) + 1);
    return m;
  }, [unresolved]);
  /**
   * Unresolved violations, grouped by expense — ONE derivation, two renderings.
   *
   * The desktop hover list has always read this; the phone banner below reads the
   * same array rather than re-deriving it, because two groupings of one list is how
   * the counts on this page disagreed with each other in the first place.
   *
   * `expenseId` is carried on the group now. It is not a new derivation — it is the
   * key the map was already built on, kept instead of discarded — and it is what lets
   * the banner's rows be `<button>`s that open the expense they name, which is the
   * whole point of the banner. `null` means a REPORT-level violation, which belongs to
   * no expense and therefore gets prose rather than a link.
   */
  /** VeloExpense (d39): one finding's catalogued label, as `violationGroups` builds it. */
  const violationLabel = (v: (typeof unresolved)[number]): string => {
    const lk = `policy.labels.${v.message}`;
    try {
      return t.has(lk as never) ? t(lk as never, violationValues(v, locale) as never) : v.message;
    } catch {
      return v.message;
    }
  };
  const violationGroups = useMemo(() => {
    const groups = new Map<
      string,
      { expenseId: string | null; merchant: string; labels: string[] }
    >();
    for (const v of unresolved) {
      const key = v.expenseId ?? 'report';
      const exp = expenses.find((e) => e.id === v.expenseId);
      const merchant = exp?.merchant?.trim() || t('line.noMerchant');
      const lk = `policy.labels.${v.message}`;
      /**
       * The VALUES matter, and their absence used to take the whole page down.
       *
       * Six of these labels carry an ICU placeholder — "Receipt expected over
       * {threshold}" and friends. Calling `t()` without them makes next-intl throw
       * FORMATTING_ERROR, and this runs inside a `useMemo` during render, so the throw
       * escaped as a render error and the report became unopenable. Not a bad label: a
       * blank screen, on the one page the person was trying to fix the violation from.
       *
       * `ViolationLine` in `_workbench/parts.tsx` had it right all along and this copy
       * of the same three lines did not, which is the whole argument for sharing the
       * helper rather than the pattern.
       *
       * The try/catch stays regardless. A label whose payload is missing should render
       * its own key — visibly wrong, and fixable — rather than deny access to the report.
       */
      let label: string;
      try {
        label = t.has(lk as never)
          ? t(lk as never, violationValues(v, locale) as never)
          : v.message;
      } catch {
        label = v.message;
      }
      const g = groups.get(key) ?? { expenseId: v.expenseId ?? null, merchant, labels: [] };
      g.labels.push(label);
      groups.set(key, g);
    }
    return [...groups.values()];
  }, [expenses, t, unresolved, locale]);

  const confirmDecide = () => {
    setSubmitError(null);
    if (decideMode === 'reject') {
      if (taskId) decide.mutate({ taskId, approve: false, note: decideNote.trim() });
    } else if (decideMode === 'return') {
      returnForEdit.mutate({ reportId, note: decideNote.trim() || undefined });
    }
    setDecideMode('idle');
    setDecideNote('');
  };

  /**
   * Open or close one of the approver's decide panels — the same clearing the
   * three popovers each did for themselves, in one place so both destinations
   * cannot drift apart on it.
   */
  const openDecidePanel = (panel: DecidePanel, open: boolean) => {
    if (panel === 'reassign') {
      setReassignTo(null);
      setReassignItem(null);
    }
    // VeloExpense (d37): a reassignment carries a reason too, so the note clears for every
    // panel. ExpenseOS cleared it only for reject and return.
    setDecideNote('');
    setDecideMode(open ? panel : 'idle');
  };

  /**
   * The decide panel's body — the note or the picker, and the confirm button
   * that actually commits.
   *
   * Defined once and mounted by whichever container asked for it: the TopBar
   * row puts it in a `PopoverContent`, the phone bar puts it inline beneath the
   * buttons. It closes over the page's own decide state, which is why the state
   * machine stays unforked across the two destinations.
   */
  const decidePanel = (panel: DecidePanel) =>
    panel === 'reassign' ? (
      <>
        <UserCombobox
          value={reassignTo}
          initialItem={reassignItem}
          onValueChange={(v, item) => {
            setReassignTo(v);
            setReassignItem(item);
          }}
          placeholder={t('approvals.reassignPlaceholder')}
        />
        {/* VeloExpense (d37): the reason is required — the submitter and the new approver
            both see it on the report's discussion — so the panel asks for it under the
            picker, as reject asks for its note. ExpenseOS's reassign takes no note. */}
        <Textarea
          className="mt-2"
          rows={3}
          value={decideNote}
          onChange={(e) => setDecideNote(e.target.value)}
          placeholder={t('approvals.reassignNotePlaceholder')}
          aria-label={t('approvals.reassignNotePlaceholder')}
        />
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            disabled={reassign.isPending || !reassignTo || !decideNote.trim()}
            onClick={() => {
              setSubmitError(null);
              if (taskId && reassignTo && decideNote.trim())
                reassign.mutate({ taskId, toUserId: reassignTo, note: decideNote.trim() });
            }}
          >
            {t('approvals.confirmReassign')}
          </Button>
        </div>
      </>
    ) : (
      <>
        <Textarea
          autoFocus
          rows={3}
          value={decideNote}
          onChange={(e) => setDecideNote(e.target.value)}
          placeholder={
            panel === 'reject'
              ? t('approvals.rejectNotePlaceholder')
              : t('approvals.returnNotePlaceholder')
          }
        />
        <div className="mt-2 flex justify-end">
          {/* A rejection needs a note; a return does not. Rejecting somebody's
              expenses without saying why is the one decision that generates a
              second conversation. */}
          <Button
            size="sm"
            variant={panel === 'reject' ? 'destructive-outline' : undefined}
            disabled={decidePending || (panel === 'reject' && !decideNote.trim())}
            onClick={confirmDecide}
          >
            {panel === 'reject' ? t('approvals.confirmReject') : t('approvals.confirmReturn')}
          </Button>
        </div>
      </>
    );

  /**
   * WHAT CAN BE DONE TO THIS REPORT — the single ordered list, built from state
   * this component already owns and consumed by both destinations.
   *
   * The guards are the ones that have always been here (`approverMode`,
   * `canSubmit`, `canEditStatus`, `canDelete`, `isDraft`, `isSubmitted`, the
   * mutations' own pending flags) and they are unchanged. They gate the
   * CONTROL; every one of these procedures re-derives the actor from the
   * session and re-reads the row before it writes, so nothing here is an
   * authorisation decision and a suppressed control suppresses no check.
   *
   * Order is the order the TopBar row has always painted, so a reader comparing
   * the two destinations sees one list in one sequence.
   *
   * The three the drawer had and this list did not — Request receipts, Mark
   * reimbursed, Acknowledge — are here so the workbench can do everything the
   * drawer does. Each matches the drawer's own condition and copy, narrowed only
   * where the drawer offered a control the server would refuse or skip.
   */
  const actions: WorkbenchAction[] = [];
  if (report) {
    // First, because it is asked BEFORE deciding: approving a report whose
    // receipts are missing is the thing it prevents. No status gate — the
    // procedure has none, and neither does the drawer.
    if (canChase && receiptlessIds.length > 0) {
      actions.push({
        id: 'requestReceipts',
        label: t('drawer.requestReceipts', { count: receiptlessIds.length }),
        onPress: () => {
          setSubmitError(null);
          setChaseNote(null);
          chase.mutate({ expenseIds: receiptlessIds });
        },
        variant: 'ghost',
        disabled: chase.isPending,
        emphasis: 'secondary',
        desktopPlacement: 'strip',
      });
    }
    if (approverMode && isAcknowledge) {
      // One outcome. The drawer shows only Acknowledge on such a task, and the
      // engine refuses a reject on one — so Return / Reject / Reassign / Approve
      // would be three controls that fail and one that says the wrong thing.
      actions.push({
        id: 'acknowledge',
        label: t('approvals.acknowledge'),
        onPress: () => {
          setSubmitError(null);
          if (taskId) decide.mutate({ taskId, approve: true });
        },
        variant: 'default',
        disabled: decidePending,
        emphasis: 'primary',
      });
    } else if (approverMode) {
      actions.push(
        {
          id: 'return',
          label: t('approvals.return'),
          onPress: () => openDecidePanel('return', true),
          variant: 'ghost',
          disabled: decidePending,
          emphasis: 'secondary',
          needsNote: 'return',
        },
        {
          id: 'reject',
          label: t('approvals.reject'),
          onPress: () => openDecidePanel('reject', true),
          variant: 'destructive-outline',
          disabled: decidePending,
          emphasis: 'secondary',
          needsNote: 'reject',
          destructive: true,
        },
        {
          id: 'reassign',
          label: t('approvals.reassign'),
          onPress: () => openDecidePanel('reassign', true),
          variant: 'ghost',
          disabled: decidePending,
          emphasis: 'secondary',
          needsNote: 'reassign',
        },
        {
          id: 'approve',
          label: t('approvals.approve'),
          onPress: () => {
            setSubmitError(null);
            if (taskId) decide.mutate({ taskId, approve: true });
          },
          variant: 'success-outline',
          disabled: decidePending,
          emphasis: 'primary',
        },
      );
    } else {
      if (canSubmit && isSubmitted) {
        actions.push({
          id: 'recall',
          label: t('drawer.recall'),
          onPress: () => recall.mutate({ reportId }),
          variant: 'ghost',
          disabled: recall.isPending,
          emphasis: 'secondary',
        });
      }
      if (canSubmit && canEditStatus) {
        actions.push({
          id: 'submit',
          label: t('drawer.submit'),
          onPress: () => void onSubmit(),
          variant: 'default',
          disabled: submit.isPending || submitBlocked,
          disabledReason: submitReason,
          emphasis: 'primary',
        });
      }
      if (canDelete && isDraft) {
        actions.push({
          id: 'delete',
          label: t('drawer.deleteReport'),
          onPress: () => remove.mutate({ reportId }),
          variant: 'ghost',
          disabled: remove.isPending,
          emphasis: 'secondary',
          destructive: true,
          /**
           * Confirmed, like every other destructive action here, and now
           * confirmed by the DESCRIPTOR rather than by one button's `onClick` —
           * so the guard cannot exist in one destination and be forgotten in
           * the other.
           *
           * It used to fire straight from the button: one stray click and the
           * report, its expenses and its receipts were gone, with no undo. The
           * asymmetry was the tell — deleting SELECTED EXPENSES two panels away
           * already asked. `window.confirm` rather than a bespoke dialog
           * because that is the house pattern for this.
           */
          confirm: t('drawer.confirmDeleteReport'),
        });
      }
    }
    // VeloExpense: no Mark reimbursed (d71). ExpenseOS offers it here to an AP clerk on an
    // APPROVED report; VeloExpense's reimbursement screen stays the one place AP pays, as the
    // approver drawer says. `canReimburse` still decides who may Request receipts.
  }
  /** At `lg` and up, the one list split by `desktopPlacement` — the phone bar takes it whole. */
  const barActions = actions.filter((a) => a.desktopPlacement !== 'strip');
  const stripActions = actions.filter((a) => a.desktopPlacement === 'strip');

  // ── Project report chrome into the app-shell top bar ────────────
  useTopBarSlots(() => {
    if (!report) return {};
    const rollup = report.rollup;
    const homeCurrency = report.currency;
    const recoverableMinor = BigInt(rollup.recoverableTotalMinor);
    // Only surface the FX/VAT breakdown when there's something to explain:
    // a multi-currency report, recoverable VAT/ITC, or an unconvertible line.
    const hasFxDetail =
      rollup.multiCurrency || recoverableMinor !== 0n || rollup.missingRates.length > 0;
    /**
     * Read this report in the reader's own currency (GA readiness report F52).
     *
     * The audit looked for a display-currency toggle and found only the FX override, which
     * converts foreign LINES into the report's currency — the opposite direction. So a
     * historical USD report could not be read in CAD at all.
     *
     * Presentation only: the report's own currency remains what it is filed and posted in,
     * and the toggle never changes a stored figure. `viewInReaderCurrency` is null when the
     * reader's currency IS the report's, or when no rate connects them — in which case
     * nothing is offered rather than something being offered and wrong.
     */
    // `?? null` and a NULLISH check: a response from before this field existed (a cached page
    // across a deploy) arrives as `undefined`, which `!== null` would let through.
    const alt = report.viewInReaderCurrency ?? null;
    const shownInAlt = alt != null && viewCurrency === alt.currency;
    const totalAmount = (
      <>
        <span className="mr-1 font-normal text-muted-foreground text-xs">
          {shownInAlt ? alt.currency : report.currency.code}
        </span>
        {shownInAlt
          ? formatMinor(Number(alt.totalMinor), { code: alt.currency }, locale)
          : formatMinor(Number(rollup.homeTotalMinor), homeCurrency, locale)}
      </>
    );
    /**
     * HOW the total adds up, stated beside it: `CAD $5,449.71 (CAD 1,573.22 + USD 2,796.69
     * @ 1.3861)`.
     *
     * This replaces the standalone "By currency" panel that used to sit under the header.
     * That panel existed for a real reason — the arithmetic was only in a hover tooltip,
     * which is invisible on a touch device and easy to miss on a desktop, so a reader
     * looking at one total above a list of CAD and USD lines had nothing tying the two
     * together (UAT A7). Putting the composition ON the total answers that without
     * spending a second bar on it: it is always visible, it is where the number is read,
     * and the tooltip still holds the full reconciliation for anyone who wants the
     * converted column and the recoverable tax.
     *
     * The rate is grey because it is provenance rather than money — the eye should land on
     * the two amounts that add up. A currency with no rate is flagged in the warning colour
     * and keeps its own panel above, which makes a different claim: not "here is how this
     * adds up" but "this total is not the whole total".
     *
     * Hidden while the reader has toggled into their own currency. The `@ rate` figures
     * convert to the REPORT's currency, so the parenthetical reconciles to the report total
     * and not to the one on screen; showing it there would be an equation that does not
     * balance.
     */
    const inlineBreakdown = rollup.multiCurrency && !shownInAlt && (
      <span className="text-xs tabular-nums">
        <span className="text-muted-foreground">(</span>
        {rollup.byCurrency.map((c, i) => (
          <span key={c.code}>
            {i > 0 && <span className="mx-1 text-muted-foreground">+</span>}
            <span className={c.convertedMinor === null ? 'text-warning' : 'text-foreground/80'}>
              {c.code} {formatMinor(Number(c.grossMinor), { code: c.code, symbol: '' }, locale)}
            </span>
            {c.rate && (
              <span className="ml-1 text-muted-foreground">
                {t('workbench.fxRate', { rate: c.rate })}
              </span>
            )}
          </span>
        ))}
        <span className="text-muted-foreground">)</span>
      </span>
    );
    const currencyToggle = alt && (
      <button
        type="button"
        onClick={() => setViewCurrency(shownInAlt ? null : alt.currency)}
        /* `.einc-tap-slop-both`: ~26 x 18, short on BOTH axes, and it is how a reader
           reaches the alternate-currency total at all — there is no other control for
           it. `-both` rather than a real box because the 44px ring's only neighbour is
           a static amount span, not another target, so there is no tap to steal; and
           because growing the chip itself would change the top bar's measured
           min-content width, which ADR-0002 budgets to the pixel. */
        className="einc-tap-slop-both shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide hover:bg-muted/50"
        title={
          shownInAlt
            ? t('workbench.viewInReportCurrency', { currency: report.currency.code })
            : t('workbench.viewInMyCurrency', { currency: alt.currency, rate: alt.rate ?? '—' })
        }
      >
        {shownInAlt ? report.currency.code : alt.currency}
      </button>
    );
    const total = hasFxDetail ? (
      <div className="group relative flex shrink-0 items-center gap-1.5">
        <span className="inline-flex cursor-default items-center gap-1.5 text-foreground text-sm tabular-nums">
          <span>{totalAmount}</span>
          {inlineBreakdown}
          <IconInfoCircle size={13} className="shrink-0 text-muted-foreground" />
        </span>
        {currencyToggle}
        <div className="absolute top-full right-0 z-50 mt-1 hidden w-72 group-hover:block">
          <div className="rounded-md border border-border bg-popover text-left shadow-md">
            <div className="flex items-center justify-between border-border border-b px-3 py-2">
              <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {t('workbench.fxReportTotal')}
              </span>
              <span className="font-semibold text-foreground text-sm tabular-nums">
                {formatMinor(Number(rollup.homeTotalMinor), homeCurrency, locale)}{' '}
                {rollup.homeCurrency}
              </span>
            </div>
            {recoverableMinor !== 0n && (
              <div className="flex items-center justify-between px-3 py-2 text-xs">
                <span className="text-muted-foreground">{t('workbench.fxRecoverable')}</span>
                <span className="text-foreground tabular-nums">
                  {formatMinor(Number(rollup.recoverableTotalMinor), homeCurrency, locale)}{' '}
                  {rollup.homeCurrency}
                </span>
              </div>
            )}
            {rollup.multiCurrency && (
              <div className="border-border border-t">
                <div className="px-3 pt-2 pb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                  {t('workbench.fxByCurrency')}
                </div>
                <ul className="flex flex-col gap-1 px-3 pb-2">
                  {rollup.byCurrency.map((c) => (
                    <li
                      key={c.code}
                      className="flex items-center justify-between gap-2 text-xs tabular-nums"
                    >
                      <span className="text-foreground">
                        {c.code}{' '}
                        {formatMinor(Number(c.grossMinor), { code: c.code, symbol: '' }, locale)}
                        {c.rate && (
                          <span className="ml-1 text-muted-foreground">
                            {t('workbench.fxRate', { rate: c.rate })}
                          </span>
                        )}
                      </span>
                      <span
                        className={
                          c.convertedMinor === null
                            ? 'shrink-0 text-warning'
                            : 'shrink-0 text-muted-foreground'
                        }
                      >
                        {c.convertedMinor === null
                          ? '—'
                          : formatMinor(Number(c.convertedMinor), homeCurrency, locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {rollup.missingRates.length > 0 && (
              <div className="flex items-start gap-1.5 border-border border-t px-3 py-2 text-warning text-xs">
                <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{t('workbench.fxMissingRate', { count: rollup.missingRates.length })}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    ) : (
      <span className="flex shrink-0 items-center gap-1.5 text-foreground text-sm tabular-nums">
        {totalAmount}
        {currencyToggle}
      </span>
    );
    const status = (
      <StatusBadge
        {...statusBadgeProps(report.status, t)}
        appearance={isDraft ? 'outline' : 'solid'}
      />
    );
    const externalIds =
      report.externalIds.length > 0 ? (
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {report.externalIds.map((x) => `${x.source} · ${x.value}`).join('  ')}
        </span>
      ) : null;
    // Opens the shell-free print view in a new tab (Print → Save as PDF).
    // Posting state + push, beside the report it is about rather than only on an
    // admin page. APPROVED/REIMBURSED only: anything earlier is not a liability.
    // VeloExpense (d38): VeloExpense's `report.posting` and a link to the posting queue
    // (`LedgerPost`, ported from `NetSuitePush`).
    // VeloExpense: `posting`, ExpenseOS's `netsuite` (check-vendor-neutral).
    const posting = (
      <LedgerPost
        state={report.posting as LedgerPostState | null}
        canOpenQueue={canOpenLedgerQueue}
        postable={report.status === 'APPROVED' || report.status === 'REIMBURSED'}
      />
    );

    const printButton = (
      <button
        type="button"
        aria-label={t('workbench.printExport')}
        title={t('workbench.printExport')}
        onClick={() => window.open(`/${locale}/print/expenses/${reportId}`, '_blank')}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <IconPrinter size={16} />
      </button>
    );

    return {
      left: (
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => router.push('/expenses')}
            /* `.einc-tap-slop` for the ~24px height, and `truncate` for the width.
               `shrink-0` is right at a desktop width and wrong at 360: an untruncated
               breadcrumb that refuses to shrink pushes the report title out of the row
               entirely. Below `lg` it yields; at `lg` and up `shrink-0` still wins and
               `truncate` is inert on an element sized to its own content, so the
               desktop row is byte-for-byte what it was. */
            className="einc-tap-slop shrink-0 truncate font-semibold text-base text-muted-foreground hover:text-foreground hover:underline max-lg:min-w-0 max-lg:shrink"
          >
            {t('workbench.reportsCrumb')}
          </button>
          <span className="shrink-0 text-muted-foreground text-sm">›</span>
          <EditableTitle
            title={report.title}
            editable={editable}
            onSave={(title) => updateReport.mutate({ reportId, title })}
          />
        </div>
      ),
      center: submitError ? (
        // Unchanged, and deliberately so: `submitError` is shared with the APPROVER
        // actions (decide, return, reassign), whose messages belong here and nowhere
        // else. The submit refusal gets its own explanation in the body — see
        // `submitRefusal` — rather than this slot being repurposed and taking those
        // with it.
        <span className="truncate text-destructive text-xs">{submitError}</span>
      ) : chaseNote || unresolved.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2">
          {/* What Request receipts did. Beside the violations badge rather than in
              place of it: the missing-receipt warning is still true until the
              submitter attaches one. A live region, because the press that caused
              it is in another part of the bar (or, on a phone, of the page). */}
          {chaseNote && (
            <span role="status" className="truncate text-muted-foreground text-xs">
              {chaseNote}
            </span>
          )}
          {unresolved.length > 0 && (
            <div className="group relative">
              <span className="inline-flex cursor-default items-center gap-1 rounded-md bg-warning/15 px-2 py-1 font-medium text-warning text-xs">
                <IconAlertTriangle size={14} />
                {t('workbench.violationsDetected', { count: unresolved.length })}
              </span>
              <div className="absolute top-full left-1/2 z-50 mt-1 hidden w-96 -translate-x-1/2 group-hover:block">
                <div className="rounded-md border border-border bg-popover text-left shadow-md">
                  <div className="border-border border-b px-3 py-2 font-medium text-foreground text-xs uppercase tracking-wide">
                    {t('drawer.policyWarnings')}
                  </div>
                  <ul className="max-h-80 divide-y divide-border overflow-y-auto">
                    {violationGroups.map((g) => (
                      <li key={g.expenseId ?? 'report'} className="flex flex-col gap-1 px-3 py-2">
                        <span className="truncate font-medium text-foreground text-sm">
                          {g.merchant}
                        </span>
                        <ul className="flex flex-col gap-0.5">
                          {g.labels.map((label) => (
                            <li
                              key={label}
                              className="flex items-start gap-1.5 text-muted-foreground text-xs"
                            >
                              <IconAlertTriangle
                                size={12}
                                className="mt-0.5 shrink-0 text-warning"
                              />
                              <span>{label}</span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null,
      right: (
        /*
         * `min-w-0`, and it is the difference between this row yielding and this row
         * overflowing.
         *
         * `TopBar.tsx` mounts this in a `min-w-0` box and bounds the right grid track, so
         * the shell can hand this row less width than it wants — that is the shell holding
         * the line for its own controls. What the shell cannot do is make this row narrower
         * than its own content: without `min-w-0` here the row's automatic minimum size is
         * its content-based minimum, so it refuses the width it was given and is painted
         * outside the zone instead, across the left zone's breadcrumb. Measured at 1024px
         * with the sidebar pinned: 44px of this row outside the zone in EN, 189px in fr-CA,
         * over a `<button>`.
         *
         * With it, the row shrinks and the yielding happens inside `NetSuitePush` (see the
         * note at its `<span>`), which is the only child here with anything that can give.
         * Everything else in this row is `shrink-0` on purpose — see `e2e/topbar-overlap.spec.ts`.
         *
         * What is still unprotected, so the next reader does not have to rediscover it:
         *
         *  · **This row has one yielder and it runs out.** All the give is the error span's
         *    `truncate` inside `NetSuitePush`. Once that span is at zero the row is still
         *    `shrink-0` boxes, so further squeezing pushes them over each other. Measured at
         *    1024px with the sidebar pinned in fr-CA: the row is 13px short in the no-error
         *    state and 19px short once the error span exists, and `NetSuitePush`'s span is
         *    painted 11.2px over `printButton`. EN has slack at that width and is clean.
         *    That is a 2.5.8 target overlap and it is smaller, not gone: before `min-w-0` it
         *    was 189px of this row over the left zone's breadcrumb `<button>`.
         *  · **No `flex-wrap`**, deliberately — this row lives in an `h-8` band, so wrapping
         *    would paint a second line over the page body rather than making room.
         *  · **`printButton` and `actions` are unbounded.** Their labels are translated and
         *    `shrink-0`; a longer fr-CA label lengthens this row's max-content and moves the
         *    band where it stops fitting further out, without any of it being visible to a
         *    test that only measures EN.
         */
        <div className={cn('flex min-w-0 items-center gap-2', isBelowLg && 'max-lg:hidden')}>
          {total}
          {status}
          {externalIds}
          {posting}
          {printButton}
          {/*
           * THE RELOCATION, and the half of it that is decided in JS.
           *
           * Below `lg` the action row is not here at all — it is mounted once,
           * in the body, by `PhoneActionBar`. One tree, selected by the hook,
           * because two trees would define the report's action set twice.
           *
           * The rest of this row is NOT relocated and stays published at every
           * width; the `max-lg:hidden` cloak above is what keeps it inside
           * ADR-0002's below-`lg` ration of one icon-only control or nothing.
           * The cloak is on the hook's branch rather than unconditional: CSS
           * decides what is VISIBLE (so a window dragged across 1024px is
           * correct in the frame before React commits), JS decides what is
           * MOUNTED.
           */}
          {isBelowLg ? null : (
            <TopBarActions
              actions={barActions}
              openPanel={decideMode}
              onOpenPanel={openDecidePanel}
              renderPanel={decidePanel}
            />
          )}
        </div>
      ),
    };
  }, [
    report,
    canOpenLedgerQueue,
    revalidate,
    editable,
    approverMode,
    decideMode,
    decideNote,
    submitError,
    chaseNote,
    submitBlocked,
    submitReason,
    hasNoExpenses,
    /**
     * `useTopBarSlots` runs its builder inside a `useEffect` keyed on THIS
     * array, so without this entry the published row would keep whatever shape
     * it had when some other dep last changed and would not notice the viewport
     * crossing `lg` at all.
     *
     * `actions`, `decidePanel` and `openDecidePanel` are deliberately NOT here.
     * Each is rebuilt every render, so listing them would re-run the effect on
     * every render for no gain — and each is a pure function of entries already
     * in this list, so the builder reads a current one whenever anything that
     * can change the row has changed.
     */
    isBelowLg,
    isDraft,
    isSubmitted,
    canEditStatus,
    canSubmit,
    canDelete,
    taskId,
    submit.isPending,
    recall.isPending,
    remove.isPending,
    decidePending,
    reassign.isPending,
    reassignTo,
    reassignItem,
    // VeloExpense: no markReimbursed (d71).
    chase.isPending,
    isSubmitter,
    isAcknowledge,
    canReimburse,
    canChase,
    unresolved.length,
    violationGroups,
    t,
    locale,
    reportId,
  ]);

  if (query.isLoading) {
    return <div className="p-6 text-muted-foreground text-sm">{t('list.loading')}</div>;
  }
  if (!report) {
    /**
     * A report id that resolves to nothing gets a real not-found state.
     *
     * This used to render `t('drawer.fallback')` — the string "Expense report", a TITLE
     * reused as an empty state. Opening a well-formed but nonexistent id therefore
     * produced the breadcrumb "Expense report" above an otherwise empty pane: no message,
     * no error, and no way forward, which reads as a broken page rather than a missing
     * record (GA readiness report F46).
     */
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
        <IconFileOff size={40} className="text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <h1 className="font-semibold text-foreground text-lg">{tc('notFound.recordTitle')}</h1>
          <p className="max-w-md text-muted-foreground text-sm">{tc('notFound.recordBody')}</p>
        </div>
        <Link href="/expenses" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
          {tc('notFound.backToExpenses')}
        </Link>
      </div>
    );
  }
  const currencySymbol = report.currency.symbol;

  return (
    /**
     * `max-lg:h-auto max-lg:shrink-0` — the pane wrapper. The first half is not enough
     * on its own, and the operator round is what proved it.
     *
     * `h-full` caps this column at the height of the area the shell gives it. Above
     * `xl` that is right: three panes side by side, each scrolling its own content.
     * Below `xl` `ResizablePanels` returns a single stacked column instead, and the
     * same cap now has to be shared out between the expense list, the editor, the
     * discussion and (until this phase) the receipt — every one of them a `min-h-0`
     * flex child, which means every one of them has a floor of zero. At 390 x 664 the
     * arithmetic that follows from that is four panes of roughly nothing.
     *
     * `h-auto` below `lg` was supposed to let the column be as tall as its content.
     * It is necessary and it is NOT sufficient, because this element is also a flex
     * ITEM of `main` (`flex flex-1 flex-col overflow-y-auto`), and a flex item's
     * default `flex-shrink: 1` plus this element's own `min-h-0` means it can be
     * squeezed below its content with no floor at all. Measured on the stage at
     * 390 x 664: this div asked for 1 418px of content and was given 573px, and
     * because `min-h-0` removed the floor, nothing overflowed the SCROLLER — the box
     * simply got smaller and its children painted outside it. `ResizablePanels`'
     * stacked branch then repeated the squeeze one level down, handing each panel
     * wrapper (`resizable-panels.tsx:229`, a `min-h-0` div with the same default
     * shrink) a fraction of what its pane needed: 109px for a 393px expenses-and-
     * discussion column, 217px for a 778px editor. Overflow on a `static` box is
     * VISIBLE and paints, so the editor — later in DOM order — was drawn over the
     * expense list, and the expense list over the discussion. That is the reported
     * "the Expenses box is under the first expense" and "the discussion box is
     * covered by the expenses box", and it is also why no expense could be tapped:
     * `document.elementFromPoint` at the centre of the first row returned the
     * EDITOR's title span, so every tap aimed at a row landed on the pane on top.
     *
     * `shrink-0` below `lg` is the floor the `min-h-0` took away. The div then takes
     * its content height, `main`'s own `overflow-y-auto` scrolls the page — which is
     * the behaviour a phone reader expects from a stack of cards — and each panel
     * wrapper measures exactly its pane (393/393, 778/778 on the same stage), so
     * nothing paints outside anything.
     *
     * `max-lg:` and not `max-xl:`, even though the panes stack from `xl` down: the
     * 1 024–1 280px band is desktop, keeps `h-full`, and is exactly as it was before
     * this task touched the file. Widening the fix into it is a different change.
     *
     * jsdom does no layout, so nothing in this repo's unit suite can show this is
     * right or wrong — the same is true of the `CommentThread` wrapper below. The
     * numbers above were taken in a real browser at 390 x 664, before and after.
     */
    <div className="flex h-full min-h-0 flex-col max-lg:h-auto max-lg:shrink-0">
      {/*
       * THE BODY-LEVEL HEADER THIS ROUTE HAS NEVER HAD.
       *
       * Below `lg` the TopBar's right slot is cloaked to nothing, so without
       * this block a phone has no total, no status, and — the part that makes
       * it a bug rather than a trim — no Submit button.
       *
       * `lg:hidden` is the other half of the cloak pair. It is on the hook's
       * branch, never unconditional: the block only exists when JS has selected
       * the phone tree, and the class is what hides it in the frame between a
       * window widening past 1024px and React unmounting it.
       *
       * The title and the breadcrumb stay in the TopBar `left` slot and are NOT
       * repeated here — a second copy would put the report title in the
       * accessibility tree twice.
       */}
      {isBelowLg && (
        <div className="flex shrink-0 flex-col gap-3 pb-3 lg:hidden">
          <ReportSummary
            report={report}
            fxOverrideOffered={isFxOverrideOffered(canFxOverride, report)}
          />
          <PhoneActionBar
            actions={actions}
            openPanel={decideMode}
            onOpenPanel={openDecidePanel}
            renderPanel={decidePanel}
          />
        </div>
      )}
      {!isBelowLg && (
        <DesktopActionStrip
          actions={stripActions}
          openPanel={decideMode}
          onOpenPanel={openDecidePanel}
          renderPanel={decidePanel}
        />
      )}
      {/* Above the panes, because it blocks submission and is about the report as a
          whole rather than any one expense. `shrink-0` so it never gets squeezed to
          nothing by the panes below it. */}
      {/**
       * Why a submission was refused, where it cannot be missed.
       *
       * The report NEVER leaves this page on a failed submit — `onSubmit` sets an error
       * and stays put — but the only thing it rendered was a truncated `text-xs` span in
       * the top bar, sharing a slot with the violations badge. A server message like
       * "Report has unresolved policy violations." was cut off mid-sentence, and somebody
       * who pressed Submit and looked away saw nothing at all. It reads as the button
       * being broken, or worse, as the report having gone somewhere.
       *
       * NOT accompanied by a violation list, and that is a finding rather than an
       * omission. `submit` attaches the blockers to its TRPCError as `cause` "so the FE
       * can render the specific blockers" — but `submitBlocked` already disables the
       * button when `blocking > 0 || unjustifiedWarnings > 0`, so a refusal that HAS
       * local violations to list cannot be triggered from this screen. Rendering them
       * here was dead code; it was written, checked against the disabled state, and
       * removed. What reaches this panel is a refusal the client could not predict, and
       * for those the server's sentence is the whole of the available information.
       */}
      {submitRefusal && (
        <div className="shrink-0 pb-3">
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
            <p className="font-medium text-destructive text-sm">
              {t('workbench.submitBlockedTitle')}
            </p>
            <p className="text-muted-foreground text-sm">{submitRefusal}</p>
            <p className="mt-2 text-muted-foreground text-xs">{t('workbench.submitBlockedFix')}</p>
          </div>
        </div>
      )}
      {/*
       * An unconvertible line is stated on the REPORT, not only in the total's hover
       * tooltip. The roll-up excludes such a line rather than adding it in the wrong
       * units, which is the right arithmetic — but on EXP-000009 it meant an approver
       * read USD 2,871.46 while CAD 911.66, about 23% of the claim, was silently absent,
       * and the only disclosure was a tooltip nobody hovers before approving. A total
       * that is not the whole total has to say so where the number is read.
       */}
      {/*
       * Why this report cannot be submitted, before anybody presses Submit.
       *
       * Uncoded expenses were only discoverable by pressing a disabled-looking button and
       * reading a refusal that named two dimensions and no expenses. Worse, before the
       * submit guard existed they sailed through to APPROVED and failed weeks later at the
       * posting gate — dev still holds three such reports, stuck on retry, which is where
       * this was reported from. Retry cannot fix them: the coding was never captured.
       *
       * Each row opens the expense it names, because "which of eleven" is the question a
       * submitter actually has.
       */}
      {/*
       * Receipts still being read, said where the button is disabled for them.
       *
       * A reading that lands after the press rewrites the amounts under the approver;
       * the submit waits for it now (`expenses.submit`), and a disabled button with no
       * sentence reads as broken. The page polls while the count is non-zero, so this
       * clears on its own — usually inside a minute. The stale note is the other half:
       * a reading the worker abandoned (fifteen minutes silent) no longer holds the
       * report, but its amounts were never read, and that is worth a look before submit.
       */}
      {extractionInFlight > 0 && editable && (
        <div className="shrink-0 pb-3" data-testid="extraction-pending">
          <div className="flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5">
            <IconInfoCircle size={16} className="mt-0.5 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="font-medium text-sm">
                {t('workbench.extractionPendingTitle', { count: extractionInFlight })}
              </p>
              <p className="text-muted-foreground text-sm">
                {t('workbench.extractionPendingBody', { count: extractionInFlight })}
              </p>
            </div>
          </div>
        </div>
      )}
      {extractionStale > 0 && editable && (
        <div className="shrink-0 pb-3" data-testid="extraction-stale">
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5">
            <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium text-sm">
                {t('workbench.extractionStaleTitle', { count: extractionStale })}
              </p>
              <p className="text-muted-foreground text-sm">
                {t('workbench.extractionStaleBody', { count: extractionStale, minutes: 15 })}
              </p>
            </div>
          </div>
        </div>
      )}
      {uncodedExpenses.length > 0 && editable && (
        <div className="shrink-0 pb-3">
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5">
            <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium text-sm">{t('workbench.codingRequiredTitle')}</p>
              <p className="text-muted-foreground text-sm">
                {t('workbench.codingRequiredBody', {
                  count: uncodedExpenses.length,
                  dimensions: (report.coding?.missing ?? []).join(', '),
                })}
              </p>
              <ul className="mt-1 flex flex-col items-start gap-0.5">
                {uncodedExpenses.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      /* `.einc-tap-slop`, vertical only: the row is already as wide as
                         its text and horizontal slop on a stacked list would have each
                         row reaching into the one above it. This is the tap that carries
                         a submitter from "this report is blocked" to the expense that
                         blocks it, and at ~20px it was the shortest control on the
                         primary path. Coarse-pointer-only, so the desktop banner is
                         untouched. */
                      className="einc-tap-slop text-left text-sm text-warning underline underline-offset-2 hover:opacity-80"
                      onClick={() => setSelectedId(e.id)}
                    >
                      {e.merchant?.trim() || t('workbench.codingRequiredUnnamed')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {/**
       * Categories only an administrator can fix — its own banner, not the coding one.
       *
       * Same shell as the dimensions banner, different fixer. The expense buttons open the
       * expense so the submitter can SEE the category (and tell someone which), not fix
       * it; the admin page is named in plain text rather than linked, because the
       * submitter usually cannot open it (RBAC-gated, and desktop-only on a phone).
       */}
      {/*
       * VeloExpense (d39): warnings about the WHOLE report — a budget overage is one —
       * with a reason box each. Not in ExpenseOS, whose findings all sit on an expense and
       * are justified by that expense's "Explain this charge"; VeloExpense's policy engine
       * also raises report-level findings, and the submit gate (d34) waits for a reason on
       * every warning, so without this a report-level one could never be answered and the
       * report never submitted. Same shell as the banners around it; the reason goes
       * through ExpenseOS's own `justifyViolation`.
       */}
      {reportWarnings.length > 0 && editable && (
        <div className="shrink-0 pb-3" data-testid="report-findings">
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5">
            <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm">{t('workbench.reportFindingsTitle')}</p>
              <p className="text-muted-foreground text-sm">{t('workbench.reportFindingsBody')}</p>
              <ul className="mt-2 flex flex-col gap-2">
                {reportWarnings.map((v) => (
                  <ReportFindingRow
                    key={v.id}
                    violation={v}
                    label={violationLabel(v)}
                    onDone={revalidate}
                  />
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {categoryProblems.length > 0 && editable && (
        <div className="shrink-0 pb-3">
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5">
            <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium text-sm">{t('workbench.categoryProblemTitle')}</p>
              <ul className="mt-1 flex flex-col gap-1.5">
                {categoryProblems.map((p) => (
                  <li key={p.categoryId}>
                    <p className="text-sm">
                      {p.kind === 'ambiguous'
                        ? t('workbench.categoryProblemAmbiguous', {
                            category: problemCategoryName(p),
                            count: p.count ?? 0,
                          })
                        : p.kind === 'inactive'
                          ? t('workbench.categoryProblemInactive', {
                              category: problemCategoryName(p),
                            })
                          : t('workbench.categoryProblemNoMatch', {
                              category: problemCategoryName(p),
                            })}
                    </p>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-muted-foreground text-sm">
                        {t('workbench.categoryProblemAffected')}
                      </span>
                      {p.expenseIds.map((id) => (
                        <button
                          key={id}
                          type="button"
                          /* The same vertical-only tap slop as the dimensions banner. */
                          className="einc-tap-slop text-left text-sm text-warning underline underline-offset-2 hover:opacity-80"
                          onClick={() => setSelectedId(id)}
                        >
                          {expenseById.get(id)?.merchant?.trim() ||
                            t('workbench.codingRequiredUnnamed')}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-muted-foreground text-sm">
                {t('workbench.categoryProblemBody', { count: categoryProblems.length })}
              </p>
              <p className="text-muted-foreground text-sm">
                {t('workbench.categoryProblemSubmitOff')}
              </p>
            </div>
          </div>
        </div>
      )}
      {/**
       * The fifth banner: WHICH policy violations, on a phone.
       *
       * Above `lg` this list is a `group-hover` panel hanging off the top bar's
       * violations pill. `group-hover` does not exist on a touch device, so on a phone
       * the submitter got a count and a greyed Submit and no way to learn what to fix.
       * A claim that a person can review and submit a report here cannot rest on an
       * affordance only a pointer can reach.
       *
       * Not new interaction design: it is the uncoded-expense blocker directly above,
       * in the same shape — a warning banner holding one row per blocker, each row a
       * `<button>` that calls `setSelectedId`. Twelve lines apart, deliberately, so the
       * two read as one stack rather than as two ideas.
       *
       * BELOW `lg` ONLY, and selected in JS rather than cloaked in CSS. Both faces in
       * the DOM would put every violation label in the accessibility tree twice — the
       * hover panel and this banner carry the same strings — and a duplicated
       * accessible name is exactly the test the mechanism rule turns on.
       *
       * A REPORT-level violation (no `expenseId`) is prose, not a button: there is no
       * expense to open, and a link that selects nothing is worse than a sentence.
       */}
      {isBelowLg && violationGroups.length > 0 && (
        <div className="shrink-0 pb-3" data-testid="violations-banner">
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5">
            <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium text-sm">
                {t('workbench.violationsDetected', { count: unresolved.length })}
              </p>
              <p className="text-muted-foreground text-sm">{t('workbench.violationsListBody')}</p>
              <ul className="mt-1 flex flex-col gap-1.5">
                {violationGroups.map((g) => (
                  <li key={g.expenseId ?? 'report'} className="flex flex-col gap-0.5">
                    {g.expenseId ? (
                      <button
                        type="button"
                        className="einc-tap-slop text-left font-medium text-sm text-warning underline underline-offset-2 hover:opacity-80"
                        onClick={() => setSelectedId(g.expenseId as string)}
                      >
                        {g.merchant}
                      </button>
                    ) : (
                      <span className="font-medium text-foreground text-sm">
                        {t('workbench.violationsReportLevel')}
                      </span>
                    )}
                    <ul className="flex flex-col gap-0.5">
                      {g.labels.map((label) => (
                        <li key={label} className="text-muted-foreground text-sm">
                          {label}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {report.rollup.missingRates.length > 0 && (
        <div className="shrink-0 pb-3">
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5">
            <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium text-sm">{t('workbench.fxExcludedTitle')}</p>
              <p className="text-muted-foreground text-sm">
                {t('workbench.fxExcludedBody', {
                  count: report.rollup.missingRates.length,
                  currencies: report.rollup.missingRates.join(', '),
                  homeCurrency: report.rollup.homeCurrency,
                })}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {report.rollup.byCurrency
                  .filter((c) => c.convertedMinor === null)
                  .map((c) => (
                    <li key={c.code} className="text-sm text-warning tabular-nums">
                      {c.code}{' '}
                      {formatMinor(Number(c.grossMinor), { code: c.code, symbol: '' }, locale)}
                    </li>
                  ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {shouldPromptUpload({ linkArrived: showUploadPrompt, editable }) && (
        <div className="shrink-0 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5">
            <div className="min-w-0">
              <p className="font-medium text-sm">{t('handoff.title')}</p>
              <p className="text-muted-foreground text-sm">{t('handoff.body')}</p>
            </div>
            {/* `gap-3` once the pair exists: `ReceiptFileInput`'s file comment
              spells out why 6px and 8px gaps let the later sibling steal taps
              aimed at the earlier one. The pair only exists on a coarse
              pointer, so the wider gap is asked for there and the desktop
              row's spacing is left exactly as it was. */}
            <div className="flex shrink-0 items-center gap-2 pointer-coarse:gap-3">
              <ReceiptFileInput
                multiple
                disabled={uploadBusy}
                // Real 44px by resize, so no invisible ring beside the dismiss button.
                hitSlop={false}
                className={receiptChip(
                  // Icon-only beside the camera on a phone, which also takes the
                  // fill there; alone on a desktop, the labelled chip keeps it.
                  coarsePointer ? RECEIPT_CHIP_ICON : RECEIPT_CHIP_FILLED,
                  captureBusy,
                )}
                aria-disabled={captureBusy || undefined}
                camera={cameraControl(receiptChip(RECEIPT_CHIP_ICON_FILLED, captureBusy))}
                /* `uploadReceipts` copies the list with `Array.from` before its
                   first `await`, which it has to: the primitive resets the
                   input's value straight after this returns and that empties
                   the very `FileList` handed over here. */
                onFiles={(files) => void uploadReceipts(files)}
              >
                {pickerChildren(t('handoff.action'))}
              </ReceiptFileInput>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowUploadPrompt(false)}
                aria-label={t('handoff.dismiss')}
              >
                <IconX size={14} />
              </Button>
            </div>
          </div>
        </div>
      )}
      {openSuggestions.length > 0 && (
        <div className="shrink-0 pb-3">
          <GroupingResolver
            suggestions={openSuggestions}
            busy={receiptMove.isPending}
            onMerge={(receiptIds, toExpenseId) => {
              // Sequentially: each move re-derives both ends server-side, and firing
              // them together would race two rebuilds of the same expense.
              void (async () => {
                for (const id of receiptIds) {
                  await receiptMove.mutateAsync({ id, toExpenseId }).catch((e) => {
                    setSubmitError(refusalText(e, String(e)));
                  });
                }
                setSelectedId(toExpenseId);
                revalidate();
                grouping.refetch();
              })();
            }}
            onKeepApart={(key) => setKeptApart((prev) => new Set(prev).add(key))}
          />
        </div>
      )}
      <ResizablePanels
        minWidths={[340, 420, 340]}
        panelKeys={['expenses', 'editor', 'receipt']}
        flexIndex={1}
        defaultWidths={[480, undefined, 480]}
        defaultFractions={[1 / 3, 1 / 3, 1 / 3]}
        storageKey="eos.expenseWorkbench.paneSizes.v6"
        separatorLabel={t('workbench.resizePanels')}
        // Scroll horizontally rather than clip when the three mins can't fit the
        // content area (e.g. ~1280–1500px with the sidebar open) — `main` is
        // overflow-x-hidden, so without this the receipt pane's edge is cut off.
        className="overflow-x-auto"
      >
        {/* LEFT — expenses, then the discussion, as two separate cards */}
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
            <div className="flex h-12 shrink-0 items-center justify-between border-border border-b px-3">
              {/**
               * The pane's title, and below `lg` also the way in and out of the list.
               *
               * Still an `<h3>` at every width — the disclosure button goes INSIDE the
               * heading rather than replacing it, so the pane keeps its place in the
               * document outline and a screen reader's heading list is unchanged. One
               * face at a time, selected in JS: two would put "Expenses" in the
               * accessibility tree twice, which is the test the mechanism rule turns on.
               *
               * The count is in the label because a collapsed pane has to say how much
               * it is hiding; `aria-expanded` says which way the tap goes, and the
               * chevron says it again for everyone who is not listening. The row is
               * `h-12` (48px) and the button stretches to it, so the target clears 44px
               * without any hit slop — `-mx-3 px-3` puts the card's own gutter inside
               * the target rather than beside it.
               */}
              <h3
                className={cn(
                  'font-semibold text-base text-foreground',
                  isBelowLg && 'min-w-0 flex-1',
                )}
              >
                {isBelowLg ? (
                  <button
                    type="button"
                    aria-expanded={expensesListOpen}
                    aria-controls={EXPENSE_LIST_ID}
                    onClick={() => setExpensesListOpen((open) => !open)}
                    className="-mx-3 flex h-12 w-full items-center gap-1.5 px-3 text-left"
                  >
                    <span className="min-w-0 truncate">
                      {t('workbench.expensesToggle', { count: expenses.length })}
                    </span>
                    <IconChevronDown
                      size={16}
                      aria-hidden="true"
                      className={cn(
                        'shrink-0 transition-transform',
                        expensesListOpen && 'rotate-180',
                      )}
                    />
                  </button>
                ) : (
                  t('drawer.expenses')
                )}
              </h3>
              {/* Only while a decision is pending — the server refuses it otherwise,
                  because the override restates the total the approver signs. */}
              {isFxOverrideOffered(canFxOverride, report) && (
                /* Half of PLACEMENT 5 — the FX override. Cloaked rather than branched, for
                   the same state reason as the editors: the popover holds a typed rate.
                   `contents` rather than `block` because this header is a flex row with
                   `justify-between`, and a wrapper box would become the flex item and take
                   the trigger's own `shrink-0` out of the row's arithmetic. Hidden, it is
                   not a flex item at all — identical to the absent case. */
                <div className="hidden lg:contents">
                  <FxOverridePopover
                    reportId={reportId}
                    homeCurrency={report.currency.code}
                    foreignCodes={report.rollup.byCurrency
                      .map((c) => c.code)
                      .filter((c) => c !== report.currency.code)}
                    current={
                      report.fxOverride
                        ? {
                            rate: report.fxOverride.rate,
                            fromCurrency: report.fxOverride.fromCurrency,
                          }
                        : null
                    }
                  />
                </div>
              )}
              {editable && (
                /* `gap-3` for the same tap-stealing reason as the hand-off banner
                   above, and only where the pair exists.

                   NO `flex-wrap`, and that is arithmetic rather than taste: on a
                   phone this row is three 44px squares and two 12px gaps, ~156px,
                   which fits the narrowest phone this app targets. It used to be
                   ~365px of labelled chips and had to wrap — into a fixed `h-12`
                   row inside an `overflow-hidden` card, where the second line had
                   nowhere to go. Icon-only removed the overflow, so the wrap goes
                   too and a desktop's row is character for character what it was
                   before the camera existed. */
                <div className="flex items-center gap-2 pointer-coarse:gap-3">
                  <ReceiptFileInput
                    multiple
                    disabled={uploadBusy}
                    // Real 44px by resize, so no invisible ring beside "Add expense".
                    hitSlop={false}
                    className={receiptChip(
                      coarsePointer ? RECEIPT_CHIP_ICON : RECEIPT_CHIP_OUTLINE,
                      captureBusy,
                    )}
                    aria-disabled={captureBusy || undefined}
                    /* The same square as the picker, camera first — see
                       `RECEIPT_CHIP_ICON`. With no visible text there is nothing
                       for a weight to distinguish, so order is the cue. */
                    camera={cameraControl(receiptChip(RECEIPT_CHIP_ICON, captureBusy))}
                    onFiles={(files) => void uploadReceipts(files)}
                  >
                    {pickerChildren(t('inbox.uploadReceipt'))}
                  </ReceiptFileInput>
                  {/*
                   * "Add expense", at every width — the only add-expense entry point on
                   * this route, and the last editing control in this header.
                   *
                   * It used to be cloaked below `lg`: it creates an EMPTY expense, and
                   * every field that would fill it in was cloaked on a phone too. The
                   * expense's own fields are editable on a phone now, so the "+" leads
                   * somewhere, and it is a plain flex item of this row again. A second
                   * tap does not pile up blank rows: `createExpense` hands back the blank
                   * expense the report already has (`expenses.ts`, "Don't pile up blank
                   * entries").
                   *
                   * `addExpense`, not a bare `mutate`, because the scroll-and-focus onto
                   * the new row's editor belongs to THIS call site only — see
                   * `pendingScrollId`. The input is the same at every width (SEC-1).
                   */}
                  <Button
                    size="sm"
                    /* Icon-only on a phone, AT THIS CALL SITE ONLY — the label
                       goes into an `sr-only` span, so the accessible name (and
                       the E2E locators that read it) is untouched.

                       CSS rather than a `coarsePointer` branch: the button then
                       needs no pointer read, it does not reflow a beat after the
                       first paint, and nothing in `packages/design-system`
                       changes for the other pages using `Button`.

                       The square is the arithmetic: `size="sm"` is `h-9` (36px),
                       which loses to `min-h-11` because a min-height beats a
                       height, and `px-3` around a glyph is 12 + 18 + 12 = 42px
                       wide, so `min-w-11` is what makes the last 2px. `mr-1`
                       comes off because an `sr-only` span is out of flow and the
                       margin would push the glyph 4px off centre. */
                    className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    disabled={createExpense.isPending || uploadBusy}
                    onClick={addExpense}
                  >
                    <IconPlus
                      size={13}
                      aria-hidden="true"
                      className="mr-1 pointer-coarse:mr-0 pointer-coarse:size-[18px]"
                    />
                    <span className="pointer-coarse:sr-only">{t('drawer.addExpense')}</span>
                  </Button>
                </div>
              )}
            </div>
            {/*
             * NO NOTICE AT THIS CARD. It used to carry one of five `SectionNotice`
             * placements, naming the bulk-actions + FX-override pair cloaked below it; this
             * route renders no `SectionNotice` at all now.
             *
             * What does NOT move: the two RECEIPT controls beside "Add expense" stay in the
             * header at every width. Attaching a document is the phone capture path, and the
             * camera control P04 put there is the reason the ordinals in
             * `e2e/support/workbench.ts` are written the way they are.
             *
             * "Add expense" stays beside them at every width too — see its own comment above.
             * It was cloaked below `lg` while the fields it feeds were, and came back with them.
             */}
            {/* Group actions — the design-system toolbar pattern (BulkActionsMenu
              + SelectionCounter), same as the admin lists. Editable reports only. */}
            {editable && (
              <div className="hidden lg:contents">
                <DataTableToolbar
                  {...toolbarLabels}
                  selectedCount={checked.size}
                  resultCount={checked.size > 0 ? undefined : expenses.length}
                  loading={checked.size === 0 && query.isLoading}
                  selectAllSlot={
                    <Checkbox
                      aria-label={t('drawer.selectAll')}
                      checked={
                        expenses.length > 0 && checked.size === expenses.length
                          ? true
                          : checked.size > 0
                            ? 'indeterminate'
                            : false
                      }
                      onCheckedChange={(v) =>
                        setChecked(v === true ? new Set(expenses.map((e) => e.id)) : new Set())
                      }
                    />
                  }
                  bulkActions={bulkActions}
                  bulkActionsDisabled={deleteExpenses.isPending}
                />
              </div>
            )}
            {/* `hidden` rather than unmounted, and only on the hook's branch — see
                `expensesListOpen`. Above `lg` no class is added at all, so the desktop
                pane is byte-identical and a window dragged past 1024px reveals the same
                DOM it always had. */}
            <div
              id={EXPENSE_LIST_ID}
              className={cn(
                'min-h-0 flex-1 overflow-y-auto',
                isBelowLg && !expensesListOpen && 'hidden',
              )}
            >
              {expenses.length === 0 ? (
                <p className="p-3 text-muted-foreground text-sm">{t('drawer.noExpenses')}</p>
              ) : (
                <ul>
                  {expenses.map((e) => (
                    <ExpenseListRow
                      key={e.id}
                      expense={e}
                      locale={locale}
                      active={e.id === selectedId}
                      violationCount={violationCountByExpense.get(e.id) ?? 0}
                      onSelect={() => selectFromList(e.id)}
                      /* One tap selects the expense AND opens its receipts. Below
                         `lg` only — `ExpenseListRow` renders no trigger above it, so
                         this is never reachable on a desktop. */
                      onOpenReceipts={() => {
                        selectFromList(e.id);
                        setReceiptSheetOpen(true);
                      }}
                      selectable={editable}
                      selected={checked.has(e.id)}
                      onToggleSelected={() => toggleChecked(e.id)}
                      onReceiptDrop={editable ? (p) => moveReceipt(p.receiptId, e.id) : undefined}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
          {/**
           * The report-level discussion, under the expenses it is about.
           *
           * Report-level rather than per-expense: the questions people ask are about the
           * claim ("why is this over budget?"), and a thread per line would scatter one
           * conversation across a dozen places. It sits in this pane because an approver
           * reads a report top-down — the discussion belongs beside the list and the
           * submit/recall actions, not behind a click in another panel.
           *
           * Its OWN card rather than a section at the foot of the expenses card. It used
           * to be the latter, which cost it the two things a transcript needs: the title
           * scrolled away with the messages (one `overflow-y-auto` wrapped the heading,
           * the stream and the composer together), and the composer went with it — so on
           * a long thread the box you type into was somewhere off-screen.
           *
           * `h-1/2 shrink-0`: half the column, and the expenses list above takes the
           * slack. Enclosed mode makes the thread own its scroller, which is what lets it
           * pin its header and stick to the newest message.
           */}
          {/* `max-lg:h-auto`, the second half of the stacked-pane change above.
              `h-1/2` is half of a parent that below `lg` no longer has a definite
              height, and a percentage height against an indefinite parent is the
              case browsers resolve to `auto` — silently, and not identically
              everywhere. Saying `auto` outright is the same outcome stated rather
              than relied upon. Unverified for the same reason as the wrapper:
              Phase 8 measures it. */}
          <div className="h-1/2 shrink-0 max-lg:h-auto">
            <CommentThread subjectType="EXPENSE_REPORT" subjectId={report.id} enclosed />
          </div>
        </div>

        {/* CENTER — selected expense editor.

            A named region you can focus but never tab to (a `<section>` with a name IS a
            region, so no `role` is spelled out), because "Add expense" on a phone lands
            the reader here: it scrolls this pane to the top and focuses it (see
            `pendingScrollId`). The PANE rather than the editor inside it, because
            the pane is mounted on every render — the editor is keyed on the expense and
            remounts, and the empty prompt replaces it outright — so the target never
            disappears from under a ref. "Expense details", not "New expense": the same
            pane shows every expense, and a landmark named for the add would be wrong
            the rest of the time. Desktop gains these attributes and no box.
            `focus:outline-none` because the ring would outline the whole card for a
            focus nobody tabbed to; the reader is told by where they are, not by a ring.
            No `scroll-mt`: nothing sticky sits above it inside the scroller — the top
            bar is outside `main`, which is what scrolls. */}
        <section
          ref={editorPaneRef}
          aria-label={t('workbench.editorRegionLabel')}
          tabIndex={-1}
          className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card focus:outline-none"
        >
          {selected ? (
            <ExpenseEditor
              key={selected.id}
              expense={selected}
              violations={report.violations.filter(
                (v) => v.expenseId === selected.id && !v.resolvedAt,
              )}
              currencySymbol={currencySymbol}
              editable={editable}
              categoryItems={categoryItems}
              locale={locale}
              onChange={revalidate}
              entityRecovers={report.entity.itcRecoverable}
              locked={editorLocked}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
              {t('workbench.selectPrompt')}
            </div>
          )}
        </section>

        {/* RIGHT — receipts for the selected expense */}
        <ReceiptPane
          expense={selected}
          editable={editable}
          reviewThreshold={report.extractionReviewThreshold}
          onChange={revalidate}
          locked={viewerLocked}
          moveTargets={moveTargets}
          onMoveReceipt={moveReceipt}
          /* Below `lg` this renders as a bottom sheet instead of the third pane;
             above it, these three are inert. `refetchReport` is SEC-4 — the same
             `expenses.report` query asked again when the sheet becomes readable, so
             a presigned URL that expired while the phone was in a pocket is replaced
             rather than rendered as an S3 error body. No new procedure. */
          sheetOpen={receiptSheetOpen}
          onSheetOpenChange={setReceiptSheetOpen}
          onRefetchReport={refetchReport}
        />
      </ResizablePanels>
    </div>
  );
}

/** AP-only per-report FX override (A4). Lets AP pin the rate used to convert a
 *  foreign currency on the report into the report currency, matching the card
 *  statement. One rate per report; Save writes it, Clear reverts to the daily
 *  FX rate. Shown only to `expense.report.fxOverride` holders (canFxOverride) on a
 *  multi-currency report. */
function FxOverridePopover({
  reportId,
  homeCurrency,
  foreignCodes,
  current,
}: {
  reportId: string;
  homeCurrency: string;
  foreignCodes: string[];
  current: { rate: string; fromCurrency: string | null } | null;
}) {
  const t = useTranslations('expenses');
  const refusalText = useRefusalText();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<string | null>(current?.fromCurrency ?? foreignCodes[0] ?? null);
  const [rate, setRate] = useState(current?.rate ?? '');
  /** The server's reason for refusing the rate — out of band, or on a decided report. */
  const [error, setError] = useState<string | null>(null);

  const setOverride = trpc.expenseApprovals.setFxOverride.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.expenses.report.invalidate({ reportId });
      setOpen(false);
    },
    onError: (e) => setError(refusalText(e, e.message)),
  });

  const items: ComboboxItem[] = foreignCodes.map((c) => ({ value: c, label: c }));
  const rateValid = /^\d+(\.\d+)?$/.test(rate) && Number(rate) > 0;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setFrom(current?.fromCurrency ?? foreignCodes[0] ?? null);
          setRate(current?.rate ?? '');
          setError(null);
        }
      }}
    >
      {/* VeloExpense: Radix `asChild` for Base UI's `render`, as above. */}
      <PopoverTrigger asChild>
        <Button size="sm" variant={current ? 'default' : 'ghost'}>
          {current ? t('workbench.fxOverrideActive') : t('workbench.fxOverride')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="mb-2 text-muted-foreground text-xs">{t('workbench.fxOverrideHelp')}</p>
        <div className="flex flex-col gap-2">
          <label className="text-muted-foreground text-xs" htmlFor="fxOverrideFrom">
            {t('workbench.fxOverrideFrom')}
          </label>
          <Combobox
            id="fxOverrideFrom"
            items={items}
            value={from}
            onValueChange={setFrom}
            disabled={foreignCodes.length <= 1}
          />
          <label className="text-muted-foreground text-xs" htmlFor="fxOverrideRate">
            {t('workbench.fxOverrideRate', { from: from ?? '', home: homeCurrency })}
          </label>
          <Input
            id="fxOverrideRate"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="1.37"
          />
        </div>
        {error && (
          <p role="alert" className="mt-2 text-destructive text-xs">
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-between">
          <Button
            size="sm"
            variant="ghost"
            disabled={setOverride.isPending || !current}
            onClick={() => setOverride.mutate({ reportId, rate: null })}
          >
            {t('workbench.fxOverrideClear')}
          </Button>
          <Button
            size="sm"
            disabled={setOverride.isPending || !rateValid || !from}
            onClick={() => from && setOverride.mutate({ reportId, rate, fromCurrency: from })}
          >
            {t('workbench.fxOverrideSave')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * VeloExpense (d39): one report-level warning and its reason box — see the banner that
 * mounts it. Acknowledging writes the reason through `justifyViolation` (ExpenseOS's
 * procedure, VeloExpense's `acknowledgeViolation`) and re-runs the policy pass, so the
 * submit gate and the top-bar count move with it.
 */
function ReportFindingRow({
  violation,
  label,
  onDone,
}: {
  violation: { id: string };
  label: string;
  onDone: () => void;
}) {
  const t = useTranslations('expenses');
  const refusalText = useRefusalText();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const justify = trpc.expenses.justifyViolation.useMutation({
    onSuccess: () => {
      setError(null);
      onDone();
    },
    onError: (e) => setError(refusalText(e, e.message)),
  });
  return (
    <li className="flex flex-col gap-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex items-start gap-2">
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('workbench.reportFindingsPlaceholder')}
          aria-label={label}
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={justify.isPending || !note.trim()}
          onClick={() => justify.mutate({ violationId: violation.id, note: note.trim() })}
        >
          {t('approvals.acknowledge')}
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </li>
  );
}
