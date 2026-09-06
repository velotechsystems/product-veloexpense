-- VeloExpense 0039 — the platform owns billing. This undoes a mistake of mine.
--
-- ── WHAT 0037 GOT WRONG ─────────────────────────────────────────────────────
--
-- 0037 built VeloExpense its own plan catalogue: `billing_plan` (name, period,
-- currency, trial days) and `billing_plan_component` (`unit_amount_minor` — a
-- PRICE). It was written as though this product decides what a customer pays.
--
-- It does not, and the rest of the suite already says so. The VeloTech platform
-- (the VeloCRM-hosted billing service) holds ONE `subscription_plans` catalogue
-- with a `product` dimension, mints the Stripe Products and Prices, runs the
-- checkout, and answers `GET /api/v1/platform/entitlements?product=<p>` for every
-- product in the family. VeloLedger consumes exactly that and stores no plan of
-- its own; its own client says it in one line — "VeloLedger does not own billing".
--
-- So 0037's catalogue was a SECOND PRICE LIST for the same customers, in a
-- different database, maintained by hand. That is the defect this project has
-- spent the week fixing elsewhere: UD-9 (three hand-kept copies, one already
-- obsolete before anybody noticed) and UD-1 (a currency the adapters did send,
-- that nothing asserted, and a month of USD booked as CAD in the gap). 0038's own
-- header argues that an invoice table here "would be a second copy of somebody
-- else's record, drifting from it" — and 0037 had already done it with prices.
--
-- Both tables are dropped. There is nothing to preserve: no deployment has run
-- them against real customers, and the rows they hold are placeholder prices I
-- invented.
--
-- ── WHAT REPLACES THEM ──────────────────────────────────────────────────────
--
-- `organization.account_id` — the platform's Account UUID, and the ONLY platform
-- identifier this product stores. Ported from VeloLedger's `0051` along with its
-- reasoning: the provisioning call stamps it at tenant creation, and until then
-- the entitlement client falls back to resolving the account by the signed-in
-- user's email domain.
--
-- `subscription` SURVIVES, demoted from a source of truth to a MIRROR, and the
-- new columns are what make that legible rather than a matter of trust:
-- `mirrored_at` says when the platform last answered, and `read_only` carries the
-- platform's own verdict instead of one derived here from a status.
--
-- ── WHY MIRROR AT ALL, WHEN VeloLedger STORES NOTHING ──────────────────────
--
-- Their client is a read-through with a 60-second cache, used for display and, in
-- its own words, "(future) gating". Ours gates TODAY, inside the transaction that
-- guards every submit, approval and payment.
--
-- An HTTP call to the platform inside that transaction would put a network round
-- trip in the middle of a database transaction and make every write in this
-- product fail when the platform hiccups — trading a billing outage for an
-- operations outage, which is a much worse thing to do to a customer who has paid.
--
-- So the entitlement is fetched OUTSIDE the write path and written here, and the
-- gate reads this table. The mirror is never authoritative: `mirrored_at` is on
-- the row precisely so that "the platform said this, at this time" is what a
-- reader sees rather than "this is true".
--
-- AND IT FAILS OPEN. An unreachable platform, an unconfigured one, or a mirror
-- that was never populated all mean the tenant keeps working. That is the same
-- decision `canWriteWithoutSubscription` already documents and the same one
-- VeloLedger makes with its `state: 'disabled'` — a billing integration that can
-- take a working product offline by being down is not a billing integration, it
-- is a single point of failure with an invoice attached.

-- ── the platform Account link ───────────────────────────────────────────────
ALTER TABLE organization ADD COLUMN account_id uuid;

-- Reconciling a platform Account back to its VeloExpense tenant — the direction
-- the inbound provisioning call needs, and the one a webhook would need later.
CREATE INDEX organization_by_account_idx ON organization (account_id)
    WHERE account_id IS NOT NULL;

-- ── subscription becomes the mirror ─────────────────────────────────────────

-- The FK goes first: `plan_code` now holds the PLATFORM's plan slug, which this
-- database has no catalogue to check it against and should not have one. Free
-- text, and deliberately so — a CHECK listing the platform's plans would be the
-- same duplication one layer down.
ALTER TABLE subscription DROP CONSTRAINT subscription_plan_code_fkey;

-- When the platform last answered. NULL means "never mirrored", which is a
-- different thing from "no subscription" and the gate treats it the same way it
-- treats an absent row: permitted.
ALTER TABLE subscription ADD COLUMN mirrored_at timestamptz;

-- The platform's plan NAME as well as its slug. `plan_code` used to be a foreign
-- key into a catalogue that held the display name; with that catalogue gone, a
-- screen showing "team" instead of "Team" would be the visible cost of this
-- change, and the platform already sends both.
ALTER TABLE subscription ADD COLUMN plan_name text;

-- The platform's OWN verdict on whether this account may write, rather than one
-- derived here from a status string. Nullable because a row mirrored before this
-- column existed has no answer, and guessing one is exactly what this ticket is
-- about not doing.
ALTER TABLE subscription ADD COLUMN read_only boolean;

-- 0037 required TRIALING to carry a trial end, because this product decided the
-- trial. It no longer does — the platform sets `trialEndsAt` and may legitimately
-- report a trialing account with no end date visible to us. A constraint that
-- refuses to record what the platform actually said would make the mirror lie.
ALTER TABLE subscription DROP CONSTRAINT subscription_trial_has_end;

-- Same reasoning for the cancellation date: the platform's `status: 'canceled'`
-- arrives without our `cancelled_at`, and inventing a timestamp to satisfy a
-- constraint is how a mirror stops being a mirror.
ALTER TABLE subscription DROP CONSTRAINT subscription_cancelled_has_date;

-- The status vocabulary widens to hold what the platform actually returns.
-- Theirs: active | trialing | past_due | canceled | suspended. Ours had no
-- SUSPENDED and called their `canceled` CANCELLED. Rather than map lossily at the
-- boundary — which is where a status becomes a guess — the column now accepts the
-- union, and `lib/billing/plans.ts` decides what each one PERMITS.
ALTER TABLE subscription DROP CONSTRAINT subscription_status_check;
ALTER TABLE subscription ADD CONSTRAINT subscription_status_check
    CHECK (status IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'LAPSED', 'CANCELLED', 'SUSPENDED'));

-- ── the catalogue that should never have been here ──────────────────────────
--
-- `billing_plan_component` first: it references `billing_plan`.
DROP TABLE billing_plan_component;
DROP TABLE billing_plan;
