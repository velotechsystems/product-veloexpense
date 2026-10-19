// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyTurnFailure, describeTurnFailure } from './assistantError';

/**
 * Turning a thrown turn failure into something a person can act on.
 *
 * The panel used to say "Something went wrong. Try asking again." for every one of these.
 * That is advice, and for most of them it is wrong advice — asking again does not fund an
 * account or rotate a revoked key. The point of the classification is that each reason maps
 * to a DIFFERENT next action, so the tests below are grouped by what the person should do.
 *
 * The other half of the contract is what must never come out: the upstream error's own
 * message. It can quote the request or carry a key prefix, and a chat transcript is a place
 * people paste into support tickets.
 */

/** An SDK-shaped error. `error.type` is the API's own classification. */
const apiError = (status: number, type?: string, message = 'upstream said so') => ({
  name: 'APIError',
  status,
  error: type ? { type, message } : null,
  message,
});

describe('nothing is wrong — wait and retry', () => {
  it('reads a 529 as overloaded', () => {
    expect(classifyTurnFailure(apiError(529))).toBe('overloaded');
  });

  it('trusts the API type over the status', () => {
    /** Anthropic returns `overloaded_error` with a 500 in some paths. The type is the
     *  more specific signal, and it is the difference between "wait" and "tell us". */
    expect(classifyTurnFailure(apiError(500, 'overloaded_error'))).toBe('overloaded');
  });

  it('reads a 429 as rate limited', () => {
    expect(classifyTurnFailure(apiError(429, 'rate_limit_error'))).toBe('rateLimited');
  });

  it('reads a bare 429 with no body the same way', () => {
    expect(classifyTurnFailure(apiError(429))).toBe('rateLimited');
  });
});

describe('an administrator has to do something', () => {
  /** These are the ones where "try again" is actively misleading — the same request will
   *  fail identically until somebody changes a setting. */
  it('reads a 401 as a credential problem', () => {
    expect(classifyTurnFailure(apiError(401, 'authentication_error'))).toBe('credential');
  });

  it('reads a 403 the same way', () => {
    expect(classifyTurnFailure(apiError(403, 'permission_error'))).toBe('credential');
  });

  it('reads a billing failure as a credential problem too', () => {
    /** Deliberately not its own reason: from the panel both mean "the key on this
     *  installation cannot be used", and an employee cannot tell the two apart anyway. */
    expect(classifyTurnFailure(apiError(400, 'billing_error'))).toBe('credential');
  });
});

describe('the conversation itself is the problem', () => {
  it('reads a request-too-large as too long', () => {
    expect(classifyTurnFailure(apiError(413, 'request_too_large'))).toBe('tooLong');
  });

  it('reads a 413 with no body as too long', () => {
    expect(classifyTurnFailure(apiError(413))).toBe('tooLong');
  });

  it('reads a 400 that mentions the context window as too long', () => {
    /**
     * The one 400 worth distinguishing. A long conversation eventually exceeds the
     * window, and the fix — start a new conversation — is something the person can do
     * immediately and would never guess from "something went wrong".
     */
    const err = apiError(400, undefined, 'prompt is too long: 210000 tokens > 200000 maximum');
    expect(classifyTurnFailure(err)).toBe('tooLong');
  });

  it('leaves an ordinary 400 as unknown', () => {
    /** Claiming a malformed request is a length problem sends somebody deleting a
     *  conversation that was fine. */
    expect(classifyTurnFailure(apiError(400, undefined, 'messages: unexpected role'))).toBe(
      'unknown',
    );
  });
});

describe('the network', () => {
  it('reads a connection error by name', () => {
    expect(classifyTurnFailure({ name: 'APIConnectionError', message: 'socket hang up' })).toBe(
      'network',
    );
  });

  it('reads a connection timeout by name', () => {
    expect(classifyTurnFailure({ name: 'APIConnectionTimeoutError' })).toBe('network');
  });

  it('reads Node’s bare fetch failure', () => {
    /** What escapes when the socket never opens at all — no status, no API body. */
    expect(classifyTurnFailure(new TypeError('fetch failed'))).toBe('network');
  });
});

describe('upstream', () => {
  it('reads any other 5xx as upstream', () => {
    expect(classifyTurnFailure(apiError(502))).toBe('upstream');
    expect(classifyTurnFailure(apiError(503))).toBe('upstream');
  });

  it('reads an explicit api_error as upstream', () => {
    expect(classifyTurnFailure(apiError(500, 'api_error'))).toBe('upstream');
  });
});

describe('when it genuinely cannot tell', () => {
  /** `unknown` is the honest answer, and it is the ONLY case the generic
   *  "try asking again" sentence actually fits. */
  it('says unknown for a plain Error', () => {
    expect(classifyTurnFailure(new Error('boom'))).toBe('unknown');
  });

  it('says unknown for a thrown string', () => {
    expect(classifyTurnFailure('boom')).toBe('unknown');
  });

  it('says unknown for null', () => {
    expect(classifyTurnFailure(null)).toBe('unknown');
  });

  it('says unknown for undefined', () => {
    expect(classifyTurnFailure(undefined)).toBe('unknown');
  });

  it('survives an error whose fields are the wrong types', () => {
    /** A rejected non-Error object is not hypothetical — a library that rejects with a
     *  response body produces exactly this. */
    expect(classifyTurnFailure({ status: '429', error: { type: 42 } })).toBe('unknown');
  });
});

describe('what reaches the server log', () => {
  it('carries the status and the API type, so the failure is diagnosable', () => {
    /** "turn failed: [object Object]" is what this replaces. The log is the only place
     *  the failure can be diagnosed at all. */
    const line = describeTurnFailure(apiError(529, 'overloaded_error'));
    expect(line).toContain('reason=overloaded');
    expect(line).toContain('status=529');
    expect(line).toContain('type=overloaded_error');
  });

  it('never carries the upstream message', () => {
    /**
     * The load-bearing omission. An error body can quote the request, and CloudWatch has
     * a different retention and access regime than the audit log.
     */
    const err = apiError(401, 'authentication_error', 'invalid x-api-key sk-ant-abc123');
    const line = describeTurnFailure(err);
    expect(line).not.toContain('sk-ant-abc123');
    expect(line).not.toContain('invalid x-api-key');
    expect(line).toContain('reason=credential');
  });

  it('still says something for a non-object', () => {
    expect(describeTurnFailure('boom')).toBe('reason=unknown');
  });

  it('names the error class when there is nothing else', () => {
    expect(describeTurnFailure(new TypeError('fetch failed'))).toContain('name=TypeError');
  });
});
