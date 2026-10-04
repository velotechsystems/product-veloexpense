/**
 * ONE FAILURE THAT NAMES ITS OWN CAUSE.
 *
 * ── THE PROBLEM THIS EXISTS FOR ────────────────────────────────────────────
 *
 * 56 of this suite's 89 files read `ADMIN_DATABASE_URL`, 57 read
 * `DATABASE_URL`, and there is NO path to either except the shell: no dotenv in
 * this repo, no `setupFiles` doing the loading, and `npm test` is a bare
 * `vitest run`. `. scripts/dev-env.sh` is the whole mechanism.
 *
 * Forget it and you do not get "environment not set". You get 55 files failing
 * with
 *
 *     database "<your login>" does not exist
 *
 * which reads as a broken local database and is not one. node-pg has no notion
 * of "unset": with no connection string it falls back to its own defaults —
 * `user = $USER` (defaults.js:5), `port = 5432` (defaults.js:29), and
 * `database = user` when no database is given (connection-parameters.js:66-67).
 * So every DB suite dials the DEFAULT cluster on 5432, that cluster answers,
 * and its answer is a confident, specific, WRONG diagnosis: it names the
 * database subsystem for a fault that is entirely in the shell.
 *
 * That cost this project a week and two merges that went in on CI alone. The
 * fix is not to remember. It is to make the failure say what is actually wrong,
 * once, before any test file runs.
 *
 * ── WHY globalSetup AND NOT setupFiles ─────────────────────────────────────
 *
 * `setupFiles` runs once PER TEST FILE, so a throw there reproduces the same
 * wall of 55 identical errors in a more legible costume. `globalSetup` runs
 * once, in the main process, before anything is collected — a throw here aborts
 * the run with a single message, which is the entire point.
 *
 * ── WHY IT CONNECTS RATHER THAN JUST READING process.env ───────────────────
 *
 * A presence check would pass on a well-formed URL pointing at nothing, and the
 * run would then fail 55 times with `ECONNREFUSED` — legible, but still 55
 * times and still not naming the port. Connecting once is what lets this
 * distinguish the three states that actually occur: the variable is missing,
 * the server is not there, or the credentials/database are wrong. Each gets its
 * own message.
 *
 * A guard that cannot tell those apart is worth very little; a guard that
 * swallowed the error and let the run proceed would be worth less than nothing,
 * which is why nothing here catches-and-continues.
 */
import { Client } from 'pg';

/** Never print a password, not even a local one, and not even into a log. */
function mask(url: string): string {
  return url.replace(/(:\/\/[^:/@]*:)[^@]*(@)/, '$1***$2');
}

/**
 * Host and port as the driver will actually resolve them, for the message.
 *
 * `new URL` is not sufficient on its own and the way it fails is worth naming:
 * it THROWS on `postgresql://user@/dbname?host=/var/run&port=5499`, the libpq
 * socket form, because an empty host with credentials present is invalid under
 * WHATWG for every scheme. That is the exact form this function was written to
 * describe. An earlier version reported it as "unparseable connection string" —
 * a tool announcing a parse failure about a string Postgres parses fine, which
 * is the same defect shape as the message this whole file exists to replace.
 * So: WHATWG first, libpq query parameters second, and "could not parse" only
 * when both genuinely fail.
 */
function endpoint(url: string): string {
  const fromParams = (qs: string): string | null => {
    const p = new URLSearchParams(qs);
    const host = p.get('host');
    const port = p.get('port') ?? '5432';
    if (!host) return null;
    return host.startsWith('/') ? `unix socket ${host}, port ${port}` : `host ${host}, port ${port}`;
  };

  try {
    const u = new URL(url);
    const viaParams = fromParams(u.search.replace(/^\?/, ''));
    if (viaParams) return viaParams;
    return `host ${u.hostname || 'localhost'}, port ${u.port || '5432'}`;
  } catch {
    const q = url.indexOf('?');
    if (q >= 0) {
      const viaParams = fromParams(url.slice(q + 1));
      if (viaParams) return viaParams;
    }
    // Last resort: the authority, if there is a recognisable one.
    const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(url);
    if (m?.[1]) {
      const [host, port] = m[1].split(':');
      if (host) return `host ${host}, port ${port ?? '5432'}`;
    }
    return 'could not parse a host out of the connection string';
  }
}

const RULE = '─'.repeat(74);

/**
 * Every message starts with ONE self-contained line, before the box.
 *
 * The first version opened with `\n${RULE}`, so the error's first line was
 * empty and anything that shows only that line — a grep for `Error:`, a CI
 * annotation, a notification — printed `Error: ` and nothing else. That is how
 * it was first read on macOS: as a guard that had gone silent, when the full
 * message underneath named the port and both addresses correctly. The box is
 * for a human reading the whole thing; the headline is for every tool that
 * reads one line.
 */

function missing(names: string[]): never {
  throw new Error(
    `test environment not in this shell: missing ${names.join(', ')} ` +
      `(run: . scripts/dev-env.sh)\n` +
      `${RULE}\n` +
      `  THE TEST ENVIRONMENT IS NOT IN THIS SHELL.\n\n` +
      `  Missing: ${names.join(', ')}\n\n` +
      `  Fix, from the repo root:\n\n` +
      `      . scripts/dev-env.sh && npm test\n\n` +
      `  You are seeing this INSTEAD OF 55 connection errors on purpose.\n` +
      `  node-pg has no notion of "unset": with no connection string it falls\n` +
      `  back to user=$USER, port=5432, database=$USER — so every DB suite\n` +
      `  dials your DEFAULT cluster, which answers\n\n` +
      `      database "${process.env.USER ?? '<your login>'}" does not exist\n\n` +
      `  That message names the database for a fault that is in the shell.\n` +
      `  This check exists so it cannot mislead you again.\n` +
      `${RULE}\n`,
  );
}

/**
 * The driver's own words — which on a Mac are not where you would look.
 *
 * Node's dual-stack connect tries every address a name resolves to and, when
 * they all fail, raises an `AggregateError` whose OWN `message` is the empty
 * string; the per-address failures ("connect ECONNREFUSED 127.0.0.1:5433") are
 * in `.errors`. On Linux the same failure arrives as a plain error with the
 * address in the message.
 *
 * The first version of this file read `err.message` alone. Five provoked
 * failures all read back correctly — every one of them on Linux. The first
 * real run on macOS printed `-> ECONNREFUSED` and then nothing: a guard built
 * to be specific about the endpoint, silent about the endpoint, on the only
 * platform it was written for. Verifying on one platform says nothing about
 * the other, and the shape of what it misses is not predictable from the pass.
 */
function describe(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { errors?: unknown[] };
  const parts: string[] = [];
  if (e.message) parts.push(e.message);
  if (Array.isArray(e.errors)) {
    for (const sub of e.errors) {
      const m = (sub as Error | undefined)?.message;
      if (m && !parts.includes(m)) parts.push(m);
    }
  }
  return parts.length > 0 ? parts.join('; ') : '(the driver reported no message, only the code)';
}

function unreachable(name: string, url: string, err: NodeJS.ErrnoException & { code?: string }): never {
  const code = err.code ?? '(no code)';
  const hint =
    code === 'ECONNREFUSED'
      ? 'Nothing is listening there. Start the cluster, or check that the port in\n' +
        '  .env.local / HANDOFF.md is the port your server is actually on.'
      : code === '3D000'
        ? 'The server is up but has no such database. Create it, or run the migrations:\n' +
          '  npm run migrate'
        : code === '28P01' || code === '28000'
          ? 'The server is up and rejected these credentials. Check the role and password\n' +
            '  in .env.local (app role) and HANDOFF.md (superuser).'
          : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
            ? 'That host does not resolve. Check the hostname in the connection string.'
            : 'Unrecognised failure — the driver error is reproduced above verbatim.';

  throw new Error(
    `${name} did not answer: ${code} at ${endpoint(url)}\n` +
      `${RULE}\n` +
      `  ${name} IS SET, BUT THE DATABASE DID NOT ANSWER.\n\n` +
      `      ${mask(url)}\n` +
      `      ${endpoint(url)}\n` +
      `      -> ${code}  ${describe(err)}\n\n` +
      `  ${hint}\n\n` +
      `  This is the OTHER failure shape, and it is worth telling apart from the\n` +
      `  first: a missing variable never reaches port 5433 at all.\n` +
      `${RULE}\n`,
  );
}

async function probe(name: string, url: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query('select 1');
  } catch (err) {
    // Deliberately no recovery path: a guard that continued past this would be
    // reporting success about something it had just failed to observe.
    unreachable(name, url, err as NodeJS.ErrnoException);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function setup(): Promise<void> {
  const required = ['DATABASE_URL', 'ADMIN_DATABASE_URL'] as const;
  const absent = required.filter((n) => !process.env[n]);
  if (absent.length > 0) missing([...absent]);

  // ADMIN first: it is the one that TRUNCATEs, so its failure is the one that
  // would otherwise take out every `beforeAll` in the suite.
  await probe('ADMIN_DATABASE_URL', process.env.ADMIN_DATABASE_URL as string);
  await probe('DATABASE_URL', process.env.DATABASE_URL as string);
}
