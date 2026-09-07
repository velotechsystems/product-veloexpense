/**
 * VX3-1 — /admin/chart-of-accounts. The tenant's chart, and what each category
 * posts to.
 *
 * Server component posting plain `<form action={serverAction}>`, no client JS.
 * Row forms live after each table because a `<form>` may not be a child of a
 * `<tr>`; the inputs point at them with the HTML `form` attribute.
 *
 * ── What this screen is careful about ───────────────────────────────────────
 *
 * A ROLLUP IS NOT SELECTABLE, and it is shown anyway. The tree is what makes a
 * chart of accounts readable — "Travel" under "Travel Meals and Entertainment"
 * under "Operating Expenses" — so the headings are listed, indented, and marked
 * as headings rather than hidden. What they are not is offered in the mapping
 * select, because nothing may post to one (VeloLedger `0028`: a line hit the
 * rollup and vanished from the income statement).
 *
 * DEACTIVATE IS THE DEFAULT REMOVAL. "Delete" appears only for an account nothing
 * has ever used, because a line's `gl_account_id` is a SNAPSHOT of what it was
 * coded to (GAP-AUDIT AC-10) and a snapshot that can vanish is not one. The usage
 * counts are on the row so the choice is visible rather than discovered by being
 * refused.
 *
 * AN UNMAPPED CATEGORY IS A WARNING, NOT AN ERROR. It does not stop anybody
 * filing an expense — "a category with no account is a configuration gap, and the
 * employee filing the expense is not who fixes it" — but it is the thing this
 * screen exists to let somebody fix, so it is counted at the top.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyRow, ErrorBanner, selectClass } from '@/app/expenses/ui';
import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.chart.of.accounts');
}

import {
  createAccountFromForm,
  getChartPage,
  pullFromLedgerForm,
  importCsvFromForm,
  instantiateTemplateFromForm,
  removeAccountFromForm,
  renameAccountFromForm,
  setAccountActiveFromForm,
  setCategoryAccountFromForm,
} from './actions';

export const dynamic = 'force-dynamic';

type Page = Awaited<ReturnType<typeof getChartPage>>;

/** Depth by walking parent_id, so the indent reflects the tree and not the number. */
function depths(accounts: Page['accounts']): Map<string, number> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map<string, number>();
  for (const a of accounts) {
    let depth = 0;
    let cursor = a.parent_id;
    // Bounded: a cycle is impossible through the FK, but a bound costs nothing
    // and a runaway render is worse than a wrong indent.
    while (cursor && depth < 10) {
      depth += 1;
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
    out.set(a.id, depth);
  }
  return out;
}

export default async function ChartOfAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string; pulled?: string }>;
}) {
  const { error, created, pulled } = await searchParams;
  const { accounts, postable, mappings, templates, canPull, pullProblem, orphaned, moduleEnabled } =
    await getChartPage();
  const indent = depths(accounts);
  const unmapped = mappings.filter((m) => m.gl_account_id === null).length;
  const dangling = mappings.filter((m) => m.dangling).length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Chart of accounts</h1>
        <p className="text-sm text-muted-foreground">
          {accounts.length === 0
            ? 'No accounts yet — choose a starter chart or import your own'
            : `${accounts.length} accounts · ${postable.length} can be posted to · ` +
              `${unmapped === 0 ? 'every category is mapped' : `${unmapped} category/categories unmapped`}`}
        </p>
      </header>

      {!moduleEnabled ? (
        // VX4-1. Same reason as the integrations screen: the reads here are
        // ungated so the page can render, so an off module is indistinguishable
        // from an empty chart unless the page says which it is.
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <strong className="font-medium">
            Accounting integrations are not enabled for this organization.
          </strong>{' '}
          The chart below is empty and read-only while the module is off: its accounts
          are hidden rather than deleted (migration <code>0022</code>), and nothing can
          be added, imported, pulled or mapped. An administrator can turn it on under{' '}
          <Link href="/admin/modules" className="underline underline-offset-4">
            Modules
          </Link>
          .
        </div>
      ) : null}

      <ErrorBanner message={error} />
      {created ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          Added {created} accounts.
        </p>
      ) : null}
      {pulled ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          Pulled from the ledger — {pulled}.
        </p>
      ) : null}
      {orphaned.length > 0 ? (
        // Said rather than done. ExpenseOS deactivates these from a background
        // job; a tenant whose ledger stops reporting an account it has been coding
        // to for a year should be told (AC-12).
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <strong className="font-medium">
            The ledger no longer reports {orphaned.length} account(s): {orphaned.join(', ')}.
          </strong>{' '}
          They are still active here and still usable, because deactivating them would unmap
          categories nobody asked to change. Deactivate them yourself if the ledger is right.
        </div>
      ) : null}
      {dangling > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <strong className="font-medium">
            {dangling} category mapping(s) point at an account that cannot be read.
          </strong>{' '}
          That should not be possible now — the foreign key is scoped to this organization — so this
          is data written before that constraint existed. Re-map them below.
        </div>
      ) : null}

      {/* ── Empty state: pick a starter chart, or bring your own ───────────── */}
      {accounts.length > 0 ? null : (
        <section className="flex flex-col gap-4">
          <div className="rounded-lg border border-border p-4">
            <h2 className="text-lg font-medium">Start from a template</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A starter chart you can rename, extend and deactivate from. You can only do this
              while the chart is empty.
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              {templates.map((t) => (
                <li
                  key={t.key}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="max-w-2xl">
                    <p className="font-medium">
                      {t.name}{' '}
                      <span className="text-sm font-normal text-muted-foreground">
                        · {t.account_count} accounts
                        {t.jurisdiction ? ` · ${t.jurisdiction}` : ''}
                      </span>
                    </p>
                    <p className="text-sm text-muted-foreground">{t.description}</p>
                  </div>
                  <form action={instantiateTemplateFromForm}>
                    <input type="hidden" name="templateKey" value={t.key} />
                    <Button type="submit" size="sm">
                      Use this chart
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          </div>

          <form
            action={importCsvFromForm}
            className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-4"
          >
            <div>
              <h2 className="text-lg font-medium">Or import a CSV</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Columns: <code>number, name, type</code> required;{' '}
                <code>sub_type, parent_number, sort_order, notes</code> optional.{' '}
                <code>type</code> is one of asset, liability, equity, revenue, expense. A parent
                must appear in the same file as its children. Nothing is imported unless every row
                is valid.
              </p>
            </div>
            <input
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              className="text-sm"
              aria-label="Chart of accounts CSV"
            />
            <Button type="submit" size="sm" variant="outline">
              Import
            </Button>
          </form>
        </section>
      )}

      {/* ── The chart ───────────────────────────────────────────────────────── */}
      {accounts.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium">Accounts</h2>
            {canPull ? (
              <form action={pullFromLedgerForm}>
                <Button type="submit" size="sm" variant="outline">
                  Pull from the ledger
                </Button>
              </form>
            ) : null}
            {pullProblem ? (
              // AC-22. The button is gone because a pull cannot choose between two
              // ledgers — which is worth a sentence, since "the button vanished"
              // is indistinguishable from "this build cannot pull".
              <p className="text-xs text-destructive">{pullProblem}</p>
            ) : null}
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Number</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Used by</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const formId = `acct-${a.id}`;
                  const unused = a.line_count === 0 && a.category_count === 0;
                  return (
                    <tr
                      key={a.id}
                      className={`border-t border-border align-middle ${
                        a.active ? '' : 'text-muted-foreground'
                      }`}
                    >
                      <td className="px-3 py-2 tabular-nums">{a.number}</td>
                      <td className="px-3 py-2" style={{ paddingLeft: 12 + (indent.get(a.id) ?? 0) * 18 }}>
                        {a.is_postable ? (
                          <Input
                            form={formId}
                            name="name"
                            defaultValue={a.name}
                            className="w-72"
                            aria-label={`Name of account ${a.number}`}
                          />
                        ) : (
                          // A heading, said out loud. Rendering it as an editable
                          // row alongside postable accounts is what invites someone
                          // to map a category to it.
                          <span className="font-medium">
                            {a.name}{' '}
                            <span className="text-xs font-normal text-muted-foreground">
                              · heading, nothing posts here
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {a.type}
                        {a.sub_type ? ` · ${a.sub_type}` : ''}
                        {a.active ? '' : ' · inactive'}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {unused
                          ? 'nothing yet'
                          : `${a.category_count} category/categories, ${a.line_count} line(s)`}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {a.is_postable ? (
                            <Button form={formId} type="submit" size="sm" variant="outline">
                              Save
                            </Button>
                          ) : null}
                          <Button
                            form={`active-${a.id}`}
                            type="submit"
                            size="sm"
                            variant="outline"
                          >
                            {a.active ? 'Deactivate' : 'Reactivate'}
                          </Button>
                          {unused ? (
                            <Button form={`del-${a.id}`} type="submit" size="sm" variant="outline">
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Row forms, outside the table, referenced by `form=` above. */}
          {accounts.map((a) => (
            <div key={a.id} className="hidden">
              <form id={`acct-${a.id}`} action={renameAccountFromForm}>
                <input type="hidden" name="id" value={a.id} />
              </form>
              <form id={`active-${a.id}`} action={setAccountActiveFromForm}>
                <input type="hidden" name="id" value={a.id} />
                <input type="hidden" name="active" value={a.active ? 'false' : 'true'} />
              </form>
              <form id={`del-${a.id}`} action={removeAccountFromForm}>
                <input type="hidden" name="id" value={a.id} />
              </form>
            </div>
          ))}

          <form
            action={createAccountFromForm}
            className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-4"
          >
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="new-number">
                Number
              </label>
              <Input id="new-number" name="number" required className="w-28" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="new-name">
                Name
              </label>
              <Input id="new-name" name="name" required className="w-64" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="new-type">
                Type
              </label>
              <select id="new-type" name="type" className={selectClass} defaultValue="expense">
                <option value="expense">expense</option>
                <option value="asset">asset</option>
                <option value="liability">liability</option>
                <option value="equity">equity</option>
                <option value="revenue">revenue</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="new-parent">
                Under
              </label>
              <select id="new-parent" name="parentNumber" className={selectClass} defaultValue="">
                <option value="">(top level)</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.number}>
                    {a.number} — {a.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" size="sm">
              Add account
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              Adding an account under another one makes that one a heading, and nothing can post to
              a heading. If a category or an expense line is already coded to it, this is refused
              rather than silently re-coded.
            </p>
          </form>
        </section>
      )}

      {/* ── Category mapping ────────────────────────────────────────────────── */}
      {accounts.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">What each category posts to</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            An expense line takes its account from its category when the line is written, and keeps
            it afterwards. Changing a mapping here affects new lines, not ones already filed — which
            is deliberate: a report posts to the account it was coded to at the time, not to
            wherever its category points months later.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {mappings.length === 0 ? (
                  <EmptyRow colSpan={3}>This tenant has no expense categories yet.</EmptyRow>
                ) : (
                  mappings.map((m) => {
                    const formId = `map-${m.id}`;
                    return (
                      <tr key={m.id} className="border-t border-border align-middle">
                        <td className="px-3 py-2">
                          {m.label}
                          <span className="ml-2 text-xs text-muted-foreground">{m.code}</span>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            form={formId}
                            name="accountId"
                            className={selectClass}
                            defaultValue={m.dangling ? '' : (m.gl_account_id ?? '')}
                            aria-label={`Account for ${m.label}`}
                          >
                            <option value="">(not mapped)</option>
                            {postable.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.number} — {a.name}
                              </option>
                            ))}
                          </select>
                          {m.gl_account_id === null ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Expenses in this category can still be filed; they will have no
                              account until this is set.
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <Button form={formId} type="submit" size="sm" variant="outline">
                            Save
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {mappings.map((m) => (
            <form
              key={m.id}
              id={`map-${m.id}`}
              action={setCategoryAccountFromForm}
              className="hidden"
            >
              <input type="hidden" name="categoryId" value={m.id} />
            </form>
          ))}
        </section>
      )}
    </div>
  );
}
