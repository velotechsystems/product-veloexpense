/**
 * `safeCallbackPath` — where a successful sign-in lands, and what it refuses.
 * See `lib/auth/callback-url.ts` for the bug and the reasoning.
 */
import { describe, it, expect } from 'vitest';
import { safeCallbackPath } from '@/lib/auth/callback-url';

describe('safeCallbackPath', () => {
  it.each([
    ['/', '/'],
    ['/expenses', '/expenses'],
    ['/approvals?tab=mine', '/approvals?tab=mine'],
    ['/expenses/123#receipt', '/expenses/123#receipt'],
    ['/loginfo', '/loginfo'], // a path that merely STARTS with "login" is fine
  ])('keeps the same-origin path %s', (raw, want) => {
    expect(safeCallbackPath(raw)).toBe(want);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['an absolute URL', 'https://evil.example/'],
    ['a scheme', 'javascript:alert(1)'],
    ['protocol-relative', '//evil.example/'],
    ['backslash protocol-relative', '/\\evil.example/'],
    ['a backslash later on', '/x\\..\\evil'],
    ['a tab', '/\t/evil.example'],
    ['a newline', '/\n/evil.example'],
    ['a space', '/ /evil.example'],
    ['no leading slash', 'expenses'],
    ['the login page', '/login'],
    ['the login page with a query', '/login?callbackUrl=%2F'],
    ['the signup page', '/signup'],
    ['the signup verify page', '/signup/verify?token=x'],
    ['the auth handler', '/api/auth/signout'],
    ['something absurdly long', `/${'a'.repeat(3000)}`],
  ])('falls back to / for %s', (_label, raw) => {
    expect(safeCallbackPath(raw as string | null | undefined)).toBe('/');
  });
});
