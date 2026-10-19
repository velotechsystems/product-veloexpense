import { describe, expect, it } from 'vitest';
import { assistantConfigured, DEFAULT_FAST_MODEL, DEFAULT_MODEL, resolveModels } from './models';

/** VeloExpense (w6-03): Next's `ProcessEnv` requires `NODE_ENV`, so a test's partial env is
 *  cast, as `server/platform/serpapi.test.ts` does. */
const asEnv = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe('resolveModels', () => {
  it('defaults to the reasoning model for answers and the fast one for chores', () => {
    expect(resolveModels(asEnv({}))).toEqual({ model: DEFAULT_MODEL, fastModel: DEFAULT_FAST_MODEL });
  });

  it('lets a deployment pin either one independently', () => {
    // They are chosen for different reasons; pinning the reasoning model is no reason to
    // also pin the one that writes conversation titles.
    expect(resolveModels(asEnv({ ASSISTANT_MODEL: 'claude-opus-4-8' }))).toEqual({
      model: 'claude-opus-4-8',
      fastModel: DEFAULT_FAST_MODEL,
    });
  });

  it('treats a blank override as unset', () => {
    // An empty variable in a deploy config is a mistake, not a request for an empty model
    // name — which would fail every call with an unhelpful API error.
    expect(resolveModels(asEnv({ ASSISTANT_MODEL: '   ' })).model).toBe(DEFAULT_MODEL);
  });
});

describe('assistantConfigured', () => {
  it('is false without a key, so the chat can decline to appear', () => {
    // A panel that opens and fails on the first message is worse than one that isn't there.
    expect(assistantConfigured(asEnv({}))).toBe(false);
    expect(assistantConfigured(asEnv({ ANTHROPIC_API_KEY: '' }))).toBe(false);
  });

  it('is true with one', () => {
    expect(assistantConfigured(asEnv({ ANTHROPIC_API_KEY: 'sk-ant-…' }))).toBe(true);
  });
});
