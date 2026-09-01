#!/usr/bin/env node
/**
 * THE MIGRATION RUNNER, and the ledger that makes it one. John's call, 1 Sep.
 *
 * ── The failure that bought this ────────────────────────────────────────────
 *
 * `0023` was merged and never applied to a developer's database. The next
 * `npm run e2e` built, passed `check:actions`, seeded, and then died inside
 * `approval-flow` — a spec with nothing to do with branding — on
 * `column "brand_color" does not exist`, printed in a `[WebServer]` log rather
 * than as a test failure. VX4-3 part 2 is what made that total instead of local:
 * the root layout now reads branding on every render, so one missing column
 * breaks every page in the product.
 *
 * The class, stated plainly: migrations were applied BY HAND from a README line,
 * `npm run e2e` never checked, and CI could not catch it because CI creates a
 * fresh database and applies every file in a loop. Every path that could have
 * noticed was structurally unable to.
 *
 * ── Why a ledger and not just "run the loop locally too" ────────────────────
 *
 * CI's loop is correct only because its database is empty. Replaying `0001..0023`
 * over an existing database fails on the first `ADD COLUMN` — so the loop cannot
 * be reused locally without either dropping the developer's data every run or
 * sprinkling `IF NOT EXISTS` through the migrations, which turns every one of them
 * into a statement that cannot tell "already applied" from "silently did nothing".
 * A ledger is the smaller thing: it records what ran, so the runner can apply only
 * what has not.
 *
 * ── What it refuses, and why each refusal earns its place ───────────────────
 *
 *   A CHANGED FILE. The checksum of an applied migration is stored. If the file on
 *   disk no longer matches, the database and the repository disagree about what
 *   the schema IS, and every later reasoning from the files is wrong. Editing an
 *   applied migration is the mistake; this is where it gets caught rather than six
 *   weeks later in a restore.
 *
 *   A GAP. If `0022` is unapplied while `0023` is applied, something was run out of
 *   order by hand. Applying `0022` now would run it against a schema it was never
 *   written for. Refuse and say which.
 *
 *   AN UNLEDGERED, NON-EMPTY DATABASE. This is the one-time case every existing
 *   developer hits: schema present, ledger absent. The runner does NOT guess which
 *   migrations are already in — probing for objects would be clever and wrong, and
 *   a wrong guess either replays DDL or skips it. It asks for
 *   `--baseline <name-or-number>` once, which records everything up to that point
 *   as applied WITHOUT running it. A fresh database needs no flag, because an
 *   absent ledger plus an absent `organization` table is unambiguous.
 *
 * ── The transaction ─────────────────────────────────────────────────────────
 *
 * Each file runs inside one transaction WITH its ledger insert, so a failure
 * leaves neither a half-applied schema nor a lie in the ledger. Verified as safe
 * for this repo: no migration uses `CREATE INDEX CONCURRENTLY` or any other
 * statement that refuses a transaction block, and none opens its own — checked,
 * not assumed. A future migration that needs `CONCURRENTLY` will fail loudly here,
 * which is the right place to have that conversation.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';

const DIR = 'prisma/migrations';
const URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;

if (!URL) {
  console.error('migrate: set ADMIN_DATABASE_URL (or DATABASE_URL) first.');
  process.exit(1);
}

/** `--baseline 0023` / `--baseline 0023_tenant_branding` / `--baseline all`. */
function baselineArg() {
  const i = process.argv.indexOf('--baseline');
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v) {
    console.error('migrate: --baseline needs a migration name, its number, or `all`.');
    process.exit(1);
  }
  return v;
}

const onDisk = readdirSync(DIR)
  .filter((name) => {
    try {
      return statSync(join(DIR, name)).isDirectory();
    } catch {
      return false;
    }
  })
  .filter((name) => {
    try {
      return statSync(join(DIR, name, 'migration.sql')).isFile();
    } catch {
      return false;
    }
  })
  // Lexicographic on a zero-padded prefix IS numeric order. It stops being so at
  // 10000, which is a problem for a later century.
  .sort();

if (onDisk.length === 0) {
  console.error(`migrate: no migrations found under ${DIR}/*/migration.sql.`);
  process.exit(1);
}

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const sqlOf = (name) => readFileSync(join(DIR, name, 'migration.sql'), 'utf8');

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migration (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
  )`;

/**
 * The tables and columns a migration DECLARES, used to check a `--baseline` claim.
 *
 * Comments are stripped first. Measured: NO migration in this repo currently
 * mentions `ADD COLUMN` outside real DDL, so the stripping changes nothing today —
 * the first draft of this comment claimed otherwise and was simply wrong, which is
 * why the count got checked. It stays because the migrations here carry very long
 * prose headers that explain their own DDL, so one of them will say it eventually,
 * and the failure mode is the worst available: a scanner reading its own
 * documentation as schema reports VERIFIED for objects nobody created.
 *
 * Deliberately narrow. It understands `CREATE TABLE` and `ADD COLUMN` and nothing
 * else — no policies, functions, constraints, indexes or renames. A migration it
 * cannot read yields nothing, which is reported as "cannot verify" rather than as
 * "verified", because those are the two answers a check like this must never
 * confuse.
 */
function declaredObjects(sql) {
  const bare = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const tables = [];
  const columns = [];
  for (const stmt of bare.split(';')) {
    const created = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i.exec(stmt);
    if (created) tables.push(created[1].toLowerCase());
    const altered = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i.exec(stmt);
    if (altered) {
      for (const m of stmt.matchAll(/\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)) {
        columns.push({ table: altered[1].toLowerCase(), column: m[1].toLowerCase() });
      }
    }
  }
  return { tables, columns };
}

/**
 * Does the database actually contain what this migration says it creates?
 *
 * WHY THIS EXISTS, and it is worth the paragraph: `--baseline` is a CLAIM by the
 * operator that everything up to a point is already applied, and recording it runs
 * nothing. Get the point wrong by one and the ledger LIES — `migrate` then reports
 * "nothing pending" forever while the schema is missing a column, which is the
 * exact failure the ledger was built to prevent, now with a clean bill of health
 * on top. That happened on the first day this script existed: the operator was
 * told to run `--baseline all` against a database that was current through `0022`
 * and had never seen `0023`, so `0023` was marked applied, `migrate` said
 * "nothing pending", and six Playwright specs died on `column "brand_color" does
 * not exist` exactly as before.
 *
 * The bad instruction was mine. This is the check that makes it impossible to
 * follow.
 */
async function verifyPresent(client, objects) {
  const missing = [];
  for (const t of objects.tables) {
    const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS yes`, [t]);
    if (!r.rows[0].yes) missing.push(t);
  }
  for (const { table, column } of objects.columns) {
    const r = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2
       ) AS yes`,
      [table, column],
    );
    if (!r.rows[0].yes) missing.push(`${table}.${column}`);
  }
  return missing;
}

const client = new pg.Client({ connectionString: URL });
await client.connect();

let exitCode = 0;
try {
  // The ledger is the RUNNER's bookkeeping, not a migration — it has to exist
  // before the first migration can be recorded, so it cannot be one of them.
  await client.query(LEDGER);

  const applied = new Map(
    (await client.query('SELECT name, checksum FROM schema_migration')).rows.map((r) => [
      r.name,
      r.checksum,
    ]),
  );

  // ── the one-time baseline ─────────────────────────────────────────────────
  //
  // THE CONDITION IS "THE LEDGER IS EMPTY", not "the ledger did not exist", and the
  // difference was a bug in the first version of this script that only running it
  // could find. The ask below exits(1) — but `CREATE TABLE IF NOT EXISTS` has
  // already run by then, so on the very next invocation the table EXISTED, the
  // block was skipped, and the `--baseline` this script had just told the user to
  // pass was silently ignored: it went straight to applying `0001` against a
  // populated database and died on `relation "organization" already exists`.
  //
  // Guidance that leads to a worse failure than the one it is explaining is the
  // worst kind, and this one was self-inflicted in a single run. An empty ledger is
  // the honest test of "has this ever been recorded".
  const baseline = baselineArg();
  if (baseline !== null && applied.size > 0) {
    console.error(
      `migrate: --baseline is a one-time operation and this ledger already has ` +
        `${applied.size} row(s). Refusing rather than quietly ignoring the flag — ` +
        `if the ledger is genuinely wrong, correct it deliberately in SQL.`,
    );
    process.exit(1);
  }

  if (applied.size === 0) {
    const populated = (
      await client.query(`SELECT to_regclass('organization') IS NOT NULL AS yes`)
    ).rows[0].yes;

    if (populated && baseline === null) {
      console.error(
        'migrate: this database has a schema but no ledger, so the runner cannot tell\n' +
          '  which migrations are already applied — and guessing would either replay DDL\n' +
          '  or skip it. Record the ones that are in with, e.g.:\n\n' +
          `      node scripts/migrate.mjs --baseline ${onDisk[onDisk.length - 1].slice(0, 4)}\n\n` +
          '  That marks every migration up to and including it as applied WITHOUT running\n' +
          '  it. Use `--baseline all` for a database that is fully up to date. Do this once.',
      );
      process.exit(1);
    }

    if (baseline !== null) {
      const upto =
        baseline === 'all'
          ? onDisk.length - 1
          : onDisk.findIndex((n) => n === baseline || n.startsWith(`${baseline}_`) || n.slice(0, 4) === baseline);
      if (upto < 0) {
        console.error(`migrate: --baseline ${baseline} matches no migration under ${DIR}.`);
        process.exit(1);
      }
      // ── verify the claim BEFORE recording it ────────────────────────────
      //
      // Walk backwards from the newest migration being baselined to the first one
      // whose objects this scanner can actually read, and require every one of
      // them to be present. Backwards, because the newest is the claim most
      // likely to be wrong — an operator's database is usually current up to
      // "the last one I remembered to apply" — and nothing later has been applied
      // yet, so all of its objects must exist if the claim is true.
      const toBaseline = onDisk.slice(0, upto + 1);
      let verified = null;
      for (let i = toBaseline.length - 1; i >= 0; i -= 1) {
        const objects = declaredObjects(sqlOf(toBaseline[i]));
        if (objects.tables.length === 0 && objects.columns.length === 0) continue;
        const missing = await verifyPresent(client, objects);
        if (missing.length) {
          const earlier = i > 0 ? toBaseline[i - 1] : null;
          console.error(
            `migrate FAILED: --baseline ${baseline} claims ${toBaseline[i]} is already\n` +
              `  applied, but this database does not have what it creates:\n` +
              missing.map((m) => `  · ${m}`).join('\n') +
              `\n\n  Nothing was recorded. Baselining it would make the ledger LIE — every\n` +
              `  later run would report "nothing pending" while the schema stays short a\n` +
              `  column, which is the failure the ledger exists to prevent.\n\n` +
              (earlier
                ? `  If your database is current through ${earlier}, baseline THAT and let the\n` +
                  `  runner apply the rest:\n\n` +
                  `      node scripts/migrate.mjs --baseline ${earlier.slice(0, 4)}\n`
                : `  This database appears to predate even the first migration. If it is empty,\n` +
                  `  drop the ledger and run the migrations without --baseline.\n`),
          );
          process.exit(1);
        }
        verified = toBaseline[i];
        break;
      }

      for (const name of toBaseline) {
        await client.query(
          'INSERT INTO schema_migration (name, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [name, sha(sqlOf(name))],
        );
        applied.set(name, sha(sqlOf(name)));
      }
      console.log(
        `migrate: baselined ${upto + 1} migration(s) as already applied ` +
          `(${onDisk[0]} … ${onDisk[upto]}). Nothing was run.`,
      );
      console.log(
        verified === null
          ? `migrate: NOTE — none of the baselined migrations declares a table or column ` +
            `this script can check, so the claim was recorded unverified.`
          : `migrate: verified against the schema — ${verified}'s tables and columns are all present.`,
      );
    }
  }

  // ── refuse a file that changed after it was applied ───────────────────────
  const changed = [...applied.entries()].filter(
    ([name, checksum]) => onDisk.includes(name) && sha(sqlOf(name)) !== checksum,
  );
  if (changed.length) {
    console.error(
      'migrate FAILED: these migrations were applied and have since been EDITED, so the\n' +
        '  database and the repository disagree about what the schema is:\n' +
        changed.map(([n]) => `  · ${n}`).join('\n') +
        '\n\n  An applied migration is history. Write a new one that makes the change, and\n' +
        '  restore these files. (If the edit was cosmetic and you are certain the schema\n' +
        '  already matches, re-record it deliberately with an UPDATE to schema_migration.)',
    );
    process.exit(1);
  }

  // ── refuse a gap ──────────────────────────────────────────────────────────
  const pending = onDisk.filter((name) => !applied.has(name));
  const firstPending = onDisk.findIndex((n) => !applied.has(n));
  const gaps =
    firstPending < 0 ? [] : onDisk.slice(firstPending).filter((n) => applied.has(n));
  if (gaps.length) {
    console.error(
      'migrate FAILED: the ledger has a GAP — these are applied while something\n' +
        `  earlier (${onDisk[firstPending]}) is not:\n` +
        gaps.map((n) => `  · ${n}`).join('\n') +
        '\n\n  Applying the earlier one now would run it against a schema it was never\n' +
        '  written for. Fix the ledger, or rebuild the database from scratch.',
    );
    process.exit(1);
  }

  if (pending.length === 0) {
    console.log(`migrate OK — ${applied.size} migration(s) applied, nothing pending.`);
  }

  for (const name of pending) {
    const sql = sqlOf(name);
    process.stdout.write(`migrate: applying ${name} … `);
    // One transaction for the DDL AND the ledger row: a failure leaves neither a
    // half-applied schema nor a lie about it.
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [
        name,
        sha(sql),
      ]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      console.error(`\nmigrate FAILED in ${name} — nothing from it was applied:\n`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  if (pending.length) {
    console.log(`migrate OK — applied ${pending.length}, ${applied.size + pending.length} total.`);
  }
} catch (err) {
  console.error('migrate FAILED:', err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  await client.end();
}
process.exit(exitCode);
