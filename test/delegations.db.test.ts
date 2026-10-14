/**
 * VX2-5 — delegation CRUD and the rules the resolver assumes, against a real
 * Postgres.
 *
 * Own org slug ('deleg-co') because the DB suites share one database and each
 * TRUNCATEs (vitest.config.ts, fileParallelism: false).
 *
 * The interesting tests are not the happy path. They are:
 *   - the calendar-date round trip, which is the whole reason `starts_on::text`
 *     exists and which a `Date`-typed assertion would pass while the UI showed
 *     the wrong day;
 *   - `onwardDelegation`, which detects the A→B→C case the resolver silently
 *     truncates (AP-16);
 *   - who may create and revoke, which is the only access control in this file.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as employees from '@/lib/employees/service';
import type { EmployeeRow } from '@/lib/employees/service';
import { verifyChain } from '@/lib/audit/verify';
import {
  DelegationError,
  createDelegation,
  getDelegation,
  listDelegations,
  onwardDelegation,
  revokeDelegation,
  type DelegationErrorCode,
  type NewDelegation,
} from '@/lib/approvals/delegations';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) {
  throw new Error(
    'delegations.db.test.ts needs ADMIN_DATABASE_URL (or DATABASE_URL). See HANDOFF.md.',
  );
}
const admin = new Pool({ connectionString: ADMIN_URL });

/**
 * A fixed "today" for every activity question.
 *
 * Not `new Date()`: `active` is computed from a date comparison in SQL, so a
 * suite that used the wall clock would change meaning at midnight and the range
 * tests below would drift out of the windows they are asserting about.
 */
const TODAY = new Date('2026-06-15T12:00:00Z');

let orgId: string;
let alice: EmployeeRow; // MANAGER — the delegator in most tests
let bob: EmployeeRow; // MANAGER — the stand-in
let carol: EmployeeRow; // MANAGER — the third party, for onward chains
let root: EmployeeRow; // ADMIN
let onLeave: EmployeeRow; // ON_LEAVE
let gone: EmployeeRow; // DEACTIVATED + soft-deleted

async function mkUser(email: string, role: string) {
  const id = await withOrg(orgId, async (tx) => {
    const r = await tx.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES (current_setting('app.current_org', true)::uuid, $1, $2, $3)
       RETURNING id`,
      [email, email.split('@')[0], role],
    );
    return r.rows[0].id as string;
  });
  const row = await withOrg(orgId, (tx) => employees.getEmployee(tx, id));
  if (!row) throw new Error(`fixture user ${email} not readable after insert`);
  return row;
}

/** `createDelegation` in its own transaction, defaults filled in. */
function create(actor: EmployeeRow, input: NewDelegation) {
  return withOrg(orgId, (tx) => createDelegation(tx, actor, input));
}

function revoke(actor: EmployeeRow, id: string) {
  return withOrg(orgId, (tx) => revokeDelegation(tx, actor, id));
}

/**
 * Assert a `DelegationError` with a specific code.
 *
 * `rejects.toThrow(DelegationError)` alone would pass on the wrong refusal —
 * INVALID_RANGE where SELF_DELEGATION was meant — which is exactly the class of
 * mistake these tests exist to catch.
 */
async function refuses(p: Promise<unknown>, code: DelegationErrorCode) {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(DelegationError);
  expect((thrown as DelegationError).code).toBe(code);
}

async function auditActions() {
  const r = await admin.query(
    `SELECT action, entity_id, details FROM audit_entry ORDER BY sequence`,
  );
  return r.rows as { action: string; entity_id: string; details: Record<string, unknown> }[];
}

beforeAll(async () => {
  await admin.query('TRUNCATE app_user, organization CASCADE');
  const o = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('deleg-co','Delegation Co') RETURNING id",
  );
  orgId = o.rows[0].id;
  alice = await mkUser('alice@deleg.test', 'MANAGER');
  bob = await mkUser('bob@deleg.test', 'MANAGER');
  carol = await mkUser('carol@deleg.test', 'MANAGER');
  root = await mkUser('root@deleg.test', 'ADMIN');
  onLeave = await mkUser('leave@deleg.test', 'MANAGER');
  gone = await mkUser('gone@deleg.test', 'MANAGER');
  // Two calls, not one statement string: node-postgres uses the extended
  // protocol as soon as parameters are present, and that protocol carries
  // exactly one statement. The multi-statement form only works unparameterised.
  await admin.query(`UPDATE app_user SET employee_status = 'ON_LEAVE' WHERE id = $1`, [
    onLeave.id,
  ]);
  await admin.query(
    `UPDATE app_user SET employee_status = 'DEACTIVATED', deleted_at = now() WHERE id = $1`,
    [gone.id],
  );
});

/**
 * A clean slate per test, keeping only the cast.
 *
 * Several tests here COUNT delegations, so a row left behind by an earlier test
 * is a wrong answer rather than noise — the same leakage `routing.db.test.ts`
 * and `approval-inbox.db.test.ts` both fix this way. Here the rows can be
 * DELETEd outright rather than parked, because nothing else references a
 * delegation.
 *
 * ONE statement string, so it runs on ONE pooled connection: the audit purge
 * hatch is transaction-local, and opening it in a separate `query()` call would
 * set it on a connection that goes back to the pool before the DELETE runs.
 */
beforeEach(async () => {
  await admin.query(
    `BEGIN;
     SELECT set_config('app.audit_purge', 'on', true);
     DELETE FROM audit_entry;
     DELETE FROM delegation;
     COMMIT;`,
  );
});

afterAll(async () => {
  await admin.end();
});

/* ── creating ──────────────────────────────────────────────────────────────── */

describe('createDelegation', () => {
  it('delegates your own approvals, and reads back active on a date inside the range', async () => {
    const row = await create(alice, {
      toUserId: bob.id,
      startsOn: '2026-06-10',
      endsOn: '2026-06-20',
      note: 'conference',
    });
    expect(row).toMatchObject({
      from_user_id: alice.id,
      from_name: 'alice',
      to_user_id: bob.id,
      to_name: 'bob',
      scope: 'ALL',
      created_by_id: alice.id,
      created_by_name: 'alice',
      revoked_at: null,
      revoked_by_name: null,
      note: 'conference',
    });

    const inside = await withOrg(orgId, (tx) => getDelegation(tx, row.id, TODAY));
    expect(inside?.active).toBe(true);
  });

  it('keeps the calendar dates it was given, whatever the process timezone', async () => {
    // The regression this guards: `node-postgres` maps a `date` column to a JS
    // Date at LOCAL midnight, so 2026-06-01 comes back as May 31st for anyone
    // west of UTC. Asserting on the text is the only assertion that can fail
    // when the column type goes back to being read as a Date.
    const row = await create(alice, { toUserId: bob.id, startsOn: '2026-06-01', endsOn: '2026-06-30' });
    expect(row.starts_on).toBe('2026-06-01');
    expect(row.ends_on).toBe('2026-06-30');
    expect(typeof row.starts_on).toBe('string');

    const reread = await withOrg(orgId, (tx) => getDelegation(tx, row.id, TODAY));
    expect(reread?.starts_on).toBe('2026-06-01');
    expect(reread?.ends_on).toBe('2026-06-30');
  });

  it('treats both ends of the range as inclusive', async () => {
    // One day long, and that day is TODAY. A half-open range would call this
    // inactive at one end or the other.
    const oneDay = await create(alice, {
      toUserId: bob.id,
      startsOn: '2026-06-15',
      endsOn: '2026-06-15',
    });
    expect((await withOrg(orgId, (tx) => getDelegation(tx, oneDay.id, TODAY)))?.active).toBe(true);

    // And the days either side of TODAY are outside it.
    const before = new Date('2026-06-14T12:00:00Z');
    const after = new Date('2026-06-16T12:00:00Z');
    expect((await withOrg(orgId, (tx) => getDelegation(tx, oneDay.id, before)))?.active).toBe(false);
    expect((await withOrg(orgId, (tx) => getDelegation(tx, oneDay.id, after)))?.active).toBe(false);
  });

  it('accepts an open-ended delegation for a standing stand-in', async () => {
    const row = await create(alice, { toUserId: bob.id, startsOn: '2026-01-01', endsOn: null });
    expect(row.ends_on).toBeNull();
    expect(row.active).toBe(true);
    const farFuture = new Date('2031-01-01T00:00:00Z');
    expect((await withOrg(orgId, (tx) => getDelegation(tx, row.id, farFuture)))?.active).toBe(true);
  });

  it('refuses to delegate to yourself', async () => {
    await refuses(create(alice, { toUserId: alice.id, startsOn: '2026-06-10' }), 'SELF_DELEGATION');
    // Also when an admin does it on somebody's behalf: the check is on the pair,
    // not on the actor.
    await refuses(
      create(root, { fromUserId: alice.id, toUserId: alice.id, startsOn: '2026-06-10' }),
      'SELF_DELEGATION',
    );
  });

  it('refuses an end date before the start date', async () => {
    await refuses(
      create(alice, { toUserId: bob.id, startsOn: '2026-06-20', endsOn: '2026-06-10' }),
      'INVALID_RANGE',
    );
  });

  it('refuses a date that is not a calendar date', async () => {
    await refuses(create(alice, { toUserId: bob.id, startsOn: 'next tuesday' }), 'INVALID_RANGE');
    await refuses(
      create(alice, { toUserId: bob.id, startsOn: '2026-06-10', endsOn: '2026-6-1' }),
      'INVALID_RANGE',
    );
  });

  it('refuses an unknown scope', async () => {
    await refuses(
      create(alice, {
        toUserId: bob.id,
        startsOn: '2026-06-10',
        scope: 'TRAVEL' as never,
      }),
      'INVALID_SCOPE',
    );
    // REPORTS is a real scope and must still be accepted, or the guard above is
    // just refusing everything.
    const ok = await create(alice, { toUserId: bob.id, startsOn: '2026-06-10', scope: 'REPORTS' });
    expect(ok.scope).toBe('REPORTS');
  });

  it('refuses a delegatee who is on leave or gone', async () => {
    await refuses(create(alice, { toUserId: onLeave.id, startsOn: '2026-06-10' }), 'DELEGATEE_UNAVAILABLE');
    await refuses(create(alice, { toUserId: gone.id, startsOn: '2026-06-10' }), 'DELEGATEE_UNAVAILABLE');
  });

  it('refuses a delegatee who is not in this organization', async () => {
    await refuses(
      create(alice, { toUserId: '00000000-0000-4000-8000-000000000000', startsOn: '2026-06-10' }),
      'NOT_FOUND',
    );
  });

  /* ── delegating on somebody else's behalf ─────────────────────────────────── */

  it('lets an admin delegate somebody else’s approvals, and records that it was them', async () => {
    const row = await create(root, {
      fromUserId: alice.id,
      toUserId: bob.id,
      startsOn: '2026-06-10',
      endsOn: '2026-06-20',
    });
    // The two ids differ, which is the entire reason created_by_id exists (0008).
    expect(row.from_user_id).toBe(alice.id);
    expect(row.created_by_id).toBe(root.id);
    expect(row.created_by_name).toBe('root');
  });

  it('refuses a non-admin delegating somebody else’s approvals', async () => {
    await refuses(
      create(alice, { fromUserId: carol.id, toUserId: bob.id, startsOn: '2026-06-10' }),
      'FORBIDDEN',
    );
    // A MANAGER is not an admin even for their own report — this is not the
    // manager chain, it is who may reassign an approval authority.
    await refuses(
      create(bob, { fromUserId: alice.id, toUserId: carol.id, startsOn: '2026-06-10' }),
      'FORBIDDEN',
    );
  });

  /* ── overlaps ─────────────────────────────────────────────────────────────── */

  it('allows overlapping delegations, because the resolver settles them', async () => {
    // AP-16 / 0008: the overlap is deliberately unconstrained in the schema and
    // VX2-2 picks the most recently created live one. Refusing it here would be
    // refusing something the rest of the system already handles.
    const first = await create(alice, {
      toUserId: bob.id,
      startsOn: '2026-06-01',
      endsOn: '2026-06-30',
    });
    const second = await create(alice, {
      toUserId: carol.id,
      startsOn: '2026-06-10',
      endsOn: '2026-06-20',
    });
    const both = await withOrg(orgId, (tx) =>
      listDelegations(tx, { forUserId: alice.id, onDate: TODAY }),
    );
    expect(both.map((d) => d.id).sort()).toEqual([first.id, second.id].sort());
    expect(both.every((d) => d.active)).toBe(true);
  });
});

/* ── onward delegations ────────────────────────────────────────────────────── */

describe('onwardDelegation', () => {
  it('is null when the stand-in has no delegation of their own', async () => {
    await create(alice, { toUserId: bob.id, startsOn: '2026-06-10', endsOn: '2026-06-20' });
    expect(await withOrg(orgId, (tx) => onwardDelegation(tx, bob.id, TODAY))).toBeNull();
  });

  it('names the third party when A→B→C, which the resolver truncates at B', async () => {
    // The whole point of the warning: alice believes she has arranged cover two
    // people deep, and she has not — a task of hers reaches bob and stops.
    await create(bob, { toUserId: carol.id, startsOn: '2026-06-01', endsOn: '2026-06-30' });
    const onward = await withOrg(orgId, (tx) => onwardDelegation(tx, bob.id, TODAY));
    expect(onward).toEqual({ toName: 'carol' });
  });

  it('ignores an onward delegation that is revoked or out of range', async () => {
    const revoked = await create(bob, { toUserId: carol.id, startsOn: '2026-06-01' });
    await revoke(bob, revoked.id);
    expect(await withOrg(orgId, (tx) => onwardDelegation(tx, bob.id, TODAY))).toBeNull();

    await create(bob, { toUserId: carol.id, startsOn: '2026-07-01', endsOn: '2026-07-31' });
    expect(await withOrg(orgId, (tx) => onwardDelegation(tx, bob.id, TODAY))).toBeNull();
    // ...but it IS onward inside its own window, so the query is not just
    // returning null for everything.
    const july = new Date('2026-07-15T12:00:00Z');
    expect(await withOrg(orgId, (tx) => onwardDelegation(tx, bob.id, july))).toEqual({
      toName: 'carol',
    });
  });

  it('reports the most recently created one when the stand-in has two', async () => {
    // Same tie-break as the resolver: created_at DESC. Asserting it here means
    // the warning names the person who would actually receive the work.
    await create(bob, { toUserId: alice.id, startsOn: '2026-06-01', endsOn: '2026-06-30' });
    await create(bob, { toUserId: carol.id, startsOn: '2026-06-01', endsOn: '2026-06-30' });
    expect(await withOrg(orgId, (tx) => onwardDelegation(tx, bob.id, TODAY))).toEqual({
      toName: 'carol',
    });
  });
});

/* ── listing ───────────────────────────────────────────────────────────────── */

describe('listDelegations', () => {
  it('returns the ones a person gave and the ones they received', async () => {
    const given = await create(alice, { toUserId: bob.id, startsOn: '2026-06-10' });
    const received = await create(carol, { toUserId: alice.id, startsOn: '2026-06-10' });
    const unrelated = await create(bob, { toUserId: carol.id, startsOn: '2026-06-10' });

    const mine = await withOrg(orgId, (tx) =>
      listDelegations(tx, { forUserId: alice.id, onDate: TODAY }),
    );
    expect(mine.map((d) => d.id).sort()).toEqual([given.id, received.id].sort());
    expect(mine.map((d) => d.id)).not.toContain(unrelated.id);
  });

  it('hides revoked delegations unless asked for them', async () => {
    const live = await create(alice, { toUserId: bob.id, startsOn: '2026-06-10' });
    const dead = await create(alice, { toUserId: carol.id, startsOn: '2026-06-10' });
    await revoke(alice, dead.id);

    const visible = await withOrg(orgId, (tx) =>
      listDelegations(tx, { forUserId: alice.id, onDate: TODAY }),
    );
    expect(visible.map((d) => d.id)).toEqual([live.id]);

    const all = await withOrg(orgId, (tx) =>
      listDelegations(tx, { forUserId: alice.id, includeRevoked: true, onDate: TODAY }),
    );
    expect(all).toHaveLength(2);
    // Live first: the ordering puts `revoked_at IS NOT NULL` last, so a screen
    // showing history does not bury the delegation in force.
    expect(all[0].id).toBe(live.id);
    expect(all[1].id).toBe(dead.id);
  });

  it('returns the whole tenant when no user is named', async () => {
    await create(alice, { toUserId: bob.id, startsOn: '2026-06-10' });
    await create(bob, { toUserId: carol.id, startsOn: '2026-06-10' });
    const everything = await withOrg(orgId, (tx) => listDelegations(tx, { onDate: TODAY }));
    expect(everything).toHaveLength(2);
  });

  it('answers activity for the date it was asked about, not today', async () => {
    await create(alice, { toUserId: bob.id, startsOn: '2026-09-01', endsOn: '2026-09-30' });
    const inJune = await withOrg(orgId, (tx) => listDelegations(tx, { onDate: TODAY }));
    expect(inJune[0].active).toBe(false);
    const inSeptember = await withOrg(orgId, (tx) =>
      listDelegations(tx, { onDate: new Date('2026-09-15T12:00:00Z') }),
    );
    expect(inSeptember[0].active).toBe(true);
  });

  it("reads the day in the tenant's working timezone, not the database server's", async () => {
    /**
     * 0008's rule: inclusive calendar dates in the tenant's working timezone
     * (`organization.default_timezone`). 02:00 UTC on 16 June is still the 15th in Toronto,
     * so a delegation ending on the 15th still covers a Toronto tenant then, and has ended
     * for a UTC one. The answer used to follow the database server's own zone.
     */
    await create(alice, { toUserId: bob.id, startsOn: '2026-06-10', endsOn: '2026-06-15' });
    const lateEvening = new Date('2026-06-16T02:00:00Z');
    const activeIn = async (zone: string) => {
      await admin.query(`UPDATE organization SET default_timezone = $2 WHERE id = $1`, [orgId, zone]);
      return (await withOrg(orgId, (tx) => listDelegations(tx, { onDate: lateEvening })))[0].active;
    };
    try {
      expect(await activeIn('America/Toronto')).toBe(true);
      expect(await activeIn('UTC')).toBe(false);
      expect(await withOrg(orgId, (tx) => onwardDelegation(tx, alice.id, lateEvening))).toBeNull();
      await activeIn('America/Toronto');
      expect(await withOrg(orgId, (tx) => onwardDelegation(tx, alice.id, lateEvening))).not.toBeNull();
    } finally {
      await admin.query(`UPDATE organization SET default_timezone = 'UTC' WHERE id = $1`, [orgId]);
    }
  });
});

/* ── revoking ──────────────────────────────────────────────────────────────── */

describe('revokeDelegation', () => {
  it('lets the delegator revoke, and records who ended it', async () => {
    const row = await create(alice, { toUserId: bob.id, startsOn: '2026-06-10' });
    const after = await revoke(alice, row.id);
    expect(after.revoked_at).toBeInstanceOf(Date);
    expect(after.revoked_by_name).toBe('alice');
    // Revoked is not active, whatever the dates say.
    expect(after.active).toBe(false);
  });

  it('lets the admin who created it revoke it, and lets any admin revoke', async () => {
    const byRoot = await create(root, {
      fromUserId: alice.id,
      toUserId: bob.id,
      startsOn: '2026-06-10',
    });
    expect((await revoke(root, byRoot.id)).revoked_by_name).toBe('root');

    const byAlice = await create(alice, { toUserId: carol.id, startsOn: '2026-06-10' });
    expect((await revoke(root, byAlice.id)).revoked_by_name).toBe('root');
  });

  it('refuses anyone else — including the stand-in it was given to', async () => {
    const row = await create(alice, { toUserId: bob.id, startsOn: '2026-06-10' });
    // bob is the delegatee. Declining cover is a conversation, not a database
    // write: letting him revoke would let him silently drop alice's queue.
    await refuses(revoke(bob, row.id), 'FORBIDDEN');
    await refuses(revoke(carol, row.id), 'FORBIDDEN');
    // Still live after both refusals.
    expect((await withOrg(orgId, (tx) => getDelegation(tx, row.id, TODAY)))?.revoked_at).toBeNull();
  });

  it('refuses a second revoke', async () => {
    const row = await create(alice, { toUserId: bob.id, startsOn: '2026-06-10' });
    await revoke(alice, row.id);
    await refuses(revoke(alice, row.id), 'ALREADY_REVOKED');
  });

  it('refuses an unknown id', async () => {
    await refuses(revoke(alice, '00000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
  });
});

/* ── the audit trail ───────────────────────────────────────────────────────── */

describe('the audit trail', () => {
  it('writes DELEGATION_CREATED and DELEGATION_REVOKED, and the chain still verifies', async () => {
    const row = await create(alice, {
      toUserId: bob.id,
      startsOn: '2026-06-10',
      endsOn: '2026-06-20',
      scope: 'REPORTS',
    });
    await revoke(alice, row.id);

    const entries = await auditActions();
    expect(entries.map((e) => e.action)).toEqual(['DELEGATION_CREATED', 'DELEGATION_REVOKED']);
    expect(entries[0].entity_id).toBe(row.id);
    expect(entries[0].details).toMatchObject({
      fromUserId: alice.id,
      toUserId: bob.id,
      startsOn: '2026-06-10',
      endsOn: '2026-06-20',
      scope: 'REPORTS',
      onBehalfOfSomeoneElse: false,
    });
    expect(entries[1].entity_id).toBe(row.id);
    expect(entries[1].details).toMatchObject({
      fromUserId: alice.id,
      toUserId: bob.id,
      revokedSomebodyElses: false,
    });

    // A delegation moves who may approve money, so the entries have to be part
    // of the tamper-evident chain rather than loose rows.
    const verified = await withOrg(orgId, (tx) => verifyChain(tx));
    expect(verified.ok).toBe(true);
  });

  it('flags an admin acting on somebody else’s behalf, on both ends', async () => {
    const row = await create(root, {
      fromUserId: alice.id,
      toUserId: bob.id,
      startsOn: '2026-06-10',
    });
    await revoke(root, row.id);
    const entries = await auditActions();
    expect(entries[0].details).toMatchObject({ onBehalfOfSomeoneElse: true });
    expect(entries[1].details).toMatchObject({ revokedSomebodyElses: true });
  });

  it('writes nothing when the create is refused', async () => {
    await refuses(create(alice, { toUserId: alice.id, startsOn: '2026-06-10' }), 'SELF_DELEGATION');
    await refuses(create(alice, { toUserId: onLeave.id, startsOn: '2026-06-10' }), 'DELEGATEE_UNAVAILABLE');
    expect(await auditActions()).toHaveLength(0);
  });
});
