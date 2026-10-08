import { describe, expect, it } from 'vitest';
import { shellFree } from '@/lib/shell-free';

/** Moved with the rule from test/nav-sections.test.ts (the retired #147 shell). */
describe('shellFree', () => {
  it.each([
    ['/login', true],
    ['/login/verify', true],
    ['/signup', true],
    ['/approve/tok123', true],
    ['/invite/abc', true],
    ['/', false],
    ['/loginx', false],
    ['/expenses', false],
    ['/admin/employees/invite', false],
  ])('%s → %s', (path, want) => {
    expect(shellFree(path)).toBe(want);
  });
});
