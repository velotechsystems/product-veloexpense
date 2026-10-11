import { describe, expect, it, vi } from 'vitest';
import { computeCostMicroUsd, METERED_FEATURES, recordUsage, usageOf } from './usage';

/**
 * VeloExpense (d43): the arithmetic and the row behind `ai_usage`. The rows are written for
 * real by the worker's db suites; this pins the parts that decide what a row SAYS — its
 * cost, the batch discount, and that nothing reading receipts is ever marked metered.
 */

describe('computeCostMicroUsd', () => {
  it('prices a call at the model’s per-token rates', () => {
    // 1,000 in at $3/Mtok + 200 out at $15/Mtok = 3,000 + 3,000 micro-USD.
    expect(computeCostMicroUsd('claude-sonnet-5', 1000, 200)).toBe(6000n);
  });

  it('halves a Message Batches call, the reason the batch path exists', () => {
    expect(computeCostMicroUsd('claude-sonnet-5', 1000, 200, { batch: true })).toBe(3000n);
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
        costMicroUsd: 3000n,
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
    expect(create.mock.calls[0]).toMatchObject([{ data: { receiptId: null, costMicroUsd: 180n } }]);
  });
});
