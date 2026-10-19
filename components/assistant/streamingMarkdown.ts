/**
 * Markdown that is still arriving.
 *
 * The answer streams a token at a time, and every frame is rendered. Markdown that is
 * half-written is not markdown: `**Total` has no closing `**`, so the renderer emits the
 * asterisks as literal text. The effect is that an answer types out as raw source and then
 * snaps into formatting when the last character lands — which reads as two different
 * answers, and makes the whole reply appear to flicker at the end.
 *
 * This closes the constructs that are open, so each frame is VALID markdown describing the
 * text so far. `**Total` renders as bold "Total", and stays bold as the rest arrives.
 *
 * Deliberately conservative. It only closes what is unambiguously open and hides what is
 * unambiguously mid-token; it never guesses at intent. Getting this wrong in the other
 * direction — formatting text the author never marked up — is worse than a moment of
 * literal asterisks, because the finished answer would be wrong rather than merely ugly.
 */

/** Fences own everything inside them, so they are settled first. */
function openFence(text: string): string | null {
  const fences = text.match(/^[ \t]*(```|~~~)/gm);
  if (!fences || fences.length % 2 === 0) return null;
  return fences.at(-1)?.trim().slice(0, 3) ?? '```';
}

/**
 * Text with everything that is not emphasis blanked out, for counting delimiters.
 *
 * Replaced with spaces rather than removed so offsets still line up — the trailing-link
 * trim indexes back into the original string.
 *
 * Three things masked, each a source of a false positive that would italicise the rest of
 * an answer as it streamed:
 *   · code, fenced and inline — `a * b` is multiplication;
 *   · list markers — a `*` opening a line is a bullet, never emphasis;
 *   · intra-word underscores — `expense_report_id` is a column name.
 */
function scannable(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => ' '.repeat(m.length))
      .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
      // The lookahead accepts end-of-line as well as a space: a bullet the model has only
      // just opened (`\n* ` with nothing after it) is still a bullet, and counting that
      // asterisk as emphasis turns the next character into italics.
      .replace(/^([ \t]*)([*+-])(?=[ \t]|$)/gm, (_m, a) => `${a} `)
      .replace(/(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g, ' ')
  );
}

/**
 * A link or image the author has started but not finished.
 *
 * `[Open the report](/expenses/` renders as literal brackets and a bare path, and the URL
 * is half a URL — briefly showing somebody a link to nowhere is worse than showing them
 * nothing for one frame. Returns the index to cut at, or -1.
 */
function danglingLinkAt(text: string): number {
  const open = text.lastIndexOf('[');
  if (open === -1) return -1;
  const rest = text.slice(open);
  // Complete when the label closes AND the destination closes right after it.
  if (/^\[[^\]]*\]\([^)]*\)/.test(rest)) return -1;
  // A label with no destination started is complete enough to leave alone — markdown
  // renders `[draft]` as literal text, which is what it is.
  if (/^\[[^\]]*\](?!\()/.test(rest)) return -1;
  // Take the `!` with it, or an unfinished image leaves a stray bang behind.
  return open > 0 && text[open - 1] === '!' ? open - 1 : open;
}

/** Emphasis markers, longest first — `**` must be settled before `*`, or one bold run
 *  counts as two unmatched italics. */
const MARKERS = ['***', '~~', '**', '__', '*', '_'] as const;

/**
 * Close what is open in a partial markdown string.
 *
 * Order matters: fences first (they contain everything), then the dangling link (which may
 * remove text that would otherwise be counted), then a trailing marker that has nothing
 * inside it yet, then the emphasis runs that do.
 */
export function completePartialMarkdown(text: string): string {
  if (!text) return text;

  const fence = openFence(text);
  if (fence) {
    // Inside a fence nothing else is markup, so nothing else needs closing. The newline
    // matters: a fence closer must start its own line.
    return `${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
  }

  const cut = danglingLinkAt(scannable(text));
  let out = cut === -1 ? text : text.slice(0, cut).trimEnd();
  if (!out) return out;

  /**
   * An open inline span is closed first, so the emphasis counting below sees the code it
   * contains as masked. A lone trailing backtick is dropped for the same reason the
   * trailing emphasis marker is: there is nothing inside it to render yet.
   */
  if ((out.match(/`/g) ?? []).length % 2 === 1) {
    // Not trimmed: the space after a bullet is load-bearing, and trimming it turns
    // `\n* \`` into `\n*`, which then reads as an opening emphasis marker.
    out = out.endsWith('`') ? out.slice(0, -1) : `${out}\``;
  }
  if (!out) return out;

  /**
   * A marker with nothing after it yet is dropped rather than closed.
   *
   * Closing `You have *` would produce `You have **`, which markdown reads as an empty
   * BOLD — a different construct from the italic that was opening, and one that leaves a
   * visible pair of asterisks. There is nothing to emphasise yet, so there is nothing to
   * show. It comes back as bold the moment a character lands inside it.
   */
  const trailing = out.match(/(?<![*_~])([*_~]{1,3})$/);
  if (trailing) {
    // Only when the run is genuinely opening — a bullet marker at the end of a line is
    // not emphasis, and neither is the closer of a run that just completed.
    const before = out.slice(0, -trailing[1].length);
    if (!/(^|\n)[ \t]*$/.test(before) || trailing[1].length > 1) {
      const stripped = before.trimEnd();
      if (!/[*_~]$/.test(stripped)) out = stripped;
    }
  }
  if (!out) return out;

  for (const marker of MARKERS) {
    const bare = scannable(out);
    // Count only runs of EXACTLY this length, so `**` is not counted twice as `*`.
    const escaped = marker.replace(/[*]/g, '\\*');
    const runs = bare.match(new RegExp(`(?<![*_~])${escaped}(?![*_~])`, 'g')) ?? [];
    if (runs.length % 2 === 1) out += marker;
  }

  return out;
}
