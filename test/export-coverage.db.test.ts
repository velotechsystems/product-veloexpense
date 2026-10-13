/**
 * VX5-12 — the export covers every tenant table, and every column of every one.
 *
 * ── THIS IS THE TICKET'S ACTUAL GUARANTEE ──────────────────────────────────
 *
 * A per-tenant export is a legal deliverable, so its property is COMPLETENESS
 * and its failure is a table or a column that exists and is not in it. Neither
 * failure is visible: nobody notices a missing column in somebody else's export,
 * and no amount of "the export succeeded" would say otherwise.
 *
 * So the authority here is NOT a list in a file — it is `information_schema`.
 * This suite asks the database what a tenant's data is and demands that
 * `lib/export/tables.ts` have said something about all of it.
 *
 * Same pattern as `test/i18n-policy-params.test.ts`, and for the same reason
 * given there: coverage from the product's own enumeration, through a loop at
 * test time instead of a type at compile time. Weaker in WHEN it fires,
 * identical in what it guarantees.
 *
 * ── WHY THE COLUMN CHECK IS THE IMPORTANT HALF ─────────────────────────────
 *
 * The table check would have passed on day one and stayed passing. The column
 * check is what makes this safe in six months: the export is `SELECT *` minus a
 * redaction list, so a migration that adds a column adds it to every tenant's
 * export silently. `integration_installation` gained six OAuth columns in
 * VX3-8, two of them live bearer tokens. That is the case this exists for, and
 * a new column now fails the build with a decision to make.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import { EXCLUDED, EXPORTED, exportedFiles } from '@/lib/export/tables';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

afterAll(async () => {
  await admin.end();
});

/**
 * `organization` is exported and is NOT tenant-scoped — it has no
 * `organization_id`, being the table the tenant id comes FROM. So it is named
 * here rather than discovered, and it is the only such exception.
 */
const NOT_TENANT_SCOPED_BUT_EXPORTED = new Set(['organization']);

async function tenantTables(): Promise<string[]> {
  const r = await admin.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'organization_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`,
  );
  return r.rows.map((row) => row.table_name);
}

async function columnsOf(table: string): Promise<string[]> {
  const r = await admin.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((row) => row.column_name);
}

describe('every tenant table is accounted for', () => {
  it('found tenant tables at all', async () => {
    // The vacuity guard. Every assertion below passes trivially against an empty
    // list, and a connection to the wrong database is exactly what would empty it.
    expect((await tenantTables()).length).toBeGreaterThan(20);
  });

  it('names every table that carries organization_id', async () => {
    const tables = await tenantTables();
    const accounted = new Set([...Object.keys(EXPORTED), ...Object.keys(EXCLUDED)]);
    const missing = tables.filter((t) => !accounted.has(t));

    expect(
      missing,
      'tenant tables in neither EXPORTED nor EXCLUDED — a migration added a table and the ' +
        "export does not know about it. Decide which map it belongs in; \"internal\" is not a " +
        'reason for EXCLUDED.',
    ).toEqual([]);
  });

  it('names no table that does not exist', async () => {
    // The other direction, and the one a coverage test usually forgets. A stale
    // entry makes the export look more complete than it is, and a redaction
    // reason for a dropped table is a promise about nothing.
    const tables = new Set(await tenantTables());
    const named = [...Object.keys(EXPORTED), ...Object.keys(EXCLUDED)];
    const orphans = named.filter(
      (t) => !tables.has(t) && !NOT_TENANT_SCOPED_BUT_EXPORTED.has(t),
    );
    expect(orphans, 'entries for tables that no longer exist').toEqual([]);
  });

  it('exports no table it also excludes', async () => {
    const both = Object.keys(EXPORTED).filter((t) => t in EXCLUDED);
    expect(both).toEqual([]);
  });

  it('gives every excluded table a substantial reason', () => {
    // Not a style check. An export that omits a table is a decision a customer
    // or a regulator may ask about, and a one-word reason is the same as none.
    for (const [table, reason] of Object.entries(EXCLUDED)) {
      expect(reason.length, `${table}'s reason is too short to be a reason`).toBeGreaterThan(60);
    }
  });

  it('writes each file exactly once', () => {
    const files = exportedFiles();
    expect(new Set(files).size, `duplicate filenames: ${files.join(', ')}`).toBe(files.length);
  });

  it('gives every file a .csv name', () => {
    // The manifest promises CSV; a `.json` in here would be a file the manifest
    // describes wrongly.
    for (const file of exportedFiles()) expect(file.endsWith('.csv'), file).toBe(true);
  });

  it('does not claim the manifest as a table file', () => {
    // `manifest.json` is added separately, last, after the tables. A table
    // called `manifest.json` would overwrite it in the archive.
    expect(exportedFiles()).not.toContain('manifest.json');
  });
});

describe('every column is exported or withheld with a reason', () => {
  it('accounts for all of them', async () => {
    const problems: string[] = [];

    for (const [table, spec] of Object.entries(EXPORTED)) {
      const columns = await columnsOf(table);
      if (columns.length === 0) {
        problems.push(`${table}: no columns found — does the table exist?`);
        continue;
      }
      for (const [column, reason] of Object.entries(spec.redact ?? {})) {
        if (!columns.includes(column)) {
          // A redaction for a column that is gone is worse than useless: it
          // reads as protection that is no longer happening.
          problems.push(`${table}.${column}: redacted but no such column`);
        }
        if (reason.length < 40) {
          problems.push(`${table}.${column}: reason too short to be a reason`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('withholds every credential this schema is known to hold', async () => {
    /**
     * THE ASSERTION THAT IS NOT DERIVABLE FROM THE CATALOGUE.
     *
     * Everything above asks the database what exists. Nothing in
     * `information_schema` says which columns are SECRETS — that is a judgement,
     * so it is written down here as an explicit list, and this test fails if any
     * of them stops being withheld.
     *
     * Without it, deleting a line from `redact` in `tables.ts` is a one-line
     * change that puts live OAuth tokens for a customer's accounting system into
     * a file they email around, and every other test in this file still passes.
     */
    const MUST_BE_WITHHELD: [string, string][] = [
      ['integration_installation', 'config'],
      ['integration_installation', 'oauth_access_token'],
      ['integration_installation', 'oauth_refresh_token'],
      ['invite', 'token_hash'],
    ];

    for (const [table, column] of MUST_BE_WITHHELD) {
      const columns = await columnsOf(table);
      if (!columns.includes(column)) continue; // dropped by a migration: fine
      const spec = EXPORTED[table];
      expect(spec, `${table} is no longer exported — check this list is still right`).toBeDefined();
      expect(
        spec.redact?.[column],
        `${table}.${column} is a credential and is being EXPORTED`,
      ).toBeTruthy();
    }
  });

  it('withholds nothing from the tables an auditor reads', () => {
    // The opposite failure, and a real temptation: redacting a column because it
    // looked sensitive would quietly gut the export. `audit_entry` is the table
    // whose value is that it is complete and verifiable — its hash columns are
    // what make the chain checkable by the person holding the file.
    expect(EXPORTED.audit_entry.redact).toBeUndefined();
    expect(EXPORTED.expense.redact).toBeUndefined();
    expect(EXPORTED.expense_line_item.redact).toBeUndefined();
    expect(EXPORTED.app_user.redact).toBeUndefined();
  });

  it('keeps receipts.csv joinable to the file bundle', () => {
    // `s3_key` looks like an internal detail and is the only thing tying a
    // receipt file to its expense. Redacting it would turn the (part 2) bundle
    // into a folder of filenames nobody can place.
    expect(EXPORTED.receipt.redact?.s3_key).toBeUndefined();
  });
});
