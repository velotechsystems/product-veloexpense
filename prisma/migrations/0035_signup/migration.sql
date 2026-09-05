-- VeloExpense 0035 — the signup, which is a credential with no tenant (VX5-2).
--
-- ── WHAT THIS TABLE IS, AND WHY IT IS NOT LIKE THE OTHERS ───────────────────
--
-- Every other table in this schema is either tenant-scoped (organization_id +
-- FORCE RLS + tenant_isolation) or global reference data. This is neither. It
-- holds the email addresses of people who are NOT customers — who may never
-- become customers — together with a live credential, and it exists precisely
-- during the window before there is a tenant to scope it to.
--
-- `action_token` (0012) is the nearest relative and the model for most of what
-- follows, with ONE structural difference that drives the rest: an approve-link
-- click resolves a tenant and then switches into it, so `action_token`'s hatch
-- can be `FOR SELECT` only and every write still needs a real `app.current_org`.
-- A signup has NO tenant to switch into — creating one is the whole point — so
-- the hatch here has to permit writes. That is a genuinely weaker position, and
-- the narrowing below is what pays for it.
--
-- ── THE POLICIES, AND WHAT EACH ONE REFUSES ─────────────────────────────────
--
-- NO tenant_isolation policy AT ALL, which is deliberate and stronger than one:
-- a signup row is platform data, so no tenant should ever see one, not even its
-- own. With no tenant policy, `app.current_org` matches nothing here — a stray
-- `SELECT * FROM signup` from anywhere in the tenant request path returns zero
-- rows. (The CI RLS-coverage guard asks for ENABLE + FORCE on any table carrying
-- `organization_id`, which this satisfies; what the guard cannot express is that
-- invisibility is the intent rather than an omission. Hence this paragraph.)
--
-- `app.signup_task` is its OWN gate, not `app.platform_task`. Reusing that one
-- would have widened an existing hatch — the poller and the approve-link handler
-- both set it — from "two tables, read-only" to "and it can also write signups".
-- A flag that does one thing is a flag whose blast radius can be read off its
-- name.
--
--   · signup_read_live — FOR SELECT under `app.signup_task`, and only rows that
--     are UNCONSUMED and UNEXPIRED. This is 0012's lesson repeated because it was
--     right: "unknown", "already used" and "expired" become ONE case, a row that
--     is not there, so the check cannot be forgotten, reordered, or defeated by a
--     clock the application reads instead of the database.
--   · signup_insert / signup_resend — FOR INSERT and FOR UPDATE under the same
--     gate. The resend policy's WITH CHECK also says `consumed_at IS NULL`, so
--     it can refresh a pending signup and can never consume one.
--   · signup_consume_read / signup_consume — FOR SELECT and FOR UPDATE under a
--     SECOND gate, `app.signup_consume`. See below; this is not tidiness.
--
-- ── WHY CONSUMPTION NEEDED ITS OWN GATE: POSTGRES WILL NOT LET AN UPDATE ────
-- ── MOVE A ROW OUT OF VIEW ──────────────────────────────────────────────────
--
-- The first version of this migration had one gate and no `signup_consume_read`,
-- and consumption was IMPOSSIBLE. Setting `consumed_at` makes the row stop
-- matching `signup_read_live`, and Postgres refuses an UPDATE whose new row is
-- not visible under the table's SELECT policies — the same rule a view's WITH
-- CHECK OPTION enforces. The statement fails with "new row violates row-level
-- security policy", which names the wrong half of the problem: the WITH CHECK
-- was satisfied; it was the SELECT policy applied to the NEW row that was not.
--
-- Found by running it, not by reading about it, and it is worth recording because
-- the narrowing that makes a token lookup safe is the SAME narrowing that makes
-- consuming the token impossible.
--
-- `action_token` (0012) does not have this problem and the reason is the
-- structural difference already named above: its hatch is FOR SELECT only, and
-- consumption happens under `tenant_isolation`, which does not narrow on
-- `consumed_at`. There was no tenant policy to fall back on here.
--
-- So there are two gates, each doing one thing:
--   `app.signup_task`    — find a live signup by token. Sees NOTHING else.
--   `app.signup_consume` — set consumed_at. Sees the row it is about to write,
--                          which is what makes the write legal.
-- Neither is a master key, both are transaction-local, and the second is set for
-- exactly one statement in `markConsumed`.
--
-- ── ONE LIVE SIGNUP PER ADDRESS, AS A CONSTRAINT RATHER THAN A COUNTER ──────
--
-- Open self-serve means a POST endpoint anybody can call. The obvious defence is
-- a rate limiter counting recent rows per address; the better one is a partial
-- UNIQUE index that makes a second live signup for the same address impossible
-- to write. "Ask again" then becomes what it should have been anyway — a RESEND
-- that replaces the token on the existing row — rather than another row.
--
-- Note what it does NOT limit, so nobody reads more into it than it says: this
-- constrains one address, not one sender. Somebody with a thousand addresses is
-- unaffected, and that is a job for the edge (a WAF, a per-IP budget) rather
-- than for a UNIQUE index pretending to be one.

CREATE TABLE signup (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email             text NOT NULL,
    organization_name text NOT NULL,
    -- What they asked for. NOT a reservation: the slug is decided at
    -- verification by `organization`'s UNIQUE constraint, so an unverified
    -- address cannot squat a name. First to verify wins, and the loser is told.
    slug              text NOT NULL,
    -- ONLY THE HASH, as 0012: the raw value exists in exactly one place, a link
    -- in somebody's mailbox, so a database leak yields nothing usable.
    token_hash        text NOT NULL,
    expires_at        timestamptz NOT NULL,
    consumed_at       timestamptz,
    -- Which tenant this became, once it did. Nullable because most rows never
    -- become one. It is why this table carries `organization_id` at all, and it
    -- is NOT a tenancy column — see the policy note above.
    organization_id   uuid REFERENCES organization(id),
    created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT signup_token_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    -- A consumed signup names its organization; an unconsumed one cannot.
    CONSTRAINT signup_consumed_has_org
        CHECK ((consumed_at IS NULL) = (organization_id IS NULL))
);

-- Globally unique, like `action_token_hash_idx` and for the same reason: the
-- lookup happens before any tenant is known, so an ambiguous hash would be
-- ambiguous at exactly the moment there is nothing to disambiguate it with.
CREATE UNIQUE INDEX signup_token_hash_idx ON signup (token_hash);

-- At most one LIVE signup per address. `lower(email)` because an address is not
-- case-sensitive to the person typing it, and two rows differing only in case
-- would defeat the whole constraint.
CREATE UNIQUE INDEX signup_one_live_per_email_idx
    ON signup (lower(email))
    WHERE consumed_at IS NULL;

CREATE INDEX signup_org_id_idx ON signup (organization_id);

ALTER TABLE signup ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup FORCE  ROW LEVEL SECURITY;

CREATE POLICY signup_read_live ON signup
    FOR SELECT
    USING (NULLIF(current_setting('app.signup_task', true), '') = 'on'
           AND consumed_at IS NULL
           AND expires_at > clock_timestamp());

CREATE POLICY signup_insert ON signup
    FOR INSERT
    WITH CHECK (NULLIF(current_setting('app.signup_task', true), '') = 'on');

-- RESEND. Asking again refreshes the token on the existing row (see the header),
-- which is an UPDATE — and under `app.signup_task` there was no UPDATE policy at
-- all, so the first working version of the consume gate still left resend
-- failing with "new row violates row-level security policy (USING expression)".
--
-- Narrowed twice, and the WITH CHECK is the important one: `consumed_at IS NULL`
-- on BOTH sides means this policy can revive an unconsumed signup (including an
-- expired one — a resend after lunch should work) and can NEVER be used to
-- consume one. Consumption has its own gate below, and only that gate can set
-- `consumed_at`.
CREATE POLICY signup_resend ON signup
    FOR UPDATE
    USING (NULLIF(current_setting('app.signup_task', true), '') = 'on'
           AND consumed_at IS NULL)
    WITH CHECK (NULLIF(current_setting('app.signup_task', true), '') = 'on'
                AND consumed_at IS NULL);

-- The consumption gate. Its SELECT policy exists so the UPDATE below has a
-- visible NEW row — see the header. It is set for one statement, in one function.
CREATE POLICY signup_consume_read ON signup
    FOR SELECT
    USING (NULLIF(current_setting('app.signup_consume', true), '') = 'on');

CREATE POLICY signup_consume ON signup
    FOR UPDATE
    -- The OLD row must still be live: a second click cannot consume what the
    -- first one took, at the policy level, before the statement's WHERE is even
    -- considered. The application uses the conditional-write idiom as well —
    -- two independent guards on a credential is the right number.
    USING (NULLIF(current_setting('app.signup_consume', true), '') = 'on'
           AND consumed_at IS NULL
           AND expires_at > clock_timestamp())
    WITH CHECK (NULLIF(current_setting('app.signup_consume', true), '') = 'on');
