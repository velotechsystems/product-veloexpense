'use client';

/**
 * /admin/assistant-feedback — what the assistant got wrong, and who says so.
 *
 * Two sources land in one queue, and keeping them together is the point. A **rating** is a
 * person saying an answer was poor; a **flag** is the assistant saying so about itself, written
 * by `review.ts` on every turn. Relying on ratings alone produces an empty queue and a false
 * sense that the thing is working, because most people abandon a bad answer rather than score
 * it. The self-flags are what make the loop actually loop.
 *
 * A row is judged by reading the question and the answer, which is all `assistant.reviewTurn`
 * returns. **Tool results are deliberately not available here** — a transcript carries whatever
 * the tools fetched, and holding `admin.help.manage` is not a claim on somebody's report totals.
 *
 * PROMOTED records intent, not an action. Nothing is written to a knowledge base by pressing it:
 * promotion is a human act with a diff, because an auto-promoted wrong answer gets retrieved,
 * reinforced and cited, and compounds silently.
 */

import {
  Badge,
  Button,
  DataTableToolbar,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  FilterPillBar,
  MarkdownText,
  TableSettingsButton,
} from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { TableExportMenu, useTableLabels, useToolbarLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { displayName } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';

type ColumnId = 'createdAt' | 'source' | 'rating' | 'person' | 'conversation' | 'comment' | 'act';

interface Row {
  id: string;
  rating: number | null;
  comment: string | null;
  flag: string | null;
  status: string;
  createdAt: Date;
  reviewedAt: Date | null;
  conversationId: string;
  messageId: string;
  conversation: { title: string | null } | null;
  user: { firstName: string | null; lastName: string | null; email: string } | null;
}

const STATUSES = ['PENDING', 'REVIEWED', 'PROMOTED', 'DISMISSED'] as const;
/** `RATING` is not a stored flag — it selects the rows where `flag` is null. */
const SOURCES = ['RATING', 'OFF_TOPIC', 'NO_ANSWER_FOUND', 'UNSUPPORTED_CLAIM'] as const;

export function AssistantFeedbackAdmin() {
  const t = useTranslations('assistant.review');
  const tableLabels = useTableLabels();
  const toolbarLabels = useToolbarLabels();
  const utils = trpc.useUtils();

  const [status, setStatus] = useState<string>('PENDING');
  const [source, setSource] = useState<string>('');
  const [openId, setOpenId] = useState<string | null>(null);

  const query = trpc.assistant.reviewQueue.useQuery({
    status: (status || null) as (typeof STATUSES)[number] | null,
    flag: source || null,
    limit: 200,
  });

  const decide = trpc.assistant.reviewDecide.useMutation({
    onSuccess: () => {
      setOpenId(null);
      void utils.assistant.reviewQueue.invalidate();
    },
  });

  const columns: ColumnDef<Row, ColumnId>[] = useMemo(
    () => [
      {
        id: 'createdAt',
        label: t('when'),
        defaultWidth: 150,
        sortable: true,
        hideable: false,
        exportValue: (r) => r.createdAt.toISOString(),
        cell: (r) => (
          <span className="text-muted-foreground text-xs">{r.createdAt.toLocaleString()}</span>
        ),
      },
      {
        id: 'source',
        label: t('source'),
        defaultWidth: 160,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (r) => r.flag ?? 'RATING',
        cell: (r) =>
          r.flag ? (
            // The assistant flagged itself. Worth distinguishing visually: nobody complained,
            // so nobody is waiting for an answer — but it is still a miss.
            <Badge variant={r.flag === 'UNSUPPORTED_CLAIM' ? 'destructive' : 'secondary'}>
              {t(`flag.${r.flag}` as 'flag.OFF_TOPIC')}
            </Badge>
          ) : (
            <Badge variant="outline">{t('flag.RATING')}</Badge>
          ),
      },
      {
        id: 'rating',
        label: t('rating'),
        defaultWidth: 100,
        sortable: true,
        exportValue: (r) => (r.rating == null ? '' : String(r.rating)),
        cell: (r) =>
          r.rating == null ? (
            <span className="text-muted-foreground text-xs">—</span>
          ) : (
            <span
              className={
                r.rating <= 2 ? 'font-medium text-destructive text-sm' : 'text-foreground text-sm'
              }
            >
              {t('outOfFive', { n: r.rating })}
            </span>
          ),
      },
      {
        id: 'person',
        label: t('person'),
        defaultWidth: 190,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (r) => r.user?.email ?? '',
        cell: (r) => (
          <span className="text-foreground text-sm">
            {r.user ? displayName(r.user) : t('unknownPerson')}
          </span>
        ),
      },
      {
        id: 'conversation',
        label: t('conversation'),
        defaultWidth: 220,
        filterable: { kind: 'text' },
        exportValue: (r) => r.conversation?.title ?? '',
        cell: (r) => (
          <span className="truncate text-muted-foreground text-sm">
            {r.conversation?.title ?? t('untitled')}
          </span>
        ),
      },
      {
        id: 'comment',
        label: t('comment'),
        defaultWidth: 240,
        exportValue: (r) => r.comment ?? '',
        cell: (r) => (
          <span className="truncate text-muted-foreground text-sm">{r.comment ?? '—'}</span>
        ),
      },
      {
        id: 'act',
        label: t('act'),
        defaultWidth: 110,
        hideable: false,
        exportValue: () => '',
        cell: (r) => (
          <Button variant="ghost" size="sm" onClick={() => setOpenId(r.id)}>
            {t('open')}
          </Button>
        ),
      },
    ],
    [t],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );
  const rows = useMemo<Row[]>(() => {
    const source = (query.data?.rows ?? []).map((r) => ({
      ...r,
      createdAt: new Date(r.createdAt),
    })) as unknown as Row[];
    // Free-text refinement within the window the server already narrowed, same split as the
    // API request log: status and source decide which rows exist, pills refine what came back.
    const clauses = tableState.filters.filter((c) => typeof c.value === 'string' && c.value);
    if (clauses.length === 0) return source;
    const valueFor = (row: Row, field: string): string => {
      switch (field) {
        case 'source':
          return row.flag ?? 'RATING';
        case 'person':
          return `${row.user?.email ?? ''} ${row.user?.firstName ?? ''} ${row.user?.lastName ?? ''}`;
        case 'conversation':
          return row.conversation?.title ?? '';
        default:
          return '';
      }
    };
    return source.filter((row) =>
      clauses.every((c) =>
        valueFor(row, String(c.field)).toLowerCase().includes(String(c.value).toLowerCase()),
      ),
    );
  }, [query.data, tableState.filters]);

  const pillBar = useFilterPillBarWiring<Row, ColumnId>(columns, tableState, setTableState);

  const total = query.data?.totalCount ?? 0;
  const windowed = total > rows.length;
  const counts = query.data?.statusCounts ?? [];
  const pending = counts.find((c) => c.status === 'PENDING')?.count ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-3">
        <label htmlFor="review-status" className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('status')}</span>
          <select
            id="review-status"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t('allStatuses')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statuses.${s}` as 'statuses.PENDING')} (
                {counts.find((c) => c.status === s)?.count ?? 0})
              </option>
            ))}
          </select>
        </label>

        <label htmlFor="review-source" className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('source')}</span>
          <select
            id="review-source"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">{t('allSources')}</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`flag.${s}` as 'flag.RATING')}
              </option>
            ))}
          </select>
        </label>

        <p className="ml-auto text-muted-foreground text-xs">
          {/* The real match, never just the window — a queue that shows 200 of 5,000 without
              saying so reads as nearly empty. */}
          {windowed ? t('windowed', { shown: rows.length, total }) : t('matched', { total })}
          {pending > 0 && status !== 'PENDING' && (
            <span className="ml-2 text-foreground">{t('pendingElsewhere', { n: pending })}</span>
          )}
        </p>
      </div>

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

        <DataTableToolbar
          {...toolbarLabels}
          selectedCount={0}
          resultCount={rows.length}
          loading={query.isLoading}
          rightSlot={
            <>
              <TableExportMenu<Row, ColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename="assistant-feedback"
              />
              <TableSettingsButton<ColumnId, string>
                columnOrder={columns.map((c) => c.id)}
                columnVisibility={tableState.columnVisibility as Record<ColumnId, boolean>}
                onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
                columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
                density={tableState.density}
                onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
                onReset={() => setTableState((s) => ({ ...s, columnVisibility: {} }))}
                labels={tableLabels.settings}
              />
            </>
          }
        />

        <DataTable<Row, ColumnId>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          totalCount={rows.length}
          state={tableState}
          onStateChange={setTableState}
          labels={tableLabels}
          selectable={false}
          renderEmpty={() => (
            <div className="space-y-1 text-center">
              <p className="font-medium text-foreground">{t('empty')}</p>
              <p className="text-muted-foreground text-sm">{t('emptyHint')}</p>
            </div>
          )}
        />
      </div>

      <ReviewDrawer
        feedbackId={openId}
        onClose={() => setOpenId(null)}
        onDecide={(next) => {
          if (openId) decide.mutate({ feedbackId: openId, status: next });
        }}
        deciding={decide.isPending}
      />
    </div>
  );
}

/** The turn behind one row: what was asked, what was answered, and the three decisions. */
function ReviewDrawer({
  feedbackId,
  onClose,
  onDecide,
  deciding,
}: {
  feedbackId: string | null;
  onClose: () => void;
  onDecide: (status: 'REVIEWED' | 'PROMOTED' | 'DISMISSED') => void;
  deciding: boolean;
}) {
  const t = useTranslations('assistant.review');
  const turn = trpc.assistant.reviewTurn.useQuery(
    { feedbackId: feedbackId ?? '' },
    { enabled: Boolean(feedbackId) },
  );

  return (
    <Drawer open={Boolean(feedbackId)} onOpenChange={(v) => !v && onClose()} dismissible>
      <DrawerContent className="flex w-full flex-col sm:w-[34rem]" storageKey="assistant-review">
        <DrawerHeader>
          <DrawerTitle>{t('turnTitle')}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-4">
          {turn.isLoading && <p className="text-muted-foreground text-sm">{t('loading')}</p>}
          {turn.data && (
            <>
              <section className="space-y-1">
                <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  {t('question')}
                </h3>
                <p className="whitespace-pre-wrap text-foreground text-sm">
                  {turn.data.question || t('noQuestion')}
                </p>
              </section>
              <section className="space-y-1">
                <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  {t('answer')}
                </h3>
                {/* The same hardened renderer the panel uses — the answer is model output. */}
                <MarkdownText>{turn.data.answer || t('noAnswer')}</MarkdownText>
              </section>
              <p className="text-muted-foreground text-xs">{t('toolResultsWithheld')}</p>
            </>
          )}
        </DrawerBody>
        <div className="flex flex-wrap gap-2 border-border border-t p-4">
          <Button onClick={() => onDecide('PROMOTED')} disabled={deciding}>
            {t('promote')}
          </Button>
          <Button variant="outline" onClick={() => onDecide('REVIEWED')} disabled={deciding}>
            {t('markReviewed')}
          </Button>
          <Button variant="ghost" onClick={() => onDecide('DISMISSED')} disabled={deciding}>
            {t('dismiss')}
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
