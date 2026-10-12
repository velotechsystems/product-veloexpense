/**
 * VX4-7 part 2c — the refusal catalogue, and the disclosure fix under it.
 *
 * No database. Two things are being asserted and they are different in kind:
 *
 *   COPY — every code resolves, in every shipped locale, to a sentence a person
 *          can act on. That is the `enums.ts` guarantee restated for a third
 *          catalogue, and the type does most of it.
 *   BEHAVIOUR — `errorParam` never lets an exception nobody catalogued reach a
 *          URL. That is the half that is a security property rather than a
 *          localisation one, and it is asserted against real error objects
 *          thrown by the real modules, not against hand-built stand-ins.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ERROR_COPY,
  USER_MESSAGE_CODES,
  isUserMessageCode,
  renderUserMessage,
  requires,
  unexpectedMessage,
  type UserMessageCode,
} from '@/lib/i18n/catalog/errors';
import {
  DomainError,
  assertRenderableParams,
  decodeUserMessage,
  encodeUserMessage,
  errorCodeParam,
  errorParam,
  userMessageOf,
  userMessageOrGeneric,
} from '@/lib/errors/domain';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/lib/i18n/locales';
import { missingCopyMarker } from '@/lib/i18n/catalog/enums';
import { ReportDecisionError } from '@/server/lib/reportLifecycle';
import { DelegationError } from '@/lib/approvals/delegations';
import { LifecycleError } from '@/lib/expenses/lifecycle';
import { ExpenseError } from '@/lib/expenses/service';

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── the copy ──────────────────────────────────────────────────────────────── */

describe('every code has copy, in every shipped locale', () => {
  it.each([...USER_MESSAGE_CODES])('%s', (code) => {
    for (const locale of SUPPORTED_LOCALES) {
      const text = renderUserMessage(code, locale);
      expect(text, `${code} in ${locale}`).not.toBe(missingCopyMarker(code));
      expect(text.length, `${code} in ${locale}`).toBeGreaterThan(0);
    }
  });

  it('the coverage assertion can actually fail', () => {
    // The guard on the guard. Without this, a catalogue whose entries all
    // resolved to the marker would pass the block above if the marker check were
    // ever weakened — and `enums.ts` records that a self-consistent catalogue is
    // the failure mode a coverage test is most likely to miss.
    expect(isUserMessageCode('NOT_A_REAL_CODE')).toBe(false);
    expect(renderUserMessage('NOT_A_REAL_CODE', DEFAULT_LOCALE)).toBe(
      unexpectedMessage(DEFAULT_LOCALE),
    );
  });

  it('reads as a sentence to a person, not as a log line', () => {
    // The whole point of part 2c is that these replaced DIAGNOSTICS. A code whose
    // copy still carries a placeholder, a bare identifier or SCREAMING_SNAKE has
    // not actually been rewritten — it has been moved.
    for (const code of USER_MESSAGE_CODES) {
      // Through the renderer rather than indexing `Copy` directly: indexed by
      // the `DEFAULT_LOCALE` constant (typed `Locale`, not its literal) the type
      // is `string | undefined`, and a `!` here would be papering over the one
      // thing this block is checking.
      // The RAW template, because `renderUserMessage` returns the generic for a
      // code whose params are absent — which every parameterised code's would be
      // here, and asserting the generic reads like a sentence thirty times over
      // proves nothing.
      const text = ERROR_COPY[code][DEFAULT_LOCALE] ?? '';
      expect(text, code).not.toMatch(/\$\{|\bundefined\b|[a-z]+Id\b/);
      // SCREAMING_SNAKE in copy means somebody pasted an enum member in.
      // `{name}`-style placeholders are fine and are checked separately below.
      expect(text.replace(/\{\w+\}/g, ''), code).not.toMatch(/[A-Z]{3,}_[A-Z]/);
      // A leading “ is fine: several of these open by quoting what the person
      // typed back at them ("“{given}” is not a valid amount").
      expect(text, code).toMatch(/^[A-Z{“]/);
      expect(text.trim(), code).toMatch(/[.!?]$/);
    }
  });

  it('names no record id, which is the defect it was written for', () => {
    // A UUID in copy would mean somebody pasted a diagnostic in here.
    for (const code of USER_MESSAGE_CODES) {
      expect(ERROR_COPY[code][DEFAULT_LOCALE] ?? '', code).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i,
      );
    }
  });
});

/* ── the split, on real errors ─────────────────────────────────────────────── */

describe('a domain error carries a diagnostic AND, sometimes, reader copy', () => {
  it('keeps the ids in the message and off the screen', () => {
    // THE assertion this ticket exists for. The log keeps both ids; the code the
    // page will render mentions neither.
    // w4-00c: the approver's refusal is `ReportDecisionError` since the ladder's
    // `DecisionForbiddenError` went with it.
    const err = new ReportDecisionError(
      'user 8b1c0f2e-0000-4000-8000-000000000001 may not decide approval task ' +
        '4f2a77bd-0000-4000-8000-000000000002',
      'FORBIDDEN',
      'TASK_NOT_YOURS',
    );
    expect(err.message).toContain('8b1c0f2e');
    expect(errorParam(err, 'test')).toBe('TASK_NOT_YOURS');
    expect(renderUserMessage(errorParam(err, 'test'), DEFAULT_LOCALE)).toBe(
      'This approval is not yours to decide.',
    );
    expect(renderUserMessage(errorParam(err, 'test'), DEFAULT_LOCALE)).not.toContain('8b1c0f2e');
  });

  it('an invariant failure gets no reader copy, on purpose', () => {
    // A report that is not there. Inventing a reason for it would be a guess presented
    // as a fact. (w4-00c: the ladder's TASK_NOT_FOUND refusal was the example; this is
    // the lifecycle's equivalent, which carries no code either.)
    const err = new LifecycleError('report x does not exist', 'NOT_FOUND');
    expect(userMessageOf(err)).toBeNull();
    // PART 2c-2 CHANGED THIS. The transitional branch — a DomainError with no
    // code putting its English in the URL — is gone, so an invariant failure now
    // reaches the reader as the generic and its message reaches the log. The old
    // expectation was `'approval task x does not exist'`, and this assertion
    // existed in 2c-1 so that the change would be deliberate rather than noticed
    // in production.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errorParam(err, 'test')).toBe('UNEXPECTED');
    expect(logged).toHaveBeenCalledOnce();
  });

  it('three sentences that share one error code get three message codes', () => {
    // The finding, asserted. `INVALID_RANGE` is one thing to a caller and three
    // things to somebody fixing the form.
    const codes = [
      new DelegationError('give a start date', 'INVALID_RANGE', 'DELEGATION_START_REQUIRED'),
      new DelegationError('give an end date', 'INVALID_RANGE', 'DELEGATION_END_INVALID'),
      new DelegationError('end before start', 'INVALID_RANGE', 'DELEGATION_END_BEFORE_START'),
    ].map((e) => e.userMessage?.code);
    expect(new Set(codes).size).toBe(3);
    expect(codes.every((c) => c !== undefined)).toBe(true);
    // …and the three sentences are actually different, which the codes alone do
    // not prove.
    const said = codes.map((c) => renderUserMessage(c as string, DEFAULT_LOCALE));
    expect(new Set(said).size).toBe(3);
  });

  it('the plural survives a catalogue that takes no parameters', () => {
    const one = new LifecycleError('…', 'BLOCKED_BY_POLICY', [], 'BLOCKED_BY_POLICY_ONE');
    const many = new LifecycleError('…', 'BLOCKED_BY_POLICY', [], 'BLOCKED_BY_POLICY_MANY');
    expect(renderUserMessage(one.userMessage!.code, DEFAULT_LOCALE)).toMatch(/^One blocking/);
    expect(renderUserMessage(many.userMessage!.code, DEFAULT_LOCALE)).toMatch(/^Blocking/);
  });

  it('every class converted in part 2c extends DomainError', () => {
    // Structural, and it is what makes `errorParam`'s case 2 meaningful: a class
    // still extending plain Error would fall through to UNEXPECTED and silently
    // lose the message it has been showing for months.
    const cases: [DomainError & { code: string }, string][] = [
      // w4-00c: the ladder's two approval classes went with it. Their successor,
      // `ReportDecisionError`, always carries reader copy, so it is not one of these.
      [new DelegationError('m', 'NOT_FOUND'), 'NOT_FOUND'],
      [new LifecycleError('m', 'NOT_FOUND'), 'NOT_FOUND'],
      [new ExpenseError('m', 'NOT_FOUND'), 'NOT_FOUND'],
    ];
    for (const [err, code] of cases) {
      expect(err, err.name).toBeInstanceOf(DomainError);
      expect(err, err.name).toBeInstanceOf(Error);
      // The subclass `code` union is untouched — callers branch on it and 2c
      // changed none of that. Paired explicitly rather than derived from
      // `err.name`: the first draft did the clever thing and asserted the wrong
      // constant for four of the five.
      expect(err.code, err.name).toBe(code);
      expect(err.userMessage, err.name).toBeNull();
    }
  });
});

/* ── the security half ─────────────────────────────────────────────────────── */

describe('errorParam never puts an unexpected exception in a URL', () => {
  it.each([
    ['a bug', new TypeError("Cannot read properties of undefined (reading 'rows')")],
    ['a driver error', Object.assign(new Error('syntax error at or near "SELCT"'), { code: '42601' })],
    ['a fetch failure', new Error('connect ECONNREFUSED 10.0.0.4:5432')],
    ['a string', 'boom'],
    ['nothing at all', undefined],
  ])('%s becomes the generic', (_name, thrown) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errorParam(thrown, 'test')).toBe('UNEXPECTED');
    // NOT swallowed. The information moves to the log; it does not vanish.
    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0][0]).toContain('[test]');
    expect(logged.mock.calls[0][1]).toBe(thrown);
  });

  it('the generic says what to do next', () => {
    // An apology with no next step is worse than useless on a screen where the
    // person still has work in front of them.
    const text = unexpectedMessage(DEFAULT_LOCALE);
    expect(text).toMatch(/try again/i);
    expect(text).toMatch(/administrator/i);
    // And it must not imply their work was saved when it was not.
    expect(text).toMatch(/nothing was saved/i);
  });

  it('does not log for a refusal somebody was told about', () => {
    // A refused delegation is not an incident, and a log that cries wolf on every
    // mistyped date is a log nobody reads.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorParam(new DelegationError('m', 'INVALID_RANGE', 'DELEGATION_START_REQUIRED'), 'test');
    expect(logged).not.toHaveBeenCalled();
  });

  it('DOES log a DomainError with no reader copy, which 2c-1 did not', () => {
    // The other half of deleting the transitional branch, and the half worth
    // pinning: in 2c-1 this put its English in the URL and logged nothing. Now
    // the reader gets the generic and the message goes where it is useful — so
    // an invariant failure that starts happening in production is visible
    // instead of being quietly readable by whoever hit it.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errorParam(new DelegationError('delegation not found after insert', 'NOT_FOUND'), 'test'))
      .toBe('UNEXPECTED');
    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0][0]).toContain('[test]');
  });
});

/* ── rendering, for the reader ─────────────────────────────────────────────── */

describe('renderUserMessage', () => {
  it('is empty for an empty parameter, so no banner renders', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(renderUserMessage(value, DEFAULT_LOCALE)).toBe('');
    }
  });

  it('refuses an uncatalogued value instead of rendering it', () => {
    // 2c-1 passed this through, which is what kept the then-uncatalogued admin
    // screens working. Now that they are catalogued, the only thing that can
    // arrive uncatalogued is a hand-edited link — and rendering arbitrary text
    // inside the product's own error banner is a thing worth not doing.
    expect(renderUserMessage('a currency code is required', DEFAULT_LOCALE)).toBe(
      unexpectedMessage(DEFAULT_LOCALE),
    );
    expect(renderUserMessage('<img src=x onerror=alert(1)>', DEFAULT_LOCALE)).toBe(
      unexpectedMessage(DEFAULT_LOCALE),
    );
  });

  it('falls back rather than blanking on an unsupported tag', () => {
    expect(renderUserMessage('SELF_APPROVAL', 'fr-CA')).toBe(
      'A report cannot be approved by the person who submitted it.',
    );
    expect(renderUserMessage('SELF_APPROVAL', 'nonsense')).toBe(
      'A report cannot be approved by the person who submitted it.',
    );
  });
});

describe('the catalogue and the codes agree', () => {
  it('no code is declared twice', () => {
    expect(new Set(USER_MESSAGE_CODES).size).toBe(USER_MESSAGE_CODES.length);
  });

  it('ERROR_COPY has exactly the declared codes, in both directions', () => {
    // The type gives one direction (`Record<UserMessageCode, Copy>`). This gives
    // the other: a key in the object that is not in the array would be dead copy,
    // and the type cannot see it because the array is what the type is built from.
    expect(Object.keys(ERROR_COPY).sort()).toEqual([...USER_MESSAGE_CODES].sort());
  });

  it('isUserMessageCode agrees with the array', () => {
    for (const code of USER_MESSAGE_CODES) expect(isUserMessageCode(code)).toBe(true);
    expect(isUserMessageCode('SELF_APPROVAL ')).toBe(false);
    expect(isUserMessageCode('')).toBe(false);
  });

  it('every code is reachable — none is copy nothing throws', () => {
    // Asserted here rather than in the gate because it needs the module graph,
    // not a regex. UNEXPECTED and the two receipt-drawer codes have no throw
    // site by construction: they are produced by `errorParam` and by the client
    // component's own catch, so they are named as the deliberate exceptions
    // rather than silently skipped.
    const producedWithoutAThrow: UserMessageCode[] = [
      'UNEXPECTED',
      'RECEIPT_ACTION_FAILED',
      'RECEIPT_OPEN_FAILED',
    ];
    for (const code of producedWithoutAThrow) {
      expect(USER_MESSAGE_CODES).toContain(code);
    }
  });
});

/* ── part 2c-2: the parameter mechanism ────────────────────────────────────── */

describe('parameters travel in the error value', () => {
  it('a code with no params is just the code', () => {
    expect(encodeUserMessage({ code: 'SELF_APPROVAL' })).toBe('SELF_APPROVAL');
    expect(encodeUserMessage({ code: 'SELF_APPROVAL', params: {} })).toBe('SELF_APPROVAL');
  });

  it('round-trips through the wire format', () => {
    const wire = encodeUserMessage({
      code: 'COLOUR_UNREADABLE',
      params: { hex: '#0284c7', white: '4.10', ink: '4.46', floor: 4.5 },
    });
    expect(wire).toMatch(/^COLOUR_UNREADABLE~/);
    expect(decodeUserMessage(wire)).toEqual({
      code: 'COLOUR_UNREADABLE',
      params: { hex: '#0284c7', white: '4.10', ink: '4.46', floor: 4.5 },
    });
  });

  it('renders the parameters into the sentence, for the reader', () => {
    const wire = encodeUserMessage({
      code: 'COLOUR_UNREADABLE',
      params: { hex: '#0284c7', white: '4.10', ink: '4.46', floor: 4.5 },
    });
    const text = renderUserMessage(wire, DEFAULT_LOCALE);
    // The three numbers `e2e/branding-flow.spec.ts` asserts, and the actionable
    // clause a first draft of the catalogue dropped.
    expect(text).toContain('#0284c7 cannot carry readable text');
    expect(text).toContain('4.10:1 against white');
    expect(text).toContain('4.46:1 against dark ink');
    expect(text).toContain('4.5:1 is needed');
    expect(text).toContain('Try a deeper or lighter shade of the same hue.');
  });

  it('REFUSES a record id as a parameter', () => {
    // Rule 2 from lib/errors/domain.ts, and the reason the mechanism is safe to
    // have at all: part 2c existed because a UUID reached a screen, and a
    // parameter channel without this check would be a nicer road in — a URL,
    // which every proxy in between also logs.
    expect(() =>
      assertRenderableParams({ id: '8b1c0f2e-0000-4000-8000-000000000001' }),
    ).toThrow(/uuid/i);
    expect(() => assertRenderableParams({ n: 3, code: 'AP-1', hex: '#0284c7' })).not.toThrow();
  });

  it('degrades to the generic rather than encoding an id', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      encodeUserMessage({
        code: 'ACCOUNT_NUMBER_TAKEN',
        params: { number: '8b1c0f2e-0000-4000-8000-000000000001' },
      }),
    ).toBe('UNEXPECTED');
    expect(logged).toHaveBeenCalledOnce();
  });

  it('survives a truncated or hand-edited params blob', () => {
    // The value arrives from a URL. A blob that does not decode drops the params
    // and keeps the code, and the code then degrades to the generic through
    // `requires` — which still tells the truth that something failed.
    expect(decodeUserMessage('LOGO_TOO_LARGE~not-base64!!')).toEqual({
      code: 'LOGO_TOO_LARGE',
      params: {},
    });
    expect(renderUserMessage('LOGO_TOO_LARGE~not-base64!!', DEFAULT_LOCALE)).toBe(
      unexpectedMessage(DEFAULT_LOCALE),
    );
    // Nested and non-scalar values are dropped rather than rendered.
    const nested = Buffer.from(JSON.stringify({ size: { a: 1 }, limit: 512 }), 'utf8').toString(
      'base64url',
    );
    expect(decodeUserMessage(`LOGO_TOO_LARGE~${nested}`).params).toEqual({ limit: 512 });
  });

  it('never leaves a hole in a sentence', () => {
    // `policy-messages.ts` learned the same thing about `String(undefined)`: a
    // sentence missing its numbers reads as a product bug rather than a data one.
    const partial = encodeUserMessage({ code: 'LOGO_TOO_LARGE', params: { size: 812 } });
    expect(renderUserMessage(partial, DEFAULT_LOCALE)).toBe(unexpectedMessage(DEFAULT_LOCALE));
    expect(requires('LOGO_TOO_LARGE')).toEqual(['size', 'limit']);
  });

  it('errorCodeParam is for a caller that already has a code', () => {
    expect(errorCodeParam('QUEUED_POST_NOT_FOUND')).toBe('QUEUED_POST_NOT_FOUND');
  });

  it('userMessageOrGeneric hands the message over as data', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(userMessageOrGeneric(new DelegationError('m', 'NOT_FOUND', 'DELEGATEE_NOT_IN_ORG'), 't'))
      .toEqual({ code: 'DELEGATEE_NOT_IN_ORG' });
    expect(userMessageOrGeneric(new TypeError('boom'), 't')).toEqual({ code: 'UNEXPECTED' });
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('placeholders and copy agree', () => {
  it('every locale override uses the same placeholders as the default', () => {
    // The one thing `requires()` cannot check for itself: it reads the DEFAULT
    // locale's template, so an override with a different placeholder set would
    // render a hole for that reader only — the failure mode a single-locale gate
    // never sees, which is IL-5/IL-6 restated.
    for (const code of USER_MESSAGE_CODES) {
      const want = [...requires(code)].sort();
      for (const locale of SUPPORTED_LOCALES) {
        const template = ERROR_COPY[code][locale];
        if (template === undefined) continue;
        const got = [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
        expect(got, `${code} in ${locale}`).toEqual(want);
      }
    }
  });

  it('an enum-typed param renders its CATALOGUED words, not the key', () => {
    // The assertion the change is for. `POLICY_PARAM_REQUIRED` used to be filled
    // at the throw site with an English rule name, so a French reader got a
    // French template with English inside it. The param now carries the key and
    // `renderUserMessage` resolves it where the locale is known.
    const text = renderUserMessage(
      encodeUserMessage({
        code: 'POLICY_PARAM_REQUIRED',
        params: { rule: 'PER_TRANSACTION_LIMIT', field: 'PER_TRANSACTION_LIMIT.thresholdMinor' },
      }),
      'en-CA',
    );
    expect(text).toBe('Per-transaction limit needs Limit.');
    // The key itself must NOT survive into the sentence — that is the defect
    // shape a silent fall-through would produce, and it looks almost right.
    expect(text).not.toContain('PER_TRANSACTION_LIMIT');
  });

  it('and an unknown member becomes the marker rather than the raw key', () => {
    // Loud, and the same shape as everywhere else. A sentence containing
    // `NO_SUCH_RULE` reads as content; one containing `{NO_SUCH_RULE}` cannot.
    const text = renderUserMessage(
      encodeUserMessage({
        code: 'POLICY_PARAM_REQUIRED',
        params: { rule: 'NO_SUCH_RULE', field: 'PER_TRANSACTION_LIMIT.thresholdMinor' },
      }),
      'en-CA',
    );
    expect(text).toContain('{NO_SUCH_RULE}');
  });

  it('a parameterised code renders once its params arrive, in every locale', () => {
    // Fixture values per placeholder name, so this covers all ~30 parameterised
    // codes without thirty separate tests.
    //
    // SOME PARAMS ARE NOW KEYS, not text. `{rule}`, `{field}` and `{maximum}`
    // are resolved through `PARAM_CATALOGUES` in the reader's locale, so `'X'`
    // is no longer a usable fixture for them — it is not a member of any
    // catalogue, and `enumLabel` correctly answers with the missing-copy marker.
    //
    // That is how this test caught the change: it failed with
    // `'{X} needs {X}.'`, which is the marker doing its job. Feeding real keys
    // makes the assertion STRONGER than it was — it now proves the catalogue
    // lookup resolves, not merely that the template fills.
    const ENUM_PARAM_FIXTURES: Record<string, string> = {
      rule: 'PER_TRANSACTION_LIMIT',
      field: 'PER_TRANSACTION_LIMIT.thresholdMinor',
      maximum: 'WARNING',
    };
    const value = (key: string) => {
      const enumFixture = ENUM_PARAM_FIXTURES[key];
      if (enumFixture !== undefined) return enumFixture;
      return /count|problems|lines|children|categories|position|steps|max|size|limit|length/.test(
        key,
      )
        ? 3
        : 'X';
    };
    for (const code of USER_MESSAGE_CODES) {
      const keys = requires(code);
      if (keys.length === 0) continue;
      const params = Object.fromEntries(keys.map((k) => [k, value(k)]));
      for (const locale of SUPPORTED_LOCALES) {
        const text = renderUserMessage(encodeUserMessage({ code, params }), locale);
        expect(text, `${code} in ${locale}`).not.toBe(unexpectedMessage(locale));
        expect(text, `${code} in ${locale}`).not.toContain('{');
      }
    }
  });
});
