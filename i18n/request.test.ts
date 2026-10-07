// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * next-intl's request config — VeloExpense's version of ExpenseOS's `src/i18n/request.ts`.
 *
 * ExpenseOS's own suite tests a URL-segment fallback chain (`/de-DE/` -> English). VeloExpense
 * has no locale in its URLs, so that chain does not exist here; what this pins instead is the
 * decision of 7 Oct (English only for now) and the two things the config takes from the
 * reader: the time zone, and — on the crawl's server — the pseudo-locale.
 */
const h = vi.hoisted(() => ({ pseudo: false, timeZone: 'America/Toronto' }));
vi.mock('@/lib/i18n/request', () => ({
  readerPrefs: async () => ({ locale: 'en-US', timeZone: h.timeZone }),
}));
vi.mock('@/lib/i18n/pseudo', async (orig) => ({
  ...(await orig<typeof import('@/lib/i18n/pseudo')>()),
  pseudoEnabled: () => h.pseudo,
}));
let resolver: () => Promise<{ locale: string; timeZone: string; messages: Record<string, Record<string, unknown>> }>;
vi.mock('next-intl/server', () => ({
  getRequestConfig: (fn: typeof resolver) => {
    resolver = fn;
    return fn;
  },
}));

beforeEach(async () => {
  vi.resetModules();
  h.pseudo = false;
  await import('./request');
});

describe('next-intl request config', () => {
  it("is ExpenseOS's English catalogue, whatever English the reader chose", async () => {
    const out = await resolver();
    expect(out.locale).toBe('en');
    expect(out.messages.common).toBeTypeOf('object');
  });

  it('never French, until it is switched on (7 Oct)', async () => {
    const out = await resolver();
    expect(out.locale).not.toBe('fr-CA');
  });

  it("uses the reader's time zone", async () => {
    h.timeZone = 'America/Vancouver';
    expect((await resolver()).timeZone).toBe('America/Vancouver');
  });

  it('serves real text normally, and pseudo-text on the crawl server', async () => {
    const plain = await resolver();
    const sample = JSON.stringify(plain.messages.common);
    expect(sample).not.toContain('⟦');
    h.pseudo = true;
    const pseudo = await resolver();
    expect(JSON.stringify(pseudo.messages.common)).toContain('⟦');
  });
});
