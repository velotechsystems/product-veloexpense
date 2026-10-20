import { satisfies } from '@expenseos/api-scopes';
import { TOOLS } from '@expenseos/mcp-server';
import { describe, expect, it } from 'vitest';
import { PERSONAL_KEY_POLICY } from './personalApiKey';

/**
 * The tool-surface tripwire — what a self-service personal key can actually DO.
 *
 * ## Why this test exists
 *
 * `PERSONAL_KEY_POLICY.scopes` is three strings, and three strings are not a capability
 * anybody can picture. The capability is the set of TOOLS those scopes reach in
 * `@expenseos/mcp-server`, and that set is the thing the `/profile` box promises its users
 * in plain language. Nothing else in the build pins it.
 *
 * The failure it is here to catch is silent and one-sided: somebody files a new tool under
 * `expense_management.expense_report` — a perfectly reasonable thing to do — and every
 * personal key already issued gains that capability instantly, with no mint, no
 * notification, and no diff that says so. This test turns that into a red build, and the
 * fix is to update the list on purpose, which is a decision with a reviewer attached.
 *
 * ## Why the expected list is written out by hand
 *
 * Deriving it — `TOOLS.filter((t) => satisfies(POLICY.scopes, t.scope, t.access))` — would
 * make the assertion vacuous: the expectation would move with the source it is meant to
 * watch, and the test would pass for every possible registry. Same reasoning as acceptance
 * criterion 4 spelling its three scope strings out rather than importing the constant. The
 * literals below are the point of the file.
 *
 * ## One entry that looks like a mistake and is not
 *
 * `search_help_articles` is filed under `expense_management.expense_report`, so a personal
 * key reaches it. Recorded here rather than "corrected": whether help-article search wants
 * a scope of its own is a question for whoever owns the registry, and quietly excluding it
 * from this list would hide the fact that today it does not have one.
 */

/**
 * Every tool the three self-service scopes reach, by name.
 *
 * 10 under `expense_management.expense_report`, 3 under `travel.travel_request`, 2 under
 * `collaboration.discussion`. Sorted, so a diff on this list reads as an addition or a
 * removal rather than a reshuffle.
 */
const REACHABLE = [
  'add_receipts_to_expense_report',
  // Filing a trip is self-service, the same as filing an expense report. Note what is NOT
  // here: `decide_travel_request`. It moved to `travel.travel_approval` precisely so a key
  // issued to FILE trips cannot approve them.
  'create_travel_request',
  'get_travel_request_options',
  'explain_expense_tax',
  // VeloExpense (w6-04): `explain_per_diem` is not in VeloExpense's registry — its procedure
  // was not ported (w6-03, Assistant 1), so it is in neither list.
  'get_expense_report',
  'get_travel_request',
  'list_my_expense_reports',
  'list_my_travel_requests',
  'post_comment',
  'read_discussion_thread',
  'recall_expense_report',
  'register_uploaded_receipt',
  'search_help_articles',
  'search_travel_destinations',
  'start_expense_report_from_receipts',
  'submit_expense_report',
  'submit_travel_request',
];

/**
 * Everything the registry holds that a personal key must NOT reach, and why.
 *
 * Asserted as well as `REACHABLE`, because the two catch different mistakes. A tool ADDED
 * under a granted scope shows up as an extra in `REACHABLE`; a tool whose scope is CHANGED
 * from `finance.budget` to `expense_management.expense_report` shows up in both lists at
 * once, and a test that only counted the reachable side could be satisfied by a coincidence
 * of arithmetic.
 */
const NOT_REACHABLE = [
  // Approving is not self-service: a key that could approve would let an assistant sign off
  // the very reports it filed. All three domains now hold that line by CONSTRUCTION — each
  // has an approval scope the personal policy does not grant, rather than relying on
  // nobody having written the tool yet.
  // VeloExpense (w6-04): the virtual-card tools and `list_budgets` are not in VeloExpense's
  // registry (w6-03, Assistant 1: virtual cards are out of scope, and there is no budgets
  // router), so they are in neither list. ExpenseOS withholds them from a personal key too.
  'decide_expense_report',
  'decide_travel_request',
  'list_my_approval_tasks',
  'list_my_travel_approval_tasks',
  'return_expense_report_for_edit',
];

/** The real gate: `satisfies` is what `apiKeyGuard` asks before a tool call runs. */
const reachableByPolicy = () =>
  TOOLS.filter((tool) => satisfies(PERSONAL_KEY_POLICY.scopes, tool.scope, tool.access))
    .map((tool) => tool.name)
    .sort();

describe('what a personal key reaches in the tool registry', () => {
  it('reaches exactly these seventeen tools, and no others' /* VeloExpense (w6-04): ExpenseOS's eighteen less explain_per_diem */, () => {
    /**
     * `toEqual` on a sorted array rather than a set membership check or a count: an extra
     * name and a missing name have to be distinguishable in the failure output, because
     * they mean opposite things. An extra is a capability everybody silently gained; a
     * missing one is a capability everybody silently lost.
     */
    expect(reachableByPolicy()).toEqual([...REACHABLE].sort());
  });

  it('reaches none of the five the policy deliberately withholds' /* VeloExpense (w6-04): ExpenseOS's fifteen less the ten VeloExpense has no tool for */, () => {
    const reached = new Set(reachableByPolicy());
    for (const name of NOT_REACHABLE) {
      expect(reached.has(name), `${name} must not be reachable by a personal key`).toBe(false);
    }
  });

  it('accounts for every tool in the registry, so nothing is unclassified', () => {
    /**
     * The gap this closes: a tool added under a scope nobody grants would appear in neither
     * list above, both cases would stay green, and the registry would have grown a surface
     * no one here looked at. 33 = 18 + 15 is the arithmetic that makes the two lists a
     * partition rather than two samples.
     */
    expect(TOOLS).toHaveLength(REACHABLE.length + NOT_REACHABLE.length);
    expect(
      TOOLS.map((tool) => tool.name).sort(),
      'a tool in the registry is in neither the reachable nor the withheld list',
    ).toEqual([...REACHABLE, ...NOT_REACHABLE].sort());
  });

  it('grants read and write on each of its three scopes, not read alone', () => {
    /**
     * Six of the fifteen are `access: 'write'` — submitting a report, posting a comment.
     * The vocabulary has no separate write flag: holding the bare resource IS the write
     * grant, and `x.readonly` is the narrower string. If the policy ever drifted to the
     * readonly forms this file's first case would still pass on the nine reads, so the
     * write half is asserted on its own.
     */
    const writes = TOOLS.filter((tool) => tool.access === 'write' && REACHABLE.includes(tool.name));
    expect(writes.length).toBeGreaterThan(0);
    for (const tool of writes) {
      expect(satisfies(PERSONAL_KEY_POLICY.scopes, tool.scope, 'write')).toBe(true);
    }
  });

  it('is written against the three scopes the policy actually holds', () => {
    // If the policy itself changes, the lists above stop describing anything — so the
    // constant is pinned here too, literally, exactly as acceptance criterion 4 requires.
    expect([...PERSONAL_KEY_POLICY.scopes]).toEqual([
      'expense_management.expense_report',
      'travel.travel_request',
      'collaboration.discussion',
    ]);
  });
});
