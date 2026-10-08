/**
 * UD-2 — "is this report coded well enough to post", in ONE place.
 *
 * ── WHAT UPSTREAM FOUND, AND WHAT IT COST THEM ──────────────────────────────
 *
 * ExpenseOS `22f81fd5` asked that question only of an APPROVED report, at post
 * time. On their dev database **all 200 approved reports refused**, every one of
 * them for missing coding, and nothing stopped more arriving. The fix extracts
 * the definition into one module used by both the poster and `submit`.
 *
 * ── OURS WAS THE SAME GAP, WITH THE SAME CAUSE ──────────────────────────────
 *
 * `dryRun` computes a `problems` list and the VeloLedger adapter refuses an
 * unmapped line in plain language, but `lib/expenses/lifecycle.ts:submitReport`
 * consulted neither. It checked status, that the report has line items, and the
 * policy rules. **Nothing checked that a line has a GL account.** And
 * `Workbench.uncodedExpenseCount` counts expenses with no LINE ITEMS, which is a
 * different thing that reads like this one.
 *
 * So a category with no `gl_account_id` — nullable on purpose since `0014`, "a
 * configuration gap, and the employee filing the expense is not who fixes it" —
 * passed submit, passed approval, and surfaced days later in the ledger queue, to
 * an operator who did not file the report and also cannot fix the cause.
 *
 * ── WHAT "CODED" MEANS, AND WHY THAT IS THE INTERESTING PART ────────────────
 *
 * `coalesce(line.gl_account_id, category.gl_account_id)`: the account SNAPSHOTTED
 * on the line when it was filed (VX3-1 / AC-10), falling back to the category's
 * current account only for a line written before `0014`.
 *
 * That join fragment appeared in THREE places before this file: `dryRun`,
 * `dispatch.loadPostable`, and the adapter's own refusal. All three agreed, which
 * is the good case and not the durable one — the next reader to add a fourth is
 * the one who gets it wrong, and a coding rule that differs between the gate and
 * the poster is a report that passes submit and then cannot post, which is
 * precisely the bug this ticket closes.
 *
 * ── ONE THING THIS FILE'S FIRST DRAFT CLAIMED AND A SABOTAGE DISPROVED ──────
 *
 * That comment went on to say the order matters here — "it does NOT prefer the
 * category". It does not matter here, and the sabotage that flipped it passed all
 * twelve tests, correctly: this function asks only whether EITHER account is
 * present, and `coalesce(a, b) IS NULL` is the same question as
 * `coalesce(b, a) IS NULL`.
 *
 * The order is load-bearing where the coalesce picks the actual account NUMBER —
 * `dispatch.loadPostable` and `dryRun`'s line list — because there, flipping it
 * changes which account the money lands in, silently, for every report whose
 * category was re-mapped after it was filed. Nothing pinned that until the
 * sabotage went looking; `test/ledger-post.db.test.ts` now does.
 *
 * The two payload loaders keep their own SELECT, because they need columns this
 * does not. What they no longer keep is their own idea of what counts as coded.
 *
 * ── WHERE THE GATE RUNS, AND THE TWO CONDITIONS THAT ARE NOT OPTIONAL ───────
 *
 * 1. ONLY WHEN A LEDGER IS CONNECTED. The requirement comes from the
 *    integration; a tenant with none has nothing to be coded *for*, and refusing
 *    a submission there conjures a rule out of an absent integration. Upstream's
 *    `loadNetSuiteConfig` returning null skips their guard entirely and a test
 *    asserts it is never reached. Ours asks `capabilityAvailability`, which
 *    already answers this correctly for the two awkward cases: the accounting
 *    module being off is `connected: false`, and TWO connected ledgers (AC-22) is
 *    `connected: true` — something is connected, too much of it, and the coding
 *    is required either way.
 * 2. BEFORE THE POLICY PASS. This is a fact about the report, not a judgement
 *    about it. Somebody fixing coding should not have to read past a policy
 *    warning to learn the report cannot post at all.
 */
import type { QueryRunner } from '@/lib/db/client';

export interface UncodedCategory {
  categoryId: string;
  code: string;
  label: string;
  /** How many line items on this report carry it. For "3 expenses need coding". */
  lineItems: number;
}

/**
 * THE DEFINITION. Categories on this report whose lines could not name a GL
 * account, worst first, then by code so the order is stable.
 *
 * Grouped by CATEGORY rather than returned per line, because the category is the
 * thing somebody fixes: three uncoded taxi lines are one mapping to add, and a
 * refusal listing three lines invites three trips to the same screen.
 */
export async function uncodedCategories(
  tx: QueryRunner,
  reportId: string,
): Promise<UncodedCategory[]> {
  const r = await tx.query(
    `SELECT c.id, c.code, c.label ->> 'en' AS label, count(li.id)::int AS line_items
       FROM expense_line_item li
       JOIN expense e ON e.id = li.expense_id
       JOIN expense_category c ON c.id = li.category_id
       LEFT JOIN gl_account lg ON lg.id = li.gl_account_id
       LEFT JOIN gl_account cg ON cg.id = c.gl_account_id
      WHERE e.report_id = $1
        AND coalesce(lg.number, cg.number) IS NULL
      GROUP BY c.id, c.code, c.label ->> 'en'
      ORDER BY count(li.id) DESC, c.code`,
    [reportId],
  );
  return r.rows.map((row) => ({
    categoryId: row.id as string,
    code: row.code as string,
    label: row.label as string,
    lineItems: row.line_items as number,
  }));
}

/**
 * The sentence for a LOG, naming the categories and the size of the job.
 *
 * The reader's version is a message code — `SUBMIT_UNCODED_ONE` /
 * `SUBMIT_UNCODED_MANY` with the labels as a parameter — because a diagnostic
 * belongs in the log and a person gets catalogued copy (IL-11). Singular is
 * handled: "1 category needs a GL account" reads as a defect.
 */
export function uncodedDiagnostic(uncoded: UncodedCategory[]): string {
  const labels = uncoded.map((u) => u.label).join(', ');
  const lines = uncoded.reduce((n, u) => n + u.lineItems, 0);
  return (
    `${uncoded.length === 1 ? '1 category has' : `${uncoded.length} categories have`} ` +
    `no GL account (${labels}), covering ` +
    `${lines === 1 ? '1 line item' : `${lines} line items`}`
  );
}
