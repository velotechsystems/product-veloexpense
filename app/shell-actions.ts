'use server';
/**
 * The sidebar's sign-out. A form posting to a server action rather than a link to
 * `/api/auth/signout`, which is Auth.js's own unbranded "Are you sure?" page — a
 * second click on a screen that looks like somebody else's product.
 *
 * In `app/` beside `app/page.tsx` so `scripts/check-server-actions.mjs` sees it.
 */
import { signOut } from '@/auth';

export async function signOutAction() {
  await signOut({ redirectTo: '/login' });
}
