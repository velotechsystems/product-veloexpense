-- ════════════════════════════════════════════════════════════════════════════
-- 0029 — A VIOLATION RECORDS WHICH SENTENCE IT IS, NOT ONLY THE SENTENCE
--        (VX4-7 part 2b)
--
-- `policy_violation.message` is English, frozen at validation time, and shown to
-- every later reader — the approver, the auditor, the submitter coming back a
-- month later. IL-11 is the general case; this is the half a normal employee
-- reads most often.
--
-- ── WHY A NEW COLUMN AND NOT `rule_code` ────────────────────────────────────
--
-- The obvious design renders from `rule_code` + `data`, and it does not work:
-- five rule kinds emit TEN distinct sentences. A limit finding reads differently
-- when the amount had to be converted; RECEIPT_REQUIRED has three shapes; and
-- BUDGET_OVERAGE emits an overage finding and a separate FX-floor note that
-- deliberately coexist (that is what `finding_key` is for). Picking among them at
-- render time means re-deriving, from `data`, the branch the rule already chose —
-- the same decision made twice, in two places, from different information.
-- `message_code` records the branch instead of reconstructing it.
--
-- ── WHY `message` SURVIVES ──────────────────────────────────────────────────
--
-- Settled with John on 2 Sep: keep it, as an audit record. A violation waved
-- through with a justification is evidence — `resolve_note` is somebody's written
-- reason for accepting THIS sentence — and a template edited six months later
-- must not silently rewrite what they agreed to. The rendered text is what the
-- screen shows; the stored text is what was said at the time.
--
-- It is also the only thing every EXISTING row can show. Those rows have no
-- labels in their `data` (the inline sentences interpolated a merchant or a line
-- description that was never stored beside it), so there is nothing to backfill
-- from and no honest way to invent one. Hence '' rather than NULL-and-guess:
--
--   message_code = ''  →  "this row predates the catalogue; show `message`"
--
-- and `renderViolation` in lib/i18n/catalog/policy-messages.ts is the one place
-- that branch is taken. NOT NULL DEFAULT '' rather than a nullable column
-- because "" already means something here and a third state (NULL) would mean
-- the same thing with a second code path to forget.
--
-- ── NO CHECK CONSTRAINT ON THE CODE, DELIBERATELY ───────────────────────────
--
-- 0027 pinned the locale set in a CHECK and needed `test/i18n-schema.db.test.ts`
-- to keep that second copy honest. The same trick here would be worse than
-- useless: message codes change with every rule edit, so the constraint would be
-- a migration per sentence, and the SQL copy would drift the moment somebody
-- renamed one. VX1-7 already made this call for `expense_policy.kind` for the
-- same reason. The guarantee lives where it can be complete instead — the
-- catalogue is `Record<PolicyMessageCode, …>` (a compile error if a code is
-- missing), and `check:i18n` asserts the code set in rules.ts and in the
-- catalogue are equal in both directions.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE policy_violation
    ADD COLUMN message_code text NOT NULL DEFAULT '';

COMMENT ON COLUMN policy_violation.message_code IS
    'Which sentence this finding is, from POLICY_MESSAGE_CODES in '
    'lib/i18n/catalog/policy-messages.ts. One per BRANCH, not one per rule_code: '
    'five rule kinds emit ten sentences. '''' means the row predates 0029 and can '
    'only be shown as the frozen English in `message`. Deliberately not a CHECK — '
    'see 0029.';

COMMENT ON COLUMN policy_violation.message IS
    'The sentence as written at validation time, in the default locale. NOT the '
    'display path since 0029 — screens render from (message_code, data) in the '
    'READER''s locale. Kept as the audit record: `resolve_note` is somebody''s '
    'justification for accepting THIS wording, and editing a template later must '
    'not rewrite what they agreed to.';

COMMENT ON COLUMN policy_violation.data IS
    'The finding''s facts, and since 0029 the render inputs too — every value the '
    'sentence interpolates, including the labels and the currency/minor-unit of '
    'each amount, because a render months later cannot re-read a line item that '
    'may have been edited. Each code declares the keys it needs; '
    'test/i18n-policy-messages.test.ts asserts the rules actually emit them.';
