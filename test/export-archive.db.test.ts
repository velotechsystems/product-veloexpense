/**
 * VX5-12 — the export end to end, against a real Postgres and a real archive.
 *
 * ── WHAT ONLY THIS SUITE CAN PROVE ─────────────────────────────────────────
 *
 * `test/export-coverage.db.test.ts` proves the enumeration is complete and
 * `test/export-csv.test.ts` proves a cell is written correctly. Neither opens an
 * archive, and the questions that matter here cannot be answered without one:
 *
 *   1. **IS IT ONE TENANT'S DATA?** The queries carry no `WHERE
 *      organization_id` — isolation comes from RLS and a GUC set inside the
 *      export's transaction. If that is wrong, the archive contains somebody
 *      else's expenses, every other test still passes, and the defect is a
 *      breach. So a second tenant exists here with a distinctive string in it,
 *      and the assertion is that the string is nowhere in the archive.
 *   2. Does the file open at all — with a reader that is not the writer.
 *   3. Do the manifest's row counts match the CSVs they describe? A manifest
 *      that is written from intentions rather than from what was written is
 *      worse than none.
 *   4. Is `audit_entry` in chain order, which is the one table whose ORDER is
 *      part of its meaning.
 *
 * `test/support/zip-reader.ts` is hand-written for exactly that reason — see its
 * header. Reading the archive with the writer's own understanding of the format
 * would pass for any self-consistent nonsense.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createOrganization } from '@/lib/onboarding/provision';
import { MemoryStorage, setStorage } from '@/lib/storage';
import { withOrg } from '@/lib/tenant/context';
import { EXPORTED } from '@/lib/export/tables';
import { ExportError, purgeExpiredExports, requestExport, runExport } from '@/lib/export/service';
import { parseCsv, readZip, readZipMap } from './support/zip-reader';
import { purgeTenants } from './support/purge-tenants';
import { append as auditAppend } from '@/lib/audit/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

/** A string that must appear in tenant A's archive. */
const MINE = 'MINE-lunch-with-the-auditor';
/** A string that must NOT. If this turns up, RLS did not scope the export. */
const THEIRS = 'THEIRS-do-not-leak-this-description';
/** A description a spreadsheet would execute. */
const FORMULA = '=cmd|\' /C calc\'!A0';

let storage: MemoryStorage;
let orgA: string;
let orgB: string;
let adminA: string;

/**
 * One report, one expense, one line item — the shape the schema actually has.
 *
 * `expense` is a container under `expense_report`; the money is on
 * `expense_line_item`. The description under test therefore goes on the LINE,
 * which is where a person types free text and so where a formula would arrive.
 */
async function addExpense(orgId: string, userId: string, description: string, minor: number) {
  await withOrg(orgId, async (tx) => {
    const cat = await tx.query(`SELECT id FROM expense_category ORDER BY sort_order LIMIT 1`);
    const report = await tx.query(
      `INSERT INTO expense_report (organization_id, title, status, currency_code, submitter_id)
       VALUES ($1, $2, 'DRAFT', 'CAD', $3) RETURNING id`,
      [orgId, description, userId],
    );
    const expense = await tx.query(
      `INSERT INTO expense (organization_id, report_id, merchant, txn_date, currency_code, notes)
       VALUES ($1, $2, $3, current_date, 'CAD', $4) RETURNING id`,
      [orgId, report.rows[0].id, 'A Merchant', description],
    );
    await tx.query(
      `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, expense.rows[0].id, cat.rows[0].id, minor, description],
    );
  });
}

beforeAll(async () => {
  // A previous partial run leaves tenants behind, and `xexp-a` is a slug: the
  // second run then fails at SLUG_TAKEN rather than at anything interesting.
  await purgeTenants(admin, { slugLike: 'xexp-%' });

  storage = new MemoryStorage();
  setStorage(storage);

  const a = await createOrganization({
    name: 'Export Co',
    slug: 'xexp-a',
    adminEmail: 'ada@xexp.test',
    adminName: 'Ada Admin',
  });
  orgA = a.organizationId;
  adminA = a.adminUserId;

  const b = await createOrganization({
    name: 'Other Co',
    slug: 'xexp-b',
    adminEmail: 'bob@xexp.test',
    adminName: 'Bob Admin',
  });
  orgB = b.organizationId;

  await addExpense(orgA, adminA, MINE, 152_50);
  // A negative amount, because the formula guard must leave it exact.
  await addExpense(orgA, adminA, 'Refunded taxi', -45_00);
  await addExpense(orgA, adminA, FORMULA, 100);
  await addExpense(orgB, b.adminUserId, THEIRS, 999_99);

  /* SEVERAL audit rows, and the reason is a sabotage that came back green.
   *
   * The chain-order test below passed with `audit_entry`'s `orderBy` override
   * DELETED — because a freshly created tenant has exactly ONE audit row (its
   * genesis), and a single row is sorted whatever you order it by. The test was
   * vacuous and its name was a claim about nothing.
   *
   * `test/i18n-policy-params.test.ts` has a "found some pairs at all" guard for
   * exactly this and I did not write one here. So: real appends, through the
   * real chain, and the assertion below is now written so that it cannot pass
   * without discriminating. */
  const actor = { id: adminA, name: 'Ada Admin', role: 'ADMIN' as const };
  for (let i = 0; i < 6; i += 1) {
    await withOrg(orgA, (tx) =>
      auditAppend(tx, actor, {
        // A real action from `AUDIT_ACTIONS` — `tsc` refused the plausible
        // 'ORGANIZATION_UPDATED' I reached for first, which is the union doing
        // its job on a test the same way it does on the product.
        action: 'REPORT_EDITED',
        entityType: 'expense_report',
        entityId: orgA,
        details: { note: `fixture change ${i}` },
      }),
    );
  }
});

afterAll(async () => {
  setStorage(null);
  // Whole tenants, not just the export rows: this suite creates two, and
  // leaving them behind puts them in every OTHER suite's cross-tenant counts.
  await purgeTenants(admin, { slugLike: 'xexp-%' });
  await admin.end();
});

/** Request, run, and hand back the archive bytes. */
async function exportOnce(orgId: string, userId: string) {
  const req = await requestExport(orgId, userId);
  const result = await runExport(orgId, req.id);
  expect(result.status, result.error ?? '').toBe('READY');
  const bytes = storage.body(result.dataKey as string);
  expect(bytes, `no object at ${result.dataKey}`).not.toBeNull();
  return { req, result, buf: Buffer.from(bytes as Uint8Array) };
}

describe('the archive', () => {
  it('opens with an independent reader and holds every expected file', async () => {
    const { buf } = await exportOnce(orgA, adminA);
    const names = readZip(buf)
      .map((e) => e.name)
      .sort();

    // Every table's file, plus the manifest. `readZip` verifies each CRC as it
    // goes, so getting here at all means the bytes are sound.
    for (const spec of Object.values(EXPORTED)) expect(names).toContain(spec.file);
    expect(names).toContain('manifest.json');
    expect(names).toHaveLength(Object.keys(EXPORTED).length + 1);
  });

  it('CONTAINS THIS TENANT AND NOT THE OTHER ONE', async () => {
    // The assertion this suite exists for. The export's queries have no
    // `WHERE organization_id` — isolation is RLS plus the GUC set inside the
    // snapshot transaction. Searching the whole archive rather than one file,
    // because a leak could be in any of the forty.
    const { buf } = await exportOnce(orgA, adminA);
    const all = readZip(buf)
      .map((e) => e.data.toString('utf8'))
      .join('\n');

    expect(all).toContain(MINE);
    expect(all, 'ANOTHER TENANT’S DATA IS IN THIS EXPORT').not.toContain(THEIRS);
    expect(all).not.toContain('Other Co');
    expect(all).not.toContain('bob@xexp.test');
  });

  it('holds exactly one organization row, and it is the right one', async () => {
    const { buf } = await exportOnce(orgA, adminA);
    const rows = parseCsv(readZipMap(buf).get('organization.csv')!.toString('utf8'));
    // Header plus one row. `organization` is the one table not scoped by RLS —
    // it has no `organization_id` — so it is filtered by id, and a mistake there
    // would put every tenant's name and branding in every export.
    expect(rows).toHaveLength(2);
    const [header, row] = rows;
    expect(row[header.indexOf('slug')]).toBe('xexp-a');
    // And the redaction is an ABSENT column, not an empty one: "we did not give
    // you this" is a different statement from "there is no value".
    expect(header).not.toContain('logo_bytes');
  });

  it('withholds the credential columns', async () => {
    const { buf } = await exportOnce(orgA, adminA);
    const header = parseCsv(readZipMap(buf).get('integrations.csv')!.toString('utf8'))[0];
    expect(header).not.toContain('config');
    expect(header).not.toContain('oauth_access_token');
    expect(header).not.toContain('oauth_refresh_token');
    // …while keeping the metadata that makes the file worth having.
    expect(header).toContain('integration_slug');
    expect(header).toContain('connected_at');
  });

  it('guards a formula and leaves a negative amount exact', async () => {
    const { buf } = await exportOnce(orgA, adminA);
    // The line-item file: `expense` is a container, and the money and the free
    // text a person typed are both on the line.
    const rows = parseCsv(readZipMap(buf).get('expense-line-items.csv')!.toString('utf8'));
    const header = rows[0];
    const d = header.indexOf('description');
    const amount = header.indexOf('amount_minor');

    const guarded = rows.find((r) => r[d]?.includes('cmd|'));
    expect(guarded, 'the formula row is missing').toBeDefined();
    expect(guarded![d]).toBe(`'${FORMULA}`);

    const refund = rows.find((r) => r[d] === 'Refunded taxi');
    expect(refund![amount], 'a negative amount was mangled by the guard').toBe('-4500');
  });

  it('has a manifest whose row counts match the files it describes', async () => {
    const { buf, result } = await exportOnce(orgA, adminA);
    const files = readZipMap(buf);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
      files: { name: string; rows: number }[];
      organization: { id: string; slug: string };
      schemaVersion: string;
      formulaGuard: { applied: number };
      tablesNotExported: Record<string, string>;
    };

    expect(manifest.organization.id).toBe(orgA);
    expect(manifest.organization.slug).toBe('xexp-a');
    expect(manifest.schemaVersion).toMatch(/^\d{4}_/);
    // The guard fired on the planted description, and the manifest says how
    // often — which is what makes the transform discoverable rather than silent.
    expect(manifest.formulaGuard.applied).toBeGreaterThan(0);
    expect(Object.keys(manifest.tablesNotExported).length).toBeGreaterThan(0);

    // A manifest written from intentions rather than from what was written is
    // worse than no manifest, so every count is checked against its own file.
    for (const entry of manifest.files) {
      const csv = files.get(entry.name);
      expect(csv, `${entry.name} is in the manifest and not in the archive`).toBeDefined();
      const parsed = parseCsv(csv!.toString('utf8'));
      const dataRows = Math.max(0, parsed.length - 1); // minus the header
      expect(dataRows, `${entry.name}: manifest says ${entry.rows}`).toBe(entry.rows);
    }

    // And the ledger agrees with the manifest.
    expect(result.rowCounts['expense-line-items.csv']).toBe(3);
  });

  it('writes audit-log.csv in chain order, not primary-key order', async () => {
    const { buf } = await exportOnce(orgA, adminA);
    const rows = parseCsv(readZipMap(buf).get('audit-log.csv')!.toString('utf8'));
    const seq = rows[0].indexOf('sequence');
    expect(seq).toBeGreaterThanOrEqual(0);
    const exported = rows.slice(1).map((r) => Number(r[seq]));

    // Both candidate orderings, asked of the database.
    const orders = await withOrg(orgA, async (tx) => ({
      bySequence: (
        await tx.query(`SELECT sequence FROM audit_entry ORDER BY sequence ASC`)
      ).rows.map((r) => Number((r as { sequence: string }).sequence)),
      byId: (await tx.query(`SELECT sequence FROM audit_entry ORDER BY id ASC`)).rows.map((r) =>
        Number((r as { sequence: string }).sequence),
      ),
    }));

    /* THIS ASSERTION CANNOT PASS VACUOUSLY, WHICH IS THE POINT.
     *
     * "Sorted ascending" was the first version, and it passed with the ordering
     * override deleted: a fresh tenant has one audit row, and one row is sorted.
     * Adding rows would have made it merely IMPROBABLE to pass by luck — a uuid
     * ordering of six rows is accidentally sorted about once in 720 runs, which
     * is a flake nobody would diagnose.
     *
     * So instead: the two candidate orders are computed, the test refuses to
     * proceed if they coincide (in which case it could not tell them apart and
     * says so), and the exported order must equal the sequence one exactly. */
    expect(
      orders.byId,
      'this fixture cannot discriminate — primary-key order and sequence order coincide, ' +
        'so add audit rows rather than trusting the assertion below',
    ).not.toEqual(orders.bySequence);

    // `audit_entry` is a hash chain: each row's hash covers its predecessor's,
    // so an export ordered by uuid hands somebody a log they cannot verify.
    expect(exported).toEqual(orders.bySequence);
    expect(exported.length).toBeGreaterThan(5);
  });

  it('every CSV has a header even when the table is empty', async () => {
    const { buf } = await exportOnce(orgA, adminA);
    // A fresh tenant has no budgets, no fraud flags, no integrations. An empty
    // file with no header is indistinguishable from a file that failed to write,
    // and "you sent me an empty file" is the support ticket that follows.
    for (const entry of readZip(buf)) {
      if (entry.name === 'manifest.json') continue;
      const text = entry.data.toString('utf8');
      expect(text.length, `${entry.name} is completely empty`).toBeGreaterThan(0);
      expect(text.endsWith('\r\n'), `${entry.name} does not end with CRLF`).toBe(true);
      expect(parseCsv(text)[0].length, `${entry.name} has no columns`).toBeGreaterThan(0);
    }
  });
});

describe('the ledger', () => {
  it('refuses a second export while one is in flight', async () => {
    const first = await requestExport(orgB, (await adminOf(orgB))!);
    await expect(requestExport(orgB, (await adminOf(orgB))!)).rejects.toBeInstanceOf(ExportError);
    await expect(requestExport(orgB, (await adminOf(orgB))!)).rejects.toMatchObject({
      code: 'ALREADY_IN_FLIGHT',
    });
    // …and once it has finished, another is allowed. The index is partial for
    // exactly this reason: it constrains the in-flight ones, not the history.
    await runExport(orgB, first.id);
    const second = await requestExport(orgB, (await adminOf(orgB))!);
    expect(second.id).not.toBe(first.id);
    await runExport(orgB, second.id);
  });

  it('refuses to run an export that is not PENDING', async () => {
    const req = await requestExport(orgA, adminA);
    await runExport(orgA, req.id);
    // Two workers racing on one row: the UPDATE's WHERE is the claim, so the
    // second sees no rows and says so rather than exporting twice.
    await expect(runExport(orgA, req.id)).rejects.toMatchObject({ code: 'NOT_PENDING' });
  });

  it('records a failure on the row rather than throwing at the worker', async () => {
    const req = await requestExport(orgA, adminA);
    // A storage that refuses. The export has already read everything by the time
    // it uploads, so this exercises the path where the work succeeded and the
    // delivery did not — which is the failure a retry can actually fix.
    const broken = new MemoryStorage();
    broken.putFile = async () => {
      throw new Error('storage is down');
    };
    setStorage(broken);
    try {
      const result = await runExport(orgA, req.id);
      expect(result.status).toBe('FAILED');
      expect(result.error).toContain('storage is down');
    } finally {
      setStorage(storage);
    }

    const row = await admin.query(`SELECT status, error, data_key FROM tenant_export WHERE id = $1`, [
      req.id,
    ]);
    expect(row.rows[0].status).toBe('FAILED');
    expect(row.rows[0].error).toContain('storage is down');
    expect(row.rows[0].data_key).toBeNull();
  });

  it('purges the object at expiry and keeps the row', async () => {
    const { result } = await exportOnce(orgA, adminA);
    expect(storage.has(result.dataKey as string)).toBe(true);

    // Age the whole row, not just the expiry. `tenant_export_expiry_after_request`
    // refused the shortcut — an export whose expiry precedes its request cannot
    // exist — so this simulates a real 8-day-old export instead, which is what
    // the purge will actually meet. The constraint catching a test taking a
    // shortcut is the constraint working.
    await admin.query(
      `UPDATE tenant_export
          SET requested_at = now() - interval '8 days',
              expires_at   = now() - interval '1 day'
        WHERE id = $1`,
      [result.id],
    );
    const purge = await purgeExpiredExports(orgA);

    expect(purge.failed).toEqual([]);
    expect(purge.purged).toBeGreaterThan(0);
    // The bytes are gone…
    expect(storage.has(result.dataKey as string)).toBe(false);
    // …and the row is not, because "this export existed and its bytes are gone"
    // is a different sentence from "no export was ever made".
    const row = await admin.query(
      `SELECT status, purged_at, data_key, row_counts FROM tenant_export WHERE id = $1`,
      [result.id],
    );
    expect(row.rows[0].status).toBe('EXPIRED');
    expect(row.rows[0].purged_at).not.toBeNull();
    expect(row.rows[0].data_key).toBeNull();
    // The counts survive: they are the receipt, and they are what somebody
    // checks an old export against.
    expect(row.rows[0].row_counts).not.toBeNull();
  });
});

/** The admin of a tenant, for the tests that did not create it. */
async function adminOf(orgId: string): Promise<string | null> {
  const r = await withOrg(orgId, (tx) =>
    tx.query(`SELECT id FROM app_user WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1`),
  );
  return (r.rows[0]?.id as string) ?? null;
}
