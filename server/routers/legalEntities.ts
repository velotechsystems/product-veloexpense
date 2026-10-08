/**
 * LegalEntity admin router. Adds `country` (ISO-3166-1 alpha-2),
 * `homeCurrency` (ISO-4217) and `itcRecoverable` on top of the shared shape.
 *
 * Ported from ExpenseOS (550b2945). VeloExpense: a currency row is keyed by its ISO
 * code, not a uuid (prisma/schema.prisma `Currency`), so `homeCurrencyId` carries the
 * code and is validated as one — marked below.
 */
import { auditActions } from '@expenseos/audit';
import { permissions as P } from '@expenseos/rbac';
import { z } from 'zod';
import { adminLookupRouter } from './adminLookup';

export const legalEntitiesRouter = adminLookupRouter({
  entityLabel: 'Legal entity',
  modelKey: 'legalEntity',
  permissions: {
    list: P.admin.legalEntity.list,
    create: P.admin.legalEntity.create,
    update: P.admin.legalEntity.update,
    delete: P.admin.legalEntity.delete,
  },
  audit: {
    create: auditActions.admin.legalEntityCreate,
    update: auditActions.admin.legalEntityUpdate,
    delete: auditActions.admin.legalEntityDelete,
  },
  extraFields: {
    // Uppercase 2-letter country code, nullable.
    country: z
      .string()
      .length(2)
      .regex(/^[A-Z]{2}$/, 'ISO-3166-1 alpha-2 (uppercase)')
      .nullable()
      .optional(),
    /** The entity's default currency, by id — `homeCurrency` is a FK now, so a
     *  typed ISO code would have been written to a column that no longer exists.
     *  The admin form picks from the active currency list. */
    // VeloExpense: the currency's id IS its ISO-4217 code here (see the header).
    homeCurrencyId: z
      .string()
      .regex(/^[A-Z]{3}$/, 'ISO-4217 (uppercase)')
      .nullable()
      .optional(),
    /** Whether this entity can reclaim input tax credits. False for a
     *  non-registrant or foreign entity — the tax engine then recovers neither
     *  GST/HST nor QST on its employees' expenses. */
    itcRecoverable: z.boolean().optional(),
  },
  // Both: the id prefills the picker in the drawer, the code is what the table
  // column and the read-mode view display.
  extraSelect: {
    country: true,
    homeCurrencyId: true,
    homeCurrency: { select: { code: true } },
    itcRecoverable: true,
  },
});
