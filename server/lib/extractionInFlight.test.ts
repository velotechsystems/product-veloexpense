import { describe, expect, it } from 'vitest';
import {
  classifyExtraction,
  EXTRACTION_IN_FLIGHT_MAX_MS,
  type ExtractionProgressRow,
  extractionInFlightMessage,
  summarizeExtractionProgress,
} from './extractionInFlight';

const NOW = new Date('2026-09-15T12:00:00Z');
const row = (over: Partial<ExtractionProgressRow> = {}): ExtractionProgressRow => ({
  scanStatus: 'CLEAN',
  status: 'PENDING',
  error: null,
  updatedAt: NOW,
  ...over,
});

describe('classifyExtraction', () => {
  it('holds the report while the scan, the queue or the model still has the receipt', () => {
    expect(classifyExtraction(row({ scanStatus: 'PENDING' }), NOW)).toBe('inFlight');
    expect(classifyExtraction(row({ scanStatus: 'SCANNING' }), NOW)).toBe('inFlight');
    // The scan re-poll parks the row PENDING with an error while SCANNING is still set —
    // the scan clause has to win, or an actively re-polled receipt would look settled.
    expect(
      classifyExtraction(row({ scanStatus: 'SCANNING', error: 'malware scan in progress' }), NOW),
    ).toBe('inFlight');
    expect(classifyExtraction(row({ status: 'EXTRACTING' }), NOW)).toBe('inFlight');
    expect(classifyExtraction(row({ status: 'PENDING', error: null }), NOW)).toBe('inFlight');
  });

  it('never holds the report on a reading that has finished, failed, or will not run', () => {
    expect(classifyExtraction(row({ status: 'EXTRACTED' }), NOW)).toBe('settled');
    expect(classifyExtraction(row({ status: 'FAILED', error: 'unreadable' }), NOW)).toBe('settled');
    expect(classifyExtraction(row({ scanStatus: 'INFECTED', status: 'FAILED' }), NOW)).toBe(
      'settled',
    );
    // The no-API-key contract: a receipt still uploads and can be typed over.
    expect(classifyExtraction(row({ error: 'extraction not configured' }), NOW)).toBe('settled');
    expect(
      classifyExtraction(row({ scanStatus: 'FAILED', error: 'malware scan timed out' }), NOW),
      // Scan budget exhausted: the worker parked it and will not come back on its own.
    ).toBe('settled');
  });

  it('stops holding the report once the worker has been silent for the cap', () => {
    const justInside = new Date(NOW.getTime() - EXTRACTION_IN_FLIGHT_MAX_MS);
    const justPast = new Date(NOW.getTime() - EXTRACTION_IN_FLIGHT_MAX_MS - 1);
    expect(classifyExtraction(row({ status: 'EXTRACTING', updatedAt: justInside }), NOW)).toBe(
      'inFlight',
    );
    expect(classifyExtraction(row({ status: 'EXTRACTING', updatedAt: justPast }), NOW)).toBe(
      'stale',
    );
    // A settled row is settled regardless of age — it is not "stale", it is done.
    expect(classifyExtraction(row({ status: 'EXTRACTED', updatedAt: justPast }), NOW)).toBe(
      'settled',
    );
  });

  it('is fifteen minutes, the same cap the NetSuite sweep rescues a stranded row at', () => {
    expect(EXTRACTION_IN_FLIGHT_MAX_MS).toBe(15 * 60_000);
  });
});

describe('summarizeExtractionProgress', () => {
  it('counts the two states that matter and ignores rows that have no extraction yet', () => {
    const old = new Date(NOW.getTime() - EXTRACTION_IN_FLIGHT_MAX_MS - 1000);
    expect(
      summarizeExtractionProgress(
        [
          row({ status: 'EXTRACTING' }),
          row({ scanStatus: 'SCANNING' }),
          row({ status: 'EXTRACTING', updatedAt: old }),
          row({ status: 'EXTRACTED' }),
          null,
          undefined,
        ],
        NOW,
      ),
    ).toEqual({ inFlight: 2, stale: 1 });
    expect(summarizeExtractionProgress([], NOW)).toEqual({ inFlight: 0, stale: 0 });
  });
});

describe('extractionInFlightMessage', () => {
  it('says how many, and that nothing was sent', () => {
    expect(extractionInFlightMessage(1)).toMatch(/^1 receipt is still being read\./);
    expect(extractionInFlightMessage(3)).toMatch(/^3 receipts are still being read\./);
    expect(extractionInFlightMessage(3)).toMatch(/cannot be submitted yet/);
  });
});
