// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK: the client's messages.create is a controllable vi.fn.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import {
  ExtractionRefusedError,
  ExtractionUnavailableError,
  extractReceipt,
  isTransientExtractionFailure,
} from './extract';

const FULL_INPUT = {
  vendor: 'Marriott',
  address: '123 Main St, Toronto ON',
  date: '2026-07-01',
  currencyCode: 'CAD',
  total: 113.0,
  subtotal: 100.0,
  taxGstHst: 13.0,
  taxQst: null,
  taxPst: null,
  mandatoryGratuity: null,
  voluntaryTip: null,
  lineItems: [{ description: 'Room', amount: 100.0, quantity: 1 }],
  derivedCategoryCode: 'travelHotel',
  confidence: 0.92,
};

function toolResponse(input: unknown) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'record_receipt', input }],
  };
}

beforeEach(() => {
  createMock.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('extractReceipt', () => {
  it('throws ExtractionUnavailableError when no API key is configured', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    await expect(
      extractReceipt({ data: new Uint8Array([1]), mimeType: 'image/png' }),
    ).rejects.toBeInstanceOf(ExtractionUnavailableError);
  });

  it('rejects an unsupported document type', async () => {
    await expect(
      extractReceipt({ data: new Uint8Array([1]), mimeType: 'application/zip', apiKey: 'k' }),
    ).rejects.toThrow(/Unsupported document type/);
  });

  it('forces the record_receipt tool, sends an image block, and parses the result', async () => {
    createMock.mockResolvedValue(toolResponse(FULL_INPUT));
    const res = await extractReceipt({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'image/jpeg',
      apiKey: 'k',
      categoryHints: [{ code: 'travelHotel', label: 'Hotel' }],
    });
    expect(res.data.vendor).toBe('Marriott');
    expect(res.data.taxGstHst).toBe(13.0);
    expect(res.confidence).toBe(0.92);

    const arg = createMock.mock.calls[0][0];
    expect(arg.tool_choice).toEqual({ type: 'tool', name: 'record_receipt' });
    expect(arg.tools[0].name).toBe('record_receipt');
    const content = arg.messages[0].content;
    expect(content[0].type).toBe('image');
    expect(
      content.some(
        (b: { type: string; text?: string }) =>
          b.type === 'text' && b.text?.includes('travelHotel'),
      ),
    ).toBe(true);
  });

  it('sends a document block for PDFs', async () => {
    createMock.mockResolvedValue(toolResponse(FULL_INPUT));
    await extractReceipt({ data: new Uint8Array([1]), mimeType: 'application/pdf', apiKey: 'k' });
    expect(createMock.mock.calls[0][0].messages[0].content[0].type).toBe('document');
  });

  it('throws ExtractionRefusedError when the model returns no tool_use block', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'no' }],
    });
    await expect(
      extractReceipt({ data: new Uint8Array([1]), mimeType: 'image/png', apiKey: 'k' }),
    ).rejects.toBeInstanceOf(ExtractionRefusedError);
  });
});

describe('isTransientExtractionFailure', () => {
  /**
   * The line between "try again in a minute" and "this needs a person".
   *
   * On 31 August two production receipts read "Extraction failed" because the AI
   * provider's DAILY CAP had been hit. Nothing retried — the handler is best-effort and
   * never threw — so a capacity blip and a corrupt PDF were recorded identically and both
   * waited for somebody to raise the cap and re-run them by hand.
   */
  const withStatus = (status: number) => Object.assign(new Error('api error'), { status });

  it('retries a rate limit', () => {
    expect(isTransientExtractionFailure(withStatus(429))).toBe(true);
  });

  it('retries an overloaded provider', () => {
    // 529 is Anthropic's "overloaded", which is not a standard HTTP code.
    expect(isTransientExtractionFailure(withStatus(529))).toBe(true);
  });

  it('retries a server or gateway error', () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isTransientExtractionFailure(withStatus(s)), `${s}`).toBe(true);
    }
  });

  it('retries the daily cap, which arrives as prose rather than a status', () => {
    // The outage that prompted this. A billing state that clears on its own.
    expect(isTransientExtractionFailure(new Error('Your credit balance is too low'))).toBe(true);
    expect(isTransientExtractionFailure(new Error('daily limit exceeded'))).toBe(true);
    expect(isTransientExtractionFailure(new Error('quota exceeded for this org'))).toBe(true);
  });

  it('retries a dropped socket, which never has a status at all', () => {
    expect(isTransientExtractionFailure(new Error('socket hang up'))).toBe(true);
    expect(isTransientExtractionFailure(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientExtractionFailure(new Error('Request timed out'))).toBe(true);
  });

  it('does NOT retry a document the model refused', () => {
    // Five more goes reach the same refusal an hour later, having spent money to do it.
    expect(isTransientExtractionFailure(new ExtractionRefusedError('refused'))).toBe(false);
  });

  it('does NOT retry a missing API key', () => {
    // Nothing about waiting fixes an unconfigured integration.
    expect(isTransientExtractionFailure(new ExtractionUnavailableError('no key'))).toBe(false);
  });

  it('does NOT retry an ordinary bad request', () => {
    expect(isTransientExtractionFailure(withStatus(400))).toBe(false);
    expect(isTransientExtractionFailure(withStatus(401))).toBe(false);
    expect(isTransientExtractionFailure(new Error('unsupported media type'))).toBe(false);
  });

  it('survives being handed something that is not an error', () => {
    expect(isTransientExtractionFailure(null)).toBe(false);
    expect(isTransientExtractionFailure(undefined)).toBe(false);
    expect(isTransientExtractionFailure('rate limit')).toBe(true);
  });
});
