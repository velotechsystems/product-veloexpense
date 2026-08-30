-- VeloExpense 0015_policy_currency_and_fx — VX3-2, closing PE-1.
--
-- One global reference table and two columns. No new tenant table.
--
-- ── The defect ───────────────────────────────────────────────────────────────
--
-- GAP-AUDIT PE-1, and it is LIVE rather than latent. `expense_report
-- .currency_code` is per REPORT; a policy threshold is per TENANT. So a tenant
-- with one USD report and one CAD report compares both against the same bare
-- number: `thresholdMinor = 500000` means $5,000 USD on one and $5,000 CAD — about
-- $3,650 USD — on the other. VeloExpense ships CAD and USD, so a tenant using both
-- hits this today. VX1-6's single-currency-per-report cascade does not help: it
-- makes each report internally consistent and says nothing about the threshold.
--
-- The tell was in the message text all along. `rules.ts` formats the THRESHOLD
-- with the REPORT's currency — `money(context, limit)` — so a CAD-set limit is
-- printed with a dollar sign on a USD report and reads as if it had been converted.
--
-- ── Why a global rate table ──────────────────────────────────────────────────
--
-- Reference data, same category as `currency`: an exchange rate on a date is a
-- fact about the world, not about a tenant, and one answer per (pair, date) for
-- everybody is the property that makes two tenants' thresholds comparable at all.
-- `0001_init` already names this category and the RLS-coverage guard keys off an
-- `organization_id` column, so this table is correctly outside it.
--
-- **RECIPROCALS ARE NOT STORED.** They are derived in `lib/policy/rates.ts`, and
-- that is PE-7's bug fixed at the source rather than inherited. ExpenseOS builds
-- its lookup forward-only:
--
--     const key = `${r.base}->${r.quote}`;
--     if (!fxRates.has(key)) fxRates.set(key, r.rate.toString());
--
-- Their FX sync is Bank-of-Canada, which publishes CAD-quoted pairs, so `USD->CAD`
-- exists and `CAD->USD` does not. An admin who correctly sets a US entity's policy
-- currency to USD therefore has EVERY CAD line fail to convert — which is what
-- their GA audit recorded as "CAD excluded from totals", a US-fit blocker rather
-- than a cosmetic bug. Storing both directions would invite the two rows to
-- disagree; deriving one from the other cannot.
--
-- ── What this migration deliberately does NOT do ─────────────────────────────
--
-- It seeds no rates. A plausible-looking rate in a global table is worse than an
-- absent one: it is stale from the moment it is written and nothing says so. The
-- demo seed inserts one clearly-labelled fixed pair so the demo tenant and the
-- e2e can convert; a real rate SOURCE (a scheduled Bank-of-Canada fetch, or an
-- admin screen) is unticketed and named as such in HANDOFF §7.

-- ── GLOBAL: exchange rates (no organization_id, no RLS) ──────────────────────
CREATE TABLE fx_rate (
    base       text NOT NULL REFERENCES currency(code),
    quote      text NOT NULL REFERENCES currency(code),
    -- `quote` per 1 `base` — e.g. base USD, quote CAD, rate 1.37 means one US
    -- dollar buys 1.37 Canadian. numeric(18,8) matches ExpenseOS's Decimal(18,8):
    -- eight significant decimals, because a long-tail pair (JPY→USD is ~0.0067)
    -- loses meaning at fewer and float loses it at any.
    rate       numeric(18,8) NOT NULL,
    -- A DATE, not a timestamp. ExpenseOS keys on `fetchedAt` and therefore holds
    -- several rates for one day, which forces every reader to decide which one it
    -- meant. Policy evaluation wants one rate per day, and "the most recent on or
    -- before this date" is a question a date can answer.
    as_of      date NOT NULL,
    -- Where it came from, so a manually-entered rate is distinguishable from a
    -- synced one when the sync eventually exists.
    source     text NOT NULL DEFAULT 'MANUAL',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (base, quote, as_of),
    CONSTRAINT fx_rate_distinct_chk CHECK (base <> quote),
    CONSTRAINT fx_rate_positive_chk CHECK (rate > 0),
    CONSTRAINT fx_rate_source_chk   CHECK (source IN ('MANUAL', 'SYNC', 'SEED'))
);
-- The read is always "latest on or before a date, for this pair".
CREATE INDEX fx_rate_pair_idx ON fx_rate (base, quote, as_of DESC);

COMMENT ON TABLE fx_rate IS
    'Global exchange rates, quote per 1 base. Reciprocals are DERIVED in '
    'lib/policy/rates.ts and must NOT be stored — two rows for one pair can '
    'disagree, a derivation cannot (GAP-AUDIT PE-7).';

-- ── The tenant's policy currency ─────────────────────────────────────────────
--
-- A real column rather than a key in `organization.settings`, following
-- `allow_sole_approver_self_approval` from `0013`: it wants a foreign key, and a
-- setting that governs whether a control fires correctly should not be reachable
-- only through a jsonb path.
--
-- DEFAULT 'CAD' matches ExpenseOS's `policyCurrency` default, and it is the honest
-- reading of the thresholds already in the database: they were entered by a
-- CAD-first tenant with no currency field on the screen, so CAD is what they meant.
ALTER TABLE organization
    ADD COLUMN policy_currency_code text NOT NULL DEFAULT 'CAD' REFERENCES currency(code);

COMMENT ON COLUMN organization.policy_currency_code IS
    'The currency every policy threshold is compared in, unless the rule names its '
    'own. Amounts are converted into it before any numeric comparison (PE-1).';

-- ── The per-rule override ────────────────────────────────────────────────────
--
-- NULL means "use the tenant's policy currency", which is the case for every
-- existing row and for most rules forever. The override exists for the tenant with
-- a Canadian and a US entity, where a meals cap is natural in each currency and
-- converting one into the other produces a threshold nobody chose.
ALTER TABLE expense_policy
    ADD COLUMN currency_code text REFERENCES currency(code);

COMMENT ON COLUMN expense_policy.currency_code IS
    'Currency this rule''s amount thresholds are expressed in. NULL = the '
    'organization''s policy_currency_code.';
