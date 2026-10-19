import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { checkGrounding, type FastClient, proposeTitle, reviewTurn } from './review';

const EXCHANGE = { question: 'How do I add a tip?', answer: 'Open the expense and…' };

const replying = (input: unknown, name: string): FastClient => ({
  create: vi.fn(
    async () =>
      ({
        content: [{ type: 'tool_use', id: 'x', name, input }],
      }) as unknown as Anthropic.Message,
  ),
});

const failing = (): FastClient => ({
  create: vi.fn(async () => {
    throw new Error('upstream is down');
  }),
});

describe('proposeTitle', () => {
  it('takes the title the fast model recorded', async () => {
    const title = await proposeTitle(
      replying({ title: 'Adding a tip' }, 'record_title'),
      'haiku',
      EXCHANGE,
    );
    expect(title).toBe('Adding a tip');
  });

  it('never fails a turn because titling failed', async () => {
    // A conversation with no title reads as "New conversation" and works fine. An outage
    // caused by a cosmetic feature does not.
    expect(await proposeTitle(failing(), 'haiku', EXCHANGE)).toBeNull();
  });

  it('rejects a non-string and a blank title', async () => {
    expect(
      await proposeTitle(replying({ title: 42 }, 'record_title'), 'haiku', EXCHANGE),
    ).toBeNull();
    expect(
      await proposeTitle(replying({ title: '  ' }, 'record_title'), 'haiku', EXCHANGE),
    ).toBeNull();
  });

  it('caps a title that ran long', async () => {
    const title = await proposeTitle(
      replying({ title: 'x'.repeat(500) }, 'record_title'),
      'haiku',
      EXCHANGE,
    );
    expect(title).toHaveLength(80);
  });

  it('shows the fast model the answer text, never the tool results', async () => {
    // No reason to hand report totals and approver names to a second model to decide
    // whether a sentence was on topic.
    const client = replying({ title: 'ok' }, 'record_title');
    await proposeTitle(client, 'haiku', EXCHANGE);
    const params = (client.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(params.messages)).toContain('How do I add a tip?');
    expect(params.tools).toHaveLength(1);
  });
});

describe('reviewTurn', () => {
  it('records the two flags the review queue understands', async () => {
    expect(
      await reviewTurn(replying({ flag: 'OFF_TOPIC' }, 'record_review'), 'haiku', EXCHANGE),
    ).toBe('OFF_TOPIC');
    expect(
      await reviewTurn(replying({ flag: 'NO_ANSWER_FOUND' }, 'record_review'), 'haiku', EXCHANGE),
    ).toBe('NO_ANSWER_FOUND');
  });

  it('flags nothing when the answer was fine', async () => {
    expect(
      await reviewTurn(replying({ flag: null }, 'record_review'), 'haiku', EXCHANGE),
    ).toBeNull();
  });

  it('ignores a flag it does not recognise', async () => {
    // This output feeds a queue humans work through. An unknown label there is noise that
    // looks like signal.
    expect(
      await reviewTurn(replying({ flag: 'SPICY' }, 'record_review'), 'haiku', EXCHANGE),
    ).toBeNull();
  });

  it('flags nothing when the call fails', async () => {
    // Evidence, not enforcement: nothing is blocked by this, so a failure costs a queue
    // entry rather than an answer.
    expect(await reviewTurn(failing(), 'haiku', EXCHANGE)).toBeNull();
  });
});

describe('checkGrounding', () => {
  // Params are typed, or `mock.calls[0][0]` is an empty tuple and reading the request off it is
  // a type error `next build` never sees — it only typechecks what the apps import.
  const client = (result: { unsupported: boolean; claim: string } | null, fail = false) => ({
    create: vi.fn(async (_params: Anthropic.MessageCreateParamsNonStreaming) => {
      if (fail) throw new Error('upstream');
      return {
        content:
          result === null
            ? [{ type: 'text', text: 'no tool call' }]
            : [{ type: 'tool_use', name: 'record_grounding', id: 'g', input: result }],
      } as never;
    }),
  });

  const exchange = {
    question: 'how do I recall a report?',
    answer: 'Open Settings and press Undo Submission.',
    guidance: 'Only the submitter can recall, and only while no decision has been made.',
  };

  it('reports the quoted sentence when the answer invented product behaviour', async () => {
    const c = client({ unsupported: true, claim: 'Open Settings and press Undo Submission.' });
    expect(await checkGrounding(c, 'haiku', exchange)).toEqual({
      claim: 'Open Settings and press Undo Submission.',
    });
  });

  it('returns null when the answer stayed inside the guidance', async () => {
    const c = client({ unsupported: false, claim: '' });
    expect(await checkGrounding(c, 'haiku', exchange)).toBeNull();
  });

  it('does not call the model when no guidance was retrieved', async () => {
    // Nothing was retrieved, so there is nothing to be grounded IN. Judging it here would flag
    // every legitimate answer that came from the capability catalog instead.
    const c = client({ unsupported: true, claim: 'anything' });
    expect(await checkGrounding(c, 'haiku', { ...exchange, guidance: '   ' })).toBeNull();
    expect(c.create).not.toHaveBeenCalled();
  });

  it('is given the guidance to compare against, not just the answer', async () => {
    const c = client({ unsupported: false, claim: '' });
    await checkGrounding(c, 'haiku', exchange);
    const sent = String(c.create.mock.calls[0][0].messages[0].content);
    expect(sent).toContain('Only the submitter can recall');
    expect(sent).toContain('Open Settings');
  });

  it('tells the judge to leave general background alone', async () => {
    // The prompt deliberately permits explaining what an ITC is from general knowledge. Flagging
    // that would fill the queue with correct answers and teach whoever reads it to ignore it.
    const c = client({ unsupported: false, claim: '' });
    await checkGrounding(c, 'haiku', exchange);
    // `tools` is a union of tool shapes, so the custom-tool schema needs narrowing to read.
    const tool = c.create.mock.calls[0]?.[0].tools?.[0] as {
      input_schema: { properties: { unsupported: { description: string } } };
    };
    const description = tool.input_schema.properties.unsupported.description;
    expect(description).toMatch(/general background/);
    expect(description).toMatch(/true independently of this product/);
  });

  it('returns null rather than throwing when the call fails', async () => {
    // Evidence, never enforcement: this must not be able to fail a turn.
    expect(await checkGrounding(client(null, true), 'haiku', exchange)).toBeNull();
  });

  it('returns null when the model answered without calling the tool', async () => {
    expect(await checkGrounding(client(null), 'haiku', exchange)).toBeNull();
  });
});
