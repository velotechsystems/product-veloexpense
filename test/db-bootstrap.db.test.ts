/**
 * `scripts/db-bootstrap.mjs` — the deployed database's app role, and the check
 * that keeps the VX5-20 hazard (empty pg_default_acl) out of a long-lived
 * database.
 *
 * Uses its own ROLE ('vx_boot_test'), not an org slug: this suite creates a
 * login, not tenant rows. Everything it creates is dropped in afterAll.
 *
 * Logins are made over TCP to 127.0.0.1, where CI's postgres image authenticates
 * with SCRAM — so a password that "works" here was really checked. (A trust
 * entry would accept any password and prove nothing; the cloud harness adds a
 * scram-sha-256 line for this role for the same reason.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client, Pool } from 'pg';
import { parse } from 'pg-connection-string';
import { bootstrap, scramVerifier } from '../scripts/db-bootstrap.mjs';

const ROLE = 'vx_boot_test';
const PW1 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
const PW2 = 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6';

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

/** A TCP URL for `user`, on the database and port the suite already uses. */
function tcpUrl(user: string, password: string): string {
  // pg's own parser: the harness uses a socket URL (`postgresql://u@/db?host=…`)
  // that WHATWG URL refuses.
  const u = parse(process.env.DATABASE_URL!);
  return `postgres://${user}:${password}@127.0.0.1:${u.port ?? '5432'}/${u.database}`;
}

async function canLogin(password: string): Promise<boolean> {
  const c = new Client({ connectionString: tcpUrl(ROLE, password) });
  try {
    await c.connect();
    await c.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

async function withAdminClient<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

async function dropRole() {
  await admin.query('DROP TABLE IF EXISTS public.vx_boot_later');
  const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
  if (exists.rowCount) {
    await admin.query(`DROP OWNED BY ${ROLE}`);
    await admin.query(`DROP ROLE ${ROLE}`);
  }
}

beforeAll(dropRole);
afterAll(async () => {
  await dropRole();
  await admin.end();
});

describe('scramVerifier', () => {
  it('produces the pg_authid SCRAM format', () => {
    const v = scramVerifier(PW1) as string;
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain(PW1);
  });
});

describe('bootstrap', () => {
  it('creates a role that logs in with the generated password, over SCRAM, and only with it', async () => {
    const r = await withAdminClient((c) => bootstrap(c, { appUser: ROLE, appPassword: PW1 }));
    expect(r.created).toBe(true);
    expect(await canLogin(PW1)).toBe(true);
    expect(await canLogin(PW2)).toBe(false);
  });

  it('stores a verifier, never the password', async () => {
    const r = await admin.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [ROLE]);
    expect(r.rows[0].rolpassword).toMatch(/^SCRAM-SHA-256\$/);
    expect(r.rows[0].rolpassword).not.toContain(PW1);
  });

  it('the role is subject to row level security', async () => {
    const r = await admin.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    // A FORCE-RLS tenant table with no tenant context: zero rows, not an error and not everything.
    const c = new Client({ connectionString: tcpUrl(ROLE, PW1) });
    await c.connect();
    try {
      const rows = await c.query('SELECT count(*)::int AS n FROM app_user');
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('a table a LATER migration creates is usable by the role — default privileges, not a one-off grant', async () => {
    await admin.query('CREATE TABLE public.vx_boot_later (id bigserial PRIMARY KEY, v text)');
    const c = new Client({ connectionString: tcpUrl(ROLE, PW1) });
    await c.connect();
    try {
      await c.query("INSERT INTO public.vx_boot_later (v) VALUES ('ok')"); // needs the sequence too
      const r = await c.query('SELECT v FROM public.vx_boot_later');
      expect(r.rows).toEqual([{ v: 'ok' }]);
    } finally {
      await c.end();
      await admin.query('DROP TABLE public.vx_boot_later');
    }
  });

  it('is idempotent, and re-running with a new password replaces the old one', async () => {
    const r = await withAdminClient((c) => bootstrap(c, { appUser: ROLE, appPassword: PW2 }));
    expect(r.created).toBe(false);
    expect(await canLogin(PW2)).toBe(true);
    expect(await canLogin(PW1)).toBe(false);
  });

  it('FAILS when default privileges are missing, instead of letting migrate run', async () => {
    await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${ROLE}`);
    await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${ROLE}`);
    // A client that drops the ALTER DEFAULT PRIVILEGES statements — the shape of a
    // database whose setup never ran them.
    const err = await withAdminClient((c) => {
      const skipping = {
        query: (sql: unknown, args?: unknown[]) =>
          typeof sql === 'string' && sql.startsWith('ALTER DEFAULT PRIVILEGES')
            ? Promise.resolve({ rows: [], rowCount: 0 })
            : c.query(sql as string, args),
      };
      return bootstrap(skipping, { appUser: ROLE, appPassword: PW2 }).catch((e: unknown) => e);
    });
    expect(String(err)).toMatch(/pg_default_acl is missing grants to vx_boot_test .*: tables .*; sequences/);
  });

  it.each([
    ['a role name that is not an identifier', { appUser: 'x; DROP ROLE postgres', appPassword: PW1 }, /refusing app role name/],
    ['a short password', { appUser: ROLE, appPassword: 'short1' }, /at least 24/],
    ['a password with punctuation', { appUser: ROLE, appPassword: `${PW1}'--` }, /letters and digits/],
  ])('refuses %s', async (_label, input, message) => {
    const err = await withAdminClient((c) => bootstrap(c, input).catch((e: unknown) => e));
    expect(String(err)).toMatch(message);
  });
});
