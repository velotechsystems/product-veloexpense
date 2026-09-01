/**
 * VX4-3 part 2 — A TENANT'S COLOUR, IN A BROWSER, WITH THE OTHER TENANT UNTOUCHED.
 *
 * ── What this proves that 51 vitest assertions cannot ──────────────────────
 *
 * `test/branding-color.test.ts` proves the maths and `test/branding.db.test.ts`
 * proves the store. Neither can show the two things that actually matter: that the
 * derived palette REACHES THE PAGE, and that setting it in one tenant leaves the
 * other alone. Three layers have to agree for that — the service, `brandCss`, and
 * a `<style>` in `<head>` that the layout renders per request — and this is the
 * only place they meet.
 *
 * It is also the only check on the ONE THING no unit test can see: the tab said
 * "Create Next App" until this ticket (BR-5/BR-9). A title is rendered HTML, so a
 * browser is what can read it.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 *
 * Alphabetically this lands SECOND, between `approval-flow` and `expense-flow`, so
 * everything after it inherits whatever it leaves behind — and a brand colour
 * changes the pixels in every later spec's failure screenshots. It therefore resets
 * the branding columns in `afterAll` AND in `beforeAll`: relying on a previous run
 * having exited cleanly is how `modules-flow` nearly coupled itself to file-name
 * order. (It needs nothing from `expense-flow`'s rule restoration, because it
 * submits no expenses — which is also why running before that file is safe.)
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

const RUN = Date.now().toString(36);
/** Teal. Deep enough to take white text, and nothing like the default sky. */
const BRAND = '#0f766e';
/** Mid-grey: 4.00:1 on white and 4.46:1 on ink, so it fails BOTH. */
const UNREADABLE = '#7f7f7f';

/** A 1x1 transparent PNG — a real one, so the magic-number sniff accepts it. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function resetBranding() {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    await pool.query(
      `UPDATE organization
          SET brand_color = NULL, logo_bytes = NULL, logo_mime = NULL,
              logo_updated_at = NULL, login_tagline = NULL`,
    );
  } finally {
    await pool.end();
  }
}

/** What the OTHER tenant sees. Read straight from the column, not through a page. */
async function brandColorOf(slug: string): Promise<string | null> {
  const pool = new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    const r = await pool.query('SELECT brand_color FROM organization WHERE slug = $1', [slug]);
    return r.rows[0]?.brand_color ?? null;
  } finally {
    await pool.end();
  }
}

test.beforeAll(resetBranding);
test.afterAll(resetBranding);

test.describe.configure({ mode: 'serial' });

test('the tab carries the TENANT\'s name, not the scaffold default', async ({ page }) => {
  await page.goto('/expenses');
  // `Create Next App` was live in every tab of this product until VX4-3 part 2.
  // Asserted as an exclusion as well as a match, because a title that merely
  // CONTAINS the org name would also pass a positive-only check while still
  // saying "Create Next App" beside it.
  await expect(page).toHaveTitle(/VeloExpense/);
  await expect(page).not.toHaveTitle(/Create Next App/);
  const title = await page.title();
  // The tenant's half goes FIRST: browsers truncate the end of a tab title, so
  // the part that says which window this is must survive the truncation.
  expect(title.startsWith('VeloExpense')).toBe(false);
  expect(title).toMatch(/ · VeloExpense$/);
});

test('an unbranded tenant gets NO injected stylesheet at all', async ({ page }) => {
  // Absence means untouched. If this ever found a style block, then every tenant
  // is being served a "default" that is now a rendered artefact rather than the
  // hand-tuned sheet — and the default palette would move whenever the generator
  // did.
  await page.goto('/expenses');
  await expect(page.locator('#tenant-branding')).toHaveCount(0);
});

test('setting a colour refuses the unreadable one and explains WHY', async ({ page }) => {
  await page.goto('/admin/branding');
  await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();

  await page.getByLabel('Colour').fill(UNREADABLE);
  await page.getByRole('button', { name: 'Save colour' }).click();

  // The message must name both ratios. "Contrast too low" is not something an
  // admin can act on; "4.00 against white, 4.46 against dark, we need 4.5" tells
  // them the colour is too middling and roughly by how much.
  //
  // Located by testid rather than by text: a regex over the sentence resolves to
  // the paragraph and its wrapper both, which is the strict-mode violation
  // VX4-1's spec already paid for.
  const banner = page.getByTestId('error-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('cannot carry readable text');
  await expect(banner).toContainText('4.00:1 against white');
  await expect(banner).toContainText('4.46:1 against dark ink');

  // And nothing was stored.
  expect(await brandColorOf('demo')).toBeNull();
});

test('a good colour reaches the PAGE, with the chosen foreground shown to the admin', async ({
  page,
}) => {
  await page.goto('/admin/branding');
  await page.getByLabel('Colour').fill(BRAND);
  await page.getByRole('button', { name: 'Save colour' }).click();

  // The screen tells the admin which foreground we picked FOR them, and at what
  // ratio — the decision is theirs to see, not ours to make quietly.
  const note = page.getByTestId('contrast-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('white');
  await expect(note).toContainText('WCAG AA needs 4.5:1');
  // Teal on white is 5.05:1 — the actual number, so a chooser that reported a
  // plausible-looking constant would fail here.
  await expect(note).toContainText(':1 contrast');

  // Now the part no unit test can see: the derived palette is in the document.
  await page.goto('/expenses');
  const style = page.locator('#tenant-branding');
  await expect(style).toHaveCount(1);
  // `textContent`, NOT `innerText`. A <style> in <head> is not rendered, and
  // `innerText` is defined in terms of rendered text — it answers '' here, so an
  // assertion built on it could only ever pass vacuously. Sibling of §4's
  // `count()`-does-not-auto-wait entry: the API that reads right is the one that
  // cannot fail.
  const css = (await style.textContent()) ?? '';
  expect(css).not.toBe('');
  expect(css).toContain(`--vl-brand:${BRAND}`);
  // The RAMP is there too, derived — not just the one colour the admin typed.
  // Seven steps, none of them the sky hexes they replace.
  for (const step of [50, 100, 200, 400, 600, 700, 900]) {
    expect(css).toMatch(new RegExp(`--vl-brand-${step}:#[0-9a-f]{6}`));
  }
  expect(css).not.toContain('#0284c7');
  expect(css).not.toContain('#f0f9ff');

  // AND THE BROWSER AGREES, which is the only assertion here that can fail while
  // the string above is perfect — a `<style>` in the wrong place, or the imported
  // sheet winning on source order.
  //
  // Probed by PAINTING rather than by reading the custom property back. Browsers
  // disagree about what `getComputedStyle().getPropertyValue('--x')` returns when
  // the value is `var(--y)` — substituted or not — so asserting on that would be a
  // test of Chrome's serialisation. Resolving `var(--primary)` into a real `color`
  // gives an rgb() triple and tests the whole indirection chain the token sheet
  // depends on: --primary -> --vl-brand -> our injected block.
  const painted = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--primary)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  // #0f766e
  expect(painted).toBe('rgb(15, 118, 110)');
});

test('the other tenant is untouched', async ({ page }) => {
  // The seed provisions a second tenant ('blank') for exactly this. Asserted at
  // the column rather than through a second sign-in, because the claim is about
  // the DATA and a second session would only prove the page.
  expect(await brandColorOf('demo')).toBe(BRAND);
  expect(await brandColorOf('blank')).toBeNull();
  // And the signed-in tenant still has it, so the reset above is not what made
  // the previous line true.
  await page.goto('/admin/branding');
  await expect(page.getByLabel('Colour')).toHaveValue(BRAND);
});

test('a logo round-trips, and the route serves it with the headers that make it safe', async ({
  page,
}) => {
  await page.goto('/admin/branding');
  await page.setInputFiles('input[type=file]', {
    name: 'wordmark.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  });
  await page.getByRole('button', { name: 'Upload' }).click();

  const img = page.getByRole('img', { name: /logo$/ });
  await expect(img).toBeVisible();
  const src = await img.getAttribute('src');
  // The `?v=` stamp is what lets the response be cached immutably instead of for
  // 300 seconds — the divergence from ExpenseOS's icon route.
  expect(src).toMatch(/^\/api\/branding\/logo\?v=\d+$/);

  const res = await page.request.get(src!);
  expect(res.status()).toBe(200);
  const headers = res.headers();
  expect(headers['content-type']).toBe('image/png');
  // `nosniff` is only a safety property because `setLogo` sniffed the magic
  // number, so the declared type is true.
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-disposition']).toBe('attachment');
  expect(headers['content-security-policy']).toContain('sandbox');
  // `private`, because the bytes belong to one tenant and a shared cache must not
  // hand them to another.
  expect(headers['cache-control']).toContain('private');
  expect(headers['cache-control']).toContain('immutable');
  expect(Buffer.from(await res.body()).equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
});

test('an SVG wearing a PNG label is refused at upload', async ({ page }) => {
  // The column refuses `image/svg+xml`, so the only way in is to LIE about the
  // type. The CHECK cannot tell; the sniff can. This is the browser-level proof
  // that the sniff is actually in the upload path and not just in the service's
  // unit tests.
  await page.goto('/admin/branding');
  await page.setInputFiles('input[type=file]', {
    name: 'wordmark.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
  });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByTestId('error-banner')).toContainText(
    'not a PNG, JPEG or WebP image',
  );
});

test('the tagline says plainly that the sign-in page is not branded yet', async ({ page }) => {
  // A field that silently stores something nobody will see is worse than no field.
  // Pre-auth branding needs host-based tenancy (Phase 5, BR-1/BR-8), and the
  // screen says so.
  await page.goto('/admin/branding');
  await page.getByPlaceholder('Expenses, sorted.').fill(`Sorted, ${RUN}`);
  await page.getByRole('button', { name: 'Save tagline' }).click();
  await expect(page.getByPlaceholder('Expenses, sorted.')).toHaveValue(`Sorted, ${RUN}`);
  await expect(
    page.getByRole('heading', { name: 'Sign-in tagline' }),
  ).toBeVisible();
});
