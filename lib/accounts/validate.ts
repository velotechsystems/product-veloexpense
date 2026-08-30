/**
 * VX3-1 — validation for a parsed chart-of-accounts CSV.
 *
 * PURE. No `pg` import, by the house rule for registry modules — the DB half is
 * `lib/accounts/service.ts`. That is what lets `test/coa-csv.test.ts` run without
 * a database.
 *
 * Ported from `product-veloledger/lib/accounts/validate.ts`, with its shape:
 * either a list of validated accounts or a list of line-numbered errors, and
 * NO PARTIAL SUCCESS — if any row is bad the whole import is rejected. A chart
 * half-imported is worse than one not imported, because the half that landed
 * looks like a chart.
 *
 * Trimmed to the columns `0014` actually has. Dropped from VeloLedger's version:
 * `normal_balance`, `currency`, `is_control_account`, `sub_ledger`,
 * `gaap_presentation`, `ifrs_presentation` — ledger concerns VeloExpense does not
 * model (see the migration's header for why, especially on currency).
 *
 * ── One thing this does that VeloLedger's does not ──────────────────────────
 *
 * `is_postable` is DERIVED, not trusted. An account with children is a rollup and
 * cannot be posted to; VeloLedger learned that the hard way and had to BACKFILL
 * the flag in `0028_account_postable` — "any account referenced as a parent by
 * another account is a rollup and should not be postable" — because a manual flag
 * had drifted from the structure. Deriving it here fixes that at the source. If
 * the column IS present, it is checked against the derivation and a disagreement
 * is an error rather than a preference: the CSV author thinking a parent account
 * is postable is exactly the misunderstanding that produced their bug.
 */
import type { ParsedCsv, CsvRow } from './csv';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/** Matches `gl_account`/`coa_template_account` in migration 0014. */
export interface ValidatedAccount {
  number: string;
  name: string;
  type: AccountType;
  subType: string | null;
  parentNumber: string | null;
  isPostable: boolean;
  sortOrder: number;
  notes: string | null;
  /** From the source CSV, so an error can name a line. */
  lineNumber: number;
}

export interface ValidationError {
  lineNumber: number;
  field: string | null;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  accounts: ValidatedAccount[];
  errors: ValidationError[];
}

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
] as const;

const REQUIRED_COLUMNS = ['number', 'name', 'type'] as const;

export function validateCoaCsv(parsed: ParsedCsv): ValidationResult {
  const errors: ValidationError[] = [];

  for (const col of REQUIRED_COLUMNS) {
    if (!parsed.headers.includes(col)) {
      errors.push({ lineNumber: 1, field: col, message: `missing required column: ${col}` });
    }
  }
  // Return early: without the required columns every row error below would be a
  // restatement of the same problem, and a hundred of those buries the one line
  // that matters.
  if (errors.length > 0) return { ok: false, accounts: [], errors };

  const declaredPostable = parsed.headers.includes('is_postable');
  const rows: (ValidatedAccount & { declaredPostable: boolean | null })[] = [];
  const numbersSeen = new Set<string>();

  parsed.rows.forEach((row, index) => {
    const rowErrors: ValidationError[] = [];
    const number = get(row, 'number');
    const name = get(row, 'name');
    const type = get(row, 'type').toLowerCase();
    const subType = get(row, 'sub_type') || null;
    const parentNumber = get(row, 'parent_number') || null;
    const notes = get(row, 'notes') || null;
    const rawSort = get(row, 'sort_order');
    const rawPostable = get(row, 'is_postable');

    if (!number) rowErrors.push(err(row, 'number', 'number is required'));
    if (!name) rowErrors.push(err(row, 'name', 'name is required'));
    if (!ACCOUNT_TYPES.includes(type as AccountType)) {
      rowErrors.push(
        err(row, 'type', `invalid type '${type}'; must be one of ${ACCOUNT_TYPES.join(', ')}`),
      );
    }
    if (number && number === parentNumber) {
      rowErrors.push(err(row, 'parent_number', `account '${number}' cannot be its own parent`));
    }
    if (rawSort !== '' && !/^\d+$/.test(rawSort)) {
      rowErrors.push(err(row, 'sort_order', `sort_order '${rawSort}' is not a whole number`));
    }
    if (declaredPostable && rawPostable !== '' && parseBool(rawPostable) === null) {
      rowErrors.push(
        err(row, 'is_postable', `is_postable '${rawPostable}' is not a true/false value`),
      );
    }
    if (number) {
      if (numbersSeen.has(number)) {
        rowErrors.push(err(row, 'number', `duplicate account number '${number}' in upload`));
      } else {
        numbersSeen.add(number);
      }
    }

    errors.push(...rowErrors);
    if (rowErrors.length === 0) {
      rows.push({
        number,
        name,
        type: type as AccountType,
        subType,
        parentNumber,
        // Placeholder; the derivation below needs every row read first.
        isPostable: true,
        // Absent sort_order preserves file order rather than collapsing to 0,
        // which would leave the picker sorted by nothing.
        sortOrder: rawSort === '' ? (index + 1) * 10 : Number(rawSort),
        notes,
        lineNumber: row.lineNumber,
        declaredPostable: rawPostable === '' ? null : parseBool(rawPostable),
      });
    }
  });

  // Parents must appear in the upload. Cross-file parents are not supported and
  // should not be: a chart that references a parent nobody can see is not a tree.
  for (const a of rows) {
    if (a.parentNumber && !numbersSeen.has(a.parentNumber)) {
      errors.push({
        lineNumber: a.lineNumber,
        field: 'parent_number',
        message:
          `parent_number '${a.parentNumber}' is not in this upload — a parent must appear ` +
          `in the same file as its children`,
      });
    }
  }

  // Derive is_postable, then hold a declared value to the same standard.
  const parents = new Set(rows.map((a) => a.parentNumber).filter((n): n is string => n !== null));
  for (const a of rows) {
    a.isPostable = !parents.has(a.number);
    if (a.declaredPostable !== null && a.declaredPostable !== a.isPostable) {
      errors.push({
        lineNumber: a.lineNumber,
        field: 'is_postable',
        message: a.declaredPostable
          ? `account '${a.number}' is marked postable but other rows name it as their parent, ` +
            `which makes it a rollup — nothing may post to a rollup ` +
            `(VeloLedger 0028: a line hit the rollup and vanished from the income statement)`
          : `account '${a.number}' is marked as a rollup but no row names it as a parent, so it ` +
            `is a leaf and nothing could ever post to it`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, accounts: [], errors };
  // Rebuilt field by field rather than spread-minus-one: `declaredPostable` is an
  // internal working value and must not reach a caller, and an explicit list is
  // the version that stays correct when a column is added.
  const accounts: ValidatedAccount[] = rows.map((a) => ({
    number: a.number,
    name: a.name,
    type: a.type,
    subType: a.subType,
    parentNumber: a.parentNumber,
    isPostable: a.isPostable,
    sortOrder: a.sortOrder,
    notes: a.notes,
    lineNumber: a.lineNumber,
  }));
  return { ok: true, accounts, errors: [] };
}

function get(row: CsvRow, key: string): string {
  return (row.fields[key] ?? '').trim();
}

function err(row: CsvRow, field: string, message: string): ValidationError {
  return { lineNumber: row.lineNumber, field, message };
}

/** null for "not a boolean at all", so a typo is an error rather than a false. */
function parseBool(v: string): boolean | null {
  const s = v.toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return null;
}
