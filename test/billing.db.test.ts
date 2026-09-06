/**
 * VX5-19 — the subscription mirror.
 *
 * Replaces VX5-8's suite, most of which tested a plan catalogue that migration
 * 0039 deleted. What is left is the part that was always this product's business:
 * copying the platform's answer without editorialising, and refusing to write
 * anything when there is no answer to copy.
 *
 * ── THE ASSERTION THIS FILE IS REALLY ABOUT ────────────────────────────────
 *
 * A platform OUTAGE must not stop a paying customer working. Every `skipped` case
 * below is a different route to that same claim: a mirror that already says
 * ACTIVE keeps saying ACTIVE when the platform cannot be reached, because writing
 * a refusal on an error is how a billing integration becomes a single point of
 * failure with an invoice attached.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { createOrganization } from '@/lib/onboarding/provision';
import {
  effectiveStatus,
  liveSubscription,
  mirrorEntitlement,
  tenantMayWrite,
} from '@/lib/billing/service';
import type { EntitlementResult, PlatformEntitlement } from '@/lib/billing/entitlements';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

/** A platform entitlement, with the shape the platform actually returns. */
function entitlement(over: Partial<PlatformEntitlement> = {}): EntitlementResult {
  return {
    state: 'ok',
    entitlement: {
      accountId: 'acc-1',
      product: 'veloexpense',
      hasSubscription: true,
      status: 'active',
      planName: 'Team',
      planSlug: 'team',
      features: {},
      limits: {},
      billingCycle: 'month',
      inTrial: false,
      trialEndsAt: null,
      currentPeriodEnd: null,
      readOnly: false,
      ...over,
    },
  };
}

async function newOrg(slug: string): Promise<string> {
  const r = await admin.query(
    'INSERT INTO organization (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await admin.end();
});

describe('mirroring what the platform said', () => {
  it('copies plan, status, trial and the platform’s own readOnly verdict', async () => {
    const org = await newOrg('mir-basic');
    const ends = '2026-10-01T00:00:00.000Z';

    const out = await withOrg(org, (tx) =>
      mirrorEntitlement(
        tx,
        entitlement({ status: 'trialing', inTrial: true, trialEndsAt: ends, readOnly: false }),
      ),
    );
    expect(out.state).toBe('written');

    const sub = await withOrg(org, (tx) => liveSubscription(tx));
    expect(sub?.status).toBe('TRIALING');
    expect(sub?.planCode).toBe('team');
    expect(sub?.planName).toBe('Team');
    expect(sub?.readOnly).toBe(false);
    expect(sub?.trialEndsAt?.toISOString()).toBe(ends);
    // The age of the answer, not just the answer.
    expect(sub?.mirroredAt).toBeInstanceOf(Date);
  });

  it('maps the platform’s vocabulary onto ours, including its one-L "canceled"', async () => {
    for (const [platform, ours] of [
      ['active', 'ACTIVE'],
      ['trialing', 'TRIALING'],
      ['past_due', 'PAST_DUE'],
      ['suspended', 'SUSPENDED'],
    ] as const) {
      const org = await newOrg(`mir-map-${platform.replace('_', '-')}`);
      await withOrg(org, (tx) =>
        mirrorEntitlement(tx, entitlement({ status: platform, trialEndsAt: null })),
      );
      expect((await withOrg(org, (tx) => liveSubscription(tx)))?.status).toBe(ours);
    }

    // `canceled` is the platform's spelling and Stripe's; ours is CANCELLED.
    // A silent no-match here would leave a departed customer writing.
    const org = await newOrg('mir-map-canceled');
    await withOrg(org, (tx) => mirrorEntitlement(tx, entitlement({ status: 'canceled' })));
    expect(await withOrg(org, (tx) => effectiveStatus(tx))).toBe('CANCELLED');
  });

  it('updates the same row rather than accumulating one per answer', async () => {
    const org = await newOrg('mir-update');
    await withOrg(org, (tx) => mirrorEntitlement(tx, entitlement({ status: 'trialing', trialEndsAt: '2026-10-01T00:00:00.000Z' })));
    await withOrg(org, (tx) => mirrorEntitlement(tx, entitlement({ status: 'active', planSlug: 'scale', planName: 'Scale' })));

    const rows = await withOrg(org, (tx) =>
      tx.query('SELECT status, plan_code FROM subscription'),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('ACTIVE');
    expect(rows.rows[0].plan_code).toBe('scale');
  });
});

describe('what is deliberately NOT mirrored', () => {
  it('an ERROR writes nothing and leaves a good mirror alone — the outage case', async () => {
    const org = await newOrg('mir-error');
    await withOrg(org, (tx) => mirrorEntitlement(tx, entitlement({ status: 'active' })));

    const out = await withOrg(org, (tx) =>
      mirrorEntitlement(tx, { state: 'error', message: 'platform request failed' }),
    );

    expect(out).toEqual({ state: 'skipped', reason: 'error' });
    // THE CLAIM THIS FILE EXISTS FOR: the platform being down does not stop a
    // paying customer working.
    expect((await withOrg(org, (tx) => liveSubscription(tx)))?.status).toBe('ACTIVE');
    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(true);
  });

  it('DISABLED writes nothing — an unconfigured deployment is not a billed one', async () => {
    const org = await newOrg('mir-disabled');
    const out = await withOrg(org, (tx) => mirrorEntitlement(tx, { state: 'disabled' }));

    expect(out).toEqual({ state: 'skipped', reason: 'disabled' });
    expect(await withOrg(org, (tx) => liveSubscription(tx))).toBeNull();
    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(true);
  });

  it('NOT_FOUND writes nothing — a tenant from our own signup is a real case', async () => {
    const org = await newOrg('mir-notfound');
    const out = await withOrg(org, (tx) => mirrorEntitlement(tx, { state: 'not_found' }));

    expect(out).toEqual({ state: 'skipped', reason: 'not_found' });
    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(true);
  });

  it('an account with no subscription writes nothing', async () => {
    const org = await newOrg('mir-nosub');
    const out = await withOrg(org, (tx) =>
      mirrorEntitlement(tx, entitlement({ hasSubscription: false, status: null })),
    );
    expect(out.state).toBe('skipped');
    expect(await withOrg(org, (tx) => liveSubscription(tx))).toBeNull();
  });

  it('an UNRECOGNISED status is skipped rather than guessed at', async () => {
    // A platform that adds a sixth status must make this product fall back to
    // permitting, not silently map it onto the nearest refusal.
    const org = await newOrg('mir-unknown');
    const out = await withOrg(org, (tx) =>
      mirrorEntitlement(tx, entitlement({ status: 'dormant' })),
    );

    expect(out.state).toBe('skipped');
    expect(out.reason).toMatch(/unrecognised platform status "dormant"/);
    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(true);
  });
});

describe('who may write', () => {
  it('the platform’s readOnly WINS over anything derived from the status', async () => {
    // The whole point of consuming a verdict instead of deriving one: a customer
    // who is read-only in VeloLedger and writable here is a support call nobody
    // can explain. PAST_DUE would be writable by our own rule; the platform says
    // otherwise, and the platform is the one that bills them.
    const org = await newOrg('write-verdict');
    await withOrg(org, (tx) =>
      mirrorEntitlement(tx, entitlement({ status: 'past_due', readOnly: true })),
    );
    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(false);
  });

  it('and the reverse — a status we would refuse, that the platform permits', async () => {
    const org = await newOrg('write-verdict-open');
    await withOrg(org, (tx) =>
      mirrorEntitlement(tx, entitlement({ status: 'suspended', readOnly: false })),
    );
    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(true);
  });

  it('falls back to our own rule when the platform sent no verdict', async () => {
    const org = await newOrg('write-fallback');
    await withOrg(org, (tx) => mirrorEntitlement(tx, entitlement({ status: 'active' })));
    await withOrg(org, (tx) => tx.query('UPDATE subscription SET read_only = NULL'));

    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(true);
  });

  it('a CANCELLED tenant may not write, and that was a live bug', async () => {
    // `liveSubscription` excludes CANCELLED, so `tenantMayWrite` used to fall
    // through to the no-subscription branch and permit everything. Caught by the
    // gate's own test in #114; the two absences it separates are easy to re-merge.
    const org = await newOrg('write-cancelled');
    await withOrg(org, (tx) => mirrorEntitlement(tx, entitlement({ status: 'canceled' })));

    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(false);
  });

  it('a tenant with NO mirror may write — which after 0039 is most of them', async () => {
    const org = await newOrg('write-unmirrored');
    expect(await withOrg(org, (tx) => tenantMayWrite(tx))).toBe(true);
  });
});

describe('a tenant provisioned through our own signup', () => {
  it('gets NO subscription, because this product no longer starts trials', async () => {
    const created = await createOrganization({
      name: 'Provisioned Inc',
      slug: 'provisioned',
      adminEmail: 'founder@provisioned.test',
      adminName: 'A Founder',
    });

    // VX5-8 started a trial here. The platform owns that now, and a tenant the
    // operator console never provisioned legitimately has no Account at all.
    const sub = await withOrg(created.organizationId, (tx) => liveSubscription(tx));
    expect(sub).toBeNull();

    // And it works normally, which is the property that stops this deploy taking
    // the existing customer base offline.
    expect(await withOrg(created.organizationId, (tx) => tenantMayWrite(tx))).toBe(true);
  });

  it('and the genesis audit row no longer claims a plan it did not choose', async () => {
    const org = await admin.query("SELECT id FROM organization WHERE slug = 'provisioned'");
    const entry = await withOrg(org.rows[0].id as string, (tx) =>
      tx.query(
        `SELECT details FROM audit_entry
          WHERE action = 'ORGANIZATION_CREATED' ORDER BY sequence LIMIT 1`,
      ),
    );
    const details = entry.rows[0].details as Record<string, unknown>;
    expect(details.plan_code).toBeUndefined();
    expect(details.trial_ends_at).toBeUndefined();
    // What it does still record is what this product actually did.
    expect(details.seeded_categories).toBe(6);
  });
});
