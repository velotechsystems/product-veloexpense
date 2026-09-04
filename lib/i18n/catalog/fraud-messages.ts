/**
 * VX4-8 part 2 — what a fraud flag SAYS, per reader.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 *
 * `packages/fraud/src/rules.ts` at 5a11a647 builds an English sentence inside
 * each detector and stores it on the row:
 *
 *     reason: `Possible duplicate of expense ${r.otherId} — same merchant ` +
 *             `(${r.merchant}) and amount within ${cfg.duplicate.windowDays} day(s).`
 *
 * That is `policy_violation.message` again, which VX4-7 part 2b replaced with
 * `message_code` + `data` and migration `0029` removed. Three things were wrong
 * with it and all three apply here unchanged: the sentence is frozen in the
 * language of whichever process wrote it; the numbers inside it are formatted in
 * no reader's locale; and it interpolates a RECORD ID into text a person reads,
 * which is what UD-3's crawl exists to catch.
 *
 * So the rules emit a CODE and the numbers behind it, and this file turns the
 * pair into a sentence at read time. Ported behaviour, not ported storage.
 *
 * ── THE SPLIT THAT KEEPS HAPPENING ──────────────────────────────────────────
 *
 * `DUPLICATE` is one RULE and two SENTENCES. Upstream has one of each, with the
 * same-report case distinguished only by a severity and a boolean buried in
 * `evidence`. But those are the two things a reviewer does differently: a
 * duplicate inside one report is usually somebody attaching the same dinner
 * twice, and a duplicate across two reports is the pattern worth opening both
 * for. This is the fourth time in this port that a code designed for a CALLER has
 * turned out coarser than what a READER needs — `rule_code` → `message_code` in
 * 2b, one `INVALID_RANGE` → three sentences in 2c-1, one `WRONG_STATUS` → four in
 * 2c-2. The rule code stays `DUPLICATE`; the message code says which kind.
 *
 * ── NO STORED-ENGLISH FALLBACK, DELIBERATELY ────────────────────────────────
 *
 * `renderViolation` in `policy-messages.ts` falls back to a frozen English column
 * because rows written before `0029` exist and have nothing else. `fraud_flag`
 * was built without that column, so there is no legacy to serve and no fallback
 * to write. A row whose `data` cannot satisfy its sentence renders the missing-
 * copy marker — visible, greppable, and not a blank cell (IL-4).
 */
import { DEFAULT_LOCALE, fallbackChain, isLocale, type Locale } from '@/lib/i18n/locales';
import { missingCopyMarker } from './enums';
import { pseudoIfEnabled } from '@/lib/i18n/pseudo';
import {
  fields,
  type Fields,
  type MessageCopy,
  type MessageData,
} from '@/lib/i18n/catalog/message-data';

export const FRAUD_MESSAGE_CODES = [
  'DUPLICATE_SAME_REPORT',
  'DUPLICATE_OTHER_REPORT',
  'AMOUNT_OUTLIER',
  'VIOLATION_DENSITY',
  'APPROVER_CONCENTRATION',
  // Written in part 2, REMOVED by part 2 because `check:i18n` said "copy exists,
  // no rule emits it", and back here in part 4 alongside `manualFinding()` — the
  // emitter it was waiting for. The round trip is the gate working: copy that
  // ships ahead of its emitter gets translated and never shown.
  'MANUAL_FLAG',
] as const;

export type FraudMessageCode = (typeof FRAUD_MESSAGE_CODES)[number];

export function isFraudMessageCode(value: string): value is FraudMessageCode {
  return (FRAUD_MESSAGE_CODES as readonly string[]).includes(value);
}

export interface FraudMessageDefinition {
  /**
   * The `data` keys this sentence interpolates. Declared, not derived — a
   * function's body cannot be inspected for the keys it will touch. Checked
   * against what the detectors actually emit by
   * `test/i18n-fraud-messages.test.ts`, in both directions.
   */
  requires: readonly string[];
  copy: MessageCopy;
}

export const FRAUD_MESSAGES: Record<FraudMessageCode, FraudMessageDefinition> = {
  /**
   * NO EXPENSE ID IN THE SENTENCE, which is the visible difference from
   * upstream's version. A reviewer reading "possible duplicate of expense
   * 9f3c…-…" learns nothing they can act on; the merchant, the amount and the
   * date of the twin are what let them recognise it, and the link to the other
   * record belongs in the UI as a link rather than in prose as a uuid.
   */
  DUPLICATE_SAME_REPORT: {
    requires: ['merchant', 'amountMinor', 'currencyCode', 'minorUnit', 'otherDate', 'windowDays'],
    copy: {
      'en-CA': (f) =>
        `Another entry on this same report is also ${f.text('merchant')} for ` +
        `${f.money('amountMinor', 'currencyCode', 'minorUnit')}, dated ${f.date('otherDate')} — ` +
        `within ${f.count('windowDays')} day(s). Usually one receipt entered twice.`,
    },
  },

  DUPLICATE_OTHER_REPORT: {
    requires: [
      'merchant',
      'amountMinor',
      'currencyCode',
      'minorUnit',
      'otherDate',
      'otherReportNumber',
      'windowDays',
    ],
    copy: {
      'en-CA': (f) =>
        `${f.text('otherReportNumber')} also claims ${f.text('merchant')} for ` +
        `${f.money('amountMinor', 'currencyCode', 'minorUnit')}, dated ${f.date('otherDate')} — ` +
        `within ${f.count('windowDays')} day(s). Two reports, one charge.`,
    },
  },

  AMOUNT_OUTLIER: {
    requires: [
      'amountMinor',
      'currencyCode',
      'minorUnit',
      'sigmas',
      'meanMinor',
      'samples',
      'lookbackDays',
    ],
    copy: {
      'en-CA': (f) =>
        `${f.money('amountMinor', 'currencyCode', 'minorUnit')} is ${f.decimal('sigmas', 1)} ` +
        `standard deviations above this person's own average of ` +
        `${f.money('meanMinor', 'currencyCode', 'minorUnit')} over ${f.count('samples')} ` +
        `entries in the last ${f.count('lookbackDays')} days.`,
      // 'σ' is deliberately spelled out. Upstream renders `2.4σ`, which is
      // shorter and assumes the reader knows the notation; the people who work
      // this queue are AP clerks, not statisticians.
    },
  },

  VIOLATION_DENSITY: {
    requires: ['violatedExpenses', 'expenses', 'violations'],
    copy: {
      'en-CA': (f) =>
        `${f.count('violatedExpenses')} of ${f.count('expenses')} entries on this report have ` +
        `unresolved policy violations (${f.count('violations')} in total).`,
    },
  },

  /**
   * A PERSON'S OWN WORDS, and the one message here the catalogue does not supply.
   *
   * Said plainly rather than left to be inferred from a code that looks like the
   * others: the renderer passes the note through and refuses an empty one.
   * `f.text` already refuses blank and whitespace-only, so the guard is the
   * accessor rather than a branch — and `raiseManualFlag` refuses it earlier
   * still, so a blank one cannot be stored at all.
   *
   * NOT wrapped in "A reviewer noted:" or anything like it. The screen says who
   * raised it and when; a renderer adding narration around somebody's sentence is
   * a renderer editing it.
   */
  MANUAL_FLAG: {
    requires: ['note'],
    copy: {
      'en-CA': (f) => f.text('note'),
    },
  },

  APPROVER_CONCENTRATION: {
    requires: ['approverName', 'submitterName', 'pairApprovals', 'totalApprovals', 'lookbackDays'],
    copy: {
      'en-CA': (f) =>
        `${f.text('approverName')} decided ${f.count('pairApprovals')} of ` +
        `${f.count('totalApprovals')} of ${f.text('submitterName')}'s approvals in the last ` +
        `${f.count('lookbackDays')} days. More than one person should see the money.`,
    },
  },

};

/**
 * What a stored flag says to this reader.
 *
 * Same three-part shape as `renderPolicyMessage`, and the same reasoning behind
 * each part:
 *   - the COPY falls back down the locale chain; the FORMATTING does not. An
 *     `en-US` reader who lands on `en-CA` copy still gets `en-US` money and
 *     dates, because `reader` is resolved once and handed to `fields` — the
 *     defect part 2b introduced inside its own fix and caught with a test.
 *   - a `MessageDataError` ends the attempt rather than trying the next locale:
 *     a row that cannot satisfy the sentence cannot satisfy it in French either.
 *   - `pseudoIfEnabled` wraps the result, because these renderers are functions
 *     and never reach `localizedFrom` — a sentence assembled here would
 *     otherwise be the one surface the pseudo-locale crawl cannot see (IL-5/6).
 */
export function renderFraudMessage(
  code: string,
  data: MessageData,
  locale: Locale | string,
): string {
  const definition = FRAUD_MESSAGES[code as FraudMessageCode] as
    | FraudMessageDefinition
    | undefined;
  if (definition === undefined) return missingCopyMarker(code);
  const reader: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  for (const target of fallbackChain(locale)) {
    const renderer = definition.copy[target];
    if (renderer === undefined) continue;
    try {
      return pseudoIfEnabled(renderer(fields(code, data, reader), reader));
    } catch {
      return missingCopyMarker(code);
    }
  }
  return missingCopyMarker(code);
}

/** Exported for the tests and for `scripts/check-i18n.mjs`. */
export type { Fields };
