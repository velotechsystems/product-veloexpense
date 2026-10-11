// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { anthropicForExtraction } from './anthropic';

/**
 * VeloExpense: where the worker's Claude credential comes from.
 *
 * ExpenseOS resolves it from an `anthropic` integration row a tenant admin installs. In
 * VeloExpense AI is native and paid for by Velotech (d40), so it is one key per environment,
 * from Secrets Manager into ANTHROPIC_API_KEY. What carries over is the contract: no key is
 * `null` — never an empty string, which would look configured and fail at the API instead
 * of parking the reading as PENDING — and an unset model leaves the package default.
 */

const saved = { key: process.env.ANTHROPIC_API_KEY, model: process.env.RECEIPT_EXTRACTION_MODEL };
const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  env.ANTHROPIC_API_KEY = saved.key;
  env.RECEIPT_EXTRACTION_MODEL = saved.model;
  if (saved.key === undefined) delete env.ANTHROPIC_API_KEY;
  if (saved.model === undefined) delete env.RECEIPT_EXTRACTION_MODEL;
});

describe('anthropicForExtraction', () => {
  it('is null with no key, so the reading is parked PENDING rather than failed', async () => {
    delete env.ANTHROPIC_API_KEY;
    expect(await anthropicForExtraction()).toBeNull();
  });

  it('is null for a blank key, which would otherwise look configured', async () => {
    env.ANTHROPIC_API_KEY = '   ';
    expect(await anthropicForExtraction()).toBeNull();
  });

  it('hands over the key, and leaves the model to the package unless one is pinned', async () => {
    env.ANTHROPIC_API_KEY = 'sk-test';
    delete env.RECEIPT_EXTRACTION_MODEL;
    expect(await anthropicForExtraction()).toEqual({ apiKey: 'sk-test', model: undefined });
    env.RECEIPT_EXTRACTION_MODEL = 'claude-sonnet-5';
    expect(await anthropicForExtraction()).toEqual({ apiKey: 'sk-test', model: 'claude-sonnet-5' });
  });
});
