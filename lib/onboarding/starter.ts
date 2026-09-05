/**
 * VX5-4 — what a tenant has the moment it exists.
 *
 * ── THE FAILURE THIS CLOSES ─────────────────────────────────────────────────
 *
 * Measured, not guessed. A tenant created by `createOrganization` was walked
 * through the first thing anybody does with an expense product, and it stopped
 * on the third step:
 *
 *   createReport   OK
 *   addExpense     OK
 *   addLineItem    THREW ExpenseError CATEGORY_NOT_FOUND
 *
 * A line item must name a category, `expense_category` is tenant data, and a new
 * tenant had none — so a customer who had just signed up could not record a
 * single expense. Not a rough edge: the product did not work.
 *
 * ── WHY CATEGORIES AND NOTHING ELSE ─────────────────────────────────────────
 *
 * The same walk turned up other gaps — no approval ladder, no spend policy, no
 * legal entities, no chart of accounts — and none of them is seeded here. The
 * line between the two is whether the product can RUN without it, or whether it
 * is a statement about how somebody's company works:
 *
 *   · A category list is structurally required and is edited on day one anyway.
 *     Seeding six is a starting point, not a claim.
 *   · An approval ladder, a spend limit, a legal entity, a chart of accounts —
 *     each of those is a POLICY. A new tenant quietly acquiring an approval
 *     route or a per-meal limit that somebody at Velotech chose is exactly the
 *     thing a finance team should not discover months later, in an audit.
 *
 * So those are on the setup checklist (`lib/onboarding/setup.ts`), which says
 * what is missing and where to go, and invents nothing.
 *
 * ── WHAT IS SEEDED IS THE TENANT'S DATA, NOT OUR COPY ───────────────────────
 *
 * These labels are English and are not in `lib/i18n/catalog`. That is correct
 * rather than an oversight: from the instant the row is written it is the
 * TENANT'S category, renamed and deleted by them like any other. Cataloguing it
 * would mean a label that changes language under a customer who had renamed it.
 *
 * ── NO GL ACCOUNTS, DELIBERATELY ────────────────────────────────────────────
 *
 * `scripts/seed.mjs` maps its copy of this list to a chart of accounts, because
 * a seeded demo tenant has one. A signed-up tenant does not, so `gl_account`
 * stays null, and nothing breaks: coding is only demanded at submit when the
 * accounting module is ON (UD-2), and a new tenant has no entitlements.
 */
import type { QueryRunner } from '@/lib/db/client';

/**
 * `[code, label, sortOrder]`.
 *
 * Six, chosen to be the ones almost every company has rather than a complete
 * chart — a long list is a list somebody has to prune before they can trust it,
 * and pruning is worse than adding. Codes match `scripts/seed.mjs`'s copy, and
 * `test/onboarding-starter.db.test.ts` asserts they still do: this is the third
 * hand-kept duplicate this codebase has had, and UD-9's was found by a test
 * rather than by anybody noticing.
 */
export const STARTER_CATEGORIES: ReadonlyArray<readonly [string, string, number]> = [
  ['meals', 'Meals & Entertainment', 10],
  ['travel_air', 'Airfare', 20],
  ['travel_lodging', 'Lodging', 30],
  ['ground', 'Ground Transportation', 40],
  ['office', 'Office Supplies', 50],
  ['software', 'Software & Subscriptions', 60],
];

/**
 * Write the starter categories for the CURRENT tenant.
 *
 * Called inside `createOrganization`'s single transaction, after the context has
 * been switched — so these rows are written under `tenant_isolation` like
 * everything else, and a failure takes the organization with it. VX5-1's rule:
 * a tenant that half-exists is worse than one that does not.
 *
 * `ON CONFLICT DO NOTHING` so this is safe to call again on a tenant that
 * already has some of them; it returns how many it actually wrote, which is what
 * the audit entry records.
 */
export async function seedStarterCategories(tx: QueryRunner): Promise<number> {
  const r = await tx.query(
    `INSERT INTO expense_category (organization_id, code, label, sort_order)
     SELECT NULLIF(current_setting('app.current_org', true), '')::uuid, c.code, c.label, c.sort_order
       FROM unnest($1::text[], $2::text[], $3::int[]) AS c(code, label, sort_order)
     ON CONFLICT (organization_id, code) DO NOTHING`,
    [
      STARTER_CATEGORIES.map(([code]) => code),
      STARTER_CATEGORIES.map(([, label]) => label),
      STARTER_CATEGORIES.map(([, , sort]) => sort),
    ],
  );
  return r.rowCount ?? 0;
}
