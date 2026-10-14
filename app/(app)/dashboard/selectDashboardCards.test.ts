import { permissions as P } from '@expenseos/rbac';
import { describe, expect, it } from 'vitest';
import { EXPENSE_MODULE, selectDashboardCards, TRAVEL_MODULE } from './selectDashboardCards';

/**
 * The dashboard's card gating, exhaustively.
 *
 * This file is not a nicety. It is the ONLY place the module-inactive branches are
 * covered anywhere in the suite: `bootstrapModuleInstallations()` skips any module that
 * already owns an installation row, so once a module is deactivated in a seeded database
 * no boot ever turns it back on — which means Playwright can never observe a travel-off
 * or expenses-off workspace. Every row below is therefore load-bearing, and every
 * expectation is written by hand rather than derived from the implementation.
 *
 * Three tables, because the three predicates take disjoint inputs: `showTravel` is a
 * function of three booleans (8 rows, all of them here), `showApprovals` of two (4 rows)
 * and `showExpenses` of two (4 rows). A single cross product would be the same 16 facts
 * repeated.
 *
 * `showExpenses` is the one whose PERMISSION half is also unreachable from Playwright, for
 * a second reason on top of the module one: every system role holds `expense.report.readOwn`
 * (`collectEmployeeBase()`, and `flatten(P.expense)` for the two admin roles), so no seeded
 * actor can produce its false branch. The reader it protects is a Role Builder role somebody
 * composed without that permission, and this file is the only place that reader exists.
 */

const modules = (...slugs: string[]) => new Set(slugs);

describe('selectDashboardCards — showTravel', () => {
  /**
   * The full truth table over (travel module active, create-own, approve). It mirrors
   * `travel/page.tsx:25-29` exactly, and it must keep mirroring it: the card deep-links
   * to /travel, so any row where this says `true` and that page would `notFound()` is a
   * card that lands the reader on a 404.
   */
  const rows: {
    moduleActive: boolean;
    createOwn: boolean;
    approve: boolean;
    expected: boolean;
    why: string;
  }[] = [
    {
      moduleActive: false,
      createOwn: false,
      approve: false,
      expected: false,
      why: 'nothing at all',
    },
    {
      moduleActive: false,
      createOwn: false,
      approve: true,
      expected: false,
      why: 'an approver on a workspace with travel switched off — the module wins',
    },
    {
      moduleActive: false,
      createOwn: true,
      approve: false,
      expected: false,
      why: 'a requester on a workspace with travel switched off — the module wins',
    },
    {
      moduleActive: false,
      createOwn: true,
      approve: true,
      expected: false,
      why: 'both permissions cannot outvote an inactive module',
    },
    {
      moduleActive: true,
      createOwn: false,
      approve: false,
      expected: false,
      why: 'travel is on but this reader can neither request nor decide',
    },
    {
      moduleActive: true,
      createOwn: false,
      approve: true,
      expected: true,
      why: 'approve alone is enough — /travel admits approvers',
    },
    {
      moduleActive: true,
      createOwn: true,
      approve: false,
      expected: true,
      why: 'create-own alone is enough — the ordinary traveller',
    },
    { moduleActive: true, createOwn: true, approve: true, expected: true, why: 'both' },
  ];

  for (const { moduleActive, createOwn, approve, expected, why } of rows) {
    it(`module=${moduleActive} createOwn=${createOwn} approve=${approve} -> ${expected} (${why})`, () => {
      const permissions = [
        ...(createOwn ? [P.travel.request.createOwn] : []),
        ...(approve ? [P.travel.request.approve] : []),
      ];
      const result = selectDashboardCards({
        activeModules: modules(...(moduleActive ? [TRAVEL_MODULE] : [])),
        permissions,
      });
      expect(result.showTravel).toBe(expected);
    });
  }

  it('is not fooled by a travel permission the reader holds for a different verb', () => {
    /** `reject` and `return` are decision verbs an approver also holds, but neither one
     *  is what /travel gates on, and neither one alone gets you through that page. */
    expect(
      selectDashboardCards({
        activeModules: modules(TRAVEL_MODULE),
        permissions: [P.travel.request.reject, P.travel.request.return],
      }).showTravel,
    ).toBe(false);
  });
});

describe('selectDashboardCards — showApprovals', () => {
  /** The full truth table over (expense-management active, approve). */
  const rows: { moduleActive: boolean; approve: boolean; expected: boolean; why: string }[] = [
    { moduleActive: false, approve: false, expected: false, why: 'nothing at all' },
    {
      moduleActive: false,
      approve: true,
      expected: false,
      why: 'the clause the ticket omitted — without it every row links into a 404',
    },
    {
      moduleActive: true,
      approve: false,
      expected: false,
      why: 'expenses are on but nothing waits on this reader',
    },
    { moduleActive: true, approve: true, expected: true, why: 'the approver' },
  ];

  for (const { moduleActive, approve, expected, why } of rows) {
    it(`module=${moduleActive} approve=${approve} -> ${expected} (${why})`, () => {
      expect(
        selectDashboardCards({
          activeModules: modules(...(moduleActive ? [EXPENSE_MODULE] : [])),
          permissions: approve ? [P.expense.report.approve] : [],
        }).showApprovals,
      ).toBe(expected);
    });
  }

  it('gives a reimburse-only AP clerk no card, deliberately', () => {
    /**
     * /expenses/approvals admits `approve` OR `reimburse` OR `readAll`. This card admits
     * `approve` only, so an AP clerk who can pay but not decide keeps their inbox and
     * loses the dashboard card. That is the intended narrowing: the card is about work
     * waiting on YOUR DECISION. Do not "fix" this test by widening the predicate.
     */
    expect(
      selectDashboardCards({
        activeModules: modules(EXPENSE_MODULE),
        permissions: [P.expense.report.reimburse, P.expense.report.readAll],
      }).showApprovals,
    ).toBe(false);
  });
});

describe('selectDashboardCards — showExpenses', () => {
  /**
   * The full truth table over (expense-management active, read-own).
   *
   * BOTH CLAUSES GUARD A DIFFERENT FAILURE, which is why neither column may be dropped
   * "because the other one covers it":
   *
   *   · module off  → `/expenses` calls `requireActiveModule`, which is `notFound()`, so
   *     every row link and the "View all" footer are 404s;
   *   · read-own missing → `expenses.list`, the card's only query, is
   *     `withPermission(readOwn)`, which THROWS `FORBIDDEN`, so the card is a permanent
   *     `common.panelUnavailable` panel with a Retry that can never succeed.
   *
   * Both land on the post-login landing page, which is the one page that may not fail.
   */
  const rows: { moduleActive: boolean; readOwn: boolean; expected: boolean; why: string }[] = [
    { moduleActive: false, readOwn: false, expected: false, why: 'nothing at all' },
    {
      moduleActive: false,
      readOwn: true,
      expected: false,
      why: 'an ordinary filer on a workspace with expense management switched off — every row would link into a 404',
    },
    {
      moduleActive: true,
      readOwn: false,
      expected: false,
      why: 'the custom-role case no seeded actor can reach: both procedures throw FORBIDDEN, so the card would be an error panel',
    },
    { moduleActive: true, readOwn: true, expected: true, why: 'the ordinary filer' },
  ];

  for (const { moduleActive, readOwn, expected, why } of rows) {
    it(`module=${moduleActive} readOwn=${readOwn} -> ${expected} (${why})`, () => {
      expect(
        selectDashboardCards({
          activeModules: modules(...(moduleActive ? [EXPENSE_MODULE] : [])),
          permissions: readOwn ? [P.expense.report.readOwn] : [],
        }).showExpenses,
      ).toBe(expected);
    });
  }

  it('is not satisfied by the wider expense permissions an administrator holds', () => {
    /**
     * `readAll` and `reimburse` open `/expenses/all` and the reimbursement queue, and
     * neither one gets a caller through `withPermission(readOwn)` — `list` and
     * `summaryOwn` name `readOwn` and nothing else. A card gated on the wider grant would
     * still paint the error panel it exists to prevent.
     */
    expect(
      selectDashboardCards({
        activeModules: modules(EXPENSE_MODULE),
        permissions: [P.expense.report.readAll, P.expense.report.reimburse],
      }).showExpenses,
    ).toBe(false);
  });
});

describe('selectDashboardCards — the three gates do not leak into each other', () => {
  it('a travel-only workspace shows travel and hides both expense cards', () => {
    expect(
      selectDashboardCards({
        activeModules: modules(TRAVEL_MODULE),
        permissions: [
          P.travel.request.createOwn,
          P.expense.report.approve,
          P.expense.report.readOwn,
        ],
      }),
    ).toEqual({ showTravel: true, showApprovals: false, showExpenses: false });
  });

  it('an expenses-only workspace shows both expense cards and hides travel', () => {
    expect(
      selectDashboardCards({
        activeModules: modules(EXPENSE_MODULE),
        permissions: [
          P.travel.request.createOwn,
          P.expense.report.approve,
          P.expense.report.readOwn,
        ],
      }),
    ).toEqual({ showTravel: false, showApprovals: true, showExpenses: true });
  });

  it('the two expense cards are decided independently of each other', () => {
    /**
     * They share a module and nothing else. An approver composed without `readOwn` keeps
     * the queue and loses their own reports; a filer without `approve` is the mirror
     * image. Asserted as one statement so a predicate that started reading the other
     * card's permission fails here rather than in an E2E run nobody attributes.
     */
    expect(
      selectDashboardCards({
        activeModules: modules(EXPENSE_MODULE),
        permissions: [P.expense.report.approve],
      }),
    ).toEqual({ showTravel: false, showApprovals: true, showExpenses: false });
    expect(
      selectDashboardCards({
        activeModules: modules(EXPENSE_MODULE),
        permissions: [P.expense.report.readOwn],
      }),
    ).toEqual({ showTravel: false, showApprovals: false, showExpenses: true });
  });

  it('an unrelated active module changes nothing', () => {
    expect(
      selectDashboardCards({
        activeModules: modules('virtual-credit-cards'),
        permissions: [P.travel.request.approve, P.expense.report.approve, P.expense.report.readOwn],
      }),
    ).toEqual({ showTravel: false, showApprovals: false, showExpenses: false });
  });

  it('hides every card for a reader with no permissions on a fully installed workspace', () => {
    expect(
      selectDashboardCards({
        activeModules: modules(TRAVEL_MODULE, EXPENSE_MODULE, 'virtual-credit-cards'),
        permissions: [],
      }),
    ).toEqual({ showTravel: false, showApprovals: false, showExpenses: false });
  });
});
