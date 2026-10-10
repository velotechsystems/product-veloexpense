// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * The shared discussion thread: read and post, for expense reports and travel requests.
 *
 * The only thing here that can be dangerously wrong is access. A thread is a conversation
 * about money — "this hotel was over policy because…" — so a thread visible to somebody who
 * cannot see the report it discusses is a disclosure, and it would not look like one: the
 * report stays hidden, only the sentences about it leak.
 *
 * So the tests are mostly about who is refused. The router delegates to the SAME check that
 * governs the subject itself (`canViewReport`, travel's `canRead`) rather than re-deriving
 * it, and these assert that delegation holds at the boundary — including that a subject
 * which does not exist is refused identically to one the caller cannot see, so the endpoint
 * cannot be used to discover which ids are real.
 *
 * Gated on DATABASE_URL; the hermetic run skips it.
 *
 * VeloExpense: ExpenseOS's `comments.db.test.ts` (550b2945), ported with w2-02a (d37) on
 * VeloExpense's harness (the suite's own tenant and people, every call under RLS). The two
 * travel cases arrive with travel. Adaptations, each marked: activity rows are read and
 * planted with SQL (no Prisma model; the type column is `event_type`), and a thread item
 * carries VeloExpense's `note` and `assignee` alongside ExpenseOS's keys.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

/** A plain employee: no read-all, no reimburse. */
const OWN_PERMS = [P.expense.report.readOwn, P.expense.report.updateOwn];

describe.skipIf(!process.env.DATABASE_URL)('comments router (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let makeCaller: (userId: string, perms?: readonly string[]) => any;
  let ownerId: string;
  let strangerId: string;

  beforeAll(async () => {
    /**
     * Two users with NO manager relationship between them.
     *
     * `canViewReport` grants a submitter's direct manager sight of it, so picking two
     * arbitrary users risks the "stranger" being the owner's manager — the refusal tests
     * would then fail for a legitimate reason and look like a bug in the router.
     *
     * VeloExpense: the harness's two people, neither the other's manager.
     */
    h = await createTenantHarness({
      slug: 'comments',
      name: 'Comments',
      people: [
        { email: 'owner@comments.test', name: 'Owner' },
        { email: 'stranger@comments.test', name: 'Stranger' },
      ],
    });
    db = h.db;
    ownerId = h.people[1].id;
    strangerId = h.people[2].id;
    const { commentsRouter } = await import('./comments');
    makeCaller = (userId, perms = OWN_PERMS) => h.makeCaller(perms, userId, commentsRouter);
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  const newReport = async () =>
    (
      await db.expenseReport.create({
        data: {
          title: `comments fixture ${Date.now()}`,
          submitterId: ownerId,
          // VeloExpense: a currency is keyed by its code.
          currencyId: 'CAD',
          status: 'SUBMITTED',
        },
        select: { id: true },
      })
    ).id as string;

  /** VeloExpense: the activity on a subject, read as the superuser. */
  const activitiesOn = async (subjectId: string) =>
    (
      await h.admin.query(
        `SELECT id, event_type, payload FROM activity WHERE subject_id = $1 ORDER BY occurred_at, id`,
        [subjectId],
      )
    ).rows as { id: string; event_type: string; payload: Record<string, unknown> }[];

  /** VeloExpense: plant an activity row directly, as ExpenseOS's `db.activity.create`. */
  const plant = (subjectId: string, eventType: string, payload: Record<string, unknown>) =>
    h.admin.query(
      `INSERT INTO activity (organization_id, subject_type, subject_id, event_type, actor_id, payload)
       VALUES ($1, 'EXPENSE_REPORT', $2, $3, $4, $5::jsonb)`,
      [h.orgId, subjectId, eventType, ownerId, JSON.stringify(payload)],
    );

  describe('posting and reading', () => {
    it('round-trips a comment on an expense report', async () => {
      const subjectId = await newReport();
      const caller = makeCaller(ownerId);
      await caller.post({
        subjectType: 'EXPENSE_REPORT',
        subjectId,
        body: 'Rebooked after the cancellation.',
      });

      const thread = await caller.thread({ subjectType: 'EXPENSE_REPORT', subjectId });
      expect(thread.items).toHaveLength(1);
      expect(thread.items[0]).toMatchObject({
        type: 'COMMENT',
        body: 'Rebooked after the cancellation.',
        via: 'app',
      });
      expect(thread.items[0].author).not.toBeNull();
    });

    // VeloExpense: "round-trips a comment on a travel request" arrives with travel.

    it('marks an in-app comment `via: app`, distinct from an emailed reply', async () => {
      /**
       * The thread renders this: a reply that arrived from somebody's inbox is labelled as
       * one, so a terse answer reads as a phone reply rather than as curtness. That only
       * works if the in-app path tags itself too — otherwise `via` is null half the time and
       * the UI cannot tell "typed here" from "unknown".
       */
      const subjectId = await newReport();
      await makeCaller(ownerId).post({
        subjectType: 'EXPENSE_REPORT',
        subjectId,
        body: 'Typed in the app.',
      });
      const [stored] = await activitiesOn(subjectId);
      expect(stored?.payload.via).toBe('app');
    });

    it('does not expose payload keys other than the body and channel', async () => {
      /**
       * The thread is a read endpoint over a Json column shared with every other activity
       * type. Passing the payload through wholesale would surface whatever else is in
       * there — and "whatever else" is not fixed, so it cannot be reviewed once and
       * trusted.
       *
       * The activity is written DIRECTLY with an extra key rather than through `post`,
       * because a comment the router itself wrote only ever contains keys the router
       * already returns — so nothing would leak and the test would pass against a
       * spread-everything implementation. This is the shape a future event type, or a
       * hand-repaired row, actually takes.
       *
       * VeloExpense: plus `note` and `assignee` (d37) — null on a comment.
       */
      const subjectId = await newReport();
      await plant(subjectId, 'COMMENT', {
        body: 'Body only.',
        via: 'app',
        internalNote: 'must not be returned',
        note: 'nor this, on a comment',
      });

      const thread = await makeCaller(ownerId).thread({ subjectType: 'EXPENSE_REPORT', subjectId });
      expect(Object.keys(thread.items[0]).sort()).toEqual(
        ['assignee', 'author', 'body', 'createdAt', 'id', 'note', 'type', 'via'].sort(),
      );
      expect(JSON.stringify(thread.items[0])).not.toContain('must not be returned');
      expect(thread.items[0].note).toBeNull();
    });

    it('interleaves system events with comments, oldest first', async () => {
      /**
       * One chronological stream. "Returned by Ana" and the comment explaining why are the
       * same conversation, and the reader should not have to merge two lists to see the
       * order they happened in.
       *
       * VeloExpense: a RETURNED event, as VeloExpense records no SUBMITTED activity.
       */
      const subjectId = await newReport();
      const caller = makeCaller(ownerId);
      // A system event recorded before the comment.
      await plant(subjectId, 'RETURNED', { note: 'Attach the receipt.' });
      await caller.post({ subjectType: 'EXPENSE_REPORT', subjectId, body: 'After the event.' });

      const thread = await caller.thread({ subjectType: 'EXPENSE_REPORT', subjectId });
      expect(thread.items.map((i: { type: string }) => i.type)).toEqual(['RETURNED', 'COMMENT']);
      // A non-comment event carries no body — the UI renders it as a verb, not a bubble.
      expect(thread.items[0].body).toBeNull();
      // VeloExpense (d37): …but it carries its reason.
      expect(thread.items[0].note).toBe('Attach the receipt.');
    });

    it('does not notify the author of their own comment', async () => {
      /**
       * The fan-out goes to the OTHER participants. On a report with no approval instance
       * the submitter is the only one, so posting must send nothing — an implementation
       * that notified the whole participant list would email the person who just clicked
       * Post, which reads as the system arguing with itself.
       */
      const subjectId = await newReport();
      await makeCaller(ownerId).post({ subjectType: 'EXPENSE_REPORT', subjectId, body: 'Note to self.' });
      const [row] = await activitiesOn(subjectId);
      const sent = await h.admin.query('SELECT count(*)::int AS n FROM notification WHERE activity_id = $1', [
        row?.id,
      ]);
      expect(sent.rows[0].n, 'the author was notified of their own comment').toBe(0);
    });

    it('rejects an empty body at the boundary', async () => {
      const subjectId = await newReport();
      const caller = makeCaller(ownerId);
      await expect(
        caller.post({ subjectType: 'EXPENSE_REPORT', subjectId, body: '   ' }),
      ).rejects.toThrow();
    });

    it('VeloExpense: tells the others on the thread — an approver a task touched — in-app only', async () => {
      // The fan-out is to participants; a comment defaults to in-app (no email), as in
      // ExpenseOS.
      const subjectId = await newReport();
      const request = (
        await h.admin.query(
          `INSERT INTO approval_request (organization_id, report_id, policy_snapshot, status, total_steps,
                                         subject_total_minor, subject_currency_code, opened_by_id)
           VALUES ($1, $2, '{}'::jsonb, 'RUNNING', 1, 100, 'CAD', $3) RETURNING id`,
          [h.orgId, subjectId, ownerId],
        )
      ).rows[0].id;
      const approverId = h.people[0].id;
      await h.admin.query(
        `INSERT INTO approval_task (organization_id, request_id, step, assignee_id) VALUES ($1, $2, 1, $3)`,
        [h.orgId, request, approverId],
      );
      await makeCaller(ownerId).post({
        subjectType: 'EXPENSE_REPORT',
        subjectId,
        body: 'The receipt is attached now.',
      });
      const [row] = await activitiesOn(subjectId);
      const sent = await h.admin.query(
        `SELECT n.recipient_id, (SELECT count(*)::int FROM notification_delivery d WHERE d.notification_id = n.id) AS deliveries
           FROM notification n WHERE n.activity_id = $1`,
        [row?.id],
      );
      expect(sent.rows).toEqual([{ recipient_id: approverId, deliveries: 0 }]);
      // The approver reads the thread, as somebody a task touched.
      const thread = await makeCaller(approverId, []).thread({ subjectType: 'EXPENSE_REPORT', subjectId });
      expect(thread.items.map((i: { body: string | null }) => i.body)).toEqual([
        'The receipt is attached now.',
      ]);
    });
  });

  describe('access', () => {
    it('refuses a report thread to somebody who cannot see the report', async () => {
      // The disclosure this endpoint could cause: the report stays hidden and only the
      // sentences about it leak.
      const subjectId = await newReport();
      const stranger = makeCaller(strangerId);
      await expect(stranger.thread({ subjectType: 'EXPENSE_REPORT', subjectId })).rejects.toThrow(
        /FORBIDDEN|forbidden/i,
      );
    });

    it('refuses POSTING to a report thread the caller cannot see', async () => {
      // Read and write are checked separately; a router that guarded only the query would
      // let a stranger put words into a thread they cannot read.
      const subjectId = await newReport();
      const stranger = makeCaller(strangerId);
      await expect(
        stranger.post({
          subjectType: 'EXPENSE_REPORT',
          subjectId,
          body: 'I should not be here.',
        }),
      ).rejects.toThrow(/FORBIDDEN|forbidden/i);
      expect(await activitiesOn(subjectId)).toHaveLength(0);
    });

    // VeloExpense: "refuses a travel thread to a stranger" arrives with travel.

    it('ALLOWS somebody with read-all, because they can see the report', async () => {
      // The check delegates to `canViewReport`, so the thread follows the report rather
      // than inventing its own narrower or wider rule.
      const subjectId = await newReport();
      const auditor = makeCaller(strangerId, [P.expense.report.readAll]);
      const thread = await auditor.thread({ subjectType: 'EXPENSE_REPORT', subjectId });
      expect(thread.items).toEqual([]);
    });

    it('ALLOWS an AP clerk, who holds reimburse rather than read-all', async () => {
      /**
       * The other half of `canViewReport`'s disjunction, and the one nobody covered.
       *
       * AP is the role that ASKS the questions a report thread exists to answer —
       * "what was this for", "where is the receipt" — so being able to read the report
       * and not the conversation about it is the wrong way round. `reimburse` is the
       * permission that means "AP works this claim"; the seeded AP Clerk holds it and
       * not `read.all`.
       */
      const subjectId = await newReport();
      const clerk = makeCaller(strangerId, [P.expense.report.reimburse]);
      await clerk.post({
        subjectType: 'EXPENSE_REPORT',
        subjectId,
        body: 'Missing the itemized receipt for the dinner — can you attach it?',
      });
      const thread = await clerk.thread({ subjectType: 'EXPENSE_REPORT', subjectId });
      // Reading AND writing: chasing a receipt is a comment, not a read.
      expect(thread.items.map((i: { body: string | null }) => i.body)).toEqual([
        'Missing the itemized receipt for the dinner — can you attach it?',
      ]);
    });

    it('refuses a nonexistent subject the same way as a forbidden one', async () => {
      /**
       * So the endpoint cannot be used to enumerate ids. A NOT_FOUND here would answer "that
       * report exists, you just cannot see it" for every id somebody tries.
       */
      const caller = makeCaller(ownerId);
      await expect(
        caller.thread({
          subjectType: 'EXPENSE_REPORT',
          subjectId: '019f851b-1738-77a9-80ce-657e28ed2b41',
        }),
      ).rejects.toThrow(/FORBIDDEN|forbidden/i);
    });

    it('refuses a subject type that has no thread', async () => {
      // The input enum is the gate. A BUDGET alert has no thread and no access rule, so it
      // must not be reachable here at all.
      const caller = makeCaller(ownerId);
      await expect(
        caller.thread({
          subjectType: 'BUDGET',
          subjectId: '019f851b-1738-77a9-80ce-657e28ed2b41',
        }),
      ).rejects.toThrow();
    });

    it("VeloExpense: lets the submitter's direct manager read it", async () => {
      const subjectId = await newReport();
      await h.admin.query(`UPDATE app_user SET manager_id = $2 WHERE id = $1`, [ownerId, strangerId]);
      try {
        const thread = await makeCaller(strangerId).thread({ subjectType: 'EXPENSE_REPORT', subjectId });
        expect(thread.items).toEqual([]);
      } finally {
        await h.admin.query(`UPDATE app_user SET manager_id = NULL WHERE id = $1`, [ownerId]);
      }
    });
  });
});
