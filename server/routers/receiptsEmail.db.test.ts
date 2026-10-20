// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the harness's callers are untyped, as in the other router suites. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * f26 — `receiptsEmail.mine`, against a real database.
 *
 * Pinned: the address is THIS tenant's (its slug, read under RLS as the caller's tenant), the
 * send-from is the CALLER's own sign-in email, an environment without inbound mail answers
 * NOT_CONFIGURED rather than an address that drops mail, and a reader who cannot create a
 * report is refused. Gated on DATABASE_URL.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

describe.skipIf(!process.env.DATABASE_URL)('receiptsEmail.mine (integration)', () => {
  let h: TenantHarness;
  let otherSlug: string;
  let router: unknown;
  const saved = {
    domain: process.env.INBOUND_EMAIL_DOMAIN,
    mailboxes: process.env.INBOUND_RECEIPTS_MAILBOXES,
  };

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'receipts-addr',
      name: 'Receipts Address',
      people: [{ email: 'second@receipts-addr.test', name: 'Second Person' }],
    });
    // A second tenant in the same database (the harness owns one; this one is made directly),
    // so "the caller's tenant" is a choice between two rows rather than the only one there is.
    const { createOrganization } = await import('@/lib/onboarding/provision');
    otherSlug = 'receipts-other';
    await createOrganization({
      name: 'Receipts Other',
      slug: otherSlug,
      adminEmail: 'founder@receipts-other.test',
      adminName: 'Founder',
    });
    ({ receiptsEmailRouter: router } = await import('@/server/routers/receiptsEmail'));
  });

  afterEach(() => {
    if (saved.domain === undefined) delete process.env.INBOUND_EMAIL_DOMAIN;
    else process.env.INBOUND_EMAIL_DOMAIN = saved.domain;
    if (saved.mailboxes === undefined) delete process.env.INBOUND_RECEIPTS_MAILBOXES;
    else process.env.INBOUND_RECEIPTS_MAILBOXES = saved.mailboxes;
  });

  afterAll(async () => {
    await h?.end();
  });

  const slugOf = async (harness: TenantHarness) =>
    (await harness.admin.query(`SELECT slug FROM organization WHERE id = $1`, [harness.orgId]))
      .rows[0].slug as string;

  it("answers the caller's tenant address and the caller's own sign-in email", async () => {
    process.env.INBOUND_EMAIL_DOMAIN = 'mail.dev.example';
    process.env.INBOUND_RECEIPTS_MAILBOXES = 'receipts';
    const slug = await slugOf(h);
    const second = h.people[1];
    const caller: any = h.makeCaller([P.expense.report.createOwn], second.id, router);
    expect(await caller.mine()).toEqual({
      address: `receipts@${slug}.mail.dev.example`,
      sendFrom: second.email,
    });
  });

  it("never answers another tenant's address", async () => {
    process.env.INBOUND_EMAIL_DOMAIN = 'mail.dev.example';
    const caller: any = h.makeCaller([P.expense.report.createOwn], h.people[0].id, router);
    const { address } = await caller.mine();
    expect(address).toBe(`receipts@${await slugOf(h)}.mail.dev.example`);
    expect(address).not.toContain(otherSlug);
  });

  it('answers NOT_CONFIGURED where this environment receives no mail', async () => {
    delete process.env.INBOUND_EMAIL_DOMAIN;
    const caller: any = h.makeCaller([P.expense.report.createOwn], h.people[0].id, router);
    expect(await caller.mine()).toEqual({ address: null, reason: 'NOT_CONFIGURED' });
  });

  it('refuses a reader who cannot create a report', async () => {
    process.env.INBOUND_EMAIL_DOMAIN = 'mail.dev.example';
    const caller: any = h.makeCaller([P.expense.report.readOwn], h.people[0].id, router);
    await expect(caller.mine()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
