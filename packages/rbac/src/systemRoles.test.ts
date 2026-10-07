import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, isPermission, type Permission } from './permissions';
import {
  RETIRED_ROLE_IDS,
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_KINDS,
  SYSTEM_ROLE_LABELS,
  SYSTEM_ROLE_PERMISSIONS,
  type SystemRoleKind,
} from './systemRoles';

/**
 * The system-role registry, which had no tests and is load-bearing in a way that
 * fails quietly.
 *
 * Two classes of mistake this catches. **Structural**: a role added to
 * `SYSTEM_ROLE_KINDS` but missed in the ids, labels or permissions map — the seed
 * would then throw at deploy time, or worse, `SYSTEM_ROLE_IDS[kind]` returns
 * undefined and every user of that role gets no role at all. **A duplicated or
 * shifted UUID**, which silently re-points every user assigned to it, because the
 * id is the only stable identity a Role row has (there is no `code` column).
 *
 * Then the capability facts worth pinning, because each was a real hole:
 * somebody other than a System Administrator must be able to issue a card, and
 * paying a claim must not be the same permission as approving it.
 */

const kinds = SYSTEM_ROLE_KINDS as readonly SystemRoleKind[];

describe('system role registry', () => {
  it('defines an id, a label and a permission set for every kind', () => {
    for (const kind of kinds) {
      expect(SYSTEM_ROLE_IDS[kind], `id for ${kind}`).toMatch(/^[0-9a-f-]{36}$/);
      expect(SYSTEM_ROLE_LABELS[kind]?.en, `en label for ${kind}`).toBeTruthy();
      expect(SYSTEM_ROLE_PERMISSIONS[kind]?.length, `permissions for ${kind}`).toBeGreaterThan(0);
    }
  });

  it('translates every role label into fr-CA', () => {
    // A role name is user-facing — it renders in the people list and the role
    // picker — so a missing translation is visible English in a French session.
    for (const kind of kinds) {
      expect(SYSTEM_ROLE_LABELS[kind]?.['fr-CA'], `fr-CA label for ${kind}`).toBeTruthy();
    }
  });

  it('gives every role a distinct id', () => {
    // The id is the ONLY stable identity a Role row has. A duplicate silently
    // merges two roles and re-points everyone assigned to either.
    const ids = kinds.map((k) => SYSTEM_ROLE_IDS[k]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('grants only permissions that exist in the registry', () => {
    // A typo'd permission string is not a compile error at the array level; it is
    // a permission nobody holds, so a screen is silently inaccessible.
    for (const kind of kinds) {
      for (const perm of SYSTEM_ROLE_PERMISSIONS[kind]) {
        expect(isPermission(perm), `${kind} grants unknown "${perm}"`).toBe(true);
      }
    }
  });

  it('repeats no permission within a role', () => {
    // Harmless at runtime, but a duplicate means two collect() spreads overlap and
    // the role is no longer readable as a statement of intent.
    for (const kind of kinds) {
      const perms = SYSTEM_ROLE_PERMISSIONS[kind];
      expect(new Set(perms).size, `${kind} has duplicates`).toBe(perms.length);
    }
  });

  it('gives the System Administrator everything', () => {
    // The "last admin" guard in roles.delete assumes some role grants each
    // permission; admin is that role.
    expect(new Set(SYSTEM_ROLE_PERMISSIONS.admin)).toEqual(new Set(ALL_PERMISSIONS));
  });
});

describe('capability coverage', () => {
  // Typed as Permission so a renamed or deleted permission is a COMPILE error
  // here, not a test that quietly passes because nobody holds a string that no
  // longer exists.
  const holders = (perm: Permission) =>
    kinds.filter((k) => SYSTEM_ROLE_PERMISSIONS[k].includes(perm));

  it('lets somebody other than a System Administrator issue a card', () => {
    // The gap card-administrator was added for. `vcc.card.issue` lived only on
    // admin, so issuing a card needed a sysadmin — and `cardIssuerIds()` reads the
    // same permission, so the "approved, awaiting issuance" notification went to
    // an audience that does not work the queue.
    const issuers = holders('vcc.card.issue').filter((k) => k !== 'admin');
    expect(issuers).toContain('card-administrator');
    expect(issuers.length).toBeGreaterThan(0);
  });

  it('lets somebody other than a System Administrator close and reassign a card', () => {
    for (const perm of [
      'vcc.card.close',
      'vcc.card.reassign',
    ] as const satisfies readonly Permission[]) {
      expect(holders(perm).filter((k) => k !== 'admin').length, perm).toBeGreaterThan(0);
    }
  });

  it('keeps COMPANY-WIDE spend to finance admins and the executive', () => {
    /**
     * This used to assert the gate on the SCREEN — that only those three held
     * `analytics.dashboard.view`. That gate moved to the employee base in #365, so every
     * role that files expenses can open a view of its own spend, and `resolveScope` THROWS
     * without it (GA readiness report F02). #365's reason was a spend card on the home
     * page; that card is gone and `/analytics` is the screen the grant now keeps reachable.
     * Which screen it is does not change this test.
     *
     * The invariant it was really protecting is this one, and it is unchanged: seeing the
     * whole company's spend requires `analytics.view.all`. An employee holds `view.own` and
     * `view.chain`, so with no direct reports the rows they get back are their own spend and
     * nothing else — the screen is reachable, the rows are not.
     *
     * Asserting the SCOPE rather than the screen is exactly why the home page's deletion did
     * not touch this test, and it is the more durable claim besides: a future screen that
     * reads company spend would have to hold `view.all` to get any, whatever its own gate
     * happens to be.
     */
    const holders = SYSTEM_ROLE_KINDS.filter((k) =>
      SYSTEM_ROLE_PERMISSIONS[k].includes('analytics.view.all'),
    );
    // AP Clerk's inclusion predates this change: they reconcile payments company-wide, so
    // company-wide spend is their job. Asserted rather than assumed, so a future grant has to
    // argue for itself here.
    expect([...holders].sort()).toEqual([
      'admin',
      'ap-clerk',
      'executive',
      'expense-administrator',
    ]);
  });

  it('lets every role reach a dashboard of its OWN spend', () => {
    // The other half of the same decision: the gate is no longer what restricts anything, so
    // it must be held by everyone or the home page is blank for most of the company.
    for (const kind of SYSTEM_ROLE_KINDS) {
      expect(SYSTEM_ROLE_PERMISSIONS[kind], `${kind} should be able to open a dashboard`).toContain(
        'analytics.dashboard.view',
      );
    }
  });

  it('gives the executive company-wide spend and nothing else', () => {
    // A C-level answers "what are we spending", not "let this through". No admin,
    // approval, card or NetSuite rights — those would make it a second admin role.
    const perms = SYSTEM_ROLE_PERMISSIONS.executive;
    expect(perms).toContain('analytics.view.all');
    expect(perms).toContain('analytics.dashboard.view');
    expect(perms.filter((p) => p.startsWith('admin.'))).toEqual([]);
    expect(perms.filter((p) => p.startsWith('ledger.'))).toEqual([]);
    expect(perms).not.toContain('expense.report.approve');
    expect(perms).not.toContain('expense.report.reimburse');
    expect(perms).not.toContain('vcc.card.issue');
    // Still files expenses like anybody else.
    expect(perms).toContain('expense.report.create.own');
  });

  it('folds Manager into Employee without widening the roles that spread it', () => {
    /**
     * The fold. A manager is nothing more than an employee with reports, and the Manager
     * role never tracked that — on the seeded directory two users held it while 135 people
     * actually had direct reports.
     *
     * The trap this pins: Card Administrator, AP Clerk and Executive all compose from the
     * employee grants. Handing `expense.report.approve` to `collectEmployee` and letting
     * them spread THAT would have given all three the right to approve — which is a
     * segregation-of-duties failure for two of them. Hence the base/folded split.
     */
    const employee = SYSTEM_ROLE_PERMISSIONS.employee;

    // What Manager used to grant, now on Employee.
    for (const p of [
      'expense.report.approve',
      'expense.report.reject',
      'expense.report.return',
      'expense.report.read.reportingChain',
      'travel.request.approve',
      'vcc.request.approve',
      'delegation.create.own',
      'budget.read',
    ]) {
      expect(employee, `employee should carry ${p} after the fold`).toContain(p);
    }

    // …and still what an employee always had.
    expect(employee).toContain('expense.report.create.own');
    expect(employee).toContain('analytics.view.own');

    // Manager is no longer a role at all.
    expect(SYSTEM_ROLE_KINDS).not.toContain('manager' as never);
    expect(Object.keys(SYSTEM_ROLE_PERMISSIONS)).not.toContain('manager');

    // The three roles that compose from the employee grants must NOT inherit approval.
    for (const kind of ['card-administrator', 'ap-clerk', 'executive'] as const) {
      expect(
        SYSTEM_ROLE_PERMISSIONS[kind],
        `${kind} must not inherit approval rights from the fold`,
      ).not.toContain('expense.report.approve');
    }
  });

  it('keeps the retired Manager id out of the live map, and never reuses it', () => {
    // `User.roleId` is a Restrict FK and Audit rows name the role a decision was made
    // under, so the id has to stay knowable — and must never be handed to a new role.
    expect(RETIRED_ROLE_IDS.manager).toBe('019e3000-0000-7000-8000-000000000003');
    expect(Object.values(SYSTEM_ROLE_IDS)).not.toContain(RETIRED_ROLE_IDS.manager);
  });

  it('separates paying a claim from approving it', () => {
    // Segregation of duties: AP pays what a manager authorised. If one role held
    // both, the approval workflow would be decoration for that person.
    expect(SYSTEM_ROLE_PERMISSIONS['ap-clerk']).toContain('expense.report.reimburse');
    expect(SYSTEM_ROLE_PERMISSIONS['ap-clerk']).not.toContain('expense.report.approve');
  });

  it('keeps the approval override to the roles that own the module', () => {
    /**
     * The override used to be a READ permission in disguise: every decide path derived
     * its admin flag from `expense.report.read.all` (or `user.read.all` for cards and
     * travel), so an AP Clerk — who reads every report to work the queue, and pays what a
     * manager authorised — could approve any report and then reimburse it, and a Card
     * Administrator could approve any limit increase and issue against it.
     *
     * Now it is an explicit grant, and this is where its holders are pinned. Expense
     * Administrator owns the expense and travel processes wholesale; the card override is
     * admin-only because approving and issuing must not share a non-admin role.
     */
    expect(holders('expense.report.decide.any')).toEqual(['admin', 'expense-administrator']);
    expect(holders('travel.request.decide.any')).toEqual(['admin', 'expense-administrator']);
    expect(holders('vcc.request.decide.any')).toEqual(['admin']);

    for (const kind of ['ap-clerk', 'card-administrator', 'employee', 'executive'] as const) {
      for (const perm of [
        'expense.report.decide.any',
        'travel.request.decide.any',
        'vcc.request.decide.any',
      ] as const satisfies readonly Permission[]) {
        expect(SYSTEM_ROLE_PERMISSIONS[kind], `${kind} must not hold ${perm}`).not.toContain(perm);
      }
    }
  });

  it('keeps reading every report separate from deciding any of them', () => {
    // The AP Clerk is the proof: it must read everything and override nothing.
    expect(SYSTEM_ROLE_PERMISSIONS['ap-clerk']).toContain('expense.report.read.all');
    expect(SYSTEM_ROLE_PERMISSIONS['ap-clerk']).not.toContain('expense.report.decide.any');
    expect(SYSTEM_ROLE_PERMISSIONS['card-administrator']).toContain('user.read.all');
    expect(SYSTEM_ROLE_PERMISSIONS['card-administrator']).not.toContain('vcc.request.decide.any');
  });

  it('lets the AP Clerk see every card without acting on any', () => {
    /**
     * `vcc.card.read.all` widens what the card list and detail return, and nothing else. AP
     * reconciles card spend company-wide, so it needs every card in view — the same reason
     * it holds `expense.report.read.all`. Card Administrator and admin already saw every
     * card through `vcc.card.issue`; they hold the new code too so the scope has one name.
     *
     * The holder set is exact, the shape of the decide.any pin above: granting it to
     * Employee, Executive or Expense Administrator has to argue for itself here, and the
     * migration that writes it to existing rows names these same three ids.
     */
    expect(holders('vcc.card.read.all')).toEqual(['admin', 'card-administrator', 'ap-clerk']);
    for (const kind of ['expense-administrator', 'employee', 'executive'] as const) {
      expect(SYSTEM_ROLE_PERMISSIONS[kind], `${kind} must not see every card`).not.toContain(
        'vcc.card.read.all',
      );
    }

    // Seeing is not acting. Before this grant only `issue` was pinned off AP; `close` and
    // `reassign` were not, so a later edit could have handed AP either without a test failing.
    const ap = SYSTEM_ROLE_PERMISSIONS['ap-clerk'];
    expect(ap).toContain('vcc.card.read.all');
    for (const perm of [
      'vcc.card.issue',
      'vcc.card.close',
      'vcc.card.reassign',
      'vcc.request.decide.any',
    ] as const satisfies readonly Permission[]) {
      expect(ap, `ap-clerk must not hold ${perm}`).not.toContain(perm);
    }
  });

  it('keeps restating FX apart from the role that pays and posts', () => {
    /**
     * `expense.report.fxOverride` re-stamps every foreign line's home amount and the
     * report total — the figures NetSuite posts. It used to ride on `reimburse`, so the
     * AP Clerk, who also holds `netsuite.sync.push`, could restate a report's amounts and
     * then send it to the ledger alone. Restating is a finance-administration act; the
     * holders are pinned here, and the AP Clerk is the role that must never gain it.
     */
    expect(holders('expense.report.fxOverride')).toEqual(['admin', 'expense-administrator']);
    for (const kind of ['ap-clerk', 'card-administrator', 'employee', 'executive'] as const) {
      expect(SYSTEM_ROLE_PERMISSIONS[kind], `${kind} must not hold fxOverride`).not.toContain(
        'expense.report.fxOverride',
      );
    }
    // AP keeps paying and posting what somebody else authorised — nothing is taken away.
    expect(SYSTEM_ROLE_PERMISSIONS['ap-clerk']).toContain('expense.report.reimburse');
    expect(SYSTEM_ROLE_PERMISSIONS['ap-clerk']).toContain('ledger.sync.push');
  });

  it('lets only the module-owning admins both restate FX and post to NetSuite', () => {
    /**
     * Role shape can separate the two duties everywhere except inside the roles that own
     * the whole module — `admin` and `expense-administrator` spread all of `P.expense`
     * and hold `sync.push` besides. For those two the separation is enforced at runtime
     * instead: `netsuiteSync.approveExpenseReportPosting` refuses the person who set the
     * report's current override. Any OTHER role appearing here would be a new role that
     * pays and decides at once, and has to argue for itself in this test.
     */
    const both = kinds.filter(
      (k) =>
        SYSTEM_ROLE_PERMISSIONS[k].includes('expense.report.fxOverride') &&
        SYSTEM_ROLE_PERMISSIONS[k].includes('ledger.sync.push'),
    );
    expect(both).toEqual(['admin', 'expense-administrator']);
  });

  it('keeps the AP Clerk out of platform configuration', () => {
    // The whole reason it is not just another Expense Administrator.
    const apPerms = SYSTEM_ROLE_PERMISSIONS['ap-clerk'];
    expect(apPerms.filter((p) => p.startsWith('config.'))).toEqual([]);
    expect(apPerms).not.toContain('policy.violation.override');
    expect(apPerms).not.toContain('vcc.card.issue');
  });

  it('keeps the Card Administrator out of platform configuration', () => {
    const cardPerms = SYSTEM_ROLE_PERMISSIONS['card-administrator'];
    expect(cardPerms.filter((p) => p.startsWith('config.'))).toEqual([]);
  });

  it('reserves the NetSuite reference resync for admins', () => {
    // A locked decision: a full reference resync is disruptive, so it stays
    // admin-only however many module-admin roles exist.
    expect(holders('ledger.reference.sync')).toEqual(['admin']);
  });

  it('reserves deleting a NetSuite reference record for admins', () => {
    // Worse than a resync: irreversible. The next sync will not bring the row back,
    // because NetSuite no longer returns it. Admin gets it for free — `collectAdmin()`
    // spreads `...flatten(P.ledger)` — and every other role lists its NetSuite
    // permissions one by one, so no explicit grant is needed or wanted anywhere. Adding
    // one is exactly how this would widen past admin without anybody deciding to.
    expect(holders('ledger.reference.delete')).toEqual(['admin']);
  });

  it('gives every role a way to read its own notifications', () => {
    // Without this the bell is empty for that role and every flow looks broken.
    for (const kind of kinds) {
      expect(SYSTEM_ROLE_PERMISSIONS[kind], kind).toContain('notification.read.own');
    }
  });

  /**
   * Everybody who works here files expenses.
   *
   * `card-administrator` did not have a single one of these, so it got a 404 on
   * `/expenses` — its own expenses — and could not file a report or a travel request at
   * all. It was not a decision: `executive` spreads `collectEmployee()` and `ap-clerk`
   * lists the same permissions with the comment "so they can file expenses like any
   * employee". The role was simply missed, and nothing here noticed, because every test
   * above asks what a role must NOT have.
   *
   * A back-office role that genuinely should not file expenses is a real possibility —
   * but it would be a decision somebody makes, and this test is where they would have to
   * come and make it.
   */
  const EMPLOYEE_BASELINE = [
    'expense.report.read.own',
    'expense.report.create.own',
    'expense.report.update.own',
    'expense.report.submit.own',
    'travel.request.create.own',
    'travel.request.submit.own',
  ] as const;

  it('lets every role file its own expenses and travel', () => {
    for (const kind of kinds) {
      for (const perm of EMPLOYEE_BASELINE) {
        expect(SYSTEM_ROLE_PERMISSIONS[kind], `${kind} is missing ${perm}`).toContain(perm);
      }
    }
  });

  it('states no permission twice', () => {
    /** The collectors compose, and `Role.permissions` is a String[] the seed writes
     *  verbatim — a duplicate is harmless to `includes()` and confusing in the Role
     *  Builder, which renders the list. */
    for (const kind of kinds) {
      const perms = SYSTEM_ROLE_PERMISSIONS[kind];
      expect(new Set(perms).size, kind).toBe(perms.length);
    }
  });
});
