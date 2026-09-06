/**
 * VX5-11 — the write gate.
 *
 * ── THE SHAPE OF THIS FILE, AND WHY IT ITERATES A LIST ─────────────────────
 *
 * Every gated path is driven from `GATED_ACTIONS`, exported by the gate itself.
 * The failure mode for a gate like this is not a wrong implementation — it is a
 * write path nobody remembered to cover. Iterating the list does not prevent that
 * (nothing at this layer can), but it means the gated set is stated once and
 * asserted once, rather than five assertions that can drift apart.
 *
 * The three cases that matter most are stated separately anyway, because each is
 * a decision a future reader is likely to reverse: PAST_DUE writes, a tenant with
 * NO subscription writes, and a recall is never gated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { mirrorEntitlement } from '@/lib/billing/service';
import {
  GATED_ACTIONS,
  BillingLapsedError,
  assertTenantMayWrite,
  type GatedAction,
} from '@/lib/billing/gate';
import type { SubscriptionStatus } from '@/lib/billing/plans';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

/**
 * A tenant whose MIRROR says `status`, or `null` for one the platform has never
 * told us about — which after 0039 is the normal state, since this product no
 * longer starts its own trials.
 *
 * The mirror is written through `mirrorEntitlement` rather than by raw SQL so the
 * fixture goes down the same path production does. `readOnly` is left null on
 * purpose: these cases exercise the FALLBACK rule (`canWrite`), and the platform's
 * own verdict is tested separately in `billing.db.test.ts`.
 */
async function orgWithStatus(slug: string, status: SubscriptionStatus | null): Promise<string> {
  const r = await admin.query(
    'INSERT INTO organization (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  const id = r.rows[0].id as string;
  if (status === null) return id;

  const PLATFORM: Record<SubscriptionStatus, string> = {
    TRIALING: 'trialing',
    ACTIVE: 'active',
    PAST_DUE: 'past_due',
    CANCELLED: 'canceled',
    SUSPENDED: 'suspended',
    // The platform has no LAPSED; it is ours, for a trial that ran out or dunning
    // that gave up. Written directly, which is the one place this fixture cannot
    // go through the mirror — and saying so beats a silent divergence.
    LAPSED: '',
  };
  if (status === 'LAPSED') {
    await withOrg(id, (tx) =>
      tx.query(
        `INSERT INTO subscription (organization_id, plan_code, status, mirrored_at)
         VALUES ($1, 'team', 'LAPSED', clock_timestamp())`,
        [id],
      ),
    );
    return id;
  }
  await withOrg(id, (tx) =>
    mirrorEntitlement(tx, {
      state: 'ok',
      entitlement: {
        accountId: 'acc-1',
        product: 'veloexpense',
        hasSubscription: true,
        status: PLATFORM[status],
        planName: 'Team',
        planSlug: 'team',
        features: {},
        limits: {},
        billingCycle: 'month',
        inTrial: status === 'TRIALING',
        trialEndsAt: null,
        currentPeriodEnd: null,
        readOnly: false,
      },
    }),
  );
  // The platform's verdict is deliberately cleared so these cases exercise the
  // fallback rule rather than the verdict, which has its own tests.
  await withOrg(id, (tx) => tx.query('UPDATE subscription SET read_only = NULL'));
  return id;
}

beforeAll(async () => {
  await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await admin.end();
});

describe('every gated action, against every status', () => {
  const permitted: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE'];
  const refused: SubscriptionStatus[] = ['LAPSED', 'CANCELLED', 'SUSPENDED'];

  for (const status of permitted) {
    it(`${status} permits all ${GATED_ACTIONS.length} gated actions`, async () => {
      const org = await orgWithStatus(`gate-ok-${status.toLowerCase().replace('_', '-')}`, status);
      for (const action of GATED_ACTIONS) {
        await expect(
          withOrg(org, (tx) => assertTenantMayWrite(tx, action)),
        ).resolves.toBeUndefined();
      }
    });
  }

  for (const status of refused) {
    it(`${status} refuses all ${GATED_ACTIONS.length}, and names the action`, async () => {
      const org = await orgWithStatus(`gate-no-${status.toLowerCase().replace('_', '-')}`, status);
      for (const action of GATED_ACTIONS) {
        const err = await withOrg(org, (tx) => assertTenantMayWrite(tx, action)).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(BillingLapsedError);
        // The action is on the error, so a log line says WHICH refusal happened
        // rather than only that one did.
        expect((err as BillingLapsedError).action).toBe(action);
        // And it carries reader copy, so this reaches a person as a sentence
        // rather than as "something went wrong on our side".
        expect((err as BillingLapsedError).userMessage?.code).toBe('BILLING_LAPSED');
      }
    });
  }
});

describe('the three entries most likely to be reversed later', () => {
  it('PAST_DUE writes — a card that failed on Friday does not stop Monday', async () => {
    const org = await orgWithStatus('gate-pastdue', 'PAST_DUE');
    await expect(
      withOrg(org, (tx) => assertTenantMayWrite(tx, 'decide an approval')),
    ).resolves.toBeUndefined();
  });

  it('NO subscription writes — absence is not lapse', async () => {
    // After 0039 this is MOST tenants: the platform starts trials, and a tenant
    // that came through VeloExpense's own signup may have no platform Account at
    // all. The other answer takes the whole customer base offline on deploy.
    const org = await orgWithStatus('gate-legacy', null);
    await expect(
      withOrg(org, (tx) => assertTenantMayWrite(tx, 'submit a report')),
    ).resolves.toBeUndefined();
  });

  it('the gated list is exactly the five write paths, stated once', () => {
    // A change to this list is a change to what a lapsed customer can do, so it
    // should be a visible line in a diff rather than an incidental edit.
    expect([...GATED_ACTIONS]).toEqual([
      'submit a report',
      'decide an approval',
      'mark a report reimbursed',
      'release a held post',
      'retry a failed post',
    ] satisfies GatedAction[]);
  });
});
