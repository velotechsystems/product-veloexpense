import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/assistant-feedback — what the assistant got wrong, and who says so.
 *
 * Two sources land in one queue and keeping them together is the point: a **rating** is
 * a person saying an answer was poor, a **flag** is the assistant saying so about
 * itself. Ratings alone produce an empty queue and a false sense that the thing works,
 * because most people abandon a bad answer rather than score it — so the suite pins
 * that both kinds are listed, told apart, and separately filterable.
 *
 * Two invariants matter more than the table:
 *
 *   · **Tool results are never shown.** A transcript carries whatever the tools
 *     fetched, and holding `admin.help.manage` is not a claim on somebody's report
 *     totals. The drawer says so rather than silently omitting them.
 *   · **PROMOTED records intent, not an action.** Nothing is written to a knowledge
 *     base by pressing it — an auto-promoted wrong answer gets retrieved, reinforced
 *     and cited, and compounds silently. So the button posts a status and nothing else.
 *
 * And the count is of the real match, never the window: a queue showing 200 of 5,000
 * without saying so reads as nearly empty.
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

import { AssistantFeedbackAdmin } from './AssistantFeedbackAdmin';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const row = (over: Record<string, unknown> = {}) => ({
  id: 'fb-1',
  rating: 2,
  comment: 'It invented a policy',
  flag: null,
  status: 'PENDING',
  createdAt: '2026-08-01T12:00:00.000Z',
  reviewedAt: null,
  conversationId: 'conv-1',
  messageId: 'msg-1',
  conversation: { title: 'Per-diem in Tokyo' },
  user: { firstName: 'Dana', lastName: 'Patel', email: 'dana@e.inc' },
  ...over,
});

const flagged = (over: Record<string, unknown> = {}) =>
  row({
    id: 'fb-2',
    rating: null,
    comment: null,
    flag: 'UNSUPPORTED_CLAIM',
    user: null,
    conversation: null,
    ...over,
  });

function setTrpc(
  data: { rows?: unknown[]; totalCount?: number; statusCounts?: unknown[] } = {},
  over: TrpcMockConfig = {},
) {
  const rows = data.rows ?? [row()];
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'assistant.reviewQueue': {
        data: {
          rows,
          totalCount: data.totalCount ?? rows.length,
          statusCounts: data.statusCounts ?? [{ status: 'PENDING', count: rows.length }],
        },
        ...over.queries?.['assistant.reviewQueue'],
      },
      'assistant.reviewTurn': {
        data: { question: 'What is the Tokyo per-diem?', answer: 'It is **¥7,500** a day.' },
        ...over.queries?.['assistant.reviewTurn'],
      },
      ...over.queries,
    },
  });
}

const show = () => render(<AssistantFeedbackAdmin />);

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter((s) => s.length > 0);

const openFirst = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getAllByRole('button', { name: 'assistant.review.open' })[0]);

/** The table body — the source and status labels also read as picker options. */
const table = () => screen.getByRole('table');
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

// ── The queue ─────────────────────────────────────────────────────────────────

describe('the queue', () => {
  it('reads a person’s rating out with their comment and conversation', () => {
    setTrpc();
    show();
    const text = rowTexts()[0];
    expect(text).toContain('assistant.review.flag.RATING');
    expect(text).toContain('assistant.review.outOfFive:2');
    expect(text).toContain('Dana Patel');
    expect(text).toContain('Per-diem in Tokyo');
    expect(text).toContain('It invented a policy');
  });

  it('lists the assistant’s own flags in the same queue', () => {
    /**
     * The self-flags are what make the loop loop: nobody complained about them, so a
     * queue built only from ratings looks healthy and is not.
     */
    setTrpc({ rows: [flagged()] });
    show();
    expect(
      within(table()).getByText('assistant.review.flag.UNSUPPORTED_CLAIM'),
    ).toBeInTheDocument();
  });

  it('tones an unsupported claim apart from the softer flags', () => {
    // "It made something up" is a different problem from "it could not answer".
    setTrpc({ rows: [flagged(), flagged({ id: 'fb-3', flag: 'NO_ANSWER_FOUND' })] });
    show();
    const bad = within(table()).getByText('assistant.review.flag.UNSUPPORTED_CLAIM');
    const meh = within(table()).getByText('assistant.review.flag.NO_ANSWER_FOUND');
    expect(bad.className).not.toEqual(meh.className);
  });

  it('dashes a flag that carries no rating and no comment', () => {
    setTrpc({ rows: [flagged()] });
    show();
    expect(rowTexts()[0]).toContain('—');
  });

  it('marks a poor rating apart from a middling one', () => {
    setTrpc({ rows: [row({ rating: 1 }), row({ id: 'fb-9', rating: 4 })] });
    show();
    expect(screen.getByText('assistant.review.outOfFive:1').className).toContain(
      'text-destructive',
    );
    expect(screen.getByText('assistant.review.outOfFive:4').className).not.toContain(
      'text-destructive',
    );
  });

  it('names a rating with no signed-in person, and a conversation with no title', () => {
    setTrpc({ rows: [flagged()] });
    show();
    expect(screen.getByText('assistant.review.unknownPerson')).toBeInTheDocument();
    expect(screen.getByText('assistant.review.untitled')).toBeInTheDocument();
  });

  it('says the queue is empty, and why that might be misleading', () => {
    setTrpc({ rows: [], statusCounts: [] });
    show();
    expect(screen.getByText('assistant.review.empty')).toBeInTheDocument();
    expect(screen.getByText('assistant.review.emptyHint')).toBeInTheDocument();
  });
});

// ── Counting ──────────────────────────────────────────────────────────────────

describe('the count', () => {
  it('reports the real match when everything fits', () => {
    setTrpc({ rows: [row(), row({ id: 'fb-2' })], totalCount: 2 });
    show();
    expect(screen.getByText(/assistant\.review\.matched:2/)).toBeInTheDocument();
  });

  it('says so when it is showing a window of a much larger match', () => {
    /**
     * 200 of 5,000 rendered without a word about it reads as "the assistant is nearly
     * perfect", which is the exact opposite of what the data says.
     */
    setTrpc({ rows: [row()], totalCount: 5000 });
    show();
    expect(screen.getByText(/assistant\.review\.windowed:1,5000/)).toBeInTheDocument();
  });

  it('warns about pending work while looking at another status', async () => {
    // The queue you are reading is not the queue that needs attention.
    const user = userEvent.setup();
    setTrpc({ statusCounts: [{ status: 'PENDING', count: 12 }] });
    show();
    await user.selectOptions(screen.getByLabelText('assistant.review.status'), 'DISMISSED');
    expect(screen.getByText('assistant.review.pendingElsewhere:12')).toBeInTheDocument();
  });

  it('stays quiet about pending work while looking AT pending', () => {
    setTrpc({ statusCounts: [{ status: 'PENDING', count: 12 }] });
    show();
    expect(screen.queryByText(/pendingElsewhere/)).not.toBeInTheDocument();
  });

  it('counts each status in its own option', () => {
    setTrpc({
      statusCounts: [
        { status: 'PENDING', count: 3 },
        { status: 'PROMOTED', count: 1 },
      ],
    });
    show();
    const select = screen.getByLabelText('assistant.review.status');
    expect(within(select).getByText('assistant.review.statuses.PENDING (3)')).toBeInTheDocument();
    expect(within(select).getByText('assistant.review.statuses.PROMOTED (1)')).toBeInTheDocument();
    expect(within(select).getByText('assistant.review.statuses.REVIEWED (0)')).toBeInTheDocument();
  });
});

// ── Narrowing ─────────────────────────────────────────────────────────────────

describe('narrowing the queue', () => {
  it('opens on the pending work, not on everything ever said', () => {
    const onCall = vi.fn();
    setTrpc(
      {},
      {
        queries: {
          'assistant.reviewQueue': {
            data: { rows: [row()], totalCount: 1, statusCounts: [] },
            onCall,
          },
        },
      },
    );
    show();
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ status: 'PENDING', flag: null });
  });

  it('asks the server for a status, and for “any” as null', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(
      {},
      {
        queries: {
          'assistant.reviewQueue': {
            data: { rows: [row()], totalCount: 1, statusCounts: [] },
            onCall,
          },
        },
      },
    );
    show();
    await user.selectOptions(screen.getByLabelText('assistant.review.status'), 'PROMOTED');
    expect(onCall.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'PROMOTED' });
    await user.selectOptions(screen.getByLabelText('assistant.review.status'), '');
    expect(onCall.mock.calls.at(-1)?.[0]).toMatchObject({ status: null });
  });

  it('asks the server for one source of feedback', async () => {
    /**
     * The source split is the useful one: "what did the assistant admit to" is a
     * different review session from "what did people complain about".
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(
      {},
      {
        queries: {
          'assistant.reviewQueue': {
            data: { rows: [row()], totalCount: 1, statusCounts: [] },
            onCall,
          },
        },
      },
    );
    show();
    await user.selectOptions(screen.getByLabelText('assistant.review.source'), 'UNSUPPORTED_CLAIM');
    expect(onCall.mock.calls.at(-1)?.[0]).toMatchObject({ flag: 'UNSUPPORTED_CLAIM' });
  });

  it('refines within the window on the person', async () => {
    // Status and source decide which rows exist; the pills refine what came back.
    const user = userEvent.setup();
    setTrpc({
      rows: [
        row(),
        row({
          id: 'fb-2',
          user: { firstName: 'Sam', lastName: 'Ito', email: 'sam@e.inc' },
        }),
      ],
    });
    show();
    await filterColumn(user, 'assistant.review.person', 'sam@');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Sam Ito')).toBeInTheDocument();
  });

  it('refines on the source, treating a rating as its own value', async () => {
    /**
     * `RATING` is not a stored flag — it is the absence of one. Filtering on the text
     * has to find those rows anyway or the column lies about what it holds.
     */
    const user = userEvent.setup();
    setTrpc({ rows: [row(), flagged()] });
    show();
    await filterColumn(user, 'assistant.review.source', 'rating');
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('Dana Patel')).toBeInTheDocument();
  });
});

// ── The review drawer ─────────────────────────────────────────────────────────

describe('reviewing one turn', () => {
  it('asks for nothing until a row is opened', () => {
    const onCall = vi.fn();
    setTrpc({}, { queries: { 'assistant.reviewTurn': { data: undefined, onCall } } });
    show();
    expect(onCall.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
  });

  it('shows the question and the answer behind the row', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openFirst(user);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('What is the Tokyo per-diem?')).toBeInTheDocument();
    expect(within(dialog).getByText(/¥7,500/)).toBeInTheDocument();
  });

  it('renders the answer through the hardened markdown renderer', async () => {
    // The answer is model output; rendering it raw is how a prompt injection lands.
    const user = userEvent.setup();
    setTrpc();
    show();
    await openFirst(user);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('¥7,500').tagName.toLowerCase()).toBe('strong');
  });

  it('says the tool results are deliberately withheld', async () => {
    /**
     * A transcript carries whatever the tools fetched. Holding `admin.help.manage` is
     * not a claim on somebody's report totals — and silence would read as "this turn
     * used no tools".
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await openFirst(user);
    expect(await screen.findByText('assistant.review.toolResultsWithheld')).toBeInTheDocument();
  });

  it('says it is loading rather than showing an empty turn', async () => {
    const user = userEvent.setup();
    setTrpc({}, { queries: { 'assistant.reviewTurn': { isLoading: true, data: undefined } } });
    show();
    await openFirst(user);
    expect(await screen.findByText('assistant.review.loading')).toBeInTheDocument();
  });

  it('names an empty question and an empty answer', async () => {
    const user = userEvent.setup();
    setTrpc({}, { queries: { 'assistant.reviewTurn': { data: { question: '', answer: '' } } } });
    show();
    await openFirst(user);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('assistant.review.noQuestion')).toBeInTheDocument();
    expect(within(dialog).getByText('assistant.review.noAnswer')).toBeInTheDocument();
  });

  it('promotes by recording intent, and nothing else', async () => {
    /**
     * Promotion is a human act with a diff. An auto-promoted wrong answer gets
     * retrieved, reinforced and cited, and compounds silently — so the button posts a
     * status and no knowledge-base write of any kind.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({}, { mutations: { 'assistant.reviewDecide': { onCall } } });
    show();
    await openFirst(user);
    await user.click(await screen.findByRole('button', { name: 'assistant.review.promote' }));
    expect(onCall.mock.calls).toHaveLength(1);
    expect(onCall).toHaveBeenCalledWith({ feedbackId: 'fb-1', status: 'PROMOTED' });
  });

  it('marks a turn reviewed, and dismisses one', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({}, { mutations: { 'assistant.reviewDecide': { onCall } } });
    show();
    await openFirst(user);
    await user.click(await screen.findByRole('button', { name: 'assistant.review.markReviewed' }));
    expect(onCall.mock.calls.at(-1)?.[0]).toEqual({ feedbackId: 'fb-1', status: 'REVIEWED' });
    await user.click(screen.getByRole('button', { name: 'assistant.review.dismiss' }));
    expect(onCall.mock.calls.at(-1)?.[0]).toEqual({ feedbackId: 'fb-1', status: 'DISMISSED' });
  });

  it('decides on the row that was opened, not the first one', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ rows: [row(), flagged()] }, { mutations: { 'assistant.reviewDecide': { onCall } } });
    show();
    await user.click(screen.getAllByRole('button', { name: 'assistant.review.open' })[1]);
    await user.click(await screen.findByRole('button', { name: 'assistant.review.dismiss' }));
    expect(onCall).toHaveBeenCalledWith({ feedbackId: 'fb-2', status: 'DISMISSED' });
  });

  it('closes on a decision, so the queue is not re-decided', async () => {
    const user = userEvent.setup();
    setTrpc({}, { mutations: { 'assistant.reviewDecide': { outcome: 'success' } } });
    show();
    await openFirst(user);
    await user.click(await screen.findByRole('button', { name: 'assistant.review.promote' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('holds all three decisions while one is in flight', async () => {
    const user = userEvent.setup();
    setTrpc({}, { mutations: { 'assistant.reviewDecide': { isPending: true } } });
    show();
    await openFirst(user);
    const dialog = await screen.findByRole('dialog');
    for (const key of ['promote', 'markReviewed', 'dismiss']) {
      expect(
        within(dialog).getByRole('button', { name: `assistant.review.${key}` }),
      ).toBeDisabled();
    }
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe('taking the queue away to read', () => {
  /**
   * The queue is where somebody decides what the assistant got wrong, and that reading
   * happens in a spreadsheet next to the answers themselves — not in this table. So the
   * file has to carry what the columns MEAN rather than how they look: the badges,
   * dashes and truncations here all exist to keep 500 rows scannable, and every one of
   * them is lossy.
   */
  const exportCsv = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    return h.downloads.at(-1)?.csv ?? '';
  };

  it('writes the timestamp as an instant, not as the reader’s locale', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    expect(await exportCsv(user)).toContain('2026-08-01T12:00:00.000Z');
  });

  it('carries the rating as a bare number', async () => {
    /** The cell says "2 out of 5" and colours a poor score; a file that repeats the
     *  sentence cannot be averaged or sorted. */
    const user = userEvent.setup();
    setTrpc();
    show();
    const csv = await exportCsv(user);
    expect(csv).toMatch(/(^|,)2(,|$)/m);
    expect(csv).not.toContain('outOfFive');
  });

  it('names the person by email, not by the name on screen', async () => {
    /** The table shows "Dana Patel" because that is who a reviewer recognises; the file
     *  needs the identifier that joins to a directory. */
    const user = userEvent.setup();
    setTrpc();
    show();
    expect(await exportCsv(user)).toContain('dana@e.inc');
  });

  it('carries the comment and the conversation title verbatim', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('It invented a policy');
    expect(csv).toContain('Per-diem in Tokyo');
  });

  it('spells a self-flagged row as its flag, and a person’s rating as RATING', async () => {
    /**
     * The two arrive in one queue and are answered differently — nobody is waiting on a
     * self-flag — so the distinction has to survive the export, and it is the one thing
     * the source column encodes that the row itself does not.
     */
    const user = userEvent.setup();
    setTrpc({ rows: [row(), flagged()] });
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('UNSUPPORTED_CLAIM');
    expect(csv).toContain('RATING');
  });

  it('leaves what a flagged row never had empty, rather than dashed', async () => {
    /** The table draws an em-dash so the row does not look broken. In a file that dash is
     *  a value, and "no comment" stops being filterable. */
    const user = userEvent.setup();
    setTrpc({ rows: [flagged()] });
    show();
    expect(await exportCsv(user)).not.toContain('—');
  });

  it('exports what the pills left, not the whole window', async () => {
    const user = userEvent.setup();
    setTrpc({ rows: [row(), flagged({ conversation: { title: 'Mileage in Alberta' } })] });
    show();
    await filterColumn(user, 'assistant.review.conversation', 'Tokyo');
    const csv = await exportCsv(user);
    expect(csv).toContain('Per-diem in Tokyo');
    expect(csv).not.toContain('Mileage in Alberta');
  });
});

describe('refining on the conversation', () => {
  it('finds the turn by the title the reader remembers', async () => {
    /**
     * A reviewer arrives from a Slack thread that names the topic, not the feedback id.
     * The title is the only handle they have.
     */
    const user = userEvent.setup();
    setTrpc({ rows: [row(), flagged({ conversation: { title: 'Mileage in Alberta' } })] });
    show();
    await filterColumn(user, 'assistant.review.conversation', 'alberta');
    expect(rowTexts()).toHaveLength(1);
    expect(within(table()).getByText('Mileage in Alberta')).toBeInTheDocument();
  });

  it('drops a row with no conversation rather than matching it against everything', async () => {
    const user = userEvent.setup();
    setTrpc({ rows: [row(), flagged()] });
    show();
    await filterColumn(user, 'assistant.review.conversation', 'tokyo');
    expect(rowTexts()).toHaveLength(1);
  });
});
