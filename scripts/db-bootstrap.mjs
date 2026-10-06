#!/usr/bin/env node
/**
 * Make a fresh (or existing) database ready for `scripts/migrate.mjs` and for
 * the app's least-privilege login — the deployed version of HANDOFF §3's
 * "non-superuser app role (RLS applies) — run once" block.
 *
 * Runs as the FIRST half of the database task (infrastructure/cdk compute-stack:
 * `node scripts/db-bootstrap.mjs && node scripts/migrate.mjs`), as the master
 * login, before every migration run. Idempotent: safe on every deploy, and it is
 * meant to run on every deploy, because it also checks something that can drift.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 *
 *   1. Creates the app role if absent and (re)sets its password from the
 *      generated secret, with NOSUPERUSER NOBYPASSRLS spelled out. A role that
 *      could bypass RLS would make every isolation test in this repo describe a
 *      database the app does not actually run against.
 *   2. Grants what HANDOFF §3 grants, on what exists now.
 *   3. ALTER DEFAULT PRIVILEGES — FOR ROLE the migrating login, explicitly — so a
 *      table or sequence a LATER migration creates is usable by the app too.
 *   4. VERIFIES step 3 in pg_default_acl and fails the task if it is missing.
 *      This is the VX5-20 hazard from HANDOFF: CI grants ON ALL TABLES after
 *      migrating, which hides a database that never had default privileges; a
 *      long-lived one then breaks on the first migration that adds a table, and
 *      the first sign is "permission denied" in production. Here it fails the
 *      deploy before the migration instead.
 *
 * ── WHY THE PASSWORD IS SENT AS A SCRAM VERIFIER ─────────────────────────────
 *
 * The cluster logs DDL (`log_statement = ddl`) and pgaudit logs role changes,
 * and both write the STATEMENT TEXT to CloudWatch. `ALTER ROLE … PASSWORD
 * 'plaintext'` would put the app's database password in a log group far more
 * people can read than the secret. Neither setting can be turned off for one
 * session without superuser, which Aurora's master login is not.
 *
 * So the password is hashed HERE into the SCRAM-SHA-256 verifier Postgres would
 * have stored anyway, and that is what the statement carries. The verifier
 * cannot be replayed as a client login (it holds StoredKey, not ClientKey) — it
 * is exactly what `pg_authid` already contains.
 *
 * Environment (docker-entrypoint.sh composes ADMIN_DATABASE_URL):
 *   ADMIN_DATABASE_URL   master login
 *   DB_APP_USER          app role name (from the app-db secret)
 *   DB_APP_PASSWORD      its password (from the same secret)
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802 / 7677,
 * the format of `pg_authid.rolpassword`). The password is used as given, without
 * SASLprep: generated app passwords are ASCII alphanumeric, which SASLprep leaves
 * unchanged, and anything else is refused by `bootstrap` below.
 */
export function scramVerifier(password, { salt = randomBytes(16), iterations = 4096 } = {}) {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Run the bootstrap on `client` (connected as the migrating login). Returns what it did. */
export async function bootstrap(client, { appUser, appPassword }) {
  if (!ROLE_NAME.test(appUser ?? '')) throw new Error(`db-bootstrap: refusing app role name ${JSON.stringify(appUser)}`);
  if (!/^[A-Za-z0-9]{24,}$/.test(appPassword ?? '')) {
    throw new Error('db-bootstrap: the app password must be at least 24 ASCII letters and digits (see SecurityStack app-db).');
  }

  const who = (await client.query('SELECT current_user AS u, current_database() AS d')).rows[0];
  if (who.u === appUser) throw new Error('db-bootstrap: connected AS the app role; it must run as the migrating login.');

  const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser])).rowCount === 1;
  const verifier = scramVerifier(appPassword);
  // Identifiers and the literal are quoted BY POSTGRES (format %I / %L), never
  // concatenated here. Inputs are also constrained above.
  const ddl = async (template, ...args) => {
    const sql = (await client.query(`SELECT format(${template}) AS s`, args)).rows[0].s;
    await client.query(sql);
  };
  if (!exists) await ddl(`'CREATE ROLE %I LOGIN', $1::text`, appUser);
  await ddl(
    `'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text, $2::text`,
    appUser,
    verifier,
  );

  await ddl(`'GRANT CONNECT ON DATABASE %I TO %I', $1::text, $2::text`, who.d, appUser);
  await ddl(`'GRANT USAGE ON SCHEMA public TO %I', $1::text`, appUser);
  await ddl(`'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', $1::text`, appUser);
  await ddl(`'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', $1::text`, appUser);
  // FOR ROLE current_user, spelled out: default privileges belong to the role
  // that will CREATE the objects, which is this login (migrate.mjs runs as it).
  await ddl(
    `'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', $1::text, $2::text`,
    who.u,
    appUser,
  );
  await ddl(
    `'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', $1::text, $2::text`,
    who.u,
    appUser,
  );

  // The check, not the statement, is the point (see header §4).
  const acl = await client.query(
    `SELECT d.defaclobjtype AS kind, array_to_string(d.defaclacl, ',') AS acl
       FROM pg_default_acl d
       JOIN pg_roles owner ON owner.oid = d.defaclrole
       JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE owner.rolname = $1 AND n.nspname = 'public'`,
    [who.u],
  );
  const grantsTo = (kind, letters) =>
    acl.rows.some(
      (r) =>
        r.kind === kind &&
        r.acl.split(',').some((entry) => {
          const [grantee, rest = ''] = entry.split('=');
          const privs = rest.split('/')[0];
          return grantee === appUser && [...letters].every((l) => privs.includes(l));
        }),
    );
  const missing = [];
  if (!grantsTo('r', 'arwd')) missing.push('tables (SELECT, INSERT, UPDATE, DELETE)');
  if (!grantsTo('S', 'rU')) missing.push('sequences (USAGE, SELECT)');
  if (missing.length > 0) {
    throw new Error(
      `db-bootstrap: pg_default_acl is missing grants to ${appUser} on objects ${who.u} creates: ${missing.join('; ')}. ` +
        'The next migration that adds one would break the app. Refusing to continue to migrate.',
    );
  }

  const role = (
    await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [appUser])
  ).rows[0];
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(`db-bootstrap: ${appUser} can bypass row level security; refusing.`);
  }
  return { created: !exists, database: who.d, migrator: who.u };
}

async function main() {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    console.error('db-bootstrap: ADMIN_DATABASE_URL is not set.');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await bootstrap(client, {
      appUser: process.env.DB_APP_USER,
      appPassword: process.env.DB_APP_PASSWORD,
    });
    // Names only. Never the password, never the verifier.
    console.log(
      `db-bootstrap OK — ${r.created ? 'created' : 'updated'} role ${process.env.DB_APP_USER} on ${r.database}; ` +
        `default privileges for objects ${r.migrator} creates verified.`,
    );
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
