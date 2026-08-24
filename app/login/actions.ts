'use server';
/**
 * The org-slug cookie is HttpOnly, so it MUST be set server-side (the browser
 * silently drops HttpOnly cookies set via document.cookie). The kit's signIn
 * callback reads it after the OAuth round-trip to resolve (org, email).
 */
import { cookies } from 'next/headers';
import { orgCookieName } from '@/src/auth-kit/org-cookie';

export async function setSsoOrgCookie(orgSlug: string): Promise<{ ok: boolean }> {
  const slug = orgSlug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return { ok: false };
  const jar = await cookies();
  jar.set(orgCookieName('veloexpense'), slug, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // allow http on localhost dev
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return { ok: true };
}
