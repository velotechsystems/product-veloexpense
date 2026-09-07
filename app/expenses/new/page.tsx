/**
 * VX1-6 — /expenses/new. One plain form posting a server action, which creates
 * the DRAFT (assigning its EXP-###### number) and redirects into the editor.
 * Currency and business-unit choices come from the tenant's own data.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createReportFromForm, getWorkbenchOptions } from '../actions';
import { ErrorBanner, cardClass, fieldClass, labelClass, selectClass, textareaClass } from '../ui';

import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.expenses.new');
}

export const dynamic = 'force-dynamic';

export default async function NewReportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const { currencies, businessUnits } = await getWorkbenchOptions();
  const defaultCurrency = currencies.find((c) => c.code === 'CAD')?.code ?? currencies[0]?.code;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <Link className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/expenses">
          ← Back to reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New expense report</h1>
      </header>

      <ErrorBanner message={sp.error} />

      <form action={createReportFromForm} className={`${cardClass} flex flex-col gap-5 p-5`}>
        <div className={fieldClass}>
          <label className={labelClass} htmlFor="title">
            Title
          </label>
          <Input id="title" name="title" required placeholder="Client visit — Toronto" />
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="purpose">
            Business purpose
          </label>
          <textarea
            id="purpose"
            name="purpose"
            className={textareaClass}
            placeholder="What was this trip or spend for?"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className={fieldClass}>
            <label className={labelClass} htmlFor="currencyCode">
              Currency
            </label>
            <select
              id="currencyCode"
              name="currencyCode"
              required
              className={selectClass}
              defaultValue={defaultCurrency}
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="businessUnitId">
              Business unit
            </label>
            <select id="businessUnitId" name="businessUnitId" className={selectClass} defaultValue="">
              <option value="">— none —</option>
              {businessUnits.map((bu) => (
                <option key={bu.id} value={bu.id}>
                  {bu.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <Button type="submit">Create draft</Button>
        </div>
      </form>
    </div>
  );
}
