'use client';

/**
 * "Which expenses does this statement cover?"
 *
 * A statement is not a receipt. A receipt evidences one charge; a statement page
 * evidences several, and it is the only document that proves what was actually
 * SETTLED — including the rate, when the charge was made in another currency. So it
 * belongs on every expense it covers.
 *
 * The recommendations come from matching the statement's own lines against each
 * expense's total, and the matched line is shown beside the box so the tick is
 * explained rather than asserted. Recommended boxes start ticked; the person decides.
 * Behind the scenes each tick becomes a copy of the file, which is why an expense that
 * already carries it is shown as covered rather than offered again.
 */

import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@expenseos/design-system';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { useRefusalText } from '@/lib/trpc/refusal';

export function StatementApplyDialog({
  receiptId,
  onClose,
  onApplied,
}: {
  receiptId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const t = useTranslations('expenses.statement');
  const locale = useLocale();
  const targets = trpc.expenses.statementTargets.useQuery({ receiptId });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed from the recommendations once they arrive, then leave the user's choices
  // alone — a refetch must not re-tick a box they deliberately cleared.
  useEffect(() => {
    if (picked !== null || !targets.data) return;
    setPicked(
      new Set(
        targets.data.items.filter((i) => i.recommended && !i.alreadyHas).map((i) => i.expenseId),
      ),
    );
  }, [targets.data, picked]);

  const refusalText = useRefusalText();
  const apply = trpc.expenses.statementApply.useMutation({
    onSuccess: () => {
      onApplied();
      onClose();
    },
    onError: (e) => setError(refusalText(e, e.message)),
  });

  const items = targets.data?.items ?? [];
  const selected = picked ?? new Set<string>();
  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title', { filename: targets.data?.filename ?? '' })}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {error && (
            <p className="rounded bg-destructive/10 px-3 py-2 text-destructive text-sm">{error}</p>
          )}
          <p className="text-muted-foreground text-sm">{t('help')}</p>

          {targets.isLoading ? (
            <p className="text-muted-foreground text-sm">{t('loading')}</p>
          ) : items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noExpenses')}</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {items.map((i) => (
                <li key={i.expenseId} className="flex items-start gap-2 rounded px-1 py-1.5">
                  <Checkbox
                    aria-label={i.merchant ?? i.expenseId}
                    disabled={i.alreadyHas || apply.isPending}
                    checked={i.alreadyHas || selected.has(i.expenseId)}
                    onCheckedChange={() => toggle(i.expenseId)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-foreground text-sm">
                        {i.merchant?.trim() || t('noMerchant')}
                      </span>
                      <span className="shrink-0 text-foreground text-sm tabular-nums">
                        {formatMinor(
                          Number(i.amountMinor),
                          { code: i.currencyCode, symbol: '' },
                          locale,
                        )}{' '}
                        {i.currencyCode}
                      </span>
                    </div>
                    {/* Why it was recommended, in the bank's own words. A tick with no
                        reason is a tick somebody has to verify by hand anyway. */}
                    {i.matchedLine && (
                      <p className="truncate text-muted-foreground text-xs">
                        {t('matched', { line: i.matchedLine })}
                        {i.strength === 'amount+merchant' ? ` · ${t('merchantAgrees')}` : ''}
                      </p>
                    )}
                    {i.alreadyHas && (
                      <Badge variant="outline" className="mt-0.5 border text-[10px]">
                        {t('alreadyHas')}
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            disabled={selected.size === 0 || apply.isPending}
            onClick={() => {
              setError(null);
              apply.mutate({ receiptId, expenseIds: [...selected] });
            }}
          >
            {apply.isPending ? t('applying') : t('apply', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
