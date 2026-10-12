import { describe, expect, it } from 'vitest';
import { addBusinessDays, DEFAULT_TTL_BUSINESS_DAYS } from './businessDays';

// 2026-01-02 is a Friday; 2026-01-05 the following Monday.
const FRI = () => new Date(2026, 0, 2);
const MON = () => new Date(2026, 0, 5);

describe('addBusinessDays', () => {
  it('returns the same date for 0', () => {
    expect(addBusinessDays(FRI(), 0).getTime()).toBe(FRI().getTime());
  });

  it('skips the weekend: Friday + 1 → Monday', () => {
    const d = addBusinessDays(FRI(), 1);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getDate()).toBe(5);
  });

  it('five business days = the following week (Mon → Mon, 7 calendar days)', () => {
    const d = addBusinessDays(MON(), 5);
    expect(d.getDay()).toBe(1);
    expect(d.getDate()).toBe(12);
  });

  it('never lands on a weekend', () => {
    for (let start = 1; start <= 7; start += 1) {
      for (let n = 1; n <= 15; n += 1) {
        const day = addBusinessDays(new Date(2026, 5, start), n).getDay();
        expect(day).not.toBe(0);
        expect(day).not.toBe(6);
      }
    }
  });

  it('does not mutate its input', () => {
    const from = FRI();
    const t = from.getTime();
    addBusinessDays(from, 10);
    expect(from.getTime()).toBe(t);
  });

  it('exposes a sane default TTL', () => {
    expect(DEFAULT_TTL_BUSINESS_DAYS).toBe(5);
  });
});
