import { describe, expect, it, vi } from 'vitest';
import { computeCostMicroUsd, METERED_FEATURES, recordUsage, usageOf } from './usage';

/**
 * VeloExpense (d43): the arithmetic and the row behind `ai_usage`. The rows are written for
 * real by the worker's db suites; this pins the parts that decide what a row SAYS — its
 * cost, the batch discount, and that nothing reading receipts is ever marked metered.
 */

describe('computeCostMicroUsd', () => {
  it('prices a call at the model’s per-token rates', () => {
    // f63: Sonnet 5 is $2/Mtok in, $10/Mtok out (Anthropic pricing, 20 Oct 2026).
    // 1,000 in + 200 out = 2,000 + 2,000 micro-USD.
    expect(computeCostMicroUsd('claude-sonnet-5', 1000, 200)).toBe(4000n);
  });

  it('prices each model the app calls at its published rate (f63, 20 Oct 2026)', () => {
    // Sonnet 4.6: $3 / $15. Haiku 4.5 (alias and dated id): $1 / $5.
    expect(computeCostMicroUsd('claude-sonnet-4-6', 1000, 200)).toBe(6000n);
    expect(computeCostMicroUsd('claude-haiku-4-5', 1000, 200)).toBe(2000n);
    expect(computeCostMicroUsd('claude-haiku-4-5-20251001', 1000, 200)).toBe(2000n);
  });

  it('halves a Message Batches call, the reason the batch path exists', () => {
    expect(computeCostMicroUsd('claude-sonnet-5', 1000, 200, { batch: true })).toBe(2000n);
  });

  it('records an unknown model at zero rather than failing the call', () => {
    expect(computeCostMicroUsd('some-future-model', 1000, 200)).toBe(0n);
    expect(computeCostMicroUsd('some-future-model', 1000, 200, { batch: true })).toBe(0n);
  });
});

describe('usageOf', () => {
  it('reads the counts a Messages response reports', () => {
    expect(usageOf({ usage: { input_tokens: 1200, output_tokens: 340 } })).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
    });
  });

  it('is null when the response reports no usage', () => {
    expect(usageOf(null)).toBeNull();
    expect(usageOf({})).toBeNull();
  });

  it('counts a missing or nonsensical figure as zero', () => {
    expect(usageOf({ usage: { input_tokens: -5, output_tokens: 'x' } })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe('recordUsage', () => {
  it('nothing that reads receipts is metered — it is included in the plan', () => {
    expect(METERED_FEATURES.has('receipt_extraction')).toBe(false);
    expect(METERED_FEATURES.has('expense_determination')).toBe(false);
  });

  // w6-03: the assistant spends AI credits.
  it('the assistant is metered, and its row says so', async () => {
    expect(METERED_FEATURES.has('assistant')).toBe(true);
    const create = vi.fn(async () => ({}));
    await recordUsage({ aiUsage: { create } } as never, {
      feature: 'assistant',
      model: 'claude-sonnet-5',
      inputTokens: 2000,
      outputTokens: 100,
      requestId: 'msg_a',
      actorUserId: 'u1',
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feature: 'assistant',
        metered: true,
        costMicroUsd: 5000n,
        receiptId: null,
        actorUserId: 'u1',
      }),
    });
  });

  it('writes one row, unmetered, with the batch-rate cost', async () => {
    const create = vi.fn(async () => ({}));
    await recordUsage({ aiUsage: { create } } as never, {
      feature: 'receipt_extraction',
      model: 'claude-sonnet-5',
      inputTokens: 1000,
      outputTokens: 200,
      requestId: 'msg_1',
      receiptId: 'r1',
      batch: true,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      data: {
        feature: 'receipt_extraction',
        model: 'claude-sonnet-5',
        inputTokens: 1000,
        outputTokens: 200,
        costMicroUsd: 2000n,
        metered: false,
        receiptId: 'r1',
        actorUserId: null,
        requestId: 'msg_1',
      },
    });
  });

  it('records the joint pass against no single receipt', async () => {
    const create = vi.fn(async () => ({}));
    await recordUsage({ aiUsage: { create } } as never, {
      feature: 'expense_determination',
      model: 'claude-sonnet-5',
      inputTokens: 10,
      outputTokens: 10,
      requestId: 'msg_2',
    });
    expect(create.mock.calls[0]).toMatchObject([{ data: { receiptId: null, costMicroUsd: 120n } }]);
  });
});
