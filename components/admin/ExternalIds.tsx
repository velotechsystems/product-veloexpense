/**
 * Re-export shim — the read-mode pill components (`ExternalIdsCell`,
 * `ExternalIdsBlock`) now live in `@expenseos/design-system`. This
 * module re-exports them (and, in ExpenseOS, pinned four canonical
 * external systems as quick-add suggestions — see below).
 *
 * Importers should prefer pulling from `@expenseos/design-system`
 * directly for new code; this file remains so existing imports
 * (`@/components/admin/ExternalIds`) keep resolving.
 */
export {
  ExternalIdsBlock,
  ExternalIdsCell,
  externalIdEntries,
} from '@expenseos/design-system';

// VeloExpense: ExpenseOS's `SUPPORTED_EXTERNAL_SYSTEMS` (four vendor names, once the
// editor's quick-add list) is not ported. Nothing reads it any more — the editor offers the
// tenant's own sources (`components/external-ids/ExternalIdsField.tsx`) — and a vendor name
// in a core module is what scripts/check-vendor-neutral.mjs exists to refuse.
