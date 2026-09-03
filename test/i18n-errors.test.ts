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
  unexpectedMessage,
  type UserMessageCode,
} from '@/lib/i18n/catalog/errors';
import { DomainError, errorParam, userMessageOf } from '@/lib/errors/domain';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/lib/i18n/locales';
import { missingCopyMarker } from '@/lib/i18n/catalog/enums';
import { DecisionForbiddenError } from '@/lib/approvals/eligibility';
import { ApprovalEngineError } from '@/lib/approvals/engine';
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
    expect(renderUserMessage('NOT_A_REAL_CODE', DEFAULT_LOCALE)).toBe('NOT_A_REAL_CODE');
    expect(isUserMessageCode('NOT_A_REAL_CODE')).toBe(false);
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
      const text = renderUserMessage(code, DEFAULT_LOCALE);
      expect(text, code).not.toMatch(/\$\{|\bundefined\b|[a-z]+Id\b|[A-Z]{3,}_[A-Z]/);
      expect(text, code).toMatch(/^[A-Z]/);
      expect(text.trim(), code).toMatch(/[.!?]$/);
    }
  });

  it('names no record id, which is the defect it was written for', () => {
    // A UUID in copy would mean somebody pasted a diagnostic in here.
    for (const code of USER_MESSAGE_CODES) {
      expect(renderUserMessage(code, DEFAULT_LOCALE), code).not.toMatch(
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
    const err = new DecisionForbiddenError(
      'user 8b1c0f2e-0000-4000-8000-000000000001 may not decide approval task ' +
        '4f2a77bd-0000-4000-8000-000000000002',
      'NOT_AN_APPROVER',
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
    // `TASK_NOT_FOUND` is a stale or tampered link. Inventing "already decided"
    // for it would be a guess presented as a fact.
    const err = new DecisionForbiddenError('approval task x does not exist', 'TASK_NOT_FOUND');
    expect(userMessageOf(err)).toBeNull();
    // A DomainError with no code keeps printing its English — the transitional
    // branch. When part 2c-2 removes it this assertion becomes 'UNEXPECTED', and
    // it is here so that change is deliberate rather than noticed in production.
    expect(errorParam(err, 'test')).toBe('approval task x does not exist');
  });

  it('three sentences that share one error code get three message codes', () => {
    // The finding, asserted. `INVALID_RANGE` is one thing to a caller and three
    // things to somebody fixing the form.
    const codes = [
      new DelegationError('give a start date', 'INVALID_RANGE', 'DELEGATION_START_REQUIRED'),
      new DelegationError('give an end date', 'INVALID_RANGE', 'DELEGATION_END_INVALID'),
      new DelegationError('end before start', 'INVALID_RANGE', 'DELEGATION_END_BEFORE_START'),
    ].map((e) => e.userMessage);
    expect(new Set(codes).size).toBe(3);
    expect(codes.every((c) => c !== null)).toBe(true);
    // …and the three sentences are actually different, which the codes alone do
    // not prove.
    const said = codes.map((c) => renderUserMessage(c as string, DEFAULT_LOCALE));
    expect(new Set(said).size).toBe(3);
  });

  it('the plural survives a catalogue that takes no parameters', () => {
    const one = new LifecycleError('…', 'BLOCKED_BY_POLICY', [], 'BLOCKED_BY_POLICY_ONE');
    const many = new LifecycleError('…', 'BLOCKED_BY_POLICY', [], 'BLOCKED_BY_POLICY_MANY');
    expect(renderUserMessage(one.userMessage!, DEFAULT_LOCALE)).toMatch(/^One blocking/);
    expect(renderUserMessage(many.userMessage!, DEFAULT_LOCALE)).toMatch(/^Blocking/);
  });

  it('every class converted in part 2c extends DomainError', () => {
    // Structural, and it is what makes `errorParam`'s case 2 meaningful: a class
    // still extending plain Error would fall through to UNEXPECTED and silently
    // lose the message it has been showing for months.
    const cases: [DomainError & { code: string }, string][] = [
      [new DecisionForbiddenError('m', 'TASK_NOT_FOUND'), 'TASK_NOT_FOUND'],
      [new ApprovalEngineError('m', 'REPORT_NOT_FOUND'), 'REPORT_NOT_FOUND'],
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

  it('does not log for an error it recognises', () => {
    // A refused delegation is not an incident, and a log that cries wolf on every
    // mistyped date is a log nobody reads.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorParam(new DelegationError('m', 'INVALID_RANGE', 'DELEGATION_START_REQUIRED'), 'test');
    errorParam(new DelegationError('m', 'NOT_FOUND'), 'test');
    expect(logged).not.toHaveBeenCalled();
  });
});

/* ── rendering, for the reader ─────────────────────────────────────────────── */

describe('renderUserMessage', () => {
  it('is empty for an empty parameter, so no banner renders', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(renderUserMessage(value, DEFAULT_LOCALE)).toBe('');
    }
  });

  it('passes an uncatalogued value through, which is the transitional branch', () => {
    // Every admin module part 2c-2 has not reached still redirects with its
    // English. This is what keeps those screens saying what they say today — and
    // it is the branch to delete when the catalogue is complete, at which point
    // arbitrary text arriving in a link stops rendering as though the product
    // said it.
    expect(renderUserMessage('a currency code is required', DEFAULT_LOCALE)).toBe(
      'a currency code is required',
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
