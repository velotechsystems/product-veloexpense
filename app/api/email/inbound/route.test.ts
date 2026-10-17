// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  update: vi.fn(),
  findUnique: vi.fn(),
  enqueue: vi.fn(),
  findThreadByEmailToken: vi.fn(),
  head: vi.fn(),
  getViewUrl: vi.fn(),
  simpleParser: vi.fn(),
  ingestReplyComment: vi.fn(),
  claimOnce: vi.fn(),
  releaseClaim: vi.fn(),
  throttle: vi.fn(),
  // VeloExpense: the tenant lookup by the address's label (d47).
  orgQuery: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  createVerify: () => ({ update: h.update, verify: h.verify }),
}));
// VeloExpense: no thread lookup, stored-message read or comment ingest here — since w5-01 the
// reply path hands the message to the worker (`email.ingestReply`), whose checks are in
// test/reply-threads.db.test.ts. Their doubles stay in `h` so the moved cases' expectations
// that nothing was read or posted still read as ExpenseOS wrote them.
vi.mock('@expenseos/jobs', () => ({ enqueue: h.enqueue }));
vi.mock('mailparser', () => ({ simpleParser: h.simpleParser }));
vi.mock('@/lib/tenant/context', () => ({
  withoutOrg: async (fn: (tx: { query: typeof h.orgQuery }) => unknown) => fn({ query: h.orgQuery }),
}));
vi.mock('@/server/lib/inboundDedup', () => ({
  claimOnce: h.claimOnce,
  releaseClaim: h.releaseClaim,
}));
vi.mock('@/server/lib/rateLimit', () => ({ throttle: h.throttle }));

/**
 * Inbound email — SES receipt rule → SNS → here. Two mailboxes, one path.
 *
 * This is the only endpoint in the product that writes on behalf of somebody purely on the
 * strength of an email, so the whole first half of the file is proving the message is real:
 * the SNS signature (only AWS can drive it — and only a cert from an SNS host can vouch for
 * it, because any S3 bucket answers under `*.amazonaws.com`), the topic ARN (an SNS signing
 * cert is shared across every topic in a region, so a valid signature alone is not enough),
 * the SES SPF/DKIM verdicts, the ALIGNMENT of the From with whichever domain those verdicts
 * were about (a pass on the attacker's own domain used to file receipts as anyone), and
 * finally an exact From match against the thread's recipient.
 *
 * The second half is about not losing anything. SNS is at-least-once, so a claim makes
 * processing idempotent — and the claim is precisely what makes a mid-flight failure
 * dangerous: holding it while answering 200 loses the message twice over. That regression
 * is pinned below, because it is the one this suite was written to find.
 *
 * Environment is read at module scope, so every test loads a fresh copy of the route.
 *
 * VeloExpense: ExpenseOS's `route.test.ts` (550b2945), Wave 3 (w3-06). Every address is a
 * tenant's — `<mailbox>@northwind.<inbound domain>` (d47) — and the tenant is looked up by
 * that label. Both mailboxes hand their message to the worker (w5-01, decided 17 Oct 2026):
 * the reply-to-comment cases that checked the thread, the From against its recipient, the body
 * and the stored-message read moved with that work to `test/reply-threads.db.test.ts`, and
 * what is left here is the route's half — that a reply is authenticated like any message and
 * enqueued with its token, sender and tenant. Cases that used the reply address only as a
 * carrier use the receipts one, so they still observe something. VeloExpense's own cases
 * (the tenant in the address) close the file.
 */

const TOPIC = 'arn:aws:sns:us-east-1:1:expenseos-inbound';
const CERT_URL = 'https://sns.us-east-1.amazonaws.com/cert.pem';

const ENV: Record<string, string> = {
  INBOUND_EMAIL_DOMAIN: 'expenseos.dev.internal.e.inc',
  INBOUND_SNS_TOPIC_ARN: TOPIC,
  INBOUND_RECEIPTS_MAILBOXES: 'receipts',
  INBOUND_REPLY_MAILBOXES: 'reply',
};

/** A fresh route module, with `env` merged over the defaults. Values set to `null` are
 *  removed, so "unconfigured" can be tested as well as "misconfigured". */
async function load(env: Record<string, string | null> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...ENV, ...env })) {
    if (v === null) vi.stubEnv(k, undefined as unknown as string);
    else vi.stubEnv(k, v);
  }
  return (await import('./route')).POST;
}

const sns = (over: Record<string, unknown> = {}) => ({
  Type: 'Notification',
  MessageId: 'sns-1',
  TopicArn: TOPIC,
  Timestamp: '2026-08-25T00:00:00.000Z',
  Signature: 'c2ln',
  SignatureVersion: '1',
  SigningCertURL: CERT_URL,
  ...over,
});

const ses = (over: Record<string, unknown> = {}) => ({
  notificationType: 'Received',
  mail: {
    source: 'dana@e.inc',
    messageId: 'ses-1',
    destination: ['reply+tok1@northwind.expenseos.dev.internal.e.inc'],
    commonHeaders: { from: ['dana@e.inc'] },
  },
  receipt: {
    recipients: ['reply+tok1@northwind.expenseos.dev.internal.e.inc'],
    spfVerdict: { status: 'PASS' },
    dkimVerdict: { status: 'PASS' },
    dmarcVerdict: { status: 'PASS' },
    spamVerdict: { status: 'PASS' },
    virusVerdict: { status: 'PASS' },
  },
  ...over,
});

/** VeloExpense (w5-01): a reply-mailbox notification, stored to S3 as the SES rule stores
 *  every message. */
const replySes = (over: Record<string, unknown> = {}) =>
  ses({
    receipt: { ...ses().receipt, action: { type: 'S3', bucketName: 'mail-bucket', objectKey: 'inbound/r1' } },
    ...over,
  });

/** A receipts-mailbox notification with the S3 action SES uses for large messages. */
const receiptsSes = (over: Record<string, unknown> = {}) =>
  ses({
    mail: {
      source: 'Dana Patel <dana@e.inc>',
      messageId: 'ses-2',
      destination: ['receipts+tok9@northwind.expenseos.dev.internal.e.inc'],
      commonHeaders: { from: ['Dana Patel <dana@e.inc>'] },
    },
    receipt: {
      recipients: ['receipts+tok9@northwind.expenseos.dev.internal.e.inc'],
      spfVerdict: { status: 'PASS' },
      dkimVerdict: { status: 'PASS' },
      dmarcVerdict: { status: 'PASS' },
      spamVerdict: { status: 'PASS' },
      virusVerdict: { status: 'PASS' },
      action: { type: 'S3', bucketName: 'mail-bucket', objectKey: 'inbound/abc' },
    },
    ...over,
  });

const call = async (POST: (r: Request) => Promise<Response>, envelope: Record<string, unknown>) =>
  POST(
    new Request('http://x/api/email/inbound', { method: 'POST', body: JSON.stringify(envelope) }),
  );

/** `sns()` carrying a SES notification as its Message string. */
const notification = (inner: unknown, over: Record<string, unknown> = {}) =>
  sns({ Message: JSON.stringify(inner), ...over });

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.verify.mockReturnValue(true);
  h.claimOnce.mockResolvedValue(true);
  h.releaseClaim.mockResolvedValue(undefined);
  h.throttle.mockResolvedValue({ allowed: true });
  h.enqueue.mockResolvedValue(undefined);
  h.orgQuery.mockResolvedValue({ rows: [{ id: 'org-1' }] });
  h.findThreadByEmailToken.mockResolvedValue({
    recipientId: 'u-1',
    subjectType: 'EXPENSE_REPORT',
    subjectId: 'rep-1',
  });
  h.findUnique.mockResolvedValue({ email: 'dana@e.inc' });
  h.head.mockResolvedValue({ size: 1000 });
  h.getViewUrl.mockResolvedValue('https://s3.test/obj');
  h.simpleParser.mockResolvedValue({ text: 'looks fine to me' });
  h.ingestReplyComment.mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('cert-bytes')),
  );
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  warn.mockRestore();
  error.mockRestore();
});

describe('proving the message came from our SNS topic', () => {
  it('400s a body that is not JSON', async () => {
    const POST = await load();
    const res = await POST(new Request('http://x', { method: 'POST', body: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('401s a bad signature', async () => {
    h.verify.mockReturnValue(false);
    const POST = await load();
    expect((await call(POST, notification(ses()))).status).toBe(401);
  });

  it('401s a message with no signature at all', async () => {
    const POST = await load();
    expect((await call(POST, notification(ses(), { Signature: undefined }))).status).toBe(401);
  });

  it('401s a signing cert served over plain http', async () => {
    const POST = await load();
    const res = await call(
      POST,
      notification(ses(), { SigningCertURL: 'http://sns.us-east-1.amazonaws.com/c.pem' }),
    );
    expect(res.status).toBe(401);
  });

  it('401s a signing cert on an AWS host that is not SNS — an S3 bucket, say', async () => {
    /**
     * The hole this test exists to keep closed. Every S3 bucket is served under
     * `<bucket>.s3.amazonaws.com`, so a suffix match on `amazonaws.com` let an attacker host
     * a self-signed PEM in their own bucket, sign the canonical string with the matching key,
     * and drive the only authentication this endpoint has. The topic-ARN pin is INSIDE the
     * signed string, so it offered nothing against a forged signature.
     */
    const POST = await load();
    for (const host of [
      'https://evil.s3.amazonaws.com/cert.pem',
      'https://evil.s3.us-east-1.amazonaws.com/cert.pem',
      'https://abc123.execute-api.us-east-1.amazonaws.com/cert.pem',
      'https://sns.us-east-1.amazonaws.com.evil.test/cert.pem',
      'https://xsns.us-east-1.amazonaws.com/cert.pem',
    ]) {
      const res = await call(POST, notification(ses(), { SigningCertURL: host }));
      expect(res.status, host).toBe(401);
    }
    // Never even fetched: the URL is refused before any request leaves this server.
    expect(fetch).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('401s a signing cert URL on the right host but not a .pem path', async () => {
    const POST = await load();
    const res = await call(
      POST,
      notification(ses(), { SigningCertURL: 'https://sns.us-east-1.amazonaws.com/?Action=x' }),
    );
    expect(res.status).toBe(401);
  });

  it('accepts the regional SNS hosts, including the China partition', async () => {
    const POST = await load();
    for (const url of [
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem',
      'https://sns.ca-central-1.amazonaws.com/x.pem',
      'https://sns.cn-north-1.amazonaws.com.cn/x.pem',
    ]) {
      const res = await call(POST, notification(ses(), { SigningCertURL: url }));
      expect(res.status, url).toBe(200);
    }
  });

  it('401s a signing cert hosted somewhere that is not AWS', async () => {
    /** The cert URL is attacker-controlled input. Fetching it from anywhere would let
     *  somebody sign their own messages with their own certificate. */
    const POST = await load();
    const res = await call(
      POST,
      notification(ses(), { SigningCertURL: 'https://amazonaws.com.evil.test/c.pem' }),
    );
    expect(res.status).toBe(401);
  });

  it('401s an unparseable signing cert URL', async () => {
    const POST = await load();
    expect((await call(POST, notification(ses(), { SigningCertURL: 'not a url' }))).status).toBe(
      401,
    );
  });

  it('verifies with SHA1 for signature version 1', async () => {
    const POST = await load();
    await call(POST, notification(ses(), { SignatureVersion: '1' }));
    expect(h.verify).toHaveBeenCalledWith('cert-bytes', 'c2ln', 'base64');
  });

  it('401s when fetching the cert fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    const POST = await load();
    expect((await call(POST, notification(ses()))).status).toBe(401);
  });

  it('401s a message from a DIFFERENT SNS topic', async () => {
    /**
     * The load-bearing one. An SNS signing cert is a public AWS certificate shared
     * across every topic and account in a region, so a valid signature alone lets ANY
     * AWS-signed message drive this endpoint. TopicArn is inside the signed canonical
     * string, so it cannot be forged for ours.
     */
    const POST = await load();
    const res = await call(
      POST,
      notification(ses(), { TopicArn: 'arn:aws:sns:us-east-1:999:someone-else' }),
    );
    expect(res.status).toBe(401);
  });

  it('fails closed when the expected topic is not configured', async () => {
    /** A misconfigured deploy must refuse everything rather than accept anything. */
    const POST = await load({ INBOUND_SNS_TOPIC_ARN: null });
    expect((await call(POST, notification(ses()))).status).toBe(401);
  });
});

describe('the subscription handshake', () => {
  const confirm = (over: Record<string, unknown> = {}) =>
    sns({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 'tk',
      ...over,
    });

  it('confirms by fetching the SubscribeURL', async () => {
    const POST = await load();
    const res = await call(POST, confirm());
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
    );
  });

  it('refuses to fetch a SubscribeURL on an AWS host that is not SNS', async () => {
    // The same suffix match made a forged SubscriptionConfirmation a blind GET from this
    // server to any AWS-hosted URL.
    const POST = await load();
    const res = await call(
      POST,
      confirm({ SubscribeURL: 'https://evil.s3.amazonaws.com/?Action=ConfirmSubscription' }),
    );
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('evil.s3'));
  });

  it('refuses to fetch a SubscribeURL that is not AWS', async () => {
    /** Confirming blindly would turn this endpoint into an SSRF gadget: SNS hands us a
     *  URL and we would fetch it from inside the VPC. */
    const POST = await load();
    const res = await call(POST, confirm({ SubscribeURL: 'https://evil.test/pwn' }));
    expect(res.status).toBe(401);
  });

  it('refuses a plain-http SubscribeURL', async () => {
    const POST = await load();
    const res = await call(POST, confirm({ SubscribeURL: 'http://sns.amazonaws.com/x' }));
    expect(res.status).toBe(401);
  });

  it('still answers 200 when the confirm fetch fails', async () => {
    /** SNS retries the handshake; failing the request achieves nothing extra. */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        if (String(u).includes('ConfirmSubscription')) throw new Error('down');
        return new Response('cert-bytes');
      }),
    );
    const POST = await load();
    expect((await call(POST, confirm())).status).toBe(200);
  });
});

describe('which messages are processed at all', () => {
  it('ignores everything when no inbound domain is configured', async () => {
    const POST = await load({ INBOUND_EMAIL_DOMAIN: null });
    await call(POST, notification(ses()));
    expect(h.claimOnce).not.toHaveBeenCalled();
  });

  it('ignores a SES payload that is not JSON', async () => {
    const POST = await load();
    const res = await call(POST, sns({ Message: 'not json' }));
    expect(res.status).toBe(200);
    expect(h.claimOnce).not.toHaveBeenCalled();
  });

  it('ignores a notification type other than Received', async () => {
    const POST = await load();
    await call(POST, notification(ses({ notificationType: 'Bounce' })));
    expect(h.claimOnce).not.toHaveBeenCalled();
  });

  it('ignores an SNS type it does not handle', async () => {
    const POST = await load();
    const res = await call(POST, sns({ Type: 'UnsubscribeConfirmation' }));
    expect(res.status).toBe(200);
    expect(h.claimOnce).not.toHaveBeenCalled();
  });

  it('claims on the SES message id', async () => {
    const POST = await load();
    await call(POST, notification(ses()));
    expect(h.claimOnce).toHaveBeenCalledWith('ses-1');
  });

  it('falls back to the SNS envelope id when SES gives none', async () => {
    const POST = await load();
    await call(
      POST,
      notification(
        ses({ mail: { source: 'dana@e.inc', commonHeaders: { from: ['dana@e.inc'] } } }),
      ),
    );
    expect(h.claimOnce).toHaveBeenCalledWith('sns-1');
  });

  it('drops a redelivery that lost the claim', async () => {
    h.claimOnce.mockResolvedValue(false);
    const POST = await load();
    // VeloExpense: through the receipts mailbox, the one that does anything here.
    await call(POST, notification(receiptsSes()));
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  // VeloExpense: ExpenseOS's list had SPF and DKIM as separate cases. Each passed only
  // because its reply-address fixture never reached a write; through the receipts mailbox
  // they would not, because either factor alone is accepted by design (`verdictsPass`: a
  // Workspace forward breaks SPF and keeps DKIM). The refusal is when both fail.
  const failing: Array<[string, Record<string, unknown>]> = [
    ['SPF and DKIM', { spfVerdict: { status: 'FAIL' }, dkimVerdict: { status: 'FAIL' } }],
    ['spam', { spamVerdict: { status: 'FAIL' } }],
    ['virus', { virusVerdict: { status: 'FAIL' } }],
  ];
  for (const [what, over] of failing) {
    it(`refuses a message that failed ${what}`, async () => {
      /** Everything downstream writes on behalf of whoever the From claims to be, so
       *  the verdicts are checked identically for both mailboxes, before anything else. */
      const POST = await load();
      // VeloExpense: through the receipts mailbox, where passing would enqueue a job.
      const base = receiptsSes();
      await call(POST, notification({ ...base, receipt: { ...base.receipt, ...over } }));
      expect(h.ingestReplyComment).not.toHaveBeenCalled();
      expect(h.enqueue).not.toHaveBeenCalled();
    });
  }

  describe('tying the From to the domain that authenticated', () => {
    /**
     * SES's SPF verdict is about the envelope sender and its DKIM verdict about whoever
     * signed; neither is required to be the domain in the From header — and the From is
     * who the receipts become an expense report FOR. Before this check, an outsider with
     * any domain that passes SPF or DKIM could write `From: cfo@e.inc` and file, with
     * hash-chained audit rows naming the CFO. The receipts mailbox is the observable path:
     * a message gets through iff a job is enqueued.
     */
    const spoofed = (
      over: Record<string, unknown> = {},
      receiptOver: Record<string, unknown> = {},
    ) => {
      const base = receiptsSes();
      return {
        ...base,
        mail: {
          ...base.mail,
          source: 'bounce@attacker.example',
          commonHeaders: { from: ['CFO <cfo@e.inc>'] },
          headers: [
            { name: 'DKIM-Signature', value: 'v=1; a=rsa-sha256; d=attacker.example; s=k1' },
          ],
          ...over,
        },
        receipt: {
          ...base.receipt,
          spfVerdict: { status: 'PASS' },
          dkimVerdict: { status: 'PASS' },
          dmarcVerdict: { status: 'FAIL' },
          ...receiptOver,
        },
      };
    };

    it('refuses a From at our domain that authenticated as somebody else’s', async () => {
      const POST = await load();
      await call(POST, notification(spoofed()));
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(h.throttle).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cfo@e\.inc is not aligned/));
    });

    it('accepts SES’s own DMARC pass as alignment already evaluated', async () => {
      const POST = await load();
      await call(POST, notification(spoofed({}, { dmarcVerdict: { status: 'PASS' } })));
      expect(h.enqueue).toHaveBeenCalledTimes(1);
    });

    it('accepts a Workspace forward: SPF fails, but the DKIM signer is the From domain', async () => {
      const POST = await load();
      await call(
        POST,
        notification(
          spoofed(
            {
              source: 'forwarder@google.com',
              headers: [{ name: 'DKIM-Signature', value: 'v=1; a=rsa-sha256; d=e.inc; s=google' }],
            },
            { spfVerdict: { status: 'FAIL' } },
          ),
        ),
      );
      expect(h.enqueue).toHaveBeenCalledTimes(1);
      expect(h.enqueue.mock.calls[0]?.[1]).toMatchObject({ claimant: 'cfo@e.inc' });
    });

    it('accepts SPF alignment on a subdomain envelope, the way DMARC’s relaxed mode does', async () => {
      const POST = await load();
      await call(
        POST,
        notification(
          spoofed(
            { source: 'bounces@mail.e.inc', headers: [] },
            { dkimVerdict: { status: 'FAIL' } },
          ),
        ),
      );
      expect(h.enqueue).toHaveBeenCalledTimes(1);
    });

    it('refuses DKIM alignment when ANY signature on the message is foreign', async () => {
      // SES reports one verdict for the whole message, so a verifying attacker signature
      // beside a forged `d=e.inc` would otherwise read as ours.
      const POST = await load();
      await call(
        POST,
        notification(
          spoofed({
            headers: [
              { name: 'DKIM-Signature', value: 'v=1; d=e.inc; s=forged' },
              { name: 'DKIM-Signature', value: 'v=1; d=attacker.example; s=k1' },
            ],
          }),
        ),
      );
      expect(h.enqueue).not.toHaveBeenCalled();
    });

    it('refuses DKIM alignment when SES truncated the header list', async () => {
      // We cannot see every signature, so we cannot say every signature is ours.
      const POST = await load();
      await call(
        POST,
        notification(
          spoofed(
            {
              headers: [{ name: 'DKIM-Signature', value: 'v=1; d=e.inc; s=google' }],
              headersTruncated: true,
            },
            { spfVerdict: { status: 'FAIL' } },
          ),
        ),
      );
      expect(h.enqueue).not.toHaveBeenCalled();
    });

    it('refuses a message with no From header, and one with two', async () => {
      const POST = await load();
      await call(
        POST,
        notification(spoofed({ commonHeaders: {} }, { dmarcVerdict: { status: 'PASS' } })),
      );
      await call(
        POST,
        notification(
          spoofed(
            { commonHeaders: { from: ['dana@e.inc', 'cfo@e.inc'] } },
            { dmarcVerdict: { status: 'PASS' } },
          ),
        ),
      );
      expect(h.enqueue).not.toHaveBeenCalled();
    });

    it('applies to the reply mailbox too', async () => {
      const POST = await load();
      const base = replySes();
      await call(
        POST,
        notification({
          ...base,
          content: Buffer.from('m').toString('base64'),
          mail: { ...base.mail, source: 'bounce@attacker.example' },
          receipt: { ...base.receipt, dmarcVerdict: { status: 'FAIL' } },
        }),
      );
      expect(h.ingestReplyComment).not.toHaveBeenCalled();
      expect(h.findThreadByEmailToken).not.toHaveBeenCalled();
      // VeloExpense: and nothing reaches the worker.
      expect(h.enqueue).not.toHaveBeenCalled();
    });
  });

  it('ignores a message addressed to neither mailbox', async () => {
    const POST = await load();
    await call(
      POST,
      notification(
        // VeloExpense: with the receipts fixture's S3 action, so a wrong match would enqueue.
        receiptsSes({
          mail: {
            source: 'dana@e.inc',
            messageId: 'ses-1',
            destination: ['someone@northwind.expenseos.dev.internal.e.inc'],
            commonHeaders: {},
          },
          receipt: { ...ses().receipt, recipients: ['someone@northwind.expenseos.dev.internal.e.inc'] },
        }),
      ),
    );
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('finds the token in the message’s own To when the envelope was rewritten', async () => {
    /**
     * `e.inc`'s MX belongs to Workspace and cannot point at SES, so mail is forwarded.
     * A full rewrite strips the token from the envelope — but not from the header the
     * sender wrote, which is where it survives.
     *
     * VeloExpense: no forwarding domain here, and the receipts mailbox carries the token —
     * the same rule, on the address the tenant's people use.
     */
    const POST = await load();
    const base = receiptsSes();
    await call(
      POST,
      notification({
        ...base,
        mail: {
          ...base.mail,
          destination: ['receipts@northwind.expenseos.dev.internal.e.inc'],
          commonHeaders: {
            to: ['receipts+tok1@northwind.expenseos.dev.internal.e.inc'],
            from: ['Dana Patel <dana@e.inc>'],
          },
        },
        receipt: { ...base.receipt, recipients: ['receipts@northwind.expenseos.dev.internal.e.inc'] },
      }),
    );
    expect(h.enqueue.mock.calls[0]?.[1]).toMatchObject({ token: 'tok1' });
  });
});

/**
 * VeloExpense (w5-01): a reply becomes a JOB here, as a receipt email does — the worker reads
 * the stored message and posts the comment, so only it reads the inbound-mail bucket (decided
 * 17 Oct 2026). ExpenseOS's "a reply becoming a comment" and "reading the stored message"
 * cases check work that moved with it: the thread lookup, the From against the thread's
 * recipient (exactly, case-insensitively), an empty or text-less body and a message over the
 * comment ceiling are asserted on `email.ingestReply` in test/reply-threads.db.test.ts.
 */
describe('a reply becoming a job', () => {
  it('enqueues the pointer, the token, the authenticated sender and the tenant', async () => {
    const POST = await load();
    await call(POST, notification(replySes()));
    expect(h.enqueue).toHaveBeenCalledWith('email.ingestReply', {
      bucket: 'mail-bucket',
      objectKey: 'inbound/r1',
      sesMessageId: 'ses-1',
      token: 'tok1',
      sender: 'dana@e.inc',
      organizationId: 'org-1',
    });
    // Nothing is read or posted here.
    expect(h.simpleParser).not.toHaveBeenCalled();
    expect(h.ingestReplyComment).not.toHaveBeenCalled();
  });

  it('ignores the reply address with no token in it', async () => {
    const POST = await load();
    const base = replySes();
    await call(
      POST,
      notification({
        ...base,
        mail: { ...base.mail, destination: ['reply@northwind.expenseos.dev.internal.e.inc'] },
        receipt: { ...base.receipt, recipients: ['reply@northwind.expenseos.dev.internal.e.inc'] },
      }),
    );
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('ignores a reply to a tenant that is not active', async () => {
    h.orgQuery.mockResolvedValue({ rows: [] });
    const POST = await load();
    await call(POST, notification(replySes()));
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('says so when the SES rule stored nothing to read', async () => {
    const POST = await load();
    await call(POST, notification(ses()));
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('needs one'));
  });
});

describe('a receipt email becoming a job', () => {
  it('enqueues the pointer rather than parsing anything here', async () => {
    /**
     * The object may be tens of megabytes and SNS redelivers a non-2xx, so a handler
     * that parsed it would be redelivered — as a duplicate expense report.
     */
    const POST = await load();
    await call(POST, notification(receiptsSes()));
    expect(h.enqueue).toHaveBeenCalledWith('email.ingestReceipts', {
      bucket: 'mail-bucket',
      objectKey: 'inbound/abc',
      sesMessageId: 'ses-2',
      mailbox: 'receipts',
      // The authenticated From, lowercased and bare: the identity the handler files as, and
      // refuses the message over if the MIME names anyone else.
      claimant: 'dana@e.inc',
      token: 'tok9',
      // VeloExpense: the tenant the address named (d47).
      organizationId: 'org-1',
    });
    expect(h.simpleParser).not.toHaveBeenCalled();
  });

  it('omits the token when the address carried none', async () => {
    const POST = await load();
    const base = receiptsSes();
    await call(
      POST,
      notification({
        ...base,
        mail: { ...base.mail, destination: ['receipts@northwind.expenseos.dev.internal.e.inc'] },
        receipt: { ...base.receipt, recipients: ['receipts@northwind.expenseos.dev.internal.e.inc'] },
      }),
    );
    expect(h.enqueue.mock.calls[0]?.[1]).not.toHaveProperty('token');
  });

  it('says so once when the SES rule has no S3 action', async () => {
    /** The message is either inline — and therefore not a receipt email — or nowhere.
     *  Failing silently would look exactly like the email never arriving. */
    const POST = await load();
    const base = receiptsSes();
    await call(POST, notification({ ...base, receipt: { ...base.receipt, action: undefined } }));
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('needs one'));
  });

  it('caps receipts per sender per hour, keyed on the authenticated From', async () => {
    // Not on the envelope sender, which anyone with a domain can rotate per message.
    const POST = await load();
    const base = receiptsSes();
    await call(
      POST,
      notification({
        ...base,
        mail: { ...base.mail, source: 'bounce-0042@mail.e.inc' },
      }),
    );
    // VeloExpense: per tenant as well, since an address is unique only inside one.
    expect(h.throttle).toHaveBeenCalledWith('inbound:receipts:org-1:dana@e.inc', {
      max: 60,
      windowSec: 3600,
    });
  });

  it('drops a sender past the ceiling', async () => {
    h.throttle.mockResolvedValue({ allowed: false });
    const POST = await load();
    await call(POST, notification(receiptsSes()));
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('does not throttle the reply mailbox', async () => {
    /** A conversation is not a cost centre; the ceiling exists because each receipt
     *  email means a stored object plus N model calls. */
    const POST = await load();
    await call(POST, notification(replySes()));
    expect(h.throttle).not.toHaveBeenCalled();
  });
});

describe('a failure after the claim is taken', () => {
  /**
   * The regression this suite was written to find.
   *
   * The claim makes processing idempotent, which is exactly what makes a mid-flight
   * failure dangerous: SNS was previously told 200 while the claim was still held, so no
   * redelivery was ever sent — and would have been dropped as a duplicate if it had been.
   * A queue hiccup silently discarded somebody's expense receipt.
   */
  it('refuses the delivery so SNS retries', async () => {
    h.enqueue.mockRejectedValue(new Error('redis down'));
    const POST = await load();
    expect((await call(POST, notification(receiptsSes()))).status).toBe(500);
  });

  it('releases the claim, so the retry is not dropped as a duplicate', async () => {
    h.enqueue.mockRejectedValue(new Error('redis down'));
    const POST = await load();
    await call(POST, notification(receiptsSes()));
    expect(h.releaseClaim).toHaveBeenCalledWith('ses-2');
  });

  it('does the same when handing a reply on fails', async () => {
    // VeloExpense: the comment is the worker's now, so the failure here is the enqueue.
    h.enqueue.mockRejectedValue(new Error('redis down'));
    const POST = await load();
    const res = await call(POST, notification(replySes()));
    expect(res.status).toBe(500);
    expect(h.releaseClaim).toHaveBeenCalledWith('ses-1');
  });

  it('logs what it is asking SNS to redeliver', async () => {
    h.enqueue.mockRejectedValue(new Error('redis down'));
    const POST = await load();
    await call(POST, notification(receiptsSes()));
    expect(warn).toHaveBeenCalledWith('[email:inbound] failed', expect.any(Error));
  });

  it('keeps the claim and answers 200 when everything worked', async () => {
    const POST = await load();
    const res = await call(POST, notification(receiptsSes()));
    expect(res.status).toBe(200);
    expect(h.releaseClaim).not.toHaveBeenCalled();
  });

  it('does not release a claim for a message it never claimed', async () => {
    /** A verdict failure is a decision, not a failure — retrying it would produce the
     *  same refusal forever. */
    h.claimOnce.mockResolvedValue(false);
    const POST = await load();
    const res = await call(POST, notification(receiptsSes()));
    expect(res.status).toBe(200);
    expect(h.releaseClaim).not.toHaveBeenCalled();
  });
});

describe('VeloExpense: the tenant is in the address (d47)', () => {
  const to = (...addresses: string[]) => {
    const base = receiptsSes();
    return notification({
      ...base,
      mail: { ...base.mail, destination: addresses, commonHeaders: { from: ['dana@e.inc'] } },
      receipt: { ...base.receipt, recipients: addresses },
    });
  };

  it('looks up the tenant by the label, active ones only', async () => {
    const POST = await load();
    await call(POST, to('receipts@northwind.expenseos.dev.internal.e.inc'));
    expect(h.orgQuery).toHaveBeenCalledWith(
      `SELECT id FROM organization WHERE slug = $1 AND status <> 'suspended'`,
      ['northwind'],
    );
    expect(h.enqueue.mock.calls[0]?.[1]).toMatchObject({ organizationId: 'org-1' });
  });

  it('matches the tenant’s domain case-insensitively', async () => {
    const POST = await load();
    await call(POST, to('Receipts@NorthWind.ExpenseOS.dev.internal.e.inc'));
    expect(h.orgQuery.mock.calls[0]?.[1]).toEqual(['northwind']);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('ignores an address with no tenant, or no active one', async () => {
    const POST = await load();
    // The inbound domain itself names no tenant.
    await call(POST, to('receipts@expenseos.dev.internal.e.inc'));
    expect(h.orgQuery).not.toHaveBeenCalled();
    // Two labels under it is not a tenant either.
    await call(POST, to('receipts@a.northwind.expenseos.dev.internal.e.inc'));
    expect(h.orgQuery).not.toHaveBeenCalled();
    // A label that names nobody, or a suspended tenant.
    h.orgQuery.mockResolvedValue({ rows: [] });
    await call(POST, to('receipts@nobody.expenseos.dev.internal.e.inc'));
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.throttle).not.toHaveBeenCalled();
  });

  it('refuses a message addressed to two tenants rather than guess whose it is', async () => {
    const POST = await load();
    await call(
      POST,
      to(
        'receipts@northwind.expenseos.dev.internal.e.inc',
        'receipts@globex.expenseos.dev.internal.e.inc',
      ),
    );
    expect(h.orgQuery).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('addressed to 2 tenants'));
  });

  it('does not let a header name a second tenant beside the envelope’s', async () => {
    // SES accepted the message for northwind; a To header naming globex makes it two.
    const POST = await load();
    const base = receiptsSes();
    await call(
      POST,
      notification({
        ...base,
        mail: {
          ...base.mail,
          destination: ['receipts@northwind.expenseos.dev.internal.e.inc'],
          commonHeaders: {
            from: ['dana@e.inc'],
            to: ['receipts@globex.expenseos.dev.internal.e.inc'],
          },
        },
        receipt: { ...base.receipt, recipients: ['receipts@northwind.expenseos.dev.internal.e.inc'] },
      }),
    );
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('hands a reply to the tenant its address names (w5-01)', async () => {
    // Until w5-01 this pinned the opposite: the reply mailbox was ignored.
    const POST = await load();
    await call(POST, to('reply+tok1@northwind.expenseos.dev.internal.e.inc'));
    expect(h.orgQuery).toHaveBeenCalled();
    expect(h.enqueue.mock.calls[0]?.[0]).toBe('email.ingestReply');
    expect(h.enqueue.mock.calls[0]?.[1]).toMatchObject({ token: 'tok1', organizationId: 'org-1' });
  });
});
