/**
 * VX4-7 part 2a — the generated assertion. UD-5 requirements 1 and 2.
 *
 * No database. This is the guard the delta review asked for, and the two
 * requirements it satisfies are easy to conflate, so they are stated apart:
 *
 *   REQ 1 — enum -> catalogue at the render boundary, with a generated
 *   assertion. Not "somebody remembered to add a label", but a check that
 *   ENUMERATES THE ENUM and demands copy for every member it finds.
 *
 *   REQ 2 — never compare catalogues against each other, because agreement is
 *   not correctness. Two catalogues can agree perfectly and both be missing the
 *   same member; upstream's `check-coverage.mjs` compares locale to locale and
 *   its own sibling gate exists because of what that let through
 *   (`vcc.requests.colSpend` shipped as `vcc.cardImport.colSpend` — "both
 *   locales are equally wrong").
 *
 * ── WHY THIS IMPORTS THE RUNTIME ARRAYS AND THE CATALOGUE SEPARATELY ────────
 *
 * `lib/i18n/catalog/enums.ts` imports every union with `import type`, so it has
 * no runtime knowledge of what the members ARE — the compiler checks it, but the
 * file itself cannot enumerate them. This test imports the actual arrays from
 * the modules that own them, which is the whole point: the SOURCE is the enum in
 * its own module, and the catalogue is the thing being audited against it.
 *
 * Asserting `Object.keys(REPORT_STATUS_COPY)` against itself would look almost
 * identical and prove nothing.
 */
import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, fallbackChain } from '@/lib/i18n/locales';
import {
  CAPABILITY_COPY,
  CHANNEL_COPY,
  CONTROL_RUN_STATUS_COPY,
  CONTROL_SEVERITY_COPY,
  DELEGATION_SCOPE_COPY,
  EMPLOYEE_ROLE_COPY,
  EMPLOYEE_STATUS_COPY,
  EVENT_TYPE_COPY,
  FRAUD_FLAG_STATUS_COPY,
  FRAUD_SEVERITY_COPY,
  POST_STATUS_COPY,
  REPORT_STATUS_COPY,
  enumLabel,
  missingCopyMarker,
  type Copy,
} from '@/lib/i18n/catalog/enums';

/* The runtime arrays, from the modules that OWN each enum. */
import { REPORT_STATUSES } from '@/lib/expenses/service';
import { EMPLOYEE_ROLES, EMPLOYEE_STATUSES } from '@/lib/employees/service';
import { CHANNELS, EVENT_TYPES } from '@/lib/notifications/catalog';
import { CAPABILITIES } from '@/lib/integrations/contract';
import { POST_STATUSES } from '@/lib/integrations/post-outbox';
import { FRAUD_SEVERITIES } from '@/lib/fraud/rules';
import { CONTROL_SEVERITIES } from '@/lib/fraud/controls';
import { FLAG_STATUSES } from '@/lib/fraud/review';
import { CONTROL_RUN_STATUSES } from '@/lib/fraud/evaluate';
import { DELEGATION_SCOPES } from '@/lib/approvals/delegations';

/**
 * The rendered enums, each paired with the array that DEFINES it.
 *
 * A union with no runtime array of its own (`InboxRoute`) is
 * listed with its members written out. `Decision`,
 * `AccountSource` and `ReceiptStatus` used to be here too; VX4-10 part 4 deleted
 * those catalogues after the new dead-catalogue gate in `scripts/check-i18n.mjs`
 * found that nothing outside this file ever read them. That is a second copy
 * and it is the honest one available: those modules export a TYPE and no array,
 * so there is nothing else to enumerate. `every union with a runtime array is
 * paired with it` below asserts the pairing is used wherever one exists, so this
 * list cannot quietly grow hand-written members for an enum that has an array.
 */
const CATALOGUES: {
  name: string;
  members: readonly string[];
  copy: Record<string, Copy>;
  /** True when `members` came from the module's own exported array. */
  fromArray: boolean;
}[] = [
  { name: 'ReportStatus', members: REPORT_STATUSES, copy: REPORT_STATUS_COPY, fromArray: true },
  { name: 'EmployeeRole', members: EMPLOYEE_ROLES, copy: EMPLOYEE_ROLE_COPY, fromArray: true },
  { name: 'EmployeeStatus', members: EMPLOYEE_STATUSES, copy: EMPLOYEE_STATUS_COPY, fromArray: true },
  // w4-02d: `Severity`, `RuleKind` and the rule descriptions went with VeloExpense's v1 policy
  // engine; ExpenseOS's are next-intl copy (`policyRules.*`).
  { name: 'Channel', members: CHANNELS, copy: CHANNEL_COPY, fromArray: true },
  { name: 'EventType', members: EVENT_TYPES, copy: EVENT_TYPE_COPY, fromArray: true },
  { name: 'Capability', members: CAPABILITIES, copy: CAPABILITY_COPY, fromArray: true },
  { name: 'PostStatus', members: POST_STATUSES, copy: POST_STATUS_COPY, fromArray: true },
  { name: 'FraudSeverity', members: FRAUD_SEVERITIES, copy: FRAUD_SEVERITY_COPY, fromArray: true },
  { name: 'FlagStatus', members: FLAG_STATUSES, copy: FRAUD_FLAG_STATUS_COPY, fromArray: true },
  {
    name: 'ControlSeverity',
    members: CONTROL_SEVERITIES,
    copy: CONTROL_SEVERITY_COPY,
    fromArray: true,
  },
  {
    name: 'ControlRunStatus',
    members: CONTROL_RUN_STATUSES,
    copy: CONTROL_RUN_STATUS_COPY,
    fromArray: true,
  },
  { name: 'DelegationScope', members: DELEGATION_SCOPES, copy: DELEGATION_SCOPE_COPY, fromArray: true },
];

describe('every rendered enum member has copy, in every locale we ship', () => {
  it('covers each member of each enum — the source is the ENUM', () => {
    const missing: string[] = [];
    for (const { name, members, copy } of CATALOGUES) {
      for (const member of members) {
        if (!(member in copy)) missing.push(`${name}.${member}`);
      }
    }
    expect(missing, `no catalogue entry for: ${missing.join(', ')}`).toEqual([]);
  });

  it('resolves in every SUPPORTED_LOCALE through the fallback chain', () => {
    // Resolution, not presence. `en-US` legitimately has no entry of its own for
    // almost everything and answers through `en-CA` — asserting the KEY exists
    // would demand 86 duplicated strings and make the chain pointless. Asking
    // whether a reader gets words is the question that matters.
    const gaps: string[] = [];
    for (const { name, members, copy } of CATALOGUES) {
      for (const member of members) {
        for (const locale of SUPPORTED_LOCALES) {
          const label = enumLabel(copy, member, locale);
          if (label === missingCopyMarker(member) || label === '') {
            gaps.push(`${name}.${member} [${locale}]`);
          }
        }
      }
    }
    expect(gaps, `no copy resolves for: ${gaps.slice(0, 10).join(', ')}`).toEqual([]);
  });

  it('has the default locale authored for every member, not inherited', () => {
    // The compiler already requires the `en-CA` KEY (`Copy` demands it), so this
    // is about its VALUE: `{ 'en-CA': '' }` type-checks and renders as nothing.
    const empty: string[] = [];
    for (const { name, members, copy } of CATALOGUES) {
      for (const member of members) {
        const authored = copy[member]?.[DEFAULT_LOCALE];
        if (typeof authored !== 'string' || authored.trim() === '') {
          empty.push(`${name}.${member}`);
        }
      }
    }
    expect(empty, `blank default copy for: ${empty.join(', ')}`).toEqual([]);
  });

  it('every union with a runtime array is paired with it, not retyped', () => {
    // Stops the CATALOGUES list above from quietly growing hand-written members
    // for an enum that exports its own array — which would turn this whole file
    // into the catalogue-vs-catalogue comparison UD-5 req 2 forbids.
    const owned: Record<string, readonly string[]> = {
      ReportStatus: REPORT_STATUSES,
      EmployeeRole: EMPLOYEE_ROLES,
      EmployeeStatus: EMPLOYEE_STATUSES,
      Channel: CHANNELS,
      EventType: EVENT_TYPES,
      Capability: CAPABILITIES,
      PostStatus: POST_STATUSES,
      FraudSeverity: FRAUD_SEVERITIES,
      FlagStatus: FLAG_STATUSES,
      ControlSeverity: CONTROL_SEVERITIES,
      ControlRunStatus: CONTROL_RUN_STATUSES,
      DelegationScope: DELEGATION_SCOPES,
    };
    for (const [name, array] of Object.entries(owned)) {
      const entry = CATALOGUES.find((c) => c.name === name);
      expect(entry, `${name} is missing from CATALOGUES`).toBeDefined();
      expect(entry!.fromArray, `${name} has an exported array and must use it`).toBe(true);
      expect(entry!.members).toBe(array);
    }
  });

  it('does not carry copy for a value the enum does not have', () => {
    // The other direction, and it is not pedantry: a catalogue entry for a
    // member that was removed is copy nobody can reach, and it is how a rename
    // silently leaves the old word behind for whoever reads the file next.
    const stale: string[] = [];
    for (const { name, members, copy } of CATALOGUES) {
      for (const key of Object.keys(copy)) {
        if (!members.includes(key)) stale.push(`${name}.${key}`);
      }
    }
    expect(stale, `copy for values that no longer exist: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('the assertion can actually fail', () => {
  it('reports a member with no entry', () => {
    const holed = { ...REPORT_STATUS_COPY } as Record<string, Copy>;
    delete holed.REIMBURSED;
    expect(enumLabel(holed, 'REIMBURSED', DEFAULT_LOCALE)).toBe('{REIMBURSED}');
    expect(REPORT_STATUSES.some((s) => !(s in holed))).toBe(true);
  });

  it('a RETIRED locale degrades to English, not to markers', () => {
    // Worth pinning because the first draft of this test asserted the opposite
    // and was wrong. `fr-CA` is no longer in SUPPORTED_LOCALES (0028), so it is
    // an UNKNOWN tag, and `fallbackChain` maps unknown tags to the default's
    // chain on purpose — its own comment: "called on stored values … a row that
    // predates a locale being retired should render, not 500".
    //
    // So retiring a locale degrades a stranded row to English. That is the right
    // direction for data that already exists, and it is NOT the same as an
    // English fallback for a SHIPPED locale, which is the thing `fr-CA` used to
    // be forbidden from doing. The difference is whether the product is claiming
    // to speak the language.
    expect(fallbackChain('fr-CA')).toEqual(fallbackChain(DEFAULT_LOCALE));
    expect(enumLabel(REPORT_STATUS_COPY, 'DRAFT', 'fr-CA')).toBe('Draft');
  });

  it('reports a locale with no resolvable copy, when one is genuinely shipped', () => {
    // The state 0028 exists to prevent: a locale IN the registry with its own
    // chain and an unauthored catalogue. Simulated rather than reached, because
    // reaching it would mean shipping it — which is the point.
    const unauthored = { DRAFT: {} } as unknown as Record<string, Copy>;
    expect(enumLabel(unauthored, 'DRAFT', DEFAULT_LOCALE)).toBe('{DRAFT}');
  });
});

describe('enumLabel at the render boundary', () => {
  it('renders the authored word', () => {
    expect(enumLabel(REPORT_STATUS_COPY, 'SUBMITTED', 'en-CA')).toBe('Submitted');
  });

  it('inherits en-CA for en-US where there is no override', () => {
    expect(enumLabel(REPORT_STATUS_COPY, 'SUBMITTED', 'en-US')).toBe('Submitted');
  });

  it('prefers an en-US override when one exists', () => {
    const withOverride = {
      ...REPORT_STATUS_COPY,
      REIMBURSED: { 'en-CA': 'Reimbursed by cheque', 'en-US': 'Reimbursed by check' },
    } as Record<string, Copy>;
    expect(enumLabel(withOverride, 'REIMBURSED', 'en-CA')).toBe('Reimbursed by cheque');
    expect(enumLabel(withOverride, 'REIMBURSED', 'en-US')).toBe('Reimbursed by check');
  });

  it('marks an unknown value rather than printing it bare', () => {
    // A stored value from a member that no longer exists. `{WITHDRAWN}` names
    // what is missing; `WITHDRAWN` looks like a deliberate label.
    expect(enumLabel(REPORT_STATUS_COPY, 'WITHDRAWN', 'en-CA')).toBe('{WITHDRAWN}');
  });

  it('renders nothing for an absent value', () => {
    for (const empty of [null, undefined, '']) {
      expect(enumLabel(REPORT_STATUS_COPY, empty, 'en-CA')).toBe('');
    }
  });
});
