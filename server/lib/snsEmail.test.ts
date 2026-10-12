// VeloExpense: ExpenseOS's `apps/web/src/server/lib/snsEmail.test.ts` (550b2945), Wave 3 (w3-06), unchanged.
import { describe, expect, it } from 'vitest';
import {
  authenticatedSender,
  extractReplyToken,
  type InboundMailbox,
  matchInboundMailbox,
  type SesMail,
  type SesReceipt,
  snsCanonicalString,
  splitAddressList,
  stripQuotedReply,
  verdictsPass,
} from './snsEmail';

describe('extractReplyToken', () => {
  it('pulls the token from reply+<token>@domain (case-insensitive domain)', () => {
    expect(extractReplyToken(['reply+abc123@reply.expenseos.test'], 'reply.expenseos.test')).toBe(
      'abc123',
    );
    expect(extractReplyToken(['reply+XYZ@Reply.ExpenseOS.Test'], 'reply.expenseos.test')).toBe(
      'XYZ',
    );
  });

  it('ignores non-matching recipients and other domains', () => {
    expect(
      extractReplyToken(['someone@e.inc', 'reply+tok@other.test'], 'reply.expenseos.test'),
    ).toBeNull();
    expect(extractReplyToken(['noreply@reply.expenseos.test'], 'reply.expenseos.test')).toBeNull();
  });

  it('finds the token among multiple recipients', () => {
    const got = extractReplyToken(
      ['cc@e.inc', 'reply+t0k3n@reply.expenseos.test'],
      'reply.expenseos.test',
    );
    expect(got).toBe('t0k3n');
  });
});

describe('snsCanonicalString', () => {
  it('orders Notification fields and omits absent Subject', () => {
    const s = snsCanonicalString({
      Type: 'Notification',
      Message: 'hi',
      MessageId: 'id1',
      Timestamp: 'ts',
      TopicArn: 'arn',
    });
    expect(s).toBe(
      'Message\nhi\nMessageId\nid1\nTimestamp\nts\nTopicArn\narn\nType\nNotification\n',
    );
  });

  it('includes SubscribeURL + Token for a SubscriptionConfirmation', () => {
    const s = snsCanonicalString({
      Type: 'SubscriptionConfirmation',
      Message: 'm',
      MessageId: 'id',
      SubscribeURL: 'https://sns/confirm',
      Timestamp: 'ts',
      Token: 'tok',
      TopicArn: 'arn',
    });
    expect(s).toContain('SubscribeURL\nhttps://sns/confirm\n');
    expect(s).toContain('Token\ntok\n');
  });

  it('returns null for an unknown type', () => {
    expect(snsCanonicalString({ Type: 'Whatever' })).toBeNull();
  });
});

describe('stripQuotedReply', () => {
  it('keeps the new content above an attribution line', () => {
    const body =
      'Looks good, approving.\n\nOn Mon, Jun 29, 2026 Jane <jane@e.inc> wrote:\n> please review';
    expect(stripQuotedReply(body)).toBe('Looks good, approving.');
  });

  it('cuts at a quoted block and a signature', () => {
    expect(stripQuotedReply('Thanks!\n> old text')).toBe('Thanks!');
    expect(stripQuotedReply('Done.\n-- \nSent from my phone')).toBe('Done.');
  });

  it('handles French attribution', () => {
    expect(stripQuotedReply('Approuvé.\nLe 29 juin, Jean a écrit :\n> texte')).toBe('Approuvé.');
  });
});

describe('matchInboundMailbox', () => {
  // What the two stages look like: a public address people type, forwarded by Workspace to
  // the address SES actually receives on.
  const MAILBOXES: InboundMailbox[] = [
    { purpose: 'receipts', localParts: ['receipts', 'receipts-dev'] },
    { purpose: 'reply', localParts: ['reply', 'expenseos', 'expenseos-dev'] },
  ];
  const DOMAINS = ['expenseos.dev.internal.e.inc', 'e.inc'];
  const match = (addresses: (string | null | undefined)[]) =>
    matchInboundMailbox(addresses, MAILBOXES, DOMAINS);

  it('reads the mailbox and token from an envelope the forward left intact', () => {
    // Workspace routing that rewrites only the DOMAIN: the token survives where the existing
    // reply+ path already looks for it.
    expect(match(['receipts-dev+abc123@expenseos.dev.internal.e.inc'])).toEqual({
      purpose: 'receipts',
      token: 'abc123',
    });
  });

  it('falls back to the To header when the forward rewrote the envelope', () => {
    // The envelope lost the +token; the header did not, and this is the case that decides
    // whether a threaded reply appends to the report or starts a brand-new one.
    expect(
      match([
        'receipts@expenseos.dev.internal.e.inc',
        'ExpenseOS Receipts <receipts-dev+abc123@e.inc>',
      ]),
    ).toEqual({ purpose: 'receipts', token: 'abc123' });
  });

  it('prefers a tokened address over a plain one whatever the order', () => {
    const plainFirst = match(['receipts@expenseos.dev.internal.e.inc', 'receipts-dev+t1@e.inc']);
    const tokenFirst = match(['receipts-dev+t1@e.inc', 'receipts@expenseos.dev.internal.e.inc']);
    expect(plainFirst).toEqual({ purpose: 'receipts', token: 't1' });
    expect(tokenFirst).toEqual({ purpose: 'receipts', token: 't1' });
  });

  it('reports the plain mailbox with no token, which is a NEW report', () => {
    expect(match(['receipts@expenseos.dev.internal.e.inc'])).toEqual({
      purpose: 'receipts',
      token: null,
    });
  });

  it('tells the two purposes apart, including the public reply alias', () => {
    expect(match(['reply+t@expenseos.dev.internal.e.inc'])?.purpose).toBe('reply');
    expect(match(['expenseos-dev+t@e.inc'])?.purpose).toBe('reply');
    expect(match(['receipts-dev+t@e.inc'])?.purpose).toBe('receipts');
  });

  it('ignores a domain we do not receive on', () => {
    // "receipts+token@e.inc.attacker.com" must not look like our mailbox.
    expect(match(['receipts+t@e.inc.attacker.com'])).toBeNull();
    expect(match(['receipts+t@notours.example'])).toBeNull();
  });

  it('ignores a local part that merely starts with a mailbox name', () => {
    // `receiptsx@` is not `receipts@`, and a prefix test would accept it.
    expect(match(['receiptsx@e.inc'])).toBeNull();
    expect(match(['xreceipts@e.inc'])).toBeNull();
  });

  it('is case-insensitive on the mailbox and the domain', () => {
    expect(match(['Receipts-Dev+AbC@E.Inc'])).toEqual({ purpose: 'receipts', token: 'AbC' });
  });

  it('skips blanks and unparseable values rather than throwing', () => {
    expect(match([null, undefined, '', 'not-an-address', 'receipts-dev+t@e.inc'])).toEqual({
      purpose: 'receipts',
      token: 't',
    });
  });

  it('returns null when no domain is configured', () => {
    // An unconfigured deployment must not match everything.
    expect(matchInboundMailbox(['receipts@e.inc'], MAILBOXES, [])).toBeNull();
  });

  it('keeps a token containing base64url characters intact', () => {
    // issueEmailReplyToken emits base64url, which includes - and _.
    expect(match(['receipts-dev+aB-c_1=@e.inc'])?.token).toBe('aB-c_1=');
  });
});

describe('splitAddressList', () => {
  it('splits a multi-address header so each can be matched', () => {
    expect(splitAddressList('a@x.test, ExpenseOS <b@y.test>')).toEqual([
      'a@x.test',
      'ExpenseOS <b@y.test>',
    ]);
  });

  it('is empty for absent or blank values', () => {
    expect(splitAddressList(undefined)).toEqual([]);
    expect(splitAddressList('  ')).toEqual([]);
  });
});

describe('verdictsPass', () => {
  const pass = { status: 'PASS' };
  const fail = { status: 'FAIL' };
  const receipt = (over: Partial<SesReceipt> = {}): SesReceipt => ({
    virusVerdict: pass,
    spamVerdict: pass,
    dkimVerdict: pass,
    spfVerdict: pass,
    ...over,
  });

  it('accepts a message that passed everything', () => {
    expect(verdictsPass(receipt())).toBe(true);
  });

  it('accepts DKIM without SPF, which is what a forward looks like', () => {
    // Workspace forwarding `receipts@e.inc` onward sends from Google's IPs on behalf of the
    // original domain, so SPF fails while DKIM survives. Requiring both would reject every
    // legitimate email the moment forwarding is in the path.
    expect(verdictsPass(receipt({ spfVerdict: fail }))).toBe(true);
  });

  it('accepts SPF without DKIM', () => {
    expect(verdictsPass(receipt({ dkimVerdict: fail }))).toBe(true);
  });

  it('rejects a message that passed neither DKIM nor SPF', () => {
    // Nothing ties the message to the domain its From claims, and the From is what decides
    // whose expense report this becomes.
    expect(verdictsPass(receipt({ dkimVerdict: fail, spfVerdict: fail }))).toBe(false);
  });

  it('rejects on virus or spam regardless of the rest', () => {
    expect(verdictsPass(receipt({ virusVerdict: fail }))).toBe(false);
    expect(verdictsPass(receipt({ spamVerdict: fail }))).toBe(false);
  });

  it('treats a missing verdict as a failure, not a pass', () => {
    // A notification shape we do not recognise must not be the thing that lets mail through.
    expect(verdictsPass(receipt({ virusVerdict: undefined }))).toBe(false);
    expect(verdictsPass(receipt({ spamVerdict: undefined }))).toBe(false);
    expect(verdictsPass(receipt({ dkimVerdict: undefined, spfVerdict: undefined }))).toBe(false);
    expect(verdictsPass(undefined)).toBe(false);
  });

  it('does not gate on DMARC itself', () => {
    // A forward can break DMARC (SPF fails, and the From domain no longer matches the
    // envelope), so a hard DMARC gate would reject mail we expect. Alignment is enforced
    // separately by `authenticatedSender`, which accepts either factor — but tied to the From.
    expect(verdictsPass(receipt({ dmarcVerdict: fail }))).toBe(true);
  });

  it('is case-insensitive about the verdict value', () => {
    expect(verdictsPass(receipt({ virusVerdict: { status: 'pass' } }))).toBe(true);
  });
});

describe('authenticatedSender', () => {
  /**
   * The other half of `verdictsPass`. A verdict says SOME domain authorised the message —
   * the envelope sender's for SPF, the signer's for DKIM. The From header is what decides
   * whose expense report the mail becomes, and nothing in SES's verdicts ties the two
   * together unless DMARC passed. This does.
   */
  const pass = { status: 'PASS' };
  const fail = { status: 'FAIL' };
  const receipt = (over: Partial<SesReceipt> = {}): SesReceipt => ({
    virusVerdict: pass,
    spamVerdict: pass,
    dkimVerdict: pass,
    spfVerdict: pass,
    dmarcVerdict: fail,
    ...over,
  });
  const sig = (d: string) => ({ name: 'DKIM-Signature', value: `v=1; a=rsa-sha256; d=${d}; s=k1` });
  const mail = (over: Partial<SesMail> = {}): SesMail => ({
    source: 'bounce@attacker.example',
    commonHeaders: { from: ['CFO <CFO@E.inc>'] },
    headers: [sig('attacker.example')],
    ...over,
  });

  it('refuses a From at our domain when SPF and DKIM both passed for somebody else', () => {
    // The attack: valid SPF and DKIM for attacker.example, `From: cfo@e.inc`.
    const out = authenticatedSender(mail(), receipt());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/cfo@e\.inc is not aligned/);
      expect(out.reason).toMatch(/spf=attacker\.example/);
      expect(out.reason).toMatch(/dkim=attacker\.example/);
    }
  });

  it('returns the From lowercased and bare when SES itself reports a DMARC pass', () => {
    expect(authenticatedSender(mail(), receipt({ dmarcVerdict: pass }))).toEqual({
      ok: true,
      address: 'cfo@e.inc',
    });
  });

  it('accepts SPF when the envelope domain is the From domain', () => {
    expect(
      authenticatedSender(
        mail({ source: 'CFO <cfo@e.inc>', headers: [] }),
        receipt({ dkimVerdict: fail }),
      ),
    ).toEqual({ ok: true, address: 'cfo@e.inc' });
  });

  it('accepts SPF on a subdomain of the From domain, either way round', () => {
    // Relaxed alignment, as DMARC defaults to: bounces.e.inc vouches for e.inc, and e.inc
    // vouches for someone@mail.e.inc.
    expect(
      authenticatedSender(
        mail({ source: 'b@bounces.e.inc', headers: [] }),
        receipt({ dkimVerdict: fail }),
      ).ok,
    ).toBe(true);
    expect(
      authenticatedSender(
        mail({ source: 'b@e.inc', headers: [], commonHeaders: { from: ['x@mail.e.inc'] } }),
        receipt({ dkimVerdict: fail }),
      ).ok,
    ).toBe(true);
  });

  it('does not let a look-alike domain align', () => {
    for (const source of ['b@e.inc.attacker.example', 'b@notе.inc', 'b@xe.inc']) {
      expect(
        authenticatedSender(mail({ source, headers: [] }), receipt({ dkimVerdict: fail })).ok,
        source,
      ).toBe(false);
    }
  });

  it('ignores an aligned envelope when SPF did not pass', () => {
    expect(
      authenticatedSender(
        mail({ source: 'cfo@e.inc', headers: [] }),
        receipt({ spfVerdict: fail, dkimVerdict: fail }),
      ).ok,
    ).toBe(false);
  });

  it('accepts DKIM when the signer is the From domain — what a forward looks like', () => {
    expect(
      authenticatedSender(
        mail({ source: 'fwd@google.com', headers: [sig('e.inc')] }),
        receipt({ spfVerdict: fail }),
      ),
    ).toEqual({ ok: true, address: 'cfo@e.inc' });
  });

  it('requires EVERY DKIM signature to align, not just one', () => {
    // SES gives one verdict for the message. A verifying attacker signature beside a forged
    // `d=e.inc` would otherwise read as ours.
    expect(
      authenticatedSender(
        mail({ headers: [sig('e.inc'), sig('attacker.example')] }),
        receipt({ spfVerdict: fail }),
      ).ok,
    ).toBe(false);
  });

  it('refuses DKIM alignment with no signature headers to inspect', () => {
    expect(authenticatedSender(mail({ headers: [] }), receipt({ spfVerdict: fail })).ok).toBe(
      false,
    );
    expect(
      authenticatedSender(mail({ headers: undefined }), receipt({ spfVerdict: fail })).ok,
    ).toBe(false);
  });

  it('refuses DKIM alignment when SES truncated the headers', () => {
    const out = authenticatedSender(
      mail({ headers: [sig('e.inc')], headersTruncated: true }),
      receipt({ spfVerdict: fail }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/headers truncated/);
  });

  it('treats a DKIM-Signature without a d= tag as a signature that vouches for nobody', () => {
    expect(
      authenticatedSender(
        mail({ headers: [{ name: 'DKIM-Signature', value: 'v=1; a=rsa-sha256; s=k1' }] }),
        receipt({ spfVerdict: fail }),
      ).ok,
    ).toBe(false);
  });

  it('reads the header name case-insensitively and the d= tag wherever it sits', () => {
    expect(
      authenticatedSender(
        mail({ headers: [{ name: 'dkim-signature', value: 'v=1;d=E.INC;s=k1' }] }),
        receipt({ spfVerdict: fail }),
      ).ok,
    ).toBe(true);
    // `bd=` is not `d=`.
    expect(
      authenticatedSender(
        mail({ headers: [{ name: 'DKIM-Signature', value: 'v=1; bd=e.inc; d=attacker.example' }] }),
        receipt({ spfVerdict: fail }),
      ).ok,
    ).toBe(false);
  });

  it('refuses a message with no From, an unparseable From, or two Froms', () => {
    const good = receipt({ dmarcVerdict: pass });
    expect(authenticatedSender(mail({ commonHeaders: {} }), good)).toEqual({
      ok: false,
      reason: 'no From header',
    });
    expect(authenticatedSender(undefined, good).ok).toBe(false);
    expect(authenticatedSender(mail({ commonHeaders: { from: ['nobody'] } }), good)).toEqual({
      ok: false,
      reason: 'unparseable From header',
    });
    expect(
      authenticatedSender(mail({ commonHeaders: { from: ['a@e.inc', 'b@e.inc'] } }), good),
    ).toEqual({
      ok: false,
      reason: '2 From addresses',
    });
  });

  it('is a refusal, never a pass, when no verdicts are present at all', () => {
    expect(
      authenticatedSender(mail({ source: 'cfo@e.inc', headers: [sig('e.inc')] }), undefined).ok,
    ).toBe(false);
  });
});
