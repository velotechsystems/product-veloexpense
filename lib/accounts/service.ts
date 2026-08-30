/**
 * VX3-1 — the tenant's chart of accounts: instantiate a template, list, edit,
 * import, and map a category to an account.
 *
 * The pure half is `lib/accounts/{csv,validate}.ts`; this file is the part that
 * touches the database. Findings: GAP-AUDIT AC-9, AC-10, AC-14, TN-1.
 *
 * ── Three properties this file is responsible for ───────────────────────────
 *
 * 1. AN ACCOUNT IS NEVER DELETED WHEN IT HAS BEEN USED. `deactivate` sets
 *    `active = false` and that is the only removal a screen offers. VeloLedger's
 *    cache comment has the reason — soft-delete "so historical mappings keep
 *    resolving" — and here it is stronger than that: a line's `gl_account_id` is
 *    a SNAPSHOT (AC-10), and a snapshot that can vanish is not one. `remove`
 *    exists for the genuinely-unused case and refuses anything else.
 * 2. INSTANTIATION IS TWO PASSES AND ONE TRANSACTION. Accounts are inserted
 *    parentless, then `parent_id` is resolved by number. A template is a tree and
 *    a tree cannot be inserted in one pass without ordering the rows, which would
 *    make the template's `sort_order` load-bearing for correctness rather than
 *    for display.
 * 3. THE CALLER NEVER PASSES `is_postable`. It is derived from the structure —
 *    an account with children is a rollup — for the reason in `validate.ts`:
 *    VeloLedger had to backfill that flag in `0028` after a manual value drifted
 *    from the tree and a posted line vanished from the income statement.
 */
import type { QueryRunner } from '@/lib/db/client';
import { parseCsv } from '@/lib/accounts/csv';
import { validateCoaCsv, type ValidatedAccount, type ValidationError } from '@/lib/accounts/validate';

const ORG = "current_setting('app.current_org', true)::uuid";

export type AccountSource = 'TEMPLATE' | 'IMPORT' | 'MANUAL' | 'PULLED';

export interface GlAccountRow {
  id: string;
  number: string;
  name: string;
  type: string;
  sub_type: string | null;
  parent_id: string | null;
  parent_number: string | null;
  is_postable: boolean;
  active: boolean;
  source: AccountSource;
  external_id: string | null;
  /** How many expense lines carry this account as their snapshot. */
  line_count: number;
  /** How many categories map to it. */
  category_count: number;
}

export interface TemplateRow {
  key: string;
  name: string;
  description: string;
  jurisdiction: string | null;
  account_count: number;
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'ALREADY_POPULATED'
      | 'IN_USE'
      | 'NOT_POSTABLE'
      | 'DUPLICATE_NUMBER'
      | 'INVALID_CSV',
    /** Line-numbered CSV problems, when the code is INVALID_CSV. */
    readonly errors: ValidationError[] = [],
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

/** The selectable starter templates. Global reference data — no tenant predicate. */
export async function listTemplates(tx: QueryRunner): Promise<TemplateRow[]> {
  const r = await tx.query(
    `SELECT t.key, t.name, t.description, t.jurisdiction,
            count(a.id)::int AS account_count
       FROM coa_template t
       LEFT JOIN coa_template_account a ON a.template_key = t.key
      WHERE t.active
      GROUP BY t.key, t.name, t.description, t.jurisdiction
      ORDER BY t.name`,
  );
  return r.rows as TemplateRow[];
}

export async function listAccounts(
  tx: QueryRunner,
  opts: { includeInactive?: boolean } = {},
): Promise<GlAccountRow[]> {
  // Ordered by number, not by a sort column: an account number IS the ordering in
  // every chart of accounts anyone has ever read, and a separate sort_order on the
  // tenant table would be a second answer to a settled question.
  const r = await tx.query(
    `SELECT g.id, g.number, g.name, g.type, g.sub_type, g.parent_id,
            p.number AS parent_number,
            g.is_postable, g.active, g.source, g.external_id,
            (SELECT count(*) FROM expense_line_item l WHERE l.gl_account_id = g.id)::int
              AS line_count,
            (SELECT count(*) FROM expense_category c WHERE c.gl_account_id = g.id)::int
              AS category_count
       FROM gl_account g
       LEFT JOIN gl_account p ON p.id = g.parent_id
      WHERE ($1::boolean OR g.active)
      ORDER BY g.number`,
    [opts.includeInactive ?? false],
  );
  return r.rows as GlAccountRow[];
}

/** The accounts a category or a line may actually be coded to. */
export async function listPostableAccounts(tx: QueryRunner): Promise<GlAccountRow[]> {
  const all = await listAccounts(tx);
  return all.filter((a) => a.is_postable);
}

/**
 * Populate a tenant's chart from a starter template.
 *
 * REFUSES a tenant that already has accounts. Instantiating twice would either
 * collide on `(organization_id, number)` halfway through or, worse, half-succeed
 * if somebody later "helpfully" added an ON CONFLICT — and a chart of accounts
 * that is half one template and half another is not a chart. Replacing a
 * populated chart is a different operation with different consequences (every
 * category mapping), and it does not exist yet on purpose.
 */
export async function instantiateTemplate(
  tx: QueryRunner,
  templateKey: string,
): Promise<{ created: number }> {
  const existing = await tx.query('SELECT count(*)::int AS n FROM gl_account');
  if ((existing.rows[0] as { n: number }).n > 0) {
    throw new AccountError(
      'this tenant already has a chart of accounts; import or add accounts instead',
      'ALREADY_POPULATED',
    );
  }
  const template = await tx.query('SELECT key FROM coa_template WHERE key = $1 AND active', [
    templateKey,
  ]);
  if (template.rows.length === 0) {
    throw new AccountError(`no such template: ${templateKey}`, 'NOT_FOUND');
  }

  // Pass 1 — every account, parentless.
  const inserted = await tx.query(
    `INSERT INTO gl_account
         (organization_id, number, name, type, sub_type, is_postable, source, source_template)
     SELECT ${ORG}, a.number, a.name, a.type, a.sub_type, a.is_postable, 'TEMPLATE', a.template_key
       FROM coa_template_account a
      WHERE a.template_key = $1
     RETURNING id`,
    [templateKey],
  );

  // Pass 2 — resolve parents by number, within this tenant.
  await tx.query(
    // An UPDATE's target table cannot be referenced from a JOIN condition inside
    // FROM — `FROM a JOIN gl_account p ON p.organization_id = g.organization_id`
    // fails with "invalid reference to FROM-clause entry for table g". So: a
    // comma-join with every predicate in WHERE. Found by running it.
    `UPDATE gl_account g
        SET parent_id = p.id
       FROM coa_template_account a, gl_account p
      WHERE a.template_key = $1
        AND g.number = a.number
        AND a.parent_number IS NOT NULL
        AND p.number = a.parent_number
        AND p.organization_id = g.organization_id`,
    [templateKey],
  );
  return { created: inserted.rows.length };
}

/**
 * Import a chart from CSV. All-or-nothing, by `validate.ts`'s contract.
 *
 * Ported from VeloLedger's `import-coa` CLI, minus its CSV hash: that exists
 * there to make a bootstrap re-runnable, and here an import into a populated
 * chart is refused outright, which is the stronger version of the same idea.
 */
export async function importFromCsv(
  tx: QueryRunner,
  content: string,
): Promise<{ created: number }> {
  let parsed;
  try {
    parsed = parseCsv(content);
  } catch (e) {
    throw new AccountError(
      e instanceof Error ? e.message : 'could not read that file as CSV',
      'INVALID_CSV',
    );
  }
  const validation = validateCoaCsv(parsed);
  if (!validation.ok) {
    throw new AccountError(
      `that file has ${validation.errors.length} problem(s) and none of it was imported`,
      'INVALID_CSV',
      validation.errors,
    );
  }
  const existing = await tx.query('SELECT count(*)::int AS n FROM gl_account');
  if ((existing.rows[0] as { n: number }).n > 0) {
    throw new AccountError(
      'this tenant already has a chart of accounts; add accounts individually instead',
      'ALREADY_POPULATED',
    );
  }
  return insertTree(tx, validation.accounts, 'IMPORT');
}

/** Two passes, one transaction — see property 2 in the header. */
async function insertTree(
  tx: QueryRunner,
  accounts: ValidatedAccount[],
  source: Extract<AccountSource, 'IMPORT' | 'MANUAL'>,
): Promise<{ created: number }> {
  for (const a of accounts) {
    await tx.query(
      `INSERT INTO gl_account
           (organization_id, number, name, type, sub_type, is_postable, source)
       VALUES (${ORG}, $1, $2, $3, $4, $5, $6)`,
      [a.number, a.name, a.type, a.subType, a.isPostable, source],
    );
  }
  for (const a of accounts) {
    if (!a.parentNumber) continue;
    await tx.query(
      `UPDATE gl_account SET parent_id = p.id
         FROM gl_account p
        WHERE gl_account.number = $1 AND p.number = $2
          AND p.organization_id = gl_account.organization_id`,
      [a.number, a.parentNumber],
    );
  }
  return { created: accounts.length };
}

/**
 * Add one account by hand.
 *
 * `is_postable` is not a parameter — see property 3. Adding a child to a leaf
 * turns that leaf into a rollup, and this is where that happens: the parent is
 * demoted in the same transaction, which is the moment VeloLedger's `0028`
 * backfill existed to repair after the fact.
 */
export async function createAccount(
  tx: QueryRunner,
  input: {
    number: string;
    name: string;
    type: string;
    subType?: string | null;
    parentNumber?: string | null;
  },
): Promise<{ id: string }> {
  const number = input.number.trim();
  const name = input.name.trim();
  if (!number || !name) {
    throw new AccountError('an account needs a number and a name', 'NOT_FOUND');
  }

  let parentId: string | null = null;
  if (input.parentNumber) {
    const parent = await tx.query('SELECT id FROM gl_account WHERE number = $1', [
      input.parentNumber,
    ]);
    if (parent.rows.length === 0) {
      throw new AccountError(`no account numbered ${input.parentNumber} to be the parent`, 'NOT_FOUND');
    }
    parentId = (parent.rows[0] as { id: string }).id;
  }

  const dup = await tx.query('SELECT id FROM gl_account WHERE number = $1', [number]);
  if (dup.rows.length > 0) {
    throw new AccountError(`account ${number} already exists`, 'DUPLICATE_NUMBER');
  }

  const r = await tx.query(
    `INSERT INTO gl_account (organization_id, number, name, type, sub_type, parent_id, source)
     VALUES (${ORG}, $1, $2, $3, $4, $5, 'MANUAL')
     RETURNING id`,
    [number, name, input.type, input.subType ?? null, parentId],
  );

  if (parentId) {
    // The parent now has a child, so it is a rollup. If a category or a line is
    // already coded to it, refuse the whole thing rather than orphaning that
    // coding — the admin needs to re-code first, and saying so is better than
    // quietly making an existing mapping unpostable.
    const used = await tx.query(
      `SELECT (SELECT count(*) FROM expense_category c WHERE c.gl_account_id = $1)::int AS cats,
              (SELECT count(*) FROM expense_line_item l WHERE l.gl_account_id = $1)::int AS lines`,
      [parentId],
    );
    const { cats, lines } = used.rows[0] as { cats: number; lines: number };
    if (cats > 0 || lines > 0) {
      throw new AccountError(
        `${input.parentNumber} is coded to by ${cats} category/categories and ${lines} expense ` +
          `line(s). Adding a child under it would make it a rollup, which nothing may post to — ` +
          `re-code those to a leaf account first.`,
        'IN_USE',
      );
    }
    await tx.query('UPDATE gl_account SET is_postable = false, updated_at = clock_timestamp() WHERE id = $1', [
      parentId,
    ]);
  }
  return r.rows[0] as { id: string };
}

export async function renameAccount(
  tx: QueryRunner,
  id: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new AccountError('an account needs a name', 'NOT_FOUND');
  const r = await tx.query(
    'UPDATE gl_account SET name = $2, updated_at = clock_timestamp() WHERE id = $1',
    [id, trimmed],
  );
  if (r.rowCount !== 1) throw new AccountError('no such account', 'NOT_FOUND');
}

/**
 * Deactivate. The only removal a screen should offer.
 *
 * Existing snapshots and mappings are left alone: a line keeps the account it was
 * coded to (AC-10), and a category keeps a mapping an admin can see and change.
 * What deactivating does is stop it being CHOSEN again — the migration's trigger
 * refuses a new coding to an inactive account.
 */
export async function deactivateAccount(tx: QueryRunner, id: string): Promise<void> {
  const r = await tx.query(
    'UPDATE gl_account SET active = false, updated_at = clock_timestamp() WHERE id = $1',
    [id],
  );
  if (r.rowCount !== 1) throw new AccountError('no such account', 'NOT_FOUND');
}

export async function reactivateAccount(tx: QueryRunner, id: string): Promise<void> {
  const r = await tx.query(
    'UPDATE gl_account SET active = true, updated_at = clock_timestamp() WHERE id = $1',
    [id],
  );
  if (r.rowCount !== 1) throw new AccountError('no such account', 'NOT_FOUND');
}

/** Hard delete, for an account nothing has ever used. Refuses everything else. */
export async function removeAccount(tx: QueryRunner, id: string): Promise<void> {
  const used = await tx.query(
    `SELECT (SELECT count(*) FROM expense_category c WHERE c.gl_account_id = $1)::int AS cats,
            (SELECT count(*) FROM expense_line_item l WHERE l.gl_account_id = $1)::int AS lines,
            (SELECT count(*) FROM gl_account g WHERE g.parent_id = $1)::int AS children`,
    [id],
  );
  const { cats, lines, children } = used.rows[0] as {
    cats: number;
    lines: number;
    children: number;
  };
  if (cats > 0 || lines > 0 || children > 0) {
    throw new AccountError(
      `that account is in use (${cats} category/categories, ${lines} expense line(s), ` +
        `${children} child account(s)) — deactivate it instead, which keeps the history readable`,
      'IN_USE',
    );
  }
  const r = await tx.query('DELETE FROM gl_account WHERE id = $1', [id]);
  if (r.rowCount !== 1) throw new AccountError('no such account', 'NOT_FOUND');
}

export interface CategoryMappingRow {
  id: string;
  code: string;
  label: string;
  gl_account_id: string | null;
  gl_account_number: string | null;
  gl_account_name: string | null;
  /** True when a mapping exists but does not resolve — see the note below. */
  dangling: boolean;
}

/**
 * Categories with their account, for the mapping screen.
 *
 * `dangling` looks redundant and is not. TN-1: until VX3-10 lands, a plain FK
 * accepts another tenant's id, which leaves `gl_account_id IS NOT NULL` pointing
 * at a row RLS will not return — and AC-14's mapping-gap control, which looks for
 * NULL, reads that as correctly mapped. `0014`'s composite FK makes it impossible
 * on THIS column, so today this flag can only fire on data written before that
 * migration. It is worth one LEFT JOIN to be able to say that rather than assume.
 */
export async function listCategoryMappings(tx: QueryRunner): Promise<CategoryMappingRow[]> {
  const r = await tx.query(
    `SELECT c.id, c.code, c.label, c.gl_account_id,
            g.number AS gl_account_number, g.name AS gl_account_name,
            (c.gl_account_id IS NOT NULL AND g.id IS NULL) AS dangling
       FROM expense_category c
       LEFT JOIN gl_account g ON g.id = c.gl_account_id
      WHERE c.active
      ORDER BY c.sort_order, c.label`,
  );
  return r.rows as CategoryMappingRow[];
}

/**
 * Map a category to an account, or clear it with null.
 *
 * The rollup and inactive rules are NOT re-checked here. They are enforced by
 * `gl_account_must_be_postable()` in `0014`, which holds for every path including
 * the ones nobody has written yet — that is the whole argument for the trigger.
 * This function translates the two errors it can raise into something a screen
 * can show.
 */
export async function setCategoryAccount(
  tx: QueryRunner,
  categoryId: string,
  accountId: string | null,
): Promise<void> {
  try {
    const r = await tx.query(
      'UPDATE expense_category SET gl_account_id = $2, updated_at = clock_timestamp() WHERE id = $1',
      [categoryId, accountId],
    );
    if (r.rowCount !== 1) throw new AccountError('no such category', 'NOT_FOUND');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/is a rollup/.test(message) || /is inactive/.test(message)) {
      throw new AccountError(message.replace(/^[^:]*:\s*/, ''), 'NOT_POSTABLE');
    }
    throw e;
  }
}

/**
 * The account a line should be stamped with — AC-10's snapshot, resolved from the
 * category AT WRITE TIME.
 *
 * Returns null rather than throwing when the category has no account: "a category
 * with no account is a configuration gap, and the employee filing the expense is
 * not who fixes it." A rollup or inactive account cannot be returned here because
 * `setCategoryAccount` could not have stored one.
 */
export async function accountForCategory(
  tx: QueryRunner,
  categoryId: string,
): Promise<string | null> {
  const r = await tx.query(
    `SELECT g.id
       FROM expense_category c
       JOIN gl_account g ON g.id = c.gl_account_id
      WHERE c.id = $1 AND g.active AND g.is_postable`,
    [categoryId],
  );
  return r.rows.length === 0 ? null : (r.rows[0] as { id: string }).id;
}
