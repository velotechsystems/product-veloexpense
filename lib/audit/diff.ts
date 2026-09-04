/**
 * UD-11 — "who changed this line's amount, from what, and when".
 *
 * ── WHAT WAS MISSING HERE, WHICH IS MORE THAN WHAT UPSTREAM FIXED ───────────
 *
 * ExpenseOS `78e7b7b4` replaced `details: { fields: Object.keys(input) }` — the
 * keys the CLIENT SENT, on editors that post their whole model, so a row could
 * not tell "corrected the amount" from "opened it and pressed Save" — with a real
 * diff. We had nothing to replace: `lib/expenses/service.ts` contained no audit
 * append at all, and `recordEvent` covers TRANSITIONS only (SUBMIT, RECALL,
 * APPROVE, REJECT, RETURN, REIMBURSE). So for every expense, report header and
 * line item in the product, "who changed this, from what" was unanswerable. For
 * an expense system that is the question an audit trail exists to answer.
 *
 * ── THE ONE PLACE THIS DIVERGES FROM THEIRS, AND WHY OURS CAN ───────────────
 *
 * Theirs diffs the PATCH against the row, and its header is honest about the
 * limit that creates: "a mutation that quietly writes a column it did not list
 * stays invisible here — which is the honest failure mode, because the
 * alternative is an audit row that claims completeness it cannot have."
 *
 * We can have more of the completeness, because every write in
 * `lib/expenses/service.ts` ends in `RETURNING *`. So this diffs the ROW BEFORE
 * against the ROW AFTER, and the difference is not academic — two columns our
 * writes touch are ones no caller ever names:
 *
 *   · `updateLineItem` re-stamps `gl_account_id` when the category changes — the
 *     AC-10 snapshot. A patch diff never mentions the account the money moved to.
 *   · `title` is TRIMMED on the way in. A patch diff records what was typed; a
 *     row diff records what was stored, which is what an auditor is looking at.
 *
 * WHAT ROW-VS-ROW STILL DOES NOT CATCH, said plainly because the first draft of
 * this comment claimed it did: a write that lands on ANOTHER TABLE. Changing a
 * report's currency cascades to every child expense's `currency_code`
 * (single-currency MVP), and no diff of the report row can see that. That one is
 * recorded by hand, in `updateReport`, as the count of rows it rewrote — and the
 * general lesson is the same one upstream's header states: this reports what it
 * is handed, and a caller that writes something else has to say so itself.
 *
 * Row-vs-row also means the field names in `details` are COLUMN names
 * (`amount_minor`, not `amountMinor`). That is deliberate: the audit row should
 * name the thing that actually changed, in the vocabulary of the table an auditor
 * will query.
 *
 * ── WHAT IT STILL DOES NOT DO ───────────────────────────────────────────────
 *
 * It does not decide whether an edit was allowed, and it is not change-data
 * capture. It compares the two rows it is handed. A write that never re-reads is
 * a write this cannot see, which is why the callers read before AND take the
 * `RETURNING *` row after, rather than reading once and trusting the patch.
 *
 * ── THE BIGINT TRAP, WHICH IS SHARPER HERE THAN THERE ───────────────────────
 *
 * Their `details` is NOT in the hash payload, so theirs only has to survive
 * `JSON.stringify`. Ours IS in the payload (AU-3), so every diff also has to
 * survive `canonical()` — and `canonical()` THROWS on BigInt, inside the
 * transaction that is recording the user's edit (AU-5). `pg` returns bigint
 * columns as strings, so the natural path is already correct; `render()` below is
 * what keeps it correct for a caller who hands us a real bigint anyway, rather
 * than letting the throw roll back somebody's edit over a logging detail.
 */

/**
 * One value, rendered for the `details` jsonb column AND for `canonical()`.
 *
 * `pg` hands back `Date` for timestamps, `string` for bigint and numeric, and
 * `null` for NULL — a narrower set than Prisma's, which is why this is shorter
 * than theirs. `bigint` is still handled: nothing stops a caller passing one, and
 * `canonical()` would throw on it.
 */
function render(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') {
    // Arrays and plain objects (jsonb columns: policy params, message data)
    // round-trip as-is, through a stringify that throws loudly on anything that
    // cannot — which is what we want here, at the boundary, rather than three
    // frames deeper inside canonical().
    return JSON.parse(JSON.stringify(v)) as unknown;
  }
  return v;
}

/**
 * Two values are the same edit-wise when they render identically.
 *
 * Compares the RENDERED forms, so `new Date(x)` equals a stored `Date(x)`, and
 * `1n` equals `'1'` — a minor-unit column read back as a string has not changed
 * because somebody handed us the bigint. Flagging that would fill the log with
 * non-events, which is upstream's point and applies unchanged.
 */
function same(a: unknown, b: unknown): boolean {
  const [x, y] = [render(a), render(b)];
  if (x === null || y === null || typeof x !== 'object') return x === y;
  return JSON.stringify(x) === JSON.stringify(y);
}

/**
 * A `type`, not an `interface`, and that is load-bearing: only a type alias gets
 * an implicit index signature, which is what lets a diff be passed straight as
 * `AuditInput.details` (`Record<string, unknown>`) with no cast at any call site.
 */
export type AuditDiff = {
  /** Only the fields that genuinely differ, each with both sides. */
  changed: Record<string, { from: unknown; to: unknown }>;
  /** Their names, for a reader — or a query — that wants the shape without the values. */
  fields: string[];
  /**
   * True when nothing changed. Worth recording rather than dropping the row: a
   * save that altered no field is a different event from one that did, and
   * telling them apart is most of what makes an edit log readable.
   */
  unchanged: boolean;
};

export interface AuditDiffOptions {
  /**
   * Columns that are never an edit. `updated_at` moves on every write, so
   * without it `unchanged` would always be false and the flag would be a lie.
   * Derived columns belong here too — see `IGNORED_COLUMNS`.
   */
  ignore?: readonly string[];
  /**
   * Fields whose CHANGE is auditable but whose VALUE is not ours to copy into a
   * second table. Both sides are replaced; the field still appears in `fields`.
   */
  redact?: readonly string[];
}

/**
 * Columns no edit diff should ever report, applied by default.
 *
 * `updated_at` is the mechanical one. `total_minor` on `expense_report` is the
 * interesting one: `recomputeReportTotal` rewrites it after every line-item
 * change, so a report diff would report a "change" that is a consequence of an
 * edit already audited on the line item — the same event, twice, in two places,
 * with the second one blaming the wrong row.
 */
export const IGNORED_COLUMNS = ['updated_at', 'created_at', 'total_minor'] as const;

/**
 * Diff two rows over the union of their keys.
 *
 * The union, not `before`'s keys: a column added by a migration is absent from a
 * row written before it, and its arrival IS a change ({ from: null, to: … }).
 *
 * A key whose value is `undefined` on the `after` side is SKIPPED rather than
 * recorded as cleared — that is what "the caller did not select this column"
 * means, and recording it as a change to null would invent an edit nobody made.
 * An explicit `null` IS a change: somebody cleared the field.
 */
export function auditDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  opts?: AuditDiffOptions,
): AuditDiff {
  const ignore = new Set<string>([...IGNORED_COLUMNS, ...(opts?.ignore ?? [])]);
  const redact = new Set<string>(opts?.redact ?? []);
  const changed: Record<string, { from: unknown; to: unknown }> = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ignore.has(key)) continue;
    if (!(key in after) || after[key] === undefined) continue;
    const prev = before[key];
    const next = after[key];
    if (same(prev, next)) continue;
    changed[key] = redact.has(key)
      ? { from: '[redacted]', to: '[redacted]' }
      : { from: render(prev), to: render(next) };
  }

  const fields = Object.keys(changed).sort();
  return { changed, fields, unchanged: fields.length === 0 };
}

/**
 * A row that is about to stop existing, rendered for `details`.
 *
 * Deletions are the edits an auditor cares about most — "who deleted the $4,000
 * line" — and upstream's port does not cover them, because their commit was
 * about edit mutations. Ours covers them because the same question applies and
 * the row is right there. `IGNORED_COLUMNS` are dropped for the same reasons.
 */
export function auditSnapshot(
  row: Record<string, unknown>,
  opts?: AuditDiffOptions,
): Record<string, unknown> {
  const ignore = new Set<string>([...IGNORED_COLUMNS, ...(opts?.ignore ?? [])]);
  const redact = new Set<string>(opts?.redact ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (ignore.has(key)) continue;
    out[key] = redact.has(key) ? '[redacted]' : render(value);
  }
  return out;
}
