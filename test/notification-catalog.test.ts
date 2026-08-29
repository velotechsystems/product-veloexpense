/**
 * VX2-7 — the pure half of the notification catalog: template keys, the
 * (event, subject) -> key map, placeholder substitution, and channel defaults.
 *
 * No database. `lib/notifications/catalog.ts` imports nothing from `lib/db`, and
 * this file existing without a Pool is what proves it — the same guarantee
 * `test/approval-tiers.test.ts` and `test/approver-token.test.ts` give for their
 * registries.
 *
 * The tests worth reading are the ones about the SUBSTITUTION RULES, because all
 * four of them look like details and each one is a defect ExpenseOS wrote down
 * after paying for it (GAP-AUDIT NT-6).
 */
import { describe, it, expect } from 'vitest';
import {
  CHANNELS,
  DEFAULT_LOCALE,
  EVENT_TYPES,
  REPORT_PLACEHOLDERS,
  RESERVED_PLACEHOLDERS,
  SUBJECT_TYPES,
  TEMPLATE_KEYS,
  TEMPLATE_KEY_BY_KEY,
  TEMPLATE_KEY_OWNERS,
  TEMPLATE_KEY_PATTERN,
  applyPlaceholders,
  channelDefault,
  channelEnabled,
  isChannel,
  isEventType,
  isTemplateKey,
  localized,
  mappedEventPairs,
  placeholderValuesFrom,
  preferenceKey,
  renderContent,
  resolveChannels,
  shippedBody,
  templateKeyFor,
} from '@/lib/notifications/catalog';

/* ── the taxonomy ──────────────────────────────────────────────────────────── */

describe('the taxonomy', () => {
  it('recognises exactly the values it ships', () => {
    for (const t of EVENT_TYPES) expect(isEventType(t)).toBe(true);
    for (const c of CHANNELS) expect(isChannel(c)).toBe(true);
    // The controls. Without them the two guards above pass on a build where
    // everything is a valid event type.
    expect(isEventType('SUBMITTED')).toBe(false);
    expect(isEventType('REIMBURSED')).toBe(false);
    expect(isChannel('SMS')).toBe(false);
    expect(isChannel('in_app')).toBe(false);
  });

  it('does not ship an event type nothing emits', () => {
    // SUBMITTED is a deliberate omission (the person who clicked Submit does not
    // need telling). REIMBURSED was one too, until VX2-9 gave it an emitter —
    // and this assertion is what made adding it a visible decision rather than a
    // drift, which is the whole reason a list this obvious is pinned. An event
    // type with no emitter is a preference row nobody can explain and a template
    // nobody can test.
    expect([...EVENT_TYPES]).toEqual([
      'TASK_ASSIGNED',
      'APPROVED',
      'REJECTED',
      'RETURNED',
      'RECALLED',
      'REIMBURSED',
    ]);
  });
});

/* ── template keys ─────────────────────────────────────────────────────────── */

describe('template keys', () => {
  it('accepts the shape it documents and rejects the shapes it documents', () => {
    expect(TEMPLATE_KEY_PATTERN.test('expense_management.report_approved')).toBe(true);
    expect(TEMPLATE_KEY_PATTERN.test('a.b')).toBe(true);
    // Every rejection the doc comment lists, one assertion each — a regex
    // reviewed by reading is a regex nobody has checked.
    for (const bad of [
      'expense-management.x', // kebab-case
      'a.b.c', // more than one dot
      'Expense.x', // uppercase
      '1a.b', // leading digit
      '_a.b', // leading underscore
      'a.b_', // trailing underscore
      'a.b.', // trailing dot
      'a__b.c', // doubled underscore
      'a b.c', // space
      '.x', // empty owner
      'x.', // empty name
      '', // empty
    ]) {
      expect(TEMPLATE_KEY_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('requires a known owner as well as a well-formed shape', () => {
    // The two halves are separate on purpose: `0011` carries the SHAPE as a
    // CHECK constraint and the OWNER list stays here, so adding a module needs
    // no migration. A key can therefore be well-formed and still unowned.
    expect(TEMPLATE_KEY_PATTERN.test('marketing.newsletter')).toBe(true);
    expect(isTemplateKey('marketing.newsletter')).toBe(false);
    expect(isTemplateKey('expense_management.report_approved')).toBe(true);
  });

  it('every shipped key is valid, owned, and unique', () => {
    const keys = TEMPLATE_KEYS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of TEMPLATE_KEYS) {
      expect(isTemplateKey(def.key), def.key).toBe(true);
      expect(
        (TEMPLATE_KEY_OWNERS as readonly string[]).includes(def.key.split('.')[0]),
        def.key,
      ).toBe(true);
    }
  });

  it('every shipped key carries copy in the default locale, and a name', () => {
    for (const def of TEMPLATE_KEYS) {
      expect(localized(def.shipped, DEFAULT_LOCALE), def.key).toBeTruthy();
      expect(def.name.length, def.key).toBeGreaterThan(0);
      expect(def.description.length, def.key).toBeGreaterThan(0);
    }
  });

  it('maps every event type it ships onto a key, and only over real subjects', () => {
    // Not an exhaustiveness GUARANTEE — there deliberately is none (NT-8), an
    // unmapped event degrades to shipped copy. This asserts the registry is
    // complete TODAY, which is a different and checkable claim.
    for (const eventType of EVENT_TYPES) {
      expect(templateKeyFor(eventType, 'EXPENSE_REPORT'), eventType).not.toBeNull();
    }
    for (const pair of mappedEventPairs()) {
      expect(EVENT_TYPES as readonly string[]).toContain(pair.eventType);
      expect(SUBJECT_TYPES as readonly string[]).toContain(pair.subjectType);
      expect(TEMPLATE_KEY_BY_KEY.has(pair.key)).toBe(true);
    }
  });

  it('returns null rather than throwing for an unmapped pair', () => {
    // "Null is not an error. It means render the shipped string." Both null
    // paths: no subject at all, and a subject with no entry.
    expect(templateKeyFor('APPROVED', null)).toBeNull();
    expect(templateKeyFor('APPROVED', 'TRAVEL_REQUEST')).toBeNull();
    expect(templateKeyFor('SOMETHING_NEW', 'EXPENSE_REPORT')).toBeNull();
  });
});

/* ── substitution ──────────────────────────────────────────────────────────── */

describe('placeholder substitution', () => {
  it('replaces a known placeholder', () => {
    expect(applyPlaceholders('{actor} approved {report}.', { actor: 'Ada', report: 'Q3' })).toBe(
      'Ada approved Q3.',
    );
    expect(applyPlaceholders('{n} receipts', { n: 3 })).toBe('3 receipts');
  });

  it('leaves an UNKNOWN placeholder verbatim rather than blanking it', () => {
    // Rule 2, and the reason: "`{amont}` in the output is a visible typo
    // somebody fixes, whereas an empty gap reads as a product bug and hides the
    // cause." An admin who mistypes a placeholder must be able to see it.
    expect(applyPlaceholders('total {amont}', { amount: '5' })).toBe('total {amont}');
    expect(applyPlaceholders('{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });

  it('is not an expression language', () => {
    // Rule 1. Nothing but `{\\w+}` is touched, so property access, calls and
    // anything else an editor might try are inert text — the injection surface
    // ExpenseOS refuses to build.
    expect(applyPlaceholders('{a.b}', { 'a.b': 'x', a: 'y' })).toBe('{a.b}');
    expect(applyPlaceholders('{a()}', { a: 'y' })).toBe('{a()}');
    expect(applyPlaceholders('${a}', { a: 'y' })).toBe('$y');
  });

  it('takes only SCALARS out of a payload', () => {
    // Rule 3, and its failure mode: an array or object stringifies to
    // "[object Object]" in a sentence somebody reads. Dropped instead, which
    // renders as a visible `{fields}`.
    expect(
      placeholderValuesFrom({
        report: 'Q3',
        count: 2,
        fields: ['a', 'b'],
        nested: { x: 1 },
        flag: true,
        missing: null,
        undef: undefined,
      }),
    ).toEqual({ report: 'Q3', count: 2 });
  });

  it('survives a payload that is not an object at all', () => {
    for (const junk of [null, undefined, 'x', 3, ['a'], true]) {
      expect(placeholderValuesFrom(junk)).toEqual({});
    }
  });

  it('names the reserved placeholders separately from the conventional ones', () => {
    // The distinction is which names are SAFE. `actor` is supplied by the
    // machinery and applied last, so a payload cannot shadow it; the report ones
    // come from the payload like anything else and are a convention.
    expect([...RESERVED_PLACEHOLDERS]).toEqual(['actor']);
    expect([...REPORT_PLACEHOLDERS]).toEqual(['report', 'number', 'total']);
    // Rule 4, at the level this file can test it: spreading the payload first
    // and the reserved names second is what makes the shadowing impossible.
    // (The service does the spreading; here we prove the ordering has an effect
    // at all, so a later refactor that reverses it fails something.)
    const payload = placeholderValuesFrom({ actor: 'AN IMPOSTOR', report: 'Q3' });
    const values = { ...payload, actor: 'Ada' };
    expect(applyPlaceholders('{actor} approved {report}.', values)).toBe('Ada approved Q3.');
  });
});

/* ── rendering stored content ──────────────────────────────────────────────── */

describe('renderContent', () => {
  it('renders the requested locale', () => {
    const out = renderContent({ body: { en: 'Hello {who}' } }, 'en', { who: 'Ada' });
    expect(out).toEqual({ subject: null, body: 'Hello Ada' });
  });

  it('falls back to the default locale, and returns null when there is nothing', () => {
    expect(renderContent({ body: { en: 'Hi' } }, 'fr-CA', {})?.body).toBe('Hi');
    // A half-authored template is a MISS, not an empty message — the caller has
    // to be able to drop to the shipped string.
    expect(renderContent({ body: {} }, 'en', {})).toBeNull();
    expect(renderContent({ body: { en: '' } }, 'en', {})).toBeNull();
    expect(renderContent({ body: null }, 'en', {})).toBeNull();
    expect(renderContent({ body: 'a bare string' }, 'en', {})).toBeNull();
  });

  it('substitutes into the subject as well as the body', () => {
    const out = renderContent(
      { subject: { en: 'Re: {report}' }, body: { en: '{actor} approved it' } },
      'en',
      { report: 'Q3', actor: 'Ada' },
    );
    expect(out).toEqual({ subject: 'Re: Q3', body: 'Ada approved it' });
  });
});

describe('shippedBody', () => {
  it('gives the copy the product ships', () => {
    expect(shippedBody('APPROVED', 'EXPENSE_REPORT')).toContain('{actor}');
    expect(shippedBody('APPROVED', 'EXPENSE_REPORT')).toContain('{report}');
  });

  it('falls back to the event type itself for an unmapped event', () => {
    // Ugly on purpose, and ported: an unmistakable missing-copy bug beats a
    // blank row.
    expect(shippedBody('SOMETHING_NEW', 'EXPENSE_REPORT')).toBe('SOMETHING_NEW');
    expect(shippedBody('APPROVED', null)).toBe('APPROVED');
  });
});

/* ── channel defaults ─────────────────────────────────────────────────────── */

describe('channel defaults', () => {
  it('defaults email opt-OUT and Slack opt-IN', () => {
    // The asymmetry is ExpenseOS's and it is the point: an unasked-for email is
    // an annoyance, an unasked-for DM is an intrusion.
    expect(channelDefault('IN_APP')).toBe(true);
    expect(channelDefault('EMAIL')).toBe(true);
    expect(channelDefault('SLACK')).toBe(false);
  });

  it('an empty override map means every default', () => {
    const none: ReadonlyMap<string, boolean> = new Map();
    expect(resolveChannels('APPROVED', none)).toEqual({
      IN_APP: true,
      EMAIL: true,
      SLACK: false,
    });
  });

  it('an override wins, in both directions', () => {
    const overrides = new Map([
      [preferenceKey('APPROVED', 'IN_APP'), false],
      [preferenceKey('APPROVED', 'SLACK'), true],
    ]);
    expect(resolveChannels('APPROVED', overrides)).toEqual({
      IN_APP: false,
      EMAIL: true,
      SLACK: true,
    });
    // And it is scoped to the event it names — an override on APPROVED must not
    // leak onto REJECTED, which is what a map keyed only by channel would do.
    expect(channelEnabled('REJECTED', 'IN_APP', overrides)).toBe(true);
  });

  it('stores only overrides, so a default can move later', () => {
    // The property NT-3 is about, asserted rather than assumed: nothing about a
    // user who has expressed no opinion is recorded, so `channelEnabled` reads
    // today's default for them. If the product later flips SLACK on, they move;
    // somebody who explicitly said false does not.
    const explicit = new Map([[preferenceKey('APPROVED', 'SLACK'), false]]);
    expect(channelEnabled('APPROVED', 'SLACK', new Map())).toBe(channelDefault('SLACK'));
    expect(channelEnabled('APPROVED', 'SLACK', explicit)).toBe(false);
  });
});
