-- Wave 0: ExpenseOS's expense categories, ported end to end. This brings
-- `expense_category` to ExpenseOS's `ExpenseCategory` model so its router and
-- screen run unchanged (prisma/schema.prisma maps the names).
--
-- 1. THE NAME IS PER LANGUAGE (decided 7 Oct): `label` becomes ExpenseOS's
--    `{ "en": …, "fr-CA": … }` JSON. Every existing row keeps its text as the
--    English name. VeloExpense is English-only for now, so readers take
--    `label->>'en'`; turning French on later needs no second migration.
--    The CHECK keeps the one guarantee the old NOT NULL text gave: every
--    category has an English name.
ALTER TABLE expense_category
  ALTER COLUMN label TYPE jsonb USING jsonb_build_object('en', label);
--    COALESCE because a CHECK that evaluates to NULL passes: without it a name
--    with no `en` key at all (`label -> 'en'` is NULL) would be accepted.
ALTER TABLE expense_category
  ADD CONSTRAINT expense_category_label_en CHECK (
    COALESCE(
      jsonb_typeof(label) = 'object'
      AND jsonb_typeof(label -> 'en') = 'string'
      AND length(btrim(label ->> 'en')) > 0,
      false
    )
  );

-- 2. THE CODE IS OPTIONAL TO THE CALLER, as in ExpenseOS: a category an admin
--    creates by hand has none, and ExpenseOS's `create` sends none. But VeloExpense
--    gives every category a code — the ledger contract carries it
--    (lib/integrations/contract.ts `categoryCode: string`) and a compliance finding
--    names it — so instead of letting it go NULL, the table mints one: `c-` and the
--    first 8 hex digits of the row's id. Opaque, stable, unique in practice, and
--    the existing UNIQUE (organization_id, code) still refuses the astronomically
--    unlikely collision rather than storing it.
CREATE FUNCTION expense_category_default_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS NULL OR btrim(NEW.code) = '' THEN
    NEW.code := 'c-' || left(replace(NEW.id::text, '-', ''), 8);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expense_category_default_code
  BEFORE INSERT ON expense_category
  FOR EACH ROW EXECUTE FUNCTION expense_category_default_code();

-- 3. ExpenseOS's per-category fields, with ExpenseOS's defaults. Existing rows
--    get the defaults (100% recoverable, nothing required); setting the real
--    values for the starter set is Wave 1 ("all tax and behaviour flags").
ALTER TABLE expense_category
  ADD COLUMN icon               text,
  ADD COLUMN color              text,
  ADD COLUMN itc_gst_hst_rate   integer NOT NULL DEFAULT 100,
  ADD COLUMN itc_qst_rate       integer NOT NULL DEFAULT 100,
  ADD COLUMN pst_recoverable    boolean NOT NULL DEFAULT false,
  ADD COLUMN requires_attendees boolean NOT NULL DEFAULT false,
  ADD COLUMN is_mileage         boolean NOT NULL DEFAULT false,
  ADD COLUMN accepts_tip        boolean NOT NULL DEFAULT false;

-- What ExpenseOS's router validates, held by the table too, so a write that does
-- not come through the router cannot store what the screen could not show.
ALTER TABLE expense_category
  ADD CONSTRAINT expense_category_color_hex CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT expense_category_icon_len CHECK (icon IS NULL OR length(icon) <= 16),
  ADD CONSTRAINT expense_category_itc_gst_hst_rate CHECK (itc_gst_hst_rate BETWEEN 0 AND 100),
  ADD CONSTRAINT expense_category_itc_qst_rate CHECK (itc_qst_rate BETWEEN 0 AND 100),
  -- A mileage amount is DERIVED (distance × rate), so there is no typed figure
  -- for a tip to sit beside. ExpenseOS's `kind` makes the pair unreachable; the
  -- table refuses it outright.
  ADD CONSTRAINT expense_category_mileage_no_tip CHECK (NOT (is_mileage AND accepts_tip));
