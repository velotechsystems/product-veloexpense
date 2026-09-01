/**
 * THE SCHEMA-DRIFT GATE. Closes the class that cost VX4-3 part 2 an e2e run.
 *
 * `0023` was merged and never applied to a developer's database. `npm run e2e`
 * built, passed `check:actions`, seeded, and then died inside `approval-flow` — a
 * spec with nothing to do with branding — on `column "brand_color" does not
 * exist`, in a `[WebServer]` log rather than as a test failure. Nothing in the
 * pipeline could have caught it: migrations were applied by hand from a README
 * line, e2e never looked, and CI creates a fresh database and applies every file
 * in a loop, so CI is structurally incapable of noticing drift.
 *
 * This is the cheap half of the fix — `scripts/migrate.mjs` is the mechanism, and
 * this is the generated assertion that proves it ran, in the house pattern of
 * `test/rls-coverage`, `test/tenant-fk` and the vendor guard. It is GENERATED from
 * the directory listing, so it cannot rot: migration `0024` is covered by this
 * file the moment it exists, without anybody remembering this file exists.
 *
 * WHAT IT BUYS, concretely: the failure above becomes `npm test` saying
 * "0023_tenant_branding is on disk but not applied", before a build, in one line,
 * naming the fix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'prisma/migrations';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

const onDisk = readdirSync(DIR)
  .filter((n) => statSync(join(DIR, n)).isDirectory())
  .filter((n) => {
    try {
      return statSync(join(DIR, n, 'migration.sql')).isFile();
    } catch {
      return false;
    }
  })
  .sort();

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const sqlOf = (n: string) => readFileSync(join(DIR, n, 'migration.sql'), 'utf8');

let ledger: Map<string, string>;

beforeAll(async () => {
  const exists = await admin.query(
    `SELECT to_regclass('schema_migration') IS NOT NULL AS yes`,
  );
  if (!exists.rows[0].yes) {
    ledger = new Map();
    return;
  }
  const rows = await admin.query('SELECT name, checksum FROM schema_migration');
  ledger = new Map(rows.rows.map((r) => [r.name as string, r.checksum as string]));
});

afterAll(async () => {
  await admin.end();
});

describe('schema drift', () => {
  it('has a ledger at all', () => {
    // An absent ledger means this database has never seen the runner. On a fresh
    // database `npm run migrate` creates and fills it; on an existing one it asks
    // for a one-time `--baseline`, because guessing which migrations are already
    // in would either replay DDL or skip it.
    expect(
      ledger.size,
      'no schema_migration ledger — run `npm run migrate` (it will tell you if it needs --baseline)',
    ).toBeGreaterThan(0);
  });

  it('finds migrations on disk to check', () => {
    // Guards the guard: a broken glob would make every assertion below vacuous,
    // which is the failure mode this project keeps paying for.
    expect(onDisk.length).toBeGreaterThan(20);
    expect(onDisk[0]).toMatch(/^0001_/);
  });

  it('has applied EVERY migration on disk', () => {
    const missing = onDisk.filter((n) => !ledger.has(n));
    expect(
      missing,
      `on disk but not applied — run \`npm run migrate\`:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has applied nothing that is NOT on disk', () => {
    // The other direction, and it is not symmetric noise: a ledger row with no
    // file means somebody applied a migration and then deleted or renamed it, so
    // the repository can no longer reproduce this database.
    const orphans = [...ledger.keys()].filter((n) => !onDisk.includes(n));
    expect(
      orphans,
      `applied but no longer on disk — this database cannot be rebuilt from the repo:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has not had an applied migration EDITED since', () => {
    // An applied migration is history. If the file changed, the database and the
    // repository disagree about what the schema is, and every later reading of
    // the files is wrong — including the two guards above, which would still pass.
    const changed = onDisk.filter((n) => ledger.has(n) && ledger.get(n) !== sha(sqlOf(n)));
    expect(
      changed,
      `applied and then edited — write a new migration instead:\n  ${changed.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no gap: nothing applied sits above something unapplied', () => {
    const firstPending = onDisk.findIndex((n) => !ledger.has(n));
    const gaps = firstPending < 0 ? [] : onDisk.slice(firstPending).filter((n) => ledger.has(n));
    expect(
      gaps,
      `applied out of order, above the unapplied ${onDisk[firstPending]}:\n  ${gaps.join('\n  ')}`,
    ).toEqual([]);
  });
});
