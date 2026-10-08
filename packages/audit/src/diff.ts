/**
 * "What did they actually change, and from what?"
 *
 * Every edit mutation in the product recorded its audit detail the same way:
 *
 *     details: { fields: Object.keys(input) }
 *
 * which answers neither half of the question. It names the keys the CLIENT SENT,
 * not the ones that changed — a form that posts its whole model on save records
 * every field as edited on every save, so an audit row cannot distinguish
 * "corrected the amount" from "opened it and pressed Save". And it carries no
 * values at all, so a reviewer can see that the merchant was touched and never
 * what it was before (UAT A12: "When a user edits their request, it should audit
 * what was edited").
 *
 * `auditDiff` compares the row as it stood against the patch about to be applied
 * and reports only the genuine differences, each as `{ from, to }`.
 *
 * WHAT IT DOES NOT DO. It does not decide whether an edit was allowed, and it is
 * not a change-data-capture feed. It reports the fields a caller hands it, so a
 * mutation that quietly writes a column it did not list stays invisible here —
 * which is the honest failure mode, because the alternative is an audit row that
 * claims completeness it cannot have.
 *
 * `details` is deliberately NOT part of the hash payload (see `chain.ts`), so
 * enriching it does not disturb an existing chain: rows written before this and
 * rows written after verify identically.
 */

/** A JSON-safe rendering of one value, for the `details` Jsonb column.
 *
 *  Prisma hands back `Date`, `bigint` and `Decimal` — none of which survive
 *  `JSON.stringify` intact (the first two silently change shape, the third throws).
 *  Rendering them here rather than at each call site is what keeps two audit rows
 *  for the same field comparable. */
function jsonValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  // Prisma Decimal, and anything else that knows how to render itself exactly.
  if (typeof v === 'object' && 'toFixed' in (v as object)) return String(v);
  if (typeof v === 'object') {
    // Arrays and plain objects (attendee rosters, locale maps) round-trip as-is,
    // via a stringify that will throw loudly on anything that cannot.
    return JSON.parse(JSON.stringify(v));
  }
  return v;
}

/** Two values are the same edit-wise when they render identically. Compares the
 *  RENDERED forms so `new Date(x)` equals the stored `Date(x)`, and `1n` equals
 *  `'1'` — a client that sends a string for a bigint column has not changed it. */
function same(a: unknown, b: unknown): boolean {
  const [x, y] = [jsonValue(a), jsonValue(b)];
  if (x === null || y === null || typeof x !== 'object') return x === y;
  return JSON.stringify(x) === JSON.stringify(y);
}

/** A `type` rather than an `interface` on purpose: only a type alias gets an implicit
 *  index signature, which is what lets a diff be handed straight to `details`
 *  (`Record<string, unknown>`) without a cast at every call site. */
export type AuditDiff = {
  /** Only the fields that genuinely differ, each with its old and new value. */
  changed: Record<string, { from: unknown; to: unknown }>;
  /** Their names, for a reader (or a query) that wants the shape without the values. */
  fields: string[];
  /** True when the caller submitted a patch that changed nothing. Worth recording:
   *  a save that altered no field is a different event from one that did, and
   *  telling them apart is most of what makes an edit log readable. */
  unchanged: boolean;
};

/**
 * Diff `patch` against `before`, over the keys present in `patch`.
 *
 * A key whose value is `undefined` is SKIPPED, not treated as a clear — that is
 * what "omit to leave untouched" means in every one of these tRPC inputs, and
 * recording it as a change to null would invent an edit nobody made. An explicit
 * `null` IS a change: the caller cleared the field.
 *
 * `redact` names fields whose presence should be logged but whose values must not
 * be — a changed value is still recorded as changed, with both sides replaced.
 */
export function auditDiff(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
  opts?: { redact?: readonly string[] },
): AuditDiff {
  const redact = new Set(opts?.redact ?? []);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(patch)) {
    if (next === undefined) continue;
    const prev = before[key];
    if (same(prev, next)) continue;
    changed[key] = redact.has(key)
      ? { from: '[redacted]', to: '[redacted]' }
      : { from: jsonValue(prev), to: jsonValue(next) };
  }
  const fields = Object.keys(changed);
  return { changed, fields, unchanged: fields.length === 0 };
}
