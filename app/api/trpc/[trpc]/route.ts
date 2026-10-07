import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';
import { crossOriginWrite } from '@/lib/trpc/origin';

/**
 * tRPC HTTP transport mounted at /api/trpc/[procedure]. The fetch adapter
 * works in both Node and Edge runtimes; we run Node here because the Prisma
 * client + bcrypt are Node-only.
 */
const handler = (req: Request) =>
  crossOriginWrite(req)
    ? Response.json(
        { error: { message: 'That request did not come from this site.', data: { code: 'FORBIDDEN', httpStatus: 403 } } },
        { status: 403 },
      )
    : fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: createTRPCContext,
    onError({ error, path }) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[tRPC] ${path ?? '<no-path>'}: ${error.message}`);
      }
    },
  });

export { handler as GET, handler as POST };
