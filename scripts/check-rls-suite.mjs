#!/usr/bin/env node
/**
 * Every tenant table is named in `test/rls-isolation.test.ts`.
 *
 * ── THIS GATE ALREADY EXISTED. IT WAS JUST NOT RUNNABLE. ───────────────────
 *
 * VX2-10 put this check in `ci.yml` as inline shell, and it is a good check —
 * the RLS-coverage guard beside it proves every tenant table has a POLICY, which
 * is a different claim from anybody having ASSERTED that the policy works. A
 * table with correct RLS and no test is checked by nobody, and that guard would
 * stay green forever.
 *
 * VX5-12 added `tenant_export` and CI caught it. That is the gate working — and
 * it is also the whole reason this file exists, because **I had run every
 * `npm run check:` script and the entire test suite locally, and none of them
 * was this.** A gate that only exists inside a CI YAML cannot be run before a
 * push, so the feedback arrives after the branch is up rather than before, and
 * the person who finds out is whoever is watching the Actions tab.
 *
 * So the logic moved here and `ci.yml` calls it. One implementation, two
 * callers, and the local one is the one that catches it first.
 *
 * ── WHY A grep RATHER THAN SOMETHING CLEVERER ──────────────────────────────
 *
 * Inherited from the CI step, and kept deliberately. A grep for the table name
 * cannot tell an assertion from a comment, so it is a weak check — but it is a
 * check on the RIGHT thing (does anybody mention this table at all) and its
 * failure mode is a false PASS, never a false alarm that trains people to
 * ignore it. Making it stricter would mean parsing the suite, and a table named
 * only in a comment is a problem a reviewer can see; a table named nowhere is
 * the one nobody can.
 *
 * NOTE: the sibling guard in `ci.yml` — "every tenant table has ENABLE+FORCE
 * RLS" — has the same problem and is NOT moved here, because it is a different
 * ticket's check and this one is the one that bit. It is worth doing.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const SUITE = 'test/rls-isolation.test.ts';

const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('check-rls-suite: set ADMIN_DATABASE_URL (or DATABASE_URL).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

const { rows } = await client.query(`
  SELECT c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'organization_id'
                    AND NOT a.attisdropped)
   ORDER BY c.relname`);
await client.end();

if (rows.length === 0) {
  // The vacuity guard the CI step never had: an empty list passes every check
  // below, and pointing at the wrong database is exactly what would empty it.
  console.error('check-rls-suite: found NO tenant tables. That is a broken check, not a pass.');
  process.exit(1);
}

const suite = readFileSync(SUITE, 'utf8');
const untested = rows
  .map((r) => r.table_name)
  .filter((t) => !new RegExp(`\\b${t}\\b`).test(suite));

if (untested.length > 0) {
  console.error(`\n✗ ${untested.length} tenant table(s) absent from ${SUITE}:\n`);
  for (const t of untested) console.error(`  ${t}`);
  console.error(
    '\nA tenant table with correct RLS and no test is asserted by nobody, and the\n' +
      'RLS-coverage guard would stay green forever. Add a case naming the table:\n' +
      'read it from two tenants, prove WITH CHECK refuses naming another, and\n' +
      'prove no platform flag opens it. `subscription_meter_reading` is the\n' +
      'shortest example in the suite.\n',
  );
  process.exit(1);
}

console.log(
  `check-rls-suite OK — all ${rows.length} tenant tables are named in ${SUITE}.`,
);
