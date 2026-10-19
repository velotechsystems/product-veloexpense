import { describe, expect, it, vi } from 'vitest';
import { extractFromArticle, extractFromArticles, type FastClient } from './extract';
import type { Article } from './types';

/**
 * The fan-out.
 *
 * The properties worth pinning are the ones that cost money or correctness if they slip: that the
 * instruction demands verbatim quoting rather than a summary (the whole cost case rests on it),
 * that each call is told what its siblings are (or compound questions become unanswerable), and
 * that one failing call cannot take the answer down with it.
 */

const article = (over: Partial<Article> = {}): Article => ({
  slug: 'meals-and-entertainment',
  title: 'Meals and entertainment',
  modules: ['expense-management'],
  updated: '2026-08-20',
  body: 'Only 50% of the GST/HST on meals and entertainment is recoverable as an ITC.',
  ...over,
});

/** A client that records what it was asked and returns a canned extract. */
function fake(passages: string | null, opts: { fail?: boolean } = {}) {
  const calls: { prompt: string; maxTokens: number; toolChoice: unknown }[] = [];
  const client: FastClient = {
    create: vi.fn(async (params) => {
      if (opts.fail) throw new Error('upstream said no');
      const content = params.messages[0]?.content;
      calls.push({
        prompt: typeof content === 'string' ? content : JSON.stringify(content),
        maxTokens: params.max_tokens,
        toolChoice: params.tool_choice,
      });
      return {
        content:
          passages === null
            ? [{ type: 'text', text: 'no tool call' }]
            : [{ type: 'tool_use', name: 'record_passages', id: 't1', input: { passages } }],
      } as never;
    }),
  };
  return { client, calls };
}

describe('extractFromArticle', () => {
  it('asks for verbatim passages, not a summary', async () => {
    // The cost case rests entirely on this: the fast model's OUTPUT costs the same as the main
    // model's INPUT, so a retelling of the whole article is more expensive than sending the
    // article. Quoting is also what keeps a rate intact through a translation.
    const { client } = fake('Only 50% of the GST/HST on meals is recoverable.');
    await extractFromArticle(client, 'haiku', {
      article: article(),
      intent: 'how much of a meal is claimable',
      siblings: [],
    });
    const tool = (client.create as ReturnType<typeof vi.fn>).mock.calls[0][0].tools[0];
    expect(tool.input_schema.properties.passages.description).toMatch(/VERBATIM/);
    expect(tool.input_schema.properties.passages.description).toMatch(/Do not summarise/);
    expect(tool.input_schema.properties.passages.description).toMatch(/Keep every figure/);
  });

  it('forces the tool, so a prose reply cannot become the extract', async () => {
    const { client } = fake('quoted text');
    await extractFromArticle(client, 'haiku', {
      article: article(),
      intent: 'x',
      siblings: [],
    });
    const params = (client.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'record_passages' });
  });

  it('tells the call what its siblings are, and leaves itself out', async () => {
    // Without this, "can I claim a meal on a per-diem day" is unanswerable: the meals call sees
    // only the meals article and reasonably drops the passage that connected to per-diem.
    const { client, calls } = fake('quoted');
    await extractFromArticle(client, 'haiku', {
      article: article(),
      intent: 'meal on a per-diem day',
      siblings: ['Meals and entertainment', 'Claiming a per-diem allowance'],
    });
    expect(calls[0].prompt).toContain('Claiming a per-diem allowance');
    // Its own title appears as the article heading, not in the sibling list.
    expect(calls[0].prompt).not.toMatch(/alongside this one[\s\S]*- Meals and entertainment/);
  });

  it('omits the sibling section entirely when it is the only article', async () => {
    const { client, calls } = fake('quoted');
    await extractFromArticle(client, 'haiku', {
      article: article(),
      intent: 'x',
      siblings: ['Meals and entertainment'],
    });
    expect(calls[0].prompt).not.toContain('alongside this one');
  });

  it('returns empty rather than throwing when the call fails', async () => {
    // This runs inside a fan-out; one bad article must not take the answer with it.
    const { client } = fake(null, { fail: true });
    const out = await extractFromArticle(client, 'haiku', {
      article: article(),
      intent: 'x',
      siblings: [],
    });
    expect(out).toEqual({
      slug: 'meals-and-entertainment',
      title: 'Meals and entertainment',
      passages: '',
    });
  });

  it('returns empty when the model answered without calling the tool', async () => {
    const { client } = fake(null);
    const out = await extractFromArticle(client, 'haiku', {
      article: article(),
      intent: 'x',
      siblings: [],
    });
    expect(out.passages).toBe('');
  });
});

describe('extractFromArticles', () => {
  it('reads every candidate concurrently', async () => {
    // Concurrency is what makes reading eight articles affordable in TIME. If these ran in
    // sequence the wall clock would be eight calls, and nobody waits that long for help text.
    let inFlight = 0;
    let peak = 0;
    const client: FastClient = {
      create: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return {
          content: [
            { type: 'tool_use', name: 'record_passages', id: 't', input: { passages: 'x' } },
          ],
        } as never;
      }),
    };
    const articles = Array.from({ length: 5 }, (_, i) => article({ slug: `a-${i}` }));
    await extractFromArticles(client, 'haiku', { articles, intent: 'x' });
    expect(peak).toBe(5);
  });

  it('drops the articles that had nothing to offer', async () => {
    // "Read and irrelevant" must not reach the answer as though it were something.
    const client: FastClient = {
      create: vi.fn(async (params) => {
        const prompt = String(params.messages[0]?.content);
        // Keyed on the BODY, not the title: every prompt now names every title, because the
        // sibling list is in it. Which is the feature working.
        const useful = prompt.includes('50% of the GST/HST');
        return {
          content: [
            {
              type: 'tool_use',
              name: 'record_passages',
              id: 't',
              input: { passages: useful ? '50% is recoverable.' : '' },
            },
          ],
        } as never;
      }),
    };
    const out = await extractFromArticles(client, 'haiku', {
      articles: [article(), article({ slug: 'signing-in', title: 'Signing in', body: 'Use SSO.' })],
      intent: 'how much of a meal is claimable',
    });
    expect(out.map((e) => e.slug)).toEqual(['meals-and-entertainment']);
  });

  it('survives a partial failure and returns the rest', async () => {
    let call = 0;
    const client: FastClient = {
      create: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('timeout');
        return {
          content: [
            { type: 'tool_use', name: 'record_passages', id: 't', input: { passages: 'kept' } },
          ],
        } as never;
      }),
    };
    const out = await extractFromArticles(client, 'haiku', {
      articles: [article({ slug: 'a' }), article({ slug: 'b' }), article({ slug: 'c' })],
      intent: 'x',
    });
    expect(out).toHaveLength(2);
  });

  it('does not call the model at all with no candidates', async () => {
    const { client } = fake('x');
    expect(await extractFromArticles(client, 'haiku', { articles: [], intent: 'x' })).toEqual([]);
    expect(client.create).not.toHaveBeenCalled();
  });
});
