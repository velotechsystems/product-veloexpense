// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { anthropicConfigured, resolveAnthropicConfig } from './anthropicConfig';

/**
 * Where the Claude key comes from.
 *
 * Ported from ExpenseOS `packages/db/src/anthropicConfig.test.ts` (1e682dd6): its
 * environment cases. VeloExpense (w6-03): the installation cases are not ported — there is
 * no `anthropic` integration here (d40), so the environment is the only source.
 */

const ENV = { ANTHROPIC_API_KEY: 'env-key' } as unknown as NodeJS.ProcessEnv;
const asEnv = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe('resolveAnthropicConfig', () => {
  it('reads the environment', async () => {
    const c = await resolveAnthropicConfig(null, ENV);
    expect(c).toMatchObject({ apiKey: 'env-key', source: 'env' });
  });

  it('carries the model overrides off the environment', async () => {
    const c = await resolveAnthropicConfig(
      null,
      asEnv({
        ANTHROPIC_API_KEY: 'k',
        ASSISTANT_MODEL: 'claude-opus-5',
        ASSISTANT_FAST_MODEL: 'claude-haiku-4-5',
        RECEIPT_EXTRACTION_MODEL: 'claude-sonnet-5',
      }),
    );
    expect(c).toMatchObject({
      assistantModel: 'claude-opus-5',
      assistantFastModel: 'claude-haiku-4-5',
      extractionModel: 'claude-sonnet-5',
    });
  });

  it('ignores blank model overrides rather than pinning an empty model', async () => {
    const c = await resolveAnthropicConfig(null, asEnv({ ANTHROPIC_API_KEY: 'k', ASSISTANT_MODEL: '  ' }));
    expect(c?.assistantModel).toBeUndefined();
  });

  it('returns null when there is no key', async () => {
    // Null, not a throw: the assistant declines to offer itself. Not a broken page.
    expect(await resolveAnthropicConfig(null, asEnv({}))).toBeNull();
    expect(await resolveAnthropicConfig(null, asEnv({ ANTHROPIC_API_KEY: '   ' }))).toBeNull();
    expect(await anthropicConfigured(null, asEnv({}))).toBe(false);
  });

  it('trims a key pasted with whitespace', async () => {
    const c = await resolveAnthropicConfig(null, asEnv({ ANTHROPIC_API_KEY: '  sk-ant-x  ' }));
    expect(c?.apiKey).toBe('sk-ant-x');
  });
});
