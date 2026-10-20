import '@testing-library/jest-dom/vitest';
import { confirmationBlock, settleMarker } from '@expenseos/assistant';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * The panel, driven through its four states: unavailable, empty, answered, and waiting on a
 * press.
 *
 * The assertions that matter are about what is NOT shown. A tool result must never reach the
 * screen, a proposal must never read like a receipt, and a suggestion must never offer
 * something the caller cannot do — the last one is enforced server-side, so here it is only
 * that the panel renders what the server sent and invents nothing.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown, sent: [] as unknown[] }));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/en/expenses' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AssistantPanel } from './AssistantPanel';

const setTrpc = (config: TrpcMockConfig) => {
  h.trpc = createTrpcMock(config);
};

const message = (over: Record<string, unknown> = {}) => ({
  id: 'm-1',
  role: 'assistant',
  content: [{ type: 'text', text: 'You have two open reports.' }],
  createdAt: new Date(),
  feedback: [],
  ...over,
});

const proposalBlock = confirmationBlock({
  toolUseId: 'tu-1',
  toolName: 'submit_expense_report',
  toolInput: { reportId: 'r-1' },
  expiresAt: new Date(Date.now() + 900_000),
});

beforeEach(() => {
  h.sent = [];
  global.fetch = vi.fn(async () => {
    throw new Error('no network in this test');
  }) as never;
});

afterEach(() => {
  h.trpc = undefined;
  vi.clearAllMocks();
});

const renderPanel = () => render(<AssistantPanel open onOpenChange={() => {}} />);

describe('when the assistant is not available', () => {
  it('says so, and says who can fix it', async () => {
    // A control that silently is not there teaches people the feature does not exist. One
    // that names the fix teaches them who to ask.
    setTrpc({
      queries: {
        'assistant.session': {
          data: {
            available: false,
            reason: 'MODULE_OFF',
            conversation: null,
            suggestions: [],
          },
        },
        'assistant.messages': { data: [] },
      },
    });
    renderPanel();
    expect(await screen.findByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('unavailableHint')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('placeholder')).not.toBeInTheDocument();
  });

  it('names the API key when that is what is missing, not the module', async () => {
    /**
     * The two reasons used to collapse into one hint naming module installation, on
     * the reasoning that a person could act on neither. Wrong twice: an administrator
     * can act on a missing key, and the surviving message sent somebody whose module
     * was already installed back to install it again — describing the one problem they
     * had fixed instead of the one they hadn't.
     */
    setTrpc({
      queries: {
        'assistant.session': {
          data: {
            available: false,
            reason: 'NOT_CONFIGURED',
            conversation: null,
            suggestions: [],
          },
        },
        'assistant.messages': { data: [] },
      },
    });
    renderPanel();
    expect(await screen.findByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('unavailableNotConfigured')).toBeInTheDocument();
    // The wrong advice must be gone, not merely joined by the right advice.
    expect(screen.queryByText('unavailableHint')).not.toBeInTheDocument();
  });
});

describe('the empty state', () => {
  it('offers exactly the openers the server sent', async () => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: {
            available: true,
            conversation: null,
            suggestions: ['list_my_expense_reports', 'explain_expense_tax'],
          },
        },
        'assistant.messages': { data: [] },
      },
    });
    renderPanel();
    expect(await screen.findByText('suggestions.list_my_expense_reports')).toBeInTheDocument();
    expect(screen.getByText('suggestions.explain_expense_tax')).toBeInTheDocument();
    // Nothing invented locally: a suggestion the caller cannot use never arrives.
    expect(screen.queryByText('suggestions.list_budgets')).not.toBeInTheDocument();
  });
});

describe('a stored conversation', () => {
  const withMessages = (messages: unknown[]) =>
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: 'Tax' }, suggestions: [] },
        },
        'assistant.messages': { data: messages },
      },
    });

  it('renders the answer and offers a rating', async () => {
    withMessages([message()]);
    renderPanel();
    expect(await screen.findByText('You have two open reports.')).toBeInTheDocument();
    expect(screen.getByText('rateTitle')).toBeInTheDocument();
  });

  it('does not offer a rating twice', async () => {
    // A rating replaces rather than accumulates, and asking again after somebody answered
    // reads as the first one not having registered.
    withMessages([message({ feedback: [{ id: 'f-1', rating: 4, flag: null }] })]);
    renderPanel();
    expect(await screen.findByText('rateThanks')).toBeInTheDocument();
    expect(screen.queryByText('rateTitle')).not.toBeInTheDocument();
  });

  it('never puts a tool result on screen', async () => {
    // Raw record data, and fields the written answer deliberately summarised.
    withMessages([
      message({
        id: 'm-2',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"secretTotal":123456}' }],
      }),
    ]);
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    expect(screen.queryByText(/secretTotal/)).not.toBeInTheDocument();
  });

  it('shows a pending proposal as something that has not happened yet', async () => {
    withMessages([message({ id: 'm-3', role: 'user', content: [proposalBlock] })]);
    renderPanel();
    expect(await screen.findByText('confirmTitle')).toBeInTheDocument();
    expect(screen.getByText('confirmBody')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'decline' })).toBeInTheDocument();
    // The name of what is proposed, so a press is not blind.
    expect(screen.getByText('submit_expense_report')).toBeInTheDocument();
  });

  it('shows a settled proposal without offering the press again', async () => {
    withMessages([
      message({
        id: 'm-4',
        role: 'user',
        content: settleMarker([proposalBlock], 'tu-1', {
          status: 'confirmed',
          result: { ok: 1 },
          at: new Date(),
        }),
      }),
    ]);
    renderPanel();
    expect(await screen.findByText('confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'confirm' })).not.toBeInTheDocument();
  });

  it('does not report a refused action as done', async () => {
    // The gate opened and the procedure still said no. A tick here would claim an action
    // happened that did not.
    withMessages([
      message({
        id: 'm-5',
        role: 'user',
        content: settleMarker([proposalBlock], 'tu-1', {
          status: 'confirmed',
          result: 'FORBIDDEN: not yours',
          at: new Date(),
        }),
      }),
    ]);
    renderPanel();
    expect(await screen.findByText('confirmRefused')).toBeInTheDocument();
    expect(screen.queryByText('confirmed')).not.toBeInTheDocument();
  });
});

describe('the composer', () => {
  beforeEach(() => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': { data: [] },
      },
    });
  });

  it('will not send an empty message', async () => {
    renderPanel();
    const send = await screen.findByRole('button', { name: /send/i });
    expect(send).toBeDisabled();
  });

  it('sends on Enter and keeps Shift+Enter as a newline', async () => {
    // A chat box that needs a mouse to send is one people stop using.
    //
    // Driven with fireEvent rather than `userEvent.type`: userEvent awaits between
    // keystrokes, and a re-render landing in one of those gaps takes the focus with it — the
    // characters then go nowhere and the test fails on a scheduling detail rather than on
    // the behaviour it is about. The behaviour under test is which KEY sends, so the key
    // events are what this dispatches.
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    global.fetch = fetchMock as never;
    renderPanel();
    const box = await screen.findByPlaceholderText('placeholder');
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('what a refusal says', () => {
  beforeEach(() => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': { data: [] },
      },
    });
  });

  /**
   * The route authors a sentence for every refusal it makes — not configured (503),
   * module inactive (404), signed out (401), malformed (400). All of it used to be
   * discarded and rendered as "Something went wrong. Try asking again.", which is
   * advice that cannot work for most of them: asking again does not install a module
   * or fund an account. It also made the panel unable to tell anybody WHY it was
   * broken, which is how a live outage became un-diagnosable from the screen.
   */
  it("shows the server's own reason", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'The assistant is not configured.' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    ) as never;
    renderPanel();
    const box = await screen.findByPlaceholderText('placeholder');
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('The assistant is not configured.')).toBeInTheDocument();
    // And NOT the generic notice, which would be advice that cannot work.
    expect(screen.queryByText('error')).not.toBeInTheDocument();
  });

  it('falls back to the generic notice when there is nothing to read', async () => {
    // A crash or a proxy error page — no JSON body. This is the only case the generic
    // message actually fits.
    global.fetch = vi.fn(async () => new Response(null, { status: 500 })) as never;
    renderPanel();
    const box = await screen.findByPlaceholderText('placeholder');
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('error')).toBeInTheDocument();
  });

  it('still treats 429 as the rate-limit state, not a failure', async () => {
    // The ceiling has its own copy and its own advice; it must not be swallowed by
    // the new message-reading path.
    global.fetch = vi.fn(async () => new Response(null, { status: 429 })) as never;
    renderPanel();
    const box = await screen.findByPlaceholderText('placeholder');
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('rateLimited')).toBeInTheDocument();
  });
});

describe('attaching receipts', () => {
  // VeloExpense (w6-03): jsdom has no `URL.createObjectURL`, which the staged-file chip calls
  // to preview an image. Stub the pair for this block only, and put back what was there.
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  beforeAll(() => {
    URL.createObjectURL = () => 'blob:test-preview';
    URL.revokeObjectURL = () => {};
  });
  afterAll(() => {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  });

  const receipt = (name = 'dinner.heic', type = 'image/heic', bytes = 11) =>
    new File([new Uint8Array(bytes)], name, { type });

  /** A one-frame SSE response, so a turn can be driven without a server. */
  const sse = (events: Record<string, unknown>[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const event of events) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );

  const pick = (...files: File[]) => {
    // The input lives inside its label and is deliberately hidden, so drive the change
    // directly rather than clicking an invisible control.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });
  };

  beforeEach(() => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': { data: [] },
      },
    });
  });

  it('stages a picked receipt and will send it with no words at all', async () => {
    // Dropping three receipts in without typing is a request. Making somebody write "here"
    // first is pedantry.
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    pick(receipt());
    expect(await screen.findByText('dinner.heic')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeEnabled();
  });

  it('describes the files exactly, and sends no bytes', async () => {
    // Typed parameters, or `mock.calls[0]` is an empty tuple and reading the request init
    // off it is a type error `next build` never sees (it only typechecks what apps import).
    const fetchMock = vi.fn(async (_url?: unknown, _init?: { body?: string }) =>
      sse([{ type: 'done' }]),
    );
    global.fetch = fetchMock as never;
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    pick(receipt('dinner.heic', 'image/heic', 11), receipt('taxi.pdf', 'application/pdf', 7));
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    // Exact byte counts: the model copies these into the tool call, and a rounded figure is
    // one it cannot reconstruct.
    expect(body.attachments).toEqual([
      { filename: 'dinner.heic', contentType: 'image/heic', sizeBytes: 11 },
      { filename: 'taxi.pdf', contentType: 'application/pdf', sizeBytes: 7 },
    ]);
    // Nothing resembling content crosses to our server.
    expect(JSON.stringify(body)).not.toContain('base64');
  });

  it('turns away a file nothing downstream can read, and says so', async () => {
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    pick(receipt('ledger.csv', 'text/csv'));
    expect(await screen.findByText('attachRejectedType')).toBeInTheDocument();
    expect(screen.queryByText('ledger.csv')).not.toBeInTheDocument();
  });

  it('lets a staged file be taken back off', async () => {
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    pick(receipt());
    fireEvent.click(await screen.findByRole('button', { name: 'attachRemove' }));
    expect(screen.queryByText('dinner.heic')).not.toBeInTheDocument();
  });

  it('uploads the bytes only after the press, to the slot presigned for them', async () => {
    const register = vi.fn();
    const extract = vi.fn();
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': {
          data: [message({ id: 'm-9', role: 'user', content: [proposalBlock] })],
        },
      },
      mutations: {
        'expenses.receiptCreate': { onCall: register, data: { id: 'receipt-9' } },
        'expenses.startExtraction': { onCall: extract, data: { ok: true } },
      },
    });

    const puts: string[] = [];
    global.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const href = String(url);
      if (href.startsWith('https://s3.example/')) {
        puts.push(href);
        // The bytes, and only here.
        expect(init?.body).toBeInstanceOf(File);
        return new Response(null, { status: 200 });
      }
      return sse([
        {
          type: 'confirmation_result',
          status: 'ok',
          toolName: 'start_expense_report_from_receipts',
          result: {
            reportId: 'r-9',
            uploads: [
              {
                expenseId: 'e-9',
                key: 'r-9/abc.heic',
                filename: 'dinner.heic',
                contentType: 'image/heic',
                url: 'https://s3.example/put/1',
                method: 'PUT',
                headers: { 'Content-Type': 'image/heic' },
              },
            ],
          },
        },
        { type: 'done' },
      ]);
    }) as never;

    renderPanel();
    await screen.findByText('confirmTitle');
    pick(receipt());
    await screen.findByText('dinner.heic');
    // Nothing has been uploaded yet — there was nowhere to put it.
    expect(puts).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    await vi.waitFor(() => expect(register).toHaveBeenCalled());
    expect(puts).toEqual(['https://s3.example/put/1']);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        expenseId: 'e-9',
        key: 'r-9/abc.heic',
        // The real size, from the File — never what the model said it was.
        sizeBytes: 11,
        deferExtraction: true,
      }),
    );
    // One extraction call for the batch, so a big upload takes the cheaper Batch API path.
    expect(extract).toHaveBeenCalledWith({ receiptIds: ['receipt-9'] });
    expect(await screen.findByText('filed')).toBeInTheDocument();
  });

  it('asks for a link sized from the File when the first PUT is refused, and files on it', async () => {
    // The first link is bound to the size the MODEL typed. Copied wrong, storage refuses the
    // PUT; the retry link is sized from the File the browser holds.
    const register = vi.fn();
    const reissue = vi.fn();
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': {
          data: [message({ id: 'm-12', role: 'user', content: [proposalBlock] })],
        },
      },
      mutations: {
        'expenses.receiptUploadUrl': {
          onCall: reissue,
          data: {
            url: 'https://s3.example/put/2',
            method: 'PUT',
            headers: { 'Content-Type': 'image/heic' },
            expiresIn: 300,
            key: 'r-9/def.heic',
          },
        },
        'expenses.receiptCreate': { onCall: register, data: { id: 'receipt-9' } },
        'expenses.startExtraction': { data: { ok: true } },
      },
    });

    const puts: string[] = [];
    global.fetch = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.startsWith('https://s3.example/')) {
        puts.push(href);
        return new Response(null, { status: href.endsWith('/1') ? 403 : 200 });
      }
      return sse([
        {
          type: 'confirmation_result',
          status: 'ok',
          toolName: 'start_expense_report_from_receipts',
          result: {
            reportId: 'r-9',
            uploads: [
              {
                expenseId: 'e-9',
                key: 'r-9/abc.heic',
                filename: 'dinner.heic',
                contentType: 'image/heic',
                url: 'https://s3.example/put/1',
                method: 'PUT',
                headers: { 'Content-Type': 'image/heic' },
              },
            ],
          },
        },
        { type: 'done' },
      ]);
    }) as never;

    renderPanel();
    await screen.findByText('confirmTitle');
    pick(receipt());
    await screen.findByText('dinner.heic');
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    await vi.waitFor(() => expect(register).toHaveBeenCalled());
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(reissue).toHaveBeenCalledWith({
      expenseId: 'e-9',
      filename: 'dinner.heic',
      contentType: 'image/heic',
      // The File's own byte length.
      sizeBytes: 11,
    });
    expect(puts).toEqual(['https://s3.example/put/1', 'https://s3.example/put/2']);
    // The reissued key is the one holding the bytes.
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ expenseId: 'e-9', key: 'r-9/def.heic', sizeBytes: 11 }),
    );
    // Recovered, so it reads as filed, not as a partial failure.
    expect(await screen.findByText('filed')).toBeInTheDocument();
  });

  it('offers a link to the report it just filed into', async () => {
    // The panel links with the router rather than the server's absolute `reportUrl`: in-app,
    // a push beats a full page load. The absolute URL exists for callers with no browser.
    const register = vi.fn();
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': {
          data: [message({ id: 'm-11', role: 'user', content: [proposalBlock] })],
        },
      },
      mutations: {
        'expenses.receiptCreate': { onCall: register, data: { id: 'receipt-9' } },
        'expenses.startExtraction': { data: { ok: true } },
      },
    });
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).startsWith('https://s3.example/')) return new Response(null, { status: 200 });
      return sse([
        {
          type: 'confirmation_result',
          status: 'ok',
          toolName: 'start_expense_report_from_receipts',
          result: {
            reportId: 'r-42',
            uploads: [
              {
                expenseId: 'e-9',
                key: 'r-42/abc.heic',
                filename: 'dinner.heic',
                contentType: 'image/heic',
                url: 'https://s3.example/put/1',
                method: 'PUT',
                headers: { 'Content-Type': 'image/heic' },
              },
            ],
          },
        },
        { type: 'done' },
      ]);
    }) as never;

    renderPanel();
    await screen.findByText('confirmTitle');
    pick(receipt());
    await screen.findByText('dinner.heic');
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    await vi.waitFor(() => expect(register).toHaveBeenCalled());
    const link = await screen.findByRole('link', { name: 'openReport' });
    expect(link).toHaveAttribute('href', '/en/expenses/r-42');
  });

  it('does not upload anything when the proposal is declined', async () => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': {
          data: [message({ id: 'm-10', role: 'user', content: [proposalBlock] })],
        },
      },
    });
    const puts: string[] = [];
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).startsWith('https://s3.example/')) {
        puts.push(String(url));
        return new Response(null, { status: 200 });
      }
      // A decline settles the marker and returns no uploads.
      return sse([
        { type: 'confirmation_result', status: 'ok', toolName: 'x', result: 'declined' },
        { type: 'done' },
      ]);
    }) as never;

    renderPanel();
    await screen.findByText('confirmTitle');
    pick(receipt());
    fireEvent.click(screen.getByRole('button', { name: 'decline' }));

    await vi.waitFor(() => expect(screen.queryByText('confirmTitle')).toBeTruthy());
    expect(puts).toEqual([]);
    // The files stay staged: declining the proposal is not throwing the receipts away.
    expect(screen.getByText('dinner.heic')).toBeInTheDocument();
  });
});

describe('past conversations', () => {
  const CONVERSATIONS = [
    { id: 'c-1', title: 'October expenses', createdAt: new Date(), updatedAt: new Date() },
    { id: 'c-2', title: null, createdAt: new Date(), updatedAt: new Date() },
  ];

  const withHistory = (over: Record<string, unknown> = {}) =>
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': { data: [] },
        'assistant.conversations': { data: CONVERSATIONS },
        ...over,
      },
    });

  const openHistory = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'menu' }));
    fireEvent.click(await screen.findByRole('button', { name: /history/i }));
  };

  it('is reachable from the conversation menu', async () => {
    withHistory();
    renderPanel();
    await openHistory();
    expect(await screen.findByText('October expenses')).toBeInTheDocument();
  });

  it('shows a thread with no title rather than hiding it', async () => {
    // Titles are generated after the first exchange, so an abandoned thread has none — and it
    // is still the one somebody is looking for.
    withHistory();
    renderPanel();
    await openHistory();
    expect(await screen.findByText('untitledThread')).toBeInTheDocument();
  });

  it('replaces the thread rather than sitting beside it', async () => {
    // A list beside a 30rem conversation would take a third of it, and the composer has
    // nothing to send to while you are choosing.
    withHistory();
    renderPanel();
    await openHistory();
    expect(screen.queryByPlaceholderText('placeholder')).not.toBeInTheDocument();
  });

  it('returns to the conversation when one is picked', async () => {
    withHistory();
    renderPanel();
    await openHistory();
    fireEvent.click(await screen.findByText('October expenses'));
    expect(await screen.findByPlaceholderText('placeholder')).toBeInTheDocument();
  });

  it('says so when there is nothing to show', async () => {
    withHistory({ 'assistant.conversations': { data: [] } });
    renderPanel();
    await openHistory();
    expect(await screen.findByText('historyEmpty')).toBeInTheDocument();
  });
});

// ── The composer ──────────────────────────────────────────────────────────────

/**
 * One bounded box: the staged receipts, the textarea, and a second line carrying the
 * three things you can do to the message — attach on the left, dictate and send on the
 * right.
 *
 * The actions used to sit in a row BELOW the box, which made the paperclip read as page
 * furniture rather than as part of what was being written. The assertions here are about
 * containment, because that is the whole change and it is invisible to a test that only
 * checks the buttons exist somewhere on screen.
 */
describe('the composer is one object', () => {
  beforeEach(() => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': { data: [] },
      },
    });
  });

  /** The bordered box that owns the focus ring — the composer proper. */
  const composer = () =>
    (screen.getByPlaceholderText('placeholder').closest('div.rounded-md') ?? null) as HTMLElement;

  it('keeps attach and send inside the same box as the textarea', async () => {
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    const box = composer();
    expect(box).not.toBeNull();
    expect(box.contains(screen.getByLabelText('attach'))).toBe(true);
    expect(box.contains(screen.getByRole('button', { name: /send/i }))).toBe(true);
  });

  it('still refuses to send an empty message', async () => {
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('sends what was typed', async () => {
    renderPanel();
    const box = await screen.findByPlaceholderText('placeholder');
    fireEvent.change(box, { target: { value: 'where is my report' } });
    expect(screen.getByRole('button', { name: /send/i })).toBeEnabled();
  });
});

describe('dictating a question', () => {
  /**
   * The mic is rendered only where the browser can actually dictate, and it appends to the
   * draft rather than replacing it — so somebody can start a sentence, dictate the awkward
   * middle, and finish it by hand.
   *
   * `useVoiceInput` owns the recogniser's contract and is tested against a fake there;
   * these are about the panel's half: whether the control appears, what it is called, and
   * where the words land.
   */
  beforeEach(() => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': { data: [] },
      },
    });
  });

  class Rec {
    static last: Rec | null = null;
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() {
      Rec.last = this;
    }
    start() {}
    stop() {
      this.onend?.();
    }
    abort() {}
    say(text: string, final = true) {
      const r = [{ transcript: text }] as unknown as ArrayLike<{ transcript: string }> & {
        isFinal: boolean;
      };
      (r as { isFinal: boolean }).isFinal = final;
      this.onresult?.({ resultIndex: 0, results: [r] });
    }
  }

  const withVoice = () => {
    Rec.last = null;
    vi.stubGlobal('window', Object.assign(globalThis.window, { SpeechRecognition: Rec }));
  };

  afterEach(() => {
    /**
     * Put the global back to ABSENT, which is what it was before `vi.stubGlobal` added it.
     *
     * `= undefined` would satisfy the detector just as well — `useVoiceInput` reads
     * `w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null`, so undefined and absent
     * are the same answer to it. `delete` is used because it restores the state the suite
     * started in rather than leaving a property that is present and undefined, which is a
     * difference the next test to use `in` would care about and this one cannot see.
     *
     * This carried a `biome-ignore lint/performance/noDelete` until now, and it suppressed
     * nothing: the target is typed `Record<string, unknown>`, which is the map-like case
     * `noDelete` itself documents as the operator's legitimate use, so the rule never
     * fired. Biome reported the dead directive as the repo's one standing warning.
     */
    delete (globalThis.window as unknown as Record<string, unknown>).SpeechRecognition;
  });

  it('offers no mic where the browser cannot dictate', async () => {
    /** Firefox has no recogniser. A mic that does nothing teaches somebody the feature is
     *  broken. */
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    expect(screen.queryByRole('button', { name: 'voice' })).not.toBeInTheDocument();
  });

  it('offers the mic where it can', async () => {
    withVoice();
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    expect(screen.getByRole('button', { name: 'voice' })).toBeInTheDocument();
  });

  it('puts the mic in the same box as the textarea', async () => {
    withVoice();
    renderPanel();
    const area = await screen.findByPlaceholderText('placeholder');
    const box = area.closest('div.rounded-md') as HTMLElement;
    expect(box.contains(screen.getByRole('button', { name: 'voice' }))).toBe(true);
  });

  it('re-labels itself while listening, so the button says what pressing it will do', async () => {
    withVoice();
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    fireEvent.click(screen.getByRole('button', { name: 'voice' }));
    const stop = await screen.findByRole('button', { name: 'voiceStop' });
    expect(stop).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes a dictated phrase into the draft', async () => {
    withVoice();
    renderPanel();
    const area = (await screen.findByPlaceholderText('placeholder')) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: 'voice' }));
    fireEvent(window, new Event('noop'));
    Rec.last?.say('show me my open reports');
    expect(await screen.findByDisplayValue('show me my open reports')).toBe(area);
  });

  it('appends to what was already typed rather than replacing it', async () => {
    /** Start a sentence, dictate the awkward middle, finish it by hand. */
    withVoice();
    renderPanel();
    const area = (await screen.findByPlaceholderText('placeholder')) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'for the Tokyo trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'voice' }));
    Rec.last?.say('what is the per diem');
    expect(await screen.findByDisplayValue('for the Tokyo trip what is the per diem')).toBe(area);
  });

  it('shows the sentence forming without committing it', async () => {
    /** Speaking into a box that stays empty until you stop reads as a microphone that is
     *  not working. */
    withVoice();
    renderPanel();
    const area = (await screen.findByPlaceholderText('placeholder')) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: 'voice' }));
    Rec.last?.say('show me my', false);
    expect(await screen.findByText('show me my')).toBeInTheDocument();
    expect(area.value).toBe('');
  });

  it('says so when the microphone was refused', async () => {
    withVoice();
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    fireEvent.click(screen.getByRole('button', { name: 'voice' }));
    Rec.last?.onerror?.({ error: 'not-allowed' });
    expect(await screen.findByText('voiceDenied')).toBeInTheDocument();
  });

  it('says nothing about a pause', async () => {
    /** `no-speech` fires whenever somebody presses the button and thinks for a moment. */
    withVoice();
    renderPanel();
    await screen.findByPlaceholderText('placeholder');
    fireEvent.click(screen.getByRole('button', { name: 'voice' }));
    Rec.last?.onerror?.({ error: 'no-speech' });
    expect(screen.queryByText('voiceDenied')).not.toBeInTheDocument();
    expect(screen.queryByText('voiceFailed')).not.toBeInTheDocument();
  });
});

/**
 * A turn as the browser actually receives it: an SSE body, frame by frame.
 *
 * The tests above drive refusals, which are ordinary JSON responses. Everything below
 * needs the STREAM, because the three behaviours it covers only exist inside one — the
 * question showing before the answer starts, markdown formatting as it arrives, and a
 * failure that happens after the 200 has already gone out.
 */
function sseResponse(frames: readonly Record<string, unknown>[], hold = false): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      // `hold` leaves the stream open, which is what the panel looks like mid-turn.
      if (!hold) controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('the question, while the answer is still coming', () => {
  beforeEach(() => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': { data: [] },
      },
    });
  });

  it('shows what was asked before anything comes back', async () => {
    /**
     * The transcript belongs to the server and is only re-read when the turn settles, so
     * pressing Enter cleared the box and showed NOTHING until the answer began. For the
     * seconds a tool call takes, the panel looked like it had swallowed the question.
     */
    global.fetch = vi.fn(async () => sseResponse([{ type: 'open', conversationId: 'c-1' }], true));
    renderPanel();
    const box = await screen.findByPlaceholderText('placeholder');
    fireEvent.change(box, { target: { value: 'show me my open reports' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('show me my open reports')).toBeInTheDocument();
  });

  it('clears the box at the same moment, so the question is in exactly one place', async () => {
    global.fetch = vi.fn(async () => sseResponse([{ type: 'open', conversationId: 'c-1' }], true));
    renderPanel();
    const box = (await screen.findByPlaceholderText('placeholder')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('hello');
    expect(box.value).toBe('');
  });

  it('shows no bubble for a turn that is only a press', async () => {
    /**
     * Confirming a proposal sends no message, so nothing must be echoed — an empty
     * bubble would read as the person having said something the transcript then failed
     * to record.
     *
     * What this actually pins is that the optimistic echo lives in `ask` and NOT in
     * `send`: the press goes straight to `send({ confirm })`. Writing it into `send`
     * would be the natural-looking refactor, and this is what would stop it.
     *
     * Counted rather than queried by text: "nothing was added" is the claim, and the
     * only way to check a bubble is ABSENT is to know how many there were before.
     */
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': {
          data: [message({ id: 'm-9', role: 'user', content: [proposalBlock] })],
        },
      },
    });
    global.fetch = vi.fn(async () => sseResponse([{ type: 'open', conversationId: 'c-1' }], true));
    const { container } = renderPanel();
    const bubbles = () => container.querySelectorAll('.bg-primary').length;
    await screen.findByRole('button', { name: 'confirm' });
    const before = bubbles();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    await screen.findByText('thinking');
    expect(bubbles()).toBe(before);
  });
});

describe('formatting as it arrives', () => {
  beforeEach(() => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': { data: [] },
      },
    });
  });

  it('renders half-written bold as bold, not as asterisks', async () => {
    /**
     * `**3 open reports` has no closing pair, so the renderer emitted the asterisks
     * literally — the answer typed out as raw source and snapped into formatting on the
     * last token, which reads as the whole reply flickering.
     */
    global.fetch = vi.fn(async () =>
      sseResponse(
        [
          { type: 'open', conversationId: 'c-1' },
          { type: 'text', text: 'You have **3 open reports' },
        ],
        true,
      ),
    );
    renderPanel();
    const box = await screen.findByPlaceholderText('placeholder');
    fireEvent.change(box, { target: { value: 'how many' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const bold = await screen.findByText('3 open reports');
    expect(bold.tagName).toBe('STRONG');
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
  });
});

describe('a failure that happens mid-answer', () => {
  beforeEach(() => {
    setTrpc({
      queries: {
        'assistant.session': {
          data: { available: true, conversation: { id: 'c-1', title: null }, suggestions: [] },
        },
        'assistant.messages': { data: [] },
      },
    });
  });

  const failWith = (reason?: string) =>
    vi.fn(async () =>
      sseResponse([
        { type: 'open', conversationId: 'c-1' },
        reason ? { type: 'error', reason } : { type: 'error' },
        { type: 'done' },
      ]),
    );

  const ask = async (text = 'list my cards') => {
    renderPanel();
    const box = await screen.findByPlaceholderText('placeholder');
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
  };

  /**
   * Once the stream is open the route cannot answer with a status code, so it sends a
   * REASON and the panel writes the sentence. Every one of these used to render as
   * "Something went wrong. Try asking again." — advice that is wrong for all but the last.
   */
  const reasons = [
    'overloaded',
    'rateLimited',
    'credential',
    'tooLong',
    'upstream',
    'network',
  ] as const;

  for (const reason of reasons) {
    it(`says what happened when the turn failed: ${reason}`, async () => {
      global.fetch = failWith(reason) as never;
      await ask();
      expect(await screen.findByText(`errorReason.${reason}`)).toBeInTheDocument();
      expect(screen.queryByText('error')).not.toBeInTheDocument();
    });
  }

  it('falls back to the generic notice when it genuinely cannot tell', async () => {
    /** `unknown` is the one case "try asking again" actually fits. */
    global.fetch = failWith('unknown') as never;
    await ask();
    expect(await screen.findByText('error')).toBeInTheDocument();
  });

  it('falls back for an error event from an older server that sends no reason', async () => {
    global.fetch = failWith() as never;
    await ask();
    expect(await screen.findByText('error')).toBeInTheDocument();
  });

  it('clears the reason when the next turn starts', async () => {
    /** A stale banner under a fresh answer reads as the new turn having failed too. */
    global.fetch = failWith('credential') as never;
    await ask();
    await screen.findByText('errorReason.credential');

    global.fetch = vi.fn(async () =>
      sseResponse([{ type: 'open', conversationId: 'c-1' }], true),
    ) as never;
    const box = screen.getByPlaceholderText('placeholder');
    fireEvent.change(box, { target: { value: 'again' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('again');
    expect(screen.queryByText('errorReason.credential')).not.toBeInTheDocument();
  });
});
