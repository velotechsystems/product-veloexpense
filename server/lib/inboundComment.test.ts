import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A reply in email or Slack, turned into a comment.
 *
 * The channel proves WHO — a verified reply token, or a Slack thread mapped to its subject
 * — and this proves WHERE: the replier has to already be on the thread. Those are two
 * different questions, and the second is the one that stops a reply channel being used to
 * reach a subject somebody was never part of.
 *
 * The bug this file exists to have fixed is worth keeping in view: actionable
 * approve/reject shipped for every subject, so a manager could decide an expense report
 * from their inbox — but typing a sentence back instead of pressing a button did nothing.
 * The reply was accepted, verified, parsed, and dropped on the floor at a hardcoded
 * `VIRTUAL_CARD_REQUEST` check.
 *
 * Ported from ExpenseOS (1e682dd6), w5-01. VeloExpense, marked below: the notification
 * service is VeloExpense's (`eventType`, and the report's placeholders in the payload); the
 * only subject with a thread is the expense report, so the travel/card case is not ported;
 * and a failed fan-out rolls the comment back rather than being logged past.
 */

const h = vi.hoisted(() => ({
  participants: ['sub-1', 'mgr-1'] as string[],
  stripped: null as string | null,
  activities: [] as Array<Record<string, unknown>>,
  notified: [] as Array<{ activityId: string; recipients: string[] }>,
  notifyError: null as Error | null,
}));

// VeloExpense: the activity service takes the bridged transaction; the stub passes it through.
vi.mock('@/lib/db/prisma-pg-bridge', () => ({ queryRunnerOf: (db: unknown) => db }));
vi.mock('./snsEmail', () => ({
  // The real one strips quoted history; here it is identity unless a test says otherwise,
  // so the assertions are about this file rather than about the stripper.
  stripQuotedReply: (body: string) => h.stripped ?? body,
}));
vi.mock('./threadParticipants', () => ({
  threadParticipants: async () => h.participants,
}));
vi.mock('@/lib/notifications/service', () => ({
  recordActivity: async (_db: unknown, entry: Record<string, unknown>) => {
    h.activities.push(entry);
    return `act-${h.activities.length}`;
  },
  reportPayload: (r: { title: string }) => ({ report: r.title, number: '', total: '' }),
  travelPayload: (t: { destinationLabel: string; number: string | null }) => ({
    request: t.destinationLabel,
    number: t.number ?? '',
    total: '',
  }),
  notifyRecipients: async (_db: unknown, activityId: string, recipients: string[]) => {
    if (h.notifyError) throw h.notifyError;
    h.notified.push({ activityId, recipients });
  },
}));

import { ingestReplyComment } from './inboundComment';

const reply = (over: Record<string, unknown> = {}) =>
  ingestReplyComment({
    subjectType: 'EXPENSE_REPORT',
    subjectId: 'r-1',
    actorId: 'mgr-1',
    body: 'Looks fine to me.',
    via: 'email' as const,
    // VeloExpense: the tenant's transaction, with the report the payload is read from.
    db: {
      expenseReport: {
        findUnique: async () => ({ title: 'Lisbon', number: 'R-1', totalMinor: 0n, currencyId: 'CAD' }),
      },
    } as never,
    ...over,
  });

beforeEach(() => {
  h.participants = ['sub-1', 'mgr-1'];
  h.stripped = null;
  h.activities = [];
  h.notified = [];
  h.notifyError = null;
});

describe('what it records', () => {
  it('records the comment against the subject the reply arrived on', async () => {
    /**
     * The line that was hardcoded to VIRTUAL_CARD_REQUEST. Every subject with a thread has
     * to work, or the feature is "you can reply, sometimes, and nothing tells you which".
     */
    await expect(reply()).resolves.toBe(true);
    expect(h.activities[0]).toMatchObject({
      subjectType: 'EXPENSE_REPORT',
      subjectId: 'r-1',
      eventType: 'COMMENT',
      actorId: 'mgr-1',
      payload: { body: 'Looks fine to me.', via: 'email', report: 'Lisbon' },
    });
  });

  it('works for a travel request', async () => {
    // VeloExpense (w6-01): ExpenseOS's "works for a travel request, a card request, a limit
    // increase", for the travel request (cards are out of scope). The trip's placeholders
    // ride on the comment, as the report's do.
    await expect(
      reply({
        subjectType: 'TRAVEL_REQUEST',
        subjectId: 't-1',
        db: {
          travelRequest: {
            findUnique: async () => ({
              number: 'TRV-000001',
              destinationLabel: 'Montréal',
              currencyId: 'CAD',
              approvedTotalMinor: null,
              budgetLines: [{ amountMinor: 45000n }],
            }),
          },
        } as never,
      }),
    ).resolves.toBe(true);
    expect(h.activities[0]).toMatchObject({
      subjectType: 'TRAVEL_REQUEST',
      subjectId: 't-1',
      payload: { body: 'Looks fine to me.', request: 'Montréal', number: 'TRV-000001' },
    });
  });

  it('records which channel it came from', async () => {
    /** A Slack reply and an email reply render differently in the timeline, and "where did
     *  this come from" is the first question about a comment nobody remembers writing. */
    await reply({ via: 'slack' });
    expect(h.activities[0]).toMatchObject({ payload: { via: 'slack' } });
  });

  it('tells everybody on the thread except the replier', async () => {
    await reply();
    expect(h.notified[0].recipients).toEqual(['sub-1']);
  });
});

describe('the body', () => {
  it('drops the quoted history an email client appends', async () => {
    /** Otherwise every reply carries the entire thread and the timeline becomes
     *  unreadable after three exchanges. */
    h.stripped = 'Just this part.';
    await reply({ body: 'Just this part.\n> On Monday, somebody wrote:\n> the whole thread' });
    expect(h.activities[0]).toMatchObject({ payload: { body: 'Just this part.' } });
  });

  it('refuses a reply that is empty once the quotes are gone', async () => {
    /** A "thanks" auto-reply, or a bare forward. A comment with no content is noise on a
     *  thread somebody is trying to read. */
    h.stripped = '   ';
    await expect(reply()).resolves.toBe(false);
    expect(h.activities).toHaveLength(0);
  });

  it('caps a runaway body rather than storing it whole', async () => {
    /** Mail loops and pasted logs. 4000 characters is a long comment; a megabyte is an
     *  incident. */
    h.stripped = 'x'.repeat(10_000);
    await reply();
    expect((h.activities[0].payload as { body: string }).body).toHaveLength(4000);
  });

  it('trims after capping, so a truncated body cannot end in whitespace', async () => {
    h.stripped = `${'x'.repeat(10)}   `;
    await reply();
    expect((h.activities[0].payload as { body: string }).body).toBe('x'.repeat(10));
  });
});

describe('authorization', () => {
  it('refuses somebody who is not on the thread', async () => {
    /**
     * The token proves who they are; it does not prove they belong here. Without this, a
     * reply channel becomes a way to post onto any subject whose id somebody can name.
     */
    h.participants = ['sub-1', 'mgr-1'];
    await expect(reply({ actorId: 'stranger' })).resolves.toBe(false);
    expect(h.activities).toHaveLength(0);
  });

  it('refuses a reply to a subject with no thread at all', async () => {
    h.participants = [];
    await expect(reply()).resolves.toBe(false);
  });

  it('checks membership before recording anything', async () => {
    // Not after: a comment recorded and then found unauthorized is already in the
    // timeline, and the fan-out has already gone out.
    h.participants = [];
    await reply();
    expect(h.activities).toHaveLength(0);
    expect(h.notified).toHaveLength(0);
  });
});

describe('the fan-out', () => {
  it('fails the whole reply when notifying fails, so a retry posts it once', async () => {
    /**
     * VeloExpense: the opposite of ExpenseOS's "still counts the comment as recorded". The
     * fan-out runs on the job's own transaction, where a failed statement has already aborted
     * it — so a caught failure would report a comment that was never written. Thrown, the job
     * rolls back as a whole and its retry is the only copy.
     */
    h.notifyError = new Error('notifications down');
    await expect(reply()).rejects.toThrow('notifications down');
  });

  it('notifies nobody when the replier is the only participant', async () => {
    h.participants = ['mgr-1'];
    await expect(reply()).resolves.toBe(true);
    expect(h.notified[0].recipients).toEqual([]);
  });
});
