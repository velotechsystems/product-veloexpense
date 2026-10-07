'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, loggerLink, TRPCClientError } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import { useState } from 'react';
import superjson from 'superjson';
import { rememberInterruptedWork, typedTextOf } from '@/lib/interruptedWork';
import type { AppRouter } from '@/server/routers/_app';

/**
 * Typed React tRPC client. Consumers do:
 *
 *   import { trpc } from '@/lib/trpc/client';
 *   const { data } = trpc.expenses.list.useQuery();
 *   const create = trpc.expenses.create.useMutation();
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * Where `/api/trpc` lives, from wherever this is running.
 *
 * Exported because it is the one part of the provider with an answer worth checking: in
 * the browser it must be RELATIVE, so the request carries the session cookie and is not a
 * cross-origin call to whatever host the build happened to know about. Off the browser
 * there is no origin to be relative to, so one has to be constructed.
 */
export function getBaseUrl() {
  if (typeof window !== 'undefined') return ''; // same-origin in the browser
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

interface TRPCProviderProps {
  children: React.ReactNode;
}

/**
 * Detect a session-expiry error from any tRPC response. The server
 * throws `TRPCError({ code: 'UNAUTHORIZED' })` from the auth
 * middleware when there's no session; that surfaces here as a
 * `TRPCClientError` whose `data.code` is `'UNAUTHORIZED'` (or
 * `data.httpStatus === 401` for non-tRPC layers like middleware).
 */
function isUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  // biome-ignore lint/suspicious/noExplicitAny: tRPC error data shape isn't statically typed here
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense lints with ESLint; same reason as the biome line above
  const data = error.data as any;
  return data?.code === 'UNAUTHORIZED' || data?.httpStatus === 401;
}

/**
 * Redirect to the login page when the session has expired in the
 * background — e.g. user idle, server restarted, JWT past max-age.
 * Without this, tRPC calls just throw cryptic errors in the console.
 * The current path is preserved as `callbackUrl` so the user lands
 * back where they were after re-auth.
 *
 * Guarded against re-entry by a module-level flag, otherwise N
 * in-flight queries each push a redirect.
 */
/**
 * The tRPC procedure path for a mutation, as `expenseApprovals.decide`.
 *
 * tRPC's react-query integration puts the path segments in the mutation key, so this reads
 * what was called without every call site having to declare it.
 */
function mutationPathOf(mutation: { options?: { mutationKey?: unknown } } | undefined): string {
  const key = mutation?.options?.mutationKey;
  if (!Array.isArray(key)) return 'unknown';
  const head = key[0];
  return Array.isArray(head) ? head.join('.') : String(head ?? 'unknown');
}

let redirectingToLogin = false;
function redirectToLogin() {
  if (typeof window === 'undefined') return;
  if (redirectingToLogin) return;
  if (window.location.pathname.endsWith('/login')) return;
  redirectingToLogin = true;
  // VeloExpense: no locale segment in the URL. The reader's language is a stored
  // preference (lib/i18n), so the sign-in page is `/login` whatever language they read.
  const callbackUrl = encodeURIComponent(window.location.pathname + window.location.search);
  // A full navigation on purpose: the session is gone, and nothing client-side should survive it.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = `/login?callbackUrl=${callbackUrl}`;
}

export function TRPCProvider({ children }: TRPCProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error) => {
            if (isUnauthorizedError(error)) redirectToLogin();
          },
        }),
        mutationCache: new MutationCache({
          onError: (error, variables, _context, mutation) => {
            if (!isUnauthorizedError(error)) return;
            /**
             * Keep what the expiry interrupted BEFORE navigating away.
             *
             * #329 taught `IdleTimeout` to drain in-flight writes before the CLIENT's own
             * countdown signs somebody out, which fixed the case where our timer fired
             * first. The dominant case is the other one: the server's Redis window lapses
             * (routine — the heartbeat is throttled to one call per 30s, and a click inside
             * that window only moves the local deadline), the mutation returns UNAUTHORIZED,
             * and we hard-navigate. The Approve click never landed and the typed
             * justification went with it, silently (GA readiness report F16 / blocker B7).
             *
             * Disclosed, not replayed — re-issuing after re-auth is how a claim gets
             * approved twice.
             */
            rememberInterruptedWork({
              path: mutationPathOf(mutation),
              typedText: typedTextOf(variables),
              url: typeof window === 'undefined' ? '' : window.location.pathname,
            });
            redirectToLogin();
          },
        }),
        defaultOptions: {
          queries: {
            // Match the calibration from the earlier scaffold — internal app,
            // explicit refresh wins over background chatter.
            refetchOnWindowFocus: false,
            // Skip retries on auth failures — they'll never succeed,
            // and one failed attempt is enough to trigger the redirect.
            retry: (failureCount, error) => {
              if (isUnauthorizedError(error)) return false;
              return failureCount < 1;
            },
            staleTime: 30_000,
          },
        },
      }),
  );

  const [client] = useState(() =>
    trpc.createClient({
      links: [
        loggerLink({
          enabled: (op) =>
            process.env.NODE_ENV === 'development' ||
            (op.direction === 'down' && op.result instanceof Error),
        }),
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
