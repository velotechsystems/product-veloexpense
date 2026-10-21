'use client';

/**
 * The workspace's 380 px panel (FR-2 step 3), top to bottom: the title, the Previous
 * routes dropdown, From / stops / To, one status line, the routes as a radio group of
 * cards, and the footer the modal hands in.
 *
 * The Previous routes dropdown offers previous routes only — no New route, since this is
 * the workspace a new route is made in (FR-6 step 2) — so with none to offer neither it nor
 * its label is rendered (FR-6 step 3), not hidden with CSS. Its block's `mb-2` adds 8 px to
 * the scroller's 12 px `gap-3` (and the sheet's inner `gap-3`): 20 px above From, on
 * desktop and on the phone sheet alike (FR-6 step 4); it goes with the block.
 *
 * The panel is the whole flow without the map (FR-9, NFR-12): every action the map offers
 * except dragging has its control here. The cards are a single-choice radio group named
 * by the dialog title, each card named by its label, distance and drive time, and the
 * chosen card told apart by a heavier border and a check icon as well as colour.
 *
 * Under the cards, the pass-through points (FR-4, NFR-12): the hint that says how to add
 * one (only with a map, worded for the pointer in use), why the last change was not kept,
 * and a list with a uniquely named remove control per point — the panel equivalent of a
 * click on its marker. A point is named by the named stops it lies between, never by its
 * coordinates. A reopened route's point Google could not place (FR-4 3.A, 3.B) is listed
 * like the others, says it is not on the map, and keeps its remove control: it has no
 * marker, so the panel is the only way to remove it, by keyboard as by pointer.
 *
 * On a phone (767 px and narrower) with a map, the modal hands the map in as `map` and the
 * panel becomes the whole sheet, top to bottom: the inputs, the map, the status line, the
 * route list DOCKED BELOW the map behind a handle, and the footer (FR-2 1.A). The list is
 * an in-flow sibling after the map, never laid over it, so Google's logo and attribution
 * at the map's bottom corners stay visible (Paralegal B5). The handle is a plain button
 * with `aria-expanded` and `aria-controls`; it has no drag gesture, so it cannot compete
 * with a pan, a pinch or the long-press on the line. The list opens by itself once, the
 * first time more than one route arrives and the filer has not used the handle yet;
 * after that only the filer opens or closes it. The body is one scroll container under
 * the title and above the footer: when the inputs, the map at its 28dvh floor and the open
 * list do not fit, the body scrolls and Use this route stays where it is. The same
 * elements render at the same places in both layouts (the phone-only wrappers are
 * `display: contents` on desktop), so crossing the breakpoint keeps the typed stops.
 */

import { Button, cn, Radio, RadioGroup } from '@expenseos/design-system';
import { IconChevronDown, IconChevronUp, IconCircleCheckFilled, IconX } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import {
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { MAX_ROUTE_STOPS, metersToDistance, type RouteStop } from '@/lib/mileageRouteSchema';
import { RouteSelect } from './RouteSelect';
import { RouteStopRows } from './RouteStopRows';
import type {
  PickerRoute,
  PointNotice,
  PreviousRoute,
  ReopenFallback,
  WorkspacePhase,
  WorkspacePoint,
  WorkspaceRow,
} from './routeWorkspace';

/** Whole minutes for a drive time, split for the "about 3 h 42 min" message. */
export function driveTimeParts(seconds: number): { hours: number; minutes: number } {
  // A drive under 30 s still takes "about 1 min"; "about 0 min" is not a drive.
  const total = Math.max(1, Math.round(seconds / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** A route's name on its card and on the map: Google's label, else "Route n" (1-based). */
export function routeName(
  t: ReturnType<typeof useTranslations<'expenses'>>,
  route: PickerRoute,
): string {
  // The fallback is display text in the reader's language — never stored.
  return route.label
    ? t('route.picker.via', { label: route.label })
    : t('route.picker.routeN', { n: route.index + 1 });
}

type Translate = ReturnType<typeof useTranslations<'expenses'>>;

/** The named stops a point lies between: the ends of its leg. */
function pointEnds(rows: readonly WorkspaceRow[], point: Pick<WorkspacePoint, 'leg'>) {
  return {
    from: rows[point.leg]?.stop.description ?? '',
    to: rows[point.leg + 1]?.stop.description ?? '',
  };
}

/**
 * A point's accessible name, "Remove point 2 (between Kingston and Ottawa)": unique, so a
 * voice-control user can say it, and the same words as its marker's tooltip.
 */
export function pointName(
  t: Translate,
  rows: readonly WorkspaceRow[],
  point: Pick<WorkspacePoint, 'leg'>,
  position: number,
): string {
  return t('route.removePoint', { n: position + 1, ...pointEnds(rows, point) });
}

export interface RouteWorkspacePanelProps {
  titleId: string;
  /** The dialog title, rendered at the top of the panel. */
  title: ReactNode;
  previous: readonly PreviousRoute[];
  onPrevious: (entry: PreviousRoute) => void;
  rows: readonly WorkspaceRow[];
  onSetStop: (index: number, stop: RouteStop) => void;
  onInsertAfter: (index: number) => void;
  onRemove: (index: number) => void;
  fromRef?: Ref<HTMLInputElement>;
  routes: readonly PickerRoute[];
  names: readonly string[];
  selected: number | null;
  onSelect: (index: number) => void;
  unit: 'KM' | 'MI';
  /** Number each card to match its line on the map; false with no map. */
  badges: boolean;
  phase: WorkspacePhase;
  error: string | null;
  /** The cards hold only a stored route (D3): say how to get alternatives. */
  storedOnly: boolean;
  /** Every row holds a picked place. */
  complete: boolean;
  onRetry: () => void;
  /** No map is shown: the "Map unavailable" line (FR-9). */
  mapUnavailable: boolean;
  /** Read aloud for a pick made on the map, which moves no focus. */
  announcement: string;
  disabled?: boolean;
  /** The pass-through points, in route order. */
  points: readonly WorkspacePoint[];
  onRemovePoint: (index: number) => void;
  /** A drop or a move is still on its way to a place and a route: no other point change. */
  pointsLocked?: boolean;
  /** Say how to add a point: a map is shown with a selected route on it. */
  pointsHint: boolean;
  /** Why the last point change was not kept, or the 25 limit refusing one. */
  pointNotice: PointNotice | null;
  /** The reopened route could not be drawn with its points: routed by its stops (FR-4 2.A). */
  reopenFallback?: ReopenFallback | null;
  footer: ReactNode;
  /**
   * The map, on a phone only: given, the panel is the whole phone sheet with the map
   * between the inputs and the docked route list. On desktop the map is the modal's right
   * column and this is omitted.
   */
  map?: ReactNode;
}

/** The selected route's distance, as its card states it. */
function distanceOf(t: Translate, route: PickerRoute, unit: 'KM' | 'MI'): string {
  return t('line.distanceValue', {
    distance: metersToDistance(route.totalMeters, unit),
    unit: t(unit === 'KM' ? 'line.km' : 'line.mi'),
  });
}

export function RouteWorkspacePanel(p: RouteWorkspacePanelProps) {
  const t = useTranslations('expenses');
  const previousId = useId();
  const listId = useId();
  const cardsRef = useRef<HTMLDivElement>(null);

  /** The phone sheet: the map is here, and the route list docks below it. */
  const sheet = Boolean(p.map);
  const chosen = p.routes.find((r) => r.index === p.selected);
  const chosenAt = p.routes.findIndex((r) => r.index === p.selected);
  const [expanded, setExpanded] = useState(false);
  /** The handle was used, or the list already opened by itself: no more automatic moves. */
  const settled = useRef(false);
  const offered = p.routes.length;
  useEffect(() => {
    if (!sheet || settled.current || offered < 2) return;
    settled.current = true;
    setExpanded(true);
  }, [sheet, offered]);
  const toggle = () => {
    settled.current = true;
    setExpanded((open) => !open);
  };
  /** With no route to sum up there is no handle, and nothing in the list to hide. */
  const handle = sheet && chosen !== undefined;
  const listHidden = handle && !expanded;

  return (
    <section
      aria-label={t('route.picker.panelLabel')}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 md:h-full"
    >
      {/* `pr-8` keeps the title clear of the dialog's own close button. */}
      <div className="shrink-0 pr-8">{p.title}</div>

      {/* The middle scrolls; the title and the footer never do, so Use this route stays
          in reach however many stops and routes there are. */}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-y-auto',
          sheet ? 'gap-2 overscroll-contain' : 'gap-3',
        )}
      >
        <div className={sheet ? 'flex shrink-0 flex-col gap-3' : 'contents'}>
          {p.previous.length > 0 && (
            <div className="mb-2 flex flex-col gap-1">
              <label htmlFor={previousId} className="text-muted-foreground text-xs">
                {t('route.previousRoutes')}
              </label>
              <RouteSelect
                entries={p.previous}
                includeNewRoute={false}
                onPrevious={p.onPrevious}
                disabled={p.disabled}
                triggerId={previousId}
                placeholder={t('route.dropdownPlaceholder')}
              />
            </div>
          )}

          <RouteStopRows
            rows={p.rows}
            onSetStop={p.onSetStop}
            onInsertAfter={p.onInsertAfter}
            onRemove={p.onRemove}
            disabled={p.disabled}
            fromRef={p.fromRef}
            pointCount={p.points.length}
          />
        </div>

        {p.map}

        {p.mapUnavailable && (
          <p className="text-muted-foreground text-xs">{t('route.picker.mapUnavailable')}</p>
        )}
        {p.reopenFallback && <ReopenFallbackLine fallback={p.reopenFallback} />}
        <StatusLine {...p} />
        <p role="status" className="sr-only">
          {p.announcement}
        </p>
        {/* On the sheet a refused or failed drop is said under the map, where the finger
            was, and stays visible with the list closed. */}
        {sheet && p.pointNotice && <PointNoticeLine notice={p.pointNotice} />}

        <div
          data-testid={sheet ? 'route-sheet' : undefined}
          className={sheet ? 'flex shrink-0 flex-col gap-2' : 'contents'}
        >
          {handle && chosen && (
            <SheetHandle
              listId={listId}
              expanded={expanded}
              onToggle={toggle}
              name={p.names[chosenAt] ?? ''}
              detail={t('route.picker.sheetDetail', {
                distance: distanceOf(t, chosen, p.unit),
                count: offered,
              })}
            />
          )}
          <div
            id={listId}
            hidden={listHidden}
            className={cn(sheet ? 'flex flex-col gap-3' : 'contents', listHidden && 'hidden')}
          >
            {p.routes.length > 0 && (
              <RadioGroup
                ref={cardsRef}
                aria-labelledby={p.titleId}
                value={p.selected}
                onValueChange={(v) => {
                  if (typeof v === 'number') p.onSelect(v);
                }}
                className="flex flex-col gap-2 space-y-0"
              >
                {p.routes.map((route, i) => (
                  <RouteCard
                    key={route.index}
                    route={route}
                    name={p.names[i] ?? ''}
                    unit={p.unit}
                    selected={route.index === p.selected}
                    badge={p.badges && p.routes.length > 1 ? i + 1 : null}
                    dimmed={p.phase === 'loading'}
                  />
                ))}
              </RadioGroup>
            )}

            <PointsSection {...p} cardsRef={cardsRef} noticeElsewhere={sheet} />
          </div>
        </div>
      </div>

      <div className="shrink-0">{p.footer}</div>
    </section>
  );
}

/**
 * The phone sheet's handle: the selected route and how many are on offer, and a chevron.
 * A native button, so Enter and Space work and it is announced with its state; its name
 * is its visible text (WCAG 2.5.3), and `aria-expanded` says whether the list is open.
 */
function SheetHandle({
  listId,
  expanded,
  onToggle,
  name,
  detail,
}: {
  listId: string;
  expanded: boolean;
  onToggle: () => void;
  name: string;
  detail: string;
}) {
  const Chevron = expanded ? IconChevronDown : IconChevronUp;
  return (
    <button
      type="button"
      data-testid="route-sheet-toggle"
      aria-expanded={expanded}
      aria-controls={listId}
      onClick={onToggle}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-left',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words font-medium text-foreground text-sm">{name}</span>
        {/* Keeps the two lines apart in the accessible name; in a flex column it takes no room. */}{' '}
        <span className="break-words text-muted-foreground text-xs tabular-nums">{detail}</span>
      </span>
      <Chevron size={18} aria-hidden className="shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * One line that says what the workspace is doing, in the one place the eye is after a pick.
 * Advice to wait is polite; something to act on ("no driving route", a lookup failure) is
 * an alert.
 */
function StatusLine({
  phase,
  error,
  storedOnly,
  complete,
  onRetry,
  disabled,
}: RouteWorkspacePanelProps) {
  const t = useTranslations('expenses.route');
  if (phase === 'loading') {
    return (
      <p role="status" className="text-muted-foreground text-xs">
        {t('calculating')}
      </p>
    );
  }
  if (phase === 'empty') {
    return (
      <p role="alert" className="text-destructive text-xs">
        {t('noRoute')}
      </p>
    );
  }
  if (phase === 'throttled' || phase === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p
          role={phase === 'throttled' ? 'status' : 'alert'}
          className="min-w-0 flex-1 text-destructive text-xs"
        >
          {phase === 'throttled' ? t('throttled') : (error ?? '')}
        </p>
        {/* VeloExpense kit: the kit's Button has no `soft`; `secondary` is its tinted fill. */}
        <Button type="button" size="sm" variant="secondary" onClick={onRetry} disabled={disabled}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (phase === 'ready' && storedOnly) {
    return (
      <p role="status" className="text-muted-foreground text-xs">
        {t('picker.storedOnly')}
      </p>
    );
  }
  if (!complete) {
    return <p className="text-muted-foreground text-xs">{t('picker.fillStops')}</p>;
  }
  return null;
}

function RouteCard({
  route,
  name,
  unit,
  selected,
  badge,
  dimmed,
}: {
  route: PickerRoute;
  name: string;
  unit: 'KM' | 'MI';
  selected: boolean;
  /** The number the map shows on this route's line; null when there is no map to match. */
  badge: number | null;
  /** A new answer is on its way: these cards describe the last one. */
  dimmed: boolean;
}) {
  const t = useTranslations('expenses');
  const nameId = useId();
  const distanceId = useId();
  const timeId = useId();

  const distance = distanceOf(t, route, unit);
  const time =
    route.durationSeconds == null
      ? null
      : t('route.picker.driveTime', driveTimeParts(route.durationSeconds));

  return (
    // A label, so a tap anywhere on the card selects its radio. The radio stays the
    // one focusable, announced control; the card's text names it.
    // biome-ignore lint/a11y/noLabelWithoutControl: the Radio nested below renders the input
    <label
      className={cn(
        'flex min-h-11 cursor-pointer items-start gap-3 rounded-md',
        'has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2',
        // Selected by weight and an icon, not by colour alone. The padding gives back
        // the extra border pixel so the text does not shift.
        selected ? 'border-2 border-primary bg-row-selected p-[11px]' : 'border border-border p-3',
        dimmed && 'opacity-60',
      )}
    >
      <Radio
        value={route.index}
        aria-labelledby={time ? `${nameId} ${distanceId} ${timeId}` : `${nameId} ${distanceId}`}
        className="mt-0.5"
      />
      {badge !== null && (
        // Matches the card to its line on the map by number, not by colour. Decorative
        // for a screen reader: the card is already named, and the map is not the way in.
        <span
          aria-hidden
          className={cn(
            'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full font-semibold text-[11px] tabular-nums',
            selected ? 'bg-brand-navy text-white' : 'bg-muted-foreground text-white',
          )}
        >
          {badge}
        </span>
      )}
      {/* The spaces between the parts are for the card's text as a label, which runs the
          spans together otherwise ("via Hwy 401187.43 km") and no longer matches the
          radio's name (axe `aria-toggle-field-name`, undecided). A flex column does not
          lay out a whitespace-only text node, so nothing on screen moves. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={nameId} className="break-words font-medium text-foreground text-sm">
          {name}
        </span>{' '}
        <span id={distanceId} className="text-foreground text-sm tabular-nums">
          {distance}
        </span>
        {time && (
          <>
            {' '}
            <span id={timeId} className="text-muted-foreground text-xs">
              {time}
            </span>
          </>
        )}
      </span>
      {selected && (
        <IconCircleCheckFilled size={18} aria-hidden className="shrink-0 text-primary" />
      )}
    </label>
  );
}

/**
 * The hint, the last refusal and the list of points. The list appears only with a point
 * in it. A removal from here moves focus to the next row's remove control, else the
 * previous one, else — the list now empty — the selected route's radio.
 */
function PointsSection({
  rows,
  points,
  onRemovePoint,
  pointsHint,
  pointNotice,
  disabled,
  pointsLocked,
  cardsRef,
  noticeElsewhere,
}: RouteWorkspacePanelProps & {
  cardsRef: RefObject<HTMLDivElement | null>;
  /** The notice is rendered outside the list (the phone sheet), not here. */
  noticeElsewhere: boolean;
}) {
  const t = useTranslations('expenses');
  const titleId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  /** The row whose control takes focus once the removal has rendered. */
  const focusNext = useRef<number | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    const controls = listRef.current?.querySelectorAll<HTMLButtonElement>('button');
    const control = controls?.[Math.min(target, controls.length - 1)];
    if (control) {
      control.focus();
      return;
    }
    cardsRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    // After every render: the removal's render is the one with `focusNext` set.
  });

  const remove = (index: number) => {
    focusNext.current = index;
    onRemovePoint(index);
  };

  return (
    <>
      {pointsHint && (
        <p className="text-muted-foreground text-xs">
          {/* Worded for the pointer in use: a finger presses and holds. */}
          <span className="pointer-coarse:hidden">{t('route.pointsHint')}</span>
          <span className="pointer-coarse:inline hidden">{t('route.pointsHintTouch')}</span>
        </p>
      )}
      {pointNotice && !noticeElsewhere && <PointNoticeLine notice={pointNotice} />}
      {points.length > 0 && (
        <section aria-labelledby={titleId} className="flex flex-col gap-1">
          <h3 id={titleId} className="font-medium text-foreground text-xs">
            {t('route.pointsTitle')}
          </h3>
          <ol ref={listRef} className="flex flex-col">
            {points.map((point, i) => (
              <li key={point.id} className="flex min-h-11 items-center gap-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-foreground text-sm">
                    {t('route.pointLabel', { n: i + 1 })}
                  </span>
                  <span className="break-words text-muted-foreground text-xs">
                    {t('route.pointBetween', pointEnds(rows, point))}
                  </span>
                  {point.unplaced && (
                    <span className="break-words text-muted-foreground text-xs">
                      {t('route.pointUnplaced')}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-11 shrink-0 p-0"
                  aria-label={pointName(t, rows, point, i)}
                  disabled={disabled || pointsLocked}
                  onClick={() => remove(i)}
                >
                  <IconX size={14} aria-hidden />
                </Button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

/**
 * Why the reopened route is shown without its points (FR-4 2.A): its own request failed or
 * found nothing, so its stops are routed alone and Use this route will not write the
 * points. An alert: what is on offer is no longer the route that was saved.
 */
function ReopenFallbackLine({ fallback }: { fallback: ReopenFallback }) {
  const t = useTranslations('expenses.route');
  const reason =
    fallback.kind === 'throttled'
      ? t('throttled')
      : fallback.kind === 'empty'
        ? t('reopenNoRoute')
        : fallback.kind === 'viaRefused'
          ? t('reopenViaRefused')
          : fallback.message;
  return (
    <p role="alert" className="text-destructive text-xs">
      {`${t('reopenFallback')} ${reason}`.trim()}
    </p>
  );
}

/**
 * Why a point change was not kept (the route is as it was), or the limit refusing a drop.
 * The limit and a throttle are advice; a failure is an alert — including the key that may
 * use neither API a drop needs, which names the API(s) an administrator must enable.
 *
 * The three drop refusals are the server's own catalog sentences (`refusals.mileage`):
 * each already says the route was left as it was.
 */
function PointNoticeLine({ notice }: { notice: PointNotice }) {
  const t = useTranslations('expenses.route');
  const refused = useTranslations('refusals.mileage');
  const text =
    notice.kind === 'maxStops'
      ? t('maxStops', { max: MAX_ROUTE_STOPS })
      : notice.kind === 'throttled'
        ? `${t('pointsUnchanged')} ${t('throttled')}`
        : notice.kind === 'empty'
          ? `${t('pointsUnchanged')} ${t('noRoute')}`
          : notice.kind === 'noRoad'
            ? refused('noRoadNear')
            : notice.kind === 'apisOff'
              ? refused('dragApisUnavailable', { apis: notice.apis })
              : notice.kind === 'viaRefused'
                ? refused('viaPlaceRefused')
                : `${t('pointsUnchanged')} ${notice.message}`.trim();
  const advice = notice.kind === 'maxStops' || notice.kind === 'throttled';
  return (
    <p
      role={advice ? 'status' : 'alert'}
      className={cn('text-xs', advice ? 'text-muted-foreground' : 'text-destructive')}
    >
      {text}
    </p>
  );
}
