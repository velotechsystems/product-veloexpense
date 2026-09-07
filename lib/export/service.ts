/**
 * VX5-12 — building a tenant's export.
 *
 * ── ONE SNAPSHOT, AND WHY THAT IS WORTH A LONG TRANSACTION ─────────────────
 *
 * VX5-20 argued at length that a network call does not belong inside a database
 * transaction, and this file appears to do the opposite: it holds one
 * transaction open for the whole export. The two are not in tension, and the
 * difference is worth stating because a reader who remembers that argument
 * should not have to guess.
 *
 * What that argument was about is a WRITE transaction whose commit is delayed by
 * something outside the database — a slow dependency turning into an exhausted
 * connection pool. This is a `READ ONLY REPEATABLE READ` transaction that talks
 * to nothing but Postgres. It takes no row locks and blocks no writer. What it
 * costs is a held snapshot, which delays vacuum for as long as it runs; that is
 * a real cost and it is the reason this is a background job rather than
 * something a page does.
 *
 * What it BUYS is the only property that matters in a legal deliverable:
 * **the files agree with each other.** Forty tables read in forty transactions
 * gives an export where `expenses.csv` has a row whose line items are missing
 * from `expense-line-items.csv`, because somebody submitted a report between
 * file 6 and file 7. Nobody would be able to tell that from the archive, and it
 * is exactly the kind of defect that surfaces as a customer insisting their data
 * is wrong. `pg_dump` makes the same choice for the same reason.
 *
 * ── SERVER-SIDE CURSORS, BECAUSE node-pg BUFFERS ───────────────────────────
 *
 * `SELECT * FROM audit_entry` through node-pg materialises every row in the
 * process before the first one is visible, which would make the streaming ZIP
 * writer pointless. So each table is read through a `DECLARE … CURSOR` and
 * `FETCH 1000`, which needs a transaction — the same transaction the snapshot
 * needs. The two requirements happen to be one mechanism.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 *
 * NO ROUTE AND NO SCREEN. This ships the mechanism with no door, deliberately
 * and for the reason VX5-1 gives in `lib/onboarding/provision.ts`: *"Shipping
 * the mechanism first and the door second means there is never a commit where
 * the door is open."* An endpoint that produces a complete dump of a tenant's
 * data is the single most valuable thing to get the authorisation wrong on.
 *
 * NO RECEIPT BUNDLE YET. `files_key` stays null and the manifest says so in
 * words. Receipt metadata IS in `receipts.csv` including the storage key, which
 * is what the bundle will join on. Reading objects back out of storage needs a
 * method the `Storage` interface does not have — it has `putFile` as of this
 * ticket and no read — so that is part 2 rather than a guess made here.
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { transaction, type QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import { withOrg } from '@/lib/tenant/context';
import { getStorage } from '@/lib/storage';
import { csvRow, csvValue, needsGuard } from '@/lib/export/csv';
import { ZipWriter } from '@/lib/export/zip';
import { EXCLUDED, EXPORTED } from '@/lib/export/tables';

/** How long an archive stays downloadable. See `0041`'s header on `expires_at`. */
export const EXPORT_TTL_DAYS = 7;

/** Rows per `FETCH`. Big enough that the round trips disappear, small enough to bound memory. */
const FETCH_SIZE = 1000;

export type ExportErrorCode = 'ALREADY_IN_FLIGHT' | 'NOT_FOUND' | 'NOT_PENDING';

export class ExportError extends DomainError {
  constructor(
    message: string,
    readonly code: ExportErrorCode,
  ) {
    super(message, null);
    this.name = 'ExportError';
  }
}

export interface ExportRequest {
  id: string;
  expiresAt: Date;
}

export interface ExportResult {
  id: string;
  status: 'READY' | 'FAILED';
  dataKey: string | null;
  dataBytes: number | null;
  rowCounts: Record<string, number>;
  error: string | null;
}

/* ── requesting ────────────────────────────────────────────────────────────── */

/**
 * Record a request. Does not build anything — `runExport` does that.
 *
 * Split so the request is durable before any work starts: a job that dies
 * mid-export leaves a row saying it was RUNNING, which is a state somebody can
 * see and act on. A function that did both would leave nothing.
 */
export async function requestExport(
  organizationId: string,
  requestedById: string,
): Promise<ExportRequest> {
  return withOrg(organizationId, async (tx) => {
    const expiresAt = new Date(Date.now() + EXPORT_TTL_DAYS * 86_400_000);
    try {
      const r = await tx.query(
        `INSERT INTO tenant_export (organization_id, requested_by_id, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id, expires_at`,
        [organizationId, requestedById, expiresAt.toISOString()],
      );
      return { id: r.rows[0].id as string, expiresAt: r.rows[0].expires_at as Date };
    } catch (err) {
      // `tenant_export_one_in_flight_idx`. The database refusing this is the
      // point — see `0041`: the caller is a button, and a button with no
      // feedback gets pressed four times.
      if ((err as { code?: string }).code === '23505') {
        throw new ExportError(
          `organization ${organizationId} already has an export in flight`,
          'ALREADY_IN_FLIGHT',
        );
      }
      throw err;
    }
  });
}

/* ── the catalogue questions, asked of the database ────────────────────────── */

/**
 * The table's primary key columns, in order, as an ORDER BY clause.
 *
 * Read from the catalogue rather than listed in `tables.ts`, so a table whose
 * key changes does not need an edit in two places. `audit_entry` overrides it —
 * its key is a uuid and its ORDER is a hash chain.
 */
async function primaryKeyOrder(tx: QueryRunner, table: string): Promise<string> {
  const r = await tx.query(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [table],
  );
  const cols = (r.rows as { attname: string }[]).map((row) => `"${row.attname}" ASC`);
  if (cols.length === 0) {
    // Every table in this schema has one; if that stops being true, ordering by
    // nothing would make exports non-reproducible in a way nobody would notice.
    throw new Error(`export: table ${table} has no primary key to order by`);
  }
  return cols.join(', ');
}

/** The highest applied migration, for the manifest. */
async function schemaVersion(tx: QueryRunner): Promise<string> {
  const r = await tx.query(`SELECT max(name) AS name FROM schema_migration`);
  return (r.rows[0]?.name as string | null) ?? 'unknown';
}

/* ── writing one table ─────────────────────────────────────────────────────── */

interface FileReport {
  name: string;
  table: string;
  rows: number;
  guardedCells: number;
  redacted: Record<string, string>;
}

/**
 * Stream one table into the archive as CSV, returning what went in.
 *
 * The generator is what keeps this bounded: `ZipWriter.add` pulls a page at a
 * time, compresses it and forwards it, so no table is ever fully in memory —
 * which is the whole reason for the cursor and the streaming writer.
 */
async function addTable(
  zip: ZipWriter,
  tx: QueryRunner,
  table: string,
  spec: (typeof EXPORTED)[string],
  organizationId: string,
): Promise<FileReport> {
  const order = spec.orderBy ?? (await primaryKeyOrder(tx, table));
  const redact = spec.redact ?? {};

  // `organization` is not tenant-scoped — it has no `organization_id`, being the
  // table the tenant id comes FROM — so it is the one table filtered by `id`.
  // Everything else is scoped by RLS and needs no WHERE at all, which is worth
  // noticing: the isolation is the database's, not this query's.
  const where = table === 'organization' ? `WHERE id = $1` : '';
  const params = table === 'organization' ? [organizationId] : [];

  const cursor = `export_cur`;
  await tx.query(
    `DECLARE ${cursor} NO SCROLL CURSOR FOR
       SELECT * FROM "${table}" ${where} ORDER BY ${order}`,
    params,
  );

  const report: FileReport = { name: spec.file, table, rows: 0, guardedCells: 0, redacted: redact };

  async function* pages(): AsyncGenerator<string> {
    let columns: string[] | null = null;
    for (;;) {
      const page = await tx.query(`FETCH ${FETCH_SIZE} FROM ${cursor}`);
      if (columns === null) {
        // From the RESULT, not from a list — so the header is whatever the table
        // actually has, minus what is withheld. A redaction is an absent column
        // rather than an empty one: an empty column reads as "no value", and
        // "we did not give you this" is a different statement.
        columns = page.fields.map((f) => f.name).filter((n) => !(n in redact));
        yield csvRow(columns);
      }
      if (page.rows.length === 0) break;
      let chunk = '';
      for (const row of page.rows as Record<string, unknown>[]) {
        const cells = columns.map((c) => csvValue(row[c]));
        for (const cell of cells) if (needsGuard(cell)) report.guardedCells += 1;
        chunk += csvRow(cells);
      }
      report.rows += page.rows.length;
      yield chunk;
      if (page.rows.length < FETCH_SIZE) break;
    }
  }

  await zip.add(spec.file, pages());
  await tx.query(`CLOSE ${cursor}`);
  return report;
}

/* ── the job ───────────────────────────────────────────────────────────────── */

/**
 * Build the archive for a PENDING export.
 *
 * Never throws for a data problem: a failure is recorded on the row as FAILED
 * with a reason, because the request is durable and the caller is a worker whose
 * exception nobody reads. It DOES throw when the export does not exist or is not
 * PENDING, since that is a programming error in the caller rather than an
 * outcome.
 */
export async function runExport(organizationId: string, exportId: string): Promise<ExportResult> {
  // Claim it, in its own transaction, before the long one starts. The UPDATE's
  // WHERE is the claim: two workers racing on the same row means exactly one
  // sees a rowcount of 1.
  const claimed = await withOrg(organizationId, async (tx) => {
    const r = await tx.query(
      `UPDATE tenant_export SET status = 'RUNNING', started_at = clock_timestamp()
        WHERE id = $1 AND status = 'PENDING'
        RETURNING id`,
      [exportId],
    );
    return r.rows.length === 1;
  });
  if (!claimed) {
    throw new ExportError(`export ${exportId} is not PENDING`, 'NOT_PENDING');
  }

  const dir = await mkdtemp(join(tmpdir(), 'vx-export-'));
  const archivePath = join(dir, 'export.zip');

  try {
    const reports: FileReport[] = [];
    let manifest = '';

    const out = createWriteStream(archivePath);
    const zip = new ZipWriter(async (chunk) => {
      // Backpressure. Without the drain wait, a slow disk turns into unbounded
      // memory in the stream's internal buffer — which would undo the cursor and
      // the streaming writer in one line.
      if (!out.write(chunk)) await once(out, 'drain');
    });

    await transaction(async (tx) => {
      // SET TRANSACTION has to be the FIRST statement, which is why this uses
      // `transaction` rather than `withOrg` — `withOrg` sets the tenant GUC
      // first, and a `SELECT set_config(…)` already counts as a query. The GUC
      // is set on the next line instead, so isolation and tenancy are both in
      // place before anything is read.
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await tx.query("SELECT set_config('app.current_org', $1, true)", [organizationId]);

      const version = await schemaVersion(tx);
      const org = await tx.query(`SELECT slug, name FROM organization WHERE id = $1`, [
        organizationId,
      ]);

      for (const [table, spec] of Object.entries(EXPORTED)) {
        reports.push(await addTable(zip, tx, table, spec, organizationId));
      }

      manifest = buildManifest({
        organizationId,
        slug: (org.rows[0]?.slug as string) ?? null,
        name: (org.rows[0]?.name as string) ?? null,
        schemaVersion: version,
        reports,
      });
    });

    // LAST, so it can describe what actually went in rather than what was meant
    // to. A manifest written first is a promise; written last it is a receipt.
    await zip.add('manifest.json', [manifest]);
    await zip.finish();

    out.end();
    await once(out, 'finish');

    const { size } = await stat(archivePath);
    const key = `exports/${organizationId}/${exportId}/veloexpense-export.zip`;
    await getStorage().putFile(key, archivePath, 'application/zip');

    const rowCounts = Object.fromEntries(reports.map((r) => [r.name, r.rows]));
    await withOrg(organizationId, (tx) =>
      tx.query(
        `UPDATE tenant_export
            SET status = 'READY', data_key = $2, data_bytes = $3, row_counts = $4,
                completed_at = clock_timestamp()
          WHERE id = $1`,
        [exportId, key, size, JSON.stringify(rowCounts)],
      ),
    );

    return { id: exportId, status: 'READY', dataKey: key, dataBytes: size, rowCounts, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withOrg(organizationId, (tx) =>
      tx.query(
        `UPDATE tenant_export
            SET status = 'FAILED', error = $2, completed_at = clock_timestamp()
          WHERE id = $1`,
        [exportId, message.slice(0, 2000)],
      ),
    );
    return {
      id: exportId,
      status: 'FAILED',
      dataKey: null,
      dataBytes: null,
      rowCounts: {},
      error: message,
    };
  } finally {
    // The archive is in storage or the export failed; either way the temp file
    // has no further use, and leaving it is how a long-lived deployment fills
    // its disk with copies of its customers' data.
    await rm(dir, { recursive: true, force: true });
  }
}

/* ── the manifest ──────────────────────────────────────────────────────────── */

function buildManifest(input: {
  organizationId: string;
  slug: string | null;
  name: string | null;
  schemaVersion: string;
  reports: FileReport[];
}): string {
  const guarded = input.reports.reduce((n, r) => n + r.guardedCells, 0);
  return `${JSON.stringify(
    {
      product: 'veloexpense',
      generatedAt: new Date().toISOString(),
      schemaVersion: input.schemaVersion,
      organization: { id: input.organizationId, slug: input.slug, name: input.name },

      /* Every file, with its row count — which is the point of the manifest.
       * "The export succeeded" is not checkable; "expenses.csv: 1421 rows" is,
       * against the screen the customer is already looking at. */
      files: input.reports.map((r) => ({
        name: r.name,
        table: r.table,
        rows: r.rows,
        ...(Object.keys(r.redacted).length > 0 ? { withheld: r.redacted } : {}),
      })),

      /* Named rather than silently absent. A customer who wonders where their
       * OAuth tokens are gets an answer in the file instead of a support
       * ticket. */
      tablesNotExported: EXCLUDED,

      snapshot: {
        isolation: 'REPEATABLE READ, READ ONLY',
        note:
          'Every file was read in one transaction, so they are consistent with each other: ' +
          'no row references another that is missing.',
      },

      formulaGuard: {
        applied: guarded,
        rule:
          "A cell beginning =, +, @, tab or CR is prefixed with a single apostrophe, because " +
          'a spreadsheet executes such text as a formula. A leading - is NOT guarded when what ' +
          'follows is a number, so negative amounts are exact. Strip one leading apostrophe to ' +
          'recover the raw text.',
      },

      receipts: {
        metadata: 'receipts.csv',
        files:
          'NOT in this archive. Receipt images and PDFs are delivered as a separate archive; ' +
          'receipts.csv carries the storage key, filename, size and content type of each, and ' +
          'the expense it belongs to.',
      },

      billing: {
        note:
          'subscription-mirror.csv and meter-readings.csv are what the VeloTech platform told ' +
          'this product, mirrored — not invoices. mirrored_at says when the platform last ' +
          'answered; the authoritative record lives on the platform.',
      },
    },
    null,
    2,
  )}\n`;
}

/* ── expiry ────────────────────────────────────────────────────────────────── */

export interface PurgeResult {
  purged: number;
  failed: { id: string; message: string }[];
}

/**
 * Delete the objects behind expired exports and stamp the rows.
 *
 * The ROW survives on purpose — `0041`'s header argues it: the trail is the
 * point, and "this export existed and its bytes are gone" is a different
 * sentence from "no export was ever made". `status` becomes EXPIRED.
 *
 * Storage deletion happens OUTSIDE the transaction that stamps the row, and the
 * order is deliberate: delete the object first, then record it. The other order
 * leaves a row claiming the bytes are gone while they sit in the bucket, which
 * is the failure that matters — the whole reason for an expiry is that nobody is
 * watching that object.
 */
export async function purgeExpiredExports(organizationId: string): Promise<PurgeResult> {
  const due = await withOrg(organizationId, async (tx) => {
    const r = await tx.query(
      `SELECT id, data_key, files_key FROM tenant_export
        WHERE purged_at IS NULL AND expires_at <= now()`,
    );
    return r.rows as { id: string; data_key: string | null; files_key: string | null }[];
  });

  const storage = getStorage();
  const result: PurgeResult = { purged: 0, failed: [] };

  for (const row of due) {
    try {
      for (const key of [row.data_key, row.files_key]) {
        if (key) await storage.delete(key);
      }
      await withOrg(organizationId, (tx) =>
        tx.query(
          `UPDATE tenant_export
              SET status = 'EXPIRED', purged_at = clock_timestamp(),
                  data_key = NULL, files_key = NULL
            WHERE id = $1`,
          [row.id],
        ),
      );
      result.purged += 1;
    } catch (err) {
      // Reported, not thrown: one unreachable object must not stop the other
      // thirty-nine from being deleted. Same reasoning as the seat sweep.
      result.failed.push({ id: row.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
