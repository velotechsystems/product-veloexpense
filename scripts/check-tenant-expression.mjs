/**
 * PE-9 — the tenant predicate is declared ONCE, in `lib/tenant/sql.ts`.
 *
 * ── WHY A SCRIPT AND NOT A CODE REVIEW ──────────────────────────────────────
 *
 * The audit named this defect at 17 sites. By the time it was fixed there were
 * 20: three more local copies were written, each by somebody following the
 * pattern in the file next door, in the window between the problem being written
 * down and being fixed. A rule with no enforcement is a rule that decays at
 * roughly the rate the codebase grows, which is MT-3's lesson arriving for the
 * fourth time in this project.
 *
 * ── WHAT IT REFUSES, AND WHY THE BARE FORM IS THE WRONG ONE ─────────────────
 *
 * Any `current_setting('app.current_org', …)` in `lib/` or `app/` that is not
 * the one declaration. The bare `current_setting(...)::uuid` is the specific
 * mistake: once the GUC has been set on a pooled connection, Postgres returns
 * `''` afterwards rather than NULL, and `''::uuid` raises
 * `22P02 invalid input syntax for type uuid` instead of matching no rows. Not a
 * leak — every site is reached through `withOrg` — but a parser error is the
 * wrong thing to hand a scheduled job that arrived without a tenant.
 *
 * ── WHAT IT DELIBERATELY DOES NOT POLICE ────────────────────────────────────
 *
 * The OTHER GUCs — `app.platform_task`, `app.audit_purge`, `app.signup_task`,
 * `app.signup_consume`, `app.invite_lookup`. Each is read in exactly one place
 * (`lib/tenant/context.ts`) and compared as a string rather than cast, so
 * neither the duplication nor the cast failure applies. A guard that policed
 * them too would be a guard that had to be argued with every time a hatch is
 * added, and IL-7's rule is that a guard which restates a list stops matching
 * it.
 *
 * COMMENTS are exempt. Five files explain WHY the `NULLIF` matters, quoting the
 * expression to do it, and a guard that forbade the explanation would be a guard
 * that deleted its own reason for existing.
 *
 * ONE REAL USE IS EXEMPT, by name: `lib/audit/chain.ts`'s advisory lock hashes
 * the RAW SETTING — `hashtext(current_setting('app.current_org', true))` — and
 * does not cast it. Substituting `ORG` there would hash a uuid cast instead of
 * the text, which is a different lock key for the same tenant, which is a
 * serialization bug rather than a tidiness one. It is listed here rather than
 * pattern-matched so that adding a second exemption is a deliberate edit.
 *
 * `prisma/migrations/**` is exempt: policies are SQL, they are where the
 * expression is CORRECTLY spelled out in full, and a migration is immutable
 * anyway.
 *
 * ── AND THE MISTAKE THIS REFACTOR ITSELF MADE ───────────────────────────────
 *
 * Replacing twenty copies with `${ORG}` introduced a failure mode that did not
 * exist before: `${ORG}` inside a SINGLE- or DOUBLE-quoted string is not an
 * interpolation. It compiles, it lints, and it sends the four literal characters
 * to Postgres, which answers `syntax error at or near "$"`.
 *
 * It happened once during this very change — `lib/notifications/dispatch.ts`
 * had a double-quoted query — and cost nineteen failing tests to find. The
 * database suite catches it loudly, which is the honest safety net, but a
 * `tsc`-clean edit that breaks nineteen tests is worth catching one step
 * earlier. So the guard checks both directions: the expression must not be
 * written twice, and the constant must not be interpolated into a string that
 * cannot interpolate.
 *
 * Run:  node scripts/check-tenant-expression.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['lib', 'app'];
/** The one file allowed to say it. */
const HOME = 'lib/tenant/sql.ts';
const PATTERN = /current_setting\(\s*'app\.current_org'/;
/** See the header: the advisory lock hashes the raw setting, uncast. */
const EXEMPT = new Set(['lib/audit/chain.ts:hashtext']);

/** A line that only TALKS about the expression is documentation, not a copy. */
function isComment(line) {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Is this `${ORG}` inside a template literal?
 *
 * Scans backwards for the nearest unescaped quote of any kind. A backtick means
 * yes; a `'` or `"` closer than the nearest backtick means the interpolation is
 * inert. Line comments are skipped first, so the worked example in
 * `lib/integrations/post-outbox.ts` — which shows the WRONG one-statement
 * version inside a `//` block — does not trip it.
 */
function inertInterpolations(file, src) {
  const found = [];
  const lines = src.split('\n');
  const re = /\$\{ORG\}/g;
  let offset = 0;
  lines.forEach((line, i) => {
    if (!isComment(line)) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        const at = offset + m.index;
        const backtick = src.lastIndexOf('`', at);
        const single = src.lastIndexOf("'", at);
        const double = src.lastIndexOf('"', at);
        if (Math.max(single, double) > backtick) {
          found.push({ file, line: i + 1, text: line.trim() });
        }
      }
    }
    offset += line.length + 1;
  });
  return found;
}

const problems = [];
const inert = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (file === HOME) continue;
    const src = readFileSync(file, 'utf8');
    inert.push(...inertInterpolations(file, src));
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!PATTERN.test(line)) return;
      if (isComment(line)) return;
      if (line.includes('hashtext(') && EXEMPT.has(`${file}:hashtext`)) return;
      problems.push({ file, line: i + 1, text: line.trim() });
    });
  }
}

if (inert.length > 0) {
  console.error(
    'check-tenant-expression FAILED — ${ORG} in a string that cannot interpolate.\n',
  );
  for (const p of inert) {
    console.error(`  ${p.file}:${p.line}`);
    console.error(`      ${p.text.slice(0, 100)}`);
  }
  console.error(`
  A single- or double-quoted string sends the four literal characters to
  Postgres, which answers: syntax error at or near "$". Use a template literal.`);
  process.exit(1);
}

if (problems.length > 0) {
  console.error('check-tenant-expression FAILED — the tenant predicate is written more than once.\n');
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}`);
    console.error(`      ${p.text.slice(0, 100)}`);
  }
  console.error(`
  Import it instead:

      import { ORG } from '@/lib/tenant/sql';
      ...  WHERE organization_id = \${ORG}

  ${HOME} explains why the NULLIF matters: without it a connection that has
  already carried a tenant returns '' rather than NULL, and ''::uuid is a parser
  error rather than a row that does not match.`);
  process.exit(1);
}

console.log(
  `check-tenant-expression OK — the tenant predicate is declared once, in ${HOME}.`,
);
