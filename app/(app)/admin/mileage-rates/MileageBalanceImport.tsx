// biome-ignore-all lint/correctness/useExhaustiveDependencies: column cells read component state through render-stable helpers; the memo deps list the state they read.
'use client';

/**
 * Importing year-to-date mileage from Concur — the drawer behind "Import year-to-date
 * mileage" on the mileage-rates page.
 *
 * Mileage is banded on what a person has claimed this calendar year, and everybody
 * arrives in ExpenseOS part-way through it. Concur's year-to-date export says how far
 * each person has already been paid for; uploading it starts their bands from there.
 *
 * The file is read in the browser (`lib/mileageBalanceImport`) and never uploaded.
 * `mileageBalances.preview` matches each name to a person and compares the file with
 * the upload in force; nothing is written until somebody has looked at that and
 * pressed commit. Each upload SUPERSEDES the previous one for the year, so a person in
 * the old file and absent from the new one loses their carried-over distance — which
 * is why "dropped" is listed by name before the button, not after.
 */
import {
  Alert,
  AlertDescription,
  Badge,
  type BadgeProps,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  Field as FormField,
  Input,
} from '@expenseos/design-system';
import { IconArrowLeft, IconUpload } from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useTableLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { Tabs } from '@/components/Tabs';
import { UserCombobox } from '@/components/pickers/EntityPickers';
import { type MileageBalanceRow, parseMileageBalances } from '@/lib/mileageBalanceImport';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';

type Outputs = inferRouterOutputs<AppRouter>['mileageBalances'];
type Preview = Outputs['preview'];
type PreviewRow = Preview['rows'][number];
type CommitResult = Outputs['commit'];
type ImportRow = Outputs['imports'][number];
type DetailRow = Outputs['importDetail'][number];

const SOURCE = 'concur' as const;

/** What the person running the import has decided about one row of the file. */
export interface Decision {
  userId: string | null;
  label: string | null;
  skip: boolean;
  /** Chosen by hand — a re-check of the file keeps it rather than re-seeding. */
  manual: boolean;
  /** The picker is open on a row that already has somebody. */
  editing: boolean;
}

const UNDECIDED: Decision = {
  userId: null,
  label: null,
  skip: false,
  manual: false,
  editing: false,
};

// VeloExpense: the vendored kit's Badge has no `info` variant, so ExpenseOS's two `info`
// badges (car allowance, a person chosen by hand) use `default`, the kit's brand tint.
const MATCH_VARIANT: Record<PreviewRow['match']['status'], BadgeProps['variant']> = {
  remembered: 'success',
  matched: 'success',
  ambiguous: 'warning',
  unmatched: 'destructive',
};

const day = (d: string | Date | null | undefined): string =>
  d ? new Date(d).toISOString().slice(0, 10) : '';

/** Seed each row from its match, keeping whatever was already chosen by hand. */
export function seedDecisions(
  preview: Preview,
  previous: Record<number, Decision>,
): Record<number, Decision> {
  const names = new Map(preview.people.map((p) => [p.id, p.name] as const));
  const next: Record<number, Decision> = {};
  preview.rows.forEach((r, i) => {
    const kept = previous[i];
    if (kept?.manual) {
      next[i] = kept;
      return;
    }
    const userId = 'userId' in r.match ? r.match.userId : null;
    next[i] = { ...UNDECIDED, userId, label: userId ? (names.get(userId) ?? null) : null };
  });
  return next;
}

export interface ImportSummary {
  resolved: number[];
  unresolved: number;
  skipped: number;
  duplicateIds: Set<string>;
  added: number;
  changed: number;
  dropped: { userId: string; distance: string }[];
}

/** Everything the summary strip and the commit guard need, from the decisions. */
export function summarize(preview: Preview, decisions: Record<number, Decision>): ImportSummary {
  const resolved: number[] = [];
  let unresolved = 0;
  let skipped = 0;
  const seen = new Map<string, number>();
  preview.rows.forEach((_, i) => {
    const d = decisions[i] ?? UNDECIDED;
    if (d.skip) skipped += 1;
    else if (d.userId) {
      resolved.push(i);
      seen.set(d.userId, (seen.get(d.userId) ?? 0) + 1);
    } else unresolved += 1;
  });
  const duplicateIds = new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id));
  const before = new Map(
    (preview.current?.balances ?? []).map((b) => [b.userId, b.distance] as const),
  );
  let added = 0;
  let changed = 0;
  for (const i of resolved) {
    const userId = decisions[i].userId as string;
    const was = before.get(userId);
    if (was === undefined) added += 1;
    else if (Number(was) !== Number(preview.rows[i].distance)) changed += 1;
  }
  const dropped = (preview.current?.balances ?? []).filter((b) => !seen.has(b.userId));
  return { resolved, unresolved, skipped, duplicateIds, added, changed, dropped };
}

export function MileageBalanceImportDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('admin.mileageBalances');
  const [tab, setTab] = useState<'import' | 'history'>('import');
  const [historyYear, setHistoryYear] = useState(() => new Date().getUTCFullYear());

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width={1040} resizable storageKey="admin.mileageBalances">
        <DrawerHeader>
          <DrawerTitle className="truncate">{t('title')}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <Tabs
            value={tab}
            onChange={setTab}
            ariaLabel={t('title')}
            tabs={[
              { value: 'import', label: t('tabImport') },
              { value: 'history', label: t('tabHistory') },
            ]}
          />
          {tab === 'import' ? (
            <ImportPanel onYear={setHistoryYear} />
          ) : (
            <HistoryPanel year={historyYear} onYearChange={setHistoryYear} />
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

// ── Import ──────────────────────────────────────────────────────────

type ReviewColumn = 'name' | 'person' | 'distance' | 'previous' | 'rate' | 'flags';
type ReviewRow = PreviewRow & { index: number };

function ImportPanel({ onYear }: { onYear: (year: number) => void }) {
  const t = useTranslations('admin.mileageBalances');
  const locale = useLocale();
  const tableLabels = useTableLabels();
  const utils = trpc.useUtils();

  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<MileageBalanceRow[]>([]);
  const [periodEnd, setPeriodEnd] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [result, setResult] = useState<CommitResult | null>(null);

  const previewMut = trpc.mileageBalances.preview.useMutation({
    onSuccess: (res) => setDecisions((prev) => seedDecisions(res, prev)),
  });
  const commitMut = trpc.mileageBalances.commit.useMutation({
    onSuccess: (res) => {
      setResult(res);
      setParsed([]);
      setFileName(null);
      setDecisions({});
      previewMut.reset();
      void utils.mileageBalances.imports.invalidate();
      // A commit can open, replace or close car-allowance rules.
      void utils.policies.mileageRate.list.invalidate();
    },
  });

  const preview = previewMut.data;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(periodEnd);
  const year = validDate ? Number(periodEnd.slice(0, 4)) : null;

  const runPreview = (rows: MileageBalanceRow[], asOf: string, filename: string) => {
    if (rows.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return;
    const y = Number(asOf.slice(0, 4));
    onYear(y);
    previewMut.mutate({
      source: SOURCE,
      year: y,
      asOf,
      filename,
      rows: rows.map(({ name, distance, paidRate, amount }) => ({
        name,
        distance,
        paidRate,
        amount,
      })),
    });
  };

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileName(file.name);
    setParseError(null);
    setResult(null);
    setParsed([]);
    setDecisions({});
    previewMut.reset();
    try {
      const res = parseMileageBalances(new Uint8Array(await file.arrayBuffer()));
      if (res.error) {
        setParseError(t(`parseError.${res.error}`));
        return;
      }
      setParsed(res.rows);
      setPeriodEnd(res.periodEnd ?? '');
      if (res.periodEnd) runPreview(res.rows, res.periodEnd, file.name);
    } catch {
      setParseError(t('parseError.unreadable'));
    }
  }

  const summary = preview ? summarize(preview, decisions) : null;
  const names = useMemo(
    () => new Map((preview?.people ?? []).map((p) => [p.id, p.name] as const)),
    [preview],
  );
  const before = useMemo(
    () => new Map((preview?.current?.balances ?? []).map((b) => [b.userId, b.distance] as const)),
    [preview],
  );
  const km = (v: string | number) =>
    Number(v).toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const decide = (index: number, patch: Partial<Decision>) =>
    setDecisions((prev) => ({
      ...prev,
      [index]: { ...(prev[index] ?? UNDECIDED), ...patch },
    }));

  /** Why commit is off, in the order somebody would fix it; null when it is on. */
  const blocked: string | null = !preview
    ? null
    : preview.stale
      ? t('blockStale', { current: day(preview.current?.asOf) })
      : !validDate
        ? t('blockDate')
        : (summary?.unresolved ?? 0) > 0
          ? t('blockUnresolved', { count: summary?.unresolved ?? 0 })
          : (summary?.duplicateIds.size ?? 0) > 0
            ? t('blockDuplicate', { count: summary?.duplicateIds.size ?? 0 })
            : (summary?.resolved.length ?? 0) === 0
              ? t('blockEmpty')
              : null;

  const commit = () => {
    if (!preview || !summary || blocked || !fileName || year === null) return;
    commitMut.mutate({
      source: SOURCE,
      year,
      asOf: periodEnd,
      filename: fileName,
      rows: summary.resolved.map((i) => ({
        name: preview.rows[i].name,
        userId: decisions[i].userId as string,
        distance: preview.rows[i].distance,
        paidRate: preview.rows[i].paidRate,
      })),
    });
  };

  const rows: ReviewRow[] = useMemo(
    () => (preview?.rows ?? []).map((r, index) => ({ ...r, index })),
    [preview],
  );

  const columns: ColumnDef<ReviewRow, ReviewColumn>[] = useMemo(
    () => [
      {
        id: 'name',
        label: t('colFileName'),
        defaultWidth: 200,
        hideable: false,
        cell: (r) => (
          <span className="truncate text-foreground text-sm" title={r.name}>
            {r.name}
          </span>
        ),
      },
      {
        id: 'person',
        label: t('colPerson'),
        defaultWidth: 380,
        hideable: false,
        cell: (r) => (
          <PersonCell
            row={r}
            decision={decisions[r.index] ?? UNDECIDED}
            duplicate={
              !!decisions[r.index]?.userId &&
              !decisions[r.index]?.skip &&
              (summary?.duplicateIds.has(decisions[r.index].userId as string) ?? false)
            }
            names={names}
            onDecide={(patch) => decide(r.index, patch)}
          />
        ),
      },
      {
        id: 'distance',
        label: t('colYtd'),
        defaultWidth: 110,
        cell: (r) => (
          <span className="block w-full text-right text-foreground text-sm tabular-nums">
            {km(r.distance)}
          </span>
        ),
      },
      {
        id: 'previous',
        label: t('colPrevious'),
        defaultWidth: 150,
        cell: (r) => {
          const d = decisions[r.index];
          const was = d?.userId && !d.skip ? before.get(d.userId) : undefined;
          if (was === undefined) {
            return <span className="text-muted-foreground text-xs">{t('isNew')}</span>;
          }
          const delta = Number(r.distance) - Number(was);
          return (
            <span className="block w-full text-right text-sm tabular-nums">
              {km(was)}
              <span
                className={`ml-1 text-xs ${delta === 0 ? 'text-muted-foreground' : 'text-foreground'}`}
              >
                {delta === 0 ? t('unchanged') : `${delta > 0 ? '+' : '−'}${km(Math.abs(delta))}`}
              </span>
            </span>
          );
        },
      },
      {
        id: 'rate',
        label: t('colRate'),
        defaultWidth: 160,
        cell: (r) => (
          <span className="flex items-center gap-1.5 text-sm tabular-nums">
            {r.paidRate ?? '—'}
            {r.carAllowance && (
              <Badge variant="default" title={t('carAllowanceHelp')}>
                {t('carAllowance')}
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: 'flags',
        label: t('colFlags'),
        defaultWidth: 170,
        cell: (r) =>
          r.flags.length === 0 ? (
            <span className="text-muted-foreground text-xs">—</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {r.flags.map((f) => (
                <Badge key={f} variant="warning" title={t(`flagHelp.${f}`)}>
                  {t(`flag.${f}`)}
                </Badge>
              ))}
            </span>
          ),
      },
    ],
    [t, decisions, names, before, summary, locale],
  );

  const [tableState, setTableState] = useState<DataTableState<ReviewColumn>>(() =>
    createDataTableState(columns as never, {}),
  );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">{t('intro')}</p>

      <div className="flex flex-wrap items-end gap-4">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-muted px-3 py-1.5 font-medium text-foreground text-sm hover:bg-muted/70">
          <IconUpload size={15} />
          {t('chooseFile')}
          <input
            type="file"
            aria-label={t('chooseFile')}
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={handleFile}
          />
        </label>
        {fileName && <span className="text-muted-foreground text-sm">{fileName}</span>}
        {parsed.length > 0 && (
          <FormField
            htmlFor="mb-period-end"
            label={t('periodEnd')}
            description={t('periodEndHelp')}
          >
            <Input
              id="mb-period-end"
              type="date"
              value={periodEnd}
              onChange={(e) => {
                setPeriodEnd(e.target.value);
                if (fileName) runPreview(parsed, e.target.value, fileName);
              }}
            />
          </FormField>
        )}
      </div>

      {parseError && <p className="text-destructive text-sm">{parseError}</p>}
      {parsed.length > 0 && !validDate && (
        <p className="text-destructive text-sm">{t('periodEndMissing')}</p>
      )}
      {previewMut.isPending && <p className="text-muted-foreground text-sm">{t('matching')}</p>}
      {previewMut.error && <p className="text-destructive text-sm">{previewMut.error.message}</p>}
      {commitMut.error && <p className="text-destructive text-sm">{commitMut.error.message}</p>}

      {result && <CommitOutcome result={result} />}

      {preview && summary && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-card px-3 py-2 text-sm">
            <Stat label={t('statPeople')} value={preview.rows.length} />
            <Stat label={t('statMatched')} value={summary.resolved.length} />
            <Stat label={t('statAttention')} value={summary.unresolved} warn />
            <Stat label={t('statSkipped')} value={summary.skipped} />
            <span className="h-4 w-px bg-border" />
            <Stat label={t('statNew')} value={summary.added} />
            <Stat label={t('statChanged')} value={summary.changed} />
            <Stat label={t('statDropped')} value={summary.dropped.length} warn />
            <span className="ml-auto text-muted-foreground text-xs">
              {preview.current
                ? t('supersedes', { asOf: day(preview.current.asOf) })
                : t('firstUpload')}
            </span>
          </div>

          {preview.stale && (
            <Alert variant="destructive">
              <AlertDescription>
                {t('staleHelp', { current: day(preview.current?.asOf) })}
              </AlertDescription>
            </Alert>
          )}

          {summary.dropped.length > 0 && (
            <Alert variant="warning">
              <AlertDescription>
                <p>{t('droppedHelp', { count: summary.dropped.length })}</p>
                <ul className="mt-1 list-disc pl-5">
                  {summary.dropped.map((b) => (
                    <li key={b.userId}>
                      {t('droppedItem', {
                        name: names.get(b.userId) ?? b.userId,
                        distance: km(b.distance),
                      })}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex min-h-[320px] flex-col overflow-hidden rounded-md border border-border bg-card">
            <DataTable<ReviewRow, ReviewColumn>
              columns={columns}
              rows={rows}
              rowKey={(r) => String(r.index)}
              totalCount={rows.length}
              state={tableState}
              onStateChange={setTableState}
              labels={tableLabels}
              selectable={false}
              rowHeight={56}
              disableInfiniteScroll
            />
          </div>

          <div className="flex items-center justify-end gap-3">
            {blocked && <span className="text-muted-foreground text-xs">{blocked}</span>}
            <Button disabled={blocked !== null || commitMut.isPending} onClick={commit}>
              {commitMut.isPending
                ? t('committing')
                : t('commit', { count: summary.resolved.length })}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span
        className={`font-medium tabular-nums ${warn && value > 0 ? 'text-warning' : 'text-foreground'}`}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * Who a row of the file is. A confident match shows the name with a way to change
 * it; an ambiguous one offers its candidates first, then a search; anything can be
 * skipped, which leaves that line out of the upload.
 */
function PersonCell({
  row,
  decision,
  duplicate,
  names,
  onDecide,
}: {
  row: ReviewRow;
  decision: Decision;
  duplicate: boolean;
  names: ReadonlyMap<string, string>;
  onDecide: (patch: Partial<Decision>) => void;
}) {
  const t = useTranslations('admin.mileageBalances');
  const status = decision.skip
    ? { variant: 'secondary' as const, label: t('status.skipped') }
    : duplicate
      ? { variant: 'destructive' as const, label: t('status.duplicate') }
      : decision.manual && decision.userId
        ? { variant: 'default' as const, label: t('status.chosen') }
        : { variant: MATCH_VARIANT[row.match.status], label: t(`status.${row.match.status}`) };

  const pick = (userId: string, label: string | null) =>
    onDecide({ userId, label, skip: false, manual: true, editing: false });

  let body: React.ReactNode;
  if (decision.skip) {
    body = (
      <Button variant="ghost" size="sm" onClick={() => onDecide({ skip: false, manual: true })}>
        {t('undoSkip')}
      </Button>
    );
  } else if (decision.userId && !decision.editing) {
    body = (
      <>
        <span className="min-w-0 flex-1 truncate text-foreground text-sm">
          {decision.label ?? names.get(decision.userId) ?? decision.userId}
        </span>
        <Button variant="ghost" size="sm" onClick={() => onDecide({ editing: true })}>
          {t('change')}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        {row.match.status === 'ambiguous' &&
          row.match.candidateIds.map((id) => (
            <Button
              key={id}
              variant="outline"
              size="sm"
              onClick={() => pick(id, names.get(id) ?? null)}
            >
              {names.get(id) ?? id}
            </Button>
          ))}
        <div className="min-w-40 flex-1">
          <UserCombobox
            value={decision.userId}
            initialItem={
              decision.userId && decision.label
                ? { value: decision.userId, label: decision.label }
                : null
            }
            onValueChange={(id, item) => {
              if (id) pick(id, item?.label ?? null);
            }}
            placeholder={t('pickPerson')}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDecide({ skip: true, manual: true, editing: false })}
        >
          {t('skip')}
        </Button>
      </>
    );
  }

  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <Badge variant={status.variant} className="shrink-0">
        {status.label}
      </Badge>
      {body}
    </div>
  );
}

function CommitOutcome({ result }: { result: CommitResult }) {
  const t = useTranslations('admin.mileageBalances');
  return (
    <Alert variant="success">
      <AlertDescription>
        <p>
          {t('committed', {
            people: result.people,
            moved: result.moved,
            dropped: result.dropped,
            repriced: result.repricedLines,
          })}
        </p>
        {result.carAllowances.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {result.carAllowances.map((a) => (
              <li key={a.rateMinor}>
                {t(`allowance.${a.action}`, {
                  rate: (a.rateMinor / 100).toFixed(2),
                  people: a.people,
                })}
              </li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

// ── History ─────────────────────────────────────────────────────────

type HistoryColumn = 'file' | 'asOf' | 'importedAt' | 'importedBy' | 'people' | 'status';
type DetailColumn = 'sourceName' | 'person' | 'distance' | 'paidRate';

function HistoryPanel({
  year,
  onYearChange,
}: {
  year: number;
  onYearChange: (year: number) => void;
}) {
  const t = useTranslations('admin.mileageBalances');
  const tableLabels = useTableLabels();
  const [selected, setSelected] = useState<ImportRow | null>(null);
  const query = trpc.mileageBalances.imports.useQuery({ source: SOURCE, year });
  const list = query.data ?? [];

  const columns: ColumnDef<ImportRow, HistoryColumn>[] = useMemo(
    () => [
      {
        id: 'file',
        label: t('colFile'),
        defaultWidth: 260,
        hideable: false,
        cell: (r) => <span className="truncate text-foreground text-sm">{r.filename}</span>,
      },
      {
        id: 'asOf',
        label: t('periodEnd'),
        defaultWidth: 120,
        cell: (r) => <span className="text-sm tabular-nums">{day(r.asOf)}</span>,
      },
      {
        id: 'importedAt',
        label: t('colImportedAt'),
        defaultWidth: 120,
        cell: (r) => <span className="text-sm tabular-nums">{day(r.importedAt)}</span>,
      },
      {
        id: 'importedBy',
        label: t('colImportedBy'),
        defaultWidth: 180,
        cell: (r) => <span className="truncate text-sm">{r.importedBy}</span>,
      },
      {
        id: 'people',
        label: t('statPeople'),
        defaultWidth: 90,
        cell: (r) => (
          <span className="block w-full text-right text-sm tabular-nums">{r.people}</span>
        ),
      },
      {
        id: 'status',
        label: t('colStatus'),
        defaultWidth: 180,
        cell: (r) =>
          r.inForce ? (
            <Badge variant="success">{t('inForce')}</Badge>
          ) : (
            <Badge variant="secondary">{t('supersededOn', { date: day(r.supersededAt) })}</Badge>
          ),
      },
    ],
    [t],
  );
  const [tableState, setTableState] = useState<DataTableState<HistoryColumn>>(() =>
    createDataTableState(columns as never, {}),
  );

  if (selected) return <ImportDetail entry={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3">
        <FormField htmlFor="mb-year" label={t('year')}>
          <Input
            id="mb-year"
            type="number"
            className="w-28"
            value={year}
            onChange={(e) => {
              const y = Number(e.target.value);
              if (Number.isInteger(y) && y >= 2000 && y <= 2100) onYearChange(y);
            }}
          />
        </FormField>
      </div>
      <div className="flex min-h-[240px] flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTable<ImportRow, HistoryColumn>
          columns={columns}
          rows={list}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          totalCount={list.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={setSelected}
          labels={tableLabels}
          renderEmpty={() => (
            <div className="text-muted-foreground">{t('noImports', { year })}</div>
          )}
          selectable={false}
          disableInfiniteScroll
        />
      </div>
    </div>
  );
}

function ImportDetail({ entry, onBack }: { entry: ImportRow; onBack: () => void }) {
  const t = useTranslations('admin.mileageBalances');
  const locale = useLocale();
  const tableLabels = useTableLabels();
  const query = trpc.mileageBalances.importDetail.useQuery({ id: entry.id });
  const list = query.data ?? [];

  const columns: ColumnDef<DetailRow, DetailColumn>[] = useMemo(
    () => [
      {
        id: 'sourceName',
        label: t('colFileName'),
        defaultWidth: 240,
        hideable: false,
        cell: (r) => <span className="truncate text-sm">{r.sourceName}</span>,
      },
      {
        id: 'person',
        label: t('colPerson'),
        defaultWidth: 240,
        cell: (r) => <span className="truncate text-sm">{r.user.name}</span>,
      },
      {
        id: 'distance',
        label: t('colYtd'),
        defaultWidth: 130,
        cell: (r) => (
          <span className="block w-full text-right text-sm tabular-nums">
            {Number(r.distance).toLocaleString(locale, { maximumFractionDigits: 2 })}{' '}
            {r.unit.toLowerCase()}
          </span>
        ),
      },
      {
        id: 'paidRate',
        label: t('colRate'),
        defaultWidth: 120,
        cell: (r) => <span className="text-sm tabular-nums">{r.paidRate ?? '—'}</span>,
      },
    ],
    [t, locale],
  );
  const [tableState, setTableState] = useState<DataTableState<DetailColumn>>(() =>
    createDataTableState(columns as never, {}),
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <IconArrowLeft size={14} className="mr-1" />
          {t('back')}
        </Button>
        <span className="truncate font-medium text-foreground text-sm">{entry.filename}</span>
        <span className="text-muted-foreground text-xs">
          {t('detailMeta', { asOf: day(entry.asOf), people: entry.people })}
        </span>
        {entry.inForce && <Badge variant="success">{t('inForce')}</Badge>}
      </div>
      <div className="flex min-h-[240px] flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTable<DetailRow, DetailColumn>
          columns={columns}
          rows={list}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          totalCount={list.length}
          state={tableState}
          onStateChange={setTableState}
          labels={tableLabels}
          selectable={false}
          disableInfiniteScroll
        />
      </div>
    </div>
  );
}
