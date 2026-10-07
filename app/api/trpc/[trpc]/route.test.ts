// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed so mock.calls[0][0] exists
  fetchRequestHandler: vi.fn(async (_opts: unknown) => new Response('ok')),
}));
vi.mock('@trpc/server/adapters/fetch', () => ({ fetchRequestHandler: h.fetchRequestHandler }));
vi.mock('@/server/routers/_app', () => ({ appRouter: { __brand: 'appRouter' } }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: () => ({ __brand: 'ctx' }) }));

import { GET, POST } from './route';

/**
 * The tRPC HTTP transport — every typed call in the app arrives here.
 *
 * Almost all of its behaviour belongs to the adapter, so what is worth pinning is the
 * handful of things WE hand it, each of which breaks the whole API when wrong and none
 * of which any procedure test would notice: procedure tests build a caller directly and
 * never traverse this file at all.
 *
 * The `endpoint` string in particular is a silent one. The adapter slices the procedure
 * name off the URL using it, so a mismatch with the mount path does not error — it
 * resolves every request to the wrong procedure name and answers 404 for a router that
 * is perfectly healthy.
 */

beforeEach(() => {
  h.fetchRequestHandler.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const args = () =>
  h.fetchRequestHandler.mock.calls[0]?.[0] as unknown as {
    endpoint: string;
    req: Request;
    router: unknown;
    createContext: unknown;
    onError: (o: { error: { message: string }; path?: string }) => void;
  };

describe('what the adapter is handed', () => {
  it('mounts at the path the route actually lives at', async () => {
    /**
     * The adapter strips this prefix to find the procedure name. If it disagreed with
     * the folder — `/api/trpc/[trpc]` — every call would resolve to a mangled name and
     * 404, with a router that is entirely fine.
     */
    await GET(new Request('http://x/api/trpc/expenses.list'));
    expect(args().endpoint).toBe('/api/trpc');
  });

  it('passes the real request through', async () => {
    const req = new Request('http://x/api/trpc/expenses.list');
    await GET(req);
    expect(args().req).toBe(req);
  });

  it('serves the app router, not an empty one', async () => {
    await GET(new Request('http://x'));
    expect(args().router).toEqual({ __brand: 'appRouter' });
  });

  it('builds a fresh context per request', async () => {
    /** Sharing one context across requests would leak the caller's session into the
     *  next caller's procedures. */
    await GET(new Request('http://x'));
    expect(args().createContext).toBeTypeOf('function');
  });
});

describe('both verbs', () => {
  it('answers GET — queries', async () => {
    expect((await GET(new Request('http://x'))).status).toBe(200);
  });

  it('answers POST — mutations', async () => {
    expect((await POST(new Request('http://x'))).status).toBe(200);
  });

  it('uses one handler for both, so they cannot drift apart', () => {
    expect(GET).toBe(POST);
  });
});

describe('error reporting', () => {
  it('logs a failing procedure outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await GET(new Request('http://x'));
    args().onError({ error: { message: 'boom' }, path: 'expenses.list' });
    expect(spy).toHaveBeenCalledWith('[tRPC] expenses.list: boom');
    spy.mockRestore();
  });

  it('says so when the failure had no procedure to blame', async () => {
    /** A malformed body fails before routing, so `path` is undefined — printing
     *  `undefined` there sends people looking for a procedure of that name. */
    vi.stubEnv('NODE_ENV', 'development');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await GET(new Request('http://x'));
    args().onError({ error: { message: 'bad json' } });
    expect(spy).toHaveBeenCalledWith('[tRPC] <no-path>: bad json');
    spy.mockRestore();
  });

  it('stays silent in production', async () => {
    /**
     * Procedure errors carry argument values in their messages. In production this
     * would write user input — amounts, emails, card fragments — into CloudWatch,
     * which is a different retention and access regime than the audit log.
     */
    vi.stubEnv('NODE_ENV', 'production');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await GET(new Request('http://x'));
    args().onError({ error: { message: 'boom' }, path: 'expenses.list' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
