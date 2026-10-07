/**
 * The pseudo-locale for ported (next-intl) screens.
 *
 * VeloExpense's pseudo-locale crawl (`npm run e2e:crawl`) counts text on each page that did
 * not come out of a catalogue. VeloExpense's own catalogue funnels pseudoize as they render
 * (`lib/i18n/pseudo.ts`). Ported ExpenseOS screens render through next-intl instead, so the
 * same transform is applied to next-intl's MESSAGES, once per request, when the flag is set.
 *
 * Unlike VeloExpense's catalogue, these are ICU messages: `{count, plural, one {# item}
 * other {# items}}`, rich-text tags, selects. Accenting the raw string would turn `plural`
 * into `ƥĺûŕáĺ` and break the message, so each one is PARSED and only its literal text is
 * accented; the structure is printed back unchanged and the whole message bracketed once.
 * A message the parser cannot read is bracketed whole and left unaccented rather than
 * broken: the crawl still sees it as catalogued.
 */
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { printAST } from '@formatjs/icu-messageformat-parser/printer.js';
import { accent, PSEUDO_MARKERS } from '@/lib/i18n/pseudo';

function accentElements(elements: MessageFormatElement[]): number {
  let letters = 0;
  for (const el of elements) {
    if (el.type === TYPE.literal) {
      letters += el.value.replace(/[^a-z]/gi, '').length;
      el.value = accent(el.value);
    } else if (el.type === TYPE.plural || el.type === TYPE.select) {
      for (const option of Object.values(el.options)) letters += accentElements(option.value);
    } else if (el.type === TYPE.tag) {
      letters += accentElements(el.children);
    }
  }
  return letters;
}

export function pseudoizeMessage(message: string): string {
  if (message === '') return '';
  const { open, close } = PSEUDO_MARKERS;
  try {
    const ast = parse(message);
    const letters = accentElements(ast);
    const pad = '·'.repeat(Math.max(1, Math.round(letters * 0.3)));
    return `${open}${printAST(ast)}${pad}${close}`;
  } catch {
    return `${open}${message}${close}`;
  }
}

/** Every string leaf of a catalogue, pseudoized; the shape is unchanged. */
export function pseudoizeMessages<T>(messages: T): T {
  if (typeof messages === 'string') return pseudoizeMessage(messages) as T;
  if (messages === null || typeof messages !== 'object' || Array.isArray(messages)) return messages;
  return Object.fromEntries(
    Object.entries(messages as Record<string, unknown>).map(([k, v]) => [k, pseudoizeMessages(v)]),
  ) as T;
}
