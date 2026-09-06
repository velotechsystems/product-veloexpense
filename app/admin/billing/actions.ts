'use server';
/**
 * VX5-11 — /admin/billing. The read behind the screen.
 *
 * ADMIN only, same gate as every other `/admin` surface, and every export is an
 * `export async function` — see `npm run check:actions`.
 *
 * ── NO ACTIONS, EVER, AND THE ABSENCE IS THE POINT ──────────────────────────
 *
 * There is no "change plan" and no "cancel", and after VX5-19 there never will
 * be. Billing belongs to the VeloTech platform: the operator console owns the
 * catalogue, the checkout, the provisioning and the revenue view, for every
 * product in the suite. A plan change made here would be a second system deciding
 * one thing, and the two would disagree the first time somebody used the other.
 *
 * So this screen READS a mirror, and says plainly where the decisions are made.
 */
import { asAdminPage } from '@/lib/auth/admin-guard';
import { liveSubscription, recentReadings } from '@/lib/billing/service';
import { platformConfigured } from '@/lib/billing/entitlements';

export async function getBillingPage() {
  return asAdminPage(async (tx) => ({
    subscription: await liveSubscription(tx),
    readings: await recentReadings(tx),
    // Whether the platform integration is configured at all. The screen has to
    // distinguish "nobody is billing this tenant" from "billing is switched off
    // in this deployment" — AC-22's rule, which this project has now applied to a
    // module being off, a queue being empty, and here.
    platformConfigured: platformConfigured(),
  }));
}
