// biome-ignore-all lint/correctness/useExhaustiveDependencies: admin handlers are component-scoped; t()/closures are render-stable.
/* eslint-disable react-hooks/exhaustive-deps -- VeloExpense: the same exemption as the Biome line above, for ESLint. */
'use client';

/**
 * /admin/fx-rates — currency-pair exchange rates for the policy engine's
 * currency conversion. Append-only: adding a rate inserts a new row and the
 * latest per pair wins (the table shows `fxRate.latest`). Read requires
 * config.policy.read; adding requires config.fxRate.update. Toolbar +
 * FilterPillBar + DataTable + an add drawer, per the listing UX standard.
 */
import {
  Alert,
  AlertDescription,
  Button,
  DataTableToolbar,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  FilterPillBar,
  Field as FormField,
  Input,
  TableSettingsButton,
  Textarea,
} from '@expenseos/design-system';
import type { Locale } from '@expenseos/i18n/locales';
import { IconPlus } from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { useTableLabels, useToolbarLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { trpc } from '@/lib/trpc/client';
import { useRefusalText } from '@/lib/trpc/refusal';
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
import { setTopBarSlot } from '@/app/(app)/TopBar';

type Row = { base: string; quote: string; rate: string; fetchedAt: string | Date };
type ColumnId = 'base' | 'quote' | 'rate' | 'updated';

/** What the add drawer posts. `reason` (with the explicit flag) is the correction path
 *  past the server's deviation bound; both are absent on an ordinary add. */
type AddRateInput = {
  base: string;
  quote: string;
  rate: string;
  confirmDeviation?: true;
  reason?: string;
};

/** The slice of a tRPC client error the drawer reads. `data` is optional on purpose: a
 *  transport-level failure never reaches the error formatter, so it carries no code —
 *  and no `refusal` either, which is why the English `message` stays the fallback. */
type AddRateError = {
  message: string;
  data?: {
    code?: string;
    /** Null on every error the server did not throw as a translatable refusal. */
    refusal?: { key: string; params?: Record<string, string | number> } | null;
  } | null;
} | null;

/** Shortest reason the server accepts — mirrored here so the button says so before
 *  the round-trip, not after. */
const MIN_REASON_LENGTH = 10;

export function FxRatesAdmin({ canManage }: { canManage: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('admin.fxRates');
  const locale = useLocale() as Locale;
  const tableLabels = useTableLabels();
  const utils = trpc.useUtils();

  // The table is the current rate per pair. Its history used to be a second
  // tab over the same columns — the whole append-only log for every pair at
  // once, which nobody reads that way. Clicking a pair opens its own history
  // in a drawer instead, beside the row it belongs to.
  const latestQuery = trpc.policies.fxRate.latest.useQuery();
  const rows = useMemo<Row[]>(() => latestQuery.data ?? [], [latestQuery.data]);
  const loading = latestQuery.isLoading;
  const [historyPair, setHistoryPair] = useState<{ base: string; quote: string } | null>(null);
  const invalidate = () => {
    utils.policies.fxRate.latest.invalidate();
    utils.policies.fxRate.history.invalidate();
  };
  const add = trpc.policies.fxRate.add.useMutation({ onSuccess: invalidate });

  const [adding, setAdding] = useState(false);

  // "Add rate" lives in the app-shell top bar (mirrors the other admin lists).
  useEffect(() => {
    setTopBarSlot(
      'right',
      canManage ? (
        <Button size="sm" onClick={() => setAdding(true)}>
          <IconPlus size={15} className="mr-1.5" />
          {t('add')}
        </Button>
      ) : null,
    );
    return () => setTopBarSlot('right', null);
  }, [t, canManage]);

  const fmtDate = (d: string | Date): string =>
    new Date(d).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });

  const columns = useMemo<ColumnDef<Row, ColumnId>[]>(
    () => [
      {
        id: 'base',
        label: t('col.base'),
        defaultWidth: 140,
        hideable: false,
        filterable: { kind: 'text' },
        cell: (r) => (
          <span className="font-medium text-foreground text-sm tabular-nums">{r.base}</span>
        ),
      },
      {
        id: 'quote',
        label: t('col.quote'),
        defaultWidth: 140,
        cell: (r) => <span className="text-foreground text-sm tabular-nums">{r.quote}</span>,
      },
      {
        id: 'rate',
        label: t('col.rate'),
        defaultWidth: 160,
        cell: (r) => (
          <span className="block text-right text-foreground text-sm tabular-nums">{r.rate}</span>
        ),
      },
      {
        id: 'updated',
        label: t('col.updated'),
        defaultWidth: 180,
        cell: (r) => <span className="text-muted-foreground text-xs">{fmtDate(r.fetchedAt)}</span>,
      },
    ],
    [t, locale],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );

  // The base filter matches either side of the pair.
  const filteredRows = useMemo(() => {
    let out = rows;
    for (const c of tableState.filters) {
      if (c.field === 'base' && c.op === 'contains') {
        const n = c.value.toLowerCase();
        out = out.filter(
          (r) => r.base.toLowerCase().includes(n) || r.quote.toLowerCase().includes(n),
        );
      }
    }
    return out;
  }, [rows, tableState.filters]);

  const pillBar = useFilterPillBarWiring<Row, ColumnId>(columns, tableState, setTableState);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="rounded-md border border-border bg-card">
        <FilterPillBar<ColumnId>
          labels={pillBar.chromeLabels}
          filters={pillBar.filters}
          fields={pillBar.filterFields}
          fieldLabels={pillBar.filterLabels}
          fieldKinds={pillBar.filterKinds}
          options={pillBar.filterOptions}
          onUpdateOp={pillBar.updateClauseOp}
          onUpdateValue={pillBar.updateClauseValue}
          onRemoveClause={pillBar.removeClause}
          onAddClause={pillBar.addClause}
          onClearAll={pillBar.clearClauses}
          clearLabel={pillBar.clearLabel}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTableToolbar
          {...toolbarLabels}
          resultCount={filteredRows.length}
          loading={loading}
          leftSlot={
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">{t('historyHint')}</span>
            </div>
          }
          rightSlot={
            <TableSettingsButton<ColumnId, string>
              columnOrder={columns.map((c) => c.id)}
              columnVisibility={tableState.columnVisibility as Record<ColumnId, boolean>}
              onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
              columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
              density={tableState.density}
              onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
              onReset={() =>
                setTableState((s) => ({
                  ...s,
                  columnVisibility: {},
                  columnWidths: {},
                  density: 'normal',
                }))
              }
              labels={tableLabels.settings}
            />
          }
        />
        <DataTable<Row, ColumnId>
          columns={columns}
          rows={filteredRows}
          rowKey={(r) => `${r.base}:${r.quote}`}
          onRowClick={(r) => setHistoryPair({ base: r.base, quote: r.quote })}
          totalCount={filteredRows.length}
          state={tableState}
          onStateChange={setTableState}
          loading={loading}
          labels={tableLabels}
          selectable={false}
          renderEmpty={() => (
            <div>
              <div className="font-medium text-foreground">{t('emptyTitle')}</div>
              <div className="mt-1 text-muted-foreground text-sm">{t('emptyBody')}</div>
            </div>
          )}
        />
      </div>

      {historyPair && <RateHistoryDrawer pair={historyPair} onClose={() => setHistoryPair(null)} />}

      {adding && (
        <AddRateDrawer
          pending={add.isPending}
          error={add.error}
          onReset={() => add.reset()}
          onClose={() => {
            add.reset();
            setAdding(false);
          }}
          onSave={(v) => add.mutate(v, { onSuccess: () => setAdding(false) })}
        />
      )}
    </div>
  );
}

/**
 * One pair's append-only rate history, opened by clicking its row. Each entry
 * shows the move from the one before it — a rate on its own says nothing, and
 * the reason to open this at all is usually "did something jump".
 */
export function RateHistoryDrawer({
  pair,
  onClose,
}: {
  pair: { base: string; quote: string };
  onClose: () => void;
}) {
  const t = useTranslations('admin.fxRates');
  const locale = useLocale() as Locale;
  const q = trpc.policies.fxRate.history.useQuery(pair);
  const entries = q.data ?? [];

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerContent width={440} resizable storageKey="admin.fx-history">
        <DrawerHeader>
          <DrawerTitle>{t('historyTitle', { base: pair.base, quote: pair.quote })}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-3">
          <p className="text-muted-foreground text-xs">{t('historySubtitle')}</p>
          {q.isLoading ? null : entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('historyEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {entries.map((e, i) => {
                const prev = entries[i + 1];
                const delta = prev ? Number(e.rate) - Number(prev.rate) : null;
                return (
                  <li
                    key={`${e.base}:${e.quote}:${new Date(e.fetchedAt).getTime()}`}
                    className="flex items-baseline justify-between gap-3 px-3 py-2"
                  >
                    <span className="text-muted-foreground text-xs">
                      {new Date(e.fetchedAt).toLocaleDateString(locale, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                      {i === 0 && (
                        <span className="ml-2 text-[10px] uppercase">{t('historyCurrent')}</span>
                      )}
                    </span>
                    <span className="flex items-baseline gap-2">
                      <span className="font-medium text-foreground text-sm tabular-nums">
                        {e.rate}
                      </span>
                      {delta !== null && delta !== 0 && (
                        <span
                          className={`text-xs tabular-nums ${
                            delta > 0 ? 'text-success' : 'text-destructive'
                          }`}
                        >
                          {delta > 0 ? '+' : ''}
                          {delta.toFixed(4)}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * The add form. When the server refuses the rate for sitting too far from the pair's
 * last one (PRECONDITION_FAILED), the refusal is shown verbatim — it names both rates
 * and the bound — and the form grows a reason field: the same values can then be
 * posted again with `confirmDeviation`, which is how a wrong earlier row gets
 * corrected on the record rather than blocking its own fix. Any other failure is
 * shown without that offer; there is nothing to override in a permission error.
 */
export function AddRateDrawer({
  pending,
  error,
  onReset,
  onClose,
  onSave,
}: {
  pending: boolean;
  error: AddRateError;
  /** Clear the last failure — called when the pair or rate changes, so a refusal of
   *  one rate never offers the override for a different one. */
  onReset: () => void;
  onClose: () => void;
  onSave: (v: AddRateInput) => void;
}) {
  const t = useTranslations('admin.fxRates');
  /** The server's refusal, in the reader's language. `fxRate.add` throws every one of
   *  its refusals through `refusal()` — the ceiling and the deviation bound alike — so
   *  the Alert shows the catalog sentence, not the English one beside it. */
  const refusalText = useRefusalText();
  const [base, setBase] = useState('');
  const [quote, setQuote] = useState('');
  const [rate, setRate] = useState('');
  const [reason, setReason] = useState('');
  const valid =
    base.trim().length === 3 && quote.trim().length === 3 && /^\d+(\.\d+)?$/.test(rate.trim());
  const refused = error?.data?.code === 'PRECONDITION_FAILED';
  const reasonValid = reason.trim().length >= MIN_REASON_LENGTH;
  const clearError = () => {
    if (error) onReset();
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerContent width={440}>
        <DrawerHeader>
          <DrawerTitle>{t('addTitle')}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <p className="text-muted-foreground text-xs">{t('appendNote')}</p>
          <div className="grid grid-cols-2 gap-3">
            <FormField htmlFor="fx-base" label={t('field.base')} required>
              <Input
                id="fx-base"
                value={base}
                maxLength={3}
                placeholder="USD"
                onChange={(e) => {
                  setBase(e.target.value.toUpperCase());
                  clearError();
                }}
              />
            </FormField>
            <FormField htmlFor="fx-quote" label={t('field.quote')} required>
              <Input
                id="fx-quote"
                value={quote}
                maxLength={3}
                placeholder="CAD"
                onChange={(e) => {
                  setQuote(e.target.value.toUpperCase());
                  clearError();
                }}
              />
            </FormField>
          </div>
          <FormField htmlFor="fx-rate" label={t('field.rate')} required>
            <Input
              id="fx-rate"
              value={rate}
              inputMode="decimal"
              placeholder="1.36"
              onChange={(e) => {
                setRate(e.target.value);
                clearError();
              }}
            />
          </FormField>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{refusalText(error, error.message)}</AlertDescription>
            </Alert>
          )}
          {refused && (
            <>
              <p className="text-muted-foreground text-xs">{t('deviationExplainer')}</p>
              <FormField
                htmlFor="fx-reason"
                label={t('field.reason')}
                hint={t('reasonHint', { min: MIN_REASON_LENGTH })}
                required
              >
                <Textarea
                  id="fx-reason"
                  value={reason}
                  rows={3}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                />
              </FormField>
            </>
          )}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          {refused ? (
            <Button
              size="sm"
              disabled={!valid || !reasonValid || pending}
              onClick={() =>
                onSave({
                  base: base.trim(),
                  quote: quote.trim(),
                  rate: rate.trim(),
                  confirmDeviation: true,
                  reason: reason.trim(),
                })
              }
            >
              {pending ? t('saving') : t('confirmSave')}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!valid || pending}
              onClick={() => onSave({ base: base.trim(), quote: quote.trim(), rate: rate.trim() })}
            >
              {pending ? t('saving') : t('save')}
            </Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
