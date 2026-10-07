/**
 * VX4-7 part 3 — the pseudo-locale, and what it is FOR.
 *
 * ── THE PROBLEM IL-5/IL-6 ACTUALLY NAMES ────────────────────────────────────
 *
 * Upstream has two good CI gates over its catalogues — key-for-key parity, type
 * agreement, non-emptiness — and the audit's finding is that neither can see an
 * INTERPOLATED key, so the only thing that catches one is a crawler that sets
 * `const LOCALE = 'en'` and runs nightly. "A guard that watches one of three
 * locales is the shape of guard this project keeps finding."
 *
 * Parts 2a, 2b and 2c closed the coverage half properly: three catalogues, each
 * with an assertion over `SUPPORTED_LOCALES` rather than over its own keys. What
 * none of that can answer is the question a translator asks first:
 *
 *   is this string coming from a catalogue AT ALL?
 *
 * A hardcoded `<h2>Add line item</h2>` satisfies every gate in the repo. It has
 * no key to be missing, no locale to be absent from, and nothing to assert
 * about. `check:i18n` cannot see it, because a string that is not localised
 * looks exactly like a string that does not need to be.
 *
 * ── WHAT A PSEUDO-LOCALE DOES THAT A REAL ONE DOES NOT ──────────────────────
 *
 * Rendering in `en-XA` makes catalogue text VISUALLY DISTINCT from text that
 * never went through one:
 *
 *   ⟦Ŝûƀmîttéd⟧              ← came from a catalogue
 *   Add line item             ← did not
 *
 * So "which strings are localised" stops being a question about the source and
 * becomes an observation about the page, which a crawler can make. Real French
 * would find the same thing — but real French costs 223 authored strings and a
 * data backfill, and inventing them would be shipping a locale no francophone
 * has read, which is what `0028` argues against at length. `fr-CA` comes back
 * when its copy exists; this is how the machinery gets proven meanwhile.
 *
 * It also finds two things translation alone would: text that grows (the padding
 * below is 30%, roughly what English→French costs) breaking a layout, and
 * sentences assembled by concatenation, which show up as two bracketed fragments
 * where one is expected.
 *
 * ── XA, AND WHY IT IS NOT IN `SUPPORTED_LOCALES` ────────────────────────────
 *
 * `XA` is a private-use region subtag; `en-XA` is the conventional spelling for
 * this (Android and Chrome both use it), so `Intl` treats it as English and
 * formats accordingly, which is what we want — the point is the words, not the
 * number format.
 *
 * It is deliberately NOT a member of `SUPPORTED_LOCALES`, and that is the whole
 * safety argument. Adding it would mean a CHECK-constraint migration, an entry
 * in two pickers, and a tenant able to select it. Instead this is a TRANSFORM
 * applied to whatever the catalogues return, switched on by an environment
 * variable read at boot and by nothing else:
 *
 *   · no request can turn it on — no cookie, no query parameter, no header. A
 *     render toggle influenced by a request is precisely the class of thing
 *     parts 2b and 2c spent their length removing.
 *   · a tenant cannot store it, because the column's CHECK does not accept it.
 *   · `npm run e2e:crawl` starts its own server with the flag set, on its own
 *     port. The normal e2e run never sees it.
 */

/**
 * Read ONCE, at module load. Not per call, and not from anything a request
 * carries — see the header. A stale value after an env change is the correct
 * trade for a toggle that cannot be reached from outside the process.
 */
const ENABLED = process.env.PSEUDO_LOCALE === '1';

export function pseudoEnabled(): boolean {
  return ENABLED;
}

/** ASCII letters to accented look-alikes. Same letter, unmistakably not English. */
const MAP: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ',
  k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ɋ', r: 'ŕ', s: 'ŝ', t: 'ť',
  u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ',
  K: 'Ķ', L: 'Ĺ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ɋ', R: 'Ŕ', S: 'Ŝ', T: 'Ť',
  U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/*
 * EVERY ENTRY IS ONE CODEPOINT AND NONE IS ITSELF, and the assertion in
 * `test/i18n-pseudo.test.ts` that says so caught three bugs in the first draft
 * of this table: `t`, `T` and `Q` mapped to themselves, so a third of English
 * text passed through unaccented — and `q` mapped to `' q'`, a leading SPACE,
 * which silently inserted one into every word containing a q.
 *
 * That last one is why the assertion is "no ASCII letter survives" rather than a
 * spot check. A table like this is exactly the kind of thing that looks right in
 * review: seven of the eight properties held, and the transform would have
 * reported a page as fully catalogued while leaving a quarter of it plain.
 */

const OPEN = '⟦';
const CLOSE = '⟧';

/**
 * What must survive untouched, and why each one matters.
 *
 * `{name}` — a placeholder. Accenting it would make `fill()` in
 *   `catalog/errors.ts` fail to substitute, so every parameterised refusal would
 *   degrade to the generic and the crawl would be testing the generic 30 times.
 * digits and `$.,:%-/` — money, ratios, dates and counts. These come from
 *   `Intl` or from a parameter and are not copy; mangling them would hide the
 *   very thing part 1b and 2b made correct.
 * `⟦⟧` — so a doubly-transformed string is still readable in a failure message.
 */
const KEEP = /(\{\w+\}|[0-9$.,:%\-/⟦⟧])/;

/**
 * Bracket, accent, and pad.
 *
 * The BRACKETS are the load-bearing part: they are what a crawler matches on,
 * and they are why this is better than accenting alone — `Ŝûƀmîttéd` is a
 * judgement call to spot in a screenshot, `⟦…⟧` is a substring test.
 *
 * The PADDING is 30%, appended as `·` runs rather than more letters so it cannot
 * be mistaken for content. English→French runs 15–30% longer, so a label that
 * survives this survives translation; one that clips or wraps badly is a layout
 * bug found before a translator ever sees it.
 */
export function pseudoize(text: string): string {
  if (text === '') return '';
  const accented = accent(text);
  // Padded on the LENGTH OF THE LETTERS, not of the whole string: a sentence
  // that is mostly a formatted amount should not be padded as though it were
  // mostly words.
  const letters = text.replace(/[^a-z]/gi, '').length;
  const pad = '·'.repeat(Math.max(1, Math.round(letters * 0.3)));
  return `${OPEN}${accented}${pad}${CLOSE}`;
}

/**
 * The accenting alone, with no brackets or padding — for a caller that brackets a WHOLE
 * message itself. `i18n/pseudo-messages.ts` needs it: an ICU message is accented one
 * literal at a time (so `{count, plural, …}` survives), then bracketed once.
 */
export function accent(text: string): string {
  return text
    .split(KEEP)
    .map((part) => (KEEP.test(part) ? part : part.replace(/[a-z]/gi, (c) => MAP[c] ?? c)))
    .join('');
}

/** Applied by the catalogue funnels; a no-op unless the flag is set at boot. */
export function pseudoIfEnabled(text: string): string {
  return ENABLED ? pseudoize(text) : text;
}

/** Did this text come out of a catalogue? The crawler's one question. */
export function isPseudoized(text: string): boolean {
  return text.includes(OPEN) && text.includes(CLOSE);
}

export const PSEUDO_MARKERS = { open: OPEN, close: CLOSE } as const;
