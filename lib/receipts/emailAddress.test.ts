import { describe, expect, it } from 'vitest';
import { receiptsEmailAddress } from './emailAddress';

/** f26 — the address shown must be one `app/api/email/inbound/route.ts` accepts. */
describe('receiptsEmailAddress', () => {
  const env = { INBOUND_EMAIL_DOMAIN: 'mail.dev.veloexpense.ai', INBOUND_RECEIPTS_MAILBOXES: 'receipts' };

  it('is the tenant label one under the inbound domain', () => {
    expect(receiptsEmailAddress('velotech-systems-inc', env)).toBe(
      'receipts@velotech-systems-inc.mail.dev.veloexpense.ai',
    );
  });

  it('uses the first configured mailbox, and the route default when none is', () => {
    expect(receiptsEmailAddress('acme', { ...env, INBOUND_RECEIPTS_MAILBOXES: ' Expenses , receipts' })).toBe(
      'expenses@acme.mail.dev.veloexpense.ai',
    );
    expect(receiptsEmailAddress('acme', { INBOUND_EMAIL_DOMAIN: 'mail.example' })).toBe(
      'receipts@acme.mail.example',
    );
  });

  it('is null where this environment receives no mail', () => {
    expect(receiptsEmailAddress('acme', {})).toBeNull();
    expect(receiptsEmailAddress('acme', { INBOUND_EMAIL_DOMAIN: '  ' })).toBeNull();
  });

  it('is null for a slug that cannot be one DNS label', () => {
    expect(receiptsEmailAddress('', env)).toBeNull();
    expect(receiptsEmailAddress(null, env)).toBeNull();
    expect(receiptsEmailAddress('a.b', env)).toBeNull();
    expect(receiptsEmailAddress('-acme', env)).toBeNull();
  });

  it('lower-cases the domain and the slug', () => {
    expect(receiptsEmailAddress('ACME', { INBOUND_EMAIL_DOMAIN: 'Mail.Example' })).toBe(
      'receipts@acme.mail.example',
    );
  });
});
