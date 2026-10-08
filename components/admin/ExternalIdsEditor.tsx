/**
 * Re-export shim — the editor itself now lives in the design-system
 * (`@expenseos/design-system`) as a generic key/value editor with a
 * configurable quick-add list. This module re-exports the editor and
 * provides the ExpenseOS-side defaults (`SUPPORTED_EXTERNAL_SYSTEMS`
 * as the default `quickAddOptions`).
 *
 * Importers should prefer pulling from `@expenseos/design-system`
 * directly for new code; this file remains so existing imports
 * (`@/components/admin/ExternalIdsEditor`) keep resolving.
 */
export {
  type ExternalIdEntry,
  ExternalIdsEditor,
  type ExternalIdsEditorProps,
  entriesFromMap,
  mapFromEntries,
} from '@expenseos/design-system';
