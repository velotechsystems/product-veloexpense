import { describe, expect, it } from 'vitest';
import { bodyForLog, outcomeForTrpcCode } from './apiKeyGuard';

describe('bodyForLog', () => {
  it('redacts by default, because a new operation is sensitive until declared otherwise', () => {
    // The direction that matters: `virtualCards.reveal` returns a PAN and a CVV, and a log
    // that stored bodies by default would be a plaintext card store.
    expect(bodyForLog('tools/call', { reportId: 'r1' })).toEqual({ redacted: true });
    expect(bodyForLog('anything/new', { pan: '4111111111111111' })).toEqual({ redacted: true });
  });

  it('stores a body for an operation explicitly declared safe', () => {
    expect(bodyForLog('tools/list', { cursor: null })).toEqual({ cursor: null });
  });

  it('leaves an absent body absent rather than recording a null', () => {
    expect(bodyForLog('tools/list', undefined)).toBeUndefined();
  });

  it('truncates an enormous loggable body instead of storing it', () => {
    const huge = { blob: 'x'.repeat(20_000) };
    expect(bodyForLog('tools/list', huge)).toMatchObject({ truncated: true });
  });
});

describe('outcomeForTrpcCode', () => {
  it('maps a procedure refusal to DENIED_PERMISSION', () => {
    // The permission check stays in the procedure, which is authoritative. This outcome is
    // produced by observing its refusal rather than by predicting it.
    expect(outcomeForTrpcCode('FORBIDDEN')).toBe('DENIED_PERMISSION');
    expect(outcomeForTrpcCode('UNAUTHORIZED')).toBe('DENIED_PERMISSION');
  });

  it('maps anything else to ERROR rather than guessing', () => {
    expect(outcomeForTrpcCode('INTERNAL_SERVER_ERROR')).toBe('ERROR');
    expect(outcomeForTrpcCode('BAD_REQUEST')).toBe('ERROR');
  });
});
