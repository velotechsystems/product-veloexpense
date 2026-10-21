import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimMapsKey, onMapsAuthFailure, resetMapsPageForTests } from './googleMapsPage';

/**
 * The page-wide facts about Google's Maps script: a refused key (Google's global
 * `gm_authFailure`) and the key the script was loaded with. Both matter because the
 * script loads once per page — a map opened later inherits what happened earlier.
 */

type AuthWindow = Window & { gm_authFailure?: () => void };
const fire = () => (window as AuthWindow).gm_authFailure?.();

beforeEach(() => {
  vi.useFakeTimers();
  resetMapsPageForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('onMapsAuthFailure', () => {
  it('tells every subscriber when Google refuses the key, until they unsubscribe', () => {
    const a = vi.fn();
    const b = vi.fn();
    const stopA = onMapsAuthFailure(a);
    onMapsAuthFailure(b);
    stopA();
    fire();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('keeps a handler the page already had', () => {
    const earlier = vi.fn();
    (window as AuthWindow).gm_authFailure = earlier;
    onMapsAuthFailure(vi.fn());
    fire();
    expect(earlier).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal that already happened to a map opened afterwards', () => {
    onMapsAuthFailure(vi.fn());
    fire();
    const later = vi.fn();
    onMapsAuthFailure(later);
    expect(later).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe('claimMapsKey', () => {
  it('is "same" for the key the page loads first, and "other" for any other', () => {
    expect(claimMapsKey('first')).toBe('same');
    expect(claimMapsKey('first')).toBe('same');
    expect(claimMapsKey('second')).toBe('other');
  });
});
