import 'server-only';
import { cache } from 'react';
import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';

/**
 * Server-side tRPC caller — invoke procedures inside React Server
 * Components / route handlers without an HTTP round-trip.
 *
 * Usage in an RSC:
 *
 *   import { api } from '@/lib/trpc/server';
 *   const me = await api.auth.me();
 *
 * `cache()` (React 19) memoizes the context factory per request so multiple
 * server-side reads share one DB session and one auth() call.
 */
const createContextCached = cache(createTRPCContext);

export const api = appRouter.createCaller(createContextCached);
