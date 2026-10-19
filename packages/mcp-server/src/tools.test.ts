import { isScopeResource } from '@expenseos/api-scopes';
import { ALL_PERMISSIONS } from '@expenseos/rbac';
import { describe, expect, it } from 'vitest';
import { TOOLS, toolByName } from './tools';

describe('tool registry', () => {
  it('has unique names', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names are snake_case and verb-first', () => {
    // The name is a wire contract with every connected client — a rename is a breaking
    // change, so the shape is pinned rather than left to taste.
    for (const tool of TOOLS) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  it('every declared permission exists in the RBAC registry', () => {
    // The tripwire that matters most here. A permission string typo would not fail to
    // compile (it is only a string by the time it reaches the caller), and the tool would
    // be silently invisible to everyone — a feature that is simply missing, with nothing
    // to grep for. Checked against the real registry, not a copy.
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const tool of TOOLS) {
      if (tool.permission) expect(known.has(tool.permission), tool.permission).toBe(true);
    }
  });

  it('every path is a dotted router procedure', () => {
    /**
     * Two segments OR three: `virtualCards.requests.create` is real — card requests are a
     * router nested under `virtualCards`, as are transactions, statements and limit
     * increases. The two-segment rule was written when nothing nested was exposed, and
     * enforcing it would have pushed a wrong path into the registry rather than caught one.
     *
     * Shape only. Whether the procedure EXISTS is `mcpToolPaths.test.ts` in the web app —
     * the one place that can import both the registry and `appRouter`.
     */
    for (const tool of TOOLS) {
      expect(tool.path, tool.name).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*){1,2}$/);
    }
  });

  it('descriptions say when to call, not just what the tool is', () => {
    // Prescriptive descriptions measurably lift correct tool selection. The bar here is
    // crude — length — but it catches the one-line placeholder that creeps in when
    // somebody adds a tool in a hurry.
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(80);
    }
  });

  /**
   * A tool with no declared permission is reachable by ANY authenticated user, and is
   * only safe because the procedure behind it decides access per record
   * (`canViewReport`, travel's `canRead`, task assignment). That is a real and correct
   * pattern — but it is not a thing to acquire by accident.
   *
   * So the permission-less set is pinned. Adding one fails this test, which forces
   * whoever adds it to confirm the procedure really does gate per record rather than
   * simply having forgotten the permission.
   */
  it('pins the tools that intentionally carry no permission', () => {
    const permissionless = TOOLS.filter((t) => !t.permission)
      .map((t) => t.name)
      .sort();
    // VeloExpense (w6-03): without the virtual-card tools (d50), `explain_per_diem` (its
    // procedure is not ported yet) and `list_budgets` (no budgets router).
    expect(permissionless).toEqual([
      'decide_expense_report',
      // The three `decide` tools and the three task queues carry no permission for the
      // same reason the expense one does not: the right to decide is not a role, it is
      // being the ASSIGNEE of that task. Checked rather than assumed — `travelRequests.decide`
      // and `virtualCardRequests.decide` both call `canDecide(db, taskId, rbac.id, isAdmin)`
      // and throw FORBIDDEN, and each `myTasks` selects only rows assigned to the caller.
      'decide_travel_request',
      'explain_expense_tax',
      'get_expense_report',
      'get_travel_request',
      'list_my_approval_tasks',
      'list_my_travel_approval_tasks',
      'list_my_travel_requests',
      'post_comment',
      'read_discussion_thread',
      'return_expense_report_for_edit',
      // Authored guidance, gated on the assistant module rather than a permission: anybody who
      // can open the chat may read the help corpus, and the search filters by active module so
      // an article about a feature the workspace lacks is never a candidate.
      'search_help_articles',
    ]);
  });

  it('classifies state changes as mutations', () => {
    // If a mutation were mislabelled `read` it would execute with no human press — the
    // one failure this whole design exists to prevent.
    const mutations = TOOLS.filter((t) => t.kind === 'mutate')
      .map((t) => t.name)
      .sort();
    // VeloExpense (w6-03): without the four virtual-card mutations (d50).
    expect(mutations).toEqual([
      'add_receipts_to_expense_report',
      'create_travel_request',
      'decide_expense_report',
      'decide_travel_request',
      'post_comment',
      'recall_expense_report',
      'register_uploaded_receipt',
      'return_expense_report_for_edit',
      'start_expense_report_from_receipts',
      'submit_expense_report',
      'submit_travel_request',
    ]);
  });

  it('keeps the surface-restricted list to the ones that cannot work elsewhere', () => {
    // An inventory rather than a rule, because the default (both surfaces) is what almost
    // every tool wants and a stray `surfaces` is how a tool silently disappears from the
    // chat. Adding one here should be a deliberate line in a diff.
    const restricted = TOOLS.filter((t) => t.surfaces !== undefined)
      .map((t) => `${t.name}:${[...(t.surfaces ?? [])].sort().join('+')}`)
      .sort();
    expect(restricted).toEqual(['register_uploaded_receipt:mcp']);
  });

  it('every tool declares a scope this build knows', () => {
    // The tripwire that matters most now the registry lives beside the scopes. A tool
    // without one would be reachable by any key that got through the door, and nothing
    // would say so — it would simply appear in `tools/list` for everybody.
    for (const tool of TOOLS) {
      expect(isScopeResource(tool.scope), `${tool.name}: ${tool.scope}`).toBe(true);
      expect(['read', 'write'], tool.name).toContain(tool.access);
    }
  });

  it('never lets a mutating tool be satisfied by read-only access', () => {
    // `kind` decides whether a human confirms; `access` decides whether `.readonly` suffices.
    // They are separate fields answering to different audiences, and this is the one
    // combination that would be a privilege bug rather than a design choice.
    for (const tool of TOOLS) {
      if (tool.kind === 'mutate') expect(tool.access, tool.name).toBe('write');
    }
  });

  it('finds a tool by name and returns undefined for an unknown one', () => {
    expect(toolByName('submit_expense_report')?.path).toBe('expenses.submit');
    expect(toolByName('drop_database')).toBeUndefined();
  });
});
