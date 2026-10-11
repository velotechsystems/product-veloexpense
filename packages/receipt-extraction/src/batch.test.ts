// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK's messages.batches surface (create / retrieve / results).
const { createMock, retrieveMock, resultsMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  retrieveMock: vi.fn(),
  resultsMock: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { batches: { create: createMock, retrieve: retrieveMock, results: resultsMock } };
  },
}));

import { collectReceiptBatch, retrieveReceiptBatch, submitReceiptBatch } from './extract';

const EXTRACTION = {
  vendor: 'Marriott',
  date: '2026-07-01',
  total: 113,
  confidence: 0.91,
};
const succeeded = (customId: string, input: unknown) => ({
  custom_id: customId,
  result: {
    type: 'succeeded',
    message: { content: [{ type: 'tool_use', name: 'record_receipt', input }] },
  },
});

beforeEach(() => {
  createMock.mockReset();
  retrieveMock.mockReset();
  resultsMock.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('submitReceiptBatch', () => {
  it('submits one request per item with a matching custom_id + forced tool', async () => {
    createMock.mockResolvedValue({ id: 'msgbatch_123' });
    const { batchId } = await submitReceiptBatch(
      [
        { customId: 'r1', data: new Uint8Array([1]), mimeType: 'image/jpeg' },
        { customId: 'r2', data: new Uint8Array([2]), mimeType: 'application/pdf' },
      ],
      { apiKey: 'k', model: 'claude-sonnet-5' },
    );
    expect(batchId).toBe('msgbatch_123');
    const { requests } = createMock.mock.calls[0][0];
    expect(requests.map((r: { custom_id: string }) => r.custom_id)).toEqual(['r1', 'r2']);
    expect(requests[0].params.tool_choice).toEqual({ type: 'tool', name: 'record_receipt' });
    expect(requests[0].params.messages[0].content[0].type).toBe('image');
    expect(requests[1].params.messages[0].content[0].type).toBe('document');
  });
});

describe('retrieveReceiptBatch', () => {
  it('returns the processing status', async () => {
    retrieveMock.mockResolvedValue({ processing_status: 'ended' });
    expect(await retrieveReceiptBatch('msgbatch_123', { apiKey: 'k' })).toEqual({
      status: 'ended',
    });
  });
});

describe('collectReceiptBatch', () => {
  it('parses succeeded items and records an error string for failed ones', async () => {
    resultsMock.mockResolvedValue([
      succeeded('r1', EXTRACTION),
      { custom_id: 'r2', result: { type: 'errored', error: {} } },
      // succeeded but no tool_use → refusal, captured as an error
      { custom_id: 'r3', result: { type: 'succeeded', message: { content: [{ type: 'text' }] } } },
    ]);
    const out = await collectReceiptBatch('msgbatch_123', { apiKey: 'k' });
    const byId = Object.fromEntries(out.map((o) => [o.customId, o]));
    expect(byId.r1.data?.vendor).toBe('Marriott');
    expect(byId.r1.confidence).toBe(0.91);
    expect(byId.r2.error).toBe('errored');
    expect(byId.r3.error).toBeTruthy();
    expect(byId.r3.data).toBeUndefined();
  });
});
