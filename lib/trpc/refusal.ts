'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

/**
 * Render a server refusal in the reader's language.
 *
 * A deliberate refusal is a `TRPCError` whose English `message` reaches the screen as
 * written (`safeMessage`, server/trpc.ts). When the resolver threw it through
 * `refusal()` (server/refusal.ts) the error ALSO carries `data.refusal = { key, params }`,
 * a full catalog path under the `refusals` area plus the values its sentence needs. This
 * module is the other half: `t(key, params)` when the catalog has the key, a real
 * `Error`'s message when it does not, and the caller's fallback otherwise. An `onError`
 * argument is a `TRPCClientError`, so its own `message` is the natural fallback there
 * (`refusalText(e, e.message)`); a `catch` argument can be anything — a failed `fetch`
 * to S3, a plain object from a harness — and gets the caller's catalog sentence instead.
 *
 * The translator is the ROOT one — `useTranslations()` with no namespace — because the
 * same refusal is shown by components bound to `expenses`, `expenses.statement` and
 * `admin.fxRates`, and the key must resolve identically from each. next-intl's `has`
 * is asked first so a key the catalog has not learned yet degrades to the English
 * sentence rather than to a MISSING_MESSAGE token; it is typed optional because a
 * mocked translator may not provide it.
 */
export type RefusalParams = Record<string, string | number>;
/**
 * One translated detail line under the headline — see `RefusalRow` in server/refusal.ts.
 *
 * Its `key` is a full catalog path like the headline's, but it is NOT restricted to the
 * `refusals` area: a row points at whichever catalog already owns its subject. Rendering
 * rows belongs to the surface that asked for them; `refusalText` below still renders the
 * headline alone, exactly as it did before rows existed.
 */
export type RefusalRow = { key: string; params?: RefusalParams };
export type RefusalData = { key: string; params?: RefusalParams; rows?: RefusalRow[] };

/** A wire value shaped like a row. Anything else in the array is dropped. */
function rowOf(value: unknown): RefusalRow | null {
  if (!value || typeof value !== 'object') return null;
  const key = (value as { key?: unknown }).key;
  if (typeof key !== 'string' || key.length === 0) return null;
  const params = (value as { params?: unknown }).params;
  return params && typeof params === 'object' ? { key, params: params as RefusalParams } : { key };
}

/**
 * The `data.refusal` of a tRPC client error, if it carries one.
 *
 * Everything here has crossed the wire, so every field is re-checked rather than trusted:
 * a headline without a usable `key` is no refusal at all and yields `null`, while a
 * malformed `params` or a malformed row is dropped on its own — losing one detail line is
 * better than swallowing the sentence that explains the refusal.
 */
export function refusalDataOf(error: unknown): RefusalData | null {
  if (!error || typeof error !== 'object') return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const r = (data as { refusal?: unknown }).refusal;
  if (!r || typeof r !== 'object') return null;
  const key = (r as { key?: unknown }).key;
  if (typeof key !== 'string' || key.length === 0) return null;
  const params = (r as { params?: unknown }).params;
  const out: RefusalData =
    params && typeof params === 'object' ? { key, params: params as RefusalParams } : { key };
  const rows = (r as { rows?: unknown }).rows;
  if (Array.isArray(rows)) {
    const kept = rows.map(rowOf).filter((row): row is RefusalRow => row !== null);
    if (kept.length > 0) out.rows = kept;
  }
  return out;
}

type RootTranslator = ReturnType<typeof useTranslations>;

/** Pure form of `useRefusalText`, for callers that already hold a root translator. */
export function refusalText(t: RootTranslator, error: unknown, fallback?: string): string {
  const refusal = refusalDataOf(error);
  if (refusal && typeof t.has === 'function' && t.has(refusal.key as never)) {
    return t(refusal.key as never, refusal.params as never);
  }
  // Only a real Error's message is trusted as a sentence. A non-Error rejection (a
  // plain object, a status) falls through to the caller's fallback rather than
  // rendering as "[object Object]" — the rule `ExpenseReportsList` has always kept.
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback ?? '';
}

/**
 * `(error, fallback?) => string` — the sentence to show for a failed mutation.
 *
 *   const refusalText = useRefusalText();
 *   trpc.expenses.receiptMove.useMutation({ onError: (e) => setError(refusalText(e)) });
 */
export function useRefusalText(): (error: unknown, fallback?: string) => string {
  const t = useTranslations();
  return useCallback((error: unknown, fallback?: string) => refusalText(t, error, fallback), [t]);
}
