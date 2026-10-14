/**
 * VX5-9 — metering.
 *
 * The claim under test is not "the SQL counts rows". It is the PROPERTY John's
 * decision names: a tenant is billed for exactly the people who can sign in. So
 * the seat tests below change access and then assert the count follows, rather
 * than asserting a number against a fixture — a test that counts four because the
 * fixture made four proves only that `count(*)` works.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import {
  canCount,
  countFor,
  meterAllTenants,
  monthOf,
  recordReadings,
  type Period,
} from '@/lib/billing/metering';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

const SEPTEMBER: Period = {
  start: new Date(Date.UTC(2026, 8, 1)),
  end: new Date(Date.UTC(2026, 9, 1)),
};

/**
 * A tenant, with no subscription — which after 0039 is the normal state. This
 * product no longer starts trials; the platform does, and metering deliberately
 * does not wait for it (see `recordReadings`: a seat count is only true at the
 * moment it is taken, so a tenant skipped this month has a hole nothing can fill).
 */
async function newOrg(slug: string): Promise<string> {
  const r = await admin.query(
    'INSERT INTO organization (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  return r.rows[0].id as string;
}

async function addUser(orgId: string, email: string): Promise<string> {
  const r = await withOrg(orgId, (tx) =>
    tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1, $2, $2, '019e3000-0000-7000-8000-000000000004') RETURNING id`,
      [orgId, email],
    ),
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await admin.end();
});

describe('what can be counted', () => {
  it('SEAT and TENANT can; CARD cannot', () => {
    expect(canCount('SEAT')).toBe(true);
    expect(canCount('TENANT')).toBe(true);
    expect(canCount('CARD')).toBe(false);
  });

  it('asking for an uncountable meter THROWS rather than answering zero', async () => {
    const org = await newOrg('meter-throws');
    // The single most important assertion in this file. A CARD counter returning
    // 0 would be indistinguishable from a tenant that genuinely owes nothing, so
    // the failure would be invisible on every invoice AND in every test. The
    // error names the reason so nobody "fixes" it by adding `?? 0n`.
    await expect(withOrg(org, (tx) => countFor(tx, 'CARD'))).rejects.toThrow(
      /no counter for meter 'CARD'/,
    );
  });
});

describe('a seat is anybody who can sign in', () => {
  it('counts non-deleted users, and the count follows access rather than headcount', async () => {
    const org = await newOrg('meter-seats');

    expect(await withOrg(org, (tx) => countFor(tx, 'SEAT'))).toBe(0n);

    const a = await addUser(org, 'a@meter.test');
    await addUser(org, 'b@meter.test');
    expect(await withOrg(org, (tx) => countFor(tx, 'SEAT'))).toBe(2n);

    // THE PROPERTY, not the SQL: deactivation is what stops the login
    // (`resolveSsoUser` checks `deleted_at`), so it must be what stops the charge.
    // A tenant can never be billed for somebody who cannot get in.
    await withOrg(org, (tx) =>
      tx.query('UPDATE app_user SET deleted_at = clock_timestamp() WHERE id = $1', [a]),
    );
    expect(await withOrg(org, (tx) => countFor(tx, 'SEAT'))).toBe(1n);
  });

  it('does NOT count a live invitation — provisioning is not arrival', async () => {
    const org = await newOrg('meter-invites');
    const inviter = await addUser(org, 'admin@meter-invites.test');

    await withOrg(org, (tx) =>
      tx.query(
        `INSERT INTO invite (organization_id, email, token_hash, invited_by_id, expires_at)
         VALUES ($1, 'pending@meter-invites.test', $2, $3,
                 clock_timestamp() + interval '7 days')`,
        [org, 'f'.repeat(64), inviter],
      ),
    );

    // John's decision: an admin who invites ten and gets three should not argue
    // with an invoice.
    expect(await withOrg(org, (tx) => countFor(tx, 'SEAT'))).toBe(1n);
  });

  it('counts a person ON_LEAVE, because they can still sign in', async () => {
    const org = await newOrg('meter-onleave');
    const u = await addUser(org, 'onleave@meter.test');
    await withOrg(org, (tx) =>
      tx.query("UPDATE app_user SET employee_status = 'ON_LEAVE' WHERE id = $1", [u]),
    );

    // Deliberate: `resolveSsoUser` does not consult `employee_status`, so filtering
    // on it here would bill differently from how the product admits people. If
    // that is ever wanted it is a pricing decision, not a WHERE clause.
    expect(await withOrg(org, (tx) => countFor(tx, 'SEAT'))).toBe(1n);
  });
});

describe('recording readings', () => {
  it('writes one per meter the plan actually charges for', async () => {
    const org = await newOrg('meter-record');
    await addUser(org, 'one@meter-record.test');

    const written = await withOrg(org, (tx) => recordReadings(tx, SEPTEMBER));

    // Every meter this product can COUNT — SEAT and TENANT. Not CARD, which has
    // no source. Which of these becomes an invoice line is the platform's
    // business; 0039 removed the local catalogue that used to decide it here.
    expect(written.map((w) => w.meter).sort()).toEqual(['SEAT', 'TENANT']);
    expect(written.every((w) => w.inserted)).toBe(true);

    const rows = await withOrg(org, (tx) =>
      tx.query(
        `SELECT meter, quantity, plan_code FROM subscription_meter_reading
          ORDER BY meter`,
      ),
    );
    expect(rows.rows.map((r) => [r.meter, r.quantity])).toEqual([
      ['SEAT', '1'],
      ['TENANT', '1'],
    ]);
    // Stamped at measurement, so "what were they on when this was counted" stays
    // answerable after they change plan. `unmirrored` is the honest stamp for a
    // tenant the platform has not told us about — which is most of them today.
    expect(rows.rows.every((r) => r.plan_code === 'unmirrored')).toBe(true);
  });

  it('is idempotent — a second run writes nothing and says so', async () => {
    const org = await newOrg('meter-idem');
    await addUser(org, 'x@meter-idem.test');
    await withOrg(org, (tx) => recordReadings(tx, SEPTEMBER));

    const again = await withOrg(org, (tx) => recordReadings(tx, SEPTEMBER));

    // It is a cron. It WILL be run twice — on a deploy, on a retry, and by a
    // person testing it.
    expect(again.every((w) => w.inserted === false)).toBe(true);
    const n = await withOrg(org, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM subscription_meter_reading'),
    );
    expect(n.rows[0].n).toBe(2);
  });

  it('does NOT overwrite a period whose count has since changed', async () => {
    const org = await newOrg('meter-evidence');
    await addUser(org, 'p@meter-evidence.test');
    await addUser(org, 'q@meter-evidence.test');
    await withOrg(org, (tx) => recordReadings(tx, SEPTEMBER));

    // Somebody leaves, and the sweep runs again over the same period.
    await withOrg(org, (tx) =>
      tx.query(
        "UPDATE app_user SET deleted_at = clock_timestamp() WHERE email = 'q@meter-evidence.test'",
      ),
    );
    await withOrg(org, (tx) => recordReadings(tx, SEPTEMBER));

    // A period's reading is EVIDENCE. September said 2, and it still says 2 —
    // overwriting would destroy the fact that the two runs disagree, which is
    // exactly what somebody investigating a disputed invoice needs.
    const seat = await withOrg(org, (tx) =>
      tx.query("SELECT quantity FROM subscription_meter_reading WHERE meter = 'SEAT'"),
    );
    expect(seat.rows.map((r) => r.quantity)).toEqual(['2']);
  });

  it('a different period gets its own reading', async () => {
    const org = await newOrg('meter-periods');
    await addUser(org, 'r@meter-periods.test');
    await withOrg(org, (tx) => recordReadings(tx, SEPTEMBER));
    const october: Period = {
      start: new Date(Date.UTC(2026, 9, 1)),
      end: new Date(Date.UTC(2026, 10, 1)),
    };
    const oct = await withOrg(org, (tx) => recordReadings(tx, october));

    expect(oct.every((w) => w.inserted)).toBe(true);
    const n = await withOrg(org, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM subscription_meter_reading'),
    );
    expect(n.rows[0].n).toBe(4);
  });

  it('a tenant with no subscription is MEASURED, which is the reverse of VX5-9', async () => {
    // VX5-9 returned [] here, because it read the local plan catalogue to decide
    // what to measure and a tenant with no subscription had no plan. 0039 deleted
    // that catalogue — the platform owns plans — so the question changed from
    // "what is this tenant charged for" to "what can this product count", and the
    // answer does not depend on anybody having bought anything.
    //
    // The reading is stamped `unmirrored` rather than a plan code, so a later
    // reconciliation can tell a measured-but-unbilled period from a billed one.
    const org = await newOrg('meter-nosub');
    await addUser(org, 'x@meter-nosub.test');

    const written = await withOrg(org, (tx) => recordReadings(tx, SEPTEMBER));

    expect(written.map((w) => w.meter).sort()).toEqual(['SEAT', 'TENANT']);
    const rows = await withOrg(org, (tx) =>
      tx.query("SELECT plan_code FROM subscription_meter_reading WHERE meter = 'SEAT'"),
    );
    expect(rows.rows[0].plan_code).toBe('unmirrored');
  });

  it('readings are tenant-isolated', async () => {
    const a = await newOrg('meter-iso-a');
    const b = await newOrg('meter-iso-b');
    await addUser(a, 'a@meter-iso.test');
    await withOrg(a, (tx) => recordReadings(tx, SEPTEMBER));

    const seenByB = await withOrg(b, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM subscription_meter_reading'),
    );
    expect(seenByB.rows[0].n).toBe(0);
  });
});

describe('the sweep across every tenant', () => {
  it('meters each tenant in its own context and totals what it wrote', async () => {
    await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
    const a = await newOrg('sweep-a');
    const b = await newOrg('sweep-b');
    await addUser(a, 'a@sweep.test');
    await addUser(b, 'b@sweep.test');

    const result = await meterAllTenants(SEPTEMBER);

    expect(result.organizations).toBe(2);
    // TEAM has two components, STARTER has two (TENANT + SEAT with 5 included).
    expect(result.readingsWritten).toBe(4);
    expect(result.readingsAlreadyPresent).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('re-running reports everything as already present rather than doubling', async () => {
    const again = await meterAllTenants(SEPTEMBER);
    expect(again.readingsWritten).toBe(0);
    expect(again.readingsAlreadyPresent).toBe(4);
  });

  it('measures a tenant the platform has never told us about', async () => {
    // AFTER 0039 THIS IS THE NORMAL CASE and it is the reason the sweep no longer
    // reads `subscription` to decide who to visit. VX5-9 did, which meant a
    // tenant with no mirrored entitlement was skipped — and since this product no
    // longer starts its own trials, that would now be almost every tenant. A seat
    // count is only true at the moment it is taken, so a month skipped is a month
    // that cannot be reconstructed.
    await admin.query('TRUNCATE organization RESTART IDENTITY CASCADE');
    const org = await newOrg('sweep-unmirrored');
    await addUser(org, 'a@sweep-unmirrored.test');

    const result = await meterAllTenants(SEPTEMBER);

    expect(result.organizations).toBe(1);
    expect(result.readingsWritten).toBe(2);
    expect(result.failures).toEqual([]);
  });

  /**
   * ── THE RESILIENCE TEST THAT USED TO BE HERE, AND WHY IT IS NOT ───────────
   *
   * VX5-9 proved that one tenant's failure does not stop the sweep, by giving a
   * tenant a plan whose meter this build cannot count. That needed a plan
   * catalogue in this database, and 0039 deleted it — the platform owns plans.
   *
   * With the catalogue gone there is no longer any DATA a tenant can hold that
   * makes its own measurement throw: the sweep counts a fixed set of meters it
   * knows it can count. That is a better property than the test was protecting,
   * and pretending otherwise by dropping a constraint mid-test is exactly the
   * schema surgery that made this file un-re-runnable twice before.
   *
   * The `failures` array stays on `SweepResult` rather than being removed,
   * because the path returns the day VCC lands and `CARD` becomes countable —
   * and a sweep that aborts on the first bad tenant would then leave every tenant
   * after it unmeasured for a month.
   */
});

describe('the billing period', () => {
  it('is the UTC calendar month, half-open', () => {
    const p = monthOf(new Date('2026-09-17T13:45:00Z'));
    expect(p.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rolls the year at December', () => {
    const p = monthOf(new Date('2026-12-31T23:59:59Z'));
    expect(p.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('is UTC regardless of the machine, which is why it uses Date.UTC', () => {
    // A period computed in local time would put two tenants in different zones in
    // different months for a seat added at midnight — and the provider's periods
    // are not tenant-local either. One interval for everybody, chosen once.
    const p = monthOf(new Date('2026-03-01T00:30:00Z'));
    expect(p.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});
