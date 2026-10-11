import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The worker's env contract, which has to match apps/web's.
 *
 * The two processes read the same `.env.local` and `.env` at the monorepo root, and the
 * worker is four directories down from it. A wrong number of `..` segments does not throw —
 * dotenv treats a missing file as a no-op — so the worker boots with none of the local
 * environment and fails later on whatever it needed first, usually `DATABASE_URL`. That
 * silence is the reason this is worth a test.
 *
 * In production the task definition injects everything and neither file exists, so the
 * whole block is skipped rather than relying on the same no-op.
 */

const h = vi.hoisted(() => ({ paths: [] as string[], quiet: [] as unknown[] }));

vi.mock('dotenv', () => ({
  default: {
    config: (opts: { path: string; quiet?: boolean }) => {
      h.paths.push(opts.path);
      h.quiet.push(opts.quiet);
      return {};
    },
  },
}));

const NODE_ENV = process.env.NODE_ENV;
/** VeloExpense: Next.js types `process.env.NODE_ENV` read-only; the test writes it. */
const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  h.paths = [];
  h.quiet = [];
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (NODE_ENV === undefined) delete (process.env as Record<string, unknown>).NODE_ENV;
  else env.NODE_ENV = NODE_ENV;
});

describe('outside production', () => {
  beforeEach(() => {
    env.NODE_ENV = 'development';
  });

  it('loads both root env files', async () => {
    await import('./env');
    expect(h.paths).toHaveLength(2);
    expect(h.paths[0].endsWith('.env.local')).toBe(true);
    expect(h.paths[1].endsWith('.env')).toBe(true);
  });

  it('reads them from the monorepo root, not from the worker directory', async () => {
    /**
     * The failure this catches: one `..` too few or too many resolves to a path that does
     * not exist, dotenv no-ops, and the worker boots with no local environment at all —
     * surfacing much later as a missing DATABASE_URL rather than as a bad path.
     */
    await import('./env');
    for (const p of h.paths) {
      expect(p).not.toContain('apps/worker');
      expect(p).not.toContain(`apps${'/'}worker`);
    }
    // Root-anchored: the two files sit beside each other in the same directory.
    const [local, plain] = h.paths;
    expect(local.slice(0, local.lastIndexOf('/'))).toBe(plain.slice(0, plain.lastIndexOf('/')));
  });

  it('loads .env.local first, so it wins over .env', async () => {
    /** dotenv does not overwrite an already-set variable, so order IS precedence — and
     *  `.env.local` is the file a developer edits. */
    await import('./env');
    expect(h.paths[0]).toMatch(/\.env\.local$/);
  });

  it('asks dotenv not to narrate', async () => {
    /** The worker's first lines of output are its boot log; two dotenv tips ahead of them
     *  are noise in every container start. */
    await import('./env');
    expect(h.quiet).toEqual([true, true]);
  });
});

describe('in production', () => {
  it('reads no files at all', async () => {
    /** ECS injects the environment from the task definition and neither file is in the
     *  image; skipping is cheaper than two failed stat calls, and says so. */
    env.NODE_ENV = 'production';
    await import('./env');
    expect(h.paths).toEqual([]);
  });
});
