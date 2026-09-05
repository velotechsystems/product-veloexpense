'use server';
/**
 * VX5-4 — the home page's reads.
 *
 * One module, two actions, and the split matters: the checklist is ADMIN work
 * and reading it needs the admin gate, but `/` is a page every signed-in person
 * lands on. So the member read and the admin read are separate calls, and the
 * page makes the second one only when the first says the reader is an admin.
 * An employee never asks for the checklist and never gets a refusal page for
 * something that was never theirs to do.
 */
import { asAdminPage, asMember } from '@/lib/auth/admin-guard';
import { isActiveAdmin } from '@/lib/auth/actor';
import { setupStatus } from '@/lib/onboarding/setup';
import { getBranding } from '@/lib/branding/service';

export async function getHomeContext() {
  return asMember(async (tx, actor) => ({
    name: actor.display_name ?? actor.email,
    isAdmin: isActiveAdmin(actor),
    organizationName: (await getBranding(tx)).name,
  }));
}

export async function getSetupStatus() {
  return asAdminPage((tx) => setupStatus(tx));
}
