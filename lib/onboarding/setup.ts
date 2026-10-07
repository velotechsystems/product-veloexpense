/**
 * VX5-4 — what a new tenant still has to decide, and who has to decide it.
 *
 * ── WHY A CHECKLIST RATHER THAN MORE SEEDING ────────────────────────────────
 *
 * `lib/onboarding/starter.ts` seeds the one thing the product cannot run
 * without. Everything here is the other kind: an approval route, a spend limit,
 * a legal entity, a chart of accounts. Each is a statement about how somebody's
 * company works, and a new tenant quietly acquiring one that Velotech chose is
 * what a finance team should not find out about in an audit.
 *
 * So the product says what is missing and where to go, and invents nothing.
 *
 * ── NO ENGLISH IN THIS FILE, AND THAT IS THE POINT ──────────────────────────
 *
 * Every item is a KEY and a set of facts — counts, booleans. The sentences live
 * on the page. This is the same split `lib/policy` made for violations (IL-11):
 * a module that returns a rendered sentence has decided who is reading it, and
 * this one is read by an admin on a screen, by nobody in a test, and — when
 * VX4-10 catalogues the admin surface — in whatever language they chose.
 *
 * ── THE ONE THAT IS NOT OPTIONAL ────────────────────────────────────────────
 *
 * `APPROVER`. A founder alone in their tenant CANNOT SUBMIT AN EXPENSE: they
 * are the only active administrator, so step 1 of any run has no eligible
 * approver, and `allow_sole_approver_self_approval` is false by default.
 *
 * That default stays. Segregation of duties is the right answer for an expense
 * product, and `0013`'s header already argues it for reimbursement. What was
 * missing was anybody TELLING the founder — the wall they hit said
 * "the submitter is the tenant's only active administrator", which is accurate
 * and arrives at the worst possible moment. Now it is the first item on the
 * list, before they have written anything.
 */
import type { QueryRunner } from '@/lib/db/client';

/**
 * The items, in the order somebody should do them.
 *
 * A runtime array so the type derives from it rather than the other way round —
 * the house pattern (`POST_STATUSES`, `VERDICTS`, `AUDIT_ACTIONS`). Adding an
 * item here without giving the page a sentence for it is a compile error, which
 * is IL-7's rule: a guard that restates the list it polices is a guard that
 * stops matching it.
 */
export const SETUP_ITEMS = [
  /** Somebody other than the founder who can approve. Blocks submitting. */
  'APPROVER',
  /** Expense categories. Seeded at creation, so this is normally already done —
   *  listed anyway, because a founder should be told the six exist and are
   *  theirs to rename rather than discovering them in a picker. */
  'CATEGORIES',
  /** An approval ladder. Without one, routing falls back to the manager chain. */
  'APPROVAL_LADDER',
  /** At least one spend rule, so a submitted report is checked against something. */
  'SPEND_POLICY',
  /** Legal entities, business units, departments — the org chart the reporting
   *  line and the analytics screens are cut by. */
  'STRUCTURE',
  /** The tenant's name and colour on what its people see. */
  'BRANDING',
] as const;

export type SetupItem = (typeof SETUP_ITEMS)[number];

export interface SetupState {
  item: SetupItem;
  done: boolean;
  /** What the count is OF depends on the item; the page decides whether to show
   *  it. Zero and `done: false` are not redundant — `BRANDING` has no count. */
  count: number | null;
}

export interface SetupStatus {
  items: SetupState[];
  /** True when nothing is outstanding. The page hides the whole panel then —
   *  a checklist that stays on screen after it is finished is furniture. */
  complete: boolean;
  /** How many people are in the tenant, founder included. Shown next to
   *  `APPROVER` because "you are the only one here" is the useful phrasing. */
  memberCount: number;
}

/**
 * Read the whole checklist in one round trip.
 *
 * Runs inside a tenant. Every count is a plain `count(*)` under
 * `tenant_isolation`, so none of it can see another organization — worth saying
 * because a "how set up are you" query is exactly the shape that grows a
 * cross-tenant comparison later.
 */
export async function setupStatus(tx: QueryRunner): Promise<SetupStatus> {
  const r = await tx.query(
    `SELECT
       (SELECT count(*) FROM app_user WHERE deleted_at IS NULL)                       AS members,
       (SELECT count(*) FROM app_user
         WHERE deleted_at IS NULL AND role IN ('ADMIN', 'MANAGER'))                   AS approvers,
       (SELECT count(*) FROM expense_category WHERE active)                           AS categories,
       (SELECT count(*) FROM approval_policy)                                         AS ladders,
       (SELECT count(*) FROM expense_policy)                                          AS policies,
       (SELECT count(*) FROM legal_entity)
        + (SELECT count(*) FROM business_unit)
        + (SELECT count(*) FROM department)                                           AS structure,
       (SELECT count(*) FROM organization
         WHERE brand_color IS NOT NULL OR logo_mime IS NOT NULL)                      AS branded`,
  );
  const n = (key: string) => Number((r.rows[0] as Record<string, string>)[key]);

  const members = n('members');
  const items: SetupState[] = [
    // TWO or more people who can approve — not "an approver exists". The founder
    // IS an admin, so a count of one is satisfied by the person who cannot
    // approve their own report, which is the whole problem this item names.
    { item: 'APPROVER', done: n('approvers') >= 2, count: n('approvers') },
    { item: 'CATEGORIES', done: n('categories') > 0, count: n('categories') },
    { item: 'APPROVAL_LADDER', done: n('ladders') > 0, count: n('ladders') },
    { item: 'SPEND_POLICY', done: n('policies') > 0, count: n('policies') },
    { item: 'STRUCTURE', done: n('structure') > 0, count: n('structure') },
    { item: 'BRANDING', done: n('branded') > 0, count: null },
  ];
  return {
    items,
    complete: items.every((i) => i.done),
    memberCount: members,
  };
}

/**
 * Whether THIS admin has collapsed the checklist to one line (migration 0043).
 *
 * A per-person display choice, so no audit row: it changes what one reader sees,
 * not what the organization has decided. RLS scopes the row to the tenant; the
 * id scopes it to the person.
 */
export async function isSetupCollapsed(tx: QueryRunner, userId: string): Promise<boolean> {
  const r = await tx.query<{ c: boolean }>(
    'SELECT setup_checklist_collapsed AS c FROM app_user WHERE id = $1',
    [userId],
  );
  return r.rows[0]?.c === true;
}

export async function setSetupCollapsed(tx: QueryRunner, userId: string, collapsed: boolean): Promise<void> {
  await tx.query(
    'UPDATE app_user SET setup_checklist_collapsed = $2, updated_at = now() WHERE id = $1',
    [userId, collapsed],
  );
}
