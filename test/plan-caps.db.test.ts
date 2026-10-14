/**
 * The plan's numeric caps, enforced where the counted thing is created.
 *
 * Own org slug ('caps-co'), like every other db suite in this project, because
 * they share one database.
 *
 * Until this suite `capIsEnforced('maxUsers')` and `capIsEnforced(
 * 'expensesPerYear')` both answered `true`, and nothing refused on either. See
 * `lib/billing/caps.ts`. The cases below are the ones that would have shown it:
 * a cap in force refuses at its limit and not before; every way a seat comes
 * back is counted, not only creation; two additions racing at the limit cannot
 * both win; and the three non-numbers (no subscription, `null`, malformed) still
 * permit, because a cap nobody stated must not take a tenant offline.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as employees from '@/lib/employees/service';
import * as expenses from '@/lib/expenses/service';
import { issueInvite } from '@/lib/invites/service';
import { resolveSsoUser } from '@/lib/auth/resolve-sso-user';
import { TEST_ACTOR } from './support/audit-actor';
import { TODAY } from './support/dates';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});
const app = new Pool({ connectionString: process.env.DATABASE_URL });

let orgId: string;
let founderId: string;
let seq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setLimits(limits: unknown): Promise<void> {
  await admin.query('DELETE FROM subscription WHERE organization_id = $1', [orgId]);
  if (limits === undefined) return;
  await admin.query(
    `INSERT INTO subscription
       (organization_id, plan_code, plan_name, status, read_only, features, limits, mirrored_at)
     VALUES ($1, 'starter', 'Starter', 'ACTIVE', false, '{}'::jsonb, $2::jsonb, clock_timestamp())`,
    [orgId, JSON.stringify(limits)],
  );
}

async function seats(): Promise<number> {
  const r = await admin.query(
    'SELECT count(*)::int AS n FROM app_user WHERE organization_id = $1 AND deleted_at IS NULL',
    [orgId],
  );
  return r.rows[0].n as number;
}

function hire(tx: Parameters<typeof employees.createEmployee>[0]) {
  seq += 1;
  return employees.createEmployee(tx, { email: `p${seq}@caps.test`, displayName: `P${seq}` });
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { userMessage?: { code?: string; params?: Record<string, unknown> } };
    return err.userMessage?.code ?? String(e);
  }
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('caps-co','Caps Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  const f = await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role_id)
     VALUES ($1,'founder@caps.test','Founder','019e3000-0000-7000-8000-000000000001') RETURNING id`,
    [orgId],
  );
  founderId = f.rows[0].id;
});

beforeEach(async () => {
  // Back to the founder alone, no plan, no expenses.
  await admin.query('DELETE FROM expense_report WHERE organization_id = $1', [orgId]);
  await admin.query('DELETE FROM invite WHERE organization_id = $1', [orgId]);
  // Accepting an invitation audits as the new member, so their rows must go
  // before they can. Same purge hatch as the approval suites.
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     COMMIT;`,
  );
  await admin.query("DELETE FROM app_user WHERE organization_id = $1 AND id <> $2", [orgId, founderId]);
  await setLimits(undefined);
});

afterAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await app.end();
  await admin.end();
});

describe('maxUsers — seats', () => {
  it('refuses the seat AFTER the limit, and not the one at it', async () => {
    await setLimits({ maxUsers: 3 }); // the founder is one
    await withOrg(orgId, (tx) => hire(tx));
    await withOrg(orgId, (tx) => hire(tx)); // three: at the limit, allowed
    expect(await seats()).toBe(3);

    const err = await withOrg(orgId, (tx) => hire(tx)).catch((e: unknown) => e);
    expect((err as { userMessage: { code: string } }).userMessage.code).toBe('SEAT_LIMIT_REACHED');
    // The sentence names the number, so the reader knows what the limit is.
    expect((err as { userMessage: { params: { limit: number } } }).userMessage.params.limit).toBe(3);
    expect(await seats()).toBe(3);
  });

  it('counts a REACTIVATION as a seat, or the cap is walked round', async () => {
    await setLimits({ maxUsers: 2 });
    const second = await withOrg(orgId, (tx) => hire(tx));
    await withOrg(orgId, (tx) =>
      employees.deactivateEmployee(tx, second.id, { actingEmployeeId: founderId }),
    );
    await withOrg(orgId, (tx) => hire(tx)); // takes the freed seat
    expect(await seats()).toBe(2);

    expect(
      await codeOf(
        withOrg(orgId, (tx) => employees.updateEmployee(tx, second.id, { employeeStatus: 'ACTIVE' })),
      ),
    ).toBe('SEAT_LIMIT_REACHED');
    expect(await seats()).toBe(2);
  });

  it('a status change that is NOT a reactivation is not a new seat', async () => {
    await setLimits({ maxUsers: 2 });
    const second = await withOrg(orgId, (tx) => hire(tx));
    // ON_LEAVE -> ACTIVE: the row never stopped counting, so nothing to refuse.
    await withOrg(orgId, (tx) => employees.updateEmployee(tx, second.id, { employeeStatus: 'ON_LEAVE' }));
    expect(
      await codeOf(
        withOrg(orgId, (tx) => employees.updateEmployee(tx, second.id, { employeeStatus: 'ACTIVE' })),
      ),
    ).toBeNull();
  });

  it.each([
    ['no subscription mirrored', undefined],
    ['limits sent without the key', {}],
    ['maxUsers: null (unlimited)', { maxUsers: null }],
    ['maxUsers malformed', { maxUsers: 'three' }],
  ])('permits when the plan does not state a number: %s', async (_label, limits) => {
    await setLimits(limits);
    for (let i = 0; i < 4; i++) await withOrg(orgId, (tx) => hire(tx));
    expect(await seats()).toBe(5);
  });

  it('two acceptances racing for the LAST seat cannot both win', async () => {
    await setLimits({ maxUsers: 2 });

    const begin = async (): Promise<PoolClient> => {
      const c = await app.connect();
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
      return c;
    };
    const a = await begin();
    const b = await begin();
    const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    try {
      await hire(a); // counted 1, inserted, holds the tenant lock

      let settled = false;
      const second = codeOf(hire(b)).finally(() => {
        settled = true;
      });
      // Postgres, not the promise, says whether B is actually waiting — the
      // #129 lesson. Without the tenant lock B would count 1 too, and win.
      const deadline = Date.now() + 3000;
      for (;;) {
        const r = await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [bPid]);
        if (r.rows[0]?.wait_event_type === 'Lock') break;
        if (settled) throw new Error('the second acceptance finished without waiting — no overlap, nothing proven');
        if (Date.now() > deadline) throw new Error('the second acceptance never blocked within 3s');
        await sleep(25);
      }
      await a.query('COMMIT');
      expect(await second).toBe('SEAT_LIMIT_REACHED');
      await b.query('ROLLBACK');
      expect(await seats()).toBe(2);
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }
  });
});

describe('the seat cap at SIGN-IN, where the invitation is actually accepted', () => {
  /**
   * `createEmployee` runs inside NextAuth's `signIn` callback when an invitee
   * signs in for the first time, and a throw there is an opaque failure page. So
   * the refusal has to arrive as a DENIAL that leaves the invitation alive, with
   * the reason in the tenant's audit log — not as an exception.
   */
  it('refuses as a denial, keeps the invitation, says why, and admits them once a seat frees', async () => {
    await setLimits({ maxUsers: 1 }); // the founder fills it
    await withOrg(orgId, (tx) =>
      issueInvite(
        tx,
        { id: founderId, name: 'Founder', role: 'System Administrator' },
        { email: 'late@caps.test', roleId: '019e3000-0000-7000-8000-000000000004' },
      ),
    );

    expect(await resolveSsoUser('caps-co', 'late@caps.test')).toBeNull();

    const live = await admin.query(
      `SELECT accepted_at FROM invite WHERE organization_id = $1 AND email = 'late@caps.test'`,
      [orgId],
    );
    expect(live.rows[0].accepted_at, 'the invitation was consumed by a refused sign-in').toBeNull();
    const refused = await admin.query(
      `SELECT details FROM audit_entry WHERE organization_id = $1 AND action = 'INVITE_REFUSED'
        ORDER BY sequence DESC LIMIT 1`,
      [orgId],
    );
    expect(refused.rows[0]?.details).toMatchObject({ reason: 'SEAT_LIMIT_REACHED', limit: 1 });

    await setLimits({ maxUsers: 2 }); // the admin buys a seat
    const joined = await resolveSsoUser('caps-co', 'late@caps.test');
    expect(joined?.email).toBe('late@caps.test');
  });
});

describe('expensesPerYear — expenses', () => {
  async function report(): Promise<string> {
    return withOrg(orgId, async (tx) => {
      const r = await expenses.createReport(tx, 'founder@caps.test', { title: 'Caps', currencyCode: 'CAD' });
      return r.id as string;
    });
  }
  const add = (reportId: string) =>
    withOrg(orgId, (tx) =>
      expenses.addExpense(tx, TEST_ACTOR, reportId, { txnDate: TODAY, currencyCode: 'CAD', merchant: 'M' }),
    );

  it('refuses the expense after the limit', async () => {
    await setLimits({ expensesPerYear: 2 });
    const r = await report();
    await add(r);
    await add(r);
    expect(await codeOf(add(r))).toBe('EXPENSE_LIMIT_REACHED');
  });

  it('is ROLLING: an expense older than 365 days no longer counts', async () => {
    await setLimits({ expensesPerYear: 1 });
    const r = await report();
    const first = await add(r);
    expect(await codeOf(add(r))).toBe('EXPENSE_LIMIT_REACHED');
    await admin.query("UPDATE expense SET created_at = now() - interval '366 days' WHERE id = $1", [first.id]);
    expect(await codeOf(add(r))).toBeNull();
  });

  it('a DELETED expense stops counting', async () => {
    await setLimits({ expensesPerYear: 1 });
    const r = await report();
    const first = await add(r);
    await withOrg(orgId, (tx) => expenses.removeExpense(tx, TEST_ACTOR, first.id as string));
    expect(await codeOf(add(r))).toBeNull();
  });

  it('permits with no number stated', async () => {
    await setLimits({ expensesPerYear: null });
    const r = await report();
    for (let i = 0; i < 3; i++) await add(r);
  });
});
