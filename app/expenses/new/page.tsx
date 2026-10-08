/**
 * VX1-6 — /expenses/new. One plain form posting a server action, which creates
 * the DRAFT (assigning its EXP-###### number) and redirects into the editor.
 * Currency and business-unit choices come from the tenant's own data.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createReportFromForm, getWorkbenchOptions } from '../actions';
import { ErrorBanner, cardClass, fieldClass, labelClass } from '../ui';

import { pageTitle } from '@/lib/i18n/page-title';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { BackLink, PageHeader, Screen } from '@/components/screen';
import { activeChoices } from '@/lib/employees/active-choices';

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
    <Screen width="narrow">
      <div className="flex flex-col gap-2">
        <BackLink href="/expenses">Back to reports</BackLink>
        <PageHeader title="New expense report" />
      </div>

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
          <Textarea
            id="purpose"
            name="purpose"
            placeholder="What was this trip or spend for?"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className={fieldClass}>
            <label className={labelClass} htmlFor="currencyCode">
              Currency
            </label>
            <NativeSelect
              id="currencyCode"
              name="currencyCode"
              required
              defaultValue={defaultCurrency}
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className={fieldClass}>
            <label className={labelClass} htmlFor="businessUnitId">
              Business unit
            </label>
            <NativeSelect id="businessUnitId" name="businessUnitId" defaultValue="">
              <option value="">— none —</option>
              {/* A new report may only name an active unit. */}
              {activeChoices(businessUnits).map((bu) => (
                <option key={bu.id} value={bu.id}>
                  {bu.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>

        <div>
          <Button type="submit">Create draft</Button>
        </div>
      </form>
    </Screen>
  );
}
