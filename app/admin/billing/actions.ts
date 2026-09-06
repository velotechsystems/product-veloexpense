'use server';
/**
 * VX5-11 — /admin/billing. The read behind the screen.
 *
 * ADMIN only, same gate as every other `/admin` surface, and every export is an
 * `export async function` — see `npm run check:actions`.
 *
 * ── NO ACTIONS YET, AND THE ABSENCE IS THE POINT ────────────────────────────
 *
 * There is no "change plan" and no "cancel". Both are things a PROVIDER will own
 * once VX5-10 wires one up — a plan change is a proration the provider computes,
 * and a cancellation is a decision their dunning and refund rules act on. Writing
 * either here first would mean building the half that has to be thrown away, and
 * worse, a window in which our row and theirs disagree about what a customer is
 * paying for.
 *
 * So this screen READS, and the page says plainly that it does.
 */
import { asAdminPage } from '@/lib/auth/admin-guard';
import { listPlans, liveSubscription, recentReadings } from '@/lib/billing/service';

export async function getBillingPage() {
  return asAdminPage(async (tx) => ({
    subscription: await liveSubscription(tx),
    // The catalogue is shown whatever the tenant is on, so an administrator can
    // see what else exists. Inactive plans are excluded — a withdrawn price is
    // not an offer — which is why the page resolves the CURRENT plan from the
    // subscription rather than assuming it appears in this list.
    plans: await listPlans(tx),
    readings: await recentReadings(tx),
  }));
}
