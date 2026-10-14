'use server';
/**
 * VX5-4 — the home page's reads; since w4-09 (d72) the setup checklist's, on ExpenseOS's
 * dashboard (`app/(app)/dashboard/SetupChecklist.tsx`), beside which it moved from `app/`
 * so the build registers its actions for the page that posts them (`check:actions`).
 *
 * One module, two actions, and the split matters: the checklist is ADMIN work
 * and reading it needs the admin gate, but the dashboard is the page every signed-in
 * person lands on. So the member read and the admin read are separate calls, and the
 * page makes the second one only when the first says the reader is an admin.
 * An employee never asks for the checklist and never gets a refusal page for
 * something that was never theirs to do.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { errorParam } from '@/lib/errors/domain';
import { asAdmin, asAdminPage, asMember } from '@/lib/auth/admin-guard';
import { isActiveAdmin } from '@/lib/auth/actor';
import { isSetupCollapsed, setSetupCollapsed, setupStatus } from '@/lib/onboarding/setup';
import { getBranding } from '@/lib/branding/service';

export async function getHomeContext() {
  return asMember(async (tx, actor) => ({
    name: actor.display_name ?? actor.email,
    isAdmin: isActiveAdmin(actor),
    organizationName: (await getBranding(tx)).name,
  }));
}

export async function getSetupStatus() {
  return asAdminPage(async (tx, actor) => ({
    ...(await setupStatus(tx)),
    collapsed: await isSetupCollapsed(tx, actor.id),
  }));
}

/**
 * "Hide" / "Show" on the checklist (decided 7 Oct: collapse to one line, never
 * dismiss). Admin-gated like the checklist itself. The only input is which way,
 * read as a closed choice so a hand-edited form cannot store anything else.
 */
export async function setSetupCollapsedFromForm(form: FormData) {
  const collapsed = form.get('collapsed') === '1';
  let failure: string | null = null;
  try {
    await asAdmin((tx, actor) => setSetupCollapsed(tx, actor.id, collapsed));
  } catch (err) {
    failure = `/dashboard?error=${encodeURIComponent(errorParam(err, 'home'))}`;
  }
  // Outside the try: `redirect` works by throwing, and a catch-all would eat it.
  if (failure) redirect(failure);
  revalidatePath('/dashboard');
}
