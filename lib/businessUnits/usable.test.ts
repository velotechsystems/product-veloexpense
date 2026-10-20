import { describe, expect, it } from 'vitest';
import { businessUnitUsable } from './usable';

describe('f09 — businessUnitUsable', () => {
  it('allows no unit', () => {
    expect(businessUnitUsable(null, null)).toBe(true);
    expect(businessUnitUsable(undefined, null)).toBe(true);
  });
  it('allows an active unit', () => {
    expect(businessUnitUsable('u1', { active: true })).toBe(true);
  });
  it('refuses a deactivated or unknown unit', () => {
    expect(businessUnitUsable('u1', { active: false })).toBe(false);
    expect(businessUnitUsable('u1', null)).toBe(false);
  });
  it('keeps the unit the record already carries, even deactivated', () => {
    expect(businessUnitUsable('u1', { active: false }, 'u1')).toBe(true);
    expect(businessUnitUsable('u2', { active: false }, 'u1')).toBe(false);
  });
});
