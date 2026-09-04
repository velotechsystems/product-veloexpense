/**
 * VX4-8 part 1 / UD-8 — who sends an approved report. Own org slug ('trig-co').
 *
 * ── What each group is actually asserting ───────────────────────────────────
 *
 * `the constraint and the union` is 0027's rule applied to a second column: a
 * CHECK cannot read a TypeScript type, so the duplicate list is made SAFE rather
 * than avoided. Both directions, so adding a value on either side alone fails.
 *
 * `a held row is unreachable` is the load-bearing one. AP_QUEUE is only worth
 * anything if the poller genuinely cannot take a held row, and there are two
 * independent reasons it cannot — `0017`'s `platform_read` policy matches
 * PENDING/FAILED, and `claimPost`'s conditional write re-asserts the same pair.
 * Both are tested, because either one alone would make this a one-guard feature
 * with a comment claiming two.
 *
 * `releasing` is separate from retrying on purpose; see `releaseHold`.
 */
process.env.INTEGRATIONS_ENABLE_STUB = '1';
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64');

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import * as outbox from '@/lib/integrations/post-outbox';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgId: string;
let userId: string;
const actor = { id: '', name: 'Ada Admin', role: 'ADMIN' as const };

async function setTrigger(value: outbox.PostingTrigger) {
  await admin.query('UPDATE organization SET posting_trigger = $1 WHERE id = $2', [value, orgId]);
}

/** An APPROVED report, enqueued through the real path. */
async function approvedReport(title: string): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const rep = await tx.query(
      `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code,
                                   status, approved_at, number, total_minor)
       VALUES ($1, $2, $3, 'CAD', 'APPROVED', clock_timestamp(), $4, 1000) RETURNING id`,
      [orgId, userId, title, `EXP-${Math.floor(Math.random() * 1000000)}`],
    );
    const reportId = rep.rows[0].id as string;
    await outbox.enqueuePost(tx, reportId);
    return reportId;
  });
}

beforeAll(async () => {
  const org = await admin.query(
    "INSERT INTO organization (slug, name) VALUES ('trig-co','Trig Co') RETURNING id, posting_trigger",
  );
  orgId = org.rows[0].id;
  // Asserted here rather than in its own `it`, because this row is the only one
  // in the suite created WITHOUT an explicit value — every later test sets the
  // trigger deliberately, so this insert is the one observation of the default.
  expect(org.rows[0].posting_trigger).toBe('AP_QUEUE');

  await withOrg(orgId, async (tx) => {
    const u = await tx.query(
      "INSERT INTO app_user (organization_id, email, display_name) VALUES ($1,'a@trig.test','Ada') RETURNING id",
      [orgId],
    );
    userId = u.rows[0].id;
    actor.id = userId;
  });
});

beforeEach(async () => {
  await admin.query('DELETE FROM integration_post');
  await admin.query('DELETE FROM expense_report');
  await setTrigger('AP_QUEUE');
});

afterAll(async () => {
  // Same teardown as every other DB suite in this repo. Safe because
  // `vitest.config.ts` sets `fileParallelism: false` — the suites share one
  // database and each one truncates. A targeted DELETE was tried first and is
  // refused by `app_user_organization_id_fkey`.
  await admin.query('TRUNCATE app_user, organization CASCADE');
  await admin.end();
});

describe('0030 — the constraint and the union', () => {
  it('the CHECK accepts exactly POSTING_TRIGGERS', async () => {
    // Direction 1: read the accepted set out of what Postgres enforces, so this
    // cannot pass by reading the migration file.
    const { rows } = await admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'organization_posting_trigger_known'`,
    );
    expect(rows).toHaveLength(1);
    const accepted = [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(accepted).toEqual([...outbox.POSTING_TRIGGERS].sort());

    // Direction 2: the column actually takes each one. A constraint whose TEXT
    // lists a value the column then rejects would pass direction 1 alone.
    for (const value of outbox.POSTING_TRIGGERS) {
      await expect(setTrigger(value)).resolves.toBeUndefined();
    }
  });

  it('refuses anything else, including the empty string', async () => {
    for (const bad of ['', 'MANUAL', 'ap_queue', 'AUTO']) {
      await expect(
        admin.query('UPDATE organization SET posting_trigger = $1 WHERE id = $2', [bad, orgId]),
      ).rejects.toThrow(/organization_posting_trigger_known/);
    }
  });

  it('the queue-status CHECK accepts exactly POST_STATUSES', async () => {
    // Stronger than asserting HELD is present, and possible only because
    // `POST_STATUSES` exists: this is the same both-directions rule 0027 applies
    // to locales, now covering every queue status rather than the new one.
    const { rows } = await admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'integration_post_status_chk'`,
    );
    const accepted = [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(accepted).toEqual([...outbox.POST_STATUSES].sort());
  });

  /**
   * A GUARD AGAINST A FUTURE SIMPLIFICATION, and it is honest about being no more
   * than that.
   *
   * The backfill — existing organizations keep AUTOMATIC — happened once, when
   * 0030 ran against a database that already had rows. CI's database is fresh, so
   * `organization` is empty at that moment and there is nothing to back-fill:
   * the property is genuinely untestable here, and a test claiming otherwise
   * would be theatre.
   *
   * What IS worth guarding is the two-statement idiom itself. Collapsing it to a
   * single `ADD COLUMN … DEFAULT 'AP_QUEUE'` looks like tidying and would silently
   * stop posting for every already-running tenant on deploy day. So this asserts
   * the shape of the DDL, and says plainly that it is asserting the file.
   */
  it('0030 adds the column as AUTOMATIC and only then makes AP_QUEUE the default', () => {
    const sql = readFileSync('prisma/migrations/0030_posting_trigger/migration.sql', 'utf8');
    const add = sql.indexOf("ADD COLUMN posting_trigger text NOT NULL DEFAULT 'AUTOMATIC'");
    const setDefault = sql.indexOf("ALTER COLUMN posting_trigger SET DEFAULT 'AP_QUEUE'");
    expect(add).toBeGreaterThan(-1);
    expect(setDefault).toBeGreaterThan(add);
  });
});

describe('enqueueing under each setting', () => {
  it('AP_QUEUE enqueues HELD', async () => {
    await approvedReport('held one');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('HELD');
  });

  it('AUTOMATIC enqueues PENDING', async () => {
    await setTrigger('AUTOMATIC');
    await approvedReport('sent one');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(queue[0].status).toBe('PENDING');
  });

  it('the status is decided by the setting, not by the caller', async () => {
    // `enqueuePost` takes no status argument at all — the signature is the
    // assertion. This test exists so that adding one is a visible failure rather
    // than a quiet new way for two callers to disagree (MT-3).
    expect(outbox.enqueuePost.length).toBe(2);
  });

  it('refuses loudly for an org it cannot see, rather than enqueuing nothing', async () => {
    // The point of the two-statement `enqueuePost`. The tempting one-statement
    // version — SELECT the trigger inside the INSERT — inserts ZERO ROWS when
    // that SELECT finds nothing and returns happily, so a lost enqueue would look
    // like a successful approval. RLS makes an unknown organization exactly that
    // case: the row is invisible, the SELECT is empty.
    const ghost = '00000000-0000-4000-8000-00000000dead';
    await expect(
      withOrg(ghost, (tx) => outbox.enqueuePost(tx, ghost)),
    ).rejects.toThrow();
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM integration_post WHERE organization_id = $1',
      [ghost],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('a held row is unreachable by anything automatic', () => {
  it('the poller cannot see it — the platform_read policy, not a query', async () => {
    await approvedReport('invisible');
    // `duePosts` goes through `withPlatformRead`, whose 0017 policy matches
    // `status IN ('PENDING','FAILED')`. Nothing in that function mentions HELD.
    const due = await outbox.duePosts();
    const ours = due.filter((d) => d.organizationId === orgId);
    expect(ours).toHaveLength(0);

    // And the same row IS visible the moment it is released, so the emptiness
    // above is about the status rather than about the fixture being wrong.
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    await withOrg(orgId, (tx) => outbox.releaseHold(tx, queue[0].id));
    const after = await outbox.duePosts();
    expect(after.filter((d) => d.organizationId === orgId)).toHaveLength(1);
  });

  it('claimPost refuses it — the second, independent guard', async () => {
    await approvedReport('unclaimable');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    const claimed = await withOrg(orgId, (tx) => outbox.claimPost(tx, queue[0].id));
    expect(claimed).toBeNull();
  });
});

describe('releasing', () => {
  it('HELD becomes PENDING and due now', async () => {
    await approvedReport('release me');
    const before = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    await withOrg(orgId, (tx) => outbox.releaseHold(tx, before[0].id));
    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after[0].status).toBe('PENDING');
    expect(after[0].next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // Nothing has been attempted — releasing is not retrying.
    expect(after[0].attempts).toBe(0);
  });

  it('a second release refuses rather than silently succeeding', async () => {
    await approvedReport('twice');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    await withOrg(orgId, (tx) => outbox.releaseHold(tx, queue[0].id));
    await expect(
      withOrg(orgId, (tx) => outbox.releaseHold(tx, queue[0].id)),
    ).rejects.toThrow(/not held/);
  });

  it('a withheld row cannot be released', async () => {
    await approvedReport('withheld');
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    await withOrg(orgId, (tx) => outbox.cancelPost(tx, queue[0].id, 'no'));
    await expect(
      withOrg(orgId, (tx) => outbox.releaseHold(tx, queue[0].id)),
    ).rejects.toThrow(/not held/);
  });
});

describe('changing the setting', () => {
  it('audits from -> to, and returns the previous value', async () => {
    const before = await withOrg(orgId, (tx) =>
      outbox.setPostingTrigger(tx, actor, 'AUTOMATIC'),
    );
    expect(before).toBe('AP_QUEUE');
    const audit = await admin.query(
      `SELECT action, details FROM audit_entry
        WHERE organization_id = $1 AND action = 'LEDGER_POSTING_TRIGGER_CHANGED'
        -- ORDER BY sequence, not id: audit_entry.id is a random uuid, so
        -- ordering by it picks an arbitrary row. Shipped in part 1 and corrected
        -- in part 4, where the same mistake was caught by running one file five
        -- times in a row. (No backticks in this comment: it is inside a template
        -- literal, which is a trap ExpenseOS's own fraud SQL warns about.)
        ORDER BY sequence DESC LIMIT 1`,
      [orgId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({ from: 'AP_QUEUE', to: 'AUTOMATIC' });
  });

  it('a resubmit that changes nothing is not an event', async () => {
    // COUNTED, not cleared: `audit_entry` is append-only and refuses DELETE
    // unless `app.audit_purge` is set — which is the hash chain doing its job,
    // and the first draft of this test tripped over it. Before-and-after is the
    // right shape here anyway; deleting to make an assertion easier would have
    // been the test asking the audit trail to be less than it is.
    const count = async () =>
      (
        await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_entry
            WHERE organization_id = $1 AND action = 'LEDGER_POSTING_TRIGGER_CHANGED'`,
          [orgId],
        )
      ).rows[0].n;
    const before = await count();
    const result = await withOrg(orgId, (tx) =>
      outbox.setPostingTrigger(tx, actor, 'AP_QUEUE'),
    );
    expect(result).toBeNull();
    expect(await count()).toBe(before);
  });

  it('switching to AUTOMATIC does NOT release what is already held', async () => {
    // The surprising half, and the one the screen states. Those rows were
    // approved while a person was meant to decide.
    await approvedReport('still held');
    await withOrg(orgId, (tx) => outbox.setPostingTrigger(tx, actor, 'AUTOMATIC'));
    const queue = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(queue[0].status).toBe('HELD');
  });
});
