import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/api-keys — the API request log.
 *
 * The rows exist either way; this screen is what makes them worth having, and the
 * questions it has to answer are security questions:
 *
 *   · **"Was this key being probed?"** A rejected attempt against a key that does not
 *     exist has no key to name, so the PREFIX that was presented is its only identity —
 *     drop it and a sweep becomes a page of identical blank rows.
 *   · **"Is this a sweep or one mistake?"** A count above 1 only ever appears on a
 *     coalesced row, so it is a badge rather than a quiet number in a column.
 *   · **"Am I looking at everything?"** The count line reports the size of the real
 *     match, not the window. 500 of 40,000 shown silently reads as complete, and that
 *     is the one way this screen could actively mislead somebody.
 *
 * Filtering is deliberately split: outcome and age go to the SERVER, because they decide
 * which rows exist and the table grows without bound; the pills refine the window that
 * came back.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
}));

// The export menu's real builder runs; only the browser hand-off is intercepted.
vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
}));

const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const key = ns ?? '';
    let t = translators.get(key);
    if (!t) {
      const fn = (k: string, values?: Record<string, unknown>) => {
        const full = ns ? `${ns}.${k}` : k;
        return values ? `${full}:${Object.values(values).join(',')}` : full;
      };
      (fn as { has?: () => boolean }).has = () => false;
      t = fn;
      translators.set(key, t);
    }
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

import { ApiKeyRequestsAdmin } from './ApiKeyRequestsAdmin';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const req = (over: Record<string, unknown> = {}) => ({
  id: 'r-1',
  createdAt: new Date('2026-08-01T12:00:00.000Z'),
  outcome: 'OK',
  apiKeyId: 'k-1',
  prefixTried: null,
  apiKey: { id: 'k-1', name: 'Zapier production', kind: 'MCP' },
  operation: 'tools/call',
  toolName: 'expenses.list',
  scopeRequired: null,
  actingUserId: '0192f4a1-9b7c-7c3e-8f21-aaaabbbbcccc',
  ip: '203.0.113.7',
  count: 1,
  windowStart: null,
  durationMs: 42,
  statusCode: 200,
  ...over,
});

/** A rejected attempt against a key that does not exist. */
const probe = (over: Record<string, unknown> = {}) =>
  req({
    id: 'r-2',
    outcome: 'UNKNOWN_KEY',
    apiKeyId: null,
    apiKey: null,
    prefixTried: 'eos_live_9f2a',
    toolName: null,
    actingUserId: null,
    durationMs: null,
    count: 14,
    ...over,
  });

function setTrpc(
  data: { rows?: unknown[]; totalCount?: number; outcomes?: unknown[] } = {},
  over: TrpcMockConfig = {},
) {
  const rows = data.rows ?? [req()];
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'apiKeys.requests': {
        data: { rows, totalCount: data.totalCount ?? rows.length },
        ...over.queries?.['apiKeys.requests'],
      },
      'apiKeys.requestOutcomes': {
        data: data.outcomes ?? [
          { outcome: 'OK', count: 120 },
          { outcome: 'UNKNOWN_KEY', count: 14 },
        ],
      },
      ...over.queries,
    },
  });
}

const show = () => render(<ApiKeyRequestsAdmin />);

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter((s) => s.length > 0);

/** A column header, disambiguated from the identically-labelled picker above it. */
const header = (text: string) =>
  (screen.getAllByText(text).find((el) => el.closest('th')) as HTMLElement).closest(
    'th',
  ) as HTMLElement;

async function filterColumn(
  user: ReturnType<typeof userEvent.setup>,
  column: string,
  value: string,
) {
  const th = header(column);
  const buttons = within(th).getAllByRole('button', { name: 'table.colMenu.menu' });
  await user.click(buttons[buttons.length - 1]);
  await user.click(await screen.findByText('table.colMenu.filter'));
  await user.type(await screen.findByPlaceholderText('table.colMenu.value'), value);
  await user.click(screen.getByText('table.colMenu.apply'));
}

afterEach(() => {
  h.trpc = undefined;
  h.downloads = [];
  vi.restoreAllMocks();
});

// ── The log ───────────────────────────────────────────────────────────────────

describe('the request log', () => {
  it('reads a successful call out with its key, tool, address and duration', () => {
    setTrpc();
    show();
    const text = rowTexts()[0];
    expect(text).toContain('OK');
    expect(text).toContain('Zapier production');
    expect(text).toContain('tools/call');
    expect(text).toContain('expenses.list');
    expect(text).toContain('203.0.113.7');
    expect(text).toContain('42ms');
  });

  it('names the prefix that was presented when no key matched', () => {
    /**
     * A probe has no key to name. Without the prefix, a sweep of two hundred guesses is
     * two hundred identical blank rows and there is nothing to correlate.
     */
    setTrpc({ rows: [probe()] });
    show();
    expect(screen.getByText('apiKeys.log.unknownPrefix:eos_live_9f2a')).toBeInTheDocument();
  });

  it('says so when a rejected attempt carried no prefix at all', () => {
    setTrpc({ rows: [probe({ prefixTried: null })] });
    show();
    expect(screen.getByText('apiKeys.log.noKey')).toBeInTheDocument();
  });

  it('tones a rejection apart from a success', () => {
    // Scanning for the failures is the whole reason to open this page.
    setTrpc({ rows: [req(), probe()] });
    show();
    const ok = screen.getByText('OK');
    const bad = screen.getByText('UNKNOWN_KEY');
    expect(ok.className).not.toEqual(bad.className);
  });

  it('makes a coalesced attempt count loud', () => {
    /**
     * A count above 1 only ever appears on a coalesced row — that is, a sweep. Rendered
     * as a plain number in a column it is exactly as quiet as a normal call.
     */
    setTrpc({ rows: [probe()] });
    show();
    expect(screen.getByText('apiKeys.log.attemptsInMinute:14')).toBeInTheDocument();
  });

  it('shows a single attempt as a plain one', () => {
    setTrpc();
    show();
    expect(rowTexts()[0]).toContain('1');
    expect(screen.queryByText(/attemptsInMinute/)).not.toBeInTheDocument();
  });

  it('names the scope a refused call needed', () => {
    // "Denied" is not actionable; "denied, needed expenses:write" is.
    setTrpc({
      rows: [req({ outcome: 'SCOPE_DENIED', scopeRequired: 'expenses:write' })],
    });
    show();
    expect(screen.getByText('apiKeys.log.needed:expenses:write')).toBeInTheDocument();
  });

  it('shortens the acting user to something readable', () => {
    // A full uuid in a table column pushes every other field off screen.
    setTrpc();
    show();
    expect(screen.getByText('0192f4a1')).toBeInTheDocument();
  });

  it('dashes the fields a rejected attempt never got as far as', () => {
    setTrpc({ rows: [probe()] });
    show();
    const text = rowTexts()[0];
    expect(text).toContain('—');
  });

  it('says so when nothing matched', () => {
    setTrpc({ rows: [], totalCount: 0 });
    show();
    expect(screen.getByText('apiKeys.log.empty')).toBeInTheDocument();
  });
});

// ── The count line ────────────────────────────────────────────────────────────

describe('the count line', () => {
  it('reports the match when the whole match is on screen', () => {
    setTrpc({ rows: [req(), probe()], totalCount: 2 });
    show();
    expect(screen.getByText('apiKeys.log.matched:2')).toBeInTheDocument();
  });

  it('says so when it is showing a window of a much larger match', () => {
    /**
     * The one way this screen could actively mislead: 500 rows of a 40,000-row match
     * shown silently reads as "this is everything that happened".
     */
    setTrpc({ rows: [req()], totalCount: 40000 });
    show();
    expect(screen.getByText('apiKeys.log.windowed:1,40000')).toBeInTheDocument();
  });

  it('counts the window, not the pill-filtered subset', async () => {
    /**
     * The pills refine what is on screen; they do not change what matched. A count that
     * shrank with them would claim the log itself had fewer rows.
     */
    const user = userEvent.setup();
    setTrpc({ rows: [req(), probe()], totalCount: 2 });
    show();
    await filterColumn(user, 'apiKeys.log.outcome', 'unknown');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('apiKeys.log.matched:2')).toBeInTheDocument();
  });
});

// ── Narrowing ─────────────────────────────────────────────────────────────────

describe('narrowing the log', () => {
  it('opens on the last week, not on everything ever recorded', () => {
    // The table grows without bound; an unbounded default query is a page that hangs.
    const onCall = vi.fn();
    setTrpc(
      {},
      { queries: { 'apiKeys.requests': { data: { rows: [req()], totalCount: 1 }, onCall } } },
    );
    show();
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ sinceDays: 7, outcome: null });
  });

  it('asks the server for one outcome, and for “any” as null', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(
      {},
      { queries: { 'apiKeys.requests': { data: { rows: [req()], totalCount: 1 }, onCall } } },
    );
    show();
    await user.selectOptions(screen.getByLabelText('apiKeys.log.outcome'), 'UNKNOWN_KEY');
    expect(onCall.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: 'UNKNOWN_KEY' });
    await user.selectOptions(screen.getByLabelText('apiKeys.log.outcome'), '');
    expect(onCall.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: null });
  });

  it('asks the server to widen the window', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(
      {},
      { queries: { 'apiKeys.requests': { data: { rows: [req()], totalCount: 1 }, onCall } } },
    );
    show();
    await user.selectOptions(screen.getByLabelText('apiKeys.log.age'), '90');
    expect(onCall.mock.calls.at(-1)?.[0]).toMatchObject({ sinceDays: 90 });
  });

  it('counts each outcome in its own option, so a spike is visible before filtering', () => {
    setTrpc();
    show();
    const select = screen.getByLabelText('apiKeys.log.outcome');
    expect(within(select).getByText('UNKNOWN_KEY (14)')).toBeInTheDocument();
    expect(within(select).getByText('OK (120)')).toBeInTheDocument();
  });

  it('refines on the address, which is how a sweep is chased', async () => {
    const user = userEvent.setup();
    setTrpc({ rows: [req(), probe({ ip: '198.51.100.9' })] });
    show();
    await filterColumn(user, 'apiKeys.log.address', '198.51');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('198.51.100.9')).toBeInTheDocument();
  });

  it('refines on the key, matching a named key or an attempted prefix', async () => {
    /**
     * The column shows one or the other, so the filter has to look at both — otherwise
     * searching the prefix you can see finds nothing.
     */
    const user = userEvent.setup();
    setTrpc({ rows: [req(), probe()] });
    show();
    await filterColumn(user, 'apiKeys.log.key', 'eos_live');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('apiKeys.log.unknownPrefix:eos_live_9f2a')).toBeInTheDocument();
  });

  it('refines on the tool and the scope together', async () => {
    const user = userEvent.setup();
    setTrpc({
      rows: [req(), req({ id: 'r-3', toolName: 'reports.get', scopeRequired: 'reports:read' })],
    });
    show();
    await filterColumn(user, 'apiKeys.log.tool', 'reports:read');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('apiKeys.log.needed:reports:read')).toBeInTheDocument();
  });

  it('refines on the acting user by the full id, not the shortened one', async () => {
    // The short form is for reading; a correlation is done with the id you were given.
    const user = userEvent.setup();
    setTrpc({ rows: [req(), probe()] });
    show();
    await filterColumn(user, 'apiKeys.log.actor', 'aaaabbbbcccc');
    expect(rowTexts()).toHaveLength(1);
  });

  it('refines on the operation', async () => {
    const user = userEvent.setup();
    setTrpc({ rows: [req(), req({ id: 'r-4', operation: 'tools/list' })] });
    show();
    await filterColumn(user, 'apiKeys.log.operation', 'tools/list');
    expect(rowTexts()).toHaveLength(1);
  });

  it('keeps every row when a pill is added but left blank', async () => {
    // An empty clause is a half-typed filter, not an instruction to hide everything.
    const user = userEvent.setup();
    setTrpc({ rows: [req(), probe()] });
    show();
    const th = header('apiKeys.log.address');
    const buttons = within(th).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    await user.click(screen.getByText('table.colMenu.apply'));
    expect(rowTexts()).toHaveLength(2);
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe('taking the log somewhere else', () => {
  /**
   * This export is evidence handed to somebody who was not looking at the screen — an
   * incident channel, a ticket, a provider's abuse team. So each column has to carry the
   * FACT rather than the rendering: the badges, dashes and truncations that make the
   * table scannable are all lossy, and a file that reproduces them cannot be joined
   * against anything.
   */
  const exportCsv = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    return h.downloads.at(-1)?.csv ?? '';
  };

  it('writes the timestamp as an instant, not as the reader’s locale', async () => {
    /** "01/08/2026" is two different days depending on who opens the file. */
    const user = userEvent.setup();
    setTrpc();
    show();
    expect(await exportCsv(user)).toContain('2026-08-01T12:00:00.000Z');
  });

  it('carries the full acting user id, not the eight characters on screen', async () => {
    /** The column truncates so the table stays readable; a truncated id in a file joins
     *  against nothing. */
    const user = userEvent.setup();
    setTrpc();
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('0192f4a1-9b7c-7c3e-8f21-aaaabbbbcccc');
  });

  it('names an unmatched attempt by the prefix it presented', async () => {
    /** A probe has no key, so the prefix is its only identity — and a sweep exported as a
     *  column of blanks is a sweep nobody can group. */
    const user = userEvent.setup();
    setTrpc({ rows: [probe()] });
    show();
    expect(await exportCsv(user)).toContain('eos_live_9f2a');
  });

  it('leaves the fields a rejected attempt never reached empty, not dashed', async () => {
    /**
     * The table draws an em-dash so the row does not look broken. In a file that dash is
     * a value, and a filter for "no tool" would miss every row that has one.
     */
    const user = userEvent.setup();
    setTrpc({ rows: [probe()] });
    show();
    const csv = await exportCsv(user);
    expect(csv).not.toContain('—');
  });

  it('writes the attempt count as a number, not as the badge’s sentence', async () => {
    const user = userEvent.setup();
    setTrpc({ rows: [probe()] });
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('14');
    expect(csv).not.toContain('attemptsInMinute');
  });

  it('carries the outcome, the operation and the address verbatim', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('OK');
    expect(csv).toContain('tools/call');
    expect(csv).toContain('203.0.113.7');
    expect(csv).toContain('42');
  });

  it('exports what the pills left, not the whole window', async () => {
    /** Handing somebody a file that contradicts the screen they were just shown is worse
     *  than handing them nothing. */
    const user = userEvent.setup();
    setTrpc({ rows: [req(), probe({ ip: '198.51.100.9' })] });
    show();
    await filterColumn(user, 'apiKeys.log.address', '203.0.113.7');
    const csv = await exportCsv(user);
    expect(csv).toContain('203.0.113.7');
    expect(csv).not.toContain('eos_live_9f2a');
  });
});
