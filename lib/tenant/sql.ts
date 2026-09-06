/**
 * PE-9 — the tenant predicate, once.
 *
 * ── WHAT WAS WRONG WITH TWENTY COPIES ───────────────────────────────────────
 *
 * Every service in this codebase declared its own:
 *
 *     const ORG = "current_setting('app.current_org', true)::uuid";
 *
 * and nineteen of them omitted the `NULLIF`. That matters for a reason `0001`'s
 * migration already wrote down about the POLICIES, where it is done correctly:
 * once `app.current_org` has been set on a pooled connection, Postgres returns
 * `''` for it afterwards rather than NULL — and `''::uuid` is a TYPE ERROR, not
 * a row that fails to match.
 *
 * So the two spellings fail differently. `NULLIF(…, '')::uuid` yields NULL,
 * which matches nothing: a refusal. The bare one raises
 * `22P02 invalid input syntax for type uuid: ""`, which is a 500 with a message
 * about parsing, handed to whatever asked.
 *
 * Neither is a LEAK — every site is reached through `withOrg`, and off that path
 * the query fails closed either way. What the bare form costs is legibility at
 * exactly the moment somebody needs it: a scheduled job or a new pre-auth path
 * arriving without a tenant gets a parser error instead of a refusal naming the
 * problem. The audit called it 17 sites; it was 20 by the time this ran, which
 * is the argument for a shared constant rather than a careful sweep.
 *
 * ── AND A GUARD, BECAUSE A SWEEP IS NOT A FIX ───────────────────────────────
 *
 * `scripts/check-tenant-expression.mjs` refuses a twenty-first local copy. Three
 * appeared between the audit naming the problem and this fixing it, which is
 * what a rule with no enforcement looks like — MT-3's lesson for the fourth
 * time in this project.
 *
 * ── WHY A STRING AND NOT A FUNCTION ─────────────────────────────────────────
 *
 * It is interpolated into SQL, so it must be a compile-time constant that no
 * caller can influence — `${ORG}` in a template literal, never a parameter. A
 * function returning a string would look like somewhere to pass an org id, and
 * an org id passed here would be an org id outside the RLS predicate, which is
 * the whole thing this product does not do.
 */
export const ORG = "NULLIF(current_setting('app.current_org', true), '')::uuid";
