/**
 * VX4-9 — the admin gate, in ONE place, with two exits.
 *
 * ── WHAT WAS WRONG, AND IT WAS TWO THINGS ───────────────────────────────────
 *
 * `e2e/crawl.spec.ts` found it on its first run: **every one of the fifteen
 * `/admin/*` pages answered HTTP 500 to a manager or an employee**, and had since
 * VX1-2. Authorization was never the problem — the predicate throws before the
 * page renders, so nothing leaked. Two other things were:
 *
 * 1. **THE REFUSAL LOOKED LIKE A CRASH.** `asAdmin` threw a bare
 *    `Error('forbidden: admin role required')` inside a server component, nothing
 *    caught it, and Next rendered its error boundary. Somebody with a stale
 *    bookmark got "Application error"; monitoring logged a 500 every time the
 *    product worked correctly, which buries the 500s that mean something.
 * 2. **THE GATE WAS COPY-PASTED FIFTEEN TIMES.** All fifteen predicates were
 *    diffed for this ticket. Fourteen were byte-identical and one —
 *    `app/admin/employees/actions.ts` — had already been refactored to delegate
 *    to an `asMember`. Same predicate, so there was no hole; but the copies had
 *    already begun to diverge in shape, which is MT-3's whole point ("a gate at
 *    the edge is a gate the next caller forgets") arriving on schedule.
 *
 * ── TWO EXITS, BECAUSE A READ AND A WRITE ARE REFUSED DIFFERENTLY ───────────
 *
 * `asAdminPage` is for a page's READ. It calls Next's `forbidden()`, which
 * renders `app/forbidden.tsx` with a 403 — a page that says no, and a status code
 * an operator can filter on.
 *
 * `asAdmin` is for a server ACTION. It throws `ForbiddenError`, a `DomainError`
 * carrying a catalogued user message, so the screen shows a sentence instead of
 * the generic "something went wrong on our side". That generic is what a
 * non-admin got before, because a bare `Error` is exactly what `errorParam`
 * refuses to put in front of a person (IL-11) — so this ticket fixes the write
 * path's copy as well as the read path's status.
 *
 * They are NOT one function with a flag. `forbidden()` throws a control-flow
 * error Next must be allowed to catch, and every action here is wrapped in a
 * `guarded()` that catches everything and redirects — so a page-shaped refusal
 * inside an action would be swallowed and shown as a generic error. Keeping them
 * apart is what stops that, and `scripts/check-admin-gate.mjs` is what stops a
 * sixteenth copy of either.
 */
import { forbidden } from 'next/navigation';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import { type EmployeeRow } from '@/lib/employees/service';
import type { QueryRunner } from '@/lib/db/client';
import { ForbiddenError, isActiveAdmin, requireActor } from '@/lib/auth/actor';

/**
 * NO SECOND REFUSAL CLASS, AND NO SECOND PREDICATE.
 *
 * The first draft of this file declared its own `ForbiddenError` and resolved
 * the acting employee with its own `getEmployeeByEmail` call. Both were wrong in
 * the same way the fifteen copies were: `lib/auth/actor.ts` has resolved the
 * actor since VX1-10, and its refusal already extends `DomainError`. A second
 * class of the same name would have differed from the first only in which file
 * imported it — which is fine until the day somebody writes `instanceof
 * ForbiddenError` and it silently answers false. Worse, the private resolver
 * skipped `requireActor`'s `deleted_at` clause, so a DEACTIVATED employee would
 * have passed `asMember` here while being refused everywhere else in the
 * product. Ported the gate; did not port a fork of it.
 *
 * `isActiveAdmin` lives in `lib/auth/actor.ts` for the same reason and one more:
 * this module imports `@/auth`, which pulls next-auth's runtime into anything
 * that touches it — and vitest cannot load it (`Cannot find module
 * 'next/server'`). A predicate no unit test can reach is a predicate that gets
 * its `deleted_at` clause back only after somebody notices. It is pure, it takes
 * a row, and it belongs beside `requireActor`.
 */

/** The email on the session, or a readable refusal. */
async function sessionEmail(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    throw new ForbiddenError('unauthenticated', 'UNAUTHENTICATED', 'SIGN_IN_REQUIRED');
  }
  return email;
}

/**
 * The signed-in employee, whoever they are. Throws rather than rendering.
 *
 * `requireActor` is the membership predicate — no row in this tenant, or a
 * soft-deleted row, and it refuses with a catalogued sentence of its own.
 */
export async function asMember<T>(
  fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>,
): Promise<T> {
  const email = await sessionEmail();
  return withCurrentOrg(async (tx) => fn(tx, await requireActor(tx, email)));
}

/**
 * FOR A SERVER ACTION. Throws `ForbiddenError`, which `errorParam` turns into a
 * catalogued sentence.
 */
export async function asAdmin<T>(
  fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>,
): Promise<T> {
  return asMember(async (tx, actor) => {
    if (!isActiveAdmin(actor)) {
      throw new ForbiddenError('admin role required', 'NOT_AN_ADMIN', 'ADMIN_ONLY');
    }
    return fn(tx, actor);
  });
}

/**
 * FOR A PAGE'S READ. Renders `app/forbidden.tsx` with a 403 instead of throwing.
 *
 * `forbidden()` never returns — its thrown value is Next's own control flow, and
 * the `as never` says so. It must not be wrapped in a try/catch that swallows
 * unknown errors, which is the reason this is a separate function from `asAdmin`
 * rather than an option on it.
 */
export async function asAdminPage<T>(
  fn: (tx: QueryRunner, actor: EmployeeRow) => Promise<T>,
): Promise<T> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) forbidden();
  return withCurrentOrg(async (tx) => {
    // Same predicate as `asMember`, different exit: `requireActor`'s refusal is
    // a thrown `ForbiddenError`, and on a page that is a 500. Catching only our
    // own class and re-throwing everything else keeps a database fault a fault —
    // a bare `catch { forbidden() }` here would report a dead connection as a
    // permission denial, which is the mirror image of the bug being fixed.
    let actor: EmployeeRow;
    try {
      actor = await requireActor(tx, email);
    } catch (err) {
      if (err instanceof ForbiddenError) forbidden();
      throw err;
    }
    if (!isActiveAdmin(actor)) forbidden();
    return fn(tx, actor);
  });
}
