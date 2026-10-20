'use client';

/**
 * f26 — where a person sees the address they can email receipts to.
 *
 * Built for VeloExpense; ExpenseOS has no such screen (the emailing-receipts article told
 * people to "send it to the receipts address for your organisation" and nothing told them
 * what that was). Two faces, one query (`receiptsEmail.mine`):
 *
 *   · `ReceiptsEmailCard` — /preferences. The address, a copy button, and the half that makes
 *     it work: the sign-in email it must be sent FROM. When this environment receives no
 *     mail it says so, rather than vanishing, because somebody who came here looking for the
 *     address deserves to learn there is not one.
 *   · `ReceiptsEmailHint` — one line under the expense report list. Silent unless there IS an
 *     address: on a list screen, "not set up" is noise.
 *
 * Both render nothing for a reader without `expense.report.createOwn` (the procedure answers
 * FORBIDDEN): the address files a report they could not file in the browser either.
 */

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useCallback, useRef } from 'react';
import { useCopy } from '@/components/api-keys/useCopy';
import { trpc } from '@/lib/trpc/client';

/** The query both faces read. No retry on a refusal: FORBIDDEN is an answer, not a blip. */
function useReceiptsEmail() {
  return trpc.receiptsEmail.mine.useQuery(undefined, {
    retry: (count, err) => err?.data?.code !== 'FORBIDDEN' && count < 2,
    staleTime: 5 * 60_000,
  });
}

export function ReceiptsEmailCard() {
  const t = useTranslations('expenses.receiptsEmail');
  const query = useReceiptsEmail();
  const addressRef = useRef<HTMLElement>(null);
  // Nothing copied it for them, so put them on the thing they now have to copy by hand.
  const onCopyFailure = useCallback(() => addressRef.current?.focus(), []);
  const { state: copy, copy: doCopy } = useCopy(onCopyFailure);

  if (query.isLoading) return null;
  if (query.error?.data?.code === 'FORBIDDEN') return null;

  const data = query.data;
  return (
    <Card data-testid="receipts-email-card">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        {data?.address ? <CardDescription>{t('lede')}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {query.isError ? (
          <p role="alert" className="text-destructive">
            {t('loadFailed')}
          </p>
        ) : data?.address ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <code
                ref={addressRef}
                tabIndex={-1}
                data-testid="receipts-email-address"
                className="min-w-0 select-all break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-foreground text-sm"
              >
                {data.address}
              </code>
              <Button size="sm" variant="outline" onClick={() => void doCopy(data.address)}>
                {copy === 'done' ? t('copied') : t('copy')}
              </Button>
            </div>
            {copy === 'failed' && (
              <span role="alert" className="text-destructive text-xs">
                {t('copyFailed')}
              </span>
            )}
            <p className="text-muted-foreground" data-testid="receipts-email-send-from">
              {t('sendFrom', { email: data.sendFrom })}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground" data-testid="receipts-email-not-configured">
            {t('notConfigured')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function ReceiptsEmailHint() {
  const t = useTranslations('expenses.receiptsEmail');
  const query = useReceiptsEmail();
  const data = query.data;
  if (!data?.address) return null;
  return (
    <p className="break-words text-muted-foreground text-xs" data-testid="receipts-email-hint">
      {t.rich('hint', {
        address: data.address,
        email: data.sendFrom,
        mono: (chunks) => (
          <span className="select-all break-all font-mono text-foreground">{chunks}</span>
        ),
      })}
    </p>
  );
}
