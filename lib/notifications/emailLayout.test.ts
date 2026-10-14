import { describe, expect, it } from 'vitest';
import { renderEmailHtml as renderInShell, renderEmailText } from './emailLayout';

/**
 * The shell every notification email is rendered into.
 *
 * Notification mail used to be `<p>{body}</p>` and two bare anchors. In an inbox beside
 * real correspondence that reads as a system nobody finished: no sender identity, no
 * separation between the sentence and the thing to click, and an "Approve" link
 * indistinguishable from the word approve. An approval request is the most consequential
 * message this product sends and it looked the least like one.
 *
 * The cases below are the ones with a cost attached: escaping, the schemes an `href` will
 * take, and the plain-text part that spam filters and screen readers actually read.
 */

const BASE = { brand: 'VeloExpense', heading: 'A card request awaits you', body: 'Please review.' };

/**
 * VeloExpense: the layout renders inside VeloExpense's branded shell, which takes the tenant.
 * Every case below renders for one fictional tenant with no brand colour.
 */
const SHELL = { organizationName: 'Northwind Example', brandColor: null };
const renderEmailHtml = (input: Parameters<typeof renderInShell>[0]) => renderInShell(input, SHELL);

describe('renderEmailHtml', () => {
  it('names the sender, the heading and the body', () => {
    const html = renderEmailHtml(BASE);
    // VeloExpense: the sender is the tenant, as the shell's wordmark.
    expect(html).toContain('Northwind Example');
    expect(html).toContain('A card request awaits you');
    expect(html).toContain('Please review.');
  });

  it('lays out with TABLES, because Outlook renders through Word', () => {
    /**
     * Not a stylistic choice: Word supports neither flex nor grid and drops most of a
     * `<style>` block, and Gmail strips `<head>`. A table with inline styles is the one
     * layout every client has agreed on.
     */
    const html = renderEmailHtml(BASE);
    expect(html).toContain('<table');
    expect(html).not.toContain('display:flex');
    expect(html).not.toContain('<style');
  });

  it('requests nothing from the network', () => {
    /**
     * No images, no web fonts, no tracking pixel. Each is a request the recipient's client
     * blocks by default — so a layout that needs one is broken on first open for most
     * readers — and a remote asset in a mail about somebody's expenses discloses when they
     * read it.
     */
    const html = renderEmailHtml({ ...BASE, actions: [{ label: 'View', url: 'https://x.test' }] });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('@import');
    expect(html).not.toContain('fonts.googleapis');
  });

  it('escapes everything a template can put into it', () => {
    // A body is TEXT. A template that could inject markup is a template that could inject
    // a link somewhere else.
    const html = renderEmailHtml({
      ...BASE,
      heading: '<script>alert(1)</script>',
      body: 'Ada & "Grace" <hi>',
      actions: [{ label: '<b>Go</b>', url: 'https://x.test' }],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Ada &amp; &quot;Grace&quot; &lt;hi&gt;');
    expect(html).toContain('&lt;b&gt;Go&lt;/b&gt;');
  });

  it('refuses a scheme that is not http(s), and keeps the label', () => {
    /**
     * `javascript:` and `data:` in an anchor are the two schemes that turn a message into
     * a payload. The label still renders as text: it says what was on offer, which beats a
     * button that does nothing.
     */
    const html = renderEmailHtml({
      ...BASE,
      actions: [{ label: 'Approve', url: 'javascript:alert(1)' }],
    });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Approve');
    expect(html).not.toContain('href');
  });

  it('renders one primary action and the rest outlined', () => {
    // Two equally-weighted buttons on a decision is a coin toss.
    const html = renderEmailHtml({
      ...BASE,
      actions: [
        { label: 'Approve', url: 'https://x.test/a', primary: true },
        { label: 'Decline', url: 'https://x.test/r' },
      ],
    });
    // The primary carries the filled background; the other does not.
    // VeloExpense: the primary is the shell's button (an <a> with the accent background) and
    // the other one of its plain links. ExpenseOS: a filled and an outlined button.
    expect(html).toMatch(/<a href="https:\/\/x\.test\/a" style="display:inline-block;background:/);
    expect(html).toMatch(/<a href="https:\/\/x\.test\/r" style="color:/);
  });

  it('splits the body on blank lines rather than running it together', () => {
    const html = renderEmailHtml({ ...BASE, body: 'One.\n\nTwo.' });
    expect(html.match(/<p /g)?.length).toBe(2);
  });

  it('takes pre-built HTML for a body a paragraph cannot carry', () => {
    // The digest is a LIST: running n unrelated things together as prose is how a reader
    // loses count of how many there are.
    const html = renderEmailHtml({ ...BASE, bodyHtml: '<ul><li>a</li></ul>' });
    expect(html).toContain('<ul><li>a</li></ul>');
    expect(html).not.toContain('Please review.');
  });

  it('omits the footer rule when there is no small print', () => {
    // VeloExpense: the shell always draws its rule and its "sent by" line; what is omitted
    // without small print is the footnote row.
    expect(renderEmailHtml(BASE)).not.toContain('Sent by ExpenseOS.');
    expect(renderEmailHtml({ ...BASE, footer: 'Sent by ExpenseOS.' })).toContain(
      'Sent by ExpenseOS.',
    );
  });

  describe('subject details', () => {
    /**
     * The facts about what is being decided, between the body and the buttons.
     *
     * "Dana Patel submitted a card request" is enough to know something happened and not
     * enough to answer it. These rows are what let an approver decide from the mail
     * instead of after a round trip to the app.
     */
    const DETAILS = [
      { label: 'Requester', value: 'Dana Patel' },
      { label: 'Requested limit', value: 'CAD 5,000.00' },
    ];

    it('renders each row as a label and a value', () => {
      const html = renderEmailHtml({ ...BASE, details: DETAILS });
      expect(html).toContain('Requester');
      expect(html).toContain('Dana Patel');
      expect(html).toContain('Requested limit');
      expect(html).toContain('CAD 5,000.00');
    });

    it('sits between the body and the buttons', () => {
      // The order the decision is made in: what happened, what it says, what you can do.
      const html = renderEmailHtml({
        ...BASE,
        details: DETAILS,
        actions: [{ label: 'Approve', url: 'https://x.test/a' }],
      });
      expect(html.indexOf('Please review.')).toBeLessThan(html.indexOf('Dana Patel'));
      expect(html.indexOf('Dana Patel')).toBeLessThan(html.indexOf('https://x.test/a'));
    });

    it('escapes both halves — these come from a database record', () => {
      // A vendor named `<script>` is a row somebody imported, not an attack anybody had
      // to mount. `details` is escaped here, unlike `bodyHtml`.
      const html = renderEmailHtml({
        ...BASE,
        details: [{ label: 'Vendor <b>', value: '<script>alert(1)</script> & co' }],
      });
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('Vendor &lt;b&gt;');
      expect(html).toContain('&amp; co');
    });

    it('renders no table at all when there is nothing to say', () => {
      // `[]` is the answer for a subject with no detail builder, and it has to leave the
      // mail exactly as it was before this existed — not an empty bordered box.
      expect(renderEmailHtml({ ...BASE, details: [] })).toBe(renderEmailHtml(BASE));
      expect(renderEmailHtml({ ...BASE, details: [{ label: '  ', value: '  ' }] })).not.toContain(
        'border-bottom:1px solid #e5e7eb;padding:8px 0;',
      );
    });
  });
});

describe('renderEmailText', () => {
  /**
   * Not a fallback nobody reads: it is what a screen reader in text mode, a terminal
   * client, and every spam filter judging the message actually see.
   */
  it('carries the heading, the body and each action as a labelled URL', () => {
    const text = renderEmailText({
      ...BASE,
      actions: [{ label: 'Approve', url: 'https://x.test/a' }],
      footer: 'Sent by ExpenseOS.',
    });
    expect(text).toContain('A card request awaits you');
    expect(text).toContain('Please review.');
    expect(text).toContain('Approve: https://x.test/a');
    expect(text).toContain('Sent by ExpenseOS.');
  });

  it('drops an action it would not have linked either', () => {
    // A dangling "Approve:" with nothing after it is worse than no line at all.
    const text = renderEmailText({ ...BASE, actions: [{ label: 'Approve', url: 'mailto:x' }] });
    expect(text).not.toContain('Approve');
  });

  it('escapes nothing, because plain text is not markup', () => {
    expect(renderEmailText({ ...BASE, body: 'Ada & Grace' })).toContain('Ada & Grace');
  });

  it('carries the same detail rows the HTML table does', () => {
    /**
     * A text part that says less than the HTML one is both a worse message and a
     * worse-scoring one — this is what the spam filter reads.
     */
    const text = renderEmailText({
      ...BASE,
      details: [
        { label: 'Requester', value: 'Dana Patel' },
        { label: 'Requested limit', value: 'CAD 5,000.00' },
      ],
      actions: [{ label: 'Approve', url: 'https://x.test/a' }],
    });
    expect(text).toContain('Requester: Dana Patel');
    expect(text).toContain('Requested limit: CAD 5,000.00');
    // Same order as the HTML: body, details, actions.
    expect(text.indexOf('Please review.')).toBeLessThan(text.indexOf('Requester:'));
    expect(text.indexOf('Requester:')).toBeLessThan(text.indexOf('Approve:'));
  });
});
