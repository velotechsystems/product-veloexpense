/**
 * BusinessUnit admin router. Thin wrapper over `adminLookupRouter`
 * with no entity-specific fields.
 */
import { auditActions } from '@expenseos/audit';
import { permissions as P } from '@expenseos/rbac';
import { adminLookupRouter } from './adminLookup';

export const businessUnitsRouter = adminLookupRouter({
  entityLabel: 'Business unit',
  modelKey: 'businessUnit',
  permissions: {
    list: P.admin.businessUnit.list,
    create: P.admin.businessUnit.create,
    update: P.admin.businessUnit.update,
    delete: P.admin.businessUnit.delete,
  },
  audit: {
    create: auditActions.admin.businessUnitCreate,
    update: auditActions.admin.businessUnitUpdate,
    delete: auditActions.admin.businessUnitDelete,
  },
});
