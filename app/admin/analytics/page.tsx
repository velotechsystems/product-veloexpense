/**
 * VX4-6b — /admin/analytics.
 *
 * Server component, plain `<form method="get">` for the range, and NO CLIENT JS —
 * the same constraint every screen here works under (the receipt drawer is the
 * only exception in the product). Charts are therefore server-rendered inline
 * SVG and CSS bars.
 *
 * ── The palette was computed, not chosen ────────────────────────────────────
 *
 * Two series (committed / awaiting a decision) need two hues that survive
 * colour-vision deficiency. Candidates were run through the validator rather
 * than eyeballed, against OUR surface (#ffffff) rather than a reference one:
 *
 *   sky-600 + sky-300   FAIL  lightness band (#7dd3fc L 0.83, outside 0.43-0.77)
 *   brand + sky-200     FAIL  band AND chroma floor (#bae6fd reads grey)
 *   brand-700 + sky-400 PASS  all checks; CVD dE 30.9, normal dE 31.3
 *
 * So `--vl-brand-700` (#075985) and `--vl-brand-400` (#38bdf8), both already in
 * the brand ramp. The one WARN that survives is #38bdf8 at 2.14:1 on white,
 * which obligates relief — "visible labels or a table view" — and this screen
 * ships BOTH: the stacked chart carries a legend and a direct label, and every
 * dimension below is a real table with numbers in it.
 *
 * DARK MODE IS NOT A SEPARATE PALETTE HERE, and that is a finding rather than a
 * shortcut: `--background` and `--card` are `var(--vl-white)`, and the dark block
 * in `app/velotech-tokens.css` does not redefine `--vl-white`. The chart surface
 * is #ffffff in both modes, so the palette validated against white IS the dark
 * palette. Validating a second one against a surface nothing renders on would be
 * paperwork. This is the same partial-dark-mode gap as the `--accent-foreground`
 * defect already pinned in `test/branding-color.test.ts`.
 *
 * ── Forms chosen by the data's job ──────────────────────────────────────────
 *
 * · Three headline numbers -> STAT TILES. "Eight categorical hues when the story
 *   is one number" is the most common way a chart misses its point, and a
 *   one-bar bar chart is worse than the number.
 * · Spend over ordered time, split two ways -> STACKED VERTICAL BARS, with a 2px
 *   surface gap between the segments rather than a border around them, and a 4px
 *   rounded top on the stack only (data-ends are rounded, baselines are not).
 * · Ranked breakdowns -> horizontal bars INSIDE a table. One series per bar means
 *   one colour for every bar: a darker-where-bigger ramp would double-encode
 *   length as hue and burn the only free channel on what the bar already says.
 * · Direct labels are SELECTIVE — the biggest month only. "A number on every data
 *   point is chaos and goes unread."
 * · The hover layer is an SVG `<title>` per segment: a native tooltip, no script.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMinor } from '@/lib/money';
import { readerPrefs } from '@/lib/i18n/request';
import { getAnalyticsPage } from './actions';
import type { SpendSlice } from '@/lib/analytics/service';
import { EmptyRow, ErrorBanner, cardClass, fieldClass, labelClass } from '@/app/expenses/ui';

export const dynamic = 'force-dynamic';

/** Validated: see the header. Committed is the darker, settled one. */
const COMMITTED = '#075985';
const PENDING = '#38bdf8';

function bigger(a: bigint, b: bigint) {
  return a > b ? a : b;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-02` -> `Feb`, and `Feb` again in January of the next year is why the year
 * is appended when the range spans one.
 *
 * The first draft printed `label.slice(5)` — a bare `02`, which is a month number
 * a reader has to decode and cannot tell from a day.
 */
function monthLabel(label: string): string {
  const [year, month] = label.split('-');
  const name = MONTHS[Number(month) - 1] ?? label;
  return `${name} ’${year.slice(2)}`;
}

/** A path with only its TOP corners rounded — a data-end is rounded, a baseline is not. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h, w / 2);
  return [
    `M ${x} ${y + h}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `L ${x + w - radius} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + radius}`,
    `L ${x + w} ${y + h}`,
    'Z',
  ].join(' ');
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const prefs = await readerPrefs();
  const sp = await searchParams;
  const { moduleEnabled, summary, problem } = await getAnalyticsPage(sp.from, sp.to);

  const money = (v: bigint | string) =>
    summary ? formatMinor(v, summary.baseCurrency, summary.baseMinorUnit, prefs.locale) : '—';

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Spend analytics</h1>
          <p className="text-sm text-muted-foreground">
            Approved and in-flight spend across the whole organization, in your reporting currency.
          </p>
        </div>
        <Link href="/admin/modules" className="text-sm underline underline-offset-4">
          Modules
        </Link>
      </div>

      <ErrorBanner message={problem ?? undefined} />

      {!moduleEnabled ? (
        <section className={`${cardClass} p-5 text-sm`} data-testid="analytics-module-off">
          <p className="font-medium">The Analytics module is off for this organization.</p>
          <p className="mt-1 text-muted-foreground">
            Nothing is aggregated while it is — every report still goes through policy, approval and
            reimbursement exactly as before.{' '}
            <Link href="/admin/modules" className="underline underline-offset-4">
              Turn it on
            </Link>{' '}
            to see spend summarised here.
          </p>
        </section>
      ) : null}

      {/* ── the range: one row of filters above the charts ─────────────────── */}
      {moduleEnabled ? (
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className={fieldClass}>
            <label className={labelClass} htmlFor="from">
              From
            </label>
            <Input id="from" name="from" type="date" defaultValue={summary?.range.from ?? ''} />
          </div>
          <div className={fieldClass}>
            <label className={labelClass} htmlFor="to">
              To
            </label>
            <Input id="to" name="to" type="date" defaultValue={summary?.range.to ?? ''} />
          </div>
          <Button type="submit">Show</Button>
          <p className="max-w-md pb-2 text-xs text-muted-foreground">
            A range is required. This screen defaults to the year so far; the query itself refuses
            to invent one, so nothing can ask for all of history by accident.
          </p>
        </form>
      ) : null}

      {summary ? (
        <>
          {/* ── stat tiles ─────────────────────────────────────────────────── */}
          <section className="grid gap-3 sm:grid-cols-3">
            <div className={`${cardClass} p-4`} data-testid="kpi-committed">
              {/* The number wears a TEXT token, never the series colour — a
                  headline is not a mark, and colouring it makes the ink carry
                  identity the swatch beside the label already carries. */}
              <div className="text-2xl font-semibold tracking-tight">
                {money(summary.committedMinor)}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: COMMITTED }}
                />
                Approved and paid
              </div>
            </div>
            <div className={`${cardClass} p-4`} data-testid="kpi-pending">
              <div className="text-2xl font-semibold tracking-tight">
                {money(summary.pendingMinor)}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: PENDING }}
                />
                Awaiting a decision
              </div>
            </div>
            <div className={`${cardClass} p-4`}>
              <div className="text-2xl font-semibold tracking-tight">
                {summary.range.from} → {summary.range.to}
              </div>
              <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
                Range
              </div>
            </div>
          </section>

          {/* ── AN-7 made visible ──────────────────────────────────────────── */}
          {Object.keys(summary.unconvertible.byCurrency).length > 0 ? (
            <section
              className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm"
              data-testid="analytics-unconvertible"
            >
              <p className="font-medium">
                Some spend is not in the figures above, because there is no exchange rate for it.
              </p>
              <p className="mt-1 text-muted-foreground">
                {Object.entries(summary.unconvertible.byCurrency)
                  .map(
                    ([code, minor]) =>
                      // Formatted in ITS OWN currency, with that currency's own
                      // minor unit. The first draft printed "7700 minor units of
                      // USD", which is a number no reader of this screen thinks in.
                      // No trailing code: `formatMinor` already prefixes one
                      // ("US$77.00"), and "US$77.00 USD" says it twice.
                      formatMinor(minor, code, summary.unconvertible.minorUnits[code] ?? 2, prefs.locale),
                  )
                  .join(', ')}{' '}
                could not be valued in {summary.baseCurrency}. It is counted here and nowhere else —
                adding the missing rates on the policy screen brings it into the totals. A figure
                that quietly absorbed it would read as a smaller, confident number.
              </p>
            </section>
          ) : null}

          {/* ── spend by month: stacked bars ───────────────────────────────── */}
          <section className={`${cardClass} p-5`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                By month
              </h2>
              {/* A legend is always present for two series, so identity is never
                  colour-alone. */}
              <ul className="flex gap-4 text-xs text-muted-foreground">
                <li className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: COMMITTED }}
                  />
                  Approved and paid
                </li>
                <li className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: PENDING }}
                  />
                  Awaiting a decision
                </li>
              </ul>
            </div>

            {summary.byMonth.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">
                No spend in this range. That is an answer, not an empty chart.
              </p>
            ) : (
              <MonthChart slices={summary.byMonth} money={money} />
            )}
          </section>

          {/* ── the breakdowns: bars inside real tables ────────────────────── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown title="By category" slices={summary.byCategory} money={money} testid="by-category" />
            <Breakdown title="By GL account" slices={summary.byGlAccount} money={money} testid="by-gl-account" />
            <Breakdown title="By department" slices={summary.byDepartment} money={money} testid="by-department" />
            <Breakdown title="By business unit" slices={summary.byBusinessUnit} money={money} testid="by-business-unit" />
            <Breakdown title="By submitter" slices={summary.bySubmitter} money={money} testid="by-submitter" />
          </div>
        </>
      ) : null}
    </main>
  );
}

/* ── the month chart ───────────────────────────────────────────────────────── */

function MonthChart({
  slices,
  money,
}: {
  slices: SpendSlice[];
  money: (v: bigint) => string;
}) {
  const W = 720;
  const H = 220;
  const PAD_B = 26;
  const PAD_T = 22;
  const totals = slices.map((s) => s.committedMinor + s.pendingMinor);
  const max = totals.reduce(bigger, 1n);
  const step = W / slices.length;
  // THIN marks. 44px looked like a toy at full width — "thick saturated blocks
  // read loud, even childish, at scale" — and a saturated fill belongs on a small
  // mark, not a large block. Found by rendering it and looking, which the colour
  // validator cannot do for you.
  const barW = Math.min(22, step * 0.45);
  const plot = H - PAD_B - PAD_T;
  // Bigints, scaled to pixels through Number only at the very end — the amounts
  // themselves never become floats.
  const px = (v: bigint) => Number((v * BigInt(Math.round(plot * 100))) / max) / 100;
  const biggest = totals.reduce((best, t, i) => (t > totals[best] ? i : best), 0);

  return (
    <figure className="mt-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Spend by month, approved and awaiting a decision"
      >
        {/* A solid hairline baseline, one shade off the surface. Never dashed —
            dashing reads as "projection" when it is just a rule. */}
        <line
          x1="0"
          y1={H - PAD_B}
          x2={W}
          y2={H - PAD_B}
          stroke="var(--vl-ink-200, #e2e8f0)"
          strokeWidth="1"
        />
        {slices.map((s, i) => {
          const cx = i * step + (step - barW) / 2;
          const committed = px(s.committedMinor);
          const pending = px(s.pendingMinor);
          const GAP = pending > 0 && committed > 0 ? 2 : 0;
          const baseY = H - PAD_B;
          const committedY = baseY - committed;
          const pendingY = committedY - GAP - pending;
          const total = s.committedMinor + s.pendingMinor;
          return (
            <g key={s.key ?? s.label}>
              {/* The committed segment sits on the baseline, so its corners are
                  square. Only the top of the stack is a data-end. */}
              {committed > 0 ? (
                <>
                  {pending > 0 ? (
                    <rect x={cx} y={committedY} width={barW} height={committed} fill={COMMITTED}>
                      <title>{`${s.label} · approved and paid ${money(s.committedMinor)}`}</title>
                    </rect>
                  ) : (
                    <path d={topRounded(cx, committedY, barW, committed, 4)} fill={COMMITTED}>
                      <title>{`${s.label} · approved and paid ${money(s.committedMinor)}`}</title>
                    </path>
                  )}
                </>
              ) : null}
              {pending > 0 ? (
                <path d={topRounded(cx, pendingY, barW, pending, 4)} fill={PENDING}>
                  <title>{`${s.label} · awaiting a decision ${money(s.pendingMinor)}`}</title>
                </path>
              ) : null}
              {/* SELECTIVE direct label: the biggest month, and only it. */}
              {i === biggest && total > 0n ? (
                <text
                  x={cx + barW / 2}
                  y={Math.min(committedY, pendingY) - 6}
                  textAnchor="middle"
                  fontSize="11"
                  fill="var(--vl-ink-700, #334155)"
                >
                  {money(total)}
                </text>
              ) : null}
              <text
                x={cx + barW / 2}
                y={H - PAD_B + 15}
                textAnchor="middle"
                fontSize="10"
                fill="var(--vl-ink-500, #64748b)"
              >
                {monthLabel(s.label)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-xs text-muted-foreground">
        Every month is valued at the exchange rates that applied to its own spend, so a rate
        published later does not move an earlier bar.
      </figcaption>
    </figure>
  );
}

/* ── a ranked breakdown, which is also the table view ──────────────────────── */

function Breakdown({
  title,
  slices,
  money,
  testid,
}: {
  title: string;
  slices: SpendSlice[];
  money: (v: bigint) => string;
  testid: string;
}) {
  const max = slices.reduce((m, s) => bigger(m, s.committedMinor + s.pendingMinor), 1n);
  const pct = (v: bigint) => Number((v * 10000n) / max) / 100;

  return (
    <section className={`${cardClass} overflow-hidden`} data-testid={testid}>
      <h2 className="px-4 pt-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <table className="mt-2 w-full text-sm">
        {/* One cell per row carries the label, both figures and the bar, so the
            header is a single column. A three-column header over one-column rows
            is the kind of markup a screen reader reads back as nonsense. */}
        <thead className="sr-only">
          <tr>
            <th>Name and amounts</th>
          </tr>
        </thead>
        <tbody>
          {slices.length === 0 ? (
            <EmptyRow colSpan={1}>Nothing in this range.</EmptyRow>
          ) : (
            slices.map((s) => (
              <tr key={s.key ?? s.label} className="border-t border-border">
                <td className="px-4 py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span>{s.label}</span>
                    {/* Values wear TEXT tokens, never the series colour — the bar
                        beside them carries identity. */}
                    <span className="tabular-nums text-muted-foreground">
                      {money(s.committedMinor)}
                      {s.pendingMinor > 0n ? ` + ${money(s.pendingMinor)} pending` : ''}
                    </span>
                  </div>
                  {/* One series, one colour for every bar. A darker-where-bigger
                      ramp would double-encode length as hue. */}
                  <div className="mt-1 flex h-1.5 gap-[2px]">
                    <div
                      style={{
                        width: `${pct(s.committedMinor)}%`,
                        background: COMMITTED,
                        borderRadius: '0 4px 4px 0',
                      }}
                    />
                    {s.pendingMinor > 0n ? (
                      <div
                        style={{
                          width: `${pct(s.pendingMinor)}%`,
                          background: PENDING,
                          borderRadius: '0 4px 4px 0',
                        }}
                      />
                    ) : null}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
