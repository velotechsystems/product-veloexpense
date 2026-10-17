import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureReplyThread,
  findThreadByEmailToken,
  findThreadBySlack,
  issueEmailReplyToken,
  setSlackThread,
} from './replyThreads';

/**
 * Ported from ExpenseOS (1e682dd6), w5-01, unchanged: the client is stubbed, as there.
 *
 * Reply threads — the mapping from an inbound email or Slack reply back to the subject it
 * is about.
 *
 * The interesting property is that the email token is DETERMINISTIC: an HMAC over the
 * thread id rather than a random value. That is deliberate, and it is what makes replying
 * to an OLD message in a thread still work — every email in a thread carries the same
 * Reply-To, so a reply to last week's notification resolves exactly like a reply to
 * today's. A random per-message token would strand every reply but the most recent.
 *
 * The other side of that choice is that the token's secrecy rests entirely on
 * `AUTH_SECRET`. Deriving it without one must THROW rather than fall back, because a
 * guessable reply address lets anyone post a comment as somebody else.
 */

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

function stubDb() {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const db = {
    replyThread: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        calls.push({ op: 'upsert', args });
        return { id: 't1', ...(args.create as object) };
      }),
      update: vi.fn(async (args: Record<string, unknown>) => {
        calls.push({ op: 'update', args });
        return {};
      }),
      findUnique: vi.fn(async (args: Record<string, unknown>) => {
        calls.push({ op: 'findUnique', args });
        return { id: 't1' };
      }),
      findFirst: vi.fn(async (args: Record<string, unknown>) => {
        calls.push({ op: 'findFirst', args });
        return { id: 't1' };
      }),
    },
  };
  return { db: db as never, calls, spies: db.replyThread };
}

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'test-secret';
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

describe('ensureReplyThread', () => {
  it('is a get-or-create keyed on recipient × subject', async () => {
    // One thread per person per subject: two approvers on the same report each get their
    // own, so a reply is attributable.
    const { db, calls } = stubDb();
    await ensureReplyThread(db, {
      subjectType: 'EXPENSE_REPORT',
      subjectId: 'r1',
      recipientId: 'u1',
    });
    expect(calls[0].op).toBe('upsert');
    expect(calls[0].args).toMatchObject({
      where: {
        recipientId_subjectType_subjectId: {
          recipientId: 'u1',
          subjectType: 'EXPENSE_REPORT',
          subjectId: 'r1',
        },
      },
      update: {},
    });
  });

  it('updates nothing on a hit, so an existing thread keeps its Slack root', async () => {
    // `update: {}` matters — overwriting would drop slackThreadTs and orphan the Slack
    // side of an existing conversation.
    const { db, calls } = stubDb();
    await ensureReplyThread(db, { subjectType: 'X', subjectId: 'y', recipientId: 'z' });
    expect((calls[0].args as { update: object }).update).toEqual({});
  });
});

describe('issueEmailReplyToken', () => {
  it('is stable across calls for the same thread', async () => {
    /**
     * The load-bearing property. Every email in a thread must carry the same Reply-To, or
     * a reply to an older message resolves to nothing and the comment is silently lost.
     */
    const { db } = stubDb();
    const a = await issueEmailReplyToken(db, 't1');
    const b = await issueEmailReplyToken(db, 't1');
    expect(a).toBe(b);
  });

  it('differs per thread', async () => {
    const { db } = stubDb();
    expect(await issueEmailReplyToken(db, 't1')).not.toBe(await issueEmailReplyToken(db, 't2'));
  });

  it('stores the HASH, never the token', async () => {
    // The raw token is an authentication credential embedded in an email address; a stolen
    // database dump must not yield working reply addresses.
    const { db, calls } = stubDb();
    const raw = await issueEmailReplyToken(db, 't1');
    const written = (calls.at(-1)?.args as { data: { tokenHash: string } }).data;
    expect(written.tokenHash).toBe(hash(raw));
    expect(written.tokenHash).not.toBe(raw);
  });

  it('derives from AUTH_SECRET, so a different secret yields a different token', async () => {
    const { db } = stubDb();
    const first = await issueEmailReplyToken(db, 't1');
    process.env.AUTH_SECRET = 'rotated-secret';
    expect(await issueEmailReplyToken(db, 't1')).not.toBe(first);
  });

  it('matches an independently computed HMAC', async () => {
    // Pins the derivation itself: a change to the prefix or algorithm would invalidate
    // every Reply-To address already in somebody's inbox.
    const { db } = stubDb();
    const raw = await issueEmailReplyToken(db, 't1');
    expect(raw).toBe(createHmac('sha256', 'test-secret').update('reply:t1').digest('base64url'));
  });

  it('THROWS without AUTH_SECRET rather than issuing a guessable token', async () => {
    delete process.env.AUTH_SECRET;
    const { db } = stubDb();
    await expect(issueEmailReplyToken(db, 't1')).rejects.toThrow(/AUTH_SECRET is not set/);
  });

  it('is url-safe, because it becomes an email local part', async () => {
    // base64url: no `+`, `/` or `=`, any of which would break the address.
    const { db } = stubDb();
    const raw = await issueEmailReplyToken(db, 'thread-with-dashes');
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('findThreadByEmailToken', () => {
  it('looks up by hash, not by the raw token', async () => {
    const { db, calls } = stubDb();
    await findThreadByEmailToken(db, 'raw-token');
    expect(calls[0].args).toMatchObject({ where: { tokenHash: hash('raw-token') } });
  });

  it('returns null for an empty token without querying', async () => {
    // An inbound email with no token in the address must not turn into a table scan, or a
    // lookup for the empty-string hash.
    const { db, spies } = stubDb();
    expect(await findThreadByEmailToken(db, '')).toBeNull();
    expect(spies.findUnique).not.toHaveBeenCalled();
  });
});

describe('setSlackThread / findThreadBySlack', () => {
  it('records the channel and parent ts', async () => {
    const { db, calls } = stubDb();
    await setSlackThread(db, 't1', 'D123', '1770000000.1');
    expect(calls[0].args).toMatchObject({
      where: { id: 't1' },
      data: { slackChannelId: 'D123', slackThreadTs: '1770000000.1' },
    });
  });

  it('matches on channel AND parent ts together', async () => {
    // Either alone is ambiguous: one DM channel carries many threads, and a ts is only
    // unique within a channel.
    const { db, calls } = stubDb();
    await findThreadBySlack(db, 'D123', '1770000000.1');
    expect(calls[0].args).toMatchObject({
      where: { slackChannelId: 'D123', slackThreadTs: '1770000000.1' },
    });
  });

  it('returns null when either half is missing, without querying', async () => {
    const { db, spies } = stubDb();
    expect(await findThreadBySlack(db, '', '1')).toBeNull();
    expect(await findThreadBySlack(db, 'D1', '')).toBeNull();
    expect(spies.findFirst).not.toHaveBeenCalled();
  });
});
