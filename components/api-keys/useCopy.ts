'use client';

/**
 * Copy-to-clipboard for the two places a freshly minted key is shown: the token itself and
 * the assistant prompt that carries it.
 *
 * ## Why this is a hook and not a second copy button
 *
 * `TokenReveal`'s own reasoning applies here word for word — two hand-written blocks drift,
 * and the one that drifts is the one nobody looked at. The failure handling below is the
 * part worth not re-deriving: `navigator.clipboard.writeText` REJECTS in a non-secure
 * context and when permission is denied, and `navigator.clipboard` is simply ABSENT in some
 * of them, so the `TypeError` from reading `.writeText` off `undefined` is a second, quite
 * different shape of the same failure. Both land in the same `catch`.
 *
 * Unhandled, that promise rejected inside an async `onClick`, the "Copied" state never
 * arrived, and the user got total silence at the one moment the value is recoverable.
 *
 * ## `onFailure` rather than a returned error
 *
 * The caller does not just render the failure, it has to put focus back on the value the
 * user now has to copy by hand — and only the caller knows which element that is. Passing
 * the callback in keeps that decision at the call site instead of handing every caller a
 * ref to wire up.
 *
 * Ported from ExpenseOS `apps/web/src/components/api-keys/useCopy.ts` (1e682dd6), w6-04 (d88).
 */

import { useCallback, useState } from 'react';

export type CopyState = 'idle' | 'done' | 'failed';

export function useCopy(onFailure?: () => void) {
  const [state, setState] = useState<CopyState>('idle');

  const copy = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setState('done');
      } catch {
        // Both shapes of failure land here: a rejected promise, and the TypeError from
        // `navigator.clipboard` being undefined outside a secure context.
        setState('failed');
        onFailure?.();
      }
    },
    [onFailure],
  );

  /**
   * Callers reset on a NEW value, not on mount: regenerating twice without leaving the page
   * hands the component a second secret, and a stale "Copied" label against a token the
   * user has not copied is worse than no label at all.
   */
  const reset = useCallback(() => setState('idle'), []);

  return { state, copy, reset };
}
