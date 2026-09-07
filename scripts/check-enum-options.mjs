#!/usr/bin/env node
/**
 * An enum member rendered raw inside a `<select>`.
 *
 * ── WHY THIS NEEDS A GATE OF ITS OWN ───────────────────────────────────────
 *
 * `e2e/pseudo-crawl.spec.ts` skips `SELECT` and `OPTION` when it walks a page,
 * and deliberately: `/preferences` and `/admin/locale` came back at 497 and 181
 * un-catalogued strings when their timezone lists were counted, because an IANA
 * zone name is data and no catalogue will ever hold one. That exclusion is right.
 *
 * The cost is that **the ratchet cannot see a raw enum in a dropdown**, and this
 * product had four of them: `SUBMITTED` / `IN_REVIEW` in `/expenses`' status
 * filter, `WARNING` / `BLOCK` in both severity selects on
 * `/admin/expense-policies`, and `ACTIVE` / `DEACTIVATED` in `/admin/employees`.
 * Each sat beside a catalogued label for the SAME value — `StatusBadge` and
 * `SeverityBadge` render "Must be fixed" in the table while the dropdown two
 * inches away said `BLOCK`.
 *
 * `/admin/compliance` got it right with `enumLabel(FRAUD_SEVERITY_COPY, …)`, so
 * the product knew how; the gate is for the four that did not.
 *
 * ── HOW IT TELLS AN ENUM FROM DATA ─────────────────────────────────────────
 *
 * By the array being mapped. Every enum in this tree is exported as a
 * SCREAMING_CASE runtime array — `SEVERITIES`, `EMPLOYEE_STATUSES`,
 * `REPORT_STATUSES`, `RULE_KINDS`, `METERS` — and every data list is a property:
 * `page.zones`, `currencies`, `categories`. So:
 *
 *   SEVERITIES.map((s) => <option>{s}</option>)        ← refused
 *   page.zones.map((zone) => <option>{zone}</option>)  ← fine, a zone is data
 *   currencies.map((c) => <option>{c.code}</option>)   ← fine, a property
 *
 * A convention, and it is stated rather than assumed: the rule is only as good as
 * the naming, and a future enum exported as `severities` would slip past. What
 * makes it worth having anyway is that the naming is uniform across all fourteen
 * enum arrays today, and a new one that broke it would be odd on its own terms.
 *
 * ── IT FINDS THE OPTION FIRST, AND THE ARRAY SECOND ────────────────────────
 *
 * The first version went the other way — match `ARRAY.map((v) =>`, then look
 * forward for the option. It found THREE of the four raw selects and silently
 * missed the fourth, which reads:
 *
 *     SEVERITIES.filter(
 *       (s) => definition.maxSeverity === undefined || !severityExceeds(s, …),
 *     ).map((s) => <option>{s}</option>)
 *
 * The optional `.filter(…)` in that pattern was `\([\s\S]*?\)`, and a regex
 * cannot balance parentheses: it matched to the first `)`, which is inside
 * `severityExceeds(…)`, then failed to find `.map(` where it expected one.
 *
 * A gate that finds most of something is worse than one that finds none, because
 * a clean run reads as an all-clear. I only knew it had missed one because I had
 * read the four files by hand first — which is not a method that scales, and is
 * the exact situation a gate exists to replace.
 *
 * So it starts from the OPTION, which is an unambiguous single-line shape, and
 * walks BACKWARDS to the `.map()` that bound the variable and then to the
 * receiver in front of it. No parenthesis balancing anywhere.
 *
 * WHAT IT DOES NOT CHECK: that the label is the RIGHT one. `enumLabel` with the
 * wrong catalogue passes. That is `test/i18n-enum-catalog.test.ts`'s coverage
 * question and a reviewer's.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['app', 'components'];

/** `<option …>{ident}</option>` — the bound variable as the WHOLE child. */
const RAW_OPTION_RE = /<option[^>]*>\s*\{\s*(\w+)\s*\}\s*<\/option>/g;

/**
 * The root identifier of the member expression ending at `src`.
 *
 * `SEVERITIES.filter(…)` → `SEVERITIES`. `page.zones` → `page`.
 * `currencies.filter(…)` → `currencies`. Returns null when the expression does
 * not end in something this can walk.
 *
 * Walks backwards, balancing parentheses and brackets, which is the thing a
 * regex could not do and the reason the first two versions of this check were
 * wrong in two different directions.
 */
function receiverRoot(src) {
  let i = src.length;
  const skipSpace = () => {
    while (i > 0 && /\s/.test(src[i - 1])) i -= 1;
  };
  const skipBalanced = (open, close) => {
    let depth = 0;
    do {
      const ch = src[i - 1];
      if (ch === close) depth += 1;
      else if (ch === open) depth -= 1;
      i -= 1;
    } while (i > 0 && depth > 0);
    return depth === 0;
  };

  let root = null;
  for (;;) {
    skipSpace();
    if (i === 0) break;
    const ch = src[i - 1];
    if (ch === ')') {
      if (!skipBalanced('(', ')')) return null;
      continue;
    }
    if (ch === ']') {
      if (!skipBalanced('[', ']')) return null;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i;
      while (j > 0 && /[A-Za-z0-9_$]/.test(src[j - 1])) j -= 1;
      root = src.slice(j, i);
      i = j;
      skipSpace();
      // A `.` means this was a property and the root is further left.
      if (i > 0 && src[i - 1] === '.') {
        i -= 1;
        continue;
      }
      return root;
    }
    return root;
  }
  return root;
}

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sources(path));
      continue;
    }
    if (entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap((root) => {
  try {
    return sources(root);
  } catch {
    return [];
  }
});

if (files.length === 0) {
  console.error('check-enum-options: found no .tsx files at all. That is a broken check.');
  process.exit(1);
}

const findings = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const opt of text.matchAll(RAW_OPTION_RE)) {
    const bound = opt[1];

    // Walk BACKWARDS for the `.map((bound) =>` that introduced it. Bounded, so a
    // variable that merely shares a name with something far above is not adopted.
    const before = text.slice(Math.max(0, opt.index - 1200), opt.index);
    const mapIdx = before.lastIndexOf('.map(');
    if (mapIdx === -1) continue;
    const mapTail = before.slice(mapIdx);
    if (!new RegExp(`^\\.map\\(\\s*\\(?\\s*${bound}\\b`).test(mapTail)) continue;

    // The ROOT of the receiver chain, resolved properly rather than guessed at.
    //
    // "The last capital token before the `.map(`" was the second wrong version:
    // it flagged `page.zones.map((zone) => …)` on both locale screens, because
    // the literal `UTC` sits in an `<option value="UTC">UTC</option>` a few lines
    // above and matched. Two false positives on a gate whose whole job is to be
    // trusted when it says nothing.
    const array = receiverRoot(before.slice(0, mapIdx));
    if (array === null || !/^[A-Z][A-Z0-9_]{2,}$/.test(array)) continue;

    findings.push({
      file,
      line: text.slice(0, opt.index).split('\n').length,
      array,
      bound,
    });
  }
}

if (findings.length > 0) {
  console.error(`\n✗ ${findings.length} enum member(s) rendered raw in a <select>:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.array}.map((${f.bound}) => <option>{${f.bound}}</option>)`);
  }
  console.error(
    '\nA dropdown showing BLOCK beside a table showing "Must be fixed" is the same\n' +
      'value spelled two ways on one screen. Use enumLabel with the member\'s\n' +
      'catalogue, as app/admin/compliance/page.tsx does:\n\n' +
      '    {SEVERITIES.map((s) => (\n' +
      '      <option key={s} value={s}>\n' +
      '        {enumLabel(SEVERITY_COPY, s, prefs.locale)}\n' +
      '      </option>\n' +
      '    ))}\n\n' +
      'The VALUE stays the member — only the text a person reads changes.\n' +
      '\nThis is a STATIC gate because the pseudo-locale crawl cannot see it: it\n' +
      'skips SELECT and OPTION on purpose, since a timezone list is data and\n' +
      'counting it took two screens to 497 and 181 un-catalogued strings.\n',
  );
  process.exit(1);
}

console.log(`check-enum-options OK — ${files.length} component(s), no raw enum in a <select>.`);
