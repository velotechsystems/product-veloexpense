// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { signupOpen } from './signupGate';

/** 18 Oct 2026: /signup is closed unless a deployment says otherwise — production does not. */
describe('signupOpen', () => {
  const before = process.env.SIGNUP_ENABLED;
  afterEach(() => {
    if (before === undefined) delete process.env.SIGNUP_ENABLED;
    else process.env.SIGNUP_ENABLED = before;
  });

  it('is closed when the variable is unset — a deployment that forgets it has no public front door', () => {
    delete process.env.SIGNUP_ENABLED;
    expect(signupOpen()).toBe(false);
  });

  it('is open only for the exact string true', () => {
    process.env.SIGNUP_ENABLED = 'true';
    expect(signupOpen()).toBe(true);
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
      process.env.SIGNUP_ENABLED = v;
      expect(signupOpen()).toBe(false);
    }
  });

  it('is read at call time, not at import', () => {
    delete process.env.SIGNUP_ENABLED;
    expect(signupOpen()).toBe(false);
    process.env.SIGNUP_ENABLED = 'true';
    expect(signupOpen()).toBe(true);
  });
});
