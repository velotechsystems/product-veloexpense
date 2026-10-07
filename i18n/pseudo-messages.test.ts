// @vitest-environment node
import { describe, expect, it } from 'vitest';
import IntlMessageFormat from 'intl-messageformat';
import { pseudoizeMessage, pseudoizeMessages } from './pseudo-messages';

/**
 * VeloExpense: the pseudo-locale for ported (next-intl) screens. Not in ExpenseOS.
 *
 * The property that matters is that a pseudoized message is STILL A VALID ICU MESSAGE that
 * formats with the same arguments: the crawl renders every ported page with these, and a
 * message the transform broke would take the page down instead of measuring it.
 */
const format = (message: string, values?: Record<string, unknown>) =>
  String(new IntlMessageFormat(message, 'en').format(values as never));

describe('one message', () => {
  it('brackets and accents plain text', () => {
    const out = pseudoizeMessage('Add category');
    expect(out.startsWith('⟦')).toBe(true);
    expect(out.endsWith('⟧')).toBe(true);
    expect(out).not.toMatch(/Add|category/);
  });

  it('keeps a placeholder working', () => {
    const out = pseudoizeMessage('Hello {name}');
    expect(format(out, { name: 'Ada' })).toContain('Ada');
    expect(format(out, { name: 'Ada' })).not.toContain('Hello');
  });

  it('keeps a plural working, and accents its branches', () => {
    const out = pseudoizeMessage('{count, plural, one {# item} other {# items}}');
    expect(format(out, { count: 1 })).toContain('1');
    expect(format(out, { count: 3 })).toContain('3');
    expect(format(out, { count: 3 })).not.toMatch(/items/);
    expect(format(out, { count: 3 })).toMatch(/îť/);
  });

  it('keeps a select working', () => {
    const out = pseudoizeMessage('{status, select, open {Open} other {Closed}}');
    expect(format(out, { status: 'open' })).toMatch(/Öþéñ/);
  });

  it('keeps rich-text tags', () => {
    const out = pseudoizeMessage('Read the <b>policy</b>');
    const rendered = new IntlMessageFormat(out, 'en').format({ b: (c: unknown) => `[${String(c)}]` });
    expect(String(rendered)).toMatch(/\[þöĺîçý\]/);
  });

  it('brackets a message it cannot parse, rather than breaking it', () => {
    expect(pseudoizeMessage('{unclosed')).toBe('⟦{unclosed⟧');
  });

  it('leaves an empty message empty', () => {
    expect(pseudoizeMessage('')).toBe('');
  });
});

describe('a whole catalogue', () => {
  it('keeps the shape and transforms every string leaf', () => {
    const out = pseudoizeMessages({ a: { b: 'Save', c: { d: 'Cancel' } }, n: 3 });
    expect(Object.keys(out)).toEqual(['a', 'n']);
    expect(out.a.b).toMatch(/^⟦Ŝáṽé·+⟧$/);
    expect(out.a.c.d).toMatch(/^⟦/);
    expect(out.n).toBe(3);
  });

  it("every ported catalogue message still formats once pseudoized", async () => {
    const { loadCatalog } = await import('@expenseos/i18n');
    const catalog = pseudoizeMessages(await loadCatalog('en'));
    const failures: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'string') {
        try {
          new IntlMessageFormat(node, 'en');
        } catch (e) {
          failures.push(`${path}: ${(e as Error).message}`);
        }
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(catalog, '');
    expect(failures).toEqual([]);
  });
});
