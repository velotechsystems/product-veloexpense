/**
 * The in-flight rule moved to `@expenseos/db` (`extractionProgress.ts`) so the worker can
 * share it; this module re-exports it for the web callers and keeps the English refusal.
 */
export {
  classifyExtraction,
  EXTRACTION_IN_FLIGHT_MAX_MS,
  type ExtractionProgress,
  type ExtractionProgressRow,
  type ExtractionProgressSummary,
  reportExtractionProgress,
  summarizeExtractionProgress,
} from '@expenseos/db';

/** The refusal's sentence. English only, like every other `submit` refusal — the
 *  workbench disables the button with a translated reason before this can be reached. */
export function extractionInFlightMessage(inFlight: number): string {
  const receipts = inFlight === 1 ? '1 receipt is' : `${inFlight} receipts are`;
  return (
    `${receipts} still being read. The amounts on this report can change until that ` +
    'finishes, so it cannot be submitted yet. This usually takes under a minute.'
  );
}
