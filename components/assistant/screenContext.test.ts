import { describe, expect, it } from 'vitest';
import { screenContextFrom } from './screenContext';

const LOCALES = ['en', 'fr-CA'];
const ID = '019e65ed-2c70-72cb-b6aa-d9d6cf60cb40';

describe('screenContextFrom', () => {
  it('drops the locale so both languages are the same screen', () => {
    // Otherwise half the routes are unrecognisable to the model, and a French-speaking user
    // silently loses screen awareness.
    expect(screenContextFrom('/fr-CA/expenses', LOCALES).route).toBe('/expenses');
    expect(screenContextFrom('/en/expenses', LOCALES).route).toBe('/expenses');
  });

  it('names an id after the collection it belongs to', () => {
    // The tools take named parameters. A positional `id` is a lookup against the wrong table.
    expect(screenContextFrom(`/en/expenses/${ID}`, LOCALES)).toEqual({
      route: '/expenses/[reportId]',
      entityIds: { reportId: ID },
    });
  });

  it('handles a nested id', () => {
    expect(screenContextFrom(`/en/virtual-cards/transactions/${ID}`, LOCALES)).toEqual({
      route: '/virtual-cards/transactions/[transactionId]',
      entityIds: { transactionId: ID },
    });
  });

  it('falls back to a plain name for a collection it does not know', () => {
    expect(screenContextFrom(`/en/something/${ID}`, LOCALES).entityIds).toEqual({ id: ID });
  });

  it('sends no ids at all when the screen carries none', () => {
    expect(screenContextFrom('/en/dashboard', LOCALES)).toEqual({ route: '/dashboard' });
  });

  it('leaves non-id segments alone', () => {
    // `approvals` is a route word, not a record. Treating it as an id would tell the model
    // the person is looking at something that does not exist.
    expect(screenContextFrom('/en/expenses/approvals', LOCALES).route).toBe('/expenses/approvals');
  });

  it('survives the root path', () => {
    expect(screenContextFrom('/en', LOCALES).route).toBe('/');
  });
});
