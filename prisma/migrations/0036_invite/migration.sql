-- VeloExpense 0036 — the invite, which is how anybody but the founder gets in (VX5-3).
--
-- ── THE DOOR THIS CLOSES ────────────────────────────────────────────────────
--
-- Until now, "invite-only" described the LOGIN page and nothing else. The
-- mechanism was `resolveSsoUser`: sign-in succeeds if an `app_user` row exists
-- for (org, verified email), and is refused otherwise. Which means the actual
-- grant of access was `INSERT INTO app_user` — and `createEmployee` did exactly
-- that, from an admin form, silently, with no email to the person and no record
-- that they had never arrived.
--
-- So the product had two doors and only one of them was visible. This ticket
-- makes the admin form write an INVITE instead of a person, and the `app_user`
-- row appears when the invitation is accepted. One door.
--
-- The consequence worth stating, because it is the reason for the whole shape:
-- **the employee directory now only ever contains people who have actually
-- arrived.** `app_user` is read by the manager picker, the reporting line, every
-- approval ladder and every count of who is in a tenant. A row for somebody who
-- was typed into a form once and never signed in is wrong in all of them.
--
-- ── WHAT ACTUALLY GRANTS ACCESS, AND WHY IT IS NOT THIS TOKEN ───────────────
--
-- The mailed link is a convenience. It carries the tenant (so nobody has to be
-- told to type a web address) and it is revocable and expiring. It is NOT what
-- makes somebody a member.
--
-- The grant is bound to the **OAuth-verified email**: `resolveSsoUser` provisions
-- from an invite only when Google or Microsoft has just asserted that the person
-- signing in holds the address the invite was sent to. A link forwarded to a
-- colleague, pasted in a chat, or lifted from a mailbox by somebody else is
-- therefore useless — they would have to control the invited mailbox as an SSO
-- identity, which is the same thing as being the invited person.
--
-- That is strictly stronger than `0035`'s signup token, and the difference is
-- worth naming: a signup link is the ONLY proof that exists, because there is no
-- tenant and no identity provider in the picture yet. An invite has both, so it
-- can lean on the stronger one.
--
-- ── ONE GATE, NOT TWO — AND WHY 0035's TRAP DOES NOT BITE HERE ─────────────
--
-- `0035` needed two GUCs because a signup has NO TENANT: its narrow policy was
-- the only way to see the row, and narrowing on `consumed_at` made the consuming
-- UPDATE impossible (Postgres refuses an UPDATE whose new row leaves the SELECT
-- policy's view).
--
-- An invite HAS a tenant, so it follows `action_token`'s (0012) shape instead:
-- one `FOR SELECT`, live-only hatch that answers ONE question — which tenant is
-- this token in — after which everything happens under `tenant_isolation`, which
-- does not narrow on `accepted_at`. The consuming UPDATE is therefore ordinary.
--
-- `app.invite_lookup` rather than reusing `app.platform_task`: that flag is set
-- by the delivery poller and the approve-link handler, both long-running
-- background paths. This one is set for a single statement inside a single
-- sign-in. Same shape, different lifetime, and a flag whose blast radius can be
-- read off its name is worth the four lines it costs.
--
-- ── WHY THE INVITE CARRIES THE WHOLE EMPLOYEE RECORD ────────────────────────
--
-- role, title, manager, department, business unit, legal entity. All of it, and
-- all of it nullable except `role`.
--
-- Because the admin filling in the form knows these things NOW and the person
-- accepting does not. The alternative — accept first, then have an admin come
-- back and fill in the reporting line — is how somebody ends up in an approval
-- ladder with no manager, which this product's own `approval_task` resolution
-- treats as an error rather than a blank.
--
-- Every one of them is a composite FK per `0019`/TN-1: referential integrity is
-- checked as the constraint's owner with RLS BYPASSED, so a plain
-- `REFERENCES app_user(id)` would accept another tenant's manager.

CREATE TABLE invite (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   uuid NOT NULL REFERENCES organization(id),
    email             text NOT NULL,
    -- ONLY THE HASH, as 0012 and 0035: the raw value exists in one place, a link
    -- in somebody's mailbox.
    token_hash        text NOT NULL,
    -- What the invitation GRANTS. Same vocabulary as `app_user.role` (0004) and
    -- checked the same way, so an invite cannot promise a role that cannot exist.
    role              text NOT NULL DEFAULT 'EMPLOYEE',
    display_name      text,
    title             text,
    manager_id        uuid,
    department_id     uuid,
    business_unit_id  uuid,
    legal_entity_id   uuid,
    invited_by_id     uuid NOT NULL,
    expires_at        timestamptz NOT NULL,
    accepted_at       timestamptz,
    revoked_at        timestamptz,
    -- Who this became. Null until accepted; see the CHECK below.
    accepted_user_id  uuid,
    created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT invite_token_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT invite_role_check CHECK (role IN ('EMPLOYEE', 'MANAGER', 'ADMIN')),
    -- An accepted invite names the user it became; an unaccepted one cannot.
    CONSTRAINT invite_accepted_has_user
        CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL)),
    -- And it cannot be both. Revoking a live invite and accepting one are the two
    -- ways it ends, and they are mutually exclusive by construction rather than
    -- by whichever code path happens to check first.
    CONSTRAINT invite_not_both_ends
        CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

-- Globally unique, as `action_token_hash_idx` and `signup_token_hash_idx`: the
-- lookup happens before any tenant is known, so an ambiguous hash would be
-- ambiguous at exactly the moment there is nothing to disambiguate it with.
CREATE UNIQUE INDEX invite_token_hash_idx ON invite (token_hash);

-- AT MOST ONE LIVE INVITE PER ADDRESS PER TENANT. `lower(email)` because
-- `app_user`'s own UNIQUE is case-sensitive and every check in application code
-- already works around that with `lower()`; two invites differing only in case
-- would defeat this the same way.
--
-- Asking again is therefore a RESEND — a new token on the existing row — rather
-- than a second invitation, which is `0035`'s lesson and holds for the same
-- reason: the person expects the newest link to work and the older one not to.
CREATE UNIQUE INDEX invite_one_live_per_email_idx
    ON invite (organization_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX invite_org_id_idx ON invite (organization_id);
CREATE INDEX invite_org_live_idx
    ON invite (organization_id, created_at DESC)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- TN-1 / 0019: composite, every one of them. A plain `REFERENCES app_user(id)`
-- is checked with RLS bypassed and would accept another tenant's row.
ALTER TABLE invite ADD CONSTRAINT invite_invited_by_id_fkey
    FOREIGN KEY (organization_id, invited_by_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE invite ADD CONSTRAINT invite_accepted_user_id_fkey
    FOREIGN KEY (organization_id, accepted_user_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE invite ADD CONSTRAINT invite_manager_id_fkey
    FOREIGN KEY (organization_id, manager_id)
    REFERENCES app_user (organization_id, id);
ALTER TABLE invite ADD CONSTRAINT invite_department_id_fkey
    FOREIGN KEY (organization_id, department_id)
    REFERENCES department (organization_id, id);
ALTER TABLE invite ADD CONSTRAINT invite_business_unit_id_fkey
    FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_unit (organization_id, id);
ALTER TABLE invite ADD CONSTRAINT invite_legal_entity_id_fkey
    FOREIGN KEY (organization_id, legal_entity_id)
    REFERENCES legal_entity (organization_id, id);

ALTER TABLE invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite FORCE  ROW LEVEL SECURITY;

-- The ordinary policy. Everything an admin does — issue, list, resend, revoke —
-- and the acceptance write itself happen under this one, inside a real tenant.
CREATE POLICY tenant_isolation ON invite
    USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- The hatch, and it answers ONE question: which tenant is this token in?
--
-- `action_token`'s `platform_read` with its rule repeated, because it is the
-- rule: THE CALLER MUST TAKE NOTHING FROM THIS BUT `organization_id`. Live rows
-- only, so an expired, revoked or already-accepted invite is a row that is not
-- there rather than a row somebody has to remember to check.
CREATE POLICY invite_lookup ON invite
    FOR SELECT
    USING (NULLIF(current_setting('app.invite_lookup', true), '') = 'on'
           AND accepted_at IS NULL
           AND revoked_at IS NULL
           AND expires_at > clock_timestamp());
