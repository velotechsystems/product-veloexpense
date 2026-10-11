'use client';

/**
 * "Are these two the same charge?"
 *
 * Asked at SUBMIT, not on every page load, and nothing is stored. The automatic pass
 * declines to merge when the evidence is not conclusive, and an unresolved pair is an
 * OVER-claim — the same charge on two expenses, each with the full total. So the
 * question belongs at the moment the report would reach an approver.
 *
 * Answering "different" writes nothing, because nothing needs writing: the documents
 * are already on separate expenses, which is what "different" means. The answer lives
 * in this component for as long as the submit attempt does. Reload and submit again
 * and you are asked again — once, when it matters, which is a pre-flight check rather
 * than a nag.
 *
 * Both files are shown with the fields the question turns on: the totals (which is
 * why they look alike), and the transaction id and time (which is what would have
 * settled it automatically had the documents printed them).
 */

import { Badge, Button } from '@expenseos/design-system';
import { IconFileText } from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import type { AppRouter } from '@/server/routers/_app';

type Suggestion =
  inferRouterOutputs<AppRouter>['expenses']['receiptGroupingSuggestions']['items'][number];

export function GroupingResolver({
  suggestions,
  onMerge,
  onKeepApart,
  busy,
}: {
  suggestions: Suggestion[];
  /** Move every other document in the group onto `toExpenseId`. */
  onMerge: (receiptIds: string[], toExpenseId: string) => void;
  /** Answered "different charges" — nothing to write, just stop asking. */
  onKeepApart: (key: string) => void;
  busy?: boolean;
}) {
  const t = useTranslations('expenses.grouping');
  const locale = useLocale();
  if (suggestions.length === 0) return null;

  const fmtDate = (d: string | null) =>
    d ? new Date(`${d}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' }) : '—';
  const fmtMoney = (total: number | null, code: string | null) =>
    total == null ? '—' : `${total.toFixed(2)}${code ? ` ${code}` : ''}`;

  return (
    <div className="flex flex-col gap-3">
      {suggestions.map((s) => {
        const key = s.documents
          .map((d) => d.receiptId)
          .sort()
          .join('|');
        return (
          <div key={key} className="rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
            <p className="mb-2 text-foreground">
              {t('question')} <span className="text-muted-foreground">({s.reason})</span>
            </p>

            <ul className="mb-3 flex flex-col gap-1.5">
              {s.documents.map((d) => (
                <li key={d.receiptId} className="flex items-center gap-2">
                  <IconFileText size={14} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{d.filename}</span>
                  {d.kind && d.kind !== 'OTHER' && (
                    <Badge variant="outline" className="shrink-0 border text-[10px]">
                      {d.kind}
                    </Badge>
                  )}
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {fmtMoney(d.total, d.currencyCode)} · {fmtDate(d.date)}
                    {d.time ? ` ${d.time}` : ''}
                  </span>
                  {/* The field that would have answered this automatically. Saying so
                      is more useful than hiding it: a merchant whose receipts print
                      no reference number is why this question exists at all. */}
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {d.transactionId ? t('withId', { id: d.transactionId }) : t('noId')}
                  </span>
                </li>
              ))}
            </ul>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  onMerge(
                    s.documents
                      .filter((d) => d.expenseId !== s.suggestedExpenseId)
                      .map((d) => d.receiptId),
                    s.suggestedExpenseId,
                  )
                }
              >
                {t('same')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onKeepApart(key)}>
                {t('different')}
              </Button>
              {s.confident && (
                <span className="text-muted-foreground text-xs">{t('recommendMerge')}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The stable key for a pair, so a session answer survives a refetch that returns the
 *  same suggestion in a different order. */
export function suggestionKey(s: Suggestion): string {
  return s.documents
    .map((d) => d.receiptId)
    .sort()
    .join('|');
}
