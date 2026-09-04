#!/usr/bin/env node
/**
 * The admin-gate guard — one gate, in one file, with the right exit per caller.
 *
 * ── WHAT VX4-9 FOUND ────────────────────────────────────────────────────────
 *
 * `e2e/crawl.spec.ts` walked the product as a manager and as an employee and
 * found that **all fifteen `/admin/*` pages answered HTTP 500**, and had since
 * VX1-2. Authorization was never wrong — the gate threw before anything
 * rendered, so nothing leaked. What was wrong was that a REFUSAL was
 * indistinguishable from a FAULT: the person got "Application error", and the
 * operator got a 500 in the logs every time the product worked correctly, which
 * is how a real 500 goes unnoticed.
 *
 * The cause was fifteen copies of the same eight-line predicate, one per
 * `app/admin/*​/actions.ts`. Fourteen were byte-identical; the fifteenth had
 * already been refactored into a different shape. No hole yet — and "not yet" is
 * the whole of MT-3's argument: a gate at the edge is a gate the next caller
 * forgets.
 *
 * So the fix is a shared `lib/auth/admin-guard.ts`, and this file is what stops a
 * sixteenth copy. A written rule already governed the last two of these and was
 * followed only by the people who had read it.
 *
 * ── WHAT IS CHECKED ─────────────────────────────────────────────────────────
 *
 *   A. `asAdmin`, `asAdminPage`, `asMember` and the `isActiveAdmin` predicate
 *      are each DECLARED in exactly one file.
 *   B. Every `app/admin/**​/actions.ts` imports the gate from that file.
 *   C. No file under `app/admin/` reads the session itself (`from '@/auth'`).
 *      A gate re-derived from a token is the bug VX1-10 already fixed once —
 *      a token outlives a demotion, the database row does not.
 *   D. THE EXIT MATCHES THE CALLER. Every export an admin `page.tsx` imports is
 *      one of two things, and the PAGE says which — `<form action={name}>` is a
 *      server action, `await name(…)` is a read during render. They are refused
 *      differently:
 *        · an ACTION must reach `asAdmin`, which throws a catalogued
 *          `ForbiddenError` the form's `guarded()` turns into a sentence.
 *        · a READ must reach `asAdminPage`, which calls `forbidden()` and
 *          renders a 403 rather than throwing into the render.
 *      "Reaches" follows calls within the module: four of the five
 *      `expense-policies` writes gate one level down, in the function they
 *      delegate to. Classifying by NAME was the first draft and it failed on
 *      correct code immediately — `pullFromLedgerForm` is a form action whose
 *      name ends `Form`, not `FromForm`.
 *      D is the check that actually prevents a recurrence: A, B and C would all
 *      pass a new page that gated its read with `asAdmin` and went straight back
 *      to answering 500.
 *   E. No bare `throw new Error('forbidden…')` or `'unauthenticated'` under
 *      `app/admin/`. `errorParam` refuses to put a bare `Error` on a screen
 *      (IL-11, correctly), so such a throw reaches a person as the generic
 *      "something went wrong on our side" — which is the write path's half of
 *      this same ticket.
 *
 * ── WHAT IS DELIBERATELY NOT CHECKED ────────────────────────────────────────
 *
 *   · `app/expenses/actions.ts` and `app/receipts/actions.ts` have their own
 *     `asActor` over `requireActor`. That is the MEMBER gate, not the admin one,
 *     and folding them in would have widened VX4-9 into a refactor of the
 *     employee surfaces. They are named here so the next reader knows it was a
 *     decision and not an oversight.
 *   · Non-page exports. An export no page imports is reached only by a form
 *     `action={…}` or not at all, and `check:actions` already governs that file's
 *     export shape.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';

const ROOT = process.cwd();

/** The one file allowed to declare the gate. */
const GUARD = 'lib/auth/admin-guard.ts';
const GUARD_MODULE = '@/lib/auth/admin-guard';

/**
 * Each gate, and the ONE file allowed to declare it.
 *
 * `isActiveAdmin` is the odd one out and deliberately so: it is a pure predicate
 * on a row, it lives in `lib/auth/actor.ts` beside `requireActor`, and the
 * reason is that `admin-guard.ts` imports `@/auth` — whose next-auth runtime
 * vitest cannot load, so a predicate declared there is a predicate no unit test
 * can reach. It is policed here all the same: a second copy of the ADMIN test is
 * exactly as bad as a second copy of the wrapper around it.
 */
const GATE_HOME = {
  asAdmin: GUARD,
  asAdminPage: GUARD,
  asMember: GUARD,
  isActiveAdmin: 'lib/auth/actor.ts',
};
const GATES = Object.keys(GATE_HOME);

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'test-results', 'playwright-report']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Comments blanked, offsets preserved — same helper and same reasoning as
 * `check-harness-leak.mjs`, including why it is not a parser. Every check below
 * runs on the blanked text, because these files EXPLAIN the gate at length and a
 * guard that fails on a sentence about itself is a guard people delete.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const offenders = [];
const fail = (file, line, what, why, fix) => offenders.push({ file, line, what, why, fix });

const rels = walk(ROOT)
  .map((full) => relative(ROOT, full).split(sep).join('/'))
  .filter((rel) => rel.endsWith('.ts') || rel.endsWith('.tsx'));

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const codeOf = (rel) => stripComments(read(rel));

if (!existsSync(join(ROOT, GUARD))) {
  console.error(`check-admin-gate FAILED — ${GUARD} does not exist.`);
  process.exit(1);
}

// ── A. Declared in exactly one file ────────────────────────────────────────
for (const rel of rels) {
  const code = codeOf(rel);
  for (const gate of GATES) {
    if (rel === GATE_HOME[gate]) continue;
    const m = new RegExp(`(?:async\\s+)?function\\s+${gate}\\b|(?:const|let|var)\\s+${gate}\\s*=`).exec(code);
    if (m) {
      fail(
        rel,
        lineOf(code, m.index),
        `a local \`${gate}\``,
        `\`${gate}\` is declared in ${GATE_HOME[gate]} and nowhere else — fifteen copies is what VX4-9 was`,
        `Delete it and import \`${gate}\` from there.`,
      );
    }
  }
}

// ── B, C, E. Properties of every admin actions module / admin file ─────────
const adminFiles = rels.filter((rel) => rel.startsWith('app/admin/'));
const adminActions = adminFiles.filter((rel) => rel.endsWith('/actions.ts'));

if (adminActions.length === 0) {
  console.error('check-admin-gate FAILED — found no app/admin/**/actions.ts to check.');
  console.error('  The paths this guard knows have moved; fix the guard, do not delete it.');
  process.exit(1);
}

for (const rel of adminActions) {
  const code = codeOf(rel);
  if (!code.includes(GUARD_MODULE)) {
    fail(
      rel,
      1,
      `no import of ${GUARD_MODULE}`,
      'an admin actions module that gates itself some other way, or does not gate at all',
      `Add \`import { asAdmin, asAdminPage } from '${GUARD_MODULE}';\` and use them.`,
    );
  }
}

for (const rel of adminFiles) {
  const code = codeOf(rel);
  const session = /from\s+['"]@\/auth['"]/.exec(code);
  if (session) {
    fail(
      rel,
      lineOf(code, session.index),
      "reads the session directly (`from '@/auth'`)",
      'authorization reads the DATABASE row, not the token — a token outlives a demotion (VX1-10)',
      `Go through ${GUARD_MODULE}, which resolves the actor inside the tenant transaction.`,
    );
  }
  const bare = /throw new Error\(\s*['"`](?:forbidden|unauthenticated)/i.exec(code);
  if (bare) {
    fail(
      rel,
      lineOf(code, bare.index),
      'a bare `throw new Error("forbidden…")`',
      'a bare Error has no reader copy, so `errorParam` shows the generic "something went wrong on our side" for a refusal that is not a fault',
      'Throw `ForbiddenError` from `@/lib/auth/actor` with a message code, or call the page gate.',
    );
  }
}

// ── D. The exit matches the caller ─────────────────────────────────────────
let readsChecked = 0;
let actionsChecked = 0;

/**
 * HOW a page uses each name it imports, read off the page rather than guessed
 * from the name. The first draft of this check classified by suffix —
 * `…FromForm` is a write, anything else is a read — and it failed on correct
 * code within a minute: `pullFromLedgerForm` is a form action whose name ends
 * `Form`, not `FromForm`. A convention that holds fourteen times out of fifteen
 * is not a property, and a guard that fails the build on working code is one
 * people delete. The page says which it is, unambiguously:
 *
 *   `<form action={name}>`  → a server ACTION
 *   `await name(…)`         → a READ, awaited during render
 */
function pageUses(pageRel) {
  const code = codeOf(pageRel);
  const uses = new Map(); // local name → { action, read }
  const note = (name, kind) => {
    const u = uses.get(name) ?? { action: false, read: false };
    u[kind] = true;
    uses.set(name, u);
  };
  for (const m of code.matchAll(/action=\{\s*([A-Za-z0-9_$]+)/g)) note(m[1], 'action');
  for (const m of code.matchAll(/await\s+([A-Za-z0-9_$]+)\s*\(/g)) note(m[1], 'read');
  return uses;
}

/** Names a `page.tsx` imports from a sibling `actions` module. */
function pageImports(pageRel) {
  const code = codeOf(pageRel);
  const out = [];
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.\.?\/(?:\.\.\/)*)actions['"]/g)) {
    const target = relative(ROOT, join(ROOT, dirname(pageRel), m[2], 'actions.ts'))
      .split(sep)
      .join('/');
    for (const clause of m[1].split(',')) {
      const c = clause.trim().replace(/^type\s+/, '');
      if (!c) continue;
      const [imported, local] = c.split(/\s+as\s+/).map((x) => x.trim());
      out.push({ target, imported, local: local ?? imported });
    }
  }
  return out;
}

/**
 * The body of `export async function NAME`, taken to the next top-level `export`.
 */
function bodyOf(code, name) {
  const start = new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}\\b`).exec(code);
  if (!start) return null;
  const rest = code.slice(start.index + start[0].length);
  const end = rest.search(/\nexport\s|\nasync function\s|\nfunction\s/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Which gates a function reaches, FOLLOWING calls to other functions in the same
 * module. The second thing the first draft got wrong: `createEmployeeFromForm`
 * calls `createEmployee`, which is where the `asAdmin` is. Every one of the four
 * `expense-policies` writes is the same shape. A one-level scan called all of
 * them ungated, which was the guard being wrong about five correct functions.
 */
function gatesReached(code, name, seen = new Set()) {
  if (seen.has(name) || seen.size > 8) return new Set();
  seen.add(name);
  const body = bodyOf(code, name);
  if (body === null) return new Set();
  const found = new Set();
  for (const gate of GATES) if (new RegExp(`\\b${gate}\\s*\\(`).test(body)) found.add(gate);
  for (const m of body.matchAll(/\b([A-Za-z0-9_$]+)\s*\(/g)) {
    if (GATES.includes(m[1]) || m[1] === name) continue;
    if (!new RegExp(`(?:export\\s+)?async\\s+function\\s+${m[1]}\\b`).test(code)) continue;
    for (const g of gatesReached(code, m[1], seen)) found.add(g);
  }
  return found;
}

for (const rel of adminFiles.filter((r) => r.endsWith('/page.tsx'))) {
  const uses = pageUses(rel);
  for (const { target, imported, local } of pageImports(rel)) {
    if (!adminActions.includes(target)) continue;
    const use = uses.get(local);
    if (!use) continue; // imported and unused, or used in a way neither pattern sees
    const code = codeOf(target);
    if (bodyOf(code, imported) === null) continue; // re-export, or not a function
    const gates = gatesReached(code, imported);

    // `asMember` is a deliberate widening — an export any signed-in employee may
    // call. Not the admin gate missing, so not this check's business.
    if (gates.has('asMember')) continue;

    for (const [kind, wants, why] of [
      [
        'read',
        'asAdminPage',
        `${rel} awaits it during render, and \`asAdmin\` throws — which Next renders as HTTP 500. That is the VX4-9 defect exactly`,
      ],
      [
        'action',
        'asAdmin',
        `${rel} passes it to a <form action={…}>, and \`asAdminPage\` calls \`forbidden()\` — a control-flow throw the action's \`guarded()\` swallows and shows as a generic error`,
      ],
    ]) {
      if (!use[kind]) continue;
      if (kind === 'read') readsChecked++;
      else actionsChecked++;
      if (gates.has(wants)) continue;
      fail(
        target,
        lineOf(code, code.indexOf(`function ${imported}`)),
        `${imported}() reaches ${gates.size === 0 ? 'no gate' : `\`${[...gates].join('`, `')}\``}`,
        why,
        `Gate it with \`${wants}\` — directly, or through a function in this module that does.`,
      );
    }
  }
}

if (offenders.length > 0) {
  console.error('');
  console.error('check-admin-gate FAILED — the admin gate has forked, or a caller has the wrong exit.');
  console.error('');
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.what}`);
    console.error(`      ${o.why}`);
    console.error(`      → ${o.fix}`);
    console.error('');
  }
  process.exit(1);
}

console.log(
  `check-admin-gate OK — one gate in ${GUARD}; ${adminActions.length} admin actions ` +
    `modules import it; ${readsChecked} page read(s) exit through asAdminPage and ` +
    `${actionsChecked} form action(s) through asAdmin.`,
);
