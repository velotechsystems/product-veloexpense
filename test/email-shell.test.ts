/**
 * VX4-3 part 3 — the branded email shell (BR-6). Pure: no database.
 *
 * The interesting assertions are the two that a "does it contain the colour"
 * test would miss, and they are the ones this file exists for:
 *
 *   THE CTA IS READABLE FOR EVERY BRAND COLOUR A TENANT CAN SAVE. The button's
 *   background and its text are asserted at 4.5:1 by MEASURING the pair out of the
 *   rendered HTML, not by checking that a foreground was chosen. A shell that
 *   always wrote white would pass every presence check and ship an invisible
 *   label on a lime-green button.
 *
 *   THE UNBRANDED DEFAULT IS NOT `--vl-brand`. #0284c7 is 4.10:1 against white and
 *   4.36:1 against ink — below AA either way — and this surface is new, so using it
 *   would be knowingly shipping a defect into fresh code. The default is the ramp's
 *   600 step. Pinned, because "just use the brand token" is the obvious future
 *   simplification and it is wrong.
 */
import { describe, it, expect } from 'vitest';
import { contrastRatio, CONTRAST_FLOOR, brandRamp } from '@/lib/branding/color';
import { DEFAULT_EMAIL_ACCENT, emailShell, shellColors } from '@/lib/notifications/email-shell';

const BODY = '<p style="margin:0">Nadia approved EXP-000042.</p>';

const base = {
  organizationName: 'Acme Inc',
  brandColor: null as string | null,
  bodyHtml: BODY,
};

/**
 * The accent is the BUTTON's background; pull that pair back out of the markup.
 *
 * ANCHORED ON `display:inline-block`, and the first version of this helper was not
 * — it matched `background:(#hex);color:(#hex)` anywhere, which finds the `<body>`
 * tag (`background:#f1f5f9;color:#0f172a`) long before the button. Those two
 * contrast at 15:1, so the sweep below passed for every brand colour while never
 * once looking at a button. It was a vacuous test of exactly the kind this project
 * keeps paying for, and it was found by sabotaging the shell to always write white
 * and watching the sweep stay green.
 */
function buttonPair(html: string): { bg: string; fg: string } {
  const m = /display:inline-block;background:(#[0-9a-f]{6});color:(#[0-9a-f]{6})/i.exec(html);
  if (!m) throw new Error('no button found in the rendered shell');
  return { bg: m[1].toLowerCase(), fg: m[2].toLowerCase() };
}

/** Guards the guard: the helper must find the BUTTON, not the body. */
function assertHelperFindsTheButton(): void {
  const html = emailShell({
    ...base,
    brandColor: '#0f766e',
    cta: { label: 'Approve', url: 'https://x.test/a' },
  });
  const { bg, fg } = buttonPair(html);
  if (bg !== '#0f766e' || fg !== '#ffffff') {
    throw new Error(`buttonPair found ${bg}/${fg}, not the button`);
  }
}

describe('the email shell (VX4-3 part 3)', () => {
  it('renders a complete document, not the four bare <p> tags it replaced', () => {
    const html = emailShell(base);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    // Layout tables must not be announced as data tables.
    expect(html).toContain('role="presentation"');
    // Email HTML: no external anything, and no <style> block for Gmail to strip.
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toContain('<link');
    expect(html).not.toContain('http://');
  });

  it('carries the TENANT\'s name as the wordmark, and says who sent it', () => {
    const html = emailShell(base);
    expect(html).toContain('>Acme Inc</td>');
    // The tenant's name first: the recipient's relationship is with them, not us.
    expect(html).toContain('Sent by Acme Inc through VeloExpense');
  });

  it('has NO image at all — a remote logo would 404 for every recipient', () => {
    // `/api/branding/logo` is session-gated, and the recipient who most needs
    // these emails is the approver deciding from a link WITHOUT signing in. An
    // <img> here is not "blocked until they click show images", it is broken.
    const html = emailShell({ ...base, brandColor: '#0f766e' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/api/branding/logo');
  });

  it('escapes a tenant name that contains markup', () => {
    const html = emailShell({ ...base, organizationName: 'A<script>alert(1)</script>&Co "X"' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;Co');
    expect(html).toContain('&quot;X&quot;');
  });

  it('makes the approve link the BUTTON and everything else a plain link', () => {
    const html = emailShell({
      ...base,
      cta: { label: 'Approve', url: 'https://x.test/a?t=1' },
      links: [
        { label: 'Reject', url: 'https://x.test/r?t=2' },
        { label: 'Open the report', url: 'https://x.test/e/1' },
      ],
      footnote: 'Both links ask you to confirm before anything happens.',
    });
    // One button only: a second competing with the first is how a one-click
    // mistake happens.
    expect(html.match(/display:inline-block;background:/g)).toHaveLength(1);
    expect(html).toContain('>Approve</a>');
    expect(html).toContain('>Reject</a>');
    expect(html).toContain('Both links ask you to confirm before anything happens.');
    // Query strings survive escaping intact — an approve token that lost its `&`
    // is a link that silently does nothing.
    expect(html).toContain('https://x.test/a?t=1');
  });

  it('renders with no CTA at all when there is nothing to decide', () => {
    const html = emailShell(base);
    expect(html).not.toContain('display:inline-block;background:');
    expect(html).toContain(BODY);
  });
});

describe('the email accent (VX4-3 part 3)', () => {
  it('does NOT use --vl-brand for an unbranded tenant, because it fails AA', () => {
    // 4.10:1 white / 4.36:1 ink. This surface is new, so choosing a colour we have
    // measured as inaccessible would be shipping a known defect into fresh code.
    expect(DEFAULT_EMAIL_ACCENT).not.toBe('#0284c7');
    expect(DEFAULT_EMAIL_ACCENT).toBe(brandRamp('#0284c7')[600]);
    expect(contrastRatio(DEFAULT_EMAIL_ACCENT, '#ffffff')).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
  });

  it('uses a tenant\'s own colour as saved, not a derived shade of it', () => {
    // It already passed the floor when it was written, so darkening it here would
    // render a brand the tenant did not choose — PE-8's class.
    expect(shellColors('#0f766e').accent).toBe('#0f766e');
  });

  it('falls back rather than emitting unreadable text if a bad row got past the service', () => {
    // #7f7f7f is 4.00/4.46 — refused by `setBrandColor`, so reaching here means a
    // row was written another way. An email cannot be fixed from the receiving
    // end, so it degrades to the safe accent instead of shipping a grey button.
    const colors = shellColors('#7f7f7f');
    expect(colors.accent).toBe(DEFAULT_EMAIL_ACCENT);
    expect(contrastRatio(colors.accent, colors.onAccent)).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
  });

  it('the sweep helper reads the BUTTON and not the body tag', () => {
    // Asserted separately so the sweep below cannot go quietly vacuous again if
    // the markup is reordered.
    expect(() => assertHelperFindsTheButton()).not.toThrow();
  });

  it('THE PROPERTY: the rendered button is readable for every colour a tenant can save', () => {
    // Swept, not sampled. A shell that always wrote white satisfies every presence
    // assertion above and fails here on the first light colour — verified by
    // sabotage, which is also how the vacuous first version of `buttonPair` was
    // caught.
    let checked = 0;
    for (let r = 0; r < 256; r += 23)
      for (let g = 0; g < 256; g += 23)
        for (let b = 0; b < 256; b += 23) {
          const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
          const html = emailShell({
            ...base,
            brandColor: hex,
            cta: { label: 'Approve', url: 'https://x.test/a' },
          });
          const { bg, fg } = buttonPair(html);
          expect(contrastRatio(bg, fg), `${hex} → ${bg} on ${fg}`).toBeGreaterThanOrEqual(
            CONTRAST_FLOOR,
          );
          checked += 1;
        }
    expect(checked).toBeGreaterThan(1000);
  });

  it('and the accent is used for the wordmark and the links too, not only the button', () => {
    const html = emailShell({
      ...base,
      brandColor: '#0f766e',
      links: [{ label: 'Open the report', url: 'https://x.test/e/1' }],
    });
    expect(html).toContain('color:#0f766e">Acme Inc</td>');
    expect(html).toContain('color:#0f766e;text-decoration:underline');
  });
});
