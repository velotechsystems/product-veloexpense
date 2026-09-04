/**
 * VX4-8 part 3 — what a control finding SAYS, per reader.
 *
 * Third catalogue of this shape, and the machinery is now genuinely shared:
 * `message-data.ts` supplies the `Fields` accessor, `check:i18n`'s
 * `messageCodesFor` is parameterised, and this file is the copy plus one render
 * function. That was the argument for extracting it in part 2 rather than
 * copying it, and this is the file that collects on it.
 *
 * ── WHY IT MATTERS MOST HERE ────────────────────────────────────────────────
 *
 * A control evaluation is the artefact most likely to be read by SOMEBODY OTHER
 * THAN ITS AUTHOR — an external auditor working through a quarter, a controller
 * who reads French. It is also the one whose sentences are made of counts,
 * thresholds and a category code rather than a person's own words, so there is
 * nothing in them that has to stay in the language it was written in. Upstream
 * stores them rendered, in the language of whichever cron ran.
 *
 * ── SEVERITY IS NOT IN THE SENTENCE ─────────────────────────────────────────
 *
 * None of these say "critical" or "warning". The severity is a column and a badge
 * on the screen; a sentence that also carried it would be two sources of truth
 * for one fact, and the copy is the one that would go stale — which is exactly
 * what happened to `POST_STATUS_COPY` before part 2a pinned it.
 */
import { DEFAULT_LOCALE, fallbackChain, isLocale, type Locale } from '@/lib/i18n/locales';
import { missingCopyMarker } from './enums';
import { pseudoIfEnabled } from '@/lib/i18n/pseudo';
import { fields, type MessageCopy, type MessageData } from '@/lib/i18n/catalog/message-data';

export const CONTROL_MESSAGE_CODES = [
  'STALE_DRAFT',
  'SUBMITTED_NO_ACTION',
  'RETURN_WITHOUT_NOTE',
  'APPROVED_WITHOUT_RECEIPT',
  'FX_RATE_MISSING',
  'GL_MAPPING_GAP',
] as const;

export type ControlMessageCode = (typeof CONTROL_MESSAGE_CODES)[number];

export function isControlMessageCode(value: string): value is ControlMessageCode {
  return (CONTROL_MESSAGE_CODES as readonly string[]).includes(value);
}

export interface ControlMessageDefinition {
  requires: readonly string[];
  copy: MessageCopy;
}

export const CONTROL_MESSAGES: Record<ControlMessageCode, ControlMessageDefinition> = {
  STALE_DRAFT: {
    requires: ['lastTouched', 'thresholdDays', 'amountMinor', 'currencyCode', 'minorUnit'],
    copy: {
      'en-CA': (f) =>
        `A draft holding ${f.money('amountMinor', 'currencyCode', 'minorUnit')} has not been ` +
        `touched since ${f.date('lastTouched')} — past the ${f.count('thresholdDays')}-day ` +
        `threshold. Costs sitting in a draft are costs the company has incurred and not recorded.`,
    },
  },

  SUBMITTED_NO_ACTION: {
    requires: ['daysWaiting', 'thresholdDays', 'amountMinor', 'currencyCode', 'minorUnit'],
    copy: {
      'en-CA': (f) =>
        `Submitted ${f.count('daysWaiting')} days ago with no approval decision — past the ` +
        `${f.count('thresholdDays')}-day threshold. ` +
        `${f.money('amountMinor', 'currencyCode', 'minorUnit')} is waiting on somebody.`,
    },
  },

  RETURN_WITHOUT_NOTE: {
    requires: ['returnedBy', 'returnedOn'],
    copy: {
      'en-CA': (f) =>
        `Returned for edits by ${f.text('returnedBy')} on ${f.date('returnedOn')} with no ` +
        `explanation recorded. The submitter is left guessing, and there is no record of why ` +
        `the company declined to record a cost.`,
    },
  },

  APPROVED_WITHOUT_RECEIPT: {
    requires: ['missing', 'entries', 'unsupportedMinor', 'currencyCode', 'minorUnit'],
    copy: {
      'en-CA': (f) =>
        `Approved with ${f.count('missing')} of ${f.count('entries')} entries missing a ` +
        `receipt — ${f.money('unsupportedMinor', 'currencyCode', 'minorUnit')} with no ` +
        `supporting document on file.`,
    },
  },

  FX_RATE_MISSING: {
    requires: ['entries', 'expenseCurrency', 'reportCurrency', 'amountMinor', 'minorUnit'],
    copy: {
      // The amount is quoted in the EXPENSE's currency, which is the only one it
      // is actually known in — converting it is precisely what cannot be done.
      // `expense(s)`, upstream's own parenthetical plural for this control, and the
      // convention GL_MAPPING_GAP below already uses. The first draft branched on
      // `Number(f.count('entries')) === 1`, which is a bug waiting for a tenant
      // with a thousand of them: `count()` returns LOCALE-FORMATTED text, so
      // `Number('1,234')` is NaN and the sentence would silently take the
      // singular branch.
      'en-CA': (f) =>
        `${f.count('entries')} expense(s) of ` +
        `${f.money('amountMinor', 'expenseCurrency', 'minorUnit')} on a ` +
        `${f.text('reportCurrency')} report, with no exchange rate available for the pair. ` +
        `The reimbursement figure is either wrong or invented.`,
    },
  },

  GL_MAPPING_GAP: {
    // NO MONEY IN THIS SENTENCE, and the absence is deliberate. See the note in
    // `checkGlMappingGaps`: line items carry their expense's currency, so a total
    // across a category is a sum of mixed currencies. Quoting it would be AN-7
    // again. The count is what a person needs to know how much of the period this
    // touched; the fix is the same whatever the amount.
    requires: ['categoryCode', 'lineItems'],
    copy: {
      'en-CA': (f) =>
        `${f.text('categoryCode')} was coded on ${f.count('lineItems')} line item(s) and has ` +
        `no GL account mapped. Nothing is mis-stated yet, but none of it can be posted.`,
    },
  },
};

/**
 * What a stored control finding says to this reader.
 *
 * Identical shape and identical reasoning to `renderFraudMessage` — copy falls
 * back down the locale chain, formatting does not, a `MessageDataError` ends the
 * attempt rather than trying the next language, and the result goes through
 * `pseudoIfEnabled` because a sentence assembled by a function never reaches
 * `localizedFrom` (IL-5/IL-6).
 */
export function renderControlMessage(
  code: string,
  data: MessageData,
  locale: Locale | string,
): string {
  const definition = CONTROL_MESSAGES[code as ControlMessageCode] as
    | ControlMessageDefinition
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
