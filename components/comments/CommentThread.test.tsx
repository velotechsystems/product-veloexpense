import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import { CommentThread } from './CommentThread';

/**
 * The discussion panel's enclosed mode: a card that pins its title and composer, and
 * a stream that stays on the newest message.
 *
 * All three used to be broken by one wrapper. The expense workbench put a single
 * `overflow-y-auto` around the heading, the stream AND the composer, so on a thread
 * with history the title scrolled away, the box you type into went off-screen with
 * it, and the panel opened showing the OLDEST message — the least useful line on a
 * screen you opened to read what was just said.
 */

// VeloExpense: ExpenseOS's suite, with three cases for the reason an event carries (d37).
const h = vi.hoisted(() => ({ trpc: undefined as unknown }));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
}));

function setup(config: TrpcMockConfig) {
  h.trpc = createTrpcMock(config);
}

/** Two comments, oldest first — the order the router returns. */
const ITEMS = [
  {
    id: 'a1',
    type: 'COMMENT',
    body: 'oldest',
    via: 'app',
    createdAt: '2026-08-01T10:00:00.000Z',
    author: { firstName: 'Ana', lastName: 'Ruiz', email: 'ana@e.inc' },
  },
  {
    id: 'a2',
    type: 'COMMENT',
    body: 'newest',
    via: 'app',
    createdAt: '2026-08-02T10:00:00.000Z',
    author: { firstName: 'Bo', lastName: 'Chen', email: 'bo@e.inc' },
  },
];

/** jsdom gives every element a scrollHeight of 0, so the assertion would pass on a
 *  component that never scrolled. Stub a real height. */
const STREAM_HEIGHT = 900;
function stubScrollHeight() {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return STREAM_HEIGHT;
    },
  });
}

describe('CommentThread — enclosed', () => {
  beforeEach(() => {
    stubScrollHeight();
    setup({ queries: { 'comments.thread': { data: { items: ITEMS } } } });
  });

  it('scrolls to the newest message on load', () => {
    const { container } = render(
      <CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" enclosed />,
    );
    const stream = container.querySelector('.overflow-y-auto') as HTMLElement;
    expect(stream).toBeTruthy();
    expect(stream.scrollTop).toBe(STREAM_HEIGHT);
  });

  it('breaks a long unbroken word in a message rather than widening the column', () => {
    /**
     * `whitespace-pre-wrap` keeps the author's newlines and wraps at spaces, but it will
     * not break a single long token. One pasted URL or reference number stretched the
     * bubble past the column it lives in and took the surrounding layout with it — the
     * thread sits in the narrow left pane of the expense workbench.
     *
     * Asserted on the class, because jsdom has no layout and so nothing can be measured
     * overflowing; what is pinned is that both are present, since either alone is wrong.
     */
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" enclosed />);
    const body = screen.getByText('newest');
    expect(body.className).toContain('whitespace-pre-wrap');
    expect(body.className).toContain('break-words');
  });

  it('renders the title as a heading, outside the scrolling stream', () => {
    const { container } = render(
      <CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" enclosed />,
    );
    const title = screen.getByRole('heading', { name: 'heading' });
    const stream = container.querySelector('.overflow-y-auto') as HTMLElement;
    // The point of the fix: the title is NOT inside the thing that scrolls.
    expect(stream.contains(title)).toBe(false);
  });

  it('keeps the composer outside the scrolling stream too', () => {
    const { container } = render(
      <CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" enclosed />,
    );
    const box = screen.getByLabelText('placeholder');
    const stream = container.querySelector('.overflow-y-auto') as HTMLElement;
    expect(stream.contains(box)).toBe(false);
  });
});

describe('CommentThread — plain', () => {
  beforeEach(() => {
    stubScrollHeight();
    setup({ queries: { 'comments.thread': { data: { items: ITEMS } } } });
  });

  it('does not own a scroller, so it cannot drag a drawer around', () => {
    // Without `enclosed` the component grows with its content and the DRAWER scrolls.
    // `scrollTop = scrollHeight` on a container it doesn't own would yank the whole
    // panel to the bottom on open.
    // VeloExpense: an expense report — the only subject until travel (ExpenseOS uses a
    // travel request here).
    const { container } = render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="t1" />);
    expect(container.querySelector('.overflow-y-auto')).toBeNull();
  });
});

describe('what the stream shows', () => {
  beforeEach(stubScrollHeight);

  it('says it is loading rather than claiming the thread is empty', () => {
    /** "No comments yet" during a fetch is a factual claim about a subject nobody has
     *  read yet — and on a returned report it is the wrong one. */
    setup({ queries: { 'comments.thread': { isLoading: true, data: undefined } } });
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(screen.queryByText('empty')).not.toBeInTheDocument();
  });

  it('says the thread is empty once it knows that', () => {
    setup({ queries: { 'comments.thread': { data: { items: [] } } } });
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(screen.getByText('empty')).toBeInTheDocument();
  });

  it('interleaves an event with the comments around it', () => {
    /**
     * "Returned by Ana" and the comment explaining why are one conversation. The
     * assertion is on ORDER, because splitting them into two panels — or emitting them
     * in fetch order — makes the reader reconstruct the sequence themselves.
     */
    setup({
      queries: {
        'comments.thread': {
          data: {
            items: [
              ITEMS[0],
              {
                id: 'e1',
                type: 'RETURNED',
                createdAt: '2026-08-01T11:00:00.000Z',
                author: { firstName: 'Ana', lastName: 'Ruiz', email: 'ana@e.inc' },
              },
              ITEMS[1],
            ],
          },
        },
      },
    });
    const { container } = render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(text.indexOf('oldest')).toBeLessThan(text.indexOf('event.RETURNED'));
    expect(text.indexOf('event.RETURNED')).toBeLessThan(text.indexOf('newest'));
  });

  it('skips an event type it has no words for', () => {
    /**
     * Task assignment and other internal bookkeeping reach this stream. Rendering one
     * would print the raw enum — `TASK_ASSIGNED` — into a discussion people read, and
     * the i18n lookup would miss and echo the key anyway.
     */
    setup({
      queries: {
        'comments.thread': {
          data: {
            items: [
              {
                id: 'e2',
                type: 'TASK_ASSIGNED',
                createdAt: '2026-08-01T11:00:00.000Z',
                author: null,
              },
              ITEMS[0],
            ],
          },
        },
      },
    });
    const { container } = render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(container.textContent).not.toContain('TASK_ASSIGNED');
    expect(screen.getByText('oldest')).toBeInTheDocument();
  });

  it('labels a reply that arrived by email, and leaves an in-app one unlabelled', () => {
    /**
     * A terse one-line answer typed here reads as curt; the same line sent from a phone
     * reads as a phone reply. Labelling the in-app case "in the app" is noise, so only
     * the other channels are named.
     */
    setup({
      queries: {
        'comments.thread': {
          data: { items: [ITEMS[0], { ...ITEMS[1], via: 'email' }] },
        },
      },
    });
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(screen.getByText('via.email')).toBeInTheDocument();
    expect(screen.queryByText('via.app')).not.toBeInTheDocument();
  });

  it('names an authorless line with a dash rather than "undefined"', () => {
    setup({
      queries: {
        'comments.thread': {
          data: { items: [{ ...ITEMS[0], author: null }] },
        },
      },
    });
    const { container } = render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(container.textContent).toContain('—');
    expect(container.textContent).not.toContain('undefined');
  });

  it('VeloExpense: shows the reason a report was rejected under its line (d37)', () => {
    // "The submitter and reviewer need to know reasons why rejected or reassigned."
    setup({
      queries: {
        'comments.thread': {
          data: {
            items: [
              {
                id: 'e3',
                type: 'REJECTED',
                note: 'Hotel is over the city cap with no explanation.',
                createdAt: '2026-08-01T11:00:00.000Z',
                author: { firstName: 'Ana', lastName: null, email: 'ana@e.inc' },
              },
            ],
          },
        },
      },
    });
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(screen.getByText('event.REJECTED', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Hotel is over the city cap with no explanation.')).toBeInTheDocument();
  });

  it('VeloExpense: says who a reassignment went to, and why (d37)', () => {
    setup({
      queries: {
        'comments.thread': {
          data: {
            items: [
              {
                id: 'e4',
                type: 'REASSIGNED',
                note: 'On leave until the 20th.',
                assignee: 'Bo Chen',
                createdAt: '2026-08-01T11:00:00.000Z',
                author: { firstName: 'Ana', lastName: null, email: 'ana@e.inc' },
              },
            ],
          },
        },
      },
    });
    const { container } = render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(container.textContent).toContain('event.REASSIGNED');
    expect(screen.getByText('On leave until the 20th.')).toBeInTheDocument();
  });

  it('VeloExpense: draws no reason line for an event that has none', () => {
    setup({
      queries: {
        'comments.thread': {
          data: {
            items: [
              {
                id: 'e5',
                type: 'APPROVED',
                note: null,
                createdAt: '2026-08-01T11:00:00.000Z',
                author: { firstName: 'Ana', lastName: null, email: 'ana@e.inc' },
              },
            ],
          },
        },
      },
    });
    const { container } = render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(container.querySelectorAll('p.whitespace-pre-wrap')).toHaveLength(0);
  });

  it('drops the heading when the section around it already has one', () => {
    setup({ queries: { 'comments.thread': { data: { items: ITEMS } } } });
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" heading={false} />);
    expect(screen.queryByText('heading')).not.toBeInTheDocument();
  });
});

describe('adding to the thread', () => {
  beforeEach(stubScrollHeight);

  const withPost = (post: Record<string, unknown>) =>
    setup({
      queries: { 'comments.thread': { data: { items: ITEMS } } },
      mutations: { 'comments.post': post },
    });

  it('will not post an empty box, or one holding only whitespace', () => {
    /** A blank comment is an audit row and a notification to everybody on the thread. */
    withPost({});
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(screen.getByRole('button', { name: 'post' })).toBeDisabled();
  });

  it('sends the trimmed body against this subject', async () => {
    const calls: unknown[] = [];
    withPost({ onCall: (input: unknown) => calls.push(input) });
    const user = userEvent.setup();
    // VeloExpense: an expense report, as above.
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="t1" />);
    await user.type(screen.getByLabelText('placeholder'), '  needs a receipt  ');
    await user.click(screen.getByRole('button', { name: 'post' }));
    expect(calls).toEqual([
      { subjectType: 'EXPENSE_REPORT', subjectId: 't1', body: 'needs a receipt' },
    ]);
  });

  it('refuses a second press while the first is still in flight', () => {
    /** Two presses on a slow network is the same comment twice, and everybody on the
     *  thread is notified twice. */
    withPost({ isPending: true });
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    const button = screen.getByRole('button', { name: 'posting' });
    expect(button).toBeDisabled();
  });

  it('shows the server’s refusal in place', () => {
    /**
     * A comment that silently fails to post is indistinguishable from one that posted
     * and did not refresh — so the author retypes it, and now it is there twice.
     */
    withPost({ error: { message: 'You no longer have access to this report.' } });
    render(<CommentThread subjectType="EXPENSE_REPORT" subjectId="r1" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'You no longer have access to this report.',
    );
  });
});
