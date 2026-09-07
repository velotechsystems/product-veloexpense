/**
 * VX5-12 — CSV, written to be read by a spreadsheet without being executed by one.
 *
 * ── WHY CSV AT ALL, WHEN THE PRODUCT COULD WRITE .xlsx ─────────────────────
 *
 * ExpenseOS has an `.xlsx` writer (`apps/web/src/lib/exportTable.ts`) and it is
 * a good one — real typed cells, number formats, no dependency beyond a zipper.
 * This export is CSV anyway, and the reason is not simplicity:
 *
 *   · GDPR Art. 20 asks for "structured, commonly used, machine-readable". CSV
 *     is the least arguable answer to that sentence.
 *   · **CSV has no cell types, which deletes a whole class of defect instead of
 *     guarding against it.** Upstream's own Excel export shipped 213 text cells
 *     and no numeric ones — `SUM` returned zero — and their post-mortem is
 *     exact: *"`exportTable` has supported typed cells all along, so the fix is
 *     at this call site."* The writer was never the problem. A format where
 *     every cell is text cannot have a call site that forgets to say so.
 *
 * What CSV brings INSTEAD is the hazard below, and it is worth being explicit
 * that this is a trade rather than a free win.
 *
 * ── THE HAZARD CSV BRINGS: A SPREADSHEET EXECUTES SOME TEXT ────────────────
 *
 * A cell whose text begins `=`, `+`, `@`, or a tab is a FORMULA to Excel,
 * LibreOffice and Google Sheets. `=cmd|' /C calc'!A0` in an expense
 * description is a command an admin's spreadsheet may offer to run, and the
 * person who typed it is any employee who can file an expense. That is an
 * intra-tenant escalation with a file as the delivery mechanism, and it is a
 * real one: the export exists so that somebody opens it.
 *
 * So a leading formula character is neutralised with a single apostrophe, which
 * every spreadsheet reads as "the rest is literal text".
 *
 * ── AND THE NARROWING THAT KEEPS THE DATA FAITHFUL ─────────────────────────
 *
 * The naive rule guards `= + - @`, and it is WRONG here, because `-` leads every
 * negative amount in the product. `-1500.00` would export as `'-1500.00` — a
 * legal deliverable in which every credit note is corrupted, to defend against a
 * formula that a number cannot be.
 *
 * So `-` is guarded ONLY when what follows is not a number. `=`, `+`, `@`, tab
 * and CR are always guarded: none of them can begin a value this product stores.
 * `+1500` is not a number this schema produces either, but it costs nothing to
 * treat it as text and it closes `+cmd|…`.
 *
 * The transform is recorded in the archive's `manifest.json` (`formulaGuard`),
 * with this rule spelled out, so the export stays self-describing rather than
 * quietly altered. An importer that wants the raw text strips one leading
 * apostrophe.
 */

/** Fields RFC 4180 requires to be quoted, plus the ones Excel mishandles. */
const MUST_QUOTE = /[",\r\n]/;

/**
 * A value a spreadsheet would evaluate rather than display.
 *
 * `-` is absent on purpose — see the header. It is handled by `needsGuard`,
 * which knows about numbers.
 */
const ALWAYS_FORMULA = /^[=+@\t\r]/;

/** What Postgres and this schema can produce as a number, including negatives. */
const NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Would a spreadsheet treat this as a formula?
 *
 * Exported rather than private because `test/export-csv.test.ts` asserts the
 * rule directly — the interesting cases are all about which values are NOT
 * guarded, and a test that could only see the quoted output would be checking
 * the wrong layer.
 */
export function needsGuard(value: string): boolean {
  if (value === '') return false;
  if (ALWAYS_FORMULA.test(value)) return true;
  // A leading `-` is a formula only if it is not simply a negative number.
  return value.startsWith('-') && !NUMERIC.test(value);
}

/** One CSV field: quoted when it has to be, guarded when a spreadsheet would run it. */
export function csvField(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const guarded = needsGuard(value) ? `'${value}` : value;
  // The apostrophe itself never forces quoting, but a guarded value may still
  // contain a comma — so the quote decision is made on the FINAL text.
  if (!MUST_QUOTE.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * One CSV row, CRLF-terminated.
 *
 * CRLF because RFC 4180 says so and because Excel on Windows still cares; every
 * reader that accepts LF accepts CRLF.
 */
export function csvRow(values: readonly (string | null | undefined)[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

/**
 * Render a database value as CSV text.
 *
 * ── THE RULES, AND WHY EACH ONE IS NOT THE OBVIOUS CHOICE ──────────────────
 *
 *   · `null` → EMPTY, and `''` → empty too. They are indistinguishable in CSV
 *     and pretending otherwise (`\N`, `NULL`) invents a convention the reader
 *     does not share. The manifest names the nullable columns, which is where
 *     that information can actually live.
 *   · `Date` → full ISO 8601 with the offset, never a local rendering. A date in
 *     a legal export that means a different instant depending on who opens it is
 *     worse than one nobody can read at a glance.
 *   · `bigint` → its digits. `Number(v)` would silently lose precision above
 *     2^53, and every money column in this schema is minor units as bigint.
 *   · `Buffer`/`Uint8Array` → base64, because a CSV cannot hold bytes and a
 *     mangled hash is worse than an encoded one.
 *   · objects and arrays → compact JSON. `audit_entry.details` and every
 *     `jsonb` column reaches here, and `[object Object]` would be data loss in
 *     the one table an auditor reads.
 */
export function csvValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return JSON.stringify(v);
}
