import { describe, expect, it } from 'vitest';
import { serpApiFailureKind, serpApiMessage, serpApiRemedy } from './client';

/**
 * Classifying a SerpApi rejection.
 *
 * Three failures actually happen, and they have three different owners: a rejected key is
 * an admin's to fix, an exhausted plan is finance's, and a rejected parameter is ours.
 * Reporting all three as "the provider could not be reached" told none of them — and on
 * the travel quote that one sentence also claimed the per-diem budget still applied, which
 * is how a provider outage came to be reported as a per-diem rule.
 *
 * The classifier is matched on BOTH the status and the message text because SerpApi uses
 * both: business failures arrive as a 200 with an `error` field, so there is often no
 * status to read at all.
 */

describe('serpApiFailureKind', () => {
  it('reads a rejected key from the status', () => {
    expect(serpApiFailureKind(401, 'Unauthorized')).toBe('KEY_REJECTED');
  });

  it('reads a rejected key from the message, since a 200 can carry one', () => {
    expect(serpApiFailureKind(undefined, 'SerpApi: Invalid API key')).toBe('KEY_REJECTED');
  });

  it('is case-insensitive about the provider’s wording', () => {
    expect(serpApiFailureKind(undefined, 'INVALID API KEY.')).toBe('KEY_REJECTED');
  });

  it('reads an exhausted plan from either signal', () => {
    expect(serpApiFailureKind(429, 'Too Many Requests')).toBe('PLAN_EXHAUSTED');
    expect(serpApiFailureKind(undefined, 'SerpApi: Your account has run out of searches')).toBe(
      'PLAN_EXHAUSTED',
    );
    expect(serpApiFailureKind(undefined, 'Monthly searches exceeded')).toBe('PLAN_EXHAUSTED');
  });

  it('reads a parameter fault as ours rather than the operator’s', () => {
    expect(serpApiFailureKind(400, 'Bad Request')).toBe('BAD_REQUEST');
    expect(serpApiFailureKind(undefined, 'departure_id is missing')).toBe('BAD_REQUEST');
    expect(serpApiFailureKind(undefined, 'unsupported engine')).toBe('BAD_REQUEST');
  });

  it('says it does not know rather than guessing', () => {
    /** A provider can fail in ways nobody has seen; naming the wrong cause sends somebody
     *  to check a setting that was never wrong. */
    expect(serpApiFailureKind(503, 'Service Unavailable')).toBe('UNKNOWN');
    expect(serpApiFailureKind(undefined, 'socket hang up')).toBe('UNKNOWN');
  });

  it('puts a rejected key ahead of a status that says otherwise', () => {
    // A proxy can turn an auth failure into a 429; the message is the better evidence.
    expect(serpApiFailureKind(429, 'Invalid API key')).toBe('KEY_REJECTED');
  });
});

describe('serpApiRemedy', () => {
  it('gives each classified failure its own instruction', () => {
    expect(serpApiRemedy(401, 'Unauthorized')).toMatch(/key was rejected/i);
    expect(serpApiRemedy(429, 'Too Many Requests')).toMatch(/no searches left/i);
    expect(serpApiRemedy(400, 'Bad Request')).toMatch(/bug on our side/i);
  });

  it('offers nothing for a failure it cannot classify', () => {
    /** Silence beats a remedy that sends somebody to the wrong settings page. */
    expect(serpApiRemedy(503, 'Service Unavailable')).toBeNull();
  });

  it('agrees with the classifier for every kind', () => {
    /** The two must not drift: Test Connection renders this prose while the travel quote
     *  translates the code, and they describe the same error to two audiences. */
    for (const [status, message] of [
      [401, 'Unauthorized'],
      [429, 'Too Many Requests'],
      [400, 'Bad Request'],
      [503, 'Service Unavailable'],
    ] as const) {
      const kind = serpApiFailureKind(status, message);
      expect(serpApiRemedy(status, message) === null, `${kind}`).toBe(kind === 'UNKNOWN');
    }
  });
});

describe('serpApiMessage', () => {
  it('reads the provider’s reason out of an error body', () => {
    expect(serpApiMessage('{"error":"Invalid API key"}')).toBe('Invalid API key');
  });

  it('returns nothing for an HTML or proxy page', () => {
    /** A 502 from a CDN is not JSON, and rendering its markup as a reason is worse than
     *  falling back to the raw status. */
    expect(serpApiMessage('<html>502 Bad Gateway</html>')).toBeNull();
  });

  it('returns nothing for JSON with no error in it', () => {
    expect(serpApiMessage('{"search_metadata":{}}')).toBeNull();
    expect(serpApiMessage('{"error":"   "}')).toBeNull();
  });

  it('bounds a very long reason, so a log line cannot be flooded', () => {
    expect(serpApiMessage(JSON.stringify({ error: 'x'.repeat(500) }))?.length).toBe(200);
  });
});
