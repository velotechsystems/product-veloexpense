'use client';

import { Alert, AlertDescription, Button } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { type InterruptedWork, takeInterruptedWork } from '@/lib/interruptedWork';

/**
 * What the last session expiry interrupted, said out loud after re-authentication.
 *
 * The reported defect was silence: an expiry mid-action "silently dropped the attempted
 * action — a typed justification was lost, an Approve click never landed" (GA readiness report
 * F16, blocker B7). #329 fixed the half where our own countdown fired; this covers the half
 * where the server's window lapsed first, which is the routine one.
 *
 * It DISCLOSES and does not replay. Re-issuing a mutation after re-auth is how a claim gets
 * approved twice or a card issued twice — so the person is told what did not happen, handed
 * back the words they typed, and decides for themselves. Not knowing was the defect; deciding
 * was never ours to take.
 */
export function InterruptedWorkNotice() {
  const t = useTranslations('security');
  const [work, setWork] = useState<InterruptedWork | null>(null);
  const [copied, setCopied] = useState(false);

  // Read once on mount, in an effect: `sessionStorage` does not exist during the server
  // render, and taking the record CLEARS it, so it must not run twice.
  useEffect(() => setWork(takeInterruptedWork()), []);

  if (!work) return null;

  return (
    <Alert className="mb-3">
      <AlertDescription className="flex flex-col gap-2">
        <span>{t('interrupted.message')}</span>
        {work.typedText && (
          <>
            {/* The part that is genuinely unrecoverable: their own words. Shown so they can
                be copied straight back into the field they were typed in. */}
            <span className="text-muted-foreground text-xs">{t('interrupted.yourText')}</span>
            <blockquote className="whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 text-sm">
              {work.typedText}
            </blockquote>
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(work.typedText ?? '').then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? t('interrupted.copied') : t('interrupted.copy')}
              </Button>
            </div>
          </>
        )}
        <div>
          <Button variant="ghost" size="sm" onClick={() => setWork(null)}>
            {t('interrupted.dismiss')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
