// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Catalog } from '@expenseos/i18n/load';
import { buildDigest, ctaFor, type DigestLine } from './digest';

/**
 * The digest's message — ported from ExpenseOS's `notification-email-digest.test.ts`
 * ("grouping and content"), against `buildDigest` directly.
 *
 * VeloExpense: the grouping, the hold and the marking are the outbox's here, so those cases
 * are in `test/notification-digest.db.test.ts`; ExpenseOS's email-integration gate and its
 * 5000-row query cap have no counterpart (the outbox drains in pages, and each digest caps
 * its own lines). The lines arrive rendered, through each event's own template, so the
 * actor-and-link cases assert that a line is carried through intact rather than how its
 * sentence is worded. English only for now (7 Oct 2026): the fr-CA case is not ported.
 */

const CATALOG: Catalog = {
  notifications: {
    cta: 'View in VeloExpense',
    // Deliberately covers ONE subject. The other keeps the generic label, so a test can
    // assert the two lines differ.
    ctaSubject: { TRAVEL_REQUEST: 'View travel request' },
    digest: {
      subjectOne: '1 new update in VeloExpense',
      subjectMany: '{count} new updates in VeloExpense',
      intro: "Here's a summary of recent activity:",
    },
    emailFooter: 'You are receiving this because of your notification settings in VeloExpense.',
  },
};

const SHELL = { organizationName: 'Demo Co', brandColor: null };

const line = (over: Partial<DigestLine> = {}): DigestLine => ({
  msg: 'Grace Hopper commented on Lisbon offsite: looks right',
  link: 'https://velo.test/expenses/rep1',
  cta: 'View in VeloExpense',
  ...over,
});

describe('grouping and content', () => {
  it('counts the items in the subject, singular and plural', () => {
    expect(buildDigest(CATALOG, [line()], SHELL).subject).toBe('1 new update in VeloExpense');
    expect(buildDigest(CATALOG, [line(), line(), line()], SHELL).subject).toBe(
      '3 new updates in VeloExpense',
    );
  });

  it('carries each line and links it through', () => {
    const out = buildDigest(CATALOG, [line()], SHELL);
    expect(out.text).toContain("Here's a summary of recent activity:");
    expect(out.text).toContain('Grace Hopper commented on Lisbon offsite: looks right');
    expect(out.text).toContain('https://velo.test/expenses/rep1');
    expect(out.html).toContain('href="https://velo.test/expenses/rep1"');
  });

  it('lists the items, rather than running them together', () => {
    // "A digest is n unrelated things, and running them together as prose is how a reader
    // loses count of how many there are."
    const out = buildDigest(CATALOG, [line(), line({ msg: 'Second thing' })], SHELL);
    expect(out.html.match(/<li /g)).toHaveLength(2);
    expect(out.text.match(/^• /gm)).toHaveLength(2);
  });

  it('names each line after the thing IT links to, not the product', () => {
    /**
     * The digest is the surface where a single shared "View in …" is worst: two subjects
     * render as two identical links in one list, and the only way to tell them apart is to
     * open both. The label is resolved PER LINE.
     */
    const out = buildDigest(
      CATALOG,
      [
        line(),
        line({
          link: 'https://velo.test/travel/requests/req-9',
          cta: ctaFor(CATALOG, 'TRAVEL_REQUEST'),
        }),
      ],
      SHELL,
    );
    expect(out.html).toMatch(/href="https:\/\/velo\.test\/travel\/requests\/req-9"[^>]*>View travel request</);
    expect(out.html).toMatch(/href="https:\/\/velo\.test\/expenses\/rep1"[^>]*>View in VeloExpense</);
  });

  it('renders an item with no landing page', () => {
    // A subject with no page has no link.
    const out = buildDigest(CATALOG, [line({ link: null })], SHELL);
    expect(out.text).not.toContain('http');
    expect(out.html).not.toMatch(/<a [^>]*>View in VeloExpense/);
  });

  it('escapes the message and the intro, but not the URL it built itself', () => {
    /**
     * Names and comment text come from people and can contain anything. The link is
     * assembled from an already-encoded path, so escaping it would corrupt it.
     */
    const out = buildDigest(
      CATALOG,
      [line({ msg: '<script> commented: "x"&' })],
      SHELL,
    );
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('&quot;x&quot;&amp;');
    expect(out.html).toContain('href="https://velo.test/expenses/rep1"');
  });

  it('falls back to default copy when the catalog has no digest strings', () => {
    // A new locale ships before its digest keys; English filler beats an empty subject.
    const out = buildDigest({ notifications: {} }, [line(), line()], SHELL);
    expect(out.subject).toBe('2 new updates in VeloExpense');
    expect(out.text).toContain('summary of recent activity');
    expect(ctaFor({ notifications: {} }, 'EXPENSE_REPORT')).toBe('View in VeloExpense');
  });

  it("goes out in the tenant's own frame, with why it arrived", () => {
    // VeloExpense: the branded shell every notification email uses.
    const out = buildDigest(CATALOG, [line()], SHELL);
    expect(out.html).toContain('Demo Co');
    expect(out.html).toContain('because of your notification settings');
  });
});
