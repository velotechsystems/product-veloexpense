import { describe, expect, it } from 'vitest';
import { databaseErrorText } from './databaseErrorText';

const pgText = 'new row for relation "fiscal_year" violates check constraint "fiscal_year_dates"';

describe('databaseErrorText', () => {
  it('reads Prisma 7.8’s raw DriverAdapterError', () => {
    const err = Object.assign(new Error(pgText), { name: 'DriverAdapterError' });
    expect(databaseErrorText(err)).toContain('"fiscal_year_dates"');
  });

  it('reads Prisma 7.10’s P2039 wrapper, whose own message is empty', () => {
    const err = Object.assign(new Error(''), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2039',
      meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '23514', originalMessage: pgText } } },
    });
    expect(err.message).toBe('');
    expect(databaseErrorText(err)).toContain('"fiscal_year_dates"');
  });

  it('reads an adapter error with its cause attached directly', () => {
    expect(databaseErrorText({ message: 'x', cause: { originalMessage: pgText } })).toContain('fiscal_year_dates');
  });

  it('is empty for nothing useful', () => {
    expect(databaseErrorText(null)).toBe('');
    expect(databaseErrorText('boom')).toBe('');
    expect(databaseErrorText({})).toBe('');
  });
});
