/**
 * VX5-8 — the subscription schema and the plan catalogue.
 *
 * The pure rules are in `test/billing-plans.test.ts`, which needs no database.
 * This file is for the claims only a real Postgres can make: the CHECK
 * constraints, the partial unique index, and `startTrial` landing inside
 * `createOrganization`'s transaction.
 *
 * ── ONE THING THIS FILE IS CAREFUL ABOUT ────────────────────────────────────
 *
 * Several assertions below are that the DATABASE refuses something. Each is
 * written against the constraint's effect, not its name — `rejects.toThrow(/check
 * constraint/i)` rather than matching `subscription_trial_has_end`. A test that
 * names a constraint passes for the wrong reason the day somebody renames it and
 * fails for the wrong reason the day somebody adds a second one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { type QueryRunner } from '@/lib/db/client';
import { createOrganization } from '@/lib/onboarding/provision';
import {
  listPlans,
  liveSubscription,
  startTrial,
  tenantMayWrite,
  DEFAULT_PLAN_CODE,
} from '@/lib/billing/service';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;

/**
 * A `QueryRunner` over the admin pool, for the catalogue reads only.
 *
 * Deliberately not `withOrg`: the point of those two cases is that `billing_plan`
 * needs NO tenant context, and running them inside one would prove the opposite of
 * what they claim. Typed rather than an inline object literal because
 * `QueryRunner`'s `query` is generic and an arrow shorthand loses that.
 */
const adminRunner: QueryRunner = {
  query: ((text: string, params?: unknown[]) => admin.query(text, params)) as QueryRunner['query'],
};

beforeAll(async () => {
  await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
  const r = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('bill-co','Bill Co') RETURNING id",
  );
  orgId = r.rows[0].id as string;
});

afterAll(async () => {
  await admin.end();
});

describe('the plan catalogue', () => {
  it('is readable with no tenant context at all — it is global reference data', async () => {
    // Not `withOrg`. `billing_plan` has no `organization_id`, so it carries no
    // policy, exactly like `currency`. A tenant that cannot read the catalogue
    // cannot be shown what it is paying for.
    const plans = await listPlans(adminRunner);

    expect(plans.map((p) => p.code)).toEqual(['STARTER', 'TEAM', 'SCALE']);
    expect(plans.every((p) => p.currencyCode === 'CAD')).toBe(true);
  });

  it('carries components, and money comes back as bigint rather than Number', async () => {
    const plans = await listPlans(adminRunner);
    const team = plans.find((p) => p.code === 'TEAM');

    expect(team).toBeDefined();
    // Base fee plus per seat — the shape a single `meter` column could not express,
    // which is why the component table exists.
    expect(team!.components.map((c) => c.meter).sort()).toEqual(['SEAT', 'TENANT']);

    const seat = team!.components.find((c) => c.meter === 'SEAT')!;
    expect(typeof seat.unitAmountMinor).toBe('bigint');
    expect(seat.unitAmountMinor).toBe(900n);
    expect(seat.includedUnits).toBe(10);
  });

  it('refuses to attach a CARD component, because nothing here can count a card', async () => {
    // The constraint that keeps a meter expressible without being billable. Drop
    // it in the migration that lands VCC — until then this is what stops an
    // invoice line that is always zero, which reads exactly like a customer who
    // owes nothing.
    await expect(
      admin.query(
        `INSERT INTO billing_plan_component (plan_code, meter, unit_amount_minor)
         VALUES ('TEAM', 'CARD', 500)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('refuses a meter outside the vocabulary', async () => {
    await expect(
      admin.query(
        `INSERT INTO billing_plan_component (plan_code, meter, unit_amount_minor)
         VALUES ('TEAM', 'MILEAGE', 500)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe('starting a trial', () => {
  it('creates a TRIALING subscription with an end date from the plan', async () => {
    const started = await withOrg(orgId, (tx) => startTrial(tx));

    expect(started.planCode).toBe(DEFAULT_PLAN_CODE);
    expect(started.status).toBe('TRIALING');
    expect(started.trialEndsAt).toBeInstanceOf(Date);

    // 30 days, from `billing_plan.trial_days` rather than from a constant in the
    // service — the assertion is deliberately loose at the edges because
    // `clock_timestamp()` and a DST boundary are not worth a flaky test.
    const days = (started.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('is visible only inside its own tenant', async () => {
    const other = await admin.query(
      "INSERT INTO organization (slug, name) VALUES ('bill-other','Other') RETURNING id",
    );
    const otherId = other.rows[0].id as string;

    const mine = await withOrg(orgId, (tx) => liveSubscription(tx));
    const theirs = await withOrg(otherId, (tx) => liveSubscription(tx));

    expect(mine?.planCode).toBe('STARTER');
    expect(theirs).toBeNull();
  });

  it('refuses a second live subscription for the same tenant', async () => {
    // The partial unique index, not a check in application code. Two live
    // subscriptions is the state that would make every later question — which
    // plan, which period, how much — ambiguous.
    await expect(withOrg(orgId, (tx) => startTrial(tx))).rejects.toThrow(/duplicate key|unique/i);
  });

  it('refuses a plan that does not exist, by name', async () => {
    const other = await admin.query(
      "INSERT INTO organization (slug, name) VALUES ('bill-noplan','No Plan') RETURNING id",
    );
    await expect(
      withOrg(other.rows[0].id as string, (tx) => startTrial(tx, { planCode: 'NOPE' })),
    ).rejects.toThrow(/no active plan 'NOPE'/);
  });

  it('refuses an INACTIVE plan too — a withdrawn price is not for sale', async () => {
    await admin.query("UPDATE billing_plan SET active = false WHERE code = 'SCALE'");
    const other = await admin.query(
      "INSERT INTO organization (slug, name) VALUES ('bill-retired','Retired') RETURNING id",
    );
    try {
      await expect(
        withOrg(other.rows[0].id as string, (tx) => startTrial(tx, { planCode: 'SCALE' })),
      ).rejects.toThrow(/no active plan 'SCALE'/);
    } finally {
      await admin.query("UPDATE billing_plan SET active = true WHERE code = 'SCALE'");
    }
  });
});

describe('the constraints that make an impossible row impossible', () => {
  it('refuses TRIALING with no trial end, and a trial end on anything else', async () => {
    const org = (
      await admin.query(
        "INSERT INTO organization (slug, name) VALUES ('bill-checks','Checks') RETURNING id",
      )
    ).rows[0].id as string;

    // TRIALING must say when the trial ends.
    await expect(
      admin.query(
        `INSERT INTO subscription (organization_id, plan_code, status)
         VALUES ($1, 'STARTER', 'TRIALING')`,
        [org],
      ),
    ).rejects.toThrow(/check constraint/i);

    // And an ACTIVE row may not carry one — two claims about the same tenant,
    // where whichever code reads it first would have to pick.
    await expect(
      admin.query(
        `INSERT INTO subscription (organization_id, plan_code, status, trial_ends_at)
         VALUES ($1, 'STARTER', 'ACTIVE', clock_timestamp() + interval '30 days')`,
        [org],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('refuses half a provider linkage', async () => {
    const org = (
      await admin.query(
        "INSERT INTO organization (slug, name) VALUES ('bill-provider','Provider') RETURNING id",
      )
    ).rows[0].id as string;

    // A provider with no customer reference is a row a reconciliation job would
    // have to guess about. All three or none.
    await expect(
      admin.query(
        `INSERT INTO subscription (organization_id, plan_code, status, provider)
         VALUES ($1, 'STARTER', 'ACTIVE', 'some-provider')`,
        [org],
      ),
    ).rejects.toThrow(/check constraint/i);

    // All three is fine.
    await expect(
      admin.query(
        `INSERT INTO subscription
           (organization_id, plan_code, status, provider, provider_customer_ref,
            provider_subscription_ref)
         VALUES ($1, 'STARTER', 'ACTIVE', 'some-provider', 'cus_x', 'sub_x')`,
        [org],
      ),
    ).resolves.toBeDefined();
  });

  it('a cancelled row does not block a new subscription, and is kept', async () => {
    const org = (
      await admin.query(
        "INSERT INTO organization (slug, name) VALUES ('bill-again','Again') RETURNING id",
      )
    ).rows[0].id as string;

    await withOrg(org, (tx) => startTrial(tx));
    await withOrg(org, (tx) =>
      tx.query(
        `UPDATE subscription SET status = 'CANCELLED', cancelled_at = clock_timestamp(),
                                 trial_ends_at = NULL`,
      ),
    );

    // The customer comes back. The partial index is what allows this; a plain
    // UNIQUE would have made returning impossible without deleting the record of
    // what they used to pay.
    const again = await withOrg(org, (tx) => startTrial(tx, { planCode: 'TEAM' }));
    expect(again.status).toBe('TRIALING');

    const rows = await withOrg(org, (tx) =>
      tx.query('SELECT status FROM subscription ORDER BY created_at'),
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['CANCELLED', 'TRIALING']);

    // And `liveSubscription` sees only the live one.
    const live = await withOrg(org, (tx) => liveSubscription(tx));
    expect(live?.planCode).toBe('TEAM');
  });
});

describe('a tenant provisioned end to end', () => {
  it('createOrganization starts the trial in the same transaction', async () => {
    const created = await createOrganization({
      name: 'Provisioned Inc',
      slug: 'provisioned',
      adminEmail: 'founder@provisioned.test',
      adminName: 'A Founder',
    });

    const sub = await withOrg(created.organizationId, (tx) => liveSubscription(tx));

    // The claim that matters: a customer who has just signed up is billable. Not
    // "a follow-up job will get to it" — there is no window in which a tenant
    // exists and no sweep would ever find it.
    expect(sub).not.toBeNull();
    expect(sub!.status).toBe('TRIALING');
    expect(sub!.planCode).toBe(DEFAULT_PLAN_CODE);
    // Nobody is paying yet, so there is no provider record anywhere. Null rather
    // than an empty string, so "not yet" and "none" are not the same value.
    expect(sub!.provider).toBeNull();
  });

  it('and the genesis audit row records the plan and the trial end', async () => {
    const org = await admin.query("SELECT id FROM organization WHERE slug = 'provisioned'");
    const orgId2 = org.rows[0].id as string;

    const entry = await withOrg(orgId2, (tx) =>
      tx.query(
        `SELECT details FROM audit_entry
          WHERE action = 'ORGANIZATION_CREATED' ORDER BY sequence LIMIT 1`,
      ),
    );

    const details = entry.rows[0].details as Record<string, unknown>;
    expect(details.plan_code).toBe(DEFAULT_PLAN_CODE);
    // "When did this customer's clock start" is answered by the row that says
    // where everything else came from, rather than by a separate event.
    expect(typeof details.trial_ends_at).toBe('string');
  });

  it('a trialing tenant may write; there is no gate yet, but the answer is right', async () => {
    const org = await admin.query("SELECT id FROM organization WHERE slug = 'provisioned'");
    const mayWrite = await withOrg(org.rows[0].id as string, (tx) => tenantMayWrite(tx));
    expect(mayWrite).toBe(true);
  });

  it('a tenant with NO subscription may write — absence is not lapse', async () => {
    // Every tenant created before 0037 is in this state. Answering "no" here
    // would take every existing customer offline on the deploy that ships the
    // write gate, which is why `canWriteWithoutSubscription` is a named decision
    // rather than a `?? false`.
    const org = (
      await admin.query(
        "INSERT INTO organization (slug, name) VALUES ('bill-legacy','Legacy') RETURNING id",
      )
    ).rows[0].id as string;

    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(true);
  });

  it('a LAPSED tenant may not write', async () => {
    const org = (
      await admin.query(
        "INSERT INTO organization (slug, name) VALUES ('bill-lapsed','Lapsed') RETURNING id",
      )
    ).rows[0].id as string;
    await withOrg(org, (tx) => startTrial(tx));
    await withOrg(org, (tx) =>
      tx.query("UPDATE subscription SET status = 'LAPSED', trial_ends_at = NULL"),
    );

    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(false);
  });

  it('a PAST_DUE tenant MAY write, and this is the entry most likely to be "fixed"', async () => {
    // A card that expired on a Friday is not a reason to stop a finance team
    // working on Monday. The provider's dunning escalates to LAPSED, and that is
    // where function stops.
    const org = (
      await admin.query(
        "INSERT INTO organization (slug, name) VALUES ('bill-pastdue','Past Due') RETURNING id",
      )
    ).rows[0].id as string;
    await withOrg(org, (tx) => startTrial(tx));
    await withOrg(org, (tx) =>
      tx.query("UPDATE subscription SET status = 'PAST_DUE', trial_ends_at = NULL"),
    );

    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(true);
  });
});
