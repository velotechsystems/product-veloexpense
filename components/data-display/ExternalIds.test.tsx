import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExternalIdsBlock, ExternalIdsCell, externalIdEntries } from './ExternalIds';

/**
 * Read-only rendering of an `externalIds` JSON map.
 *
 * The input is a Prisma `Json` column, so it is genuinely `unknown` at this boundary — no
 * schema validates it, and a bad write or a hand-edited row can put anything there. These
 * render inside table cells across the directory and every admin lookup page, so a value
 * that throws takes the whole page down rather than one cell. That is what the tolerance
 * assertions below are for; they are not defensive padding.
 *
 * The other half is the em dash. An empty cell is indistinguishable from a rendering
 * failure, and "this record has no external IDs" is a real, useful answer.
 */

describe('externalIdEntries', () => {
  it('returns the string entries of a map', () => {
    expect(externalIdEntries({ netsuite: '123', google: 'abc' })).toEqual([
      ['netsuite', '123'],
      ['google', 'abc'],
    ]);
  });

  it('skips non-string values instead of rendering them', () => {
    // A number or a nested object in the map would otherwise render as `123` or
    // `[object Object]` beside a system name — worse than omitting it, because it looks
    // like a real ID.
    expect(
      externalIdEntries({ a: '1', b: 2, c: null, d: undefined, e: {}, f: [], g: true }),
    ).toEqual([['a', '1']]);
  });

  it('skips empty strings', () => {
    // `netsuite:` with nothing after it states a mapping that does not exist.
    expect(externalIdEntries({ a: '', b: '1' })).toEqual([['b', '1']]);
  });

  it('returns nothing for values that are not maps at all', () => {
    // Each of these is reachable from a Json column. None may throw.
    for (const raw of [null, undefined, '', 'string', 42, true, [], [1, 2], Number.NaN]) {
      expect(externalIdEntries(raw), JSON.stringify(raw) ?? 'undefined').toEqual([]);
    }
  });

  it('treats an array as not-a-map even when it holds strings', () => {
    // `['a','b']` has numeric keys, so it would render as `0: a` — nonsense presented as a
    // system mapping.
    expect(externalIdEntries(['a', 'b'])).toEqual([]);
  });

  it('preserves whatever keys exist, without a known-systems list', () => {
    // No system names are baked in; a new integration must show up without a code change.
    expect(externalIdEntries({ somethingNew: 'x' })).toEqual([['somethingNew', 'x']]);
  });
});

describe('ExternalIdsCell', () => {
  it('renders a pill per mapping, showing the system and the id', () => {
    render(<ExternalIdsCell value={{ netsuite: '123', google: 'abc' }} />);
    expect(screen.getByText('netsuite:')).toBeInTheDocument();
    expect(screen.getByText('123')).toBeInTheDocument();
    expect(screen.getByText('google:')).toBeInTheDocument();
    expect(screen.getByText('abc')).toBeInTheDocument();
  });

  it('renders an em dash when there is nothing to show', () => {
    // Distinguishes "no external IDs" from a cell that failed to render.
    render(<ExternalIdsCell value={{}} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders an em dash for malformed input rather than throwing', () => {
    // The cell is inside a table; an exception here blanks the whole page.
    for (const raw of [null, 'nonsense', 42, []]) {
      const { unmount } = render(<ExternalIdsCell value={raw} />);
      expect(screen.getByText('—')).toBeInTheDocument();
      unmount();
    }
  });

  it('omits a non-string value but still renders its siblings', () => {
    // One bad entry must not take the good ones with it.
    render(<ExternalIdsCell value={{ netsuite: '123', broken: { nested: true } }} />);
    expect(screen.getByText('netsuite:')).toBeInTheDocument();
    expect(screen.queryByText('broken:')).not.toBeInTheDocument();
  });
});

describe('ExternalIdsBlock', () => {
  it('renders the same content in the roomier variant', () => {
    render(<ExternalIdsBlock value={{ netsuite: '123' }} />);
    expect(screen.getByText('netsuite:')).toBeInTheDocument();
    expect(screen.getByText('123')).toBeInTheDocument();
  });

  it('renders an em dash when empty', () => {
    render(<ExternalIdsBlock value={undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('agrees with the cell variant on WHICH entries are displayable', () => {
    // Two components, one filter. If they diverged, a drawer would show a mapping the table
    // hid — and somebody would reasonably conclude the table was stale.
    const messy = { a: '1', b: 2, c: '', d: 'x' };
    const { unmount } = render(<ExternalIdsCell value={messy} />);
    const cellText = document.body.textContent;
    unmount();
    render(<ExternalIdsBlock value={messy} />);
    expect(document.body.textContent).toBe(cellText);
  });
});
