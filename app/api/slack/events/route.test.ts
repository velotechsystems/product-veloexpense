// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  slackInboundGate: vi.fn(),
  verifySlackSignature: vi.fn(),
  findThreadBySlack: vi.fn(),
  findUnique: vi.fn(),
  ingestReplyComment: vi.fn(),
  claimOnce: vi.fn(),
  releaseClaim: vi.fn(),
  slackTenantFor: vi.fn(),
}));

/**
 * VeloExpense: the plumbing ExpenseOS's version does not have — the tenant from the host
 * (`slackTenantFor`), the gate on that tenant's transaction (`withOrg`), and the thread work
 * on its Prisma transaction (`withTenantDb`) — stubbed so the cases below run unchanged. The
 * same path against a real database is `test/slack-replies.db.test.ts`.
 */
const TX = { tenant: 'org-1' };
const DB = { user: { findUnique: h.findUnique } };
vi.mock('@/server/lib/slackTenant', () => ({ slackTenantFor: h.slackTenantFor }));
vi.mock('@/lib/tenant/context', () => ({
  withOrg: async (_org: string, fn: (tx: unknown) => unknown) => fn(TX),
}));
vi.mock('@/lib/db/prisma', () => ({
  withTenantDb: async (_org: string, fn: (db: unknown) => unknown) => fn(DB),
}));
vi.mock('@/lib/notifications/slack', () => ({
  slackInboundGate: h.slackInboundGate,
  verifySlackSignature: h.verifySlackSignature,
}));
vi.mock('@/lib/notifications/replyThreads', () => ({ findThreadBySlack: h.findThreadBySlack }));
vi.mock('@/server/lib/inboundComment', () => ({ ingestReplyComment: h.ingestReplyComment }));
vi.mock('@/server/lib/inboundDedup', () => ({
  claimOnce: h.claimOnce,
  releaseClaim: h.releaseClaim,
}));

import { resetSlackGateWarnings } from '@/server/lib/slackGateWarn';
import { POST } from './route';

/**
 * Slack Events — a reply in a notification's DM thread becomes a comment on the subject.
 *
 * This endpoint is on the public internet with no session, so everything that decides
 * WHO is speaking is asserted here. Three separate gates have to hold, and each one
 * fails open in a different direction if it is dropped:
 *
 *   · the signing secret proves the request came from Slack at all;
 *   · the ReplyThread mapping proves the message belongs to a subject we know;
 *   · the cached `slackUserId` proves the human typing is the thread's recipient —
 *     without it, anyone Slack lets into the conversation comments AS the recipient,
 *     because the comment is attributed to `thread.recipientId` and never to the sender.
 *
 * The retry contract is the other half. Slack redelivers on any non-200, so the claim
 * must be released when processing fails, and held when it succeeds. Get that backwards
 * and you either lose the comment permanently or post it repeatedly.
 */

const CFG = { ok: true, botToken: 'xoxb-1', signingSecret: 'shh' };

/** What `slackInboundGate` returns when the install cannot be used. */
const refused = (state: string, message: string) => ({ ok: false, state, message });
const THREAD = { recipientId: 'user-1', subjectType: 'EXPENSE_REPORT', subjectId: 'rep-1' };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://x/api/slack/events', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: {
        'x-slack-request-timestamp': '1700000000',
        'x-slack-signature': 'v0=deadbeef',
        ...headers,
      },
    }),
  );

const message = (over: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  event_id: 'Ev1',
  event: {
    type: 'message',
    user: 'U-slack-1',
    channel: 'D-1',
    thread_ts: '111.222',
    text: 'looks good',
    ...over,
  },
});

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.slackInboundGate.mockResolvedValue(CFG);
  resetSlackGateWarnings();
  h.verifySlackSignature.mockReturnValue(true);
  h.findThreadBySlack.mockResolvedValue(THREAD);
  h.findUnique.mockResolvedValue({ slackUserId: 'U-slack-1' });
  h.claimOnce.mockResolvedValue(true);
  h.ingestReplyComment.mockResolvedValue(undefined);
  h.releaseClaim.mockResolvedValue(undefined);
  h.slackTenantFor.mockResolvedValue('org-1');
});

describe('which tenant this is for (VeloExpense)', () => {
  it('reads the tenant from the address Slack posted to', async () => {
    await post(message(), { host: 'acme.velo.example.test' });
    expect(h.slackTenantFor).toHaveBeenCalledWith('acme.velo.example.test');
  });

  it('prefers the forwarded host, as the load balancer passes it', async () => {
    await post(message(), { host: 'internal:3000', 'x-forwarded-host': 'acme.velo.example.test' });
    expect(h.slackTenantFor).toHaveBeenCalledWith('acme.velo.example.test');
  });

  it('404s an address that names no active tenant, before reading anything', async () => {
    h.slackTenantFor.mockResolvedValue(null);
    const res = await post(message());
    expect(res.status).toBe(404);
    expect(h.slackInboundGate).not.toHaveBeenCalled();
    expect(h.claimOnce).not.toHaveBeenCalled();
  });

  it("reads the gate on that tenant's transaction", async () => {
    await post(message());
    expect(h.slackInboundGate).toHaveBeenCalledWith(TX);
  });
});

describe('proving the request came from Slack', () => {
  it('rejects a body that is not JSON', async () => {
    expect((await post('not json at all')).status).toBe(400);
  });

  it('verifies the signature over the RAW body, not the reparsed one', async () => {
    /**
     * Slack signs the exact bytes. Re-serialising the parsed object changes key order
     * and whitespace, so the computed signature would never match and every genuine
     * request would 401 — or, if someone "fixed" that by signing the reparsed form,
     * the check would stop detecting tampering.
     */
    const body = JSON.stringify(message());
    await post(body);
    expect(h.verifySlackSignature).toHaveBeenCalledWith('shh', '1700000000', body, 'v0=deadbeef');
  });

  it('401s a bad signature', async () => {
    h.verifySlackSignature.mockReturnValue(false);
    expect((await post(message())).status).toBe(401);
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
  });

  it('503s when Slack is not configured rather than accepting unsigned traffic', async () => {
    h.slackInboundGate.mockResolvedValue(refused('not-installed', 'nobody installed Slack.'));
    expect((await post(message())).status).toBe(503);
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
  });

  it('503s when the installation exists but carries no signing secret', async () => {
    h.slackInboundGate.mockResolvedValue(refused('no-signing-secret', 'no signing secret.'));
    expect((await post(message())).status).toBe(503);
  });

  it('puts the DIAGNOSIS in the 503 body, not the word "unconfigured"', async () => {
    /**
     * Slack shows the response text back in the Event Subscriptions console when a
     * delivery fails, so this is the one place an operator reads WHY without holding the
     * server log. Every refusal used to say `Slack events not configured` — including the
     * one for an install with a signing secret saved and a blank bot token, where those
     * words are simply false.
     */
    h.slackInboundGate.mockResolvedValue(
      refused('no-bot-token', 'its BOT TOKEN is blank. See docs/runbooks/slack-setup.md.'),
    );
    const res = await post(message());
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toContain('BOT TOKEN is blank');
  });

  it('logs the reason once, rather than on every redelivery', async () => {
    /**
     * Slack retries a failed delivery and then redelivers the backlog, so a line per
     * request buries itself — and no line at all is the outage nobody can see.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.slackInboundGate.mockResolvedValue(refused('no-bot-token', 'its BOT TOKEN is blank.'));
    await post(message());
    await post(message());
    await post(message());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('BOT TOKEN');
    warn.mockRestore();
  });

  it('still logs when a DIFFERENT reason appears', async () => {
    // The reasons get fixed in sequence: somebody pastes the bot token and the next thing
    // they need to hear is that the signing secret is still missing. One latch for all
    // four would have swallowed exactly that message.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.slackInboundGate.mockResolvedValue(refused('no-bot-token', 'its BOT TOKEN is blank.'));
    await post(message());
    h.slackInboundGate.mockResolvedValue(refused('no-signing-secret', 'no signing secret.'));
    await post(message());
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('the setup handshake', () => {
  it('echoes the challenge', async () => {
    const res = await post({ type: 'url_verification', challenge: 'abc123' });
    await expect(res.json()).resolves.toEqual({ challenge: 'abc123' });
  });

  it('answers even with nothing configured, so a fresh install can be verified', async () => {
    /** Slack sends the handshake BEFORE the app is usable, so requiring a stored
     *  signing secret here would make the endpoint impossible to register. */
    h.slackInboundGate.mockResolvedValue(refused('not-installed', 'nobody installed Slack.'));
    expect((await post({ type: 'url_verification', challenge: 'abc' })).status).toBe(200);
  });

  it('does not verify the signature of the handshake itself', async () => {
    // There is no signing secret to verify it WITH at the moment Slack sends it.
    h.verifySlackSignature.mockReturnValue(false);
    expect((await post({ type: 'url_verification', challenge: 'abc' })).status).toBe(200);
  });

  it('warns that the green tick is about to be a lie', async () => {
    /**
     * The confusing setup experience. The URL verifies with no installation and no signing
     * secret, Slack's console goes green, the operator reads that as "events work" — and
     * every real event 503s afterwards, sometimes for days, with nothing contradicting the
     * tick. The handshake cannot be refused, so it says so instead, naming the specific
     * thing that is missing at the moment the tick appears.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.slackInboundGate.mockResolvedValue(
      refused('no-bot-token', 'its BOT TOKEN is blank. See docs/runbooks/slack-setup.md.'),
    );
    await post({ type: 'url_verification', challenge: 'abc' });
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toContain('BOT TOKEN is blank');
    expect(said).toContain('503');
    warn.mockRestore();
  });

  it('says nothing when the install is complete', async () => {
    // A correctly configured app re-verifying its URL is not a problem, and a warning on
    // the happy path is how the real one stops being read.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await post({ type: 'url_verification', challenge: 'abc' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('echoes an empty string when Slack sends no challenge', async () => {
    const res = await post({ type: 'url_verification' });
    await expect(res.json()).resolves.toEqual({ challenge: '' });
  });
});

describe('turning a reply into a comment', () => {
  it('ingests the reply against the thread’s subject', async () => {
    await post(message());
    expect(h.ingestReplyComment).toHaveBeenCalledWith({
      subjectType: 'EXPENSE_REPORT',
      subjectId: 'rep-1',
      actorId: 'user-1',
      body: 'looks good',
      via: 'slack',
      // VeloExpense: on the tenant's transaction, which the lookup ran on too.
      db: DB,
    });
  });

  it('attributes the comment to the THREAD recipient, not the sender', async () => {
    /**
     * The sender is only ever checked for equality; `actorId` comes from the thread.
     * That is deliberate — it means a mismatch must be refused rather than attributed,
     * which the next test covers.
     */
    await post(message());
    expect(h.ingestReplyComment.mock.calls[0]?.[0].actorId).toBe('user-1');
  });

  it('unescapes Slack mrkdwn entities', async () => {
    await post(message({ text: '&lt;b&gt; &amp; done' }));
    expect(h.ingestReplyComment.mock.calls[0]?.[0].body).toBe('<b> & done');
  });

  it('ingests an empty body rather than dropping the reply', async () => {
    await post(message({ text: undefined }));
    expect(h.ingestReplyComment.mock.calls[0]?.[0].body).toBe('');
  });

  it('looks the thread up by channel AND thread root', async () => {
    await post(message());
    expect(h.findThreadBySlack).toHaveBeenCalledWith(DB, 'D-1', '111.222');
  });
});

describe('replies it must ignore', () => {
  /** Each of these is a message Slack delivers to the same endpoint. Ingesting any of
   *  them posts a comment nobody wrote. */
  const ignored: Array<[string, Record<string, unknown>]> = [
    ['our own bot posting the notification', { bot_id: 'B1' }],
    ['an edit, join, or other subtype', { subtype: 'message_changed' }],
    ['a top-level message outside any thread', { thread_ts: undefined }],
    ['a message with no sender', { user: undefined }],
    ['a message with no channel', { channel: undefined }],
    ['a non-message event such as a reaction', { type: 'reaction_added' }],
  ];

  for (const [what, over] of ignored) {
    it(`ignores ${what}`, async () => {
      const res = await post(message(over));
      expect(h.ingestReplyComment).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
    });
  }

  it('ignores an event_callback carrying no event at all', async () => {
    const res = await post({ type: 'event_callback', event_id: 'Ev1' });
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('ignores a reply in a thread we have no mapping for', async () => {
    h.findThreadBySlack.mockResolvedValue(null);
    await post(message());
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
  });

  it('refuses a replier who is not the thread recipient', async () => {
    /**
     * The load-bearing one. The comment is attributed to `thread.recipientId`, so
     * without this check anyone else in the conversation posts AS the recipient —
     * an approval discussion where the words are signed by the wrong person.
     */
    h.findUnique.mockResolvedValue({ slackUserId: 'U-someone-else' });
    await post(message());
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
  });

  it('refuses when the recipient row has gone', async () => {
    h.findUnique.mockResolvedValue(null);
    await post(message());
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
  });

  it('refuses a recipient who has never linked Slack', async () => {
    /** A null cached id must not compare equal to a null-ish sender. */
    h.findUnique.mockResolvedValue({ slackUserId: null });
    await post(message());
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
  });

  it('ignores a type it does not handle', async () => {
    const res = await post({ type: 'app_rate_limited' });
    expect(h.claimOnce).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

describe('the retry contract with Slack', () => {
  it('claims the event id so a redelivery cannot double-post', async () => {
    // VeloExpense: scoped to the tenant as well — each tenant's app is its own Slack app.
    await post(message());
    expect(h.claimOnce).toHaveBeenCalledWith('slack:org-1:Ev1');
  });

  it('drops a redelivery that lost the claim, without reprocessing', async () => {
    h.claimOnce.mockResolvedValue(false);
    const res = await post(message());
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('keeps the claim after a successful ingest', async () => {
    /** Releasing on success would let the next redelivery post the comment twice. */
    await post(message());
    expect(h.releaseClaim).not.toHaveBeenCalled();
  });

  it('releases the claim and 500s when processing fails, so Slack retries', async () => {
    /**
     * The whole reason this is synchronous. The previous fire-and-forget shape
     * answered 200 immediately, so a transient failure lost the comment permanently —
     * Slack had no reason to try again.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.ingestReplyComment.mockRejectedValue(new Error('db down'));
    const res = await post(message());
    expect(res.status).toBe(500);
    expect(h.releaseClaim).toHaveBeenCalledWith('slack:org-1:Ev1');
    warn.mockRestore();
  });

  it('logs the failure it is asking Slack to retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.ingestReplyComment.mockRejectedValue(new Error('db down'));
    await post(message());
    expect(warn).toHaveBeenCalledWith('[slack:events] failed', expect.any(Error));
    warn.mockRestore();
  });
});
